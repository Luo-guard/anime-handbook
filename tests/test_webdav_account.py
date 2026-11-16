import json
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from handbook.webdav import WebDAVSyncService


class WebDAVAccountVersionTests(unittest.TestCase):
    def setUp(self):
        self.service = object.__new__(WebDAVSyncService)
        self.service._lock = threading.RLock()
        self.service._read = Mock(return_value={"url": "https://example.invalid", "username": "test", "password": "test"})
        self.service._ensure_remote_folder = Mock()
        self.service._write = Mock()
        self.baseline = {"tables": {"events": []}}
        self.local = {"tables": {"events": [{"content": "desktop"}]}}
        self.other = {"tables": {"events": [{"content": "phone"}]}}
        self.item = {"account_id": "test-account", "last_hash": self.service._state_hash(self.baseline), "last_etag": "v1"}
        self.service._profile_config = Mock(return_value=self.item)
        self.database = SimpleNamespace(export_cloud_state=Mock(return_value=self.local), import_cloud_state=Mock())

    def test_concurrent_cloud_write_blocks_fast_path_and_first_upload(self):
        for missing in (False, True):
            with self.subTest(missing=missing):
                self.item["last_verified_etag"] = "v1"
                initial = dict(self.item)

                def request(config, method, relative, body=None, content_type=None, **kwargs):
                    if method == "HEAD":
                        kwargs["response_headers"]["etag"] = "v1"
                        return (404 if missing else 200), b""
                    if method == "GET":
                        self.assertTrue(missing)
                        return 404, b""
                    self.assertEqual(method, "PUT")
                    condition = {"If-None-Match": "*"} if missing else {"If-Match": "v1"}
                    self.assertEqual(kwargs["request_headers"], condition)
                    return 412, b""

                with patch.object(WebDAVSyncService, "_request", side_effect=request):
                    with self.assertRaisesRegex(ValueError, "另一台设备"):
                        self.service._sync_once(self.database)
                self.assertEqual(self.item, initial)
                self.service._write.assert_not_called()
                self.database.import_cloud_state.assert_not_called()

    def test_get_version_conditions_upload_and_missing_put_tag_disables_fast_path(self):
        methods = []

        def request(config, method, relative, body=None, content_type=None, **kwargs):
            methods.append(method)
            if method == "HEAD":
                kwargs["response_headers"]["etag"] = "v1"
                return 200, b""
            if method == "GET":
                kwargs["response_headers"]["etag"] = "v2"
                return 200, json.dumps({"state": self.baseline}).encode()
            self.assertEqual(kwargs["request_headers"], {"If-Match": "v2"})
            return 204, b""

        with patch.object(WebDAVSyncService, "_request", side_effect=request):
            result = self.service._sync_once(self.database)
        self.assertEqual(result["action"], "uploaded")
        self.assertEqual(methods, ["HEAD", "GET", "PUT"])
        self.assertEqual(self.item["last_verified_etag"], "")

    def test_weak_or_missing_version_never_allows_unconditional_overwrite(self):
        for etag in ("", 'W/"v1"', "*", '"v1", "v2"'):
            with self.subTest(etag=etag):
                def request(config, method, relative, **kwargs):
                    self.assertIn(method, {"HEAD", "GET"})
                    kwargs["response_headers"]["etag"] = etag
                    return 200, json.dumps({"state": self.baseline}).encode()

                with patch.object(WebDAVSyncService, "_request", side_effect=request):
                    with self.assertRaisesRegex(ValueError, "安全上传的版本号"):
                        self.service._sync_once(self.database)
