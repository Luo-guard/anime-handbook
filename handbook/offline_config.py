"""离线下载的「这台机器」配置。

单独放一个 ``offline.json``，不进 settings 主表，原因是这类设置全部跟本机
绑定：媒体库路径、qB 端口、字体目录。放进主设置会被同步到别的设备，那边
既没有那个盘符也没有那个下载器，反而制造故障。
"""
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Any

CONFIG_FILE = "offline.json"
DEFAULT_QB_HOST = "127.0.0.1"
DEFAULT_QB_PORT = 8080
DEFAULT_CATEGORY = "AnimeHandbook"
MAX_TEXT = 400

DEFAULTS: dict[str, Any] = {
    "media_root": "",          # 空表示用 default_media_root()
    "download_root": "",       # 空表示 <media_root>/_incoming
    "qb_host": DEFAULT_QB_HOST,
    "qb_port": DEFAULT_QB_PORT,
    "qb_category": DEFAULT_CATEGORY,
    "seed_after_done": True,
    "auto_follow": False,
    "font_dir": "",
    "mikan_host": "",          # 空表示按 MIRRORS 顺序自动选
    "last_group": {},          # anime_id(字符串) -> 字幕组名
    "warn_size_gb": 10,
    "low_space_gb": 20,
}

_BOOLS = ("seed_after_done", "auto_follow")
_INTS = {"qb_port": (1, 65535), "warn_size_gb": (1, 500), "low_space_gb": (1, 5000)}
_TEXTS = ("media_root", "download_root", "font_dir", "mikan_host", "qb_host", "qb_category")


def default_media_root() -> str:
    """优先放 D/E/F 盘根目录下，找不到就退回用户视频目录。

    刻意不放在项目目录：项目会被同步到 GitHub，几十 GB 视频进去以后历史记录
    清不掉。
    """
    for letter in ("D", "E", "F"):
        drive = Path(f"{letter}:/")
        try:
            if drive.exists():
                return f"{letter}:/动漫/离线视频"
        except OSError:
            continue
    return str(Path.home() / "Videos" / "动漫手账").replace("\\", "/")


def config_path(asset_root: Path) -> Path:
    return Path(asset_root) / CONFIG_FILE


def _clean_text(value: Any) -> str:
    text = str(value or "").strip()
    if len(text) > MAX_TEXT:
        text = text[:MAX_TEXT]
    return text.replace("\\", "/").rstrip("/") if text else ""


def normalize(document: Any) -> dict[str, Any]:
    """把任意输入收敛成合法配置；不认识的多余键直接丢弃。"""
    source = document if isinstance(document, dict) else {}
    result: dict[str, Any] = {}
    for key in _TEXTS:
        result[key] = _clean_text(source.get(key, DEFAULTS[key]))
    for key in _BOOLS:
        result[key] = bool(source.get(key, DEFAULTS[key]))
    for key, (low, high) in _INTS.items():
        raw = source.get(key, DEFAULTS[key])
        try:
            number = int(raw)
        except (TypeError, ValueError):
            number = int(DEFAULTS[key])
        result[key] = max(low, min(high, number))
    if not result["qb_host"]:
        result["qb_host"] = DEFAULT_QB_HOST
    if not result["qb_category"]:
        result["qb_category"] = DEFAULT_CATEGORY
    # 字幕组偏好只保留「数字 id → 短字符串」的配对，防止脏数据堆积。
    last_group: dict[str, str] = {}
    raw_groups = source.get("last_group")
    if isinstance(raw_groups, dict):
        for anime_id, group in list(raw_groups.items())[:500]:
            key = str(anime_id).strip()
            name = str(group or "").strip()[:80]
            if key.isdigit() and name:
                last_group[key] = name
    result["last_group"] = last_group
    return result


def load(asset_root: Path) -> dict[str, Any]:
    path = config_path(asset_root)
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return normalize({})
    return normalize(document)


def save(asset_root: Path, document: Any) -> dict[str, Any]:
    config = normalize(document)
    path = config_path(asset_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)
    return config


def resolved(config: dict[str, Any]) -> dict[str, str]:
    """算出真正使用的两个目录，不改动原始配置。"""
    media = _clean_text(config.get("media_root")) or _clean_text(default_media_root())
    download = _clean_text(config.get("download_root")) or f"{media}/_incoming"
    return {"media_root": media, "download_root": download}


def ensure_dirs(config: dict[str, Any]) -> dict[str, Any]:
    """建目录并顺手检查可写；返回给界面看的落地状态。"""
    paths = resolved(config)
    result: dict[str, Any] = {**paths, "ok": True, "error": "", "free_gb": 0.0}
    for key in ("media_root", "download_root"):
        target = Path(paths[key])
        try:
            target.mkdir(parents=True, exist_ok=True)
            probe = target / ".handbook-write-test"
            probe.write_text("ok", encoding="utf-8")
            probe.unlink()
        except OSError as error:
            result["ok"] = False
            result["error"] = f"{target} 不可写：{error}"
            return result
    try:
        # shutil.disk_usage 在 Windows 上也能用，os.statvfs 不行。
        usage = shutil.disk_usage(paths["media_root"])
        result["free_gb"] = round(usage.free / (1 << 30), 1)
        result["total_gb"] = round(usage.total / (1 << 30), 1)
    except OSError:
        pass
    return result


def remember_group(asset_root: Path, anime_id: Any, group: str) -> dict[str, Any]:
    """记住某部番上次选的字幕组，下次搜索把它排前面。"""
    config = load(asset_root)
    key = str(int(anime_id)) if str(anime_id).isdigit() else ""
    name = str(group or "").strip()[:80]
    if key and name:
        config["last_group"][key] = name
        return save(asset_root, config)
    return config
