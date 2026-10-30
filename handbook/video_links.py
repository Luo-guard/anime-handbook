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


class VideoLinks:
    def __init__(self, database):
        self.database = database
        self.scope = hashlib.sha256(str(database.path.resolve()).encode()).hexdigest()

    def list(self, anime_id):
        with self.database.connect() as db:
            return [dict(row) for row in db.execute("SELECT * FROM video_links WHERE anime_id=? ORDER BY is_default DESC, id DESC", (anime_id,))]

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
                url = canonical_video_url(body.get("url"))
                title = str(body.get("title") or "B站视频").strip()[:200]
                uploader = str(body.get("uploader") or "").strip()[:100]
                note = str(body.get("note") or "").strip()[:200]
                existing = db.execute("SELECT id FROM video_links WHERE anime_id=? AND url=?", (anime_id, url)).fetchone()
                if existing:
                    db.execute("UPDATE video_links SET title=?,uploader=?,note=? WHERE id=?", (title,uploader,note,existing["id"]))
                    link_id = existing["id"]
                else:
                    link_id = db.execute("INSERT INTO video_links(anime_id,url,title,uploader,note) VALUES(?,?,?,?,?)", (anime_id,url,title,uploader,note)).lastrowid
                make_default = body.get("make_default") is True
                if body.get("make_default") is False:
                    db.execute("UPDATE video_links SET is_default=0 WHERE id=? AND anime_id=?", (link_id,anime_id))
            elif action in {"delete", "default", "unset_default"}:
                link_id = int(body.get("id", 0))
                if not db.execute("SELECT 1 FROM video_links WHERE id=? AND anime_id=?", (link_id,anime_id)).fetchone():
                    raise ValueError("保存的视频不存在")
                if action == "delete":
                    db.execute("DELETE FROM video_links WHERE id=? AND anime_id=?", (link_id,anime_id))
                elif action == "unset_default":
                    db.execute("UPDATE video_links SET is_default=0 WHERE id=? AND anime_id=?", (link_id,anime_id))
                make_default = action == "default"
            else:
                raise ValueError("视频操作无效")
            if make_default:
                db.execute("UPDATE video_links SET is_default=0 WHERE anime_id=?", (anime_id,))
                db.execute("UPDATE video_links SET is_default=1 WHERE id=? AND anime_id=?", (link_id,anime_id))
        return self.list(anime_id)
