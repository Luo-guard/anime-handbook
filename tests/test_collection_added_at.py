"""收藏夹内的「加入时间」：每个收藏夹各记各的，不能共用 Kazumi 入库时间。"""
import tempfile
import unittest
from pathlib import Path

from handbook.collection import save_collection
from handbook.database import HandbookDB

OLD = "2000-01-01T00:00:00+08:00"


def kazumi_item(anime_id: int, category: int, updated_at: str) -> dict:
    return {
        "id": anime_id,
        "type": category,
        "name": f"Anime {anime_id}",
        "name_cn": f"番剧 {anime_id}",
        "summary": "简介",
        "air_date": "2026-01-01",
        "image_url": "https://example.com/cover.jpg",
        "updated_at": updated_at,
    }


class CollectionAddedAtTest(unittest.TestCase):
    def setUp(self):
        self._folder = tempfile.TemporaryDirectory()
        self.path = Path(self._folder.name) / "test.db"
        self.db = HandbookDB(self.path)

    def tearDown(self):
        self._folder.cleanup()

    def _set_added(self, anime_id: int, stamp: str) -> None:
        with self.db.connect() as db:
            db.execute(
                "UPDATE anime SET collection_added_at = ? WHERE id = ?",
                (stamp, anime_id),
            )

    def _added(self, anime_id: int) -> str:
        return self.db.get_anime(anime_id)["collection_added_at"]

    def test_new_anime_records_entry_time_immediately(self):
        # 以前改状态不写时间戳，新条目排序值是空串，只能吊在该收藏夹最后，
        # 要等下一次同步才归位（「刷新一下就好了」）。
        anime = save_collection(self.db, {"id": 101, "type": 2, "name": "A"}, 1)
        self.assertTrue(anime["collection_added_at"])
        self.assertEqual(self._added(101), anime["collection_added_at"])

    def test_same_category_keeps_entry_time(self):
        save_collection(self.db, {"id": 102, "type": 2, "name": "B"}, 1)
        self._set_added(102, OLD)
        changed = self.db.change_collection_status(102, 1)
        self.assertEqual(changed["collection_added_at"], OLD)

    def test_moving_between_categories_resets_entry_time(self):
        self.db.import_kazumi([kazumi_item(103, 1, "2026-01-01T10:00:00+08:00")])
        self._set_added(103, OLD)
        moved = self.db.change_collection_status(103, 4)
        self.assertEqual(moved["collection_type"], 4)
        # 换了收藏夹就是「刚加入」，旧戳必须被替换掉。
        self.assertNotEqual(moved["collection_added_at"], OLD)
        self.assertTrue(moved["collection_added_at"])

    def test_reactivating_counts_as_rejoining(self):
        self.db.import_kazumi([kazumi_item(104, 1, "2026-01-01T10:00:00+08:00")])
        self._set_added(104, OLD)
        with self.db.connect() as db:
            db.execute("UPDATE anime SET active = 0 WHERE id = 104")
        # 移出收藏后重新加入（不换分类）也是一次新的「加入」。
        restored = self.db.change_collection_status(104, 1)
        self.assertEqual(restored["active"], 1)
        self.assertNotEqual(restored["collection_added_at"], OLD)

    def test_import_keeps_stamp_when_category_is_unchanged(self):
        self.db.import_kazumi([kazumi_item(105, 1, "2026-01-01T10:00:00+08:00")])
        self._set_added(105, OLD)
        self.db.import_kazumi([kazumi_item(105, 1, "2026-02-01T10:00:00+08:00")])
        self.assertEqual(self._added(105), OLD)

    def test_import_uses_kazumi_time_for_new_entries(self):
        self.db.import_kazumi([kazumi_item(106, 2, "2026-03-04T05:06:07.890")])
        self.assertEqual(self._added(106), "2026-03-04T05:06:07.890")

    def test_import_resets_stamp_when_kazumi_changed_category(self):
        self.db.import_kazumi([kazumi_item(107, 1, "2026-01-01T10:00:00+08:00")])
        self._set_added(107, OLD)
        self.db.import_kazumi([kazumi_item(107, 4, "2026-01-01T10:00:00+08:00")])
        self.assertEqual(self.db.get_anime(107)["collection_type"], 4)
        self.assertNotEqual(self._added(107), OLD)

    def test_custom_collection_membership_exposes_its_own_time(self):
        self.db.import_kazumi([kazumi_item(108, 1, "2026-01-01T10:00:00+08:00")])
        self._set_added(108, OLD)
        first = self.db.create_custom_collection("通勤")
        second = self.db.create_custom_collection("睡前")
        self.db.add_to_custom_collection(first["id"], 108)
        self.db.add_to_custom_collection(second["id"], 108)
        anime = self.db.get_anime(108)
        stamps = anime["custom_collection_added_at"]
        self.assertEqual(
            sorted(stamps), sorted([str(first["id"]), str(second["id"])])
        )
        self.assertTrue(all(stamps.values()))
        # 未映射的自定义收藏夹不改内置分类，内置分类的加入时间应保持原样。
        self.assertEqual(anime["collection_added_at"], OLD)

    def test_readding_custom_collection_stamps_again(self):
        self.db.import_kazumi([kazumi_item(109, 1, "2026-01-01T10:00:00+08:00")])
        collection = self.db.create_custom_collection("临时")
        key = str(collection["id"])
        self.db.add_to_custom_collection(collection["id"], 109)
        first = self.db.get_anime(109)["custom_collection_added_at"][key]
        with self.db.connect() as db:
            db.execute(
                "UPDATE custom_collection_items SET created_at = ?", (OLD,)
            )
        self.assertEqual(self.db.get_anime(109)["custom_collection_added_at"][key], OLD)
        # 移出再加回来，是新的加入时间。
        self.db.remove_from_custom_collection(collection["id"], 109)
        again = self.db.add_to_custom_collection(collection["id"], 109)
        self.assertNotEqual(again["custom_collection_added_at"][key], OLD)

    def test_legacy_database_backfills_from_kazumi_time(self):
        self.db.import_kazumi([kazumi_item(110, 1, "2026-05-06T07:08:09.123")])
        with self.db.connect() as db:
            db.execute("ALTER TABLE anime DROP COLUMN collection_added_at")
            db.execute("UPDATE anime SET kazumi_updated_at = ? WHERE id = 110", (OLD,))
        upgraded = HandbookDB(self.path)
        self.assertEqual(upgraded.get_anime(110)["collection_added_at"], OLD)


if __name__ == "__main__":
    unittest.main()
