from __future__ import annotations

import json
import base64
import hashlib
import io
import mimetypes
import os
import re
import secrets
import sqlite3
import subprocess
import sys
import threading
import tempfile
import time
import urllib.error
import urllib.request
import webbrowser
import shutil
import uuid
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import parse_qs, quote, unquote, urlparse
from html import unescape
from schedule import ScheduleService, attach_collection, season_key

try:
    from PIL import Image
    from pillow_heif import read_heif
except ImportError:  # HEIC support is optional until such an image is uploaded.
    Image = None
    read_heif = None


APP_ROOT = Path(__file__).resolve().parent.parent
STATIC_ROOT = APP_ROOT / "static"
DEFAULT_DATA_ROOT = APP_ROOT / "data"
DATA_ROOT = Path(os.environ.get("ANIME_HANDBOOK_DATA_DIR", DEFAULT_DATA_ROOT))
DB_PATH = DATA_ROOT / "handbook.db"
COVER_ROOT = DATA_ROOT / "covers"
CHARACTER_COVER_ROOT = DATA_ROOT / "character-covers"
BACKGROUND_ROOT = DATA_ROOT / "background"
RECORD_IMAGE_ROOT = DATA_ROOT / "record-images"
PROFILE_ROOT = DATA_ROOT / "profiles"
PROFILE_REGISTRY_PATH = PROFILE_ROOT / "registry.json"
SHARING_CONFIG_PATH = DATA_ROOT / "sharing.json"
WEBDAV_CONFIG_PATH = DATA_ROOT / "webdav.json"
PORT = int(os.environ.get("ANIME_HANDBOOK_PORT", "43127"))
HOST = "127.0.0.1"
MAX_JSON_BODY_BYTES = 12 * 1024 * 1024
AUTOSTART_SCRIPT_NAME = "AnimeHandbook.vbs"


BGM_OFFICIAL_SOURCE = {
    "id": "official",
    "name": "Bangumi 官方",
    "site_base": "https://bgm.tv",
    "api_base": "https://api.bgm.tv",
}


def normalize_http_base(value: Any, field_name: str) -> str:
    """Validate a configurable Bangumi website/API base URL."""
    candidate = str(value or "").strip().rstrip("/")
    parsed = urlparse(candidate)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"{field_name} 必须是完整的 http(s) 地址")
    return candidate


def normalize_bgm_sources(value: Any) -> list[dict[str, str]]:
    """Normalize saved Bangumi sources and keep source ids stable for switching."""
    if not isinstance(value, list):
        raise ValueError("Bangumi 站点列表格式错误")
    sources: list[dict[str, str]] = []
    used_ids: set[str] = set()
    for index, raw in enumerate(value):
        if not isinstance(raw, dict):
            continue
        source_id = re.sub(r"[^a-z0-9_-]", "", str(raw.get("id") or "").lower())
        source_id = source_id[:40] or f"source-{index + 1}"
        while source_id in used_ids:
            source_id = f"{source_id[:35]}-{len(used_ids) + 1}"
        name = str(raw.get("name") or "").strip()[:50]
        if not name:
            raise ValueError("Bangumi 站点名称不能为空")
        sources.append({
            "id": source_id,
            "name": name,
            "site_base": normalize_http_base(raw.get("site_base"), "站点地址"),
            "api_base": normalize_http_base(raw.get("api_base"), "API 地址"),
        })
        used_ids.add(source_id)
    if not sources:
        raise ValueError("请至少保留一个 Bangumi 站点")
    return sources


def normalize_background_bytes(image: bytes) -> tuple[bytes, str]:
    """Return browser-safe image bytes and the matching extension."""
    if len(image) >= 12 and image[4:12] in {
        b"ftypheic", b"ftypheix", b"ftyphevc", b"ftyphevx", b"ftypmif1"
    }:
        if read_heif is None or Image is None:
            raise ValueError("该图片实际为 HEIC 格式，请安装 pillow-heif 后重试")
        heif = read_heif(image)
        converted = Image.frombytes(heif.mode, heif.size, heif.data, "raw")
        output = io.BytesIO()
        converted.convert("RGB").save(output, format="JPEG", quality=92, optimize=True)
        return output.getvalue(), "jpg"
    return image, ""


def migrate_legacy_backgrounds() -> None:
    """Repair earlier HEIC uploads that were saved with a misleading .jpg suffix."""
    if not BACKGROUND_ROOT.exists():
        return
    for path in BACKGROUND_ROOT.glob("background*.jpg"):
        original = path.read_bytes()
        converted, extension = normalize_background_bytes(original)
        if extension:
            path.write_bytes(converted)


def safe_asset_id(value: Any, default: str = "default") -> str:
    """Return a filesystem-safe id used only for handbook-owned assets."""
    return re.sub(r"[^A-Za-z0-9_-]", "", str(value or ""))[:80] or default


def background_stem(account_id: Any, theme_id: Any) -> str:
    """Keep per-account theme images separate, including shared mirrors."""
    return f"background-{safe_asset_id(account_id, 'local')}-{safe_asset_id(theme_id)}"


def find_background_asset(account_id: Any, theme_id: Any, *, root: Path | None = None) -> Path | None:
    """Find a namespaced image, falling back to images made by older builds."""
    root = root if root is not None else BACKGROUND_ROOT
    stem = background_stem(account_id, theme_id)
    image = next(iter(root.glob(f"{stem}.*")), None)
    if image:
        return image
    legacy = safe_asset_id(theme_id)
    return next(iter(root.glob(f"background-{legacy}.*")), None)


def path_identity(value: Any) -> str:
    """Compare Windows paths consistently without requiring the file to exist."""
    raw = str(value or "").strip()
    return os.path.normcase(os.path.abspath(os.path.expanduser(raw))) if raw else ""


def windows_startup_script() -> Path | None:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        return None
    return (
        Path(appdata)
        / "Microsoft"
        / "Windows"
        / "Start Menu"
        / "Programs"
        / "Startup"
        / AUTOSTART_SCRIPT_NAME
    )


def configure_windows_autostart(enabled: bool) -> bool:
    """Create or remove this user's silent Windows startup launcher."""
    startup_script = windows_startup_script()
    if startup_script is None:
        return False
    if not enabled:
        startup_script.unlink(missing_ok=True)
        return False
    python_executable = Path(sys.executable)
    pythonw = python_executable.with_name("pythonw.exe")
    executable = pythonw if pythonw.is_file() else python_executable
    startup_script.parent.mkdir(parents=True, exist_ok=True)
    command = f'"{executable}" "{APP_ROOT / "app.py"}"'
    startup_script.write_text(
        'Set shell = CreateObject("WScript.Shell")\r\n'
        f'shell.Run "{command.replace(chr(34), chr(34) * 2)}", 0, False\r\n',
        encoding="utf-8",
    )
    return True

CATEGORY_NAMES = {
    1: "在看",
    2: "想看",
    3: "搁置",
    4: "看过",
    5: "抛弃",
}

EPISODE_TYPE_NAMES = {
    0: "本篇",
    1: "SP",
    2: "OP",
    3: "ED",
    4: "预告",
    5: "MAD",
    6: "其它",
}

EPISODE_TYPE_ORDER = {
    0: 0,
    1: 1,
    2: 2,
    3: 3,
    4: 4,
    5: 5,
    6: 6,
}


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def json_list(raw: str | None) -> list[Any]:
    try:
        value = json.loads(raw or "[]")
    except json.JSONDecodeError:
        return []
    return value if isinstance(value, list) else []


def normalize_theme_ids(value: Any, fallback: str = "other") -> list[str]:
    """Normalize a record's theme list while keeping one legacy primary theme."""
    candidates = value if isinstance(value, list) else [value]
    result: list[str] = []
    for item in candidates:
        name = str(item or "").strip()
        if name and name not in result:
            result.append(name)
    return result or ([fallback] if fallback else [])


def episode_type_label(type_value: int) -> str:
    return EPISODE_TYPE_NAMES.get(int(type_value), f"类型 {type_value}")


def episode_display_number(value: Any) -> str:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return str(value or "")
    if number.is_integer():
        integer = int(number)
        return f"{integer:02d}" if 0 < integer < 100 else str(integer)
    return str(value)


def episode_sort_value(episode: dict[str, Any]) -> float:
    for key in ("sort", "ep"):
        try:
            return float(episode.get(key) or 0)
        except (TypeError, ValueError):
            continue
    return 0


def normalize_episode(raw: dict[str, Any], fallback_index: int = 0) -> dict[str, Any]:
    type_value = int(raw.get("type") or 0)
    sort_value = raw.get("sort")
    if sort_value in (None, ""):
        sort_value = raw.get("ep") or fallback_index
    key_source = raw.get("id") or f"{type_value}:{sort_value or fallback_index}"
    key = f"bgm:{key_source}" if raw.get("id") else f"{type_value}:{sort_value or fallback_index}"
    label = episode_display_number(sort_value or raw.get("ep") or fallback_index)
    type_name = episode_type_label(type_value)
    return {
        "key": str(key),
        "id": int(raw["id"]) if raw.get("id") else None,
        "type": type_value,
        "type_label": type_name,
        "sort": sort_value,
        "ep": raw.get("ep"),
        "label": label,
        "display_label": f"{type_name} {label}",
        "name": str(raw.get("name") or ""),
        "name_cn": str(raw.get("name_cn") or ""),
        "airdate": str(raw.get("airdate") or ""),
        "duration": str(raw.get("duration") or ""),
    }


def normalize_episodes(raw_items: list[Any]) -> list[dict[str, Any]]:
    episodes = [
        normalize_episode(item, index + 1)
        for index, item in enumerate(raw_items)
        if isinstance(item, dict)
    ]
    return sorted(
        episodes,
        key=lambda episode: (
            EPISODE_TYPE_ORDER.get(int(episode["type"]), 99),
            episode_sort_value(episode),
            episode.get("id") or 0,
        ),
    )


def aired_main_episode_count(
    episodes: list[dict[str, Any]], *, as_of: date | None = None
) -> int:
    """Count regular episodes whose Bangumi air date has arrived.

    Bangumi lists scheduled future episodes too, so the list length is not the
    same thing as the number currently available to watch.
    """
    today = as_of or datetime.now().astimezone().date()
    aired = 0
    for episode in episodes:
        if int(episode.get("type") or 0) != 0:
            continue
        raw_date = str(episode.get("airdate") or "").strip()[:10]
        try:
            air_date = date.fromisoformat(raw_date)
        except ValueError:
            continue
        if air_date <= today:
            aired += 1
    return aired


def generated_episodes(count: int) -> list[dict[str, Any]]:
    count = max(0, int(count or 0))
    return [
        normalize_episode(
            {"type": 0, "sort": index, "ep": index, "name": f"第 {index} 集"},
            index,
        )
        for index in range(1, count + 1)
    ]


def episode_groups(episodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[int, dict[str, Any]] = {}
    for episode in episodes:
        type_value = int(episode.get("type") or 0)
        if type_value not in grouped:
            grouped[type_value] = {
                "type": type_value,
                "type_label": episode_type_label(type_value),
                "count": 0,
                "episodes": [],
            }
        grouped[type_value]["episodes"].append(episode)
        grouped[type_value]["count"] += 1
    return [
        grouped[key]
        for key in sorted(grouped, key=lambda value: EPISODE_TYPE_ORDER.get(value, 99))
    ]


def episode_summary(episodes: list[dict[str, Any]]) -> str:
    groups = episode_groups(episodes)
    if not groups:
        return "章节待同步"
    return " · ".join(
        f"{group['type_label']} {group['count']}" for group in groups
    )


def normalize_watched_keys(
    watched: list[Any],
    episodes: list[dict[str, Any]],
    fallback_count: int = 0,
) -> list[str]:
    if not episodes and fallback_count:
        episodes = generated_episodes(fallback_count)
    valid_keys = {str(episode["key"]) for episode in episodes}
    main_by_number: dict[int, str] = {}
    for episode in episodes:
        if int(episode.get("type") or 0) != 0:
            continue
        for value in (episode.get("sort"), episode.get("ep"), episode.get("label")):
            try:
                number = int(float(value))
            except (TypeError, ValueError):
                continue
            if number > 0 and number not in main_by_number:
                main_by_number[number] = str(episode["key"])
    result: set[str] = set()
    for item in watched:
        key = str(item)
        if key in valid_keys:
            result.add(key)
            continue
        legacy_main_key = re.fullmatch(r"(?:0|main):(\d+)", key)
        try:
            number = int(legacy_main_key.group(1)) if legacy_main_key else int(float(item))
        except (TypeError, ValueError):
            continue
        mapped = main_by_number.get(number)
        if mapped:
            result.add(mapped)
    order = {str(episode["key"]): index for index, episode in enumerate(episodes)}
    return sorted(result, key=lambda key: order.get(key, 10**9))


def with_initial_appearance(html: str, settings: dict[str, Any], account_id: str) -> str:
    """Embed only the active account's appearance, before the blocking theme script."""
    keys = ("theme_color", "custom_theme_color", "custom_background_enabled",
            "active_theme_profile", "custom_background_version", "custom_background_overlay_opacity")
    payload = json.dumps({"settings": {key: settings[key] for key in keys if key in settings},
                          "account_id": account_id}, ensure_ascii=True).replace("<", "\\u003c")
    marker = '<script id="initialAppearance" type="application/json">{}</script>'
    return html.replace(marker, f'<script id="initialAppearance" type="application/json">{payload}</script>', 1)




def normalize_schedule_grouping(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) - {"mode", "collection_order", "status_order", "sorts", "direction", "directions"}:
        raise ValueError("周表分组排序无效")
    mode = value.get("mode", "none")
    if mode not in ("none", "collection", "status"):
        raise ValueError("周表分组方式无效")
    result = {"mode": mode}
    for key, defaults in [("collection_order", ["collected", "uncollected"]), ("status_order", ["1", "2", "3", "4", "5", "uncollected"])]:
        order = value.get(key, defaults)
        if not isinstance(order, list) or any(not isinstance(item, str) or item not in defaults for item in order) or len(set(order)) != len(order):
            raise ValueError("周表分组顺序无效")
        result[key] = order + [item for item in defaults if item not in order]
    sorts = value.get("sorts", {})
    if not isinstance(sorts, dict) or any(key not in {"collected", "uncollected", "1", "2", "3", "4", "5"} or sort not in ("time", "score", "popularity") for key, sort in sorts.items()):
        raise ValueError("周表组内排序无效")
    result["sorts"] = dict(sorts)
    direction = value.get("direction")
    directions = value.get("directions", {})
    if direction is not None and direction not in ("asc", "desc"):
        raise ValueError("周表排序方向无效")
    if not isinstance(directions, dict) or any(key not in {"collected", "uncollected", "1", "2", "3", "4", "5"} or item not in ("asc", "desc") for key, item in directions.items()):
        raise ValueError("周表组内排序方向无效")
    if direction is not None:
        result["direction"] = direction
    result["directions"] = dict(directions)
    return result
