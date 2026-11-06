"""默认展示记录：设置项校验、去重与持久化。"""
import tempfile
import unittest
from pathlib import Path

from handbook import database
from handbook.settings_service import normalize_settings


class TimelineDefaultThemesSettingTest(unittest.TestCase):
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
