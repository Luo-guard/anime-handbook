"""Desktop-only preview for public Xifan Next episodes."""
from __future__ import annotations

import json
import re
import secrets
import threading
import time
from http.client import HTTPException
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

PREFIX = "/api/preview/xifan/"
SITE = "https://next.xifanacg.com"
API = "https://api.xifanacg.com"
RULE = "https://raw.githubusercontent.com/Predidit/KazumiRules/main/xfdmnext.json"
SAMPLE_URL = f"{SITE}/anime/3435/play/203809"
MEDIA_HOSTS = {"apn.moedot.net", "play.xfvod.pro", "bjdownload.pan.wo.cn"}
TIMEOUT = 10
_LOCK = threading.Lock()
_TICKETS: dict[str, tuple[str, float]] = {}
_KEY: tuple[str, float] = ("", 0)
_SLOTS = threading.BoundedSemaphore(4)


class PreviewError(ValueError):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def _allowed(url: str, hosts: set[str]) -> bool:
    try:
        p = urlsplit(url)
        valid_port = p.port in (None, 443) or (p.hostname == "bjdownload.pan.wo.cn" and p.port == 30443)
        return (p.scheme == "https" and p.hostname in hosts and valid_port
                and p.username is None and p.password is None)
    except ValueError:
        return False


class _Redirect(HTTPRedirectHandler):
    def __init__(self, hosts: set[str]):
        self.hosts = hosts

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not _allowed(newurl, self.hosts):
            raise PreviewError("稀饭更换了视频线路，当前测试版暂不支持")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _json_request(url: str, body: dict | None = None, key: str = ""):
    headers = {"Accept": "application/json", "User-Agent": "AnimeHandbook Xifan Preview"}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers.update({"Content-Type": "application/json", "Origin": SITE,
                        "apikey": key, "Authorization": f"Bearer {key}"})
    try:
        with build_opener(_Redirect(set())).open(Request(url, data, headers), timeout=TIMEOUT) as reply:
            content = reply.read(2 * 1024 * 1024 + 1)
        if len(content) > 2 * 1024 * 1024:
            raise PreviewError("稀饭返回的资料过大，请打开原网页")
        return json.loads(content)
    except HTTPError as error:
        error.close()
        if error.code in (401, 403):
            raise PreviewError("稀饭未授权这个播放请求，请打开原网页") from None
        raise PreviewError(f"稀饭暂时无法响应（HTTP {error.code}）") from None
    except (URLError, OSError, UnicodeError, json.JSONDecodeError):
        raise PreviewError("连接稀饭失败，请重试或打开原网页") from None


def _public_key() -> str:
    global _KEY
    with _LOCK:
        key, until = _KEY
    if key and until > time.monotonic():
        return key
    rule = _json_request(RULE)
    try:
        key = rule["chapterApiConfig"]["request"]["headers"]["apikey"]
    except (KeyError, TypeError):
        raise PreviewError("稀饭 Next 的公开站点规则已变更") from None
    if not isinstance(key, str) or not re.fullmatch(r"sb_publishable_[A-Za-z0-9_-]{10,100}", key):
        raise PreviewError("稀饭 Next 的公开站点规则已变更")
    with _LOCK:
        _KEY = key, time.monotonic() + 3600
    return key


def _id(value) -> int:
    if not re.fullmatch(r"[1-9][0-9]{0,8}", str(value)):
        raise PreviewError("番剧、线路或集数编号无效", 400)
    return int(value)


def catalogue(url: str) -> dict:
    if not _allowed(url, {"next.xifanacg.com"}):
        raise PreviewError("请粘贴稀饭动漫 Next 的番剧详情或播放链接", 400)
    match = re.fullmatch(r"/anime/([1-9][0-9]{0,8})(?:/play/([1-9][0-9]{0,8}))?/?", urlsplit(url).path)
    if not match:
        raise PreviewError("请粘贴稀饭动漫 Next 的番剧详情或播放链接", 400)
    anime_id, selected = int(match[1]), int(match[2] or 0)
    result = _json_request(f"{API}/rest/v1/rpc/get_anime_detail", {"p_id": anime_id}, _public_key())
    if not isinstance(result, dict) or not isinstance(result.get("anime"), dict):
        raise PreviewError("稀饭没有返回这部番的详情")
    anime = result["anime"]
    sources = []
    for source in result.get("sources") or []:
        episodes = []
        for episode in source.get("episodes") or []:
            number = str(episode.get("episode_number") or "")
            episodes.append({
                "id": _id(episode["id"]),
                "number": re.sub(r"(?<=\d)\.0+$", "", number),
                "title": str(episode.get("title") or "")[:180],
            })
        if episodes:
            sources.append({"id": _id(source["id"]), "name": str(source.get("name") or "稀饭")[:80],
                            "episodes": episodes})
    if not sources:
        raise PreviewError("稀饭没有返回可选择的集数")
    return {"title": str(anime.get("title") or "稀饭动漫")[:180],
            "id": anime_id, "selected": selected, "sources": sources}


def issue(anime_id: str, episode_id: str, source_id: str) -> str:
    anime, episode, source = map(_id, (anime_id, episode_id, source_id))
    result = _json_request(f"{API}/functions/v1/issue-web-playback",
                           {"action": "fallback", "episode_id": episode, "source_id": source},
                           _public_key())
    if not isinstance(result, dict) or not result.get("ok") or result.get("anime_id") != anime:
        raise PreviewError("稀饭未提供这一集的公开播放地址，请打开原网页")
    media = result.get("url")
    if not isinstance(media, str) or not _allowed(media, MEDIA_HOSTS):
        raise PreviewError("当前线路无法在手账内播放，请打开原网页")
    now = time.time()
    expires = result.get("expires_at")
    until = min(now + 5400, expires) if isinstance(expires, (int, float)) else now + 900
    if until <= now:
        raise PreviewError("稀饭的视频地址已过期，请重试")
    token = secrets.token_urlsafe(24)
    with _LOCK:
        for old_token, (_, expiration) in list(_TICKETS.items()):
            if expiration <= now:
                del _TICKETS[old_token]
        if len(_TICKETS) >= 48:
            del _TICKETS[next(iter(_TICKETS))]
        _TICKETS[token] = media, until
    return f"{PREFIX}stream/{token}.mp4"


def _stream(handler, token: str) -> None:
    with _LOCK:
        media, until = _TICKETS.get(token, ("", 0))
    if time.time() >= until:
        raise PreviewError("播放地址已过期，请重试", 410)
    range_header = handler.headers.get("Range", "bytes=0-")
    if not re.fullmatch(r"bytes=(?:[0-9]{1,14}-[0-9]{0,14}|-[0-9]{1,14})", range_header):
        raise PreviewError("视频范围无效", 416)
    if not _SLOTS.acquire(blocking=False):
        raise PreviewError("正在读取视频，请稍后重试", 503)
    try:
        try:
            upstream = build_opener(_Redirect(MEDIA_HOSTS)).open(
                Request(media, headers={"Range": range_header, "User-Agent": "Mozilla/5.0",
                                        "Accept-Encoding": "identity"}),
                timeout=TIMEOUT,
            )
        except HTTPError as error:
            error.close()
            raise PreviewError("稀饭视频线路暂不可用，请重试或打开原网页") from None
        except (URLError, OSError):
            raise PreviewError("连接稀饭视频线路超时，请重试") from None
        with upstream:
            length = upstream.headers.get("Content-Length", "")
            content_range = upstream.headers.get("Content-Range", "")
            if (upstream.status != 206 or not length.isascii() or not length.isdigit()
                    or not re.fullmatch(r"bytes [0-9]+-[0-9]+/[0-9]+", content_range)
                    or upstream.headers.get_content_type() not in {"video/mp4", "application/octet-stream"}):
                raise PreviewError("这条线路暂不支持内置播放，请打开原网页")
            handler.send_response(206)
            handler.send_header("Content-Type", "video/mp4")
            handler.send_header("Content-Length", length)
            handler.send_header("Content-Range", content_range)
            handler.send_header("Accept-Ranges", "bytes")
            handler.send_header("Cache-Control", "no-store")
            handler.send_header("Cross-Origin-Resource-Policy", "same-origin")
            handler.end_headers()
            remaining = int(length)
            try:
                while remaining:
                    chunk = upstream.read(min(128 * 1024, remaining))
                    if not chunk:
                        break
                    handler.wfile.write(chunk)
                    remaining -= len(chunk)
            except (OSError, HTTPException):
                handler.close_connection = True
            if remaining:
                handler.close_connection = True
    finally:
        _SLOTS.release()


def serve(handler, path: str, query: dict) -> None:
    if (handler.client_address[0] not in {"127.0.0.1", "::1"}
            or not re.fullmatch(r"(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?",
                                handler.headers.get("Host", ""))
            or handler.headers.get("Sec-Fetch-Site") in {"cross-site", "same-site"}):
        raise PreviewError("此播放测试仅供本机使用", 403)
    if path == PREFIX + "catalogue":
        handler.send_json(catalogue(query.get("url", [SAMPLE_URL])[0]))
    elif path == PREFIX + "play":
        values = [query.get(key, [""])[0] for key in ("anime", "episode", "source")]
        handler.send_json({"url": issue(*values)})
    else:
        match = re.fullmatch(re.escape(PREFIX) + r"stream/([A-Za-z0-9_-]{32})\.mp4", path)
        if not match:
            raise PreviewError("播放地址无效", 404)
        _stream(handler, match[1])
