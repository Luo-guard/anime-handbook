
"""Authenticated HTTP adapter around the shared business routes."""
from __future__ import annotations
from handbook import http

import json
import logging
import re
import secrets
import socket
import threading
import urllib.error
from http.cookies import SimpleCookie
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .auth import Accounts
from .runtime import Runtime, core
from .uploads import CHUNK_SIZE, receive_original

ASSETS = Path(__file__).parent / "static"
LOG = logging.getLogger("animehandbook.online")
READ_ROUTES = re.compile(r"/api/(?:video-links|animes(?:/[1-9]\d*(?:/(?:characters|episode-records|comments))?)?|timeline|statistics|status|schedule(?:/cover)?|covers/[1-9]\d*|character-covers/[1-9]\d*/[1-9]\d*|record-images/[\w-]+\.(?:jpg|png|webp)|background|rankings(?:/[1-9]\d*)?|ranking-templates)\Z")
WRITE_ROUTES = {
    "POST": re.compile(r"/api/(?:video-links|notes|custom-collections(?:/[1-9]\d*/items)?|rankings(?:/[1-9]\d*/(?:tiers|import|move))?|ranking-templates|animes/custom-sort|animes/[1-9]\d*/(?:rating|comments|characters|episode-titles|progress|episode-count))\Z"),
    "PATCH": re.compile(r"/api/(?:settings|events/[1-9]\d*|custom-collections/[1-9]\d*|categories/[1-5]|rankings/[1-9]\d*(?:/tiers/[1-9]\d*)?)\Z"),
    "DELETE": re.compile(r"/api/(?:events/[1-9]\d*|custom-collections/[1-9]\d*(?:/items/[1-9]\d*)?|ranking-templates/[1-9]\d*|rankings/[1-9]\d*(?:/items/[1-9]\d*)?)\Z"),
}
FORBIDDEN_SETTINGS = {"launch_at_login", "bgm_sources", "active_bgm_source", "bgm_api_base", "bgm_site_base", "bound_kazumi_path", "top_sync_action"}


class OnlineServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 32

    def __init__(self, address, root, origin, development=False):
        if address[0] not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("后端仅监听本机回环地址；公网访问请使用 HTTPS 反向代理")
        self.origin = origin.rstrip("/")
        parsed = urlparse(self.origin)
        if parsed.scheme not in ({"http", "https"} if development else {"https"}) or not parsed.netloc or parsed.path or parsed.username:
            raise ValueError("请配置完整 HTTPS 站点地址；本地测试才可启用 development")
        self.host_header = parsed.netloc.lower()
        self.development = development
        self.runtime = Runtime(root)
        self.accounts = Accounts(root)
        from .demo import prepare_demo
        prepare_demo(self.runtime, self.accounts.demo_user())
        self.slots = threading.BoundedSemaphore(16)
        self.upload_slot = threading.BoundedSemaphore(1)
        super().__init__(address, Handler)

    def process_request(self, request, client_address):
        self.slots.acquire()
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            request.settimeout(30)
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


class Handler(http.RequestHandler):
    server_version = "AnimeHandbookOnline/1.0"
    sys_version = ""

    def log_message(self, format_string, *args):
        # Never log session tokens, request bodies, user content, or query strings.
        pass

    def send_error_json(self, status, message):
        if status >= 500:
            message = "服务器暂时无法处理请求，请稍后重试"
        super().send_error_json(status, message)

    def require_write_access(self):
        if not getattr(self, "user", None):
            raise PermissionError("请先登录")
        if self.user.get("role") == "guest":
            raise PermissionError("游客体验为只读，请注册自己的手账后记录")

    @property
    def schedule(self):
        return self.server.runtime.schedule

    def send_header(self, keyword, value):
        if keyword.lower() == "cache-control" and urlparse(self.path).path.startswith("/api/"):
            value = "private, no-store"
        super().send_header(keyword, value)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        if hasattr(self, "services"):
            self.send_header("X-Handbook-Revision", str(self.services.revision()))
        super().end_headers()

    def read_json(self):
        if hasattr(self, "parsed_body"):
            return self.parsed_body
        if self.headers.get("Transfer-Encoding"):
            raise ValueError("不支持分块请求")
        if self.headers.get_content_type() != "application/json":
            raise ValueError("请求必须使用 application/json")
        value = super().read_json()
        if not isinstance(value, dict):
            raise ValueError("请求内容需为 JSON 对象")
        return value

    def file_response(self, data, mime):
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def image_file_response(self, path):
        if not path or not path.is_file():
            return self.send_error_json(404, "图片不存在")
        with path.open("rb") as source:
            self.send_response(200)
            mime = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}.get(path.suffix.lower(), "application/octet-stream")
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(source.seek(0, 2)))
            source.seek(0)
            self.send_header("Cache-Control", "private, no-store")
            self.end_headers()
            while block := source.read(CHUNK_SIZE):
                self.wfile.write(block)

    def serve_static(self, request_path):
        if request_path in {"/online.js", "/online.css", "/login.js"}:
            p = ASSETS / request_path[1:]
            return self.file_response(p.read_bytes(), "text/javascript; charset=utf-8" if p.suffix == ".js" else "text/css; charset=utf-8")
        if request_path == "/login":
            return self.file_response((ASSETS / "login.html").read_bytes(), "text/html; charset=utf-8")
        if request_path in {"/", "/index.html"}:
            html = core.with_initial_appearance((core.STATIC_ROOT / "index.html").read_text("utf-8"),
                                                self.database.get_settings(), str(self.profiles.profile()["id"]))
            html = html.replace("<body>", '<body class="online-mode">')
            html = html.replace("</head>", '<link rel="stylesheet" href="/online.css" /></head>')
            html = html.replace('    <script src="/schedule.js', '    <script src="/online.js" defer></script>\n    <script src="/schedule.js')
            return self.file_response(html.encode(), "text/html; charset=utf-8")
        module_paths = {"/modules/" + path.name for path in core.STATIC_ROOT.joinpath("modules").glob("*.js")}
        if request_path not in {"/app.js", "/schedule.js", "/styles.css", "/appearance.js"} | module_paths:
            return self.send_error_json(404, "页面不存在")
        super().serve_static(request_path)

    def token(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except Exception:
            return ""
        return cookie["handbook_session"].value if "handbook_session" in cookie else ""

    def set_session(self, token, age=604800):
        self.send_header("Set-Cookie", f"handbook_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={age}" + ("" if self.server.development else "; Secure"))

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PATCH(self):
        self.dispatch("PATCH")

    def do_DELETE(self):
        self.dispatch("DELETE")

    def dispatch(self, method):
        try:
            if self.headers.get("Host", "").lower() != self.server.host_header:
                return self.send_error_json(400, "站点地址不匹配")
            path = urlparse(self.path).path
            write = method != "GET"
            if write and self.headers.get("Origin") != self.server.origin:
                return self.send_error_json(403, "请求来源不匹配")
            if path == "/api/health" and not write:
                return self.send_json({"ok": True, "mode": "online", "features": {"schedule_sorting": 2, "keyboard_shortcuts": 1}})
            if path in {"/api/auth/login", "/api/auth/register", "/api/auth/guest"} and method == "POST":
                body = self.read_json()
                if path.endswith("/guest"):
                    token, user = self.server.accounts.guest(self.client_address[0])
                elif path.endswith("/register"):
                    if body.get("password") != body.get("confirm_password"):
                        raise ValueError("两次输入的密码不一致")
                    token, user = self.server.accounts.register(str(body.get("username", "")), str(body.get("password", "")), str(body.get("invitation", "")), self.client_address[0])
                else:
                    token, user = self.server.accounts.login(str(body.get("username", "")), str(body.get("password", "")), self.client_address[0])
                self.send_response(200)
                self.set_session(token, 3600 if user.get("role") == "guest" else 604800)
                data = json.dumps({"ok": True, "csrf": user["csrf"], "read_only": user.get("role") == "guest"}).encode()
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return self.wfile.write(data)
            self.user = self.server.accounts.session(self.token())
            if not self.user:
                if path in {"/login", "/login.js", "/online.css"} and not write:
                    return self.serve_static(path)
                if not path.startswith("/api/") and not write:
                    self.send_response(303)
                    self.send_header("Location", "/login")
                    self.send_header("Content-Length", "0")
                    return self.end_headers()
                return self.send_error_json(401, "请先登录")
            if write and not secrets.compare_digest(self.headers.get("X-CSRF-Token", ""), self.user["csrf"]):
                return self.send_error_json(403, "登录校验失效，请刷新页面")
            if path == "/api/auth/me" and not write:
                return self.send_json({"username": "游客体验" if self.user["role"] == "guest" else self.user["username"], "csrf": self.user["csrf"], "read_only": self.user["role"] == "guest"})
            if path == "/api/auth/logout" and method == "POST":
                self.server.accounts.logout(self.token())
                self.send_response(204)
                self.set_session("", 0)
                return self.end_headers()
            # Central deny precedes route selection, body parsing and revisions.
            # Future business write endpoints inherit the same read-only policy.
            if write and self.user["role"] == "guest":
                return self.send_error_json(403, "游客体验为只读，请注册自己的手账后记录")
            self.services = self.server.runtime.services(self.user)
            with self.services.lock:
                if path == "/api/bootstrap" and not write:
                    return self.send_json(self.services.bootstrap(self.user))
                if path == "/api/changes" and not write:
                    return self.send_json({"revision": self.services.revision()})
                if not write:
                    if not path.startswith("/api/"):
                        return self.serve_static(path)
                    if not READ_ROUTES.fullmatch(path):
                        return self.send_error_json(404, "线上版不提供此接口")
                    if path.startswith("/api/record-images/"):
                        return self.image_file_response(self.record_image_root / path.rsplit("/", 1)[1])
                    if path == "/api/background":
                        query = parse_qs(urlparse(self.path).query)
                        # Account ownership is derived from the session, never a query.
                        if query.get("account", [self.user["id"]])[0] != self.user["id"]:
                            return self.send_error_json(404, "图片不存在")
                        theme = core.safe_asset_id(query.get("profile", ["default"])[0], "default")
                        return self.image_file_response(core.find_background_asset(self.user["id"], theme, root=self.background_root))
                    return super().do_GET()
                custom_route = method == "POST" and path in {"/api/subjects", "/api/record-images", "/api/background"}
                category_route = method == "PATCH" and re.fullmatch(r"/api/subjects/[1-9]\d*", path)
                if not custom_route and not category_route and not WRITE_ROUTES[method].fullmatch(path):
                    return self.send_error_json(404, "线上版不提供此接口")
                if method == "POST" and path in {"/api/record-images", "/api/background"}:
                    if self.headers.get("If-Match") != str(self.services.revision()):
                        return self.send_json({"ok": False, "message": "另一端已更新数据，请刷新后重新上传。", "revision": self.services.revision()}, 409)
                    return self.upload_image(path)
                self.parsed_body = self.read_json()
                progress_route = method == "POST" and re.fullmatch(r"/api/animes/[1-9]\d*/progress", path) and isinstance(self.parsed_body.get("base_episode_keys"), list)
                current_version = self.headers.get("If-Match") == str(self.services.revision())
                # A stale additive progress command is safe to merge. Removals and
                # all other stale edits require review instead of overwriting data.
                safe_addition = bool(progress_route and self.headers.get("If-Match", "").isdigit()
                    and int(self.headers["If-Match"]) <= self.services.revision()
                    and isinstance(self.parsed_body.get("episode_keys"), list)
                    and set(self.parsed_body["base_episode_keys"]) <= set(self.parsed_body["episode_keys"]))
                if not current_version and not safe_addition:
                    return self.send_json({"ok": False, "message": "另一端已更新数据，请刷新后重新保存；当前输入仍保留。", "revision": self.services.revision()}, 409)
                if path == "/api/settings":
                    self.parsed_body = {k: v for k, v in self.parsed_body.items() if k not in FORBIDDEN_SETTINGS}
                # Advance before invoking shared routes, including partially rejected writes.
                # This also makes interrupted/retried requests fail closed against stale state.
                self.services.changed()
                if progress_route:
                    result = self.services.record_progress(int(path.split("/")[3]), self.parsed_body)
                    return self.send_json({"ok": True, "refresh_required": not current_version, **result})
                if path == "/api/subjects":
                    category = int(self.parsed_body.get("category", 2))
                    subject_id = int(self.parsed_body.get("id", 0))
                    if category not in range(1, 6) or not 0 < subject_id < 10**9:
                        raise ValueError("番剧 ID 或收藏状态无效")
                    anime = self.services.add_subject(subject_id, category)
                    return self.send_json({"ok": True, "anime": anime}, 201)
                if category_route:
                    category = int(self.parsed_body.get("category", 0))
                    if category not in range(0, 6):
                        raise ValueError("收藏状态无效")
                    subject_id = int(path.rsplit("/", 1)[1])
                    if not self.database.get_anime(subject_id):
                        return self.send_error_json(404, "番剧不存在")
                    with self.database.connect() as db:
                        db.execute("UPDATE anime SET collection_type=?,active=?,updated_at=? WHERE id=?", (category or 2, int(category != 0), core.now_iso(), subject_id))
                    return self.send_json({"ok": True})
                return getattr(super(), "do_" + method)()
        except PermissionError as error:
            self.send_error_json(429, str(error))
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
            self.send_error_json(400, str(error)[:200])
        except (BrokenPipeError, ConnectionResetError, socket.timeout):
            pass
        except urllib.error.URLError:
            self.send_error_json(502, "资料来源暂不可用，请稍后重试")
        except Exception:
            LOG.exception("Online request failed: %s", method)
            self.send_error_json(500, "服务器暂时无法处理请求")

    def upload_image(self, path):
        if self.headers.get("Transfer-Encoding") or not self.headers.get("Content-Length", "").isdigit():
            raise ValueError("上传需提供完整文件长度")
        if self.headers.get_content_type() not in {"image/jpeg", "image/png", "image/webp", "application/octet-stream"}:
            raise ValueError("请刷新页面后使用原图上传")
        root = self.background_root if path == "/api/background" else self.record_image_root
        if not self.server.upload_slot.acquire(timeout=20):
            return self.send_error_json(503, "上传队列繁忙，请稍后重试")
        temporary = None
        try:
            temporary, extension, _ = receive_original(self.rfile, int(self.headers["Content-Length"]), root)
            if path == "/api/background":
                query = parse_qs(urlparse(self.path).query)
                theme = core.safe_asset_id(query.get("profile_id", ["default"])[0], "default")
                stem = core.background_stem(self.user["id"], theme)
                filename = stem + "." + extension
            else:
                filename = "record-" + secrets.token_hex(16) + "." + extension
            temporary.replace(root / filename)
            if path == "/api/background":
                for old in root.glob(stem + ".*"):
                    if old.name != filename:
                        old.unlink()
            self.services.changed()
        finally:
            if temporary:
                temporary.unlink(missing_ok=True)
            self.server.upload_slot.release()
        if path == "/api/background":
            self.database.set_setting("custom_background_enabled", True)
            self.database.set_setting("custom_background_version", secrets.token_hex(8))
            return self.send_json({"ok": True, "settings": self.database.get_settings()})
        self.send_json({"ok": True, "url": "/api/record-images/" + filename}, 201)
