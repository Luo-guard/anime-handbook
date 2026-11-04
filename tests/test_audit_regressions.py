"""Data-loss and stale-progress regressions from the November takeover audit."""
import hashlib
import os
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

from handbook import assets, airing
from handbook.database import HandbookDB
from handbook.webdav import WebDAVSyncService
import test_webdav_kazumi
from test_note_versions import note, state


class CloudSafetyTests(unittest.TestCase):
    build = test_webdav_kazumi.KazumiCloudPushTests.build
    run_push = test_webdav_kazumi.KazumiCloudPushTests.run_push
    puts = test_webdav_kazumi.KazumiCloudPushTests.puts
    def test_old_observation_baseline_is_not_trusted(self):
        with tempfile.TemporaryDirectory() as folder:
            service, database, hive = self.build(Path(folder))
            remote = {f"kazumiSync/{name}.tmp": b"phone" for name in service.KAZUMI_BOXES}
            config = service._read()
            service._profile_config(config)["kazumi_sync"] = {name: hashlib.sha256(b"phone").hexdigest() for name in service.KAZUMI_BOXES}
            service._write(config)
            for _ in range(3):
                result, calls = self.run_push(service, database, hive, remote)
                self.assertFalse(result["ok"])
                self.assertEqual(self.puts(calls), [])

    def test_equal_bytes_establish_baseline_then_local_edits_can_upload(self):
        with tempfile.TemporaryDirectory() as folder:
            service, database, hive = self.build(Path(folder))
            remote = {f"kazumiSync/{name}.tmp": (hive / f"{name}.hive").read_bytes() for name in service.KAZUMI_BOXES}
            result, calls = self.run_push(service, database, hive, remote)
            self.assertTrue(result["ok"])
            self.assertEqual(self.puts(calls), [])
            (hive / "collectibles.hive").write_bytes(b"local edit")
            result, calls = self.run_push(service, database, hive, remote)
            self.assertTrue(result["ok"])
            self.assertEqual(len(self.puts(calls)), 1)

    def test_conditional_write_rejects_race_and_does_not_advance_baseline(self):
        with tempfile.TemporaryDirectory() as folder:
            service, database, hive = self.build(Path(folder))
            conditions = []
            def request(config, method, relative, body=None, content_type=None, **kwargs):
                if method == "MKCOL": return 405, b""
                if method == "GET": return 404, b""
                conditions.append(kwargs.get("request_headers"))
                return 412, b""
            with patch.object(service, "_hive_dir", return_value=hive), patch.object(service, "_kazumi_running", return_value=False), patch.object(service, "_request", side_effect=request):
                self.assertFalse(service._push_kazumi(database)["ok"])
            self.assertEqual(conditions, [{"If-None-Match": "*"}])
            self.assertEqual(service._profile_config(service._read())["kazumi_sync_v2"], {})

    def test_existing_remote_requires_strong_etag(self):
        with tempfile.TemporaryDirectory() as folder:
            service, database, hive = self.build(Path(folder))
            config = service._read()
            baseline = {name: hashlib.sha256(b"previous").hexdigest() for name in service.KAZUMI_BOXES}
            service._profile_config(config)["kazumi_sync_v2"] = baseline
            service._write(config)
            for tag in ["", 'W/"weak"', '"strong"']:
                conditions = []
                def request(config, method, relative, body=None, content_type=None, **kwargs):
                    if method == "MKCOL": return 405, b""
                    if method == "GET":
                        kwargs["response_headers"]["etag"] = tag
                        return 200, b"previous"
                    conditions.append(kwargs["request_headers"])
                    return 412, b""
                with patch.object(service, "_hive_dir", return_value=hive), patch.object(service, "_kazumi_running", return_value=False), patch.object(service, "_request", side_effect=request):
                    service._push_kazumi(database)
                self.assertEqual(conditions, [{"If-Match": tag}] if tag.startswith('"') else [])


class MultiAccountAssetsTests(unittest.TestCase):
    def test_other_accounts_images_and_themes_survive(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            current = HandbookDB(root / "first.db", asset_root=root)
            other = HandbookDB(root / "second.db", asset_root=root)
            other.add_note("![picture](/api/record-images/other.png)")
            other.set_setting("theme_profiles", [{"id": "other_theme"}])
            images, backgrounds = root / "images", root / "backgrounds"
            images.mkdir(); backgrounds.mkdir()
            kept_image, kept_background = images / "other.png", backgrounds / "background-other-other_theme.jpg"
            for path in [kept_image, kept_background, images / "orphan.png", backgrounds / "orphan.jpg"]:
                path.write_bytes(b"example"); os.utime(path, (0, 0))
            result = assets.run_housekeeping(current, current.get_settings(), ["local", "other"], profile_paths={"local": current.path, "other": other.path}, record_root=images, background_root=backgrounds)
            self.assertTrue(kept_image.exists())
            self.assertTrue(kept_background.exists())
            self.assertEqual(result["record_images"], ["orphan.png"])
            self.assertEqual(result["backgrounds"], ["orphan.jpg"])
            result = assets.run_housekeeping(current, {}, ["local", "missing"], profile_paths={"local": current.path, "missing": root / "missing.db"}, record_root=images, background_root=backgrounds)
            self.assertTrue(result["assets_skipped"])
            self.assertTrue(kept_image.exists())
            self.assertTrue(kept_background.exists())
            self.assertFalse((root / "missing.db").exists())


class NoteIdentityTests(unittest.TestCase):
    def test_shorter_new_record_survives_reinitialization(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            database = HandbookDB(root / "notes.db", asset_root=root)
            first = database.add_note("前段正文以及后段正文")
            second = database.add_note("正文")
            with database.connect() as db:
                db.execute("UPDATE events SET created_at = '2026-11-01T10:00:00+08:00'")
                before = [dict(row) for row in db.execute("SELECT * FROM events")]
            database.initialize()
            with database.connect() as db:
                after = [dict(row) for row in db.execute("SELECT * FROM events")]
            self.assertEqual(before, after)
            self.assertEqual(len({row["record_uid"] for row in after}), 2)
            self.assertEqual({row["id"] for row in after}, {first, second})

    def test_legacy_upgrade_is_backed_up_before_identity_migration(self):
        import sqlite3
        from contextlib import closing
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            database = HandbookDB(root / "old.db", asset_root=root)
            database.add_note("legacy content")
            with database.connect() as db:
                db.execute("DROP TRIGGER events_record_uid")
                db.execute("ALTER TABLE events DROP COLUMN record_uid")
            database.initialize()
            backups = list((root / "backups").glob("*-before-record-identity-*.db"))
            self.assertEqual(len(backups), 1)
            with closing(sqlite3.connect(backups[0])) as db:
                self.assertEqual(db.execute("SELECT content FROM events").fetchone()[0], "legacy content")
                self.assertNotIn("record_uid", {row[1] for row in db.execute("PRAGMA table_info(events)")})
            with database.connect() as db:
                self.assertTrue(db.execute("SELECT record_uid FROM events").fetchone()[0])

    def test_unrelated_same_sqlite_id_cannot_merge(self):
        left, right = note(1, "正文"), note(1, "前段正文后段", updated_at="2026-11-04T13:00:00+08:00")
        right["record_uid"] = "another-device-record"
        merged = WebDAVSyncService.merge_record_states(state([left]), state([right]))
        self.assertEqual(len(merged["tables"]["events"]), 2)
        left.pop("record_uid"); right.pop("record_uid")
        merged = WebDAVSyncService.merge_record_states(state([left]), state([right]))
        self.assertEqual(len(merged["tables"]["events"]), 2)

    def test_mixed_legacy_snapshot_keeps_identities_and_sqlite_defaults(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            database = HandbookDB(root / "notes.db", asset_root=root)
            old, current = note(1, "old row"), note(2, "new row")
            old.pop("record_uid"); old.pop("updated_at")
            database.import_cloud_state(state([old, current]))
            exported = database.export_cloud_state()["tables"]["events"]
            self.assertTrue(exported[0]["record_uid"])
            self.assertEqual(exported[1]["record_uid"], current["record_uid"])
            # An unchanged old-device copy should not duplicate the new row.
            legacy = dict(current); legacy.pop("record_uid")
            merged = WebDAVSyncService.merge_record_states(state([current]), state([legacy]))
            self.assertEqual(len(merged["tables"]["events"]), 1)

    def test_identity_survives_cloud_export_import_and_subject_changes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            database = HandbookDB(root / "one.db", asset_root=root)
            database.add_note("draft")
            snapshot = database.export_cloud_state()
            old = snapshot["tables"]["events"][0]
            new = dict(old, content="edited", created_at="2099-11-04T12:00:00+08:00", updated_at="2099-11-04T12:00:00+08:00")
            merged = WebDAVSyncService.merge_record_states(state([old]), state([new]))
            self.assertEqual(len(merged["tables"]["events"]), 1)
            self.assertEqual(merged["tables"]["events"][0]["content"], "edited")
            database.import_cloud_state(merged)
            self.assertEqual(database.export_cloud_state()["tables"]["events"][0]["record_uid"], old["record_uid"])


class AiringGapTests(unittest.TestCase):
    def test_missing_and_unordered_episode_numbers(self):
        result = airing.compute_airing({"episodes": [{"sort": 3, "airdate": "2026-01-15"}, {"sort": 1, "airdate": "2026-01-01"}], "episode_count": 12}, {}, datetime(2026, 2, 1, tzinfo=airing.BEIJING))
        self.assertEqual(result["aired"], 3)
        self.assertEqual(result["total"], 12)
        result = airing.compute_airing({"episodes": [{"sort": 1, "airdate": "2026-01-01"}, {"sort": 3, "airdate": "2026-02-01"}], "episode_count": 12}, {}, datetime(2026, 1, 20, tzinfo=airing.BEIJING))
        self.assertEqual(result["next_episode"], 3)


if __name__ == "__main__": unittest.main()
