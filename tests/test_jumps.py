import tempfile
import unittest
from pathlib import Path

from handbook.database import HandbookDB
from handbook.jumps import normalize_jump


class JumpNormalizeTest(unittest.TestCase):
    def test_normalizes_host_and_kind(self):
        jump = normalize_jump({"url": "https://www.bilibili.com/video/BV1NJHG6eE9z/", "title": " 某视频 ", "anime_name": " 测试番 ", "anime_id": 3, "kind": "video"})
        self.assertEqual(jump["host"], "bilibili.com")
        self.assertEqual(jump["title"], "某视频")
        self.assertEqual(jump["anime_name"], "测试番")
        self.assertEqual(jump["anime_id"], 3)
        self.assertEqual(jump["kind"], "video")

    def test_kind_defaults_to_video_and_title_falls_back_to_host(self):
        jump = normalize_jump({"url": "https://example.com/a"})
        self.assertEqual(jump["kind"], "video")
        self.assertEqual(jump["title"], "example.com")

    def test_invalid_urls(self):
        for body in [
            {},
            {"url": ""},
            {"url": "javascript:alert(1)"},
            {"url": "ftp://a.b/c"},
            {"url": "https://user:pw@example.com/"},
            {"url": "https://a.b/" + "x" * 600},
            "not-a-dict",
        ]:
            with self.subTest(body=str(body)[:50]), self.assertRaises(ValueError):
                normalize_jump(body)


class JumpHistoryTest(unittest.TestCase):
    def test_records_are_deduped_and_capped(self):
        with tempfile.TemporaryDirectory() as folder:
            db = HandbookDB(Path(folder) / "one.db")
            db.record_jump({"url": "https://a.example/1", "title": "第一次", "kind": "video", "host": "a.example"})
            db.record_jump({"url": "https://a.example/2", "title": "第二条", "kind": "link", "host": "a.example"})
            rows = db.record_jump({"url": "https://a.example/1", "title": "改过标题", "kind": "video", "host": "a.example"})
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0]["url"], "https://a.example/1")
            self.assertEqual(rows[0]["title"], "改过标题")
            self.assertEqual(rows[1]["kind"], "link")
            db.clear_jumps()
            self.assertEqual(db.list_jumps(), [])

    def test_history_is_capped(self):
        with tempfile.TemporaryDirectory() as folder:
            db = HandbookDB(Path(folder) / "one.db")
            for index in range(HandbookDB.JUMP_HISTORY_LIMIT + 8):
                db.record_jump({"url": f"https://a.example/{index}", "title": f"第 {index} 条"})
            self.assertEqual(len(db.list_jumps(500)), HandbookDB.JUMP_HISTORY_LIMIT)
            self.assertEqual(db.list_jumps(5)[0]["title"], "第 207 条")


if __name__ == "__main__":
    unittest.main()
