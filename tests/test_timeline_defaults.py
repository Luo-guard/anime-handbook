"""默认展示记录：设置项校验、去重与持久化。"""
import tempfile
import unittest
from pathlib import Path

from handbook import database
from handbook.settings_service import normalize_settings


class TimelineDefaultThemesSettingTest(unittest.TestCase):
    def test_date_filter_matches_statistics_day_boundary_and_theme(self):
        with tempfile.TemporaryDirectory() as temp:
            db = database.HandbookDB(Path(temp) / "handbook.db")
            db.set_settings({"day_start_hour": 4})
            before = db.add_note("before the boundary", theme="other")
            after = db.add_note("after the boundary", theme="other")
            with db.connect() as conn:
                conn.executemany("UPDATE events SET created_at=? WHERE id=?", [
                    ("2026-11-19T03:59:59+08:00", before),
                    ("2026-11-19T04:00:00+08:00", after),
                ])
            result = db.timeline_page(start="2026-11-18", end="2026-11-18", themes=["other"], limit=1)
            self.assertEqual([e["id"] for day in result["days"] for e in day["events"]], [before])
            self.assertFalse(result["has_more"])
            self.assertEqual([row["label"] for row in db.statistics("day", "other")], ["2026-11-18", "2026-11-19"])

    def test_default_is_empty_meaning_everything(self):
        with tempfile.TemporaryDirectory() as temp:
            db = database.HandbookDB(Path(temp) / "handbook.db")
            self.assertEqual(db.get_settings()["timeline_default_themes"], [])

    def test_accepts_known_string_ids_and_removes_duplicates(self):
        pending, _, _ = normalize_settings(
            {"timeline_default_themes": ["watch", "note", "watch"]}, {}
        )
        self.assertEqual(pending["timeline_default_themes"], ["watch", "note"])

    def test_rejects_wrong_shapes(self):
        for bad in ("watch", [1], None, {"watch": True}, [["watch"]]):
            with self.assertRaises(ValueError):
                normalize_settings({"timeline_default_themes": bad}, {})

    def test_caps_runaway_lists(self):
        pending, _, _ = normalize_settings(
            {"timeline_default_themes": ["theme-%02d" % index for index in range(60)]}, {}
        )
        self.assertEqual(len(pending["timeline_default_themes"]), 40)

    def test_round_trip_persists(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "handbook.db"
            db = database.HandbookDB(path)
            values, _, _ = normalize_settings(
                {"timeline_default_themes": ["note", "oped"]}, db.get_settings()
            )
            db.set_settings(values)
            self.assertEqual(db.get_settings()["timeline_default_themes"], ["note", "oped"])

            reopened = database.HandbookDB(path)
            self.assertEqual(
                reopened.get_settings()["timeline_default_themes"], ["note", "oped"]
            )


if __name__ == "__main__":
    unittest.main()
