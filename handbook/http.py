from __future__ import annotations
from .http_read import ReadRoutes
from .http_post import PostRoutes
from .http_patch import PatchRoutes
from .http_delete import DeleteRoutes
from .http_support import read_object, send_asset
from .observability import LOG, record_failure
from typing import Any
from http.server import BaseHTTPRequestHandler
from http import HTTPStatus
from schedule import ScheduleService
import mimetypes
import os
import threading
from datetime import date, datetime, timedelta
import secrets
import urllib.error
from urllib.parse import urlparse
from .common import BACKGROUND_ROOT, DATA_ROOT, RECORD_IMAGE_ROOT, STATIC_ROOT, json_dumps, with_initial_appearance
from .assets import prune_record_images, profile_asset_references
from .airing import BEIJING, compute_airing
from .animeschedule import AnimeScheduleService, title_key
from .as_calendar import ASCalendar
from .xifan_preview import PREFIX as XIFAN_PREVIEW_PREFIX
from .playback_rules import PREFIX as PLAYBACK_PREFIX


SCHEDULE = ScheduleService(DATA_ROOT / "schedule")
AS_SERVICES = {}
AS_SERVICES_LOCK = threading.Lock()


def _desktop():
    from . import desktop
    return desktop


class RequestHandler(ReadRoutes, PostRoutes, PatchRoutes, DeleteRoutes, BaseHTTPRequestHandler):
    server_version = "AnimeHandbook/1.0"

    @staticmethod
    def _with_airing(animes: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Attach schedule-based progress to collection items (meaning A).

        Uses only the local season caches; no external requests. Items without a
        cached clock fall back to date precision, and only for recent premieres
        so a 500-item collection stays cheap.
        """
        index = SCHEDULE.airtime_index()
        now = datetime.now(BEIJING)
        cutoff = now.date() - timedelta(days=200)
        for anime in animes:
            try:
                anime_id = int(anime.get("id") or 0)
            except (TypeError, ValueError):
                continue
            slot = index.get(anime_id)
            if slot is None:
                try:
                    premiere = date.fromisoformat(str(anime.get("air_date") or "")[:10])
                except ValueError:
                    continue
                if premiere < cutoff:
                    continue
                slot = {}
            # 季表里的放送钟点（bj_time 已换算成北京时间）直接带给前端，
            # 详情头部的更新徽标要显示「每周五 11:20 更新」。以前只有
            # compute_airing 在星期匹配时才会产出 next_at，遇到 Bangumi 日期
            # 与季表星期不一致就降级成「只有日期」，钟点白白丢掉。
            clock = str(slot.get("bj_time") or "").strip()
            if clock:
                anime["air_time"] = {
                    "time": clock,
                    "source_time": str(slot.get("source_time") or ""),
                }
            result = compute_airing(anime, slot, now)
            if result:
                anime["airing"] = result
        return animes

    @property
    def schedule(self):
        return SCHEDULE

    @property
    def animeschedule(self):
        runtime = getattr(self.server, "runtime", None)
        root = (runtime.root / "cache" if runtime else DATA_ROOT) / "animeschedule"
        with AS_SERVICES_LOCK:
            if root not in AS_SERVICES:
                AS_SERVICES[root] = AnimeScheduleService(root)
            return AS_SERVICES[root]

    def _with_progress(self, animes):
        self._with_airing(animes)
        settings = self.database.get_settings()
        if any(settings.get(key) == "as" for key in (
            "collection_airing_source", "schedule_airing_source", "detail_airtime_source",
        )):
            titles = {row["id"]: {
                key for field in ("name", "name_cn", "display_name")
                if (key := title_key(row.get(field)))
            } for row in animes}
            progress = self.animeschedule.get_many(titles, titles=titles)
            for row in animes:
                row["as_airing"] = progress.get(str(row["id"]))
        return animes

    @property
    def as_calendar(self):
        service = self.animeschedule
        with service.lock:
            if not hasattr(service, "calendar"):
                service.calendar = ASCalendar(service)
            return service.calendar

    def require_write_access(self) -> None:
        _desktop().require_active_profile_write_access()

    def sweep_record_images_later(self) -> None:
        """Collect unreferenced record images after the response is written.

        The caller already holds the desktop write gate, so walking the image
        directory there would make every other save wait behind it.
        """
        database, root = self.database, self.record_image_root

        def sweep() -> None:
            try:
                references = set()
                if not hasattr(self, "services"):
                    profiles = _desktop().PROFILES
                    paths = {p["id"]: profiles.database_path(p["id"]) for p in profiles.list_profiles()}
                    references, _ = profile_asset_references(paths)
                prune_record_images(database, root=root, referenced_images=references)
            except Exception as error:
                record_failure("record_image_sweep", error)

        threading.Thread(target=sweep, name="handbook-image-sweep", daemon=True).start()

    @property
    def database(self):
        if hasattr(self, "services"):
            return getattr(self.services, "database")
        snapshot = getattr(self, "_profile_snapshot", None)
        return snapshot["database"] if snapshot else _desktop().DATABASE

    @property
    def sync(self):
        if hasattr(self, "services"):
            return getattr(self.services, "sync")
        snapshot = getattr(self, "_profile_snapshot", None)
        return snapshot["sync"] if snapshot else _desktop().SYNC

    @property
    def age(self):
        if hasattr(self, "services"):
            return getattr(self.services, "age")
        snapshot = getattr(self, "_profile_snapshot", None)
        return snapshot["age"] if snapshot else _desktop().AGE

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

    def read_json(self, max_bytes: int | None = None) -> dict[str, Any]:
        return read_object(self, max_bytes)

    def unexpected_error(self, error):
        if isinstance(error, ConnectionError):
            LOG.info("response_disconnected")
            return
        request_id = secrets.token_hex(6)
        record_failure(f"{self.command} {urlparse(self.path).path}", error, request_id)
        status = 504 if isinstance(error, TimeoutError) else 502 if isinstance(error, urllib.error.URLError) else 500
        self.send_error_json(status, f"后台暂时无法处理请求，请稍后重试（编号 {request_id}）")

    def setup(self):
        self.request.settimeout(30)
        super().setup()

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (ConnectionError, TimeoutError):
            LOG.info("request_disconnected_or_timed_out")
        finally:
            lease = getattr(self, "_profile_lease", None)
            if lease:
                self._profile_lease = None
                lease.__exit__(None, None, None)
            self._profile_snapshot = None

    def parse_request(self):
        if not super().parse_request(): return False
        if not hasattr(self.server, "runtime"):
            path = urlparse(self.path).path
            if ((self.command == "GET" and path.startswith((PLAYBACK_PREFIX, XIFAN_PREVIEW_PREFIX)))
                    or (self.command == "POST" and path == PLAYBACK_PREFIX + "rules")):
                return True  # Desktop playback does not access account data.
            desktop = _desktop()
            switching = self.command == "POST" and path == "/api/profiles/activate"
            self._profile_lease = desktop.PROFILE_GATE.write() if switching else desktop.PROFILE_GATE.read()
            self._profile_lease.__enter__()
            self._profile_snapshot = desktop.service_snapshot()
        return True

    def send_error_json(self, status: int, message: str) -> None:
        self.send_json({"ok": False, "message": message}, status)


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
        # WebAssembly 实例化要求 Content-Type 的 essence 精确为 application/wasm，
        # 带上 charset 会被部分浏览器拒绝；字体同理走二进制，不加字符集。
        binary_mime = {
            ".wasm": "application/wasm",
            ".woff2": "font/woff2",
            ".woff": "font/woff",
            ".ttf": "font/ttf",
            ".otf": "font/otf",
        }
        suffix = requested.suffix.lower()
        mime = binary_mime.get(suffix) or mimetypes.guess_type(requested.name)[0] or "application/octet-stream"
        content_type = mime if suffix in binary_mime else f"{mime}; charset=utf-8"
        cache = "private, no-store" if suffix == ".html" else "public, no-cache"
        send_asset(self, body, content_type, cache=cache, compress=suffix in {".js", ".css", ".html", ".svg"})

