"""蜜柑计划搜索：只读它的搜索 RSS，不解析网页、不处理登录态。

搜索地址固定为 ``/RSS/Search?searchstr=<关键词>``，单次最多返回 100 条，
每条带标题、大小、发布时间、种子直链和条目页链接，字段已经够用，因此这里
不做 HTML 抓取。

官方主域名 ``mikanani.me`` 在国内不可达（连接阶段就超时），所以按 ``MIRRORS``
顺序尝试；第一个成功的记住，后续请求先用它，全部失败才抛 ``MikanError``，
调用方据此给出可读提示，不会静默返回空列表。
"""
from __future__ import annotations

import re
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ElementTree
from typing import Any, Callable

MIRRORS = (
    "https://mikanime.tv",
    "https://mikanani.kas.pub",
    "https://mikanani.me",
)
USER_AGENT = "AnimeHandbook/1.0 (+local)"
REQUEST_TIMEOUT = 20
MAX_FEED_BYTES = 8 * 1024 * 1024
MAX_TORRENT_BYTES = 8 * 1024 * 1024
MAX_RESULTS = 100
MAX_QUERY_CHARS = 60

_GROUP_RE = re.compile(r"^\s*[\[【]([^\]】]{1,40})[\]】]")
_RESOLUTION_RE = re.compile(r"(2160p|1440p|1080p|720p|576p|480p)", re.IGNORECASE)
_DEPTH_RE = re.compile(r"(10-?bit|8-?bit|ma10p)", re.IGNORECASE)
_HEVC_RE = re.compile(r"hevc|[xh]\.?265", re.IGNORECASE)
_AVC_RE = re.compile(r"[xh]\.?264|\bavc\b", re.IGNORECASE)
_BATCH_RE = re.compile(r"合集|\bfin\b|\bcomplete\b|全集", re.IGNORECASE)


class MikanError(RuntimeError):
    """搜索失败；调用方保留原状态并提示，不伪造空结果。"""


def format_size(size: int) -> str:
    """把字节数变成人能读的大小；种子大小动辄十几 GB，不需要更细的精度。"""
    try:
        value = int(size)
    except (TypeError, ValueError):
        return ""
    if value <= 0:
        return ""
    for unit, limit in (("TB", 1 << 40), ("GB", 1 << 30), ("MB", 1 << 20), ("KB", 1 << 10)):
        if value >= limit:
            return f"{value / limit:.1f} {unit}"
    return f"{value} B"


def _subtitles(title: str) -> str:
    """把「简繁日内封」这类标签归一到「简繁内封 / 简体内封 / 内封」四种之一。

    字幕组写法五花八门，这里只做归并，不改写原标签；归并后的值用于筛选。
    """
    if "外挂" in title or "外挂字幕" in title:
        kind = "外挂"
    elif "内封" in title:
        kind = "内封"
    elif "内嵌" in title:
        kind = "内嵌"
    elif "内挂" in title:
        kind = "内挂"
    else:
        return ""
    simplified = "简" in title
    traditional = "繁" in title
    if simplified and traditional:
        return "简繁" + kind
    if simplified:
        return "简体" + kind
    if traditional:
        return "繁体" + kind
    return kind


def parse_title(title: str) -> dict[str, Any]:
    """从字幕组标题里拆出可直接筛选的字段。

    例：``[VCB-Studio] 全金属狂潮 / Full Metal Panic! 10-bit 720p/1080p
    AVC/HEVC BDRip [S1-S4 Reseed Fin]`` → 组=VCB-Studio、分辨率=720p、
    编码=HEVC、位深=10bit、合集=True。
    """
    text = str(title or "")
    group = ""
    matched = _GROUP_RE.match(text)
    if matched:
        group = matched.group(1).strip()
    resolution = ""
    found = _RESOLUTION_RE.search(text)
    if found:
        resolution = found.group(1).lower()
    depth = ""
    found = _DEPTH_RE.search(text)
    if found:
        depth = found.group(1).lower().replace("-", "").replace("ma", "")
        depth = "10bit" if depth.startswith("10") else ("8bit" if depth.startswith("8") else "")
    # AVC 和 HEVC 同时出现时（双版本种子）以 HEVC 为准，因为那是画质更好的一支。
    codec = ""
    if _HEVC_RE.search(text):
        codec = "HEVC"
    elif _AVC_RE.search(text):
        codec = "H.264"
    return {
        "group": group,
        "resolution": resolution,
        "codec": codec,
        "bit_depth": depth,
        "subtitles": _subtitles(text),
        "batch": bool(_BATCH_RE.search(text)),
    }


def _child_text(node: ElementTree.Element, suffix: str) -> str:
    """读取带命名空间的子节点（``torrent:contentLength`` 前缀随主机变化）。"""
    for child in node:
        tag = child.tag.rsplit("}", 1)[-1]
        if tag == suffix and child.text:
            return child.text.strip()
    return ""


def _torrent_id(torrent_url: str) -> str:
    name = urllib.parse.urlsplit(torrent_url).path.rsplit("/", 1)[-1]
    return name[:-len(".torrent")] if name.endswith(".torrent") else name


def parse_feed(payload: bytes, base: str = MIRRORS[0]) -> list[dict[str, Any]]:
    """解析搜索 RSS。坏掉一条就跳过一条，不因为单个条目异常丢掉整页。"""
    try:
        root = ElementTree.fromstring(payload)
    except ElementTree.ParseError as error:
        raise MikanError(f"蜜柑返回的不是有效 RSS：{error}") from error
    channel = root.find("channel")
    if channel is None:
        raise MikanError("蜜柑返回的 RSS 缺少 channel 节点")
    items: list[dict[str, Any]] = []
    for node in channel.findall("item"):
        title = (node.findtext("title") or "").strip()
        if not title:
            continue
        enclosure = node.find("enclosure")
        torrent_url = ""
        size = 0
        if enclosure is not None:
            torrent_url = (enclosure.get("url") or "").strip()
            try:
                size = int(enclosure.get("length") or 0)
            except ValueError:
                size = 0
        if size <= 0:
            try:
                size = int(_child_text(node, "contentLength") or 0)
            except ValueError:
                size = 0
        item = {
            "id": _torrent_id(torrent_url) or (node.findtext("guid") or "").strip(),
            "title": title,
            "size": size,
            "size_text": format_size(size),
            "published_at": _child_text(node, "pubDate"),
            "torrent_url": torrent_url,
            "page_url": (node.findtext("link") or "").strip(),
        }
        item.update(parse_title(title))
        items.append(item)
    return items


def search_url(base: str, keyword: str) -> str:
    return f"{base.rstrip('/')}/RSS/Search?searchstr={urllib.parse.quote(keyword)}"


def _open(
    request: urllib.request.Request,
    timeout: float,
    opener: Callable[..., Any] | None,
) -> bytes:
    handle = urllib.request.urlopen if opener is None else opener
    with handle(request, timeout=timeout) as response:
        return response.read(MAX_FEED_BYTES + 1)


def search(
    keyword: str,
    *,
    prefer: str = "",
    limit: int = 40,
    timeout: float = REQUEST_TIMEOUT,
    opener: Callable[..., Any] | None = None,
    mirrors: tuple[str, ...] = MIRRORS,
) -> dict[str, Any]:
    """按关键词搜索，返回 ``{"base", "items", "truncated"}``。

    ``prefer`` 传上次成功的主机，省掉一次必然失败的尝试；它仍会在失败时
    回落到其余镜像，所以不需要在调用方做额外容错。
    """
    query = " ".join(str(keyword or "").split())[:MAX_QUERY_CHARS]
    if not query:
        raise MikanError("请输入搜索关键词")
    hosts: list[str] = []
    for host in ([prefer] if prefer else []) + list(mirrors):
        host = str(host or "").strip().rstrip("/")
        if host and host not in hosts:
            hosts.append(host)
    failures: list[str] = []
    for host in hosts:
        request = urllib.request.Request(
            search_url(host, query),
            headers={"User-Agent": USER_AGENT, "Accept": "application/rss+xml, application/xml"},
        )
        try:
            payload = _open(request, timeout, opener)
        except (urllib.error.URLError, OSError, TimeoutError) as error:
            failures.append(f"{urllib.parse.urlsplit(host).hostname or host}: {error}")
            continue
        if len(payload) > MAX_FEED_BYTES:
            failures.append(f"{host}: 响应异常偏大")
            continue
        items = parse_feed(payload, host)
        wanted = max(1, min(int(limit or 0), MAX_RESULTS))
        return {"base": host, "items": items[:wanted], "truncated": len(items) >= MAX_RESULTS}
    raise MikanError("蜜柑搜索不可用：" + "；".join(failures) if failures else "蜜柑搜索不可用")


def fetch_torrent(
    torrent_url: str,
    *,
    timeout: float = REQUEST_TIMEOUT,
    opener: Callable[..., Any] | None = None,
) -> bytes:
    """取回种子文件本体；调用方负责把它交给下载器。

    不让下载器自己去拉这个地址，是因为它可能落在代理或墙外，而手账这边
    已经验证过能连通；几百 KB 的文件本地取一次更稳。
    """
    url = str(torrent_url or "").strip()
    if not url.startswith(("http://", "https://")):
        raise MikanError("种子地址无效")
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        payload = _open(request, timeout, opener)
    except (urllib.error.URLError, OSError, TimeoutError) as error:
        raise MikanError(f"种子下载失败：{error}") from error
    if len(payload) > MAX_TORRENT_BYTES:
        raise MikanError("种子文件异常偏大，已跳过")
    # bencode 字典一定以 d 开头，否则多半是拿回了一张错误页。
    if not payload.lstrip().startswith(b"d"):
        raise MikanError("种子文件内容无效")
    return payload
