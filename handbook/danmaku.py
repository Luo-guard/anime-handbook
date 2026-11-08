"""弹幕数据源：本地弹幕文件解析 + 弹弹play 兼容 API 代理。

刻意不碰播放内核：视频仍是原生 ``<video>`` 播 mp4（Range 流），弹幕只是浮在
canvas 上的一层，NijiLucid 这类抓帧超分扩展照常接管原生 video。

这里只负责把各种来源的弹幕归一成同一份::

    [{"time": 12.34, "mode": 1, "size": 25, "color": "#ffffff", "text": "..."}]

mode 沿用 B 站约定：1 滚动、4 底部固定、5 顶部固定。
"""
from __future__ import annotations

import base64
import hashlib
import html
import ipaddress
import json
import os
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

MAX_LOCAL_BYTES = 8 * 1024 * 1024
MAX_UPSTREAM_BYTES = 8 * 1024 * 1024
# 在线源只允许官方域名、本机和私有网段，避免这个接口被当成任意 URL 代理。
ALLOWED_HOSTS = {"api.dandanplay.net", "localhost", "127.0.0.1", "::1"}


def _color(value) -> str:
    try:
        number = int(str(value).strip(), 0) & 0xFFFFFF
    except (TypeError, ValueError):
        return "#ffffff"
    return f"#{number:06x}"


def _time(value) -> float | None:
    try:
        number = float(str(value).strip())
    except (TypeError, ValueError):
        return None
    return number if -1 < number < 86400 else None


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", str(text)))).strip()[:200]


def parse_bili_xml(text: str) -> list[dict]:
    """B 站 / 弹弹play 导出的 XML：``<d p="时间,模式,字号,颜色,...">文字</d>``。"""
    items: list[dict] = []
    pattern = re.compile(r"<d\s+p=[\"']([^\"']*)[\"'][^>]*>(.*?)</d>", re.S | re.I)
    for match in pattern.finditer(text):
        seconds = _time(match.group(1).split(",")[0])
        if seconds is None:
            continue
        fields = match.group(1).split(",")
        content = _clean(match.group(2))
        if not content:
            continue
        try:
            mode = int(fields[1])
        except (IndexError, ValueError):
            mode = 1
        if mode not in (1, 4, 5, 6, 7, 8):
            mode = 1
        try:
            size = max(12, min(48, int(float(fields[2]))))
        except (IndexError, ValueError):
            size = 25
        items.append({
            "time": round(seconds, 3),
            "mode": mode,
            "size": size,
            "color": _color(fields[3]) if len(fields) > 3 else "#ffffff",
            "text": content,
        })
    return sorted(items, key=lambda item: item["time"])


def parse_dandan_json(payload) -> list[dict]:
    """弹弹play ``/api/v2/comment/{id}``：``comments[].p = "时间,模式,颜色,uid"``。

    也接受我们自己导出的归一化数组，方便用户把任意弹幕文件直接拖进来。
    """
    if isinstance(payload, list):
        comments = payload
    elif isinstance(payload, dict):
        comments = payload.get("comments") or payload.get("danmaku") or payload.get("items") or []
    else:
        return []
    if not isinstance(comments, list):
        return []
    items: list[dict] = []
    for entry in comments:
        if not isinstance(entry, dict):
            continue
        if "p" in entry:
            fields = str(entry.get("p") or "").split(",")
            seconds = _time(fields[0])
            if seconds is None:
                continue
            try:
                mode = int(fields[1])
            except (IndexError, ValueError):
                mode = 1
            color = _color(fields[2]) if len(fields) > 2 else "#ffffff"
            size = 25
        else:
            seconds = _time(entry.get("time"))
            if seconds is None:
                continue
            try:
                mode = int(entry.get("mode") or 1)
            except (TypeError, ValueError):
                mode = 1
            color = str(entry.get("color") or "#ffffff")
            if not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
                color = "#ffffff"
            size = 25
        content = _clean(str(entry.get("m") or entry.get("text") or ""))
        if not content:
            continue
        items.append({
            "time": round(seconds, 3),
            "mode": mode if mode in (1, 4, 5, 6, 7, 8) else 1,
            "size": size,
            "color": color,
            "text": content,
        })
    return sorted(items, key=lambda item: item["time"])


def parse_text(text: str) -> list[dict]:
    """按内容猜格式：XML 走 B 站解析，其余按 JSON。"""
    stripped = text.lstrip("\ufeff \t\r\n")
    if stripped.startswith("<"):
        return parse_bili_xml(stripped)
    try:
        return parse_dandan_json(json.loads(stripped))
    except (ValueError, TypeError):
        return []


def local_danmaku_files(video_path: str | Path) -> list[Path]:
    """找同一集配套的弹幕文件：同名 .xml/.json、``*.danmaku.xml``，
    或同目录里唯一的 .xml（字幕组打包时常见的形态）。"""
    video = Path(str(video_path or ""))
    if not video.is_file():
        return []
    folder = video.parent
    stem = video.stem
    names = [
        stem + ".xml", stem + ".json",
        stem + ".danmaku.xml", stem + ".danmaku.json",
        stem + ".dandanplay.xml",
    ]
    found: list[Path] = []
    for name in names:
        candidate = folder / name
        if candidate.is_file() and candidate.stat().st_size <= MAX_LOCAL_BYTES:
            found.append(candidate)
    if found:
        return found
    try:
        singles = [
            item for item in sorted(folder.iterdir())
            if item.is_file() and item.suffix.lower() == ".xml"
            and item.stat().st_size <= MAX_LOCAL_BYTES
        ]
    except OSError:
        return []
    return singles[:1] if len(singles) == 1 else []


def load_local(video_path: str | Path) -> list[dict]:
    items: list[dict] = []
    for candidate in local_danmaku_files(video_path):
        try:
            text = candidate.read_text(encoding="utf-8-sig", errors="replace")
        except OSError:
            continue
        items.extend(parse_text(text))
    return sorted(items, key=lambda item: item["time"])


def safe_base(base: str) -> str:
    """校验在线源地址，防止这个本机接口变成任意 URL 代理。"""
    value = str(base or "").strip().rstrip("/")
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("弹幕服务地址需以 http:// 或 https:// 开头")
    host = parsed.hostname.strip("[]").lower()
    if host in ALLOWED_HOSTS:
        return value
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        raise ValueError("只允许填弹弹play 官方地址，或本机 / 局域网自建服务") from None
    if address.is_private or address.is_loopback:
        return value
    raise ValueError("在线弹幕源只允许官方域名或本机 / 局域网地址")


def signed_headers(app_id: str, app_secret: str, full_url: str) -> dict[str, str]:
    """官方开放 API 签名：base64(sha256(AppId + Timestamp + Path + AppSecret))。

    Path 是不含域名与查询参数的路径；自建服务通常把 token 放在路径前缀里，
    那种情况下不传 app_id/app_secret，签名头也就不加了。
    """
    if not app_id or not app_secret:
        return {}
    timestamp = str(int(time.time()))
    path = urllib.parse.urlsplit(full_url).path
    raw = f"{app_id}{timestamp}{path}{app_secret}".encode("utf-8")
    signature = base64.b64encode(hashlib.sha256(raw).digest()).decode("ascii")
    return {
        "X-AppId": app_id,
        "X-Signature": signature,
        "X-Timestamp": timestamp,
    }


def _system_proxy() -> str:
    """Windows 系统代理。urllib 默认不读它，之前周表就是栽在这里。"""
    if os.name != "nt":
        return ""
    try:
        import winreg
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Internet Settings",
        ) as key:
            enabled, _ = winreg.QueryValueEx(key, "ProxyEnable")
            server, _ = winreg.QueryValueEx(key, "ProxyServer")
    except OSError:
        return ""
    server = str(server or "").strip()
    if not enabled or not server or "=" in server:
        return ""
    return server if "://" in server else "http://" + server


def fetch_upstream(base: str, api_path: str, *, app_id: str = "",
                   app_secret: str = "", timeout: float = 15) -> str:
    """转发弹弹play 兼容 API，返回响应文本（前端负责解析）。"""
    root = safe_base(base)
    if not api_path.startswith("/") or ".." in api_path:
        raise ValueError("弹幕接口路径不合法")
    url = root + api_path
    headers = {
        "User-Agent": "AnimeHandbook/1.0 (personal danmaku client)",
        "Accept": "application/json, text/xml, */*",
    }
    headers.update(signed_headers(str(app_id or ""), str(app_secret or ""), url))
    request = urllib.request.Request(url, headers=headers)
    proxy = _system_proxy()
    attempts = [""]
    if proxy:
        attempts.append(proxy)
    last: Exception | None = None
    for candidate in attempts:
        try:
            if candidate:
                opener = urllib.request.build_opener(
                    urllib.request.ProxyHandler({"http": candidate, "https": candidate})
                )
                source = opener.open
            else:
                source = urllib.request.urlopen
            with source(request, timeout=timeout) as response:
                data = response.read(MAX_UPSTREAM_BYTES + 1)
            if len(data) > MAX_UPSTREAM_BYTES:
                raise ValueError("弹幕响应过大")
            return data.decode("utf-8-sig", errors="replace")
        except Exception as error:  # noqa: BLE001 - 直连失败才试系统代理
            last = error
            continue
    raise ValueError(f"弹幕服务连不上：{last}")
