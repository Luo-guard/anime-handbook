"""Account-scoped Bilibili videos with cached official episode identities."""
import hashlib
import re
import json
import urllib.request
from urllib.parse import urlsplit, parse_qs, urlencode
from .http_support import request_integer


def canonical_video_url(value):
    try:
        url = urlsplit(str(value))
        match = re.fullmatch(r"/video/(BV[0-9A-Za-z]{10})/?", url.path)
        official = re.fullmatch(r"/bangumi/play/((?:ss|ep)[1-9][0-9]{0,11})/?", url.path)
        if url.scheme != "https" or url.hostname not in {"www.bilibili.com", "bilibili.com"} or url.username or url.password or url.port or not (match or official):
            raise ValueError()
        if official:
            return "https://www.bilibili.com/bangumi/play/" + official[1]
        page = parse_qs(url.query).get("p", ["1"])[0]
        if not page.isdigit() or not 1 <= int(page) <= 10000:
            raise ValueError()
        return "https://www.bilibili.com/video/" + match[1] + "/" + ("?" + urlencode({"p": int(page)}) if int(page) > 1 else "")
    except (ValueError, TypeError):
        raise ValueError("请选择有效的 B 站视频或官方番剧页面") from None


def fetch_bangumi_episodes(url):
    """Fetch public episode identities once when an official video is saved."""
    key = urlsplit(url).path.rsplit("/", 1)[-1]
    parameter = "season_id" if key.startswith("ss") else "ep_id"
    request = urllib.request.Request(
        "https://api.bilibili.com/pgc/view/web/season?" + urlencode({parameter: key[2:]}),
        headers={"User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com/"},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            raw = response.read(4 * 1024 * 1024 + 1)
        if len(raw) > 4 * 1024 * 1024:
            raise ValueError()
        payload = json.loads(raw)
        if payload.get("code") != 0:
            raise ValueError()
        episodes = payload.get("result", {}).get("episodes", [])
        mapping = {}
        for episode in episodes:
            number = str(episode.get("title") or "").strip()
            identifier = str(episode.get("id") or "")
            if number.isascii() and number.isdigit() and 0 < int(number) <= 10000 and re.fullmatch(r"[1-9][0-9]{0,11}", identifier):
                target = "https://www.bilibili.com/bangumi/play/ep" + identifier
                existing = mapping.get(str(int(number)))
                if existing and existing != target:
                    raise ValueError()  # Ambiguous numbering must never guess an episode.
                mapping[str(int(number))] = target
        if not mapping:
            raise ValueError()
        return mapping
    except (OSError, ValueError, TypeError, AttributeError) as error:
        raise ValueError("暂时无法读取 B 站官方选集，请稍后重试保存") from error


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
            items = [dict(row) for row in db.execute(f"SELECT * FROM video_links WHERE anime_id=? ORDER BY kind DESC, {order}", (anime_id,))]
        for item in items:
            try:
                mapping = json.loads(item.pop("episode_urls", "{}"))
            except (ValueError, TypeError):
                mapping = {}
            item["episode_urls"] = mapping if isinstance(mapping, dict) else {}
        return items

    def update(self, body):
        if body.get("scope") != self.scope:
            raise ValueError("手账账号已切换，请重新打开扩展后再保存")
        anime_id = request_integer(body.get("anime_id"), "番剧 ID")
        if not self.database.get_anime(anime_id):
            raise ValueError("番剧不存在，请重新选择")
        action = body.get("action", "save")
        episode_urls = None
        if action == "save" and str(body.get("kind") or "video").strip() == "video":
            canonical = canonical_video_url(body.get("url"))
            if "/bangumi/play/" in canonical:
                # Do not hold SQLite's write lock during the external request.
                with self.database.connect() as db:
                    cached = db.execute("SELECT episode_urls FROM video_links WHERE anime_id=? AND url=?", (anime_id, canonical)).fetchone()
                try:
                    episode_urls = json.dumps(fetch_bangumi_episodes(canonical))
                except ValueError:
                    if not cached or cached[0] == "{}":
                        raise
                    episode_urls = cached[0]
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
                if episode_urls is not None:
                    db.execute("UPDATE video_links SET episode_urls=? WHERE id=?", (episode_urls, link_id))
                # 普通链接不参与“默认视频”，也不会被设为默认。
                make_default = kind == "video" and body.get("make_default") is True
                if kind == "link" or body.get("make_default") is False:
                    db.execute("UPDATE video_links SET is_default=0 WHERE id=? AND anime_id=?", (link_id,anime_id))
            elif action in {"delete", "default", "unset_default"}:
                link_id = request_integer(body.get("id"), "视频 ID")
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
