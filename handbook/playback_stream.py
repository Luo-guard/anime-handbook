"""Resolve public browser media and serve it to the local video player."""
from __future__ import annotations

import hashlib
import re
import secrets
import threading
import time
from dataclasses import dataclass, field
from http.client import HTTPException
from urllib.parse import urljoin, urlsplit

from .http_support import RequestProblem
from .playback_network import browser_proxy, public_url, request_public

HLS_TYPES = {"application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl", "audio/x-mpegurl"}
PLAYBACK_PREFIX = "/api/playback/"
_BROWSER_SLOTS = threading.BoundedSemaphore(2)
_STREAM_SLOTS = threading.BoundedSemaphore(16)
_LOCK = threading.Lock()
MAX_PLAYLIST_BYTES = 2 * 1024 * 1024


def media_format(url, content_type=""):
    path = urlsplit(url).path.lower()
    if content_type in HLS_TYPES or path.endswith(".m3u8"):
        return "hls"
    if content_type in {"video/mp4", "video/webm", "video/quicktime"} or path.endswith((".mp4", ".webm")):
        return "file"
    return ""


def resolve_in_browser(url, rule):
    public_url(url)
    try:
        from playwright.sync_api import Error, sync_playwright
    except ImportError:
        raise RequestProblem("缺少片源解析组件 Playwright，请安装桌面播放依赖", 503) from None
    if not _BROWSER_SLOTS.acquire(blocking=False):
        raise RequestProblem("正在解析其他视频，请稍后重试", 503)
    try:
        with browser_proxy() as proxy, sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                channel="msedge", headless=True, proxy={"server": proxy, "bypass": "<-loopback>"},
                args=["--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
            )
            try:
                page = browser.new_page(accept_downloads=False, service_workers="block",
                                        user_agent=rule.get("userAgent") or None)
                page.context.on("page", lambda popup: popup.close() if popup != page else None)
                captured = []

                def on_response(response):
                    if captured or response.status not in (200, 206):
                        return
                    content_type = response.headers.get("content-type", "").partition(";")[0].lower()
                    if content_type.startswith("text/") or content_type in {"application/json", "application/xml"}:
                        return
                    kind = media_format(response.url, content_type)
                    if kind and urlsplit(response.url).scheme in ("http", "https"):
                        captured.append((response.request, kind))

                page.on("response", on_response)
                deadline = time.monotonic() + 15
                try:
                    page.goto(url, referer=rule.get("referer") or None, wait_until="commit", timeout=9000)
                except Error:
                    pass
                attempted_play = False
                while not captured and time.monotonic() < deadline and not page.is_closed():
                    if not attempted_play:
                        for frame in page.frames:
                            video = frame.locator("video").first
                            if video.count():
                                try:
                                    video.evaluate("video => { video.muted = true; video.play().catch(() => {}); }", timeout=500)
                                    attempted_play = True
                                except Error:
                                    pass
                    page.wait_for_timeout(250)
                if captured:
                    request, kind = captured[0]
                    headers = {key: value for key, value in request.all_headers().items()
                               if key in {"referer", "origin", "user-agent", "cookie"}}
                    return request.url, kind, headers
            finally:
                browser.close()
    except Error:
        raise RequestProblem("播放页无法加载，请重试或切换规则", 502) from None
    finally:
        _BROWSER_SLOTS.release()
    raise RequestProblem("未从播放页找到可用视频，请切换线路或规则", 502)


@dataclass
class Playback:
    expires: float
    url: str
    headers: dict
    resources: dict = field(default_factory=dict)


_PLAYBACKS: dict[str, Playback] = {}


def issue(url, kind, headers=None, *, expires=None):
    public_url(url)
    now = time.time()
    until = min(now + 5400, expires) if expires is not None else now + 5400
    if until <= now:
        raise RequestProblem("视频地址已过期，请重试", 410)
    token = secrets.token_urlsafe(24)
    with _LOCK:
        for old_token in [key for key, item in _PLAYBACKS.items() if item.expires <= now]:
            del _PLAYBACKS[old_token]
        if len(_PLAYBACKS) >= 48:
            del _PLAYBACKS[next(iter(_PLAYBACKS))]
        playback = Playback(until, url, dict(headers or {}), {"main": (url, kind)})
        _PLAYBACKS[token] = playback
    return {"url": f"{PLAYBACK_PREFIX}stream/{token}/main", "format": kind}


def _playlist_text(response):
    data = response.read(MAX_PLAYLIST_BYTES + 1)
    if len(data) > MAX_PLAYLIST_BYTES:
        raise RequestProblem("HLS 列表过大", 502)
    return data.decode("utf-8-sig")


def _validate_playlist(lines):
    if not lines or lines[0].strip() != "#EXTM3U":
        raise RequestProblem("片源返回了无效的 HLS 列表", 502)
    if not any(line and (not line.startswith("#")
                        or (line.startswith("#EXT-X-I-FRAME-STREAM-INF:") and 'URI="' in line))
               for line in map(str.strip, lines[1:])):
        raise RequestProblem("片源返回了空的播放列表，请切换线路或规则", 502)


def probe_media(url, kind, headers):
    """Verify a direct URL before handing it to the browser."""
    probe_headers = {"User-Agent": "Mozilla/5.0", "Accept-Encoding": "identity", **headers}
    if kind == "file":
        probe_headers["Range"] = "bytes=0-1023"
    try:
        with request_public(url, headers=probe_headers) as (response, _):
            content_type = response.headers.get_content_type()
            if response.status not in (200, 206) or content_type in {"text/html", "application/json"}:
                raise RequestProblem(f"片源返回 HTTP {response.status} 或非视频内容，请切换线路或规则", 502)
            if kind == "hls":
                _validate_playlist(_playlist_text(response).splitlines())
            elif not response.read(1):
                raise RequestProblem("片源返回了空的视频，请切换线路或规则", 502)
    except (OSError, HTTPException, UnicodeError):
        raise RequestProblem("无法读取片源，请重试或切换规则", 502) from None


def rewrite_playlist(data, base, token, playback):
    source_lines = data.splitlines()
    _validate_playlist(source_lines)

    def register(uri, kind="segment"):
        target = urljoin(base, uri)
        public_url(target)
        key = hashlib.sha256(f"{kind}\n{target}".encode()).hexdigest()[:32]
        with _LOCK:
            if len(playback.resources) >= 12000 and key not in playback.resources:
                raise RequestProblem("HLS 分段数量过多", 502)
            playback.resources[key] = (target, kind)
        return f"{PLAYBACK_PREFIX}stream/{token}/{key}"

    lines = []
    variant = False
    for line in source_lines:
        line = line.strip()
        if line.startswith("#"):
            # Alternate playlists and initialization/key resources use URI attributes.
            kind = "hls" if line.startswith(("#EXT-X-MEDIA:", "#EXT-X-I-FRAME-STREAM-INF:",
                                             "#EXT-X-RENDITION-REPORT:")) else "segment"
            line = re.sub(r'(?<=[:,])URI="([^"]+)"', lambda match: f'URI="{register(match[1], kind)}"', line)
            if line.startswith("#EXT-X-STREAM-INF:"):
                variant = True
        elif line:
            line = register(line, "hls" if variant or media_format(urljoin(base, line)) == "hls" else "segment")
            variant = False
        lines.append(line)
    return ("\n".join(lines) + "\n").encode()


def stream(handler, token, resource):
    with _LOCK:
        playback = _PLAYBACKS.get(token)
        item = playback.resources.get(resource) if playback and time.time() < playback.expires else None
    if not item:
        raise RequestProblem("播放地址已过期，请重试", 410)
    url, kind = item
    headers = {"User-Agent": "Mozilla/5.0", "Accept-Encoding": "identity", **playback.headers}
    origin = lambda value: urlsplit(value).netloc
    if origin(url) != origin(playback.url) or urlsplit(url).scheme != urlsplit(playback.url).scheme:
        headers.pop("cookie", None)
    range_header = handler.headers.get("Range")
    if range_header and kind != "hls":
        if not re.fullmatch(r"bytes=(?:[0-9]{1,14}-[0-9]{0,14}|-[0-9]{1,14})", range_header):
            raise RequestProblem("视频范围无效", 416)
        headers["Range"] = range_header
    if not _STREAM_SLOTS.acquire(blocking=False):
        raise RequestProblem("正在读取视频，请稍后重试", 503)
    try:
        with request_public(url, headers=headers) as (response, final_url):
            if response.status == 416:
                handler.send_response(416)
                if value := response.getheader("Content-Range"):
                    handler.send_header("Content-Range", value)
                handler.send_header("Content-Length", "0")
                handler.end_headers()
                return
            content_type = response.headers.get_content_type()
            if response.status not in (200, 206) or content_type in {"text/html", "application/json"}:
                raise RequestProblem(f"视频线路返回 HTTP {response.status} 或非视频内容", 502)
            if kind == "hls" or content_type in HLS_TYPES:
                body = rewrite_playlist(_playlist_text(response), final_url, token, playback)
                _headers(handler, 200, "application/vnd.apple.mpegurl", str(len(body)))
                _send_body(handler, (body,))
                return
            content_range = response.getheader("Content-Range", "")
            if response.status == 206 and not re.fullmatch(r"bytes \d+-\d+/\d+", content_range):
                raise RequestProblem("线路返回了无效的视频分段", 502)
            if kind == "file":
                content_type = "video/webm" if content_type == "video/webm" or urlsplit(final_url).path.endswith(".webm") else "video/mp4"
            elif content_type not in {"video/mp4", "video/mp2t", "audio/aac", "text/vtt"}:
                content_type = "application/octet-stream"
            length = response.getheader("Content-Length", "")
            _headers(handler, response.status, content_type, length, content_range)
            sent = _send_body(handler, iter(lambda: response.read(128 * 1024), b""))
            if length.isascii() and length.isdigit() and sent != int(length):
                handler.close_connection = True
    except (OSError, HTTPException, UnicodeError):
        raise RequestProblem("读取视频失败，可重试或切换线路", 502) from None
    finally:
        _STREAM_SLOTS.release()


def _headers(handler, status, content_type, length, content_range=""):
    handler.send_response(status)
    handler.send_header("Content-Type", content_type)
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Cross-Origin-Resource-Policy", "same-origin")
    if length and length.isascii() and length.isdigit():
        handler.send_header("Content-Length", length)
    else:
        handler.send_header("Connection", "close")
        handler.close_connection = True
    if content_range:
        handler.send_header("Content-Range", content_range)
    handler.send_header("Accept-Ranges", "bytes")
    handler.end_headers()


def _send_body(handler, chunks):
    sent = 0
    try:
        for chunk in chunks:
            handler.wfile.write(chunk)
            sent += len(chunk)
    except (OSError, HTTPException):
        handler.close_connection = True
    return sent
