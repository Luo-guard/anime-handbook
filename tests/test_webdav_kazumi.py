import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from handbook.database import HandbookDB
from handbook.webdav import WebDAVSyncService


class FakeProfiles:
    def profile(self, profile_id=None):
        return {"id": "p1", "sharing_id": "acc-12345678"}


class KazumiCloudPushTests(unittest.TestCase):
    def build(self, folder: Path):
        config_path = folder / "webdav.json"
        config_path.write_text(
            json.dumps(
                {
                    "url": "https://dav.example/dav/",
                    "username": "u",
                    "password": "p",
                    "profiles": {"p1": {"account_id": "acc-12345678"}},
                }
            ),
            encoding="utf-8",
        )
        hive = folder / "hive"
        hive.mkdir()
        (hive / "collectibles.hive").write_bytes(b"collectibles-v1")
        (hive / "collectchanges.hive").write_bytes(b"changes-v1")
        database = HandbookDB(folder / "db.sqlite")
        service = WebDAVSyncService(FakeProfiles(), config_path)
        return service, database, hive

    def run_push(self, service, database, hive, remote):
        calls = []

        def fake_request(config, method, relative, body=None, content_type=None):
            calls.append((method, relative, body))
            if method == "GET":
                data = remote.get(relative)
                return (404, b"") if data is None else (200, data)
            return (405 if method == "MKCOL" else 201, b"")

        with patch.object(WebDAVSyncService, "_request", staticmethod(fake_request)), patch.object(
            WebDAVSyncService, "_hive_dir", staticmethod(lambda: hive)
        ), patch.object(WebDAVSyncService, "_kazumi_running", staticmethod(lambda: False)):
            return service._push_kazumi(database), calls

    def puts(self, calls):
        return [call for call in calls if call[0] == "PUT"]

    def test_first_upload_when_cloud_is_empty(self):
        with tempfile.TemporaryDirectory() as folder:
            service, database, hive = self.build(Path(folder))
            result, calls = self.run_push(service, database, hive, {f"kazumiSync/{name}.tmp": None for name in ("collectibles", "collectchanges")})
            self.assertTrue(result["ok"])
            self.assertEqual(len(self.puts(calls)), 2)
            uploaded = {call[1]: call[2] for call in self.puts(calls)}
            self.assertEqual(uploaded["kazumiSync/collectibles.tmp"], b"collectibles-v1")

    def test_skips_when_cloud_changed_elsewhere(self):
        with tempfile.TemporaryDirectory() as folder:
            service, database, hive = self.build(Path(folder))
            config = service._read()
            item = service._profile_config(config)
            item["kazumi_sync"] = {
                "collectibles": hashlib.sha256(b"old").hexdigest(),
                "collectchanges": hashlib.sha256(b"changes-v1").hexdigest(),
            }
            service._write(config)
            remote = {
                "kazumiSync/collectibles.tmp": b"from-phone",
                "kazumiSync/collectchanges.tmp": b"changes-v1",
            }
            result, calls = self.run_push(service, database, hive, remote)
            self.assertFalse(result["ok"])
            self.assertEqual(result["action"], "changed")
            self.assertEqual(self.puts(calls), [])
            # 云端版本被记为新的基线，下一次点击才会推送。
            self.assertEqual(service._profile_config(service._read())["kazumi_sync"]["collectibles"], hashlib.sha256(b"from-phone").hexdigest())

    def test_pushes_when_cloud_unchanged_since_last_sync(self):
        with tempfile.TemporaryDirectory() as folder:
            service, database, hive = self.build(Path(folder))
            config = service._read()
            item = service._profile_config(config)
            item["kazumi_sync"] = {
                "collectibles": hashlib.sha256(b"cloud-v1").hexdigest(),
                "collectchanges": hashlib.sha256(b"changes-v1").hexdigest(),
            }
            service._write(config)
            remote = {
                "kazumiSync/collectibles.tmp": b"cloud-v1",
                "kazumiSync/collectchanges.tmp": b"changes-v1",
            }
            result, calls = self.run_push(service, database, hive, remote)
            self.assertTrue(result["ok"])
            self.assertEqual({call[1]: call[2] for call in self.puts(calls)}["kazumiSync/collectibles.tmp"], b"collectibles-v1")

    def test_skips_while_kazumi_runs(self):
        with tempfile.TemporaryDirectory() as folder:
            service, database, hive = self.build(Path(folder))
            with patch.object(WebDAVSyncService, "_hive_dir", staticmethod(lambda: hive)), patch.object(
                WebDAVSyncService, "_kazumi_running", staticmethod(lambda: True)
            ), patch.object(WebDAVSyncService, "_request", staticmethod(lambda *a, **k: (405, b""))):
                result = service._push_kazumi(database)
            self.assertFalse(result["ok"])
            self.assertEqual(result["action"], "running")

    def test_switch_off_disables_push(self):
        with tempfile.TemporaryDirectory() as folder:
            service, database, hive = self.build(Path(folder))
            database.set_setting("webdav_kazumi_sync", False)
            with patch.object(WebDAVSyncService, "_request", staticmethod(lambda *a, **k: (405, b""))):
                self.assertIsNone(service._push_kazumi(database))


if __name__ == "__main__":
    unittest.main()
