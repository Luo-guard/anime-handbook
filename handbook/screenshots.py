"""播放器截图入库：按番名分文件夹、按模板命名。

目录与命名模板都存在 ``offline.json``（跟盘符绑定，不进同步的主设置）。
默认目录是 ``<媒体库>/截图``，默认文件名 ``{episode}_{time}``。
"""
from __future__ import annotations

import base64
import binascii
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from . import offline_config

MAX_BYTES = 15 * 1024 * 1024
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
_BAD_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_TOKENS = ("anime", "episode", "time", "date", "datetime")


def _safe_segment(text: Any, fallback: str = "未命名", limit: int = 80) -> str:
    name = _BAD_CHARS.sub("_", str(text or "").strip())
    # Windows 不允许结尾的空格和点，也不允许空名字。
    name = name.strip(" .")
    return (name or fallback)[:limit]


def _time_label(seconds: Any) -> str:
    total = max(0, int(round(float(seconds or 0))))
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours:02d}-{minutes:02d}-{secs:02d}" if hours else f"{minutes:02d}-{secs:02d}"


def render_name(template: str | None, *, anime: str, episode: str, seconds: Any, when: datetime | None = None) -> str:
    """把模板渲染成文件名（不含扩展名）。

    支持 {episode}{time}{date}{datetime}{anime}；未知占位符直接删掉，
    免得文件名里留一串 ``{}``。
    """
    fmt = str(template or "").strip() or offline_config.DEFAULT_SCREENSHOT_NAME
    stamp = when or datetime.now()
    values = {
        "anime": _safe_segment(anime),
        "episode": _safe_segment(episode, "第0集"),
        "time": _time_label(seconds),
        "date": stamp.strftime("%Y%m%d"),
        "datetime": stamp.strftime("%Y%m%d-%H%M%S"),
    }
    for key in _TOKENS:
        fmt = fmt.replace("{" + key + "}", values[key])
    fmt = re.sub(r"\{[^}]*\}", "", fmt)
    return _safe_segment(fmt, "截图", 120)


def root(asset_root: Path) -> Path:
    config = offline_config.load(asset_root)
    return Path(offline_config.resolved(config)["screenshot_root"])


def _decode_png(data_url: str) -> bytes:
    raw = str(data_url or "")
    payload = raw.partition(",")[2] if raw.startswith("data:") else raw
    try:
        blob = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError("截图数据无效") from error
    if not blob.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("截图不是 PNG 图片")
    if len(blob) > MAX_BYTES:
        raise ValueError("截图文件太大")
    if not blob:
        raise ValueError("截图是空的")
    return blob


def save_png(asset_root: Path, *, anime: str, episode: str, seconds: Any, data_url: str) -> dict[str, Any]:
    """把一张 PNG 存进 <截图目录>/<番名>/，重名自动加序号，绝不覆盖。"""
    blob = _decode_png(data_url)
    config = offline_config.load(asset_root)
    base = root(asset_root)
    folder = base / _safe_segment(anime, "未命名番剧")
    folder.mkdir(parents=True, exist_ok=True)
    name = render_name(config.get("screenshot_name_format"), anime=anime, episode=episode, seconds=seconds)
    target = folder / f"{name}.png"
    index = 2
    while target.exists():
        target = folder / f"{name}-{index}.png"
        index += 1
    target.write_bytes(blob)
    return {
        "ok": True,
        "relative": target.relative_to(base).as_posix(),
        "folder": folder.name,
        "name": target.name,
        "bytes": len(blob),
        "root": str(base),
    }


def list_library(asset_root: Path) -> dict[str, Any]:
    """按番剧文件夹分组列出截图，新图在前。"""
    base = root(asset_root)
    groups: list[dict[str, Any]] = []
    total = 0
    if base.is_dir():
        for folder in sorted(base.iterdir(), key=lambda item: item.name):
            if not folder.is_dir():
                continue
            images = []
            for file in folder.iterdir():
                if not file.is_file() or file.suffix.lower() not in IMAGE_SUFFIXES:
                    continue
                try:
                    stat = file.stat()
                except OSError:
                    continue
                images.append({
                    "name": file.name,
                    "relative": file.relative_to(base).as_posix(),
                    "bytes": stat.st_size,
                    "mtime": int(stat.st_mtime),
                })
            if not images:
                continue
            images.sort(key=lambda item: item["mtime"], reverse=True)
            total += len(images)
            groups.append({
                "folder": folder.name,
                "count": len(images),
                "latest": images[0]["mtime"],
                "images": images,
            })
    groups.sort(key=lambda item: item["latest"], reverse=True)
    return {"root": str(base), "count": total, "groups": groups}


def _resolve(asset_root: Path, relative: str) -> Path | None:
    base = root(asset_root)
    try:
        target = (base / str(relative or "")).resolve()
        base = base.resolve()
    except (OSError, ValueError):
        return None
    # 只允许截图目录里的图片，挡掉 ../ 或绝对路径。
    if target != base and base not in target.parents:
        return None
    if target.suffix.lower() not in IMAGE_SUFFIXES or not target.is_file():
        return None
    return target


def image_path(asset_root: Path, relative: str) -> Path | None:
    return _resolve(asset_root, relative)


def delete_image(asset_root: Path, relative: str) -> dict[str, Any]:
    target = _resolve(asset_root, relative)
    if not target:
        raise ValueError("找不到这张截图")
    target.unlink()
    # 这组的最后一张删完就把空文件夹一起收掉，截图库里不留空壳。
    try:
        if not any(target.parent.iterdir()):
            target.parent.rmdir()
    except OSError:
        pass
    return {"ok": True, "relative": relative}


def delete_images(asset_root: Path, relatives: list[Any]) -> dict[str, Any]:
    """批量删除截图：逐张删，最后统一收掉空文件夹。

    一张删失败不该拖累整批（文件被占用、刚好被手动挪走都可能），
    所以返回 deleted / failed 两份清单，让界面能说清「删了几张、还剩几张」。
    """
    wanted = [str(item or "").strip() for item in (relatives or [])]
    wanted = [item for item in dict.fromkeys(wanted) if item]
    if not wanted:
        raise ValueError("没有选中要删除的截图")
    if len(wanted) > 500:
        raise ValueError("一次最多删除 500 张截图")
    deleted: list[str] = []
    failed: list[dict[str, str]] = []
    parents: set[Path] = set()
    for relative in wanted:
        target = _resolve(asset_root, relative)
        if not target:
            failed.append({"relative": relative, "error": "找不到这张截图"})
            continue
        parents.add(target.parent)
        try:
            target.unlink()
            deleted.append(relative)
        except OSError as error:
            failed.append({"relative": relative, "error": str(error)})
    for folder in parents:
        try:
            if folder.is_dir() and not any(folder.iterdir()):
                folder.rmdir()
        except OSError:
            pass
    return {"ok": True, "deleted": deleted, "failed": failed}


def folder_name(asset_root: Path, relative: str) -> str:
    return Path(str(relative or "")).parent.name
