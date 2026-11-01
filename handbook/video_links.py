"""Account-scoped saved Bilibili videos; no remote scraping required."""
import hashlib
import re
from urllib.parse import urlsplit, parse_qs, urlencode


def canonical_video_url(value):
    try:
        url = urlsplit(str(value))
        match = re.fullmatch(r"/video/(BV[0-9A-Za-z]{10})/?", url.path)
        if url.scheme != "https" or url.hostname not in {"www.bilibili.com", "bilibili.com"} or url.username or url.password or url.port or not match:
            raise ValueError()
        page = parse_qs(url.query).get("p", ["1"])[0]
        if not page.isdigit() or not 1 <= int(page) <= 10000:
            raise ValueError()
        return "https://www.bilibili.com/video/" + match[1] + "/" + ("?" + urlencode({"p": int(page)}) if int(page) > 1 else "")
    except (ValueError, TypeError):
        raise ValueError("请选择有效的 B 站 BV 视频页面") from None


def canonical_link_url(value):
    """任意 http(s) 链接（非视频），保留原貌只做基本校验。"""
    text = str(value or "").strip()
    if len(text) > 500:
        raise ValueError("链接过长")
    try:
        url = urlsplit(text)
    except (ValueError, TypeError):
        raise ValueError("请填写有效的链接") from None
    if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password:
        raise ValueError("请填写以 http:// 或 https:// 开头的外部链接")
    return text


class VideoLinks:
    def __init__(self, database):
        self.database = database
        self.scope = hashlib.sha256(str(database.path.resolve()).encode()).hexdigest()

    def list(self, anime_id):
        # 默认视频是否置顶；关闭后按加入顺序（最新在前）排列，默认视频留在原位。
        pinned = self.database.get_settings().get("video_default_pinned") is not False
        order = "is_default DESC, id DESC" if pinned else "id DESC"
        with self.database.connect() as db:
            return [dict(row) for row in db.execute(f"SELECT * FROM video_links WHERE anime_id=? ORDER BY kind DESC, {order}", (anime_id,))]

    def update(self, body):
        if body.get("scope") != self.scope:
            raise ValueError("手账账号已切换，请重新打开扩展后再保存")
        anime_id = int(body.get("anime_id", 0))
        if not self.database.get_anime(anime_id):
            raise ValueError("番剧不存在，请重新选择")
        action = body.get("action", "save")
        with self.database.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if action == "save":
                kind = str(body.get("kind") or "video").strip()
                if kind not in {"video", "link"}:
                    raise ValueError("只能保存视频或普通链接")
                url = canonical_video_url(body.get("url")) if kind == "video" else canonical_link_url(body.get("url"))
                title = str(body.get("title") or ("B站视频" if kind == "video" else "外部链接")).strip()[:200]
                uploader = str(body.get("uploader") or "").strip()[:100] if kind == "video" else ""
                note = str(body.get("note") or "").strip()[:200]
                existing = db.execute("SELECT id, kind FROM video_links WHERE anime_id=? AND url=?", (anime_id, url)).fetchone()
                if existing:
                    db.execute("UPDATE video_links SET title=?,uploader=?,note=?,kind=? WHERE id=?", (title,uploader,note,kind,existing["id"]))
                    link_id = existing["id"]
                else:
                    link_id = db.execute("INSERT INTO video_links(anime_id,url,title,uploader,note,kind) VALUES(?,?,?,?,?,?)", (anime_id,url,title,uploader,note,kind)).lastrowid
                # 普通链接不参与“默认视频”，也不会被设为默认。
                make_default = kind == "video" and body.get("make_default") is True
                if kind == "link" or body.get("make_default") is False:
                    db.execute("UPDATE video_links SET is_default=0 WHERE id=? AND anime_id=?", (link_id,anime_id))
            elif action in {"delete", "default", "unset_default"}:
                link_id = int(body.get("id", 0))
                if not db.execute("SELECT 1 FROM video_links WHERE id=? AND anime_id=?", (link_id,anime_id)).fetchone():
                    raise ValueError("保存的视频不存在")
                if action == "delete":
                    db.execute("DELETE FROM video_links WHERE id=? AND anime_id=?", (link_id,anime_id))
                elif action == "unset_default":
                    db.execute("UPDATE video_links SET is_default=0 WHERE id=? AND anime_id=?", (link_id,anime_id))
                elif db.execute("SELECT kind FROM video_links WHERE id=? AND anime_id=?", (link_id,anime_id)).fetchone()["kind"] != "video":
                    raise ValueError("只有视频才能设为默认")
                make_default = action == "default"
            else:
                raise ValueError("视频操作无效")
            if make_default:
                db.execute("UPDATE video_links SET is_default=0 WHERE anime_id=?", (anime_id,))
                db.execute("UPDATE video_links SET is_default=1 WHERE id=? AND anime_id=?", (link_id,anime_id))
        return self.list(anime_id)
