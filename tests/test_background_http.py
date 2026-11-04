"""Background HTTP behaviour: cache headers and per-theme deletion."""
from __future__ import annotations

import http.client as httpclient
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from handbook import database, desktop, http
from handbook import common as app


class BackgroundHTTPTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        root = Path(self.tempdir.name)
        self.db = database.HandbookDB(root / "handbook.db")
        self.backgrounds = root / "background"
        self.backgrounds.mkdir()
        (self.backgrounds / "background-local-default.jpg").write_bytes(b"\xff\xd8fake-jpeg")
        self.active_account = str(desktop.PROFILES.profile().get("id") or "local")

        self.previous_database = desktop.DATABASE
        desktop.DATABASE = self.db
        desktop.DATABASE.set_setting("custom_background_enabled", True)
        desktop.DATABASE.set_setting("active_theme_profile", "default")

        self.root_patch = patch("handbook.http.BACKGROUND_ROOT", self.backgrounds)
        self.root_patch.start()
        self.write_patch = patch.object(http.RequestHandler, "require_write_access", lambda *args, **kwargs: None)
        self.write_patch.start()

        self.server = app.ThreadingHTTPServer(("127.0.0.1", 0), http.RequestHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        self.write_patch.stop()
        self.root_patch.stop()
        desktop.DATABASE = self.previous_database
        self.tempdir.cleanup()

    def request(self, method: str, path: str, headers: dict | None = None):
        connection = httpclient.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        connection.request(method, path, headers=headers or {})
        response = connection.getresponse()
        body = response.read()
        status, response_headers = response.status, dict(response.getheaders())
        connection.close()
        return status, response_headers, body

    def test_versioned_url_is_cached_for_good(self) -> None:
        status, headers, body = self.request("GET", "/api/background?profile=default&account=local&v=7")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"\xff\xd8fake-jpeg")
        self.assertIn("immutable", headers.get("Cache-Control", ""))
        self.assertTrue(headers.get("ETag"))

    def test_unversioned_url_revalidates_with_etag(self) -> None:
        status, headers, _ = self.request("GET", "/api/background?profile=default&account=local")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Cache-Control"), "no-cache")
        etag = headers["ETag"]
        status, headers, body = self.request(
            "GET",
            "/api/background?profile=default&account=local",
            {"If-None-Match": etag},
        )
        self.assertEqual(status, 304)
        self.assertEqual(body, b"")

    def test_deleting_another_theme_keeps_the_current_background_switch(self) -> None:
        (self.backgrounds / f"background-{self.active_account}-night.png").write_bytes(b"night")
        status, _, _ = self.request(
            "DELETE",
            f"/api/background?profile=night&account={self.active_account}",
        )
        self.assertEqual(status, 200)
        settings = self.db.get_settings()
        self.assertTrue(settings["custom_background_enabled"], "current theme still has a background")
        self.assertFalse((self.backgrounds / f"background-{self.active_account}-night.png").exists())

    def test_deleting_the_active_theme_background_turns_the_switch_off(self) -> None:
        status, _, body = self.request(
            "DELETE",
            f"/api/background?profile=default&account={self.active_account}",
        )
        self.assertEqual(status, 200)
        self.assertFalse(app.json.loads(body)["settings"]["custom_background_enabled"])
        self.assertFalse((self.backgrounds / f"background-{self.active_account}-default.jpg").exists())


if __name__ == "__main__":
    unittest.main()
