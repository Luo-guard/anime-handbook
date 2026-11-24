"""网站资源下载：把播放器解析出来的在线地址抓成媒体库里的成品。

Kazumi 的下载是「拿到 m3u8 / 直链 → 按分片下载 → 本地重建播放列表」，这里
沿用同一套思路，但地址来自手账自己的网页播放解析（``playback_rules``），
所以只需要一个能在后台跑的下载器：

- HLS：解析 master / media 播放列表，下载 key、init 分片和全部分片，
  再把播放列表重写成指向本地文件的版本，交给既有归档流程 remux 成 mp4；
- 直链 mp4：``.part`` 断点续传，完成后改名。

下载器不碰数据库，进度靠 :func:`snapshot` 被 ``OfflineService`` 轮询取走，
这样暂停、取消、失败重试都只在这一层解决，不改动 BT 那套逻辑。
"""
from __future__ import annotations

import http.client
import os
import re
import shutil
import socket
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import quote, urljoin, urlsplit

# 分片并发：4 路已经能跑满一般家用带宽，再多容易被源站限速。
SEGMENT_WORKERS = 4
SEGMENT_RETRIES = 3
RETRY_DELAYS = (1, 3, 9)
TIMEOUT = 30
CHUNK = 65536
MAX_PLAYLIST_BYTES = 4 * 1024 * 1024
PLAYLIST_NAME = "playlist.m3u8"
DIRECT_NAME = "video.mp4"

_ATTRIBUTE = re.compile(r'([A-Z0-9-]+)=("[^"]*"|[^,]*)')


class WebDownloadError(RuntimeError):
    """下载失败，消息直接给用户看。"""


# ---------------------------------------------------------------- 网络

def _sandbox() -> bool:
    return os.environ.get("ANIME_HANDBOOK_SANDBOX") == "1"


def _connect(host: str, port: int, timeout: float):
    """只连公网地址；测试时（沙箱模式）允许回环，方便起本地站点验证。"""
    addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    if not _sandbox():
        import ipaddress

        for _family, _kind, _proto, _canon, address in addresses:
            ip = ipaddress.ip_address(address[0].split("%", 1)[0])
            ip = getattr(ip, "ipv4_mapped", None) or ip
            if not ip.is_global or ip.is_multicast:
                raise WebDownloadError("片源地址不是公网地址，已拒绝连接")
    last: OSError | None = None
    for family, kind, proto, _canon, address in addresses:
        sock = socket.socket(family, kind, proto)
        try:
            sock.settimeout(timeout)
            sock.connect(address)
            return sock
        except OSError as error:  # noqa: PERF203 - 逐个地址试，最后一个错误最有用
            last = error
            sock.close()
    raise WebDownloadError(f"连不上片源服务器：{last}")


@contextmanager
def _open(url: str, headers: dict[str, str] | None = None, *, timeout: float = TIMEOUT):
    """发一个 GET，自动跟随跳转。产出 (response, 最终地址)。"""
    target = str(url or "")
    current_headers = dict(headers or {})
    for _ in range(6):
        try:
            parts = urlsplit(target)
            if parts.scheme not in {"http", "https"} or not parts.hostname:
                raise WebDownloadError("片源地址无效")
            port = parts.port or (443 if parts.scheme == "https" else 80)
            cls = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
            conn = cls(parts.hostname, port, timeout=timeout)
            conn._create_connection = lambda address, wait, source: _connect(*address, wait)  # noqa: SLF001
        except ValueError as error:
            raise WebDownloadError(f"片源地址无效：{error}") from error
        try:
            path = quote(parts.path or "/", safe="/%:@!$&'()*+,;=-._~")
            if parts.query:
                path += "?" + quote(parts.query, safe="/?%:@!$&'()*+,;=-._~")
            conn.request("GET", path, headers=current_headers)
            response = conn.getresponse()
            location = response.getheader("Location")
            if response.status in {301, 302, 303, 307, 308} and location:
                target = urljoin(target, location)
                continue
            yield response, target
            return
        finally:
            conn.close()
    raise WebDownloadError("片源跳转次数过多")


def _fetch_text(url: str, headers: dict[str, str], *, limit: int = MAX_PLAYLIST_BYTES) -> tuple[str, str]:
    with _open(url, headers) as (response, final):
        if response.status in (401, 403):
            raise WebDownloadError("片源拒绝访问（401/403），可能需要重新解析或换一条线路")
        if response.status >= 400:
            raise WebDownloadError(f"片源返回 HTTP {response.status}")
        data = response.read(limit + 1)
    if len(data) > limit:
        raise WebDownloadError("播放列表异常大，可能不是 m3u8")
    try:
        return data.decode("utf-8-sig"), final
    except UnicodeDecodeError:
        return data.decode("utf-8", "replace"), final


# ---------------------------------------------------------------- 播放列表

def _attributes(line: str) -> dict[str, str]:
    payload = line.split(":", 1)[1] if ":" in line else ""
    values: dict[str, str] = {}
    for key, raw in _ATTRIBUTE.findall(payload):
        values[key] = raw.strip('"') if raw.startswith('"') else raw.strip()
    return values


def _is_playlist(text: str) -> bool:
    return text.lstrip().startswith("#EXTM3U")


def _looks_nested(uri: str) -> bool:
    return urlsplit(uri).path.lower().endswith(".m3u8")


def _parse_master(text: str, base: str) -> str:
    """从 master 播放列表里挑码率最高的一路。"""
    best_uri, best_bandwidth = "", -1
    pending = 0
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("#EXT-X-STREAM-INF:"):
            pending = int(_attributes(line).get("BANDWIDTH") or 0)
        elif line and not line.startswith("#") and pending >= 0:
            if pending > best_bandwidth:
                best_bandwidth, best_uri = pending, urljoin(base, line)
            pending = -1
    if not best_uri:
        raise WebDownloadError("播放列表里没有可用的清晰度")
    return best_uri


def _parse_media(text: str, base: str) -> dict:
    """解析 media 播放列表：分片、加密 key、初始化分片。"""
    segments: list[dict] = []
    keys: list[dict] = []
    key_index: dict[str, int] = {}
    current_key: dict | None = None
    current_map = ""
    duration = 0.0
    target = 0.0
    vod = "#EXT-X-PLAYLIST-TYPE:VOD" in text
    ended = "#EXT-X-ENDLIST" in text
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("#EXT-X-KEY:"):
            values = _attributes(line)
            method = (values.get("METHOD") or "NONE").upper()
            if method == "NONE" or not values.get("URI"):
                current_key = None
                continue
            uri = urljoin(base, values["URI"])
            if uri not in key_index:
                key_index[uri] = len(keys)
                keys.append({"uri": uri, "method": method, "iv": values.get("IV", "")})
            current_key = {"index": key_index[uri], "method": method, "iv": values.get("IV", "")}
        elif line.startswith("#EXT-X-MAP:"):
            uri = _attributes(line).get("URI")
            current_map = urljoin(base, uri) if uri else ""
        elif line.startswith("#EXT-X-TARGETDURATION:"):
            try:
                target = float(line.split(":", 1)[1])
            except ValueError:
                target = 0.0
        elif line.startswith("#EXTINF:"):
            try:
                duration = float(line.split(":", 1)[1].split(",")[0])
            except ValueError:
                duration = 0.0
        elif line and not line.startswith("#"):
            segments.append({
                "uri": urljoin(base, line),
                "duration": duration or 1.0,
                "key": dict(current_key) if current_key else None,
                "map": current_map,
            })
            duration = 0.0
    if not segments:
        raise WebDownloadError("播放列表里没有可下载的分片")
    if not (ended or vod):
        raise WebDownloadError("这是直播流，不能下载；换一条点播线路试试")
    if not target:
        target = max(seg["duration"] for seg in segments)
    return {"segments": segments, "keys": keys, "target": max(1.0, target)}


def _expand_nested(playlist: dict, headers: dict[str, str]) -> dict:
    """有些源把真正的分片列表再套一层 m3u8，展开一层就够。"""
    if not any(_looks_nested(seg["uri"]) for seg in playlist["segments"]):
        return playlist
    expanded: list[dict] = []
    keys = list(playlist["keys"])
    key_index = {item["uri"]: index for index, item in enumerate(keys)}
    for seg in playlist["segments"]:
        if not _looks_nested(seg["uri"]):
            expanded.append(seg)
            continue
        text, final = _fetch_text(seg["uri"], headers)
        if not _is_playlist(text):
            raise WebDownloadError("嵌套播放列表读取失败")
        inner = _parse_media(text, final)
        for item in inner["keys"]:
            if item["uri"] not in key_index:
                key_index[item["uri"]] = len(keys)
                keys.append(item)
        for item in inner["segments"]:
            if item["key"]:
                item["key"]["index"] = key_index.get(item["key"].get("uri", ""), item["key"]["index"])
            expanded.append(item)
    return {"segments": expanded, "keys": keys, "target": playlist["target"]}


def _local_playlist(playlist: dict, names: list[str], key_names: list[str], map_names: dict[str, str]) -> str:
    lines = ["#EXTM3U", "#EXT-X-VERSION:3", f"#EXT-X-TARGETDURATION:{int(round(playlist['target']))}",
             "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:VOD"]
    written_key = None
    written_map = None
    for index, seg in enumerate(playlist["segments"]):
        key = seg.get("key")
        if key and key.get("index") is not None:
            if written_key != key["index"]:
                attrs = f'METHOD={key.get("method") or "AES-128"},URI="{key_names[key["index"]]}"'
                if key.get("iv"):
                    attrs += f',IV={key["iv"]}'
                lines.append(f"#EXT-X-KEY:{attrs}")
                written_key = key["index"]
        elif written_key is not None:
            lines.append("#EXT-X-KEY:METHOD=NONE")
            written_key = None
        if seg.get("map") and written_map != seg["map"]:
            lines.append(f'#EXT-X-MAP:URI="{map_names.get(seg["map"], "")}"')
            written_map = seg["map"]
        lines.append(f"#EXTINF:{seg['duration']:.3f},")
        lines.append(names[index])
    lines.append("#EXT-X-ENDLIST")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------- 任务

class WebTask:
    """一次网站资源下载。线程只负责搬字节，状态由 :meth:`snapshot` 暴露。"""

    def __init__(self, media_id: int, url: str, kind: str, headers: dict[str, str], dest: Path) -> None:
        self.media_id = int(media_id)
        self.url = str(url)
        self.kind = "hls" if str(kind).lower() == "hls" else "file"
        self.headers = {str(key): str(value) for key, value in (headers or {}).items()}
        self.dest = Path(dest)
        self.final_url = ""
        self.status = "queued"          # queued / running / paused / done / failed
        self.error = ""
        self.total = 0
        self.done = 0
        self.bytes = 0
        self.total_bytes = 0
        self.speed = 0.0
        self.started_at = time.time()
        self._pause = threading.Event()
        self._cancel = threading.Event()
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._last_bytes = 0
        self._last_time = time.time()

    # -- 控制 ---------------------------------------------------------

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name=f"webdl-{self.media_id}", daemon=True)
        self._thread.start()

    def pause(self) -> None:
        self._pause.set()
        self.status = "paused"

    def resume(self) -> None:
        self._pause.clear()
        if self.status in ("paused", "failed") and not self._alive():
            self.status = "queued"
            self.error = ""
            self.start()
        elif self.status in ("paused", "failed"):
            self.status = "running"

    def cancel(self) -> None:
        self._cancel.set()
        self._pause.set()

    def _alive(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    @property
    def paused(self) -> bool:
        return self._pause.is_set()

    # -- 状态 ---------------------------------------------------------

    def snapshot(self) -> dict:
        with self._lock:
            if self.status == "done":
                percent = 100.0
            elif self.total:
                percent = self.done / self.total * 100
            elif self.total_bytes:
                percent = min(100.0, self.bytes / self.total_bytes * 100)
            else:
                percent = 0.0
            return {
                "status": self.status,
                "paused": self.paused,
                "progress": round(percent, 1),
                "segments": self.total,
                "done_segments": self.done,
                "bytes": self.bytes,
                "speed": round(self.speed, 1),
                "error": self.error,
            }

    def _progress(self, *, added: int = 0) -> None:
        with self._lock:
            self.bytes += added
            now = time.time()
            if now - self._last_time >= 0.8:
                self.speed = max(0.0, (self.bytes - self._last_bytes) / (now - self._last_time))
                self._last_bytes = self.bytes
                self._last_time = now

    # -- 主流程 -------------------------------------------------------

    def _run(self) -> None:
        self.status = "running"
        self.started_at = time.time()
        try:
            self.dest.mkdir(parents=True, exist_ok=True)
            target, response_kind = self._prepare()
            if response_kind == "playlist":
                self._download_hls(target)
            else:
                self._download_file(target)
            if self._pause.is_set() or self._cancel.is_set():
                self.status = "paused"
                return
            self.status = "done"
            self.speed = 0.0
        except WebDownloadError as error:
            self.status = "paused" if self._pause.is_set() else "failed"
            self.error = "" if self._pause.is_set() else str(error)
        except OSError as error:
            self.status = "failed"
            self.error = f"写入文件失败：{error}"
        except Exception as error:  # noqa: BLE001 - 后台线程必须把异常落成状态
            self.status = "failed"
            self.error = f"下载出错：{error}"

    def _prepare(self) -> tuple[str, str]:
        """看一眼片源：是播放列表还是直链；直链带断点续传。"""
        part = self.dest / (DIRECT_NAME + ".part")
        for attempt in range(2):
            # 只有「已知是直链」才发 Range：拿分片偏移去请求 m3u8 会把列表截断。
            offset = 0
            if attempt == 0 and self.kind == "file" and part.is_file():
                offset = part.stat().st_size if part.stat().st_size > 0 else 0
            headers = dict(self.headers)
            if offset:
                headers["Range"] = f"bytes={offset}-"
            with _open(self.url, headers) as (response, final):
                self.final_url = final
                if response.status in (401, 403):
                    raise WebDownloadError("片源拒绝访问（401/403），请重新解析或换一条线路")
                if response.status == 416:
                    part.unlink(missing_ok=True)
                    continue
                if response.status >= 400:
                    raise WebDownloadError(f"片源返回 HTTP {response.status}")
                head = response.read(1024)
                if _is_playlist(head.decode("utf-8-sig", "replace")):
                    rest = response.read(MAX_PLAYLIST_BYTES)
                    part.unlink(missing_ok=True)
                    return (head + rest).decode("utf-8-sig", "replace"), "playlist"
                if self.kind == "hls":
                    # 声明的 HLS 实际返回了二进制：多半是单文件伪装的 m3u8，按直链再下一次。
                    self.kind = "file"
                    part.unlink(missing_ok=True)
                    continue
                if response.status == 200 and offset:
                    # 服务器忽略了 Range（常见于签名地址）：只能重下。
                    offset = 0
                    part.unlink(missing_ok=True)
                self.bytes = offset
                self._last_bytes = offset
                written = self._stream_into(response, part, offset, head)
                if self._cancel.is_set() or self._pause.is_set():
                    return str(self.dest / DIRECT_NAME), "file"
                if self.total_bytes and written < self.total_bytes:
                    raise WebDownloadError(f"直链没有下载完整（{written}/{self.total_bytes} 字节）")
                return str(self.dest / DIRECT_NAME), "file"
        raise WebDownloadError("片源地址无法续传，请重新解析后再试")

    # -- 直链 ---------------------------------------------------------

    def _stream_into(self, response, path: Path, offset: int, head: bytes) -> int:
        total = int(response.getheader("Content-Length") or 0)
        if response.status == 206:
            span = (response.getheader("Content-Range") or "").rsplit("/", 1)
            if len(span) == 2 and span[1].isdigit():
                self.total_bytes = int(span[1])
            elif total:
                self.total_bytes = offset + total
        elif total:
            self.total_bytes = total
        written = offset
        mode = "ab" if offset else "wb"
        with path.open(mode) as handle:
            if head:
                handle.write(head)
                written += len(head)
                self._progress(added=len(head))
            while True:
                if self._cancel.is_set() or self._pause.is_set():
                    break
                chunk = response.read(CHUNK)
                if not chunk:
                    break
                handle.write(chunk)
                written += len(chunk)
                self._progress(added=len(chunk))
        return written

    def _download_file(self, target: str) -> None:
        """``_prepare`` 已经把内容流进 .part；这里只做校验和改名。"""
        if self._pause.is_set() or self._cancel.is_set():
            return
        source = self.dest / (DIRECT_NAME + ".part")
        if not source.is_file() or source.stat().st_size <= 0:
            raise WebDownloadError("片源没有返回任何数据")
        source.replace(Path(target))
        self.total = 1
        self.done = 1

    # -- HLS ----------------------------------------------------------

    def _download_hls(self, text: str) -> None:
        base_url = self.final_url or self.url
        if "#EXT-X-STREAM-INF" in text:
            variant = _parse_master(text, base_url)
            text, base_url = _fetch_text(variant, self.headers)
            if not _is_playlist(text):
                raise WebDownloadError("清晰度列表读取失败")
        playlist = _expand_nested(_parse_media(text, base_url), self.headers)
        segments = playlist["segments"]
        self.total = len(segments)
        key_names: list[str] = []
        for index, key in enumerate(playlist["keys"]):
            name = f"key_{index}.key"
            key_names.append(name)
            self._download_bytes(key["uri"], self.dest / name)
        map_names: dict[str, str] = {}
        for seg in segments:
            uri = seg.get("map") or ""
            if uri and uri not in map_names:
                name = f"init_{len(map_names)}.mp4"
                map_names[uri] = name
                self._download_bytes(uri, self.dest / name)
        names = [f"seg_{index:05d}.ts" for index in range(len(segments))]
        self._download_segments(segments, names)
        if self._pause.is_set() or self._cancel.is_set():
            return
        playlist_path = self.dest / PLAYLIST_NAME
        playlist_path.write_text(
            _local_playlist(playlist, names, key_names, map_names), encoding="utf-8"
        )

    def _download_bytes(self, url: str, path: Path) -> None:
        if path.is_file() and path.stat().st_size > 0:
            return
        with _open(url, self.headers) as (response, _final):
            if response.status >= 400:
                raise WebDownloadError(f"片源分片返回 HTTP {response.status}")
            data = response.read()
        if not data:
            raise WebDownloadError("片源返回了空的分片")
        path.write_bytes(data)
        self._progress(added=len(data))

    def _download_segments(self, segments: list[dict], names: list[str]) -> None:
        pending = [
            index for index, name in enumerate(names)
            if not ((self.dest / name).is_file() and (self.dest / name).stat().st_size > 0)
        ]
        self.done = len(names) - len(pending)
        if not pending:
            return
        queue = list(pending)
        lock = threading.Lock()
        failures: list[str] = []

        def worker() -> None:
            while True:
                with lock:
                    if not queue or self._cancel.is_set() or self._pause.is_set():
                        return
                    index = queue.pop(0)
                if self._pause.is_set() or self._cancel.is_set():
                    return
                try:
                    self._segment(segments[index]["uri"], self.dest / names[index])
                    with lock:
                        self.done += 1
                except WebDownloadError as error:
                    with lock:
                        failures.append(str(error))

        threads = [threading.Thread(target=worker, daemon=True) for _ in range(min(SEGMENT_WORKERS, len(pending)))]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        if self._cancel.is_set() or self._pause.is_set():
            return
        if failures:
            raise WebDownloadError(f"{len(failures)} 个分片下载失败：{failures[0]}")

    def _segment(self, url: str, path: Path) -> None:
        temporary = path.with_suffix(path.suffix + ".part")
        last = ""
        for attempt in range(SEGMENT_RETRIES):
            if self._pause.is_set() or self._cancel.is_set():
                return
            try:
                with _open(url, self.headers) as (response, _final):
                    if response.status >= 400:
                        raise WebDownloadError(f"分片返回 HTTP {response.status}")
                    size = 0
                    with temporary.open("wb") as handle:
                        while True:
                            if self._cancel.is_set() or self._pause.is_set():
                                handle.close()
                                temporary.unlink(missing_ok=True)
                                return
                            chunk = response.read(CHUNK)
                            if not chunk:
                                break
                            handle.write(chunk)
                            size += len(chunk)
                            self._progress(added=len(chunk))
                if size <= 0:
                    raise WebDownloadError("分片是空的")
                temporary.replace(path)
                return
            except (WebDownloadError, OSError, http.client.HTTPException) as error:
                last = str(error)
                temporary.unlink(missing_ok=True)
                if attempt + 1 < SEGMENT_RETRIES:
                    time.sleep(RETRY_DELAYS[min(attempt, len(RETRY_DELAYS) - 1)])
        raise WebDownloadError(last or "分片下载失败")


# ---------------------------------------------------------------- 注册表

_TASKS: dict[int, WebTask] = {}
_LOCK = threading.Lock()


def start(media_id: int, url: str, kind: str, headers: dict[str, str], dest: Path) -> WebTask:
    task = WebTask(media_id, url, kind, headers, dest)
    with _LOCK:
        _TASKS[int(media_id)] = task
    task.start()
    return task


def get(media_id: int) -> WebTask | None:
    with _LOCK:
        return _TASKS.get(int(media_id))


def drop(media_id: int) -> WebTask | None:
    with _LOCK:
        return _TASKS.pop(int(media_id), None)


def clear_folder(dest: Path) -> None:
    try:
        shutil.rmtree(dest, ignore_errors=True)
    except OSError:
        pass
