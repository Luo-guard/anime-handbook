
"""Account-scoped business services using the existing handbook implementation."""
from __future__ import annotations
from handbook import database, metadata, related, webdav

import json
import threading
from datetime import datetime, timezone, timedelta
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlparse
import urllib.request

# Importing business modules never initializes the desktop registry or DB.
from handbook import common as core


IMAGE_HOSTS = {"lain.bgm.tv", "img.bgm.tv"}
IMAGE_MIMES = {"image/png", "image/jpeg", "image/webp", "image/gif"}
MAX_CACHED_IMAGE_BYTES = 8 * 1024 * 1024


def image_url_allowed(url):
    try:
        p = urlparse(str(url))
        return p.scheme == "https" and p.hostname in IMAGE_HOSTS and p.port in (None, 443) and not p.username and not p.password
    except ValueError:
        return False



class ImageRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not image_url_allowed(newurl):
            raise ValueError("图片源跳转地址不受支持")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class OnlineMetadata(metadata.SyncService):
    def _bgm_api_bases(self):
        return ["https://api.bgm.tv"]

    def _bgm_site_bases(self):
        return ["https://bgm.tv"]

    def fetch_bgm(self, anime_id):
        return self._fetch_bgm_json(f"https://api.bgm.tv/v0/subjects/{int(anime_id)}", attempts=1)

    def cached_image(self, url):
        if not image_url_allowed(url):
            return None
        import hashlib
        key = hashlib.sha256(url.encode()).hexdigest()
        path = self.cover_root / key
        if path.is_file():
            try:
                with path.open("rb") as cached:
                    raw = cached.read(MAX_CACHED_IMAGE_BYTES + 128)
                mime, separator, data = raw.partition(b"\n")
                mime = mime.decode("ascii")
                if separator and mime in IMAGE_MIMES and 0 < len(data) <= MAX_CACHED_IMAGE_BYTES:
                    return data, mime
            except (OSError, UnicodeError):
                pass
            # An incomplete cache is a miss; a successful fetch replaces it atomically.
        request = urllib.request.Request(url, headers={"User-Agent": "AnimeHandbook/online"})
        with urllib.request.build_opener(ImageRedirect()).open(request, timeout=15) as response:
            mime = response.headers.get_content_type()
            data = response.read(MAX_CACHED_IMAGE_BYTES + 1)
        if mime not in IMAGE_MIMES or not data or len(data) > MAX_CACHED_IMAGE_BYTES:
            return None
        temporary = path.with_suffix("." + core.secrets.token_hex(4) + ".tmp")
        try:
            temporary.write_bytes(mime.encode() + b"\n" + data)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
        return data, mime

    def cover(self, anime_id):
        anime = self.database.get_anime(anime_id)
        return self.cached_image(str(anime.get("image_url") or "")) if anime else None

    def character_cover(self, anime_id, character_id):
        character = next((c for c in self.database.list_anime_characters(anime_id) if int(c["character_id"]) == character_id), None)
        return self.cached_image(str(character.get("image_url") or "")) if character else None


class AccountServices:
    def __init__(self, root, user, shared_covers):
        self.root = root / "users" / user["id"]
        fresh = not (self.root / "handbook.db").exists()
        self.database = database.HandbookDB(self.root / "handbook.db", asset_root=self.root)
        if fresh:
            self.database.update_episode_balance_settings(initial=0)
        self.sync = OnlineMetadata(self.database)
        self.sync.cover_root = shared_covers
        self.sync.status.update(message="数据已保存在服务器", last_success_at=core.now_iso())
        self.age = related.AgeRelatedService(self.database, self.sync)
        self.background_root = self.root / "background"
        self.record_image_root = self.root / "record-images"
        self.lock = threading.RLock()
        profile = {"id": user["id"], "name": user["username"], "active": True, "shared": False}
        self.profiles = SimpleNamespace(profile=lambda: profile, list_profiles=lambda: [profile])
        with self.database.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS online_revision(id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL)")
            db.execute("INSERT OR IGNORE INTO online_revision VALUES(1,0)")
        self.secure_settings()

    def secure_settings(self):
        for key, value in {"bgm_api_base": "https://api.bgm.tv", "bgm_site_base": "https://bgm.tv", "bgm_sources": [core.BGM_OFFICIAL_SOURCE], "active_bgm_source": "official", "launch_at_login": False, "bound_kazumi_path": ""}.items():
            self.database.set_setting(key, value)

    def revision(self):
        with self.database.connect() as db:
            return db.execute("SELECT value FROM online_revision WHERE id=1").fetchone()[0]

    def changed(self):
        with self.database.connect() as db:
            db.execute("UPDATE online_revision SET value=value+1 WHERE id=1")

    def bootstrap(self, user):
        db = self.database
        return {"online": True, "user": {"username": user["username"], "read_only": user.get("role") == "guest"}, "revision": self.revision(),
                "profiles": self.profiles.list_profiles(), "active_profile": self.profiles.profile(),
                "sharing": {}, "webdav": {}, "sync": self.sync.status,
                "animes": db.list_anime(), "custom_collections": db.list_custom_collections(),
                "ranking_boards": db.list_ranking_boards(), "ranking_templates": db.list_ranking_templates(),
                "settings": db.get_settings(), "stats": db.stats()}

    def add_subject(self, subject_id, category):
        metadata = self.sync.fetch_bgm(subject_id)
        if metadata.get("type") != 2 or int(metadata.get("id", 0)) != subject_id:
            raise ValueError("请使用 Bangumi 动画条目 ID")
        stamp = core.now_iso()
        with self.database.connect() as db:
            db.execute("""INSERT INTO anime(id,name,name_cn,summary,air_date,image_url,collection_type,active,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET collection_type=excluded.collection_type,active=1,updated_at=excluded.updated_at""",
                (subject_id, metadata.get("name", ""), metadata.get("name_cn", ""), metadata.get("summary", ""), metadata.get("date", ""), (metadata.get("images") or {}).get("common", ""), category, stamp, stamp))
        rating = metadata.get("rating") or {}
        self.database.update_bgm_metadata(subject_id, episode_count=int(metadata.get("total_episodes") or metadata.get("eps") or 0), rating_score=rating.get("score"), rating_total=rating.get("total"), rating_rank=rating.get("rank"), rating_synced=True)
        return self.database.get_anime(subject_id)

    def record_progress(self, subject_id, body):
        """Apply explicit episode deltas, preserving concurrent additions and earliest times."""
        anime = self.database.get_anime(subject_id)
        if not anime:
            raise ValueError("番剧不存在")
        if not isinstance(body.get("base_episode_keys"), list) or not isinstance(body.get("episode_keys"), list):
            raise ValueError("观看进度需包含原始列表和新的选择列表")
        normalize = lambda keys: core.normalize_watched_keys(keys, anime["episodes"], int(anime["episode_count"] or 0))
        base, desired = set(normalize(body["base_episode_keys"])), set(normalize(body["episode_keys"]))
        added, removed = desired - base, base - desired
        stamp = str(body.get("watched_at") or core.now_iso())
        moment = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        if moment.tzinfo is None or moment > datetime.now(timezone.utc) + timedelta(minutes=5):
            raise ValueError("观看时间无效，请检查设备时钟")
        current = set(normalize(anime.get("watched_episode_keys") or []))
        keys = (current - removed) | added
        result = self.database.set_progress(subject_id, list(keys))
        with self.database.connect() as db:
            rows = db.execute("SELECT * FROM events WHERE anime_id=? AND event_type='watch'", (subject_id,)).fetchall()
            for raw in rows:
                row = dict(raw)
                affected = set(normalize(core.json_list(row["episodes"]))) & added
                old_moment = webdav.WebDAVSyncService._row_moment(row, "created_at")
                if not affected or (old_moment is not None and old_moment <= moment):
                    continue
                rest = [k for k in core.json_list(row["episodes"]) if k not in affected]
                if not rest:
                    db.execute("UPDATE events SET created_at=? WHERE id=?", (stamp, row["id"]))
                else:
                    db.execute("UPDATE events SET episodes=? WHERE id=?", (core.json_dumps(rest), row["id"]))
                    columns = [k for k in row if k != "id"]
                    earlier = {**row, "episodes": core.json_dumps(sorted(affected)), "created_at": stamp}
                    db.execute(f"INSERT INTO events ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)})", [earlier[k] for k in columns])
        return result


class Runtime:
    def __init__(self, root):
        self.root = Path(root).resolve()
        if self.root == core.DEFAULT_DATA_ROOT.resolve() or core.DEFAULT_DATA_ROOT.resolve() in self.root.parents:
            raise ValueError("线上数据目录不能使用本机 data 目录")
        self.root.mkdir(parents=True, exist_ok=True)
        self.covers = self.root / "cache" / "covers"
        self.covers.mkdir(parents=True, exist_ok=True)
        self.schedule = core.ScheduleService(self.root / "cache" / "schedule")
        self._accounts = {}
        self._lock = threading.Lock()

    def services(self, user):
        with self._lock:
            if user["id"] not in self._accounts:
                self._accounts[user["id"]] = AccountServices(self.root, user, self.covers)
            return self._accounts[user["id"]]
