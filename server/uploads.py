"""Disk-backed original image uploads; never decode pixel buffers."""
import tempfile
from pathlib import Path

CHUNK_SIZE = 64 * 1024
MAX_IMAGE_BYTES = 8 * 1024 * 1024
IMAGE_FORMATS = {"JPEG": ("jpg", "image/jpeg"), "PNG": ("png", "image/png"), "WEBP": ("webp", "image/webp")}


def identify_original(path, length):
    from PIL import Image

    with path.open("rb") as source:
        header = source.read(32)
    if header[:4] == b"RIFF" and header[8:12] == b"WEBP":
        # Pillow's WebP plugin constructs an animation decoder even on open().
        # Inspect the bounded RIFF header instead; never create that decoder.
        # https://developers.google.com/speed/webp/docs/riff_container
        total = int.from_bytes(header[4:8], "little") + 8
        size = int.from_bytes(header[16:20], "little")
        kind = header[12:16]
        minimum = {b"VP8 ": 10, b"VP8L": 5, b"VP8X": 10}.get(kind)
        valid = minimum is not None and size >= minimum and 20 + size + (size % 2) <= total <= length
        if kind == b"VP8 ":
            valid = valid and header[23:26] == b"\x9d\x01\x2a"
        elif kind == b"VP8L":
            valid = valid and header[20:21] == b"\x2f"
        if not valid:
            raise ValueError("WebP 文件头无效")
        return IMAGE_FORMATS["WEBP"]
    with Image.open(path, formats=["JPEG", "PNG"]) as image:
        if image.format not in IMAGE_FORMATS or min(image.size) <= 0:
            raise ValueError("请选择 JPG、PNG 或 WebP 图片")
        return IMAGE_FORMATS[image.format]


def receive_original(stream, length, root):
    """Stage to disk and identify headers only. Caller owns the global upload slot."""
    from PIL import Image, UnidentifiedImageError

    if not 0 < length <= MAX_IMAGE_BYTES:
        raise ValueError("图片不能为空或超过 8 MB")
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=root, prefix=".upload-", suffix=".tmp", delete=False) as out:
            temporary = Path(out.name)
            remaining = length
            while remaining:
                block = stream.read(min(CHUNK_SIZE, remaining))
                if not block:
                    raise ValueError("图片上传不完整，请重试")
                out.write(block)
                remaining -= len(block)
        # Image.open reads dimensions/format lazily. Do not call load, convert,
        # exif_transpose, thumbnail or save: original bytes must remain unchanged.
        extension, mime = identify_original(temporary, length)
        return temporary, extension, mime
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError) as error:
        if temporary:
            temporary.unlink(missing_ok=True)
        raise ValueError("图片文件头无效或格式不受支持") from error
    except BaseException:
        if temporary:
            temporary.unlink(missing_ok=True)
        raise
