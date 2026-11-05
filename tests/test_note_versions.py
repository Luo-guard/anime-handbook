"""Editing a note must not create a second timeline row when snapshots merge."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from handbook import database, webdav

CREATED = "2026-10-23T17:05:44+08:00"


def state(events):
    tables = {table: [] for table in database.HandbookDB.CLOUD_TABLES}
    tables["events"] = events
    return {"format": 1, "tables": tables}


def note(event_id, content, *, updated_at=None, created_at=CREATED):
    return {
        "id": event_id,
        "record_uid": f"test-record-{event_id}",
        "event_type": "note",
        "anime_id": None,
        "episodes": "[]",
        "content": content,
        "created_at": created_at,
        "updated_at": updated_at or created_at,
        "theme": "other",
        "themes": '["other"]',
        "raw_directives": content,
        "rating": None,
    }


class NoteMergeTest(unittest.TestCase):
    def merge(self, local_events, remote_events):
        return webdav.WebDAVSyncService.merge_record_states(
            state(local_events), state(remote_events)
        )["tables"]["events"]

    def test_edited_note_collapses_to_the_newer_copy(self):
        old = note(7, "第一段\n第二段", updated_at="2026-11-01T10:00:00+08:00")
        new = note(7, "第一段\n第二段\n第三段", updated_at="2026-11-04T13:00:00+08:00")
        events = self.merge([new], [old])
        self.assertEqual(len(events), 1)
        self.assertIn("第三段", events[0]["content"])
        self.assertEqual(events[0]["updated_at"], "2026-11-04T13:00:00+08:00")

    def test_deleted_paragraph_still_wins_when_it_was_edited_later(self):
        long_text = note(8, "第一段\n第二段\n第三段", updated_at="2026-11-01T10:00:00+08:00")
        shortened = note(8, "第一段\n第三段", updated_at="2026-11-04T13:00:00+08:00")
        events = self.merge([shortened], [long_text])
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["content"], "第一段\n第三段")

    def test_two_genuinely_different_notes_in_one_second_survive(self):
        first = note(11, "买牛奶")
        second = note(12, "修自行车")
        events = self.merge([first], [second])
        self.assertEqual(len(events), 2)
        self.assertEqual({event["content"] for event in events}, {"买牛奶", "修自行车"})

    def test_same_identity_without_edit_clock_does_not_use_length(self):
        old = note(13, "旧内容", updated_at=None)
        new = note(13, "旧内容\n追加一行", updated_at=None)
        old.pop("updated_at")
        new.pop("updated_at")
        events = self.merge([new], [old])
        self.assertEqual(len(events), 1)
        self.assertIn(events[0]["content"], [old["content"], new["content"]])

    def test_approved_repair_prevents_old_cloud_copies_returning(self):
        old = note(1, "old body")
        kept = note(2, "complete body", updated_at="2026-11-05T15:00:00+08:00")
        local = state([kept])
        local["tables"]["settings"] = [{"key":"record_identity_aliases", "value":'{"test-record-1":"test-record-2"}'}]
        for a,b in [(local,state([old])), (state([old]),local)]:
            merged = webdav.WebDAVSyncService.merge_record_states(a,b)
            self.assertEqual(len(merged["tables"]["events"]),1)
            self.assertEqual(merged["tables"]["events"][0]["content"],"complete body")
            self.assertEqual(len(webdav.WebDAVSyncService.merge_record_states(merged,state([old]))["tables"]["events"]),1)

    def test_merge_is_idempotent(self):
        new = note(14, "正文\n补充", updated_at="2026-11-04T13:00:00+08:00")
        old = note(14, "正文", updated_at="2026-11-01T10:00:00+08:00")
        once = self.merge([new], [old])
        twice = self.merge(once, [old])
        self.assertEqual(len(once), 1)
        self.assertEqual(len(twice), 1)
        self.assertEqual(once[0]["content"], twice[0]["content"])


class NoteVersionMigrationTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db = database.HandbookDB(Path(self.tempdir.name) / "handbook.db")

    def tearDown(self):
        self.tempdir.cleanup()

    def insert(self, content, *, created_at=CREATED, updated_at=None):
        with self.db._write_lock, self.db.connect() as db:
            cursor = db.execute(
                "INSERT INTO events(event_type, anime_id, episodes, content, theme, themes, raw_directives, created_at, updated_at)"
                " VALUES ('note', NULL, '[]', ?, 'other', '[\"other\"]', ?, ?, ?)",
                (content, content, created_at, updated_at or created_at),
            )
            return int(cursor.lastrowid)

    def test_prefix_rows_without_shared_identity_are_preserved(self):
        short = self.insert("要更新的：\n周表完善")
        longer = self.insert("要更新的：\n周表完善\n\n主题随机")
        longest = self.insert("要更新的：\n周表完善\n\n主题随机\n\n播出进度")
        self.db.initialize()
        with self.db.connect() as db:
            remaining = [row["content"] for row in db.execute("SELECT content FROM events")]
        self.assertEqual(len(remaining), 3)

    def test_independent_notes_keep_both(self):
        self.insert("买牛奶")
        self.insert("修自行车")
        self.db.initialize()
        with self.db.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events").fetchone()[0], 2)

    def event_row(self, event_id):
        with self.db.connect() as db:
            return dict(db.execute("SELECT * FROM events WHERE id = ?", (event_id,)).fetchone())

    def test_legacy_reimport_preserves_identity_without_mutating_input(self):
        event_id = self.db.add_note("legacy note")
        original = self.event_row(event_id)
        legacy = dict(original)
        legacy.pop("record_uid")
        snapshot = state([legacy])
        self.db.import_cloud_state(snapshot)
        self.assertEqual(self.event_row(event_id)["record_uid"], original["record_uid"])
        self.assertNotIn("record_uid", snapshot["tables"]["events"][0])
        self.db.import_cloud_state(snapshot)
        self.assertEqual(self.event_row(event_id)["record_uid"], original["record_uid"])

    def test_repaired_identity_survives_legacy_snapshot_restore(self):
        import json
        self.db.set_setting("record_identity_aliases", {"test-record-1":"test-record-2"})
        old=note(1,"old body")
        kept=note(2,"complete body",updated_at="2026-11-05T15:00:00+08:00")
        self.db.import_cloud_state(state([old,kept]))
        rows=self.db.export_cloud_state()["tables"]["events"]
        self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]["content"],"complete body")
        self.assertEqual(self.db.get_settings()["record_identity_aliases"],{"test-record-1":"test-record-2"})

    def test_editing_keeps_created_at_and_moves_updated_at(self):
        event_id = self.db.add_note("原始正文")
        before = self.event_row(event_id)
        self.db.update_event(
            event_id,
            content="原始正文\n追加",
            anime_id=None,
            theme="other",
            themes=["other"],
        )
        after = self.event_row(event_id)
        self.assertEqual(after["created_at"], before["created_at"], "timeline position must not move")
        self.assertGreaterEqual(after["updated_at"], before["updated_at"])

    def test_move_time_keeps_identity_and_cloud_merge_single(self):
        event_id = self.insert("before")
        before = self.event_row(event_id)
        self.db.update_event(event_id, content="after", anime_id=None, theme="other", time_mode="now")
        after = self.event_row(event_id)
        self.assertNotEqual(after["created_at"], before["created_at"])
        self.assertEqual(after["record_uid"], before["record_uid"])
        merged = webdav.WebDAVSyncService.merge_record_states(state([before]), state([after]))
        self.assertEqual(len(merged["tables"]["events"]), 1)
        self.assertEqual(merged["tables"]["events"][0]["content"], "after")

    def test_copy_is_independent_and_retry_safe(self):
        import uuid
        event_id = self.insert("original")
        before = self.event_row(event_id)
        args = dict(content="edited", anime_id=None, theme="other", time_mode="copy", copy_uid=uuid.uuid4().hex)
        self.db.update_event(event_id, **args)
        self.db.update_event(event_id, **args)
        rows = self.db.export_cloud_state()["tables"]["events"]
        self.assertEqual(len(rows), 2)
        self.assertEqual(self.event_row(event_id), before)
        self.assertEqual(len({row["record_uid"] for row in rows}), 2)
        merged = webdav.WebDAVSyncService.merge_record_states(state(rows), state([before]))
        self.assertEqual(len(merged["tables"]["events"]), 2)

    def test_copy_watch_does_not_duplicate_watched_count(self):
        import uuid
        event_id = self.insert("watched")
        with self.db.connect() as db:
            db.execute("UPDATE events SET event_type='watch', episodes='[1,2]' WHERE id=?", (event_id,))
        self.db.update_event(event_id, content="edited", anime_id=None, theme="watch", time_mode="copy", copy_uid=uuid.uuid4().hex)
        rows = self.db.export_cloud_state()["tables"]["events"]
        self.assertEqual([row["event_type"] for row in rows].count("watch"), 1)
        self.assertEqual([row["event_type"] for row in rows].count("note"), 1)

    def test_invalid_mode_and_copy_identity_leave_original_untouched(self):
        event_id = self.insert("original")
        before = self.event_row(event_id)
        for mode, uid in [("unknown", ""), ("copy", "invalid")]:
            with self.assertRaises(ValueError):
                self.db.update_event(event_id, content="edited", anime_id=None, theme="other", time_mode=mode, copy_uid=uid)
        self.assertEqual(self.event_row(event_id), before)


if __name__ == "__main__":
    unittest.main()
