"""自定义收藏夹 → Kazumi 收藏夹的映射同步。"""
import json
import tempfile
import unittest
from pathlib import Path

from handbook.database import HandbookDB


def sample_item(anime_id: int, category: int, name: str = "") -> dict:
    return {
        "id": anime_id,
        # 这个字段在 Kazumi 导入里就是收藏分类（1 在看 … 5 抛弃）。
        "type": category,
        "name": name or f"Anime {anime_id}",
        "name_cn": f"番剧 {anime_id}",
        "summary": "简介",
        "air_date": "2026-01-01",
        "image_url": "https://example.com/cover.jpg",
        "type_name": "在看",
        "updated_at": "2026-11-01T10:00:00+08:00",
        "time": anime_id,
    }


class CustomCollectionMappingTest(unittest.TestCase):
    def setUp(self):
        self._folder = tempfile.TemporaryDirectory()
        self.db = HandbookDB(Path(self._folder.name) / "test.db")
        self.db.import_kazumi([sample_item(501, 1)])

    def tearDown(self):
        self._folder.cleanup()

    def _outbox(self) -> list[dict]:
        with self.db.connect() as db:
            return [dict(row) for row in db.execute("SELECT * FROM kazumi_outbox ORDER BY anime_id")]

    def test_create_and_update_mapping(self):
        collection = self.db.create_custom_collection("通勤", 2)
        self.assertEqual(collection["kazumi_category"], 2)
        self.assertEqual(self.db.list_custom_collections()[0]["kazumi_category"], 2)

        updated = self.db.update_custom_collection(collection["id"], kazumi_category=4)
        self.assertEqual(updated["kazumi_category"], 4)
        # 只改映射不应该动名字。
        self.assertEqual(updated["name"], "通勤")

        cleared = self.db.update_custom_collection(collection["id"], kazumi_category=None)
        self.assertIsNone(cleared["kazumi_category"])

    def test_rename_keeps_mapping(self):
        collection = self.db.create_custom_collection("通勤", 3)
        renamed = self.db.rename_custom_collection(collection["id"], "路上")
        self.assertEqual(renamed["name"], "路上")
        self.assertEqual(renamed["kazumi_category"], 3)

    def test_invalid_mapping_rejected(self):
        for value in (0, 6, -1, "abc", True, [2]):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.db.create_custom_collection("X", value)
        collection = self.db.create_custom_collection("Y")
        with self.assertRaises(ValueError):
            self.db.update_custom_collection(collection["id"], kazumi_category=9)

    def test_adding_to_mapped_collection_syncs_kazumi_category(self):
        collection = self.db.create_custom_collection("通勤", 2)
        anime = self.db.add_to_custom_collection(collection["id"], 501)
        self.assertEqual(anime["collection_type"], 2)
        self.assertEqual(anime["mapped_category"], 2)
        jobs = self._outbox()
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["status"], 2)
        # baseline 是改之前的分类，Kazumi 优先时用来判断冲突。
        self.assertEqual(jobs[0]["baseline"], 1)
        subject = json.loads(jobs[0]["subject"])
        self.assertEqual(subject["id"], 501)
        self.assertEqual(subject["name_cn"], "番剧 501")
        self.assertEqual(subject["date"], "2026-01-01")
        self.assertEqual(subject["images"], {"large": "https://example.com/cover.jpg"})

    def test_unmapped_collection_does_not_touch_kazumi(self):
        collection = self.db.create_custom_collection("随手")
        anime = self.db.add_to_custom_collection(collection["id"], 501)
        self.assertEqual(anime["collection_type"], 1)
        self.assertNotIn("mapped_category", anime)
        self.assertEqual(self._outbox(), [])

    def test_multiple_collections_can_map_to_the_same_category(self):
        first = self.db.create_custom_collection("通勤", 2)
        second = self.db.create_custom_collection("地铁", 2)
        third = self.db.create_custom_collection("睡前", 2)

        self.db.add_to_custom_collection(first["id"], 501)
        self.db.add_to_custom_collection(second["id"], 501)
        self.db.add_to_custom_collection(third["id"], 501)
        # 三部收藏夹都映射到“想看”，但只写一条写回任务。
        self.assertEqual(len(self._outbox()), 1)
        self.assertEqual(self.db.get_anime(501)["collection_type"], 2)
        self.assertEqual(
            sorted(self.db.get_anime(501)["custom_collection_ids"]),
            sorted([first["id"], second["id"], third["id"]]),
        )

    def test_same_anime_can_live_in_many_collections(self):
        a = self.db.create_custom_collection("通勤")
        b = self.db.create_custom_collection("地铁")
        self.db.add_to_custom_collection(a["id"], 501)
        self.db.add_to_custom_collection(b["id"], 501)
        self.assertEqual(sorted(self.db.get_anime(501)["custom_collection_ids"]), sorted([a["id"], b["id"]]))
        counts = {row["name"]: row["count"] for row in self.db.list_custom_collections()}
        self.assertEqual(counts, {"通勤": 1, "地铁": 1})
        # 移出一个不影响另一个。
        self.db.remove_from_custom_collection(a["id"], 501)
        self.assertEqual(self.db.get_anime(501)["custom_collection_ids"], [b["id"]])

    def test_removing_from_collection_keeps_kazumi_category(self):
        collection = self.db.create_custom_collection("通勤", 4)
        self.db.add_to_custom_collection(collection["id"], 501)
        self.db.remove_from_custom_collection(collection["id"], 501)
        # 不回滚：另一个映射到“看过”的收藏夹可能刚把它改过来。
        self.assertEqual(self.db.get_anime(501)["collection_type"], 4)
        self.assertEqual(len(self._outbox()), 1)

    def test_read_only_skips_kazumi_sync(self):
        collection = self.db.create_custom_collection("通勤", 2)
        self.db.set_setting("kazumi_read_only", True)
        anime = self.db.add_to_custom_collection(collection["id"], 501)
        self.assertEqual(anime["collection_type"], 1)
        self.assertNotIn("mapped_category", anime)
        self.assertEqual(self._outbox(), [])
        # 但自定义收藏夹本身仍然加进去了。
        self.assertEqual(self.db.get_anime(501)["custom_collection_ids"], [collection["id"]])

    def test_already_in_target_category_does_not_queue(self):
        self.db.import_kazumi([sample_item(502, 2)])
        collection = self.db.create_custom_collection("通勤", 2)
        anime = self.db.add_to_custom_collection(collection["id"], 502)
        self.assertEqual(anime["collection_type"], 2)
        self.assertEqual([job for job in self._outbox() if job["anime_id"] == 502], [])

    def test_deleting_collection_keeps_kazumi_data(self):
        collection = self.db.create_custom_collection("通勤", 2)
        self.db.add_to_custom_collection(collection["id"], 501)
        self.assertTrue(self.db.delete_custom_collection(collection["id"]))
        self.assertEqual(self.db.get_anime(501)["collection_type"], 2)
        self.assertEqual(self.db.get_anime(501)["custom_collection_ids"], [])
        # 已有的写回任务不受影响。
        self.assertEqual(len(self._outbox()), 1)


if __name__ == "__main__":
    unittest.main()
