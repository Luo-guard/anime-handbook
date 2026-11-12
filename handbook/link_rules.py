"""Kazumi 规则仓库 → 详情页跳转链接。

规则仓库里的每个 JSON 描述一个番剧站点的搜索与解析方式。手账只取其中的
站点名和搜索地址，用来在详情页生成「去这个站搜这部番」的链接；解析规则、
播放地址、弹幕配置一概不用，也不抓取站点内容。

整包一次下载（约 50 KB），本地缓存，用户点「刷新」才会再次联网。
"""
from __future__ import annotations

import io
import json
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

ARCHIVE_URL = "https://codeload.github.com/Predidit/KazumiRules/zip/refs/heads/main"
SOURCE_LABEL = "KazumiRules"
CACHE_FILE = "link-rules.json"
MAX_ARCHIVE_BYTES = 4 * 1024 * 1024
REQUEST_TIMEOUT = 25
CACHE_TTL = 6 * 3600


class RuleFetchError(RuntimeError):
    """规则仓库不可用；调用方保留旧缓存并如实提示。"""


def _host(url: str) -> str:
    try:
        host = urlsplit(url).hostname or ""
    except ValueError:
        return ""
    return host[4:] if host.startswith("www.") else host


def rule_to_link(stem: str, rule: Any) -> dict[str, Any] | None:
    """Build a jump link only when the rule has a plain GET search address.

    Rules that search through an API (``searchURL`` empty) or POST cannot be
    turned into a link, so they are skipped instead of producing a dead entry.
    """
    if not isinstance(rule, dict):
        return None
    if str(rule.get("type") or "anime").lower() != "anime":
        return None
    if rule.get("usePost") is True:
        return None
    search = str(rule.get("searchURL") or "").strip()
    if not search.startswith(("http://", "https://")):
        return None
    if "@keyword" not in search and "{keyword}" not in search:
        return None
    template = search.replace("@keyword", "{title}").replace("{keyword}", "{title}")
    base = str(rule.get("baseURL") or "").strip()
    host = _host(base) or _host(search)
    if not host:
        return None
    name = str(rule.get("name") or stem).strip() or stem
    return {
        "id": f"rule-{stem.lower()}",
        "name": name,
        "host": host,
        "base_url": base,
        "template": template,
        "version": str(rule.get("version") or ""),
    }


def extract_rules(payload: bytes) -> list[dict[str, Any]]:
    """Read every top-level ``*.json`` rule from the downloaded archive."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(payload))
    except zipfile.BadZipFile as error:
        raise RuleFetchError("规则仓库返回的不是有效的压缩包") from error
    links: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in archive.namelist():
        # 只要仓库根目录下的规则文件；跳过 .github 等子目录。
        if entry.count("/") != 1 or not entry.lower().endswith(".json"):
            continue
        try:
            rule = json.loads(archive.read(entry).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            continue
        link = rule_to_link(Path(entry).stem, rule)
        if not link or link["template"] in seen:
            continue
        seen.add(link["template"])
        links.append(link)
    links.sort(key=lambda item: (item["name"].lower(), item["host"]))
    return links


def fetch_archive(timeout: float = REQUEST_TIMEOUT) -> bytes:
    request = urllib.request.Request(ARCHIVE_URL, headers={"User-Agent": "AnimeHandbook/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read(MAX_ARCHIVE_BYTES + 1)
    except (urllib.error.URLError, OSError, TimeoutError) as error:
        raise RuleFetchError(f"连不上规则仓库：{error}") from error
    if len(payload) > MAX_ARCHIVE_BYTES:
        raise RuleFetchError("规则仓库压缩包异常偏大，已跳过")
    return payload


def fetch_rules(timeout: float = REQUEST_TIMEOUT) -> list[dict[str, Any]]:
    links = extract_rules(fetch_archive(timeout))
    if not links:
        raise RuleFetchError("规则仓库里没有可直接跳转的搜索链接")
    return links


def cache_path(asset_root: Path) -> Path:
    return Path(asset_root) / CACHE_FILE


def load_cache(path: Path) -> dict[str, Any]:
    try:
        document = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"items": [], "fetched_at": 0, "source": SOURCE_LABEL, "error": ""}
    if not isinstance(document, dict) or not isinstance(document.get("items"), list):
        return {"items": [], "fetched_at": 0, "source": SOURCE_LABEL, "error": ""}
    return document


def refresh(path: Path, timeout: float = REQUEST_TIMEOUT) -> dict[str, Any]:
    items = fetch_rules(timeout=timeout)
    # 和上一份缓存对比，告诉用户这次多了/少了哪些站点；固定过的链接不受影响。
    previous = load_cache(path)
    old_ids = {str(item.get("id")) for item in previous.get("items") or [] if isinstance(item, dict)}
    new_ids = {str(item.get("id")) for item in items}
    document = {
        "items": items,
        "fetched_at": int(time.time()),
        "source": SOURCE_LABEL,
        "error": "",
        "added": len(new_ids - old_ids) if old_ids else 0,
        "removed": len(old_ids - new_ids),
    }
    target = Path(path)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(target.name + ".tmp")
        temporary.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")
        temporary.replace(target)
    except OSError as error:
        raise RuleFetchError(f"规则缓存写入失败：{error}") from error
    return document


def payload(document: dict[str, Any], limit: int, *, now: float | None = None) -> dict[str, Any]:
    """Shape the HTTP response; ``stale`` only marks ageing, it never refetches."""
    fetched_at = int(document.get("fetched_at") or 0)
    current = time.time() if now is None else now
    return {
        "ok": True,
        "source": document.get("source") or SOURCE_LABEL,
        "items": document.get("items") or [],
        "fetched_at": fetched_at,
        "stale": bool(fetched_at) and current - fetched_at > CACHE_TTL,
        "limit": limit,
        "error": str(document.get("error") or ""),
        "added": int(document.get("added") or 0),
        "removed": int(document.get("removed") or 0),
    }
