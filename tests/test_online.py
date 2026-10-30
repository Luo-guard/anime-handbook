from __future__ import annotations
from handbook import database, webdav


import base64
import hashlib
import http.client
import io
import json
import sqlite3
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from server.http import OnlineServer
from server.manage import import_local
from server.runtime import core, image_url_allowed


class OnlineTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "online"
        self.server = OnlineServer(("127.0.0.1", 0), self.root, "http://127.0.0.1", True)
        self.port = self.server.server_address[1]
        self.origin = f"http://127.0.0.1:{self.port}"
        self.server.origin = self.origin
        self.server.host_header = f"127.0.0.1:{self.port}"
        for user in ("alice", "bobby"):
            self.server.accounts.create(user, "test-password-2026")
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .02}, daemon=True)
        self.thread.start()
        self.alice = self.login("alice")
        self.bobby = self.login("bobby")

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def call(self, method, path, body=None, client=None, headers=None):
        request_headers = {"Content-Type": "application/json", "Origin": self.origin}
        if client:
            request_headers.update({"Cookie": client["cookie"], "X-CSRF-Token": client["csrf"], "If-Match": str(client.get("revision", 0))})
        request_headers.update(headers or {})
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request(method, path, body=body if isinstance(body, bytes) else json.dumps(body).encode() if body is not None else None, headers=request_headers)
        response = conn.getresponse()
        raw = response.read()
        result = json.loads(raw) if response.getheader("Content-Type", "").startswith("application/json") and raw else raw
        response_headers = dict(response.getheaders())
        if client and "X-Handbook-Revision" in response_headers and response.status != 409:
            client["revision"] = int(response_headers["X-Handbook-Revision"])
        status = response.status
        conn.close()
        return status, result, response_headers

    def test_html_initial_appearance_is_private_and_account_scoped(self):
        self.services("alice").database.set_setting("theme_color", "slate")
        self.services("bobby").database.set_setting("theme_color", "custom")
        self.services("bobby").database.set_setting("custom_theme_color", "#123456")
        for client, theme in [(self.alice, "slate"), (self.bobby, "custom")]:
            status, raw, headers = self.call("GET", "/", client=client)
            self.assertEqual(status, 200)
            html = raw.decode()
            start = html.index('<script id="initialAppearance" type="application/json">') + len('<script id="initialAppearance" type="application/json">')
            payload = json.loads(html[start:html.index('</script>', start)])
            self.assertEqual(payload["settings"]["theme_color"], theme)
            self.assertNotIn("bound_kazumi_path", payload["settings"])
            self.assertIn("no-store", headers["Cache-Control"])
            self.assertLess(html.index('/appearance.js'), html.index('/styles.css'))
            self.assertLess(html.index('/appearance.js'), html.index('<body'))
        self.assertEqual(self.call("GET", "/appearance.js", client=self.alice)[0], 200)

    def login(self, username):
        status, data, headers = self.call("POST", "/api/auth/login", {"username": username, "password": "test-password-2026"})
        self.assertEqual(status, 200)
        return {"cookie": headers["Set-Cookie"].split(";", 1)[0], "csrf": data["csrf"], "revision": 0}

    def services(self, username="alice"):
        return self.server.runtime.services(self.server.accounts.user(username))

    def add_fixture(self, username="alice", anime_id=1):
        svc = self.services(username)
        svc.database.import_kazumi([{"id": anime_id, "type": 1, "name": "测试番剧"}])
        svc.database.update_bgm_metadata(anime_id, episode_count=3)
        return svc

    def test_page_names_are_validated_persistent_and_account_scoped(self):
        names = {"collection": "我的番架", "schedule": "追番日历", "timeline": "日记", "statistics": "统计", "ranking": "榜单"}
        self.assertEqual(self.call("PATCH", "/api/settings", {"sidebar_labels": names}, self.alice)[0], 200)
        self.assertEqual(self.call("GET", "/api/bootstrap", client=self.alice)[1]["settings"]["sidebar_labels"], names)
        self.assertEqual(self.call("GET", "/api/bootstrap", client=self.bobby)[1]["settings"]["sidebar_labels"], {})
        for invalid in ([], {"collection": "字" * 21}, {"schedule": 123}, {"ranking": "a\nb"}):
            self.assertEqual(self.call("PATCH", "/api/settings", {"sidebar_labels": invalid}, self.alice)[0], 400)
        self.assertEqual(self.call("PATCH", "/api/settings", {"sidebar_labels": {"collection": "  "}}, self.alice)[0], 200)
        self.assertEqual(self.call("GET", "/api/bootstrap", client=self.alice)[1]["settings"]["sidebar_labels"], {})

    def test_login_required_for_data_and_images(self):
        for path in ("/api/bootstrap", "/api/status", "/api/record-images/record-test.jpg", "/api/background", "/api/covers/1"):
            self.assertEqual(self.call("GET", path)[0], 401)
        self.assertEqual(self.call("GET", "/")[0], 303)

    def register(self, code, username="newfriend", **overrides):
        body = {"username": username, "password": "new-password-2026", "confirm_password": "new-password-2026", "invitation": code, **overrides}
        return self.call("POST", "/api/auth/register", body)

    def test_invited_registration_logs_in_and_has_empty_private_data(self):
        code = self.server.accounts.create_invitation()
        status, result, headers = self.register(code)
        self.assertEqual(status, 200)
        client = {"cookie": headers["Set-Cookie"].split(";", 1)[0], "csrf": result["csrf"]}
        snapshot = self.call("GET", "/api/bootstrap", client=client)[1]
        self.assertEqual(snapshot["animes"], [])
        self.assertEqual(snapshot["ranking_boards"], [])
        self.assertFalse(self.call("GET", "/api/auth/me", client=client)[1]["read_only"])
        self.assertEqual(self.call("POST", "/api/notes", {"content": "my private note"}, client)[0], 201)
        self.assertEqual(self.call("GET", "/api/timeline", client=self.alice)[1]["days"], [])
        with self.server.accounts.connect() as db:
            values = str([tuple(row) for row in db.execute("SELECT * FROM invitations")])
        self.assertNotIn(code, values)

    def test_invite_single_use_under_concurrent_registration(self):
        code = self.server.accounts.create_invitation()
        with ThreadPoolExecutor(2) as pool:
            statuses = list(pool.map(lambda name: self.register(code, name)[0], ("friend1", "friend2")))
        self.assertEqual(sorted(statuses), [200, 400])

    def test_invalid_expired_revoked_invites_and_invalid_credentials(self):
        self.assertEqual(self.register("unknown")[0], 400)
        code = self.server.accounts.create_invitation()
        self.server.accounts.revoke_invitation(code)
        self.assertEqual(self.register(code)[0], 400)
        code = self.server.accounts.create_invitation()
        with self.server.accounts.connect() as db:
            db.execute("UPDATE invitations SET expires=0 WHERE used_by IS NULL")
        self.assertEqual(self.register(code)[0], 400)
        code = self.server.accounts.create_invitation()
        for overrides in ({"confirm_password": "mismatch"}, {"username": "x"}, {"password": "short", "confirm_password": "short"}, {"username": "__demo__"}, {"username": "alice"}):
            self.assertEqual(self.register(code, **overrides)[0], 400)
        self.assertEqual(self.register(code)[0], 200, "validation errors must not consume the invite")

    def test_registration_rate_limit_persists(self):
        for index in range(10):
            self.assertEqual(self.register("bad", f"name{index}")[0], 400)
        self.assertEqual(self.register("bad")[0], 429)

    def guest(self):
        status, data, headers = self.call("POST", "/api/auth/guest", {})
        self.assertEqual(status, 200)
        self.assertTrue(data["read_only"])
        self.assertIn("Max-Age=3600", headers["Set-Cookie"])
        return {"cookie": headers["Set-Cookie"].split(";", 1)[0], "csrf": data["csrf"]}

    def test_guest_demo_content_and_all_writes_denied_centrally(self):
        guest = self.guest()
        me = self.call("GET", "/api/auth/me", client=guest)[1]
        self.assertTrue(me["read_only"])
        snapshot = self.call("GET", "/api/bootstrap", client=guest)[1]
        self.assertEqual(len(snapshot["animes"]), 6)
        self.assertTrue(snapshot["ranking_boards"])
        self.assertTrue(self.call("GET", "/api/timeline", client=guest)[1]["days"])
        self.assertTrue(self.call("GET", "/api/statistics", client=guest)[1]["series"])
        sid = snapshot["animes"][0]["id"]
        self.assertEqual(self.call("GET", f"/api/covers/{sid}", client=guest)[0], 200)
        revision = snapshot["revision"]
        for method, path in (("PATCH", "/api/settings"), ("POST", "/api/notes"), ("POST", "/api/subjects"), ("POST", "/api/record-images"), ("POST", "/api/background"), ("DELETE", "/api/events/1"), ("POST", "/api/rankings"), ("POST", f"/api/animes/{sid}/progress"), ("PATCH", f"/api/subjects/{sid}"), ("POST", "/api/future-write-endpoint")):
            self.assertEqual(self.call(method, path, {}, guest)[0], 403, path)
        self.assertEqual(self.call("GET", "/api/changes", client=guest)[1]["revision"], revision)
        self.assertEqual(self.call("GET", "/api/bootstrap", client=self.alice)[1]["animes"], [])
        self.assertEqual(self.call("POST", "/api/auth/logout", {}, guest)[0], 204)
        self.assertEqual(self.call("GET", "/api/bootstrap", client=guest)[0], 401)

    def test_guests_share_only_demo_not_sessions_or_personal_data(self):
        first, second = self.guest(), self.guest()
        self.assertNotEqual(first["cookie"], second["cookie"])
        self.assertNotEqual(first["csrf"], second["csrf"])
        self.call("POST", "/api/auth/logout", {}, first)
        self.assertEqual(self.call("GET", "/api/bootstrap", client=second)[0], 200)
        self.assertEqual(self.call("POST", "/api/auth/login", {"username": "__demo__", "password": "anything"})[0], 400)

    def test_registration_and_guest_require_origin(self):
        for action in ("register", "guest"):
            self.assertEqual(self.call("POST", "/api/auth/" + action, {}, headers={"Origin": "https://evil.example"})[0], 403)

    def test_bootstrap_is_account_scoped(self):
        self.add_fixture()
        alice = self.call("GET", "/api/bootstrap", client=self.alice)[1]
        bobby = self.call("GET", "/api/bootstrap", client=self.bobby)[1]
        self.assertEqual(len(alice["animes"]), 1)
        self.assertEqual(len(bobby["animes"]), 0)
        self.assertEqual(alice["user"]["username"], "alice")
        self.assertEqual(len(alice["profiles"]), 1)

    def test_csrf_and_origin_are_required(self):
        for headers in ({"Origin": "https://evil.example"}, {"X-CSRF-Token": "wrong"}, {"Origin": ""}):
            self.assertEqual(self.call("POST", "/api/notes", {"content": "no"}, self.alice, headers)[0], 403)
        self.assertEqual(self.services().database.timeline_days(), [])

    def test_shared_account_refresh_and_stale_write(self):
        second = self.login("alice")
        status, _, h = self.call("POST", "/api/notes", {"content": "first"}, self.alice)
        self.assertEqual(status, 201)
        self.assertEqual(h["X-Handbook-Revision"], "1")
        status, data, _ = self.call("POST", "/api/notes", {"content": "stale"}, second)
        self.assertEqual(status, 409)
        self.assertEqual(data["revision"], 1)
        snapshot = self.call("GET", "/api/bootstrap", client=second)[1]
        self.assertEqual(snapshot["revision"], 1)
        self.assertEqual(self.call("POST", "/api/notes", {"content": "next"}, second)[0], 201)
        self.assertEqual(self.call("GET", "/api/changes", client=self.alice)[1]["revision"], 2)

    def test_concurrent_same_revision_only_one_writer(self):
        second = self.login("alice")
        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(lambda client: self.call("POST", "/api/notes", {"content": "concurrent"}, client)[0], (self.alice, second)))
        self.assertEqual(sorted(results), [201, 409])

    def test_different_users_can_write_concurrently_without_crossing(self):
        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(lambda pair: self.call("POST", "/api/notes", {"content": pair[0]}, pair[1])[0], (("alice-note", self.alice), ("bobby-note", self.bobby))))
        self.assertEqual(results, [201, 201])
        for name in ("alice", "bobby"):
            events = self.services(name).database.export_cloud_state()["tables"]["events"]
            self.assertEqual([e["content"] for e in events], [name + "-note"])

    def test_password_hash_and_cookie_flags(self):
        with self.server.accounts.connect() as db:
            row = db.execute("SELECT password FROM users WHERE username='alice'").fetchone()
        self.assertNotIn("test-password", row["password"])
        status, _, headers = self.call("POST", "/api/auth/login", {"username": "alice", "password": "test-password-2026"})
        self.assertEqual(status, 200)
        self.assertIn("HttpOnly", headers["Set-Cookie"])
        self.assertIn("SameSite=Strict", headers["Set-Cookie"])

    def test_logout_revokes_session(self):
        self.assertEqual(self.call("POST", "/api/auth/logout", {}, self.alice)[0], 204)
        self.assertEqual(self.call("GET", "/api/bootstrap", client=self.alice)[0], 401)

    def test_reset_password_revokes_all_sessions(self):
        second = self.login("alice")
        self.server.accounts.reset_password("alice", "new-password-2026")
        for client in (self.alice, second):
            self.assertEqual(self.call("GET", "/api/bootstrap", client=client)[0], 401)

    def test_login_throttling(self):
        for _ in range(18):
            self.call("POST", "/api/auth/login", {"username": "missing", "password": "bad-password"})
        self.assertEqual(self.call("POST", "/api/auth/login", {"username": "alice", "password": "test-password-2026"})[0], 429)

    def test_private_image_isolation_and_cache_headers(self):
        services = self.services()
        services.record_image_root.mkdir()
        (services.record_image_root / "record-test.jpg").write_bytes(b"example")
        status, data, headers = self.call("GET", "/api/record-images/record-test.jpg", client=self.alice)
        self.assertEqual((status, data), (200, b"example"))
        self.assertEqual(headers["Cache-Control"], "private, no-store")
        self.assertEqual(self.call("GET", "/api/record-images/record-test.jpg", client=self.bobby)[0], 404)
        uid = self.server.accounts.user("alice")["id"]
        self.assertEqual(self.call("GET", "/api/background?account=" + uid, client=self.bobby)[0], 404)

    def test_local_only_and_filesystem_routes_are_unavailable(self):
        for method, path in (("POST", "/api/profiles/activate"), ("POST", "/api/sync"), ("POST", "/api/webdav/sync"), ("POST", "/api/sharing/configure"), ("GET", "/api/profiles"), ("GET", "/data/handbook.db"), ("GET", "/../app.py")):
            self.assertEqual(self.call(method, path, {}, self.alice)[0], 404)

    def test_user_cannot_change_server_network_endpoints(self):
        status, data, _ = self.call("PATCH", "/api/settings", {"bgm_sources": [{"api_base": "http://127.0.0.1"}], "launch_at_login": True, "day_start_hour": 4}, self.alice)
        self.assertEqual(status, 200)
        self.assertEqual(data["settings"]["bgm_api_base"], "https://api.bgm.tv")
        self.assertFalse(data["settings"]["launch_at_login"])
        self.assertFalse(image_url_allowed("http://127.0.0.1/test"))
        self.assertFalse(image_url_allowed("https://lain.bgm.tv.evil.example/a"))
        self.assertTrue(image_url_allowed("https://lain.bgm.tv/pic/cover/a.jpg"))

    def test_progress_preserves_first_watch_and_rejects_stale_selection(self):
        services = self.add_fixture()
        second = self.login("alice")
        anime = services.database.get_anime(1)
        key = anime["episodes"][0]["key"]
        self.assertEqual(self.call("POST", "/api/animes/1/progress", {"episode_keys": [key]}, self.alice)[0], 200)
        old = services.database.export_cloud_state()["tables"]["events"]
        self.assertEqual(self.call("POST", "/api/animes/1/progress", {"episode_keys": []}, second)[0], 409)
        self.assertEqual(self.call("POST", "/api/animes/1/progress", {"episode_keys": [key]}, self.alice)[0], 200)
        self.assertEqual(services.database.export_cloud_state()["tables"]["events"], old)

    def test_add_subject_and_change_category(self):
        metadata = {"id": 99, "type": 2, "name": "Example", "total_episodes": 12, "rating": {"score": 7.4, "total": 100}, "images": {}}
        with patch.object(self.services().sync, "fetch_bgm", return_value=metadata):
            status, data, _ = self.call("POST", "/api/subjects", {"id": 99, "category": 2}, self.alice)
        self.assertEqual(status, 201)
        self.assertEqual(data["anime"]["bgm_score"], 7.4)
        self.assertEqual(self.call("PATCH", "/api/subjects/99", {"category": 1}, self.alice)[0], 200)
        self.assertEqual(self.services().database.get_anime(99)["collection_type"], 1)
        self.assertEqual(self.call("PATCH", "/api/subjects/99", {"category": 0}, self.alice)[0], 200)
        self.assertEqual(self.services().database.list_anime(), [])

    def test_original_upload_does_not_decode_or_reencode_and_is_private(self):
        from PIL import Image
        output = io.BytesIO()
        Image.new("RGB", (3, 4), "red").save(output, "PNG")
        data = output.getvalue()
        with patch.object(Image.Image, "load", side_effect=AssertionError("Must not decode pixels")):
            status, payload, _ = self.call("POST", "/api/record-images", data, self.alice, {"Content-Type": "image/png"})
        self.assertEqual(status, 201)
        self.assertTrue(payload["url"].endswith(".png"))
        with patch.object(Path, "read_bytes", side_effect=AssertionError("Images must stream from disk")):
            self.assertEqual(self.call("GET", payload["url"], client=self.alice)[1], data)
        self.assertEqual(self.call("GET", payload["url"], client=self.bobby)[0], 404)
        status, _, _ = self.call("POST", "/api/record-images", b"abc", self.alice, {"Content-Type": "image/png"})
        self.assertEqual(status, 400)
        self.assertEqual(list(self.services().record_image_root.glob(".upload-*")), [])

    def test_background_original_formats_replace_old_and_preserve_metadata(self):
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo
        for fmt, mime in (("JPEG", "image/jpeg"), ("PNG", "image/png"), ("WEBP", "image/webp")):
            output = io.BytesIO()
            metadata = PngInfo()
            metadata.add_text("Comment", "Original metadata remains intact")
            Image.new("RGB", (20, 30), "blue").save(output, fmt, **({"pnginfo": metadata} if fmt == "PNG" else {}))
            raw = output.getvalue()
            status, _, _ = self.call("POST", "/api/background?profile_id=custom", raw, self.alice, {"Content-Type": mime})
            self.assertEqual(status, 200)
            received = self.call("GET", "/api/background?profile=custom", client=self.alice)
            self.assertEqual(received[1], raw)
            self.assertEqual(received[2]["Content-Type"], mime)
            self.assertEqual(len(list(self.services().background_root.glob("background-*"))), 1)

    def test_webp_variants_skip_native_pixel_decoder(self):
        from PIL import Image, WebPImagePlugin
        for options in ({}, {"lossless": True}, {"exif": b"Exif\x00\x00retained"}):
            out = io.BytesIO()
            Image.new("RGB", (40, 30)).save(out, "WEBP", **options)
            with patch.object(WebPImagePlugin.WebPImageFile, "_open", side_effect=AssertionError("Must not create WebP decoder")):
                status, data, _ = self.call("POST", "/api/record-images", out.getvalue(), self.alice, {"Content-Type": "image/webp"})
            self.assertEqual(status, 201)
            self.assertEqual(self.call("GET", data["url"], client=self.alice)[1], out.getvalue())

    def test_truncated_upload_removes_disk_staging_file(self):
        from server.uploads import receive_original, CHUNK_SIZE
        class BoundedReader(io.BytesIO):
            def read(self, size=-1):
                self_test.assertTrue(0 < size <= CHUNK_SIZE)
                return super().read(size)
        self_test = self
        folder = self.root / "partial-upload-test"
        with self.assertRaisesRegex(ValueError, "不完整"):
            receive_original(BoundedReader(b"abc"), 100, folder)
        self.assertEqual(list(folder.iterdir()), [])

    def test_upload_rejects_oversize_and_stale_without_creating_files(self):
        status, _, _ = self.call("POST", "/api/record-images", b"x", self.alice, {"Content-Type": "image/jpeg", "Content-Length": str(8 * 1024 * 1024 + 1)})
        self.assertEqual(status, 400)
        self.assertEqual(self.services().revision(), 0)
        other = self.login("alice")
        self.call("POST", "/api/notes", {"content": "new revision"}, other)
        self.assertEqual(self.call("POST", "/api/record-images", b"x", self.alice, {"Content-Type": "image/jpeg"})[0], 409)
        self.assertFalse(self.services().record_image_root.exists())

    def test_upload_queue_serializes_different_users(self):
        from PIL import Image
        import time
        import server.http as adapter
        raw = io.BytesIO()
        Image.new("RGB", (4, 5)).save(raw, "PNG")
        original = adapter.receive_original
        active = 0
        peak = 0
        counter_lock = threading.Lock()
        def slow(*args):
            nonlocal active, peak
            with counter_lock:
                active += 1
                peak = max(peak, active)
            try:
                time.sleep(.04)
                return original(*args)
            finally:
                with counter_lock:
                    active -= 1
        with patch.object(adapter, "receive_original", side_effect=slow):
            with ThreadPoolExecutor(2) as pool:
                results = list(pool.map(lambda c: self.call("POST", "/api/record-images", raw.getvalue(), c, {"Content-Type": "image/png"})[0], (self.alice, self.bobby)))
        self.assertEqual(results, [201, 201])
        self.assertEqual(peak, 1)

    def test_stale_additive_progress_merges_and_keeps_earliest_instant(self):
        svc = self.add_fixture()
        keys = [e["key"] for e in svc.database.get_anime(1)["episodes"]]
        second = self.login("alice")
        status, _, _ = self.call("POST", "/api/animes/1/progress", {"base_episode_keys": [], "episode_keys": keys[:2], "watched_at": "2026-10-01T12:00:00+08:00"}, self.alice)
        self.assertEqual(status, 200)
        status, result, _ = self.call("POST", "/api/animes/1/progress", {"base_episode_keys": [], "episode_keys": [keys[0], keys[2]], "watched_at": "2026-10-01T02:00:00Z"}, second)
        self.assertEqual(status, 200)
        self.assertTrue(result["refresh_required"])
        self.assertEqual(set(result["anime"]["watched_episode_keys"]), set(keys))
        events = svc.database.export_cloud_state()["tables"]["events"]
        moments = {k: webdav.WebDAVSyncService._row_moment(e, "created_at").isoformat() for e in events for k in json.loads(e["episodes"])}
        self.assertEqual(moments[keys[0]], "2026-10-01T02:00:00+00:00")
        self.assertEqual(moments[keys[1]], "2026-10-01T04:00:00+00:00")
        self.assertEqual(moments[keys[2]], "2026-10-01T02:00:00+00:00")
        # Retry the same operation with the old version: no duplicated episodes/events.
        second["revision"] = 0
        self.assertEqual(self.call("POST", "/api/animes/1/progress", {"base_episode_keys": [], "episode_keys": [keys[0], keys[2]], "watched_at": "2026-10-01T02:00:00Z"}, second)[0], 200)
        self.assertEqual(svc.database.export_cloud_state()["tables"]["events"], events)

    def test_stale_removal_is_not_merged(self):
        svc = self.add_fixture()
        key = svc.database.get_anime(1)["episodes"][0]["key"]
        second = self.login("alice")
        self.call("POST", "/api/animes/1/progress", {"base_episode_keys": [], "episode_keys": [key]}, self.alice)
        self.assertEqual(self.call("POST", "/api/animes/1/progress", {"base_episode_keys": [key], "episode_keys": []}, second)[0], 409)
        self.assertEqual(svc.database.get_anime(1)["watched_episode_keys"], [key])

    def test_only_referenced_images_are_imported(self):
        source_root = Path(self.temp.name) / "source"
        source_db = database.HandbookDB(source_root / "handbook.db", asset_root=source_root)
        source_db.add_note("![test](/api/record-images/record-own.jpg)")
        folder = source_root / "record-images"
        folder.mkdir()
        (folder / "record-own.jpg").write_bytes(b"own")
        (folder / "record-other.jpg").write_bytes(b"other")
        result = import_local(self.server.runtime, self.server.accounts, "alice", source_db.path)
        self.assertEqual(result["images_copied"], 1)
        self.assertTrue((self.services().record_image_root / "record-own.jpg").exists())
        self.assertFalse((self.services().record_image_root / "record-other.jpg").exists())

    def test_origin_host_mismatch(self):
        self.assertEqual(self.call("GET", "/api/bootstrap", client=self.alice, headers={"Host": "evil.example"})[0], 400)

    def test_login_page_and_online_assets(self):
        self.assertIn("登录".encode(), self.call("GET", "/login")[1])
        page = self.call("GET", "/", client=self.alice)[1].decode()
        self.assertIn('class="online-mode"', page)
        self.assertLess(page.index('/online.js'), page.index('/app.js'))
        self.assertEqual(self.call("GET", "/online.js", client=self.alice)[0], 200)

    def test_revision_persists_across_service_restart(self):
        self.call("POST", "/api/notes", {"content": "persist"}, self.alice)
        self.server.runtime._accounts.clear()
        self.assertEqual(self.call("GET", "/api/changes", client=self.alice)[1]["revision"], 1)

    def test_import_is_readonly_and_refuses_existing_records(self):
        local_root = Path(self.temp.name) / "desktop"
        db = database.HandbookDB(local_root / "handbook.db", asset_root=local_root)
        db.import_kazumi([{"id": 7, "type": 2, "name": "imported"}])
        db.add_note("retained")
        db.set_setting("bound_kazumi_path", "PRIVATE-DEVICE-PATH")
        before = hashlib.sha256(db.path.read_bytes()).hexdigest()
        counts = import_local(self.server.runtime, self.server.accounts, "alice", db.path)
        self.assertEqual(counts["animes"], 1)
        self.assertEqual(hashlib.sha256(db.path.read_bytes()).hexdigest(), before)
        self.assertEqual(self.services().database.get_settings()["bound_kazumi_path"], "")
        with self.assertRaises(ValueError):
            import_local(self.server.runtime, self.server.accounts, "alice", db.path)

    def test_reject_local_data_root(self):
        from server.runtime import Runtime
        with self.assertRaises(ValueError):
            Runtime(core.DEFAULT_DATA_ROOT)

    def test_production_requires_https_and_secure_cookie(self):
        with self.assertRaises(ValueError):
            OnlineServer(("127.0.0.1", 0), self.root, "http://example.com")
        self.server.development = False
        self.assertIn("Secure", self.call("POST", "/api/auth/login", {"username": "alice", "password": "test-password-2026"})[2]["Set-Cookie"])


class LegacyAccountMigrationTest(unittest.TestCase):
    def test_old_account_database_keeps_credentials_and_member_access(self):
        from server.auth import Accounts
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            salt = "01" * 16
            with closing(sqlite3.connect(root / "accounts.sqlite3")) as db, db:
                db.execute("CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, password TEXT NOT NULL, created_at REAL NOT NULL)")
                db.execute("INSERT INTO users VALUES(?,?,?,?,?)", ("existing-user", "oldfriend", salt, Accounts.digest("old-password-2026", salt), 1))
            accounts = Accounts(root)
            token, user = accounts.login("oldfriend", "old-password-2026", "local")
            self.assertEqual(user["role"], "member")
            self.assertEqual(accounts.session(token)["id"], "existing-user")
