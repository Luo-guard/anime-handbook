"""Per-collection overrides for automatically selected detail artwork."""
from __future__ import annotations

import base64
from io import BytesIO
from pathlib import Path
import re
from tempfile import NamedTemporaryFile

from PIL import Image, ImageOps

from . import screenshots

ROUTE = re.compile(r"/api/detail-wallpapers/([1-9]\d{0,9})")
MAX_BYTES = 8 * 1024 * 1024
MAX_PIXELS = 40_000_000


def wallpaper_path(database, anime_id):
    return database.path.parent / "detail-wallpapers" / database.path.name / f"{anime_id}.webp"


def read_wallpaper(database, anime_id):
    try:
        return wallpaper_path(database, anime_id).read_bytes()
    except FileNotFoundError:
        return None


def change_wallpaper(database, anime_id, body, *, allow_gallery):
    with database.connect() as db:
        exists = db.execute("SELECT 1 FROM anime WHERE id = ?", (anime_id,)).fetchone()
    if not exists:
        raise KeyError("找不到这部番剧")

    target = wallpaper_path(database, anime_id)
    action = body.get("action")
    if action == "reset":
        target.unlink(missing_ok=True)
        return {"ok": True, "custom": False}

    if action == "gallery" and allow_gallery:
        relative = body.get("relative")
        source = screenshots.image_path(database.asset_root, relative) if isinstance(relative, str) else None
        if source is None:
            raise ValueError("找不到这张图库图片，请重新选择")
        try:
            with source.open("rb") as handle:
                data = handle.read(MAX_BYTES + 1)
        except FileNotFoundError as error:
            raise ValueError("找不到这张图库图片，请重新选择") from error
    elif action == "upload":
        value = body.get("data")
        if not isinstance(value, str) or len(value) > 4 * ((MAX_BYTES + 2) // 3):
            raise ValueError("请选择不超过 8 MB 的图片")
        try:
            data = base64.b64decode(value, validate=True)
        except ValueError as error:
            raise ValueError("无法读取图片，请重新选择") from error
    else:
        raise ValueError("壁纸操作无效")

    if len(data) > MAX_BYTES:
        raise ValueError("请选择不超过 8 MB 的图片")
    try:
        with Image.open(BytesIO(data), formats=["JPEG", "PNG", "WEBP", "AVIF"]) as image:
            if image.width * image.height > MAX_PIXELS:
                raise ValueError("图片分辨率过大，请缩小后重试")
            image.thumbnail((2560, 2560), Image.Resampling.LANCZOS)
            output = BytesIO()
            ImageOps.exif_transpose(image).convert("RGB").save(output, "WEBP", quality=90, method=4)
    except Image.DecompressionBombError as error:
        raise ValueError("图片分辨率过大，请缩小后重试") from error
    except (OSError, SyntaxError) as error:
        raise ValueError("无法读取图片，请选择有效的 JPG、PNG、WebP 或 AVIF") from error

    target.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(dir=target.parent, suffix=".tmp", delete=False) as handle:
        temporary = Path(handle.name)
        try:
            handle.write(output.getbuffer())
            handle.close()
            temporary.replace(target)
        finally:
            handle.close()
            temporary.unlink(missing_ok=True)
    return {"ok": True, "custom": True}
