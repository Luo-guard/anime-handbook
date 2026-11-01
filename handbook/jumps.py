"""最近跳转记录：只收视频/链接的地址，便于下次直接打开。"""
from urllib.parse import urlsplit


def normalize_jump(body) -> dict:
    if not isinstance(body, dict):
        raise ValueError("跳转记录格式错误")
    url = str(body.get("url") or "").strip()
    if not url or len(url) > 500:
        raise ValueError("跳转记录链接无效")
    parts = urlsplit(url)
    if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password:
        raise ValueError("跳转记录链接无效")
    host = (parts.hostname or "").removeprefix("www.")
    title = str(body.get("title") or "").strip()[:200] or host or "链接"
    anime_name = str(body.get("anime_name") or "").strip()[:100]
    kind = "link" if str(body.get("kind") or "") == "link" else "video"
    try:
        anime_id = int(body.get("anime_id") or 0) or None
    except (TypeError, ValueError):
        anime_id = None
    return {
        "anime_id": anime_id,
        "anime_name": anime_name,
        "title": title,
        "url": url,
        "kind": kind,
        "host": host[:120],
    }
