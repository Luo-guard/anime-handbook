from __future__ import annotations

from typing import Any
from typing import Iterator
from pathlib import Path
from contextlib import contextmanager
from datetime import date
from datetime import datetime
import json
import os
import re
import sqlite3
import tempfile
import threading
from datetime import timedelta
from .common import (BGM_OFFICIAL_SOURCE, CATEGORY_NAMES, DATA_ROOT, DB_PATH, episode_groups, episode_summary, generated_episodes, json_dumps, json_list, normalize_bgm_sources, normalize_episodes, normalize_theme_ids, normalize_watched_keys, now_iso)

class HandbookDB:
    def __init__(self, path: Path = DB_PATH, *, asset_root: Path | None = None) -> None:
        self.asset_root = Path(asset_root) if asset_root is not None else DATA_ROOT
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        (self.asset_root / "covers").mkdir(parents=True, exist_ok=True)
        (self.asset_root / "character-covers").mkdir(parents=True, exist_ok=True)
        self._write_lock = threading.RLock()
        self.initialize()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=15)
        try:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys = ON")
            connection.execute("PRAGMA journal_mode = WAL")
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def export_snapshot(self, destination: Path) -> None:
        """Create a consistent SQLite copy without syncing WAL/SHM sidecars.

        Syncthing must only receive this immutable snapshot.  Copying the live
        database file directly can otherwise produce a database that is out of
        sync with its WAL journal.
        """
        destination = Path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        # Each export owns its staging file, including concurrent exports to one path.
        with tempfile.NamedTemporaryFile(dir=destination.parent, prefix=destination.name + ".", suffix=".tmp", delete=False) as stage:
            temporary = Path(stage.name)
        try:
            with self._write_lock:
                source = sqlite3.connect(self.path, timeout=15)
                try:
                    target = sqlite3.connect(temporary, timeout=15)
                    try:
                        source.backup(target)
                    finally:
                        target.close()
                finally:
                    source.close()
            os.replace(temporary, destination)
        finally:
            temporary.unlink(missing_ok=True)

    def import_snapshot(self, source_path: Path) -> None:
        """Replace this database with a verified consistent shared snapshot."""
        source_path = Path(source_path)
        if not source_path.is_file():
            raise ValueError("找不到要加载的共享手账快照")
        temporary = self.path.with_suffix(self.path.suffix + ".importing")
        with self._write_lock:
            source = sqlite3.connect(source_path, timeout=15)
            target = sqlite3.connect(temporary, timeout=15)
            try:
                source.backup(target)
                target.execute("PRAGMA integrity_check")
            finally:
                target.close()
                source.close()
            os.replace(temporary, self.path)

    def referenced_record_images(self) -> set[str]:
        """Return local record-image filenames referenced by this handbook."""
        pattern = re.compile(r"/api/record-images/([A-Za-z0-9_-]+\.(?:png|jpg|webp))")
        filenames: set[str] = set()
        with self.connect() as db:
            rows = db.execute("SELECT content, raw_directives FROM events").fetchall()
        for row in rows:
            for value in (row["content"], row["raw_directives"]):
                filenames.update(pattern.findall(str(value or "")))
        return filenames

    def initialize(self) -> None:
        with self.connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS video_links (
                    id INTEGER PRIMARY KEY,
                    anime_id INTEGER NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
                    url TEXT NOT NULL,
                    title TEXT NOT NULL,
                    uploader TEXT NOT NULL DEFAULT '',
                    note TEXT NOT NULL DEFAULT '',
                    is_default INTEGER NOT NULL DEFAULT 0,
                    UNIQUE(anime_id, url)
                );
                CREATE TABLE IF NOT EXISTS anime (
                    id INTEGER PRIMARY KEY,
                    name TEXT NOT NULL DEFAULT '',
                    name_cn TEXT NOT NULL DEFAULT '',
                    summary TEXT NOT NULL DEFAULT '',
                    air_date TEXT NOT NULL DEFAULT '',
                    image_url TEXT NOT NULL DEFAULT '',
                    collection_type INTEGER NOT NULL,
                    kazumi_updated_at TEXT NOT NULL DEFAULT '',
                    active INTEGER NOT NULL DEFAULT 1,
                    kazumi_position INTEGER NOT NULL DEFAULT 0,
                    custom_sort_order INTEGER NOT NULL DEFAULT 0,
                    episode_count INTEGER,
                    episodes TEXT NOT NULL DEFAULT '[]',
                    episode_titles_synced INTEGER NOT NULL DEFAULT 0,
                    aired_episode_count INTEGER NOT NULL DEFAULT 0,
                    episode_release_synced_at TEXT,
                    watched_episodes TEXT NOT NULL DEFAULT '[]',
                    progress_initialized INTEGER NOT NULL DEFAULT 0,
                    bgm_synced_at TEXT,
                    bgm_score REAL,
                    bgm_rank INTEGER,
                    bgm_rating_total INTEGER,
                    bgm_rating_synced_at TEXT,
                    bgm_rating_version INTEGER NOT NULL DEFAULT 0,
                    personal_score REAL,
                    personal_rating_text TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_type TEXT NOT NULL CHECK(event_type IN ('watch', 'note', 'anime_comment')),
                    anime_id INTEGER,
                    episodes TEXT NOT NULL DEFAULT '[]',
                    content TEXT NOT NULL DEFAULT '',
                    theme TEXT NOT NULL DEFAULT '',
                    themes TEXT NOT NULL DEFAULT '[]',
                    rating REAL,
                    raw_directives TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(anime_id) REFERENCES anime(id)
                );

                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS custom_collections (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS custom_collection_items (
                    collection_id INTEGER NOT NULL,
                    anime_id INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(collection_id, anime_id),
                    FOREIGN KEY(collection_id)
                        REFERENCES custom_collections(id) ON DELETE CASCADE,
                    FOREIGN KEY(anime_id) REFERENCES anime(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS ranking_boards (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS ranking_templates (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    tiers TEXT NOT NULL DEFAULT '[]',
                    is_builtin INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS ranking_tiers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    board_id INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    sort_order INTEGER NOT NULL,
                    FOREIGN KEY(board_id) REFERENCES ranking_boards(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS ranking_items (
                    board_id INTEGER NOT NULL,
                    anime_id INTEGER NOT NULL,
                    tier_id INTEGER,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(board_id, anime_id),
                    FOREIGN KEY(board_id) REFERENCES ranking_boards(id) ON DELETE CASCADE,
                    FOREIGN KEY(anime_id) REFERENCES anime(id) ON DELETE CASCADE,
                    FOREIGN KEY(tier_id) REFERENCES ranking_tiers(id) ON DELETE SET NULL
                );

                CREATE TABLE IF NOT EXISTS age_related_cache (
                    anime_id INTEGER PRIMARY KEY,
                    search_term TEXT NOT NULL DEFAULT '',
                    source_title TEXT NOT NULL DEFAULT '',
                    source_url TEXT NOT NULL DEFAULT '',
                    items TEXT NOT NULL DEFAULT '[]',
                    fetched_at TEXT NOT NULL,
                    FOREIGN KEY(anime_id) REFERENCES anime(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_anime_active_type
                    ON anime(active, collection_type);
                CREATE INDEX IF NOT EXISTS idx_events_created
                    ON events(created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_custom_items_anime
                    ON custom_collection_items(anime_id);
                CREATE INDEX IF NOT EXISTS idx_ranking_items_board
                    ON ranking_items(board_id, tier_id, sort_order);
                """
            )
            columns = {
                row["name"]
                for row in db.execute("PRAGMA table_info(anime)").fetchall()
            }
            if "episodes" not in columns:
                db.execute(
                    "ALTER TABLE anime ADD COLUMN episodes TEXT NOT NULL DEFAULT '[]'"
                )
            if "episode_titles_synced" not in columns:
                db.execute(
                    "ALTER TABLE anime ADD COLUMN episode_titles_synced INTEGER NOT NULL DEFAULT 0"
                )
            for column, definition in {
                "aired_episode_count": "INTEGER NOT NULL DEFAULT 0",
                "episode_release_synced_at": "TEXT",
            }.items():
                if column not in columns:
                    db.execute(f"ALTER TABLE anime ADD COLUMN {column} {definition}")
            for column, definition in {
                "kazumi_position": "INTEGER NOT NULL DEFAULT 0",
                "custom_sort_order": "INTEGER NOT NULL DEFAULT 0",
            }.items():
                if column not in columns:
                    db.execute(f"ALTER TABLE anime ADD COLUMN {column} {definition}")
            for column, definition in {
                "bgm_score": "REAL",
                "bgm_rank": "INTEGER",
                "bgm_rating_total": "INTEGER",
                "bgm_rating_synced_at": "TEXT",
                "bgm_rating_version": "INTEGER NOT NULL DEFAULT 0",
                "personal_score": "REAL",
                "personal_rating_text": "TEXT NOT NULL DEFAULT ''",
            }.items():
                if column not in columns:
                    db.execute(f"ALTER TABLE anime ADD COLUMN {column} {definition}")
            event_schema = db.execute(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'"
            ).fetchone()["sql"]
            if "anime_comment" not in event_schema:
                db.execute("ALTER TABLE events RENAME TO events_legacy")
                db.execute(
                    """
                    CREATE TABLE events (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        event_type TEXT NOT NULL CHECK(event_type IN ('watch', 'note', 'anime_comment')),
                        anime_id INTEGER,
                        episodes TEXT NOT NULL DEFAULT '[]',
                        content TEXT NOT NULL DEFAULT '',
                        created_at TEXT NOT NULL,
                        FOREIGN KEY(anime_id) REFERENCES anime(id)
                    )
                    """
                )
                db.execute(
                    """
                    INSERT INTO events(id, event_type, anime_id, episodes, content, created_at)
                    SELECT id, event_type, anime_id, episodes, content, created_at
                    FROM events_legacy
                    """
                )
                db.execute("DROP TABLE events_legacy")
                db.execute(
                    "CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC)"
                )
            event_columns = {row["name"] for row in db.execute("PRAGMA table_info(events)").fetchall()}
            if "theme" not in event_columns:
                db.execute("ALTER TABLE events ADD COLUMN theme TEXT NOT NULL DEFAULT ''")
            if "rating" not in event_columns:
                db.execute("ALTER TABLE events ADD COLUMN rating REAL")
            if "raw_directives" not in event_columns:
                db.execute("ALTER TABLE events ADD COLUMN raw_directives TEXT NOT NULL DEFAULT ''")
            if "themes" not in event_columns:
                db.execute("ALTER TABLE events ADD COLUMN themes TEXT NOT NULL DEFAULT '[]'")
            db.execute("UPDATE events SET theme = CASE event_type WHEN 'watch' THEN 'watch' WHEN 'anime_comment' THEN 'anime_comment' ELSE 'other' END WHERE theme = ''")
            for row in db.execute("SELECT id, theme, themes FROM events").fetchall():
                themes = json_list(row["themes"])
                if not themes:
                    db.execute(
                        "UPDATE events SET themes = ? WHERE id = ?",
                        (json_dumps(normalize_theme_ids(row["theme"])), row["id"]),
                    )
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS anime_characters (
                    anime_id INTEGER NOT NULL,
                    character_id INTEGER NOT NULL,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    order_version INTEGER NOT NULL DEFAULT 1,
                    name TEXT NOT NULL DEFAULT '',
                    name_cn TEXT NOT NULL DEFAULT '',
                    image_url TEXT NOT NULL DEFAULT '',
                    cv_names TEXT NOT NULL DEFAULT '[]',
                    fetched_at TEXT NOT NULL,
                    PRIMARY KEY (anime_id, character_id),
                    FOREIGN KEY(anime_id) REFERENCES anime(id) ON DELETE CASCADE
                )
                """
            )
            # The Bangumi subject-character endpoint already returns credits in
            # the order shown on the subject page.  Keep that position instead
            # of sorting the local cache by a translated name.
            character_columns = {
                row["name"]
                for row in db.execute("PRAGMA table_info(anime_characters)").fetchall()
            }
            if "sort_order" not in character_columns:
                db.execute(
                    "ALTER TABLE anime_characters "
                    "ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0"
                )
            if "order_version" not in character_columns:
                # Existing caches were stored in API order.  Version 1 means
                # that the list was sorted from the public character page.
                db.execute(
                    "ALTER TABLE anime_characters "
                    "ADD COLUMN order_version INTEGER NOT NULL DEFAULT 0"
                )
            defaults = {
                "day_start_hour": 4,
                "show_episode_balance": True,
                "episode_balance_initial": 237,
                "episode_balance_daily_target": 8,
                "episode_balance_anchor": "",
                "statistics_default_theme": "watch",
                "keyboard_shortcuts": {},
                "statistics_show_zero_periods": True,
                "show_watch_events": True,
                "show_note_events": True,
                "show_comment_events": True,
                "record_themes": [
                    {"id": "watch", "name": "观看记录", "color": "#5f8fba", "builtin": True},
                    {"id": "anime_comment", "name": "番剧评论", "color": "#687fb1", "builtin": True},
                    {"id": "anime_rating", "name": "番剧评分", "color": "#b7834a", "builtin": True},
                    {"id": "episode_review", "name": "单集评价", "color": "#a36f9d", "builtin": True},
                    {"id": "oped", "name": "OP/ED记录", "color": "#4c9390", "builtin": True},
                    {"id": "episode_rating", "name": "单集评分", "color": "#c07842", "builtin": True},
                    {"id": "character_record", "name": "人物记录", "color": "#a8795b", "builtin": True},
                    {"id": "other", "name": "其他记录", "color": "#7c8790", "builtin": True},
                ],
                "show_bgm_rating": True,
                "show_bgm_rating_in_collection": True,
                "show_collection_rating_control": True,
                "collection_rating_source": "bgm",
                "show_collection_progress_control": True,
                "show_create_collection_control": True,
                "show_age_related_button": True,
                "show_bilibili_search_button": True,
                "show_saved_video_list": True,
                "merge_bilibili_links": False,
                "show_episode_titles_on_hover": False,
                "show_episode_review_record": True,
                "show_oped_record": True,
                "show_episode_rating_record": True,
                "show_character_tab": True,
                "launch_at_login": False,
                "bound_kazumi_path": "",
                "autostart_active": False,
                "show_ranking_hover_titles": True,
                "ranking_hover_delay_seconds": 2,
                "show_all_collection_tab": True,
                "builtin_collection_order": [1, 2, 3, 4, 5],
                "collection_home": "builtin:1",
                "collection_sort_modes": {},
                "collection_sort_directions": {},
                # Anime ids that moved from Kazumi's "watching" list to
                # "watched" and still need their remaining episodes recorded.
                "pending_kazumi_completed_transitions": [],
                "new_record_defaults_to_other": False,
                "top_sync_action": "webdav",
                "theme_color": "forest",
                "custom_theme_color": "#2e6d4e",
                "custom_background_enabled": False,
                "custom_background_version": 0,
                "custom_background_overlay_opacity": 82,
                "active_theme_profile": "default",
                "theme_profiles": [
                    {"id": "default", "name": "默认主题", "theme_color": "forest", "custom_theme_color": "#2e6d4e", "custom_background_enabled": False, "custom_background_version": 0, "custom_background_overlay_opacity": 82}
                ],
                # Data requests use the official API while browser links use
                # the official subject website.  Extra mirrors can be saved
                # and switched from the settings panel.
                "bgm_api_base": BGM_OFFICIAL_SOURCE["api_base"],
                "bgm_site_base": BGM_OFFICIAL_SOURCE["site_base"],
                "bgm_sources": [BGM_OFFICIAL_SOURCE],
                "active_bgm_source": BGM_OFFICIAL_SOURCE["id"],
                "category_episode_visibility": {
                    "1": True,
                    "2": True,
                    "3": True,
                    "4": True,
                    "5": True,
                },
                "category_rating_visibility": {
                    "1": True, "2": True, "3": True, "4": True, "5": True,
                },
                "category_progress_visibility": {
                    "1": True,
                    "2": True,
                    "3": True,
                    "4": True,
                    "5": True,
                },
                "builtin_category_visibility": {
                    "1": True,
                    "2": True,
                    "3": True,
                    "4": True,
                    "5": True,
                },
                "hide_custom_collection_items_from_builtin": True,
                "show_custom_move_button_without_collections": True,
                "show_progress_bar": True,
                "show_sidebar_toggle": True,
                "show_shutdown_button": True,
                "default_view": "collection",
                "sidebar_visibility": {
                    "schedule": True,                    "collection": True,
                    "timeline": True,
                    "statistics": True,
                    "ranking": True,
                    "settings": True,
                },
                "sidebar_order": ["collection", "schedule", "timeline", "statistics", "ranking", "settings"],
                "sidebar_labels": {},
                "schedule_sort": "time",
                "schedule_grouping": {"mode": "none", "collection_order": ["collected", "uncollected"], "status_order": ["1", "2", "3", "4", "5", "uncollected"], "sorts": {}},
                "schedule_statuses": [1, 2, 3, 4, 5],
                "schedule_uncollected": True,
                "schedule_card_fields": {key: True for key in ["tags", "votes", "release", "score", "collection", "airtime"]},
            }
            for key, value in defaults.items():
                db.execute(
                    "INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)",
                    (key, json_dumps(value)),
                )
            # Templates intentionally contain only tier names, never anime ids.
            if not db.execute(
                "SELECT 1 FROM ranking_templates WHERE is_builtin = 1 LIMIT 1"
            ).fetchone():
                stamp = now_iso()
                db.execute(
                    "INSERT INTO ranking_templates(name, tiers, is_builtin, created_at, updated_at) VALUES (?, ?, 1, ?, ?)",
                    ("默认 SABCD", json_dumps(["S", "A", "B", "C", "D"]), stamp, stamp),
                )
            # Move older installs away from the retired anibt mirror.  The
            # source list did not exist before this migration, so only touch
            # those installs; manually saved sources are never overwritten.
            source_row = db.execute(
                "SELECT value FROM settings WHERE key = 'bgm_sources'"
            ).fetchone()
            try:
                saved_sources = normalize_bgm_sources(
                    json.loads(source_row["value"]) if source_row else []
                )
            except (json.JSONDecodeError, ValueError, TypeError):
                saved_sources = []
            api_row = db.execute(
                "SELECT value FROM settings WHERE key = 'bgm_api_base'"
            ).fetchone()
            try:
                current_api_base = str(json.loads(api_row["value"])) if api_row else ""
            except (json.JSONDecodeError, TypeError):
                current_api_base = ""
            is_unmigrated_default = (
                saved_sources == [BGM_OFFICIAL_SOURCE]
                and "anibt.net" in current_api_base.lower()
            )
            if not saved_sources or is_unmigrated_default:
                db.execute(
                    "INSERT INTO settings(key, value) VALUES (?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    ("bgm_sources", json_dumps([BGM_OFFICIAL_SOURCE])),
                )
                db.execute(
                    "INSERT INTO settings(key, value) VALUES (?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    ("active_bgm_source", json_dumps(BGM_OFFICIAL_SOURCE["id"])),
                )
                db.execute(
                    "INSERT INTO settings(key, value) VALUES (?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    ("bgm_api_base", json_dumps(BGM_OFFICIAL_SOURCE["api_base"])),
                )
                db.execute(
                    "INSERT INTO settings(key, value) VALUES (?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    ("bgm_site_base", json_dumps(BGM_OFFICIAL_SOURCE["site_base"])),
                )
            saved_themes_row = db.execute(
                "SELECT value FROM settings WHERE key = 'record_themes'"
            ).fetchone()
            saved_themes = json_list(saved_themes_row["value"] if saved_themes_row else "[]")
            existing_ids = {str(item.get("id")) for item in saved_themes if isinstance(item, dict)}
            for theme in defaults["record_themes"]:
                if theme["id"] not in existing_ids:
                    saved_themes.append(theme)
            db.execute(
                "UPDATE settings SET value = ? WHERE key = 'record_themes'",
                (json_dumps(saved_themes),),
            )

    def get_settings(self) -> dict[str, Any]:
        with self.connect() as db:
            return {
                row["key"]: json.loads(row["value"])
                for row in db.execute("SELECT key, value FROM settings")
            }

    def set_setting(self, key: str, value: Any) -> None:
        with self._write_lock, self.connect() as db:
            db.execute(
                """
                INSERT INTO settings(key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """,
                (key, json_dumps(value)),
            )

    def list_custom_collections(self) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = db.execute(
                """
                SELECT c.id, c.name, c.created_at, c.updated_at,
                    COUNT(a.id) AS count
                FROM custom_collections c
                LEFT JOIN custom_collection_items i ON i.collection_id = c.id
                LEFT JOIN anime a ON a.id = i.anime_id AND a.active = 1
                GROUP BY c.id
                ORDER BY c.created_at ASC, c.id ASC
                """
            ).fetchall()
        return [dict(row) for row in rows]

    def create_custom_collection(self, name: str) -> dict[str, Any]:
        name = name.strip()
        if not name:
            raise ValueError("收藏夹名称不能为空")
        stamp = now_iso()
        with self._write_lock, self.connect() as db:
            cursor = db.execute(
                """
                INSERT INTO custom_collections(name, created_at, updated_at)
                VALUES (?, ?, ?)
                """,
                (name, stamp, stamp),
            )
            collection_id = int(cursor.lastrowid)
        collection = self.get_custom_collection(collection_id)
        if not collection:
            raise RuntimeError("创建自定义收藏夹失败")
        return collection

    def get_custom_collection(self, collection_id: int) -> dict[str, Any] | None:
        for collection in self.list_custom_collections():
            if int(collection["id"]) == int(collection_id):
                return collection
        return None

    def rename_custom_collection(
        self, collection_id: int, name: str
    ) -> dict[str, Any]:
        name = name.strip()
        if not name:
            raise ValueError("收藏夹名称不能为空")
        with self._write_lock, self.connect() as db:
            cursor = db.execute(
                """
                UPDATE custom_collections
                SET name = ?, updated_at = ?
                WHERE id = ?
                """,
                (name, now_iso(), collection_id),
            )
            if cursor.rowcount <= 0:
                raise KeyError("自定义收藏夹不存在")
        collection = self.get_custom_collection(collection_id)
        if not collection:
            raise KeyError("自定义收藏夹不存在")
        return collection

    def delete_custom_collection(self, collection_id: int) -> bool:
        with self._write_lock, self.connect() as db:
            cursor = db.execute(
                "DELETE FROM custom_collections WHERE id = ?",
                (collection_id,),
            )
            return cursor.rowcount > 0

    def list_ranking_boards(self) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = db.execute("SELECT b.*, COUNT(i.anime_id) AS item_count FROM ranking_boards b LEFT JOIN ranking_items i ON i.board_id = b.id GROUP BY b.id ORDER BY b.updated_at DESC, b.id DESC").fetchall()
        return [dict(row) for row in rows]

    def list_ranking_templates(self) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = db.execute(
                "SELECT * FROM ranking_templates ORDER BY is_builtin DESC, updated_at ASC, id ASC"
            ).fetchall()
        templates = []
        for row in rows:
            template = dict(row)
            template["tiers"] = [str(name).strip() for name in json_list(template["tiers"]) if str(name).strip()]
            templates.append(template)
        return templates

    def create_ranking_template(self, name: str, tier_names: list[Any]) -> dict[str, Any]:
        name = name.strip()
        tiers = [str(item).strip() for item in tier_names if str(item).strip()]
        if not name:
            raise ValueError("模板名称不能为空")
        if not tiers:
            raise ValueError("模板至少需要一个等级")
        stamp = now_iso()
        with self._write_lock, self.connect() as db:
            template_id = int(db.execute(
                "INSERT INTO ranking_templates(name, tiers, created_at, updated_at) VALUES (?, ?, ?, ?)",
                (name, json_dumps(tiers), stamp, stamp),
            ).lastrowid)
            row = db.execute("SELECT * FROM ranking_templates WHERE id = ?", (template_id,)).fetchone()
        template = dict(row or {})
        template["tiers"] = tiers
        return template

    def delete_ranking_template(self, template_id: int) -> bool:
        with self._write_lock, self.connect() as db:
            template = db.execute("SELECT is_builtin FROM ranking_templates WHERE id = ?", (template_id,)).fetchone()
            if not template:
                return False
            if template["is_builtin"]:
                raise ValueError("默认模板不能删除")
            return db.execute("DELETE FROM ranking_templates WHERE id = ?", (template_id,)).rowcount > 0

    def get_ranking_board(self, board_id: int) -> dict[str, Any] | None:
        with self.connect() as db:
            board = db.execute("SELECT * FROM ranking_boards WHERE id = ?", (board_id,)).fetchone()
            if not board:
                return None
            tiers = [dict(row) for row in db.execute("SELECT * FROM ranking_tiers WHERE board_id = ? ORDER BY sort_order, id", (board_id,)).fetchall()]
            items = [dict(row) for row in db.execute("SELECT i.board_id, i.anime_id, i.tier_id, i.sort_order, a.name, a.name_cn, a.image_url FROM ranking_items i JOIN anime a ON a.id = i.anime_id WHERE i.board_id = ? AND a.active = 1 ORDER BY i.tier_id IS NULL DESC, i.tier_id, i.sort_order, i.anime_id", (board_id,)).fetchall()]
        result = dict(board)
        result["tiers"], result["items"] = tiers, items
        return result

    def create_ranking_board(self, name: str, template_id: int | None = None) -> dict[str, Any]:
        name = name.strip()
        if not name:
            raise ValueError("排行榜名称不能为空")
        stamp = now_iso()
        with self._write_lock, self.connect() as db:
            tier_names = ["S", "A", "B", "C", "D"]
            if template_id:
                row = db.execute("SELECT tiers FROM ranking_templates WHERE id = ?", (template_id,)).fetchone()
                if not row:
                    raise ValueError("排名模板不存在")
                tier_names = [str(item).strip() for item in json_list(row["tiers"]) if str(item).strip()]
                if not tier_names:
                    raise ValueError("排名模板没有可用等级")
            board_id = int(db.execute("INSERT INTO ranking_boards(name, created_at, updated_at) VALUES (?, ?, ?)", (name, stamp, stamp)).lastrowid)
            for order, tier_name in enumerate(tier_names):
                db.execute("INSERT INTO ranking_tiers(board_id, name, sort_order) VALUES (?, ?, ?)", (board_id, tier_name, order))
        return self.get_ranking_board(board_id) or {}

    def update_ranking_board(self, board_id: int, name: str) -> dict[str, Any]:
        name = name.strip()
        if not name:
            raise ValueError("排行榜名称不能为空")
        with self._write_lock, self.connect() as db:
            db.execute("UPDATE ranking_boards SET name = ?, updated_at = ? WHERE id = ?", (name, now_iso(), board_id))
        return self.get_ranking_board(board_id) or {}

    def delete_ranking_board(self, board_id: int) -> bool:
        with self._write_lock, self.connect() as db:
            return db.execute("DELETE FROM ranking_boards WHERE id = ?", (board_id,)).rowcount > 0

    def add_ranking_tier(self, board_id: int, name: str) -> dict[str, Any]:
        with self._write_lock, self.connect() as db:
            order = db.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM ranking_tiers WHERE board_id = ?", (board_id,)).fetchone()[0]
            db.execute("INSERT INTO ranking_tiers(board_id, name, sort_order) VALUES (?, ?, ?)", (board_id, name.strip() or "新等级", order))
            db.execute("UPDATE ranking_boards SET updated_at = ? WHERE id = ?", (now_iso(), board_id))
        return self.get_ranking_board(board_id) or {}

    def rename_ranking_tier(self, board_id: int, tier_id: int, name: str) -> dict[str, Any]:
        with self._write_lock, self.connect() as db:
            db.execute("UPDATE ranking_tiers SET name = ? WHERE id = ? AND board_id = ?", (name.strip() or "未命名等级", tier_id, board_id))
        return self.get_ranking_board(board_id) or {}

    def import_ranking_items(self, board_id: int, anime_ids: list[int]) -> dict[str, Any]:
        with self._write_lock, self.connect() as db:
            for order, anime_id in enumerate(dict.fromkeys(int(item) for item in anime_ids)):
                db.execute("INSERT OR IGNORE INTO ranking_items(board_id, anime_id, tier_id, sort_order) VALUES (?, ?, NULL, ?)", (board_id, anime_id, order))
            db.execute("UPDATE ranking_boards SET updated_at = ? WHERE id = ?", (now_iso(), board_id))
        return self.get_ranking_board(board_id) or {}

    def delete_unranked_ranking_item(self, board_id: int, anime_id: int) -> bool:
        with self._write_lock, self.connect() as db:
            cursor = db.execute(
                "DELETE FROM ranking_items WHERE board_id = ? AND anime_id = ? AND tier_id IS NULL",
                (board_id, anime_id),
            )
            if cursor.rowcount:
                db.execute("UPDATE ranking_boards SET updated_at = ? WHERE id = ?", (now_iso(), board_id))
            return cursor.rowcount > 0

    def move_ranking_item(self, board_id: int, anime_id: int, tier_id: int | None, anime_ids: list[int]) -> dict[str, Any]:
        ordered = list(dict.fromkeys(int(item) for item in anime_ids))
        if anime_id not in ordered:
            ordered.append(anime_id)
        with self._write_lock, self.connect() as db:
            if tier_id is not None and not db.execute("SELECT 1 FROM ranking_tiers WHERE id = ? AND board_id = ?", (tier_id, board_id)).fetchone():
                raise ValueError("等级不存在")
            for order, item_id in enumerate(ordered):
                db.execute("UPDATE ranking_items SET tier_id = ?, sort_order = ? WHERE board_id = ? AND anime_id = ?", (tier_id, order, board_id, item_id))
            db.execute("UPDATE ranking_boards SET updated_at = ? WHERE id = ?", (now_iso(), board_id))
        return self.get_ranking_board(board_id) or {}

    def save_ranking_placements(self, board_id: int, placements: dict[str, list[Any]]) -> dict[str, Any]:
        with self._write_lock, self.connect() as db:
            for raw_tier, anime_ids in placements.items():
                tier_id = None if raw_tier == "unranked" else int(raw_tier)
                for order, anime_id in enumerate(dict.fromkeys(int(item) for item in anime_ids)):
                    db.execute("UPDATE ranking_items SET tier_id = ?, sort_order = ? WHERE board_id = ? AND anime_id = ?", (tier_id, order, board_id, anime_id))
            db.execute("UPDATE ranking_boards SET updated_at = ? WHERE id = ?", (now_iso(), board_id))
        return self.get_ranking_board(board_id) or {}

    def add_to_custom_collection(
        self, collection_id: int, anime_id: int
    ) -> dict[str, Any]:
        if not self.get_custom_collection(collection_id):
            raise KeyError("自定义收藏夹不存在")
        if not self.get_anime(anime_id):
            raise KeyError("动漫不存在")
        stamp = now_iso()
        with self._write_lock, self.connect() as db:
            db.execute(
                """
                INSERT OR IGNORE INTO custom_collection_items(
                    collection_id, anime_id, created_at
                ) VALUES (?, ?, ?)
                """,
                (collection_id, anime_id, stamp),
            )
            db.execute(
                "UPDATE custom_collections SET updated_at = ? WHERE id = ?",
                (stamp, collection_id),
            )
        return self.get_anime(anime_id) or {}

    def remove_from_custom_collection(
        self, collection_id: int, anime_id: int
    ) -> dict[str, Any]:
        if not self.get_custom_collection(collection_id):
            raise KeyError("自定义收藏夹不存在")
        with self._write_lock, self.connect() as db:
            db.execute(
                """
                DELETE FROM custom_collection_items
                WHERE collection_id = ? AND anime_id = ?
                """,
                (collection_id, anime_id),
            )
            db.execute(
                "UPDATE custom_collections SET updated_at = ? WHERE id = ?",
                (now_iso(), collection_id),
            )
        return self.get_anime(anime_id) or {}

    def _custom_membership_map(
        self, anime_ids: list[int]
    ) -> dict[int, list[int]]:
        if not anime_ids:
            return {}
        placeholders = ",".join("?" for _ in anime_ids)
        with self.connect() as db:
            rows = db.execute(
                f"""
                SELECT anime_id, collection_id
                FROM custom_collection_items
                WHERE anime_id IN ({placeholders})
                ORDER BY collection_id ASC
                """,
                anime_ids,
            ).fetchall()
        mapping: dict[int, list[int]] = {anime_id: [] for anime_id in anime_ids}
        for row in rows:
            mapping.setdefault(int(row["anime_id"]), []).append(
                int(row["collection_id"])
            )
        return mapping

    def _attach_custom_memberships(
        self, items: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        mapping = self._custom_membership_map([int(item["id"]) for item in items])
        for item in items:
            collection_ids = mapping.get(int(item["id"]), [])
            item["custom_collection_ids"] = collection_ids
            item["in_custom_collection"] = bool(collection_ids)
        return items

    def import_kazumi(self, items: list[dict[str, Any]]) -> dict[str, int]:
        stamp = now_iso()
        incoming_ids = {int(item["id"]) for item in items}
        created = 0
        updated = 0
        completed_from_watching: set[int] = set()
        with self._write_lock, self.connect() as db:
            existing = {
                int(row["id"]): int(row["collection_type"])
                for row in db.execute("SELECT id, collection_type FROM anime")
            }
            existing_ids = set(existing)
            db.execute("UPDATE anime SET active = 0")
            for position, item in enumerate(items):
                anime_id = int(item["id"])
                collection_type = int(item.get("type") or 0)
                if existing.get(anime_id) == 1 and collection_type == 4:
                    completed_from_watching.add(anime_id)
                values = (
                    anime_id,
                    str(item.get("name") or ""),
                    str(item.get("name_cn") or ""),
                    str(item.get("summary") or ""),
                    str(item.get("air_date") or ""),
                    str(item.get("image_url") or ""),
                    collection_type,
                    str(item.get("updated_at") or ""),
                    position,
                    stamp,
                    stamp,
                )
                db.execute(
                    """
                    INSERT INTO anime(
                        id, name, name_cn, summary, air_date, image_url,
                        collection_type, kazumi_updated_at, active, kazumi_position,
                        created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        name = excluded.name,
                        name_cn = excluded.name_cn,
                        summary = excluded.summary,
                        air_date = excluded.air_date,
                        image_url = excluded.image_url,
                        collection_type = excluded.collection_type,
                        kazumi_updated_at = excluded.kazumi_updated_at,
                        active = 1,
                        kazumi_position = excluded.kazumi_position,
                        updated_at = excluded.updated_at
                    """,
                    values,
                )
                if anime_id in existing_ids:
                    updated += 1
                else:
                    created += 1
            if completed_from_watching:
                placeholders = ",".join("?" for _ in completed_from_watching)
                # Prevent the metadata initializer from silently filling a
                # just-completed former watching item before its watch event
                # can be written. Existing watched keys remain untouched.
                db.execute(
                    f"UPDATE anime SET progress_initialized = 1 WHERE id IN ({placeholders})",
                    tuple(completed_from_watching),
                )
            pending_row = db.execute(
                "SELECT value FROM settings WHERE key = ?",
                ("pending_kazumi_completed_transitions",),
            ).fetchone()
            pending = {
                int(anime_id)
                for anime_id in json_list(pending_row["value"] if pending_row else "[]")
                if str(anime_id).isdigit()
            }
            pending.update(completed_from_watching)
            db.execute(
                """
                INSERT INTO settings(key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """,
                (
                    "pending_kazumi_completed_transitions",
                    json_dumps(sorted(pending)),
                ),
            )
            deactivated = len(existing_ids - incoming_ids)
        return {
            "total": len(items),
            "created": created,
            "updated": updated,
            "deactivated": deactivated,
            "completed_from_watching": len(completed_from_watching),
        }

    def complete_kazumi_watching_transitions(self) -> dict[str, int]:
        """Finish progress and create a watch record only for 1 -> 4 moves.

        A title first seen in Kazumi's watched list is deliberately excluded:
        it receives full progress during metadata initialization, but no timeline
        entry. Pending ids are retained when episode metadata is not available.
        """
        pending = self.get_settings().get(
            "pending_kazumi_completed_transitions", []
        )
        pending_ids = list(dict.fromkeys(
            int(anime_id) for anime_id in pending if str(anime_id).isdigit()
        ))
        remaining: list[int] = []
        completed = 0
        recorded_episodes = 0
        for anime_id in pending_ids:
            anime = self.get_anime(anime_id)
            if not anime or not anime.get("active") or int(anime.get("collection_type") or 0) != 4:
                continue
            episode_keys = [str(episode["key"]) for episode in anime.get("episodes", [])]
            if not episode_keys:
                remaining.append(anime_id)
                continue
            result = self.set_progress(anime_id, episode_keys)
            recorded_episodes += len(result["recorded_episodes"])
            completed += 1
        self.set_setting("pending_kazumi_completed_transitions", remaining)
        return {
            "completed": completed,
            "recorded_episodes": recorded_episodes,
            "pending": len(remaining),
        }

    def set_custom_sort_order(self, anime_ids: list[int]) -> list[dict[str, Any]]:
        """Persist the manually arranged card order without touching Kazumi data."""
        unique_ids = list(dict.fromkeys(int(anime_id) for anime_id in anime_ids))
        if not unique_ids:
            raise ValueError("自定义排序不能为空")
        with self._write_lock, self.connect() as db:
            known_ids = {
                int(row["id"])
                for row in db.execute(
                    "SELECT id FROM anime WHERE active = 1"
                ).fetchall()
            }
            if not set(unique_ids).issubset(known_ids):
                raise ValueError("排序中包含不存在的番剧")
            for position, anime_id in enumerate(unique_ids):
                db.execute(
                    "UPDATE anime SET custom_sort_order = ?, updated_at = ? WHERE id = ?",
                    (position, now_iso(), anime_id),
                )
        return self.list_anime()

    @staticmethod
    def _anime_from_row(row: sqlite3.Row) -> dict[str, Any]:
        item = dict(row)
        raw_watched = json_list(item.pop("watched_episodes", "[]"))
        raw_episodes = json_list(item.pop("episodes", "[]"))
        episodes = normalize_episodes(raw_episodes)
        if not episodes and item.get("episode_count"):
            episodes = generated_episodes(int(item.get("episode_count") or 0))
        watched = normalize_watched_keys(
            raw_watched,
            episodes,
            int(item.get("episode_count") or 0),
        )
        groups = episode_groups(episodes)
        item["episodes"] = episodes
        item["episode_groups"] = groups
        item["episode_summary"] = episode_summary(episodes)
        item["has_episode_list"] = bool(raw_episodes)
        item["episode_count"] = len(episodes) if episodes else item.get("episode_count")
        item["watched_episodes"] = watched
        item["watched_episode_keys"] = watched
        item["watched_count"] = len(watched)
        item["display_name"] = item["name_cn"] or item["name"]
        item["category_name"] = CATEGORY_NAMES.get(
            item["collection_type"], "未分类"
        )
        item["cover_url"] = f"/api/covers/{item['id']}"
        return item

    def list_anime(
        self,
        category: int | None = None,
        *,
        custom_collection_id: int | None = None,
        hide_customized_from_builtin: bool = False,
    ) -> list[dict[str, Any]]:
        sql = "SELECT anime.* FROM anime"
        params: list[Any] = []
        if custom_collection_id is not None:
            sql += """
                INNER JOIN custom_collection_items ci
                    ON ci.anime_id = anime.id AND ci.collection_id = ?
            """
            params.append(custom_collection_id)
        sql += " WHERE anime.active = 1"
        if category:
            sql += " AND collection_type = ?"
            params.append(category)
            if hide_customized_from_builtin:
                sql += """
                    AND NOT EXISTS (
                        SELECT 1 FROM custom_collection_items hidden_ci
                        WHERE hidden_ci.anime_id = anime.id
                    )
                """
        sql += """
            ORDER BY
                CASE collection_type
                    WHEN 1 THEN 1 WHEN 2 THEN 2 WHEN 3 THEN 3
                    WHEN 4 THEN 4 ELSE 5
                END,
                COALESCE(NULLIF(name_cn, ''), name) COLLATE NOCASE
        """
        with self.connect() as db:
            items = [
                self._anime_from_row(row)
                for row in db.execute(sql, params).fetchall()
            ]
        return self._attach_custom_memberships(items)

    def get_anime(self, anime_id: int) -> dict[str, Any] | None:
        with self.connect() as db:
            row = db.execute(
                "SELECT * FROM anime WHERE id = ?", (anime_id,)
            ).fetchone()
        if not row:
            return None
        items = self._attach_custom_memberships([self._anime_from_row(row)])
        return items[0] if items else None

    def update_bgm_metadata(
        self,
        anime_id: int,
        *,
        episode_count: int,
        episodes: list[dict[str, Any]] | None = None,
        image_url: str = "",
        name: str = "",
        name_cn: str = "",
        summary: str = "",
        air_date: str = "",
        rating_score: float | None = None,
        rating_rank: int | None = None,
        rating_total: int | None = None,
        rating_synced: bool = False,
        episode_titles_synced: bool = False,
        aired_episode_count: int | None = None,
        episode_release_synced: bool = False,
    ) -> None:
        episode_count = max(0, int(episode_count))
        with self._write_lock, self.connect() as db:
            current = db.execute(
                """
                SELECT collection_type, progress_initialized,
                    watched_episodes, episode_count, episodes, episode_titles_synced
                FROM anime WHERE id = ?
                """,
                (anime_id,),
            ).fetchone()
            if not current:
                return
            pending_transition_row = db.execute(
                "SELECT value FROM settings WHERE key = ?",
                ("pending_kazumi_completed_transitions",),
            ).fetchone()
            pending_completed_transitions = {
                int(value)
                for value in json_list(
                    pending_transition_row["value"]
                    if pending_transition_row
                    else "[]"
                )
                if str(value).isdigit()
            }
            # A full Bangumi episode list may be cached even when title hover is
            # disabled. Preserve it during rating/airing refreshes; otherwise a
            # fallback list of only regular episodes would erase OP/ED groups.
            if episodes is None and int(current["episode_count"] or 0) == episode_count:
                normalized_episodes = normalize_episodes(
                    json_list(current["episodes"])
                )
            else:
                normalized_episodes = normalize_episodes(episodes or [])
            if not normalized_episodes and episode_count:
                normalized_episodes = generated_episodes(episode_count)
            effective_count = len(normalized_episodes) if normalized_episodes else episode_count
            watched = json_list(current["watched_episodes"])
            initialized = int(current["progress_initialized"])
            if not initialized:
                watched = (
                    [episode["key"] for episode in normalized_episodes]
                    if current["collection_type"] == 4
                    else []
                )
                initialized = 1
            else:
                legacy_full_watch = (
                    current["collection_type"] == 4
                    and int(current["episode_count"] or 0) > 0
                    and len(watched) >= int(current["episode_count"] or 0)
                    # A 1 -> 4 Kazumi move must retain the exact saved
                    # progress until complete_kazumi_watching_transitions()
                    # writes an event for the remaining episodes.  Without
                    # this guard, a refreshed larger episode list can make a
                    # previously complete *old* count look like full progress
                    # and silently discard the required watch record.
                    and anime_id not in pending_completed_transitions
                )
                if legacy_full_watch:
                    watched = [episode["key"] for episode in normalized_episodes]
                else:
                    watched = normalize_watched_keys(
                        watched,
                        normalized_episodes,
                        effective_count,
                    )
            db.execute(
                """
                UPDATE anime SET
                    episode_count = ?,
                    episodes = ?,
                    episode_titles_synced = CASE
                        WHEN ? THEN 1 ELSE episode_titles_synced END,
                    aired_episode_count = CASE
                        WHEN ? THEN ? ELSE aired_episode_count END,
                    episode_release_synced_at = CASE
                        WHEN ? THEN ? ELSE episode_release_synced_at END,
                    watched_episodes = ?,
                    progress_initialized = ?,
                    bgm_synced_at = ?,
                    image_url = CASE WHEN ? <> '' THEN ? ELSE image_url END,
                    name = CASE WHEN name = '' AND ? <> '' THEN ? ELSE name END,
                    name_cn = CASE
                        WHEN name_cn = '' AND ? <> '' THEN ? ELSE name_cn END,
                    summary = CASE
                        WHEN summary = '' AND ? <> '' THEN ? ELSE summary END,
                    air_date = CASE
                        WHEN air_date = '' AND ? <> '' THEN ? ELSE air_date END,
                    bgm_score = CASE WHEN ? THEN ? ELSE bgm_score END,
                    bgm_rank = CASE WHEN ? THEN ? ELSE bgm_rank END,
                    bgm_rating_total = CASE WHEN ? THEN ? ELSE bgm_rating_total END,
                    bgm_rating_synced_at = CASE
                        WHEN ? THEN ? ELSE bgm_rating_synced_at END,
                    bgm_rating_version = CASE
                        WHEN ? THEN 2 ELSE bgm_rating_version END,
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    effective_count,
                    json_dumps(normalized_episodes),
                    episode_titles_synced,
                    episode_release_synced,
                    max(0, int(aired_episode_count or 0)),
                    episode_release_synced,
                    now_iso(),
                    json_dumps(
                        normalize_watched_keys(
                            watched,
                            normalized_episodes,
                            effective_count,
                        )
                    ),
                    initialized,
                    now_iso(),
                    image_url,
                    image_url,
                    name,
                    name,
                    name_cn,
                    name_cn,
                    summary,
                    summary,
                    air_date,
                    air_date,
                    rating_synced,
                    rating_score,
                    rating_synced,
                    rating_rank,
                    rating_synced,
                    rating_total,
                    rating_synced,
                    now_iso(),
                    rating_synced,
                    now_iso(),
                    anime_id,
                ),
            )

    def set_episode_count(self, anime_id: int, count: int) -> dict[str, Any]:
        current = self.get_anime(anime_id)
        if not current:
            raise KeyError("动漫不存在")
        self.update_bgm_metadata(anime_id, episode_count=count)
        return self.get_anime(anime_id) or {}

    def set_progress(
        self, anime_id: int, episodes: list[Any]
    ) -> dict[str, Any]:
        anime = self.get_anime(anime_id)
        if not anime:
            raise KeyError("动漫不存在")
        normalized = normalize_watched_keys(
            episodes,
            anime["episodes"],
            int(anime["episode_count"] or 0),
        )
        order = {
            str(episode["key"]): index
            for index, episode in enumerate(anime["episodes"])
        }
        with self._write_lock, self.connect() as db:
            # ``episodes`` is the complete selection from the detail dialog,
            # not an incremental add request.  Treat it as the source of truth
            # so a user can uncheck an already-watched episode.  Watch events
            # are kept in sync below; otherwise they would be restored at the
            # next startup and make a removed episode appear again.
            event_rows = db.execute(
                "SELECT id, episodes FROM events WHERE anime_id = ? AND event_type = 'watch'",
                (anime_id,),
            ).fetchall()
            historical = normalize_watched_keys(
                [
                    key
                    for event in event_rows
                    for key in json_list(event["episodes"])
                ],
                anime["episodes"],
                int(anime["episode_count"] or 0),
            )
            # The saved progress snapshot is durable user intent too.  Older
            # versions could preserve it without a matching timeline event;
            # during a Kazumi 1 -> 4 move those keys must not be recorded
            # again as newly watched episodes.
            stored = normalize_watched_keys(
                anime.get("watched_episode_keys")
                or anime.get("watched_episodes")
                or [],
                anime["episodes"],
                int(anime["episode_count"] or 0),
            )
            desired = set(normalized)
            historical_set = set(historical) | set(stored)
            added = sorted(
                desired - historical_set,
                key=lambda key: order.get(key, 10**9),
            )

            # Remove unchecked episodes from their timeline records.  A record
            # that no longer contains any episode is removed entirely.  This
            # also prevents the startup recovery routine from resurrecting a
            # progress item that the user explicitly cleared.
            for event in event_rows:
                event_keys = normalize_watched_keys(
                    json_list(event["episodes"]),
                    anime["episodes"],
                    int(anime["episode_count"] or 0),
                )
                retained = [key for key in event_keys if key in desired]
                if retained == event_keys:
                    continue
                if retained:
                    db.execute(
                        "UPDATE events SET episodes = ? WHERE id = ?",
                        (json_dumps(retained), int(event["id"])),
                    )
                else:
                    db.execute("DELETE FROM events WHERE id = ?", (int(event["id"]),))

            db.execute(
                """
                UPDATE anime SET watched_episodes = ?,
                    progress_initialized = 1, updated_at = ?
                WHERE id = ?
                """,
                (json_dumps(normalized), now_iso(), anime_id),
            )
            if added:
                db.execute(
                    """
                    INSERT INTO events(
                        event_type, anime_id, episodes, content, theme, themes, created_at
                    ) VALUES ('watch', ?, ?, '', 'watch', '["watch"]', ?)
                    """,
                    (anime_id, json_dumps(added), now_iso()),
                )
        return {
            "anime": self.get_anime(anime_id),
            "recorded_episodes": added,
        }

    def recover_progress_from_watch_events(self, anime_ids: list[int]) -> int:
        """Reconcile current progress with durable watch events.

        This performs no new timeline writes. It only restores the current
        progress state when a previous metadata refresh made stored keys
        temporarily unresolvable. Existing progress and historical records are
        merged, so a partially lost progress field is repaired as well.
        """
        unique_ids = list(dict.fromkeys(int(anime_id) for anime_id in anime_ids))
        if not unique_ids:
            return 0
        restored = 0
        with self._write_lock, self.connect() as db:
            for anime_id in unique_ids:
                row = db.execute(
                    "SELECT episodes, episode_count, watched_episodes FROM anime WHERE id = ?",
                    (anime_id,),
                ).fetchone()
                if not row:
                    continue
                episodes = normalize_episodes(json_list(row["episodes"]))
                if not episodes:
                    continue
                current = normalize_watched_keys(
                    json_list(row["watched_episodes"]),
                    episodes,
                    int(row["episode_count"] or 0),
                )
                event_rows = db.execute(
                    "SELECT episodes FROM events WHERE anime_id = ? AND event_type = 'watch'",
                    (anime_id,),
                ).fetchall()
                historical_keys = [
                    key
                    for event in event_rows
                    for key in json_list(event["episodes"])
                ]
                recovered = normalize_watched_keys(
                    [*current, *historical_keys],
                    episodes,
                    int(row["episode_count"] or 0),
                )
                if recovered != current:
                    db.execute(
                        """
                        UPDATE anime SET watched_episodes = ?, progress_initialized = 1,
                            updated_at = ?
                        WHERE id = ?
                        """,
                        (json_dumps(recovered), now_iso(), anime_id),
                    )
                    restored += 1
        return restored

    def legacy_bgm_watch_event_anime_ids(self) -> list[int]:
        """Find watch records whose old Bangumi keys no longer match cached episodes."""
        with self.connect() as db:
            rows = db.execute(
                """
                SELECT DISTINCT a.id, a.episodes, e.episodes AS event_episodes
                FROM anime AS a JOIN events AS e ON e.anime_id = a.id
                WHERE e.event_type = 'watch'
                """
            ).fetchall()
        affected: set[int] = set()
        for row in rows:
            current_keys = {
                str(item.get("key"))
                for item in normalize_episodes(json_list(row["episodes"]))
            }
            event_keys = {str(key) for key in json_list(row["event_episodes"])}
            if any(key.startswith("bgm:") and key not in current_keys for key in event_keys):
                affected.add(int(row["id"]))
        return sorted(affected)

    def get_age_related_cache(self, anime_id: int) -> dict[str, Any] | None:
        with self.connect() as db:
            row = db.execute(
                "SELECT * FROM age_related_cache WHERE anime_id = ?",
                (anime_id,),
            ).fetchone()
        if not row:
            return None
        result = dict(row)
        result["items"] = json_list(result.get("items"))
        result["items"].sort(
            key=lambda item: (
                not bool(str(item.get("air_date") or "").strip()),
                str(item.get("air_date") or "9999-12-31"),
                str(item.get("title") or ""),
            )
        )
        return result

    def save_age_related_cache(
        self,
        anime_id: int,
        *,
        search_term: str,
        source_title: str,
        source_url: str,
        items: list[dict[str, Any]],
    ) -> dict[str, Any]:
        with self._write_lock, self.connect() as db:
            db.execute(
                """
                INSERT INTO age_related_cache(
                    anime_id, search_term, source_title, source_url, items, fetched_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(anime_id) DO UPDATE SET
                    search_term = excluded.search_term,
                    source_title = excluded.source_title,
                    source_url = excluded.source_url,
                    items = excluded.items,
                    fetched_at = excluded.fetched_at
                """,
                (
                    anime_id,
                    search_term,
                    source_title,
                    source_url,
                    json_dumps(items),
                    now_iso(),
                ),
            )
        return self.get_age_related_cache(anime_id) or {}

    def list_anime_characters(self, anime_id: int) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = db.execute(
                """SELECT character_id, sort_order, name, name_cn, image_url, cv_names
                   FROM anime_characters WHERE anime_id = ?
                   ORDER BY sort_order ASC, character_id ASC""",
                (anime_id,),
            ).fetchall()
        result = [dict(row) for row in rows]
        for item in result:
            item["cv_names"] = json_list(item.get("cv_names"))
            item["cover_url"] = f"/api/character-covers/{anime_id}/{item['character_id']}"
        return result

    def anime_characters_need_order_refresh(self, anime_id: int) -> bool:
        """Whether this is an old cache created before Bangumi order was kept."""
        with self.connect() as db:
            row = db.execute(
                """SELECT COUNT(*) AS total, MIN(sort_order) AS first_position,
                          MAX(sort_order) AS last_position,
                          MIN(order_version) AS oldest_order_version
                   FROM anime_characters WHERE anime_id = ?""",
                (anime_id,),
            ).fetchone()
        # Pre-order caches received SQLite's migration default (all zero).
        # A fresh cache has contiguous positions 0..n-1.
        return bool(
            row
            and int(row["total"] or 0) > 1
            and (
                int(row["oldest_order_version"] or 0) < 1
                or (
                    int(row["first_position"] or 0) == 0
                    and int(row["last_position"] or 0) == 0
                )
            )
        )

    def replace_anime_characters(self, anime_id: int, characters: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not self.get_anime(anime_id):
            raise KeyError("动画不存在")
        with self._write_lock, self.connect() as db:
            db.execute("DELETE FROM anime_characters WHERE anime_id = ?", (anime_id,))
            db.executemany(
                """INSERT INTO anime_characters(
                    anime_id, character_id, sort_order, order_version, name, name_cn, image_url, cv_names, fetched_at
                ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)""",
                [
                    (
                        anime_id,
                        int(item["character_id"]),
                        position,
                        str(item.get("name") or ""),
                        str(item.get("name_cn") or ""),
                        str(item.get("image_url") or ""),
                        json_dumps(item.get("cv_names") or []),
                        now_iso(),
                    )
                    for position, item in enumerate(characters)
                    if item.get("character_id")
                ],
            )
        return self.list_anime_characters(anime_id)

    def add_note(
        self,
        content: str,
        anime_id: int | None = None,
        theme: str = "other",
        *,
        themes: list[str] | None = None,
        episode_keys: list[Any] | None = None,
        raw_directives: str = "",
    ) -> int:
        content = content.strip()
        if not content and not raw_directives.strip():
            raise ValueError("记录不能为空")
        if anime_id is not None and not self.get_anime(anime_id):
            raise KeyError("关联的动漫不存在")
        theme_ids = normalize_theme_ids(themes if themes is not None else theme, theme)
        primary_theme = theme_ids[0] if theme_ids else "other"
        episode_json = json_dumps([str(item) for item in (episode_keys or [])])
        with self._write_lock, self.connect() as db:
            cursor = db.execute(
                """
                INSERT INTO events(
                    event_type, anime_id, episodes, content, theme, themes, raw_directives, created_at
                ) VALUES ('note', ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    anime_id,
                    episode_json,
                    content,
                    primary_theme,
                    json_dumps(theme_ids),
                    raw_directives,
                    now_iso(),
                ),
            )
            return int(cursor.lastrowid)

    def add_anime_comment(
        self, anime_id: int, content: str, *, raw_directives: str = ""
    ) -> int:
        content = content.strip()
        if not content:
            raise ValueError("番剧评论不能为空")
        anime = self.get_anime(anime_id)
        if not anime:
            raise KeyError("动漫不存在")
        raw_directives = raw_directives.strip() or (
            f"#主题 番剧评论\n#动漫 {anime.get('name_cn') or anime.get('name') or ''}\n{content}"
        )
        with self._write_lock, self.connect() as db:
            cursor = db.execute(
                """
                INSERT INTO events(event_type, anime_id, episodes, content, theme, themes, raw_directives, created_at)
                VALUES ('anime_comment', ?, '[]', ?, 'anime_comment', '["anime_comment"]', ?, ?)
                """,
                (anime_id, content, raw_directives, now_iso()),
            )
            return int(cursor.lastrowid)

    def add_anime_rating(self, anime_id: int, rating: str) -> int:
        anime = self.get_anime(anime_id)
        if not anime:
            raise KeyError("动漫不存在")
        rating = str(rating or "").strip()
        if not rating:
            raise ValueError("评分不能为空")
        if len(rating) > 80:
            raise ValueError("评分不能超过 80 个字符")
        with self._write_lock, self.connect() as db:
            db.execute("UPDATE anime SET personal_rating_text = ?, updated_at = ? WHERE id = ?", (rating, now_iso(), anime_id))
            cursor = db.execute(
                """
                INSERT INTO events(event_type, anime_id, episodes, content, theme, themes, rating, raw_directives, created_at)
                VALUES ('note', ?, '[]', ?, 'anime_rating', '["anime_rating"]', ?, ?, ?)
                """,
                (
                    anime_id,
                    f"评分：{rating}",
                    None,
                    f"#主题 番剧评分\n#动漫 {anime.get('name_cn') or anime.get('name') or ''}\n评分：{rating}",
                    now_iso(),
                ),
            )
            return int(cursor.lastrowid)

    def clear_anime_rating(self, anime_id: int) -> int:
        """Clear the current personal score and its generated timeline records."""
        if not self.get_anime(anime_id):
            raise KeyError("动漫不存在")
        with self._write_lock, self.connect() as db:
            db.execute(
                "UPDATE anime SET personal_rating_text = '', updated_at = ? WHERE id = ?",
                (now_iso(), anime_id),
            )
            cursor = db.execute(
                "DELETE FROM events WHERE anime_id = ? AND theme = 'anime_rating'",
                (anime_id,),
            )
            return int(cursor.rowcount)

    def list_anime_comments(self, anime_id: int) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = db.execute(
                """
                SELECT id, content, created_at FROM events
                WHERE anime_id = ? AND event_type = 'anime_comment'
                ORDER BY julianday(created_at) DESC, id DESC
                """,
                (anime_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def delete_event(self, event_id: int) -> bool:
        with self._write_lock, self.connect() as db:
            cursor = db.execute("DELETE FROM events WHERE id = ?", (event_id,))
            return cursor.rowcount > 0

    def update_event(self, event_id: int, *, content: str, anime_id: int | None, theme: str, themes: list[str] | None = None, rating: float | None = None, raw_directives: str = "", episode_text: str = "") -> bool:
        content = content.strip()
        if not content and not raw_directives.strip():
            raise ValueError("正文不能为空")
        if anime_id is not None and not self.get_anime(anime_id):
            raise KeyError("关联的动漫不存在")
        theme_ids = normalize_theme_ids(themes if themes is not None else theme, theme)
        primary_theme = theme_ids[0] if theme_ids else "other"
        with self._write_lock, self.connect() as db:
            # episode_text is deliberately not converted to episode keys.  The
            # editable #集数 directive is free-form; existing keys are retained
            # only for quick-action annotations and progress bookkeeping.
            cursor = db.execute(
                "UPDATE events SET anime_id = ?, content = ?, theme = ?, themes = ?, rating = ?, raw_directives = ? WHERE id = ?",
                (anime_id, content, primary_theme, json_dumps(theme_ids), rating, raw_directives, event_id),
            )
            return cursor.rowcount > 0

    # These tables describe the account itself.  Deliberately omit covers,
    # character data and AGE cache: they are download caches and are rebuilt
    # from the Bangumi subject IDs after a cloud restore.
    CLOUD_TABLES = (
        "anime", "events", "settings", "custom_collections",
        "custom_collection_items", "ranking_boards", "ranking_templates",
        "ranking_tiers", "ranking_items",
    )

    def export_cloud_state(self) -> dict[str, Any]:
        """Return portable account data without local image/API caches."""
        with self.connect() as db:
            tables = {
                table: [dict(row) for row in db.execute(f"SELECT * FROM {table}").fetchall()]
                for table in self.CLOUD_TABLES
            }
        return {"format": 1, "exported_at": now_iso(), "tables": tables}

    def import_cloud_state(self, state: Any) -> None:
        """Replace account-owned tables with a validated WebDAV state."""
        if not isinstance(state, dict) or int(state.get("format") or 0) != 1:
            raise ValueError("云端手账数据格式不受支持")
        raw_tables = state.get("tables")
        if not isinstance(raw_tables, dict):
            raise ValueError("云端手账数据不完整")
        tables: dict[str, list[dict[str, Any]]] = {}
        for table in self.CLOUD_TABLES:
            rows = raw_tables.get(table)
            if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
                raise ValueError(f"云端数据缺少 {table}")
            tables[table] = rows
        # Keep the amount sensible before opening a transaction.  A normal
        # handbook is far below this ceiling; it avoids a malformed DAV file
        # exhausting SQLite with an accidental giant import.
        if sum(len(rows) for rows in tables.values()) > 200_000:
            raise ValueError("云端手账数据过大")
        with self._write_lock, self.connect() as db:
            db.execute("PRAGMA foreign_keys = OFF")
            try:
                for table in (
                    "ranking_items", "ranking_tiers", "ranking_templates", "ranking_boards",
                    "custom_collection_items", "custom_collections", "events", "anime",
                    "settings",
                ):
                    db.execute(f"DELETE FROM {table}")
                for table in self.CLOUD_TABLES:
                    rows = tables[table]
                    if not rows:
                        continue
                    available = {
                        row["name"] for row in db.execute(f"PRAGMA table_info({table})").fetchall()
                    }
                    columns = [column for column in rows[0] if column in available]
                    if not columns:
                        continue
                    placeholders = ", ".join("?" for _ in columns)
                    sql = f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({placeholders})"
                    db.executemany(sql, [tuple(row.get(column) for column in columns) for row in rows])
                # Character and AGE caches point at old metadata. They are
                # intentionally local and safe to rebuild on demand.
                db.execute("DELETE FROM anime_characters")
                db.execute("DELETE FROM age_related_cache")
            finally:
                db.execute("PRAGMA foreign_keys = ON")

    def timeline(
        self,
        *,
        show_watch: bool = True,
        show_notes: bool = True,
        show_comments: bool = True,
        search: str = "",
        event_ids: list[int] | None = None,
    ) -> list[dict[str, Any]]:
        if not show_watch and not show_notes and not show_comments:
            return []
        event_types = []
        if show_watch:
            event_types.append("watch")
        if show_notes:
            event_types.append("note")
        if show_comments:
            event_types.append("anime_comment")
        placeholders = ",".join("?" for _ in event_types)
        search = search.strip()
        sql = f"""
                SELECT e.*, a.name, a.name_cn, a.image_url,
                    a.episodes AS anime_episodes,
                    a.episode_count AS anime_episode_count
                FROM events e
                LEFT JOIN anime a ON a.id = e.anime_id
                WHERE e.event_type IN ({placeholders})
        """
        params: list[Any] = list(event_types)
        if event_ids is not None:
            if not event_ids:
                return []
            sql += " AND e.id IN (" + ",".join("?" for _ in event_ids) + ")"
            params.extend(event_ids)
        if search:
            sql += """
                AND (a.name LIKE ? OR a.name_cn LIKE ? OR e.content LIKE ?)
            """
            keyword = f"%{search}%"
            params.extend([keyword, keyword, keyword])
        # Cloud records may use either a UTC `Z` suffix (mobile) or a local
        # offset (desktop).  Text ordering puts 15:47Z before 16:10+08:00 even
        # though it is actually 23:47 in Beijing, so order by real instants.
        sql += " ORDER BY julianday(e.created_at) DESC, e.id DESC"
        with self.connect() as db:
            rows = db.execute(
                sql,
                params,
            ).fetchall()
        events = []
        for row in rows:
            event = dict(row)
            event["themes"] = normalize_theme_ids(
                json_list(event.get("themes")), str(event.get("theme") or "other")
            )
            raw_event_episodes = json_list(event.get("episodes"))
            anime_episodes = normalize_episodes(
                json_list(event.pop("anime_episodes", "[]"))
            )
            if not anime_episodes and event.get("anime_episode_count"):
                anime_episodes = generated_episodes(
                    int(event.get("anime_episode_count") or 0)
                )
            episode_keys = normalize_watched_keys(
                raw_event_episodes,
                anime_episodes,
                int(event.pop("anime_episode_count", 0) or 0),
            )
            by_key = {
                str(episode["key"]): episode for episode in anime_episodes
            }
            event["episode_keys"] = episode_keys
            event["episodes"] = [
                by_key.get(key)
                or {
                    "key": key,
                    "display_label": str(key),
                    "type_label": "",
                    "label": str(key),
                }
                for key in episode_keys
            ]
            event["display_name"] = event["name_cn"] or event["name"] or ""
            events.append(event)
        return events

    def timeline_days(
        self,
        *,
        show_watch: bool = True,
        show_notes: bool = True,
        show_comments: bool = True,
        search: str = "",
        event_ids: list[int] | None = None,
    ) -> list[dict[str, Any]]:
        settings = self.get_settings()
        day_start = int(settings.get("day_start_hour", 4))
        groups: dict[str, dict[str, Any]] = {}
        for event in self.timeline(
            show_watch=show_watch,
            show_notes=show_notes,
            show_comments=show_comments,
            search=search,
            event_ids=event_ids,
        ):
            moment = datetime.fromisoformat(event["created_at"])
            key = (moment - timedelta(hours=day_start)).date().isoformat()
            if key not in groups:
                groups[key] = {
                    "date": key,
                    "episode_total": 0,
                    "anime_ids": set(),
                    "events": [],
                }
            group = groups[key]
            group["events"].append(event)
            if event["event_type"] == "watch":
                group["episode_total"] += len(event["episodes"])
                if event["anime_id"]:
                    group["anime_ids"].add(event["anime_id"])
        result = []
        for key in sorted(groups, reverse=True):
            group = groups[key]
            group["anime_total"] = len(group.pop("anime_ids"))
            result.append(group)
        return result

    def timeline_page(self, *, search: str = "", themes: list[str] | None = None,
                      offset: int = 0, limit: int = 30) -> dict[str, Any]:
        """Page lightweight event headers first; expand only this page's episodes.

        Finish the last day so daily summaries and day sections remain complete.
        """
        offset = max(0, offset)
        limit = max(1, min(100, limit))
        selected = set(themes or [])
        day_start = int(self.get_settings().get("day_start_hour", 4))
        sql = """SELECT e.id, e.created_at, e.theme, e.themes FROM events e
                 LEFT JOIN anime a ON a.id=e.anime_id
                 WHERE e.event_type IN ('watch','note','anime_comment')"""
        params: list[Any] = []
        if search.strip():
            sql += " AND (a.name LIKE ? OR a.name_cn LIKE ? OR e.content LIKE ?)"
            params = [f"%{search.strip()}%"] * 3
        sql += " ORDER BY julianday(e.created_at) DESC, e.id DESC"
        ids: list[int] = []
        skipped = 0
        last_day = None
        has_more = False
        with self.connect() as db:
            for row in db.execute(sql, params):
                if selected and not selected.intersection(normalize_theme_ids(json_list(row["themes"]), row["theme"] or "other")):
                    continue
                if skipped < offset:
                    skipped += 1
                    continue
                day = (datetime.fromisoformat(row["created_at"]) - timedelta(hours=day_start)).date()
                if len(ids) >= limit and day != last_day:
                    has_more = True
                    break
                ids.append(row["id"])
                last_day = day
        with self.connect() as db:
            # Account-wide metadata, independent of search, selection and paging.
            theme_rows = db.execute("SELECT DISTINCT theme,themes FROM events WHERE event_type IN ('watch','note','anime_comment')")
            available_themes = sorted({theme for row in theme_rows
                for theme in normalize_theme_ids(json_list(row["themes"]), row["theme"] or "other")})
        return {"days": self.timeline_days(event_ids=ids), "has_more": has_more,
                "next_offset": offset + len(ids), "available_themes": available_themes}

    def episode_record_annotations(self, anime_id: int) -> dict[str, list[dict[str, Any]]]:
        """Return lightweight, per-episode notes created through quick episode actions."""
        quick_theme_ids = {"episode_review", "episode_rating", "oped"}
        with self.connect() as db:
            rows = db.execute(
                """
                SELECT id, content, created_at, theme, themes, episodes
                FROM events
                WHERE anime_id = ? AND event_type = 'note'
                ORDER BY julianday(created_at) DESC, id DESC
                """,
                (anime_id,),
            ).fetchall()
        annotations: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            event = dict(row)
            theme_ids = normalize_theme_ids(
                json_list(event.get("themes")), str(event.get("theme") or "other")
            )
            matched_themes = [theme_id for theme_id in theme_ids if theme_id in quick_theme_ids]
            if not matched_themes:
                continue
            for episode_key in json_list(event.get("episodes")):
                key = str(episode_key)
                annotations.setdefault(key, []).append(
                    {
                        "id": event["id"],
                        "themes": matched_themes,
                        "content": str(event.get("content") or ""),
                        "created_at": event["created_at"],
                    }
                )
        return annotations

    def _record_day_key(self, moment: datetime, day_start: int) -> str:
        return (moment - timedelta(hours=day_start)).date().isoformat()

    def episode_balance(self) -> dict[str, Any]:
        """Calculate the planned-vs-watched episode balance from its saved baseline."""
        settings = self.get_settings()
        day_start = int(settings.get("day_start_hour", 4))
        today = self._record_day_key(datetime.now(), day_start)
        anchor = str(settings.get("episode_balance_anchor") or "")
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", anchor):
            anchor = today
            self.set_setting("episode_balance_anchor", anchor)
        try:
            anchor_date = datetime.fromisoformat(anchor).date()
        except ValueError:
            anchor_date = datetime.fromisoformat(today).date()
        today_date = datetime.fromisoformat(today).date()
        planned_days = max(0, (today_date - anchor_date).days)
        daily_target = max(0, int(settings.get("episode_balance_daily_target", 8)))
        initial = int(settings.get("episode_balance_initial", 237))
        watched = 0
        with self.connect() as db:
            rows = db.execute(
                "SELECT episodes, created_at FROM events WHERE event_type = 'watch'"
            ).fetchall()
        for row in rows:
            try:
                event_day = self._record_day_key(datetime.fromisoformat(row["created_at"]), day_start)
            except (TypeError, ValueError):
                continue
            if event_day >= anchor:
                watched += len(json_list(row["episodes"]))
        return {
            "enabled": bool(settings.get("show_episode_balance", True)),
            "value": initial + planned_days * daily_target - watched,
            "watched": watched,
            "planned": planned_days * daily_target,
            "anchor": anchor,
        }

    def reset_episode_balance_anchor(self, initial: int | None = None) -> None:
        settings = self.get_settings()
        day_start = int(settings.get("day_start_hour", 4))
        if initial is not None:
            self.set_setting("episode_balance_initial", int(initial))
        self.set_setting("episode_balance_anchor", self._record_day_key(datetime.now(), day_start))

    def update_episode_balance_settings(
        self,
        *,
        initial: int | None = None,
        daily_target: int | None = None,
    ) -> None:
        """Update balance settings without moving the baseline on an unchanged save."""
        settings = self.get_settings()
        old_initial = int(settings.get("episode_balance_initial", 237))
        old_daily_target = max(
            0, int(settings.get("episode_balance_daily_target", 8))
        )
        new_initial = old_initial if initial is None else int(initial)
        new_daily_target = (
            old_daily_target
            if daily_target is None
            else min(100, max(0, int(daily_target)))
        )

        initial_changed = initial is not None and new_initial != old_initial
        target_changed = (
            daily_target is not None and new_daily_target != old_daily_target
        )
        if not initial_changed and not target_changed:
            return

        # Preserve the balance at the instant the daily target changes. An
        # explicitly changed initial value, on the other hand, intentionally
        # starts a new baseline from today.
        current_balance = self.episode_balance()["value"]
        self.set_setting("episode_balance_daily_target", new_daily_target)
        self.reset_episode_balance_anchor(
            new_initial if initial_changed else int(current_balance)
        )

    def statistics(self, period: str, record_type: str) -> list[dict[str, Any]]:
        if period not in {"day", "week", "month", "year"}:
            raise ValueError("统计周期无效")
        # Keep the old API aliases working for existing clients while the UI
        # now sends the real record-theme id.
        record_type = {"comment": "anime_comment", "other": "other"}.get(
            record_type, record_type
        )
        with self.connect() as db:
            rows = db.execute(
                "SELECT event_type, theme, themes, episodes, created_at FROM events ORDER BY julianday(created_at) ASC, id ASC"
            ).fetchall()
        day_start = int(self.get_settings().get("day_start_hour", 4))
        groups: dict[str, dict[str, Any]] = {}
        for row in rows:
            event = dict(row)
            theme_ids = normalize_theme_ids(json_list(event.get("themes")), str(event.get("theme") or ""))
            if not theme_ids:
                theme_ids = ["watch" if event["event_type"] == "watch" else "anime_comment" if event["event_type"] == "anime_comment" else "other"]
            if record_type != "all" and record_type not in theme_ids:
                continue
            moment = datetime.fromisoformat(event["created_at"])
            adjusted = moment - timedelta(hours=day_start)
            key = (
                adjusted.date().isoformat()
                if period == "day"
                else f"{adjusted.isocalendar().year}-W{adjusted.isocalendar().week:02d}"
                if period == "week"
                else adjusted.strftime("%Y-%m")
                if period == "month"
                else str(adjusted.year)
            )
            group = groups.setdefault(
                key,
                {"label": key, "episodes": 0, "records": 0},
            )
            group["records"] += 1
            if event["event_type"] == "watch":
                group["episodes"] += len(json_list(event["episodes"]))
        # Keep missing periods between the first and last matching records.
        # Do not invent leading/trailing periods outside the recorded range.
        if groups:
            first, last = min(groups), max(groups)
            if period == "day":
                cursor = date.fromisoformat(first)
            elif period == "week":
                year, week = first.split("-W")
                cursor = date.fromisocalendar(int(year), int(week), 1)
            elif period == "month":
                cursor = date.fromisoformat(first + "-01")
            else:
                cursor = date(int(first), 1, 1)
            while True:
                key = (
                    cursor.isoformat() if period == "day"
                    else f"{cursor.isocalendar().year}-W{cursor.isocalendar().week:02d}" if period == "week"
                    else cursor.strftime("%Y-%m") if period == "month"
                    else str(cursor.year)
                )
                groups.setdefault(key, {"label": key, "episodes": 0, "records": 0})
                if key == last:
                    break
                if period in {"day", "week"}:
                    cursor += timedelta(days=1 if period == "day" else 7)
                elif period == "month":
                    cursor = date(cursor.year + (cursor.month == 12), cursor.month % 12 + 1, 1)
                else:
                    cursor = date(cursor.year + 1, 1, 1)
        return [groups[key] for key in sorted(groups)]

    def stats(self) -> dict[str, Any]:
        settings = self.get_settings()
        hide_customized = bool(
            settings.get("hide_custom_collection_items_from_builtin", True)
        )
        with self.connect() as db:
            category_sql = """
                SELECT collection_type, COUNT(*) AS count
                FROM anime
                WHERE active = 1
            """
            if hide_customized:
                category_sql += """
                    AND NOT EXISTS (
                        SELECT 1 FROM custom_collection_items hidden_ci
                        WHERE hidden_ci.anime_id = anime.id
                    )
                """
            category_sql += " GROUP BY collection_type"
            category_counts = {
                str(row["collection_type"]): row["count"]
                for row in db.execute(category_sql)
            }
            custom_collection_counts = {
                str(row["id"]): row["count"]
                for row in db.execute(
                    """
                    SELECT c.id, COUNT(a.id) AS count
                    FROM custom_collections c
                    LEFT JOIN custom_collection_items i
                        ON i.collection_id = c.id
                    LEFT JOIN anime a ON a.id = i.anime_id AND a.active = 1
                    GROUP BY c.id
                    """
                )
            }
            total_watched = 0
            for row in db.execute(
                """
                SELECT watched_episodes, episodes, episode_count
                FROM anime WHERE active = 1
                """
            ):
                episodes = normalize_episodes(json_list(row["episodes"]))
                if not episodes and row["episode_count"]:
                    episodes = generated_episodes(int(row["episode_count"] or 0))
                total_watched += len(
                    normalize_watched_keys(
                        json_list(row["watched_episodes"]),
                        episodes,
                        int(row["episode_count"] or 0),
                    )
                )
            today_key = (
                datetime.now().astimezone()
                - timedelta(hours=int(self.get_settings()["day_start_hour"]))
            ).date().isoformat()
            today_episodes = 0
            # Dashboard totals need only today's expanded episode records.
            # Avoid expanding the entire history on every status poll.
            day_start_hour = int(self.get_settings()["day_start_hour"])
            today_event_ids = [row["id"] for row in db.execute(
                "SELECT id, created_at FROM events WHERE event_type='watch'"
            ) if (datetime.fromisoformat(row["created_at"]) - timedelta(
                hours=day_start_hour
            )).date().isoformat() == today_key]
            for event in self.timeline(show_watch=True, show_notes=False, show_comments=False,
                                       event_ids=today_event_ids):
                moment = datetime.fromisoformat(event["created_at"])
                key = (
                    moment
                    - timedelta(
                        hours=int(self.get_settings()["day_start_hour"])
                    )
                ).date().isoformat()
                if key == today_key:
                    today_episodes += len(event["episodes"])
            active_total = db.execute(
                "SELECT COUNT(*) FROM anime WHERE active = 1"
            ).fetchone()[0]
            return {
                "category_counts": category_counts,
                "custom_collection_counts": custom_collection_counts,
                "anime_total": active_total,
                "watched_episode_total": total_watched,
                "today_episode_total": today_episodes,
            }


