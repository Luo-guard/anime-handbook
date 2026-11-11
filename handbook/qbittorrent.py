"""qBittorrent WebUI API 的最小客户端。

只覆盖手账用得到的动作：提交种子、读任务、暂停/继续、删除、探活。
不实现登录流程——qB 已配置「对本地主机跳过身份验证」，本机直连即可；
万一某个版本仍要求认证，这里会收到 403 并抛 ``QBError``，由界面提示用户
去 qB 里勾那个选项，而不是弹一个让人摸不着头脑的密码框。
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Callable

DEFAULT_BASE = "http://127.0.0.1:8080"
API_PREFIX = "/api/v2"
USER_AGENT = "AnimeHandbook/1.0 (+local)"
DEFAULT_TIMEOUT = 12.0
MAX_RESPONSE_BYTES = 4 * 1024 * 1024

# qB 5.0 把 pause/resume 改名为 stop/start，两套并行存在；按顺序试探。
_PAUSE_PATHS = ("/torrents/stop", "/torrents/pause")
_RESUME_PATHS = ("/torrents/start", "/torrents/resume")


class QBError(RuntimeError):
    """qBittorrent 不可用或拒绝了请求；调用方把它转成可读提示。"""


def build_multipart(
    fields: dict[str, str],
    files: dict[str, tuple[str, bytes]],
    boundary: str,
) -> bytes:
    """拼 multipart/form-data 请求体。

    urllib 没有现成的 multipart 编码，而提交种子恰好是「一个文件字段 + 若干
    文本字段」，手写比引第三方库划算得多。
    """
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode("utf-8")
        )
    for name, (filename, payload) in files.items():
        chunks.append(
            (
                f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; '
                f'filename="{filename}"\r\nContent-Type: application/x-bittorrent\r\n\r\n'
            ).encode("utf-8")
        )
        chunks.append(payload)
        chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(chunks)


class Client:
    def __init__(
        self,
        base: str = DEFAULT_BASE,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        opener: Callable[..., Any] | None = None,
    ) -> None:
        self.base = str(base or DEFAULT_BASE).rstrip("/")
        self.timeout = timeout
        self._opener = urllib.request.urlopen if opener is None else opener

    # ---- 传输层 -------------------------------------------------------

    def _request(
        self,
        path: str,
        *,
        data: bytes | None = None,
        headers: dict[str, str] | None = None,
        method: str = "GET",
    ) -> bytes:
        request = urllib.request.Request(
            self.base + API_PREFIX + path,
            data=data,
            headers={"User-Agent": USER_AGENT, **(headers or {})},
            method=method,
        )
        try:
            with self._opener(request, timeout=self.timeout) as response:
                return response.read(MAX_RESPONSE_BYTES)
        except urllib.error.HTTPError as error:
            detail = ""
            try:
                detail = error.read(2048).decode("utf-8", "replace").strip()
            except Exception:  # noqa: BLE001 - 读错误体失败不该盖掉原始状态码
                detail = ""
            if error.code in (401, 403):
                raise QBError(
                    "qBittorrent 要求身份验证。请到 qB 设置 → Web UI，"
                    "勾选「对本地主机上的客户端跳过身份验证」后重试。"
                ) from error
            raise QBError(f"qBittorrent 返回 {error.code}：{detail or error.reason}") from error
        except (urllib.error.URLError, OSError, TimeoutError) as error:
            raise QBError(f"连不上 qBittorrent（{self.base}）：{error}") from error

    def _json(self, path: str) -> Any:
        raw = self._request(path)
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as error:
            raise QBError("qBittorrent 返回的不是 JSON，可能版本不兼容") from error

    def _post_form(self, path: str, fields: dict[str, str]) -> bytes:
        body = urllib.parse.urlencode(fields).encode("utf-8")
        return self._request(
            path,
            data=body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )

    def _first_working(self, paths: tuple[str, ...], fields: dict[str, str]) -> None:
        last: QBError | None = None
        for index, path in enumerate(paths):
            try:
                self._post_form(path, fields)
                return
            except QBError as error:
                last = error
                # 只有最后一个动作不存在（404）才换下一个名字；其它错误直接上抛，
                # 否则会把真正的故障误当成「接口改名」而反复重试。
                if "返回 404" not in str(error):
                    raise
                if index == len(paths) - 1 and last:
                    raise
        if last:
            raise last

    # ---- 业务动作 -----------------------------------------------------

    def version(self) -> str:
        return self._request("/app/version").decode("utf-8", "replace").strip()

    def alive(self) -> bool:
        try:
            self.version()
        except QBError:
            return False
        return True

    def transfer_info(self) -> dict[str, Any]:
        return self._json("/transfer/info") or {}

    def add_torrent(
        self,
        payload: bytes,
        filename: str = "anime.torrent",
        *,
        save_path: str = "",
        category: str = "",
        tags: tuple[str, ...] = (),
        paused: bool = False,
        skip_checking: bool = False,
    ) -> None:
        """提交一个已下载到本地的 .torrent。

        刻意只收字节流而不是 URL：让 qB 自己去拉地址，会受它的代理和网络策略
        影响，而手账这边已经验证过能连通蜜柑。
        """
        if not payload:
            raise QBError("种子内容为空")
        fields: dict[str, str] = {"autoTMM": "false"}
        if save_path:
            fields["savepath"] = str(save_path)
        if category:
            fields["category"] = str(category)
        if tags:
            fields["tags"] = ",".join(str(tag) for tag in tags if str(tag).strip())
        # qB 对布尔参数只认存在与否，传 "false" 也可能被当成 true；
        # 不暂停时干脆不发这两个字段。
        if paused:
            fields["paused"] = "true"
            fields["stopped"] = "true"
        if skip_checking:
            fields["skip_checking"] = "true"
        boundary = "----AnimeHandbook" + uuid.uuid4().hex
        body = build_multipart(fields, {"torrents": (filename, payload)}, boundary)
        raw = self._request(
            "/torrents/add",
            data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        )
        text = raw.decode("utf-8", "replace").strip()
        if text and not text.lower().startswith("ok"):
            raise QBError(f"qBittorrent 拒绝了这个种子：{text}")

    def torrents(self, *, tag: str = "", category: str = "") -> list[dict[str, Any]]:
        query: dict[str, str] = {}
        if tag:
            query["tag"] = tag
        if category:
            query["category"] = category
        path = "/torrents/info"
        if query:
            path += "?" + urllib.parse.urlencode(query)
        items = self._json(path)
        return items if isinstance(items, list) else []

    def torrent(self, torrent_hash: str) -> dict[str, Any] | None:
        if not torrent_hash:
            return None
        items = self._json("/torrents/info?" + urllib.parse.urlencode({"hashes": torrent_hash}))
        if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
            raise QBError("qBittorrent 返回的任务列表无效")
        return items[0] if items else None

    def pause(self, torrent_hashes: list[str]) -> None:
        self._first_working(_PAUSE_PATHS, {"hashes": "|".join(torrent_hashes)})

    def resume(self, torrent_hashes: list[str]) -> None:
        self._first_working(_RESUME_PATHS, {"hashes": "|".join(torrent_hashes)})

    def delete(self, torrent_hashes: list[str], *, delete_files: bool = False) -> None:
        self._post_form(
            "/torrents/delete",
            {
                "hashes": "|".join(torrent_hashes),
                "deleteFiles": "true" if delete_files else "false",
            },
        )


def normalise_base(host: str, port: Any, *, scheme: str = "http") -> str:
    """把用户填的主机和端口拼成可用的 base URL；端口非法时退回默认值。"""
    host = str(host or "").strip().rstrip("/")
    if not host:
        return DEFAULT_BASE
    if host.startswith(("http://", "https://")):
        base = host
        parsed = urllib.parse.urlsplit(base)
        netloc = parsed.hostname or "127.0.0.1"
    else:
        netloc = host
        base = ""
    try:
        number = int(port)
    except (TypeError, ValueError):
        number = 0
    if not (0 < number < 65536):
        number = urllib.parse.urlsplit(DEFAULT_BASE).port or 8080
    if not base:
        base = f"{scheme}://{netloc}"
    parsed = urllib.parse.urlsplit(base)
    netloc = parsed.netloc if parsed.port else f"{parsed.hostname or netloc}:{number}"
    return urllib.parse.urlunsplit((parsed.scheme or scheme, netloc, parsed.path.rstrip("/"), "", ""))
