from __future__ import annotations
from .video_links import VideoLinks
from .shortcuts import normalize_shortcuts

from typing import Any
from http.server import BaseHTTPRequestHandler
from http import HTTPStatus
from pathlib import Path
from schedule import ScheduleService
from schedule import attach_collection
import base64
import json
import mimetypes
import os
from urllib.parse import parse_qs
import re
from schedule import season_key
import secrets
import time
from urllib.parse import unquote
from urllib.parse import urlparse
from .common import (BACKGROUND_ROOT, CATEGORY_NAMES, DATA_ROOT, MAX_JSON_BODY_BYTES, RECORD_IMAGE_ROOT, STATIC_ROOT, background_stem, configure_windows_autostart, find_background_asset, json_dumps, normalize_background_bytes, normalize_bgm_sources, safe_asset_id, with_initial_appearance)
from .common import normalize_schedule_grouping
from .metadata import SyncService

SCHEDULE = ScheduleService(DATA_ROOT / "schedule")

def _desktop():
    from . import desktop
    return desktop

class RequestHandler(BaseHTTPRequestHandler):
    server_version = "AnimeHandbook/1.0"

    @property
    def schedule(self):
        return SCHEDULE

    def require_write_access(self) -> None:
        _desktop().require_active_profile_write_access()

    @property
    def database(self):
        if hasattr(self, "services"):
            return getattr(self.services, "database")
        return _desktop().DATABASE

    @property
    def sync(self):
        if hasattr(self, "services"):
            return getattr(self.services, "sync")
        return _desktop().SYNC

    @property
    def age(self):
        if hasattr(self, "services"):
            return getattr(self.services, "age")
        return _desktop().AGE

    @property
    def profiles(self):
        if hasattr(self, "services"):
            return getattr(self.services, "profiles")
        return _desktop().PROFILES

    @property
    def sharing(self):
        if hasattr(self, "services"):
            return getattr(self.services, "sharing")
        return _desktop().SHARING

    @property
    def webdav(self):
        if hasattr(self, "services"):
            return getattr(self.services, "webdav")
        return _desktop().WEBDAV

    @property
    def background_root(self):
        if hasattr(self, "services"):
            return getattr(self.services, "background_root")
        return BACKGROUND_ROOT

    @property
    def record_image_root(self):
        if hasattr(self, "services"):
            return getattr(self.services, "record_image_root")
        return RECORD_IMAGE_ROOT



    def log_message(self, format_string: str, *args: Any) -> None:
        if os.environ.get("ANIME_HANDBOOK_DEBUG"):
            super().log_message(format_string, *args)

    def send_json(
        self, payload: Any, status: int = HTTPStatus.OK
    ) -> None:
        body = json_dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict[str, Any]:
        size = int(self.headers.get("Content-Length", "0"))
        if size <= 0:
            return {}
        if size > MAX_JSON_BODY_BYTES:
            raise ValueError("请求内容过大")
        return json.loads(self.rfile.read(size).decode("utf-8"))

    def send_error_json(self, status: int, message: str) -> None:
        self.send_json({"ok": False, "message": message}, status)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        try:
            if path == "/api/background":
                profile_id = safe_asset_id(query.get("profile", [""])[0], "default")
                account_id = safe_asset_id(query.get("account", [""])[0], "local")
                image = find_background_asset(account_id, profile_id, root=self.background_root) if profile_id else None
                image = image or next(iter(self.background_root.glob("background.*")), None)
                if not image:
                    self.send_error(HTTPStatus.NOT_FOUND)
                    return
                body = image.read_bytes()
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", mimetypes.guess_type(image.name)[0] or "image/jpeg")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                self.wfile.write(body)
            elif path == "/api/health":
                self.send_json({"ok": True, "features": {"schedule_sorting": 2, "keyboard_shortcuts": 1}})
            elif path == "/api/bootstrap":
                self.send_json(
                    {
                        "profiles": self.profiles.list_profiles(),
                        "active_profile": self.profiles.profile(),
                        "sharing": self.sharing.status(),
                        "webdav": self.webdav.status(),
                        "animes": self.database.list_anime(),
                        "custom_collections": self.database.list_custom_collections(),
                        "ranking_boards": self.database.list_ranking_boards(),
                        "ranking_templates": self.database.list_ranking_templates(),
                        "settings": self.database.get_settings(),
                        "stats": self.database.stats(),
                        "sync": self.sync.status,
                    }
                )
            elif path == "/api/schedule":
                season = season_key(query.get("season", [""])[0])
                source = query.get("source", ["yuc"])[0]
                document = self.schedule.for_source(source).get(season, refresh=query.get("refresh", [""])[0] == "true")
                if source == "yuc":
                    document = {**document, "items": [row for row in document["items"] if not row["key"].startswith("bgm-")]}
                with self.database.connect() as db:
                    local = [dict(row) for row in db.execute(
                        "SELECT id,name,name_cn,collection_type,bgm_score,bgm_rating_total FROM anime WHERE active=1"
                    )]
                self.send_json(attach_collection(document, local))
            elif path == "/api/schedule/cover":
                body, mime = self.schedule.for_source(query.get("source", ["yuc"])[0]).cover(season_key(query.get("season", [""])[0]), query.get("key", [""])[0])
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "public, max-age=86400")
                self.end_headers()
                self.wfile.write(body)
            elif path == "/api/profiles":
                self.send_json({"profiles": self.profiles.list_profiles(), "active_profile": self.profiles.profile()})
            elif path == "/api/sharing":
                self.send_json({
                    "sharing": self.sharing.status(),
                    "available_profiles": self.sharing.available_profiles(),
                    "device_requests": self.sharing.device_requests(),
                })
            elif path == "/api/webdav":
                self.send_json({"webdav": self.webdav.status()})
            elif path == "/api/video-links":
                store = VideoLinks(self.database)
                anime_id = int(query.get("anime_id", ["0"])[0])
                self.send_json({"features": {"optional_video_default": 1}, "scope": store.scope, "items": store.list(anime_id), "animes": [{"id": a["id"], "name": a["display_name"]} for a in self.database.list_anime()]})
            elif path == "/api/animes":
                category = int(query["category"][0]) if query.get("category") else None
                custom_collection_id = (
                    int(query["custom_collection_id"][0])
                    if query.get("custom_collection_id")
                    else None
                )
                settings = self.database.get_settings()
                hide_customized = self.parse_bool(
                    query.get(
                        "hide_customized",
                        [
                            str(
                                settings.get(
                                    "hide_custom_collection_items_from_builtin",
                                    True,
                                )
                            )
                        ],
                    )[0]
                )
                self.send_json(
                    {
                        "animes": self.database.list_anime(
                            category,
                            custom_collection_id=custom_collection_id,
                            hide_customized_from_builtin=hide_customized,
                        )
                    }
                )
            elif path == "/api/rankings":
                self.send_json({"boards": self.database.list_ranking_boards()})
            elif path == "/api/ranking-templates":
                self.send_json({"templates": self.database.list_ranking_templates()})
            elif path.startswith("/api/rankings/"):
                board = self.database.get_ranking_board(int(path.split("/")[3]))
                if board:
                    self.send_json({"board": board})
                else:
                    self.send_error_json(404, "排行榜不存在")
            elif path.endswith("/characters") and path.startswith("/api/animes/"):
                anime_id = int(path.split("/")[3])
                if self.database.get_anime(anime_id):
                    self.send_json({
                        "characters": self.database.list_anime_characters(anime_id),
                        "needs_order_refresh": self.database.anime_characters_need_order_refresh(anime_id),
                    })
                else:
                    self.send_error_json(404, "动画不存在")
            elif path.endswith("/episode-records") and path.startswith("/api/animes/"):
                anime_id = int(path.split("/")[3])
                if self.database.get_anime(anime_id):
                    self.send_json({"annotations": self.database.episode_record_annotations(anime_id)})
                else:
                    self.send_error_json(404, "动漫不存在")
            elif path.endswith("/comments") and path.startswith("/api/animes/"):
                anime_id = int(path.split("/")[3])
                self.send_json({"comments": self.database.list_anime_comments(anime_id)})
            elif path.startswith("/api/animes/"):
                anime_id = int(path.rsplit("/", 1)[1])
                anime = self.database.get_anime(anime_id)
                if anime:
                    self.send_json({"anime": anime})
                else:
                    self.send_error_json(404, "动漫不存在")
            elif path == "/api/timeline":
                if "limit" in query:
                    self.send_json(self.database.timeline_page(
                        search=query.get("q", [""])[0],
                        themes=query.get("theme", []),
                        offset=int(query.get("offset", ["0"])[0]),
                        limit=int(query["limit"][0]),
                    ))
                    return
                settings = self.database.get_settings()
                show_watch = self.parse_bool(
                    query.get(
                        "watch", [str(settings["show_watch_events"])]
                    )[0]
                )
                show_notes = self.parse_bool(
                    query.get(
                        "notes", [str(settings["show_note_events"])]
                    )[0]
                )
                show_comments = self.parse_bool(
                    query.get(
                        "comments", [str(settings["show_comment_events"])]
                    )[0]
                )
                search = query.get("q", [""])[0]
                self.send_json(
                    {
                        "days": self.database.timeline_days(
                            show_watch=show_watch,
                            show_notes=show_notes,
                            show_comments=show_comments,
                            search=search,
                        )
                    }
                )
            elif path == "/api/statistics":
                period = query.get("period", ["day"])[0]
                record_type = query.get("type", ["all"])[0]
                self.send_json(
                    {"series": self.database.statistics(period, record_type), "balance": self.database.episode_balance()}
                )
            elif path == "/api/status":
                self.send_json(
                    {
                        "sync": self.sync.status,
                        "stats": self.database.stats(),
                        "animes": self.database.list_anime(),
                        "custom_collections": self.database.list_custom_collections(),
                    }
                )
            elif path.startswith("/api/covers/"):
                anime_id = int(path.rsplit("/", 1)[1])
                cover = self.sync.cover(anime_id)
                if not cover:
                    self.send_response(HTTPStatus.NOT_FOUND)
                    self.end_headers()
                    return
                body, mime = cover
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "public, max-age=86400")
                self.end_headers()
                self.wfile.write(body)
            elif path.startswith("/api/character-covers/"):
                parts = path.strip("/").split("/")
                if len(parts) != 4:
                    self.send_error(HTTPStatus.NOT_FOUND)
                    return
                try:
                    anime_id, character_id = int(parts[2]), int(parts[3])
                except ValueError:
                    self.send_error(HTTPStatus.NOT_FOUND)
                    return
                cover = self.sync.character_cover(anime_id, character_id)
                if not cover:
                    self.send_error(HTTPStatus.NOT_FOUND)
                    return
                body, mime = cover
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "public, max-age=86400")
                self.end_headers()
                self.wfile.write(body)
            elif path.startswith("/api/record-images/"):
                filename = Path(path).name
                if filename != path.rsplit("/", 1)[-1] or not re.fullmatch(r"[A-Za-z0-9_-]+\.(?:png|jpg|webp)", filename):
                    self.send_error(HTTPStatus.NOT_FOUND)
                    return
                image_path = self.record_image_root / filename
                if not image_path.is_file():
                    self.send_error(HTTPStatus.NOT_FOUND)
                    return
                body = image_path.read_bytes()
                mime = mimetypes.guess_type(image_path.name)[0] or "application/octet-stream"
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "public, max-age=86400")
                self.end_headers()
                self.wfile.write(body)
            elif path.startswith("/api/"):
                self.send_error_json(404, "接口不存在")
            else:
                self.serve_static(path)
        except (ValueError, KeyError) as error:
            self.send_error_json(400, str(error))
        except Exception as error:
            self.send_error_json(500, str(error))

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        try:
            body = self.read_json()
            write_exempt_paths = {
                "/api/profiles",
                "/api/profiles/activate",
                "/api/sharing/configure",
                "/api/sharing/load",
                "/api/sharing/resident-profiles",
                "/api/sharing/auto-publish",
                "/api/sharing/device-request",
                "/api/sharing/import-device-request",
                "/api/sharing/approve-device",
                "/api/webdav/configure",
                "/api/webdav/test",
                "/api/webdav/sync",
            }
            if path not in write_exempt_paths:
                self.require_write_access()
            if path == "/api/video-links":
                self.send_json({"ok": True, "items": VideoLinks(self.database).update(body)})
            elif path == "/api/profiles":
                profile = self.profiles.create(
                    str(body.get("name") or ""),
                    str(body.get("kazumi_path") or ""),
                )
                self.send_json({"ok": True, "profile": profile, "profiles": self.profiles.list_profiles()}, 201)
            elif path == "/api/profiles/activate":
                profile = _desktop().activate_profile(str(body.get("profile_id") or ""))
                self.send_json({
                    "ok": True,
                    "profile": profile,
                    "profiles": self.profiles.list_profiles(),
                    "settings": self.database.get_settings(),
                    "animes": self.database.list_anime(),
                    "stats": self.database.stats(),
                })
            elif path == "/api/sharing/configure":
                self.send_json({"ok": True, "sharing": self.sharing.configure(str(body.get("shared_folder") or ""))})
            elif path == "/api/sharing/publish":
                profile_id = str(body.get("profile_id") or self.profiles.profile().get("id"))
                if profile_id != str(self.profiles.profile().get("id")):
                    raise ValueError("只能发布当前已打开的手账账号")
                self.send_json({"ok": True, "snapshot": self.sharing.publish(profile_id, self.database)})
            elif path == "/api/sharing/load":
                loaded = self.sharing.load(str(body.get("profile_id") or ""))
                self.send_json({"ok": True, **loaded, "profiles": self.profiles.list_profiles()})
            elif path == "/api/sharing/resident-profiles":
                self.send_json({"ok": True, "sharing": self.sharing.set_resident_profiles(body.get("profile_ids"))})
            elif path == "/api/sharing/auto-publish":
                self.send_json({"ok": True, "sharing": self.sharing.set_auto_publish(body.get("enabled"))})
            elif path == "/api/sharing/device-request":
                request = self.sharing.request_device(str(body.get("device_id") or ""), str(body.get("device_name") or ""))
                self.send_json({"ok": True, "request": request}, 201)
            elif path == "/api/sharing/import-device-request":
                request = self.sharing.import_device_request(body.get("request"))
                self.send_json({"ok": True, "request": request}, 201)
            elif path == "/api/sharing/approve-device":
                approval = self.sharing.approve_device(str(body.get("device_id") or ""))
                self.send_json({"ok": True, "approval": approval})
            elif path == "/api/webdav/configure":
                self.send_json({"ok": True, "webdav": self.webdav.configure(
                    url=body.get("url"), username=body.get("username"), password=body.get("password"),
                    account_id=body.get("account_id"), auto_sync=body.get("auto_sync"),
                )})
            elif path == "/api/webdav/test":
                self.send_json(self.webdav.test())
            elif path == "/api/webdav/sync":
                result = self.webdav.sync(self.database, resolution=str(body.get("resolution") or ""))
                self.send_json({**result, "webdav": self.webdav.status(), "settings": self.database.get_settings(), "animes": self.database.list_anime(), "custom_collections": self.database.list_custom_collections(), "ranking_boards": self.database.list_ranking_boards(), "ranking_templates": self.database.list_ranking_templates(), "stats": self.database.stats()})
            elif path == "/api/background":
                raw = str(body.get("data") or "")
                match = re.fullmatch(r"data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)", raw)
                if not match:
                    raise ValueError("请选择 PNG、JPG 或 WebP 图片")
                image = base64.b64decode(match.group(2), validate=True)
                if len(image) > 8 * 1024 * 1024:
                    raise ValueError("背景图片不能超过 8 MB")
                extension = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}[match.group(1)]
                # Some Windows/phone image pickers expose HEIC files with a .jpg
                # name and image/jpeg MIME type. Browsers cannot render those bytes,
                # so normalize them to a real JPEG before persisting the profile.
                image, normalized_extension = normalize_background_bytes(image)
                extension = normalized_extension or extension
                self.background_root.mkdir(parents=True, exist_ok=True)
                theme_id = safe_asset_id(body.get("profile_id"), "default")
                account_id = safe_asset_id(body.get("account_id"), str(self.profiles.profile().get("id") or "local"))
                stem = background_stem(account_id, theme_id)
                for old in self.background_root.glob(f"{stem}.*"):
                    old.unlink(missing_ok=True)
                (self.background_root / f"{stem}.{extension}").write_bytes(image)
                self.database.set_setting("custom_background_enabled", True)
                self.database.set_setting("custom_background_version", int(time.time() * 1000))
                self.send_json({"ok": True, "settings": self.database.get_settings()})
            elif path == "/api/record-images":
                raw = str(body.get("data") or "")
                match = re.fullmatch(
                    r"data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)", raw
                )
                if not match:
                    raise ValueError("请选择 PNG、JPG 或 WebP 图片")
                image = base64.b64decode(match.group(2), validate=True)
                if len(image) > 8 * 1024 * 1024:
                    raise ValueError("记录图片不能超过 8 MB")
                extension = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}[match.group(1)]
                image, normalized_extension = normalize_background_bytes(image)
                extension = normalized_extension or extension
                self.record_image_root.mkdir(parents=True, exist_ok=True)
                filename = f"record-{int(time.time() * 1000)}-{secrets.token_hex(5)}.{extension}"
                (self.record_image_root / filename).write_bytes(image)
                self.send_json({"ok": True, "url": f"/api/record-images/{filename}"}, 201)
            elif path == "/api/sync":
                started = self.sync.start_background(
                    enrich_all=bool(body.get("refresh_all", False))
                )
                self.send_json(
                    {
                        "ok": started,
                        "message": (
                            "同步已开始" if started else "同步正在进行"
                        ),
                    },
                    202 if started else 409,
                )
            elif path == "/api/custom-collections":
                collection = self.database.create_custom_collection(
                    str(body.get("name") or "")
                )
                self.send_json(
                    {
                        "ok": True,
                        "collection": collection,
                        "custom_collections": self.database.list_custom_collections(),
                        "stats": self.database.stats(),
                        "animes": self.database.list_anime(),
                    },
                    201,
                )
            elif path.startswith("/api/custom-collections/") and path.endswith(
                "/items"
            ):
                collection_id = int(path.split("/")[3])
                anime_id = int(body.get("anime_id") or 0)
                anime = self.database.add_to_custom_collection(collection_id, anime_id)
                self.send_json(
                    {
                        "ok": True,
                        "anime": anime,
                        "custom_collections": self.database.list_custom_collections(),
                        "stats": self.database.stats(),
                    }
                )
            elif path == "/api/notes":
                anime_id = body.get("anime_id")
                event_id = self.database.add_note(
                    str(body.get("content") or ""),
                    int(anime_id) if anime_id else None,
                    str(body.get("theme") or "other"),
                    themes=[str(item) for item in body.get("themes", [])]
                    if isinstance(body.get("themes"), list)
                    else None,
                    episode_keys=list(body.get("episode_keys") or []),
                    raw_directives=str(body.get("raw_directives") or ""),
                )
                self.send_json({"ok": True, "event_id": event_id}, 201)
            elif path.endswith("/rating") and path.startswith("/api/animes/"):
                anime_id = int(path.split("/")[3])
                rating = str(body.get("rating") or "").strip()
                if not rating:
                    deleted = self.database.clear_anime_rating(anime_id)
                    self.send_json({"ok": True, "deleted": deleted})
                else:
                    event_id = self.database.add_anime_rating(anime_id, rating)
                    self.send_json({"ok": True, "event_id": event_id}, 201)
            elif path == "/api/rankings":
                template_id = body.get("template_id")
                board = self.database.create_ranking_board(str(body.get("name") or ""), int(template_id) if template_id not in (None, "") else None)
                self.send_json({"ok": True, "board": board, "boards": self.database.list_ranking_boards()}, 201)
            elif path == "/api/ranking-templates":
                template = self.database.create_ranking_template(str(body.get("name") or ""), list(body.get("tiers") or []))
                self.send_json({"ok": True, "template": template, "templates": self.database.list_ranking_templates()}, 201)
            elif path.startswith("/api/rankings/"):
                parts = path.split("/")
                board_id = int(parts[3])
                if path.endswith("/tiers"):
                    board = self.database.add_ranking_tier(board_id, str(body.get("name") or ""))
                elif path.endswith("/import"):
                    board = self.database.import_ranking_items(board_id, list(body.get("anime_ids") or []))
                elif path.endswith("/move"):
                    placements = body.get("placements")
                    if not isinstance(placements, dict):
                        raise ValueError("排名位置格式错误")
                    board = self.database.save_ranking_placements(board_id, placements)
                else:
                    self.send_error_json(404, "接口不存在")
                    return
                self.send_json({"ok": True, "board": board, "boards": self.database.list_ranking_boards()})
            elif path == "/api/animes/custom-sort":
                anime_ids = body.get("anime_ids")
                if not isinstance(anime_ids, list):
                    raise ValueError("自定义排序格式错误")
                self.send_json(
                    {
                        "ok": True,
                        "animes": self.database.set_custom_sort_order(anime_ids),
                    }
                )
            elif path.endswith("/age-related") and path.startswith("/api/animes/"):
                anime_id = int(path.split("/")[3])
                self.send_json({"ok": True, "related": self.age.fetch_related(anime_id)})
            elif path.endswith("/characters") and path.startswith("/api/animes/"):
                if not self.database.get_settings().get("show_character_tab", True):
                    raise ValueError("请先在设置中开启人物分栏")
                anime_id = int(path.split("/")[3])
                self.send_json({"ok": True, "characters": self.sync.enrich_characters(anime_id)})
            elif path.endswith("/comments") and path.startswith("/api/animes/"):
                anime_id = int(path.split("/")[3])
                event_id = self.database.add_anime_comment(
                    anime_id,
                    str(body.get("content") or ""),
                    raw_directives=str(body.get("raw_directives") or ""),
                )
                self.send_json({"ok": True, "event_id": event_id}, 201)
            elif path.endswith("/episode-titles") and path.startswith("/api/animes/"):
                if not self.database.get_settings().get("show_episode_titles_on_hover"):
                    raise ValueError("请先在设置中开启单集名称悬浮提示")
                anime_id = int(path.split("/")[3])
                self.send_json(
                    {"ok": True, "anime": self.sync.enrich_episode_titles(anime_id)}
                )
            elif path.endswith("/progress") and path.startswith("/api/animes/"):
                anime_id = int(path.split("/")[3])
                episode_payload = body.get("episode_keys")
                if episode_payload is None:
                    episode_payload = body.get("episodes") or []
                result = self.database.set_progress(
                    anime_id, list(episode_payload or [])
                )
                self.send_json({"ok": True, **result})
            elif path.endswith("/episode-count") and path.startswith(
                "/api/animes/"
            ):
                anime_id = int(path.split("/")[3])
                anime = self.database.set_episode_count(
                    anime_id, int(body.get("episode_count") or 0)
                )
                self.send_json({"ok": True, "anime": anime})
            else:
                self.send_error_json(404, "接口不存在")
        except json.JSONDecodeError:
            self.send_error_json(400, "JSON 格式错误")
        except PermissionError as error:
            self.send_error_json(403, str(error))
        except (ValueError, KeyError) as error:
            self.send_error_json(400, str(error))
        except Exception as error:
            self.send_error_json(500, str(error))

    def do_PATCH(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        try:
            body = self.read_json()
            if not path.startswith("/api/profiles/"):
                self.require_write_access()
            if path.startswith("/api/profiles/"):
                profile_id = path.rsplit("/", 1)[1]
                if self.profiles.profile(profile_id).get("shared"):
                    raise PermissionError("好友共享账号只能查看，不能修改账号资料。")
                profile = self.profiles.update(
                    profile_id,
                    name=body["name"] if "name" in body else None,
                    kazumi_path=body["kazumi_path"] if "kazumi_path" in body else None,
                )
                self.send_json({"ok": True, "profile": profile, "profiles": self.profiles.list_profiles()})
            elif path.startswith("/api/events/"):
                event_id = int(path.rsplit("/", 1)[1])
                anime_id = body.get("anime_id")
                updated = self.database.update_event(
                    event_id,
                    content=str(body.get("content") or ""),
                    anime_id=int(anime_id) if anime_id else None,
                    theme=str(body.get("theme") or ""),
                    themes=[str(item) for item in body.get("themes", [])]
                    if isinstance(body.get("themes"), list)
                    else None,
                    rating=float(body["rating"]) if body.get("rating") not in (None, "") else None,
                    raw_directives=str(body.get("raw_directives") or ""),
                    episode_text=str(body.get("episodes") or ""),
                )
                self.send_json({"ok": updated}, 200 if updated else 404)
            elif path == "/api/settings":
                allowed = {
                    "keyboard_shortcuts",
                    "day_start_hour",
                    "show_episode_balance",
                    "episode_balance_initial",
                    "episode_balance_daily_target",
                    "statistics_default_theme",
                    "statistics_show_zero_periods",
                    "show_watch_events",
                    "show_note_events",
                    "show_comment_events",
                    "record_themes",
                    "show_bgm_rating",
                    "show_bgm_rating_in_collection",
                    "show_collection_rating_control",
                    "collection_rating_source",
                    "show_collection_progress_control",
                    "show_create_collection_control",
                    "show_age_related_button",
                    "show_bilibili_search_button",
                    "show_saved_video_list",
                    "merge_bilibili_links",
                    "show_episode_titles_on_hover",
                    "show_episode_review_record",
                    "show_oped_record",
                    "show_episode_rating_record",
                    "show_character_tab",
                    "bgm_sources",
                    "active_bgm_source",
                    "launch_at_login",
                    "show_ranking_hover_titles",
                    "ranking_hover_delay_seconds",
                    "show_all_collection_tab",
                    "builtin_collection_order",
                    "collection_home",
                    "collection_sort_modes",
                    "collection_sort_directions",
                    "new_record_defaults_to_other",
                    "top_sync_action",
                    "theme_color",
                    "custom_theme_color",
                    "custom_background_enabled",
                    "custom_background_overlay_opacity",
                    "active_theme_profile",
                    "theme_profiles",
                    "category_episode_visibility",
                    "category_rating_visibility",
                    "category_progress_visibility",
                    "builtin_category_visibility",
                    "hide_custom_collection_items_from_builtin",
                    "show_custom_move_button_without_collections",
                    "show_progress_bar",
                    "show_sidebar_toggle",
                    "show_shutdown_button",
                    "default_view",
                    "sidebar_visibility",
                    "sidebar_order",
                    "sidebar_labels",
                    "schedule_source",
                    "show_schedule_source_switch",
                    "schedule_sort",
                    "schedule_grouping",
                    "schedule_statuses",
                    "schedule_uncollected",
                    "schedule_card_fields",
                }
                balance_initial = (
                    int(body["episode_balance_initial"])
                    if "episode_balance_initial" in body
                    else None
                )
                balance_daily_target = (
                    min(100, max(0, int(body["episode_balance_daily_target"])))
                    if "episode_balance_daily_target" in body
                    else None
                )
                for key, value in body.items():
                    if key in allowed:
                        if key in {
                            "episode_balance_initial",
                            "episode_balance_daily_target",
                        }:
                            continue
                        if key == "schedule_grouping":
                            value = normalize_schedule_grouping(value)
                        elif key == "schedule_source":
                            if value not in {"yuc", "kazumi"}:
                                raise ValueError("周表来源无效")
                        elif key == "show_schedule_source_switch":
                            value = bool(value)
                        elif key == "schedule_sort":
                            if value not in {"time", "score", "popularity"}:
                                raise ValueError("周表排序无效")
                        elif key == "schedule_card_fields":
                            fields = {"tags", "votes", "release", "score", "collection", "airtime"}
                            if not isinstance(value, dict) or any(item not in fields or type(flag) is not bool for item, flag in value.items()):
                                raise ValueError("周表卡片显示设置无效")
                            value = {**self.database.get_settings().get(key, {}), **value}
                        elif key == "schedule_statuses":
                            if not isinstance(value, list) or any(type(item) is not int or item not in {1, 2, 3, 4, 5} for item in value):
                                raise ValueError("周表收藏状态无效")
                            value = list(dict.fromkeys(value))
                        elif key == "schedule_uncollected":
                            value = bool(value)
                        elif key == "day_start_hour":
                            value = min(23, max(0, int(value)))
                        elif key == "show_episode_balance":
                            value = bool(value)
                        elif key == "episode_balance_initial":
                            value = int(value)
                        elif key == "episode_balance_daily_target":
                            value = min(100, max(0, int(value)))
                        elif key == "keyboard_shortcuts":
                            value = normalize_shortcuts(value)
                        elif key == "statistics_default_theme":
                            value = str(value or "watch").strip() or "watch"
                        elif key in {
                            "category_episode_visibility",
                            "category_rating_visibility",
                            "category_progress_visibility",
                            "builtin_category_visibility",
                        }:
                            current = self.database.get_settings().get(key, {})
                            if not isinstance(current, dict):
                                current = {}
                            if not isinstance(value, dict):
                                raise ValueError("收藏夹可见设置格式错误")
                            current.update(
                                {
                                    str(item_key): bool(item_value)
                                    for item_key, item_value in value.items()
                                }
                            )
                            value = current
                        elif key == "hide_custom_collection_items_from_builtin":
                            value = bool(value)
                        elif key == "show_custom_move_button_without_collections":
                            value = bool(value)
                        elif key == "show_progress_bar":
                            value = bool(value)
                        elif key in {"show_sidebar_toggle", "show_shutdown_button", "statistics_show_zero_periods"}:
                            value = bool(value)
                        elif key == "new_record_defaults_to_other":
                            value = bool(value)
                        elif key == "show_bgm_rating":
                            value = bool(value)
                        elif key == "show_bgm_rating_in_collection":
                            value = bool(value)
                        elif key == "show_age_related_button":
                            value = bool(value)
                        elif key in {"show_bilibili_search_button", "show_saved_video_list", "merge_bilibili_links"}:
                            value = bool(value)
                        elif key == "show_episode_titles_on_hover":
                            value = bool(value)
                        elif key == "bgm_sources":
                            value = normalize_bgm_sources(value)
                        elif key == "active_bgm_source":
                            value = str(value or "").strip()
                        elif key in {
                            "show_episode_review_record",
                            "show_oped_record",
                            "show_episode_rating_record",
                            "show_character_tab",
                            "launch_at_login",
                        }:
                            value = bool(value)
                        elif key == "show_ranking_hover_titles":
                            value = bool(value)
                        elif key == "ranking_hover_delay_seconds":
                            value = min(10, max(0, int(value)))
                        elif key == "show_all_collection_tab":
                            value = bool(value)
                        elif key == "builtin_collection_order":
                            if not isinstance(value, list):
                                raise ValueError("收藏夹顺序格式错误")
                            ordered = [int(item) for item in value if int(item) in CATEGORY_NAMES]
                            value = ordered + [item for item in CATEGORY_NAMES if item not in ordered]
                        elif key == "collection_home":
                            value = str(value)
                            if value != "all" and not re.fullmatch(
                                r"(?:builtin|custom):\d+", value
                            ):
                                raise ValueError("收藏夹主页无效")
                        elif key == "collection_sort_modes":
                            if not isinstance(value, dict):
                                raise ValueError("收藏排序格式错误")
                            valid_modes = {
                                "name", "rank", "popularity", "airdate",
                                "kazumi", "custom",
                            }
                            value = {
                                str(k): str(v)
                                for k, v in value.items()
                                if str(v) in valid_modes
                            }
                        elif key == "collection_sort_directions":
                            if not isinstance(value, dict):
                                raise ValueError("收藏排序方向格式错误")
                            value = {
                                str(k): str(v)
                                for k, v in value.items()
                                if str(v) in {"asc", "desc"}
                            }
                        elif key == "theme_color":
                            if value not in {
                                "forest", "ocean", "violet", "amber", "rose",
                                "indigo", "teal", "slate", "custom",
                            }:
                                raise ValueError("主题颜色无效")
                        elif key == "custom_theme_color":
                            value = str(value).strip()
                            if not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
                                raise ValueError("自定义颜色应为 6 位 HEX 色值，例如 #2E6D4E")
                        elif key == "custom_background_enabled":
                            value = bool(value)
                        elif key == "custom_background_overlay_opacity":
                            value = min(100, max(0, int(value)))
                        elif key == "top_sync_action":
                            if value not in {"webdav", "kazumi"}:
                                raise ValueError("同步按钮功能无效")
                        elif key == "default_view":
                            if value not in {"collection", "schedule", "timeline", "statistics", "ranking"}:
                                raise ValueError("默认主页无效")
                        elif key == "record_themes":
                            if not isinstance(value, list):
                                raise ValueError("记录主题格式错误")
                            value = [
                                {"id": str(item.get("id") or ""), "name": str(item.get("name") or ""), "color": str(item.get("color") or "#7c8790"), "builtin": bool(item.get("builtin", False))}
                                for item in value
                                if isinstance(item, dict) and str(item.get("id") or "") and str(item.get("name") or "")
                            ]
                        elif key == "theme_profiles":
                            if not isinstance(value, list):
                                raise ValueError("主题方案格式错误")
                            value = [item for item in value if isinstance(item, dict) and item.get("id") and item.get("name")]
                        elif key == "active_theme_profile":
                            value = str(value or "default")
                        elif key == "collection_rating_source":
                            if value not in {"bgm", "personal"}:
                                raise ValueError("评分来源无效")
                        elif key == "sidebar_visibility":
                            if not isinstance(value, dict):
                                raise ValueError("侧边栏显示设置格式错误")
                            current = self.database.get_settings().get(key, {})
                            if not isinstance(current, dict):
                                current = {}
                            current.update(
                                {
                                    item: bool(value.get(item, True))
                                    for item in {"collection", "schedule", "timeline", "statistics", "ranking", "settings"}
                                    if item in value
                                }
                            )
                            current["settings"] = True
                            value = current
                        elif key == "sidebar_labels":
                            if not isinstance(value, dict):
                                raise ValueError("页面名称设置格式错误")
                            labels = {}
                            for page in ("collection", "schedule", "timeline", "statistics", "ranking"):
                                name = value.get(page, "")
                                if not isinstance(name, str) or len(name.strip()) > 20 or any(ord(c) < 32 for c in name):
                                    raise ValueError("页面名称需为不超过 20 个字符的文字")
                                if name.strip():
                                    labels[page] = name.strip()
                            value = labels
                        elif key == "sidebar_order":
                            if not isinstance(value, list):
                                raise ValueError("侧边栏顺序格式错误")
                            allowed_items = {"collection", "schedule", "timeline", "statistics", "ranking", "settings"}
                            ordered = [item for item in value if item in allowed_items]
                            value = ordered + [
                                item for item in ["collection", "schedule", "timeline", "statistics", "ranking", "settings"]
                                if item not in ordered
                            ]
                        self.database.set_setting(key, value)
                self.database.update_episode_balance_settings(
                    initial=balance_initial,
                    daily_target=balance_daily_target,
                )
                if "bgm_sources" in body or "active_bgm_source" in body:
                    settings = self.database.get_settings()
                    sources = normalize_bgm_sources(settings.get("bgm_sources"))
                    active_id = str(settings.get("active_bgm_source") or "")
                    active = next((item for item in sources if item["id"] == active_id), sources[0])
                    self.database.set_setting("active_bgm_source", active["id"])
                    self.database.set_setting("bgm_api_base", active["api_base"])
                    self.database.set_setting("bgm_site_base", active["site_base"])
                if "launch_at_login" in body:
                    settings = self.database.get_settings()
                    local_kazumi = SyncService.find_kazumi_database()
                    bound_kazumi = str(settings.get("bound_kazumi_path") or "")
                    # A profile receives its binding only once. In a future shared
                    # setup, another profile with a different binding can update its
                    # own preference without removing this machine's launcher.
                    if not bound_kazumi and local_kazumi:
                        bound_kazumi = str(local_kazumi)
                        self.database.set_setting("bound_kazumi_path", bound_kazumi)
                    matches_local = bool(
                        local_kazumi
                        and bound_kazumi
                        and os.path.normcase(os.path.abspath(str(local_kazumi)))
                        == os.path.normcase(os.path.abspath(bound_kazumi))
                    )
                    if matches_local:
                        active = configure_windows_autostart(
                            bool(settings.get("launch_at_login"))
                        )
                        self.database.set_setting("autostart_active", active)
                    else:
                        # Never alter the computer's launcher for a profile bound to
                        # another Kazumi database.
                        self.database.set_setting("autostart_active", False)
                self.send_json(
                    {
                        "ok": True,
                        "settings": self.database.get_settings(),
                        "stats": self.database.stats(),
                        "animes": self.database.list_anime(),
                        "custom_collections": self.database.list_custom_collections(),
                    }
                )
            elif path.startswith("/api/rankings/"):
                parts = path.split("/")
                board_id = int(parts[3])
                if len(parts) >= 6 and parts[4] == "tiers":
                    board = self.database.rename_ranking_tier(board_id, int(parts[5]), str(body.get("name") or ""))
                else:
                    board = self.database.update_ranking_board(board_id, str(body.get("name") or ""))
                self.send_json({"ok": True, "board": board, "boards": self.database.list_ranking_boards()})
            elif path.startswith("/api/custom-collections/"):
                collection_id = int(path.rsplit("/", 1)[1])
                collection = self.database.rename_custom_collection(
                    collection_id,
                    str(body.get("name") or ""),
                )
                self.send_json(
                    {
                        "ok": True,
                        "collection": collection,
                        "custom_collections": self.database.list_custom_collections(),
                    }
                )
            elif path.startswith("/api/categories/"):
                category = int(path.rsplit("/", 1)[1])
                if category not in CATEGORY_NAMES:
                    raise ValueError("收藏分类不存在")
                settings = self.database.get_settings()
                visibility = settings["category_episode_visibility"]
                visibility[str(category)] = bool(
                    body.get("show_episode_count", True)
                )
                self.database.set_setting(
                    "category_episode_visibility", visibility
                )
                self.send_json({"ok": True, "visibility": visibility})
            else:
                self.send_error_json(404, "接口不存在")
        except PermissionError as error:
            self.send_error_json(403, str(error))
        except (ValueError, KeyError) as error:
            self.send_error_json(400, str(error))
        except Exception as error:
            self.send_error_json(500, str(error))

    def do_DELETE_profile_legacy(self) -> None:
        path = urlparse(self.path).path
        try:
            if not path.startswith("/api/profiles/"):
                self.send_error_json(404, "接口不存在")
                return
            profile_id = unquote(path.rsplit("/", 1)[1])
            deleted = self.profiles.delete(profile_id)
            sharing = self.sharing.forget_profile(str(deleted.get("sharing_id") or ""))
            self.send_json(
                {
                    "ok": True,
                    "deleted_profile": deleted,
                    "profiles": self.profiles.list_profiles(),
                    "sharing": sharing,
                }
            )
        except (ValueError, KeyError) as error:
            self.send_error_json(400, str(error))
        except Exception as error:
            self.send_error_json(500, str(error))

    def do_DELETE(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        try:
            if path.startswith("/api/profiles/"):
                profile_id = unquote(path.rsplit("/", 1)[1])
                deleted = self.profiles.delete(profile_id)
                sharing = self.sharing.forget_profile(str(deleted.get("sharing_id") or ""))
                self.send_json({"ok": True, "deleted_profile": deleted, "profiles": self.profiles.list_profiles(), "sharing": sharing})
                return

            self.require_write_access()
            if path == "/api/background":
                theme_id = safe_asset_id(query.get("profile", [""])[0], "default")
                account_id = safe_asset_id(query.get("account", [""])[0], str(self.profiles.profile().get("id") or "local"))
                for image in self.background_root.glob(f"{background_stem(account_id, theme_id)}.*"):
                    image.unlink(missing_ok=True)
                self.database.set_setting("custom_background_enabled", False)
                self.send_json({"ok": True, "settings": self.database.get_settings()})
            elif path.startswith("/api/events/"):
                event_id = int(path.rsplit("/", 1)[1])
                deleted = self.database.delete_event(event_id)
                self.send_json({"ok": deleted}, 200 if deleted else 404)
            elif path.startswith("/api/custom-collections/") and "/items/" in path:
                parts = path.split("/")
                collection_id = int(parts[3])
                anime_id = int(parts[5])
                anime = self.database.remove_from_custom_collection(
                    collection_id, anime_id
                )
                self.send_json(
                    {
                        "ok": True,
                        "anime": anime,
                        "custom_collections": self.database.list_custom_collections(),
                        "stats": self.database.stats(),
                    }
                )
            elif path.startswith("/api/custom-collections/"):
                collection_id = int(path.rsplit("/", 1)[1])
                deleted = self.database.delete_custom_collection(collection_id)
                self.send_json(
                    {
                        "ok": deleted,
                        "custom_collections": self.database.list_custom_collections(),
                        "stats": self.database.stats(),
                        "animes": self.database.list_anime(),
                    },
                    200 if deleted else 404,
                )
            elif path.startswith("/api/ranking-templates/"):
                template_id = int(path.rsplit("/", 1)[1])
                deleted = self.database.delete_ranking_template(template_id)
                self.send_json({"ok": deleted, "templates": self.database.list_ranking_templates()}, 200 if deleted else 404)
            elif path.startswith("/api/rankings/"):
                parts = path.split("/")
                board_id = int(parts[3])
                if len(parts) == 6 and parts[4] == "items":
                    deleted = self.database.delete_unranked_ranking_item(board_id, int(parts[5]))
                    self.send_json({"ok": deleted, "board": self.database.get_ranking_board(board_id), "boards": self.database.list_ranking_boards()}, 200 if deleted else 404)
                    return
                deleted = self.database.delete_ranking_board(board_id)
                self.send_json(
                    {"ok": deleted, "boards": self.database.list_ranking_boards()},
                    200 if deleted else 404,
                )
            else:
                self.send_error_json(404, "接口不存在")
        except PermissionError as error:
            self.send_error_json(403, str(error))
        except (ValueError, KeyError) as error:
            self.send_error_json(400, str(error))
        except Exception as error:
            self.send_error_json(500, str(error))

    @staticmethod
    def parse_bool(value: str) -> bool:
        return value.lower() in {"1", "true", "yes", "on"}

    def serve_static(self, request_path: str) -> None:
        relative = request_path.lstrip("/") or "index.html"
        requested = (STATIC_ROOT / relative).resolve()
        try:
            requested.relative_to(STATIC_ROOT.resolve())
        except ValueError:
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        if not requested.is_file():
            requested = STATIC_ROOT / "index.html"
        body = requested.read_bytes()
        if requested.name == "index.html":
            body = with_initial_appearance(body.decode("utf-8"), self.database.get_settings(),
                                           str(self.profiles.profile()["id"])).encode("utf-8")
        mime = mimetypes.guess_type(requested.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", f"{mime}; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header(
            "Cache-Control",
            "private, no-store" if requested.suffix == ".html" else "no-cache" if requested.suffix in {".js", ".css"} else "public, max-age=3600",
        )
        self.end_headers()
        self.wfile.write(body)


