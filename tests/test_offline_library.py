"""「我的库」聚合：分组、已看统计、继续观看指向、磁盘字段。"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from handbook import database, offline_config
from handbook.offline_service import OfflineService


class LibraryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.media = self.root / "media"
        self.media.mkdir()
        self.db = database.HandbookDB(self.root / "handbook.db", asset_root=self.root)
        offline_config.save(self.root, {"media_root": str(self.media), "auto_follow": False})
        self.service = OfflineService(self.db)

    def tearDown(self):
        self.tmp.cleanup()

    def _make_anime(self, anime_id: int, name: str, *, watched: list[str], episodes: list[dict] | None = None):
        import json
        with self.db.connect() as db:
            db.execute(
                "INSERT INTO anime (id, name, name_cn, collection_type, episode_count,"
                " watched_episodes, episodes, active, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?)",
                (anime_id, name, name, 1, 12,
                 json.dumps(watched), json.dumps(episodes or []), 1, "2026-01-01T00:00:00", "2026-01-01T00:00:00"),
            )

    def _make_file(self, anime_id: int, key: str, name: str, *, size: int = 100, resume: int = 0, duration: int = 0):
        target = self.media / name
        target.write_bytes(b"x" * size)
        self.service.store.replace_file(
            anime_id=anime_id, episode_key=key, file_path=str(target),
            file_size=size, duration_ms=duration,
        )
        if resume:
            self.service.store.set_resume(anime_id, key, resume)

    def test_groups_files_and_counts(self):
        self._make_anime(1, "测试番A", watched=["0:1"])
        self._make_file(1, "0:1", "a1.mp4", resume=60_000, duration=100_000)
        self._make_file(1, "0:2", "a2.mp4")
        self._make_anime(2, "测试番B", watched=[])
        self._make_file(2, "0:1", "b1.mp4")

        data = self.service.library()
        items = {item["anime_id"]: item for item in data["items"]}
        self.assertEqual(len(items), 2)
        a = items[1]
        self.assertEqual(a["file_count"], 2)
        self.assertEqual(a["watched_count"], 1)
        self.assertEqual(a["size_bytes"], 200)
        self.assertEqual(a["continue_episode_key"], "0:1", "第 1 集看到一半：继续观看应回到这集的断点")
        b = items[2]
        self.assertEqual(b["continue_episode_key"], "0:1", "全没看过就从第一集开始")

    def test_disk_fields_present(self):
        self._make_anime(1, "测试番", watched=[])
        self._make_file(1, "0:1", "a.mp4")
        data = self.service.library()
        self.assertIn("free_gb", data["disk"])
        self.assertIn("total_gb", data["disk"])
        self.assertIn("media_root", data["disk"])

    def test_unplayable_anime_is_skipped(self):
        self._make_anime(3, "磁盘上没有的番", watched=[])
        self.service.store.replace_file(anime_id=3, episode_key="0:1", file_path=str(self.media / "ghost.mp4"), file_size=10)
        data = self.service.library()
        self.assertEqual([item["anime_id"] for item in data["items"]], [], "文件全不在的番不进媒体库")

    def test_bgm_style_watched_keys_map_through_episodes(self):
        import json
        episodes = [{"key": "bgm:900001", "type": 0, "sort": 1}]
        with self.db.connect() as db:
            db.execute(
                "UPDATE anime SET watched_episodes = ?, episodes = ? WHERE id = 1",
                (json.dumps(["bgm:900001"]), json.dumps(episodes)),
            )
        self._make_anime(1, "测试番A", watched=["0:1"])  # setUp 已插，这里只更新上面两列
        self._make_file(1, "0:1", "a1.mp4")
        data = self.service.library()
        a = next(item for item in data["items"] if item["anime_id"] == 1)
        self.assertEqual(a["watched_count"], 1, "旧 bgm:xxx 已看记录要经 episodes 映射统计进已看")


if __name__ == "__main__":
    unittest.main()
