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
        self.database = SimpleNamespace(path="test.db", _write_lock=threading.RLock(), export_cloud_state=Mock(return_value=self.local), import_cloud_state=Mock())

    def test_first_sync_with_two_versions_requires_explicit_choice(self):
        for resolution in ("local", "remote"):
            with self.subTest(resolution=resolution):
                self.item.clear()
                self.item["account_id"] = "test-account"
                self.service._remote_probe = Mock(return_value=(200, "v1"))
                self.service._remote_state = Mock(return_value=({"state": self.other}, self.service._state_hash(self.other), "v1"))
                self.service._upload_state = Mock(return_value=(self.service._state_hash(self.local), "v2"))
                self.service._write.reset_mock()
                self.database.import_cloud_state.reset_mock()
                conflict = self.service._sync_once(self.database)
                self.assertTrue(conflict["conflict"])
                self.service._write.assert_not_called()
                self.service._upload_state.assert_not_called()
                self.database.import_cloud_state.assert_not_called()

                result = self.service._sync_once(self.database, resolution=resolution, conflict_token=conflict["conflict_token"])
                self.service._remote_probe.assert_called_once()
                self.assertEqual(self.service._remote_state.call_count, 2)
                if resolution == "local":
                    self.assertEqual(result["action"], "uploaded")
                    self.service._upload_state.assert_called_once_with(self.service._read.return_value, "test-account", self.local, etag="v1")
                    self.database.import_cloud_state.assert_not_called()
                else:
                    self.assertEqual(result["action"], "downloaded")
                    self.database.import_cloud_state.assert_called_once_with(self.other)
                    self.service._upload_state.assert_not_called()

    def test_choice_expires_if_either_version_changes(self):
        self.item.pop("last_hash")
        self.service._remote_probe = Mock(return_value=(200, "v1"))
        initial = ({"state": self.other}, self.service._state_hash(self.other), "v1")
        self.service._remote_state = Mock(return_value=initial)
        self.service._upload_state = Mock()
        token = self.service._sync_once(self.database)["conflict_token"]
        for changed in ("local", "remote", "missing", "account"):
            with self.subTest(changed=changed):
                self.database.export_cloud_state.return_value = self.baseline if changed == "local" else self.local
                self.service._remote_state.return_value = {
                    "remote": ({"state": self.baseline}, self.service._state_hash(self.baseline), "v2"),
                    "missing": (None, "", ""),
                }.get(changed, initial)
                if changed == "account":
                    self.item["account_id"] = "other-account"
                for resolution in ("local", "remote"):
                    with self.assertRaisesRegex(ValueError, "版本已变化"):
                        self.service._sync_once(self.database, resolution=resolution, conflict_token=token)
        self.service._upload_state.assert_not_called()
        self.service._write.assert_not_called()
        self.database.import_cloud_state.assert_not_called()

    def test_first_sync_with_empty_local_or_identical_versions_is_automatic(self):
        self.service._remote_probe = Mock(return_value=(200, "v1"))
        self.service._remote_state = Mock(return_value=({"state": self.other}, self.service._state_hash(self.other), "v1"))
        self.service._upload_state = Mock()
        for local, action in ((self.baseline, "downloaded"), (self.other, "unchanged")):
            with self.subTest(action=action):
                self.item.pop("last_hash", None)
                self.database.export_cloud_state.return_value = local
                self.database.import_cloud_state.reset_mock()
                self.assertEqual(self.service._sync_once(self.database)["action"], action)
                self.assertEqual(self.database.import_cloud_state.call_count, int(action == "downloaded"))
        self.service._upload_state.assert_not_called()

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
