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

    def test_file_count_only_counts_playable_files(self):
        """卡片「已收 N 集」和详情同口径：只数磁盘上真在的文件。"""
        self._make_anime(1, "测试番A", watched=[])
        self._make_file(1, "0:1", "a1.mp4")
        self._make_file(1, "0:2", "a2.mp4")
        (self.media / "a2.mp4").unlink()   # 记录还在，文件被手动删掉

        item = next(row for row in self.service.library()["items"] if row["anime_id"] == 1)
        self.assertEqual(item["file_count"], 1, "已收集数只算还能播的那一集")
        self.assertEqual(item["missing_count"], 1, "缺的那一集单独报出来，供详情提示")

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

    def test_downloading_anime_shows_up_with_progress(self):
        """刚点下载、还没有成品文件的番也要进媒体库：否则从动漫库进来像什么都没发生。"""
        self._make_anime(3, "测试番C", watched=[])
        self.service.store.create_job(
            anime_id=3, source_kind="web", torrent_name="网站资源 · 第 01 集",
            episode_key="0:1", status="downloading",
        )
        item = next(row for row in self.service.library()["items"] if row["anime_id"] == 3)
        self.assertEqual(item["file_count"], 0)
        self.assertEqual(item["active_count"], 1)
        self.assertEqual(item["name"], "测试番C")
        self.assertEqual(item["continue_file_id"], 0, "没有成品时不该给「继续观看」")

    def test_progress_is_averaged_over_active_jobs(self):
        self._make_anime(4, "测试番D", watched=[])
        for key, value in (("0:1", 50), ("0:2", 10)):
            job = self.service.store.create_job(
                anime_id=4, source_kind="web", torrent_name=f"网站资源 · {key}",
                episode_key=key, status="downloading",
            )
            self.service.store.set_status(int(job["id"]), "downloading", progress=value)
        item = next(row for row in self.service.library()["items"] if row["anime_id"] == 4)
        self.assertEqual(item["active_count"], 2)
        self.assertEqual(item["active_progress"], 30.0)

    def test_finished_job_stops_counting_as_active(self):
        self._make_anime(5, "测试番E", watched=[])
        job = self.service.store.create_job(
            anime_id=5, source_kind="web", torrent_name="网站资源 · 第 01 集",
            episode_key="0:1", status="downloading",
        )
        self.service.store.set_status(int(job["id"]), "ready", progress=100)
        self.assertEqual(
            [row for row in self.service.library()["items"] if row["anime_id"] == 5], [],
            "已经入库又没有文件记录的番不该以「下载中」的身份留着",
        )



    def test_batch_delete_removes_files_and_reports_the_rest(self):
        """批量删除：能删的都删掉，删不掉的单独报出来，不整批放弃。"""
        self._make_anime(7, "测试番", watched=[])
        self._make_file(7, "0:1", "a1.mp4")
        self._make_file(7, "0:2", "a2.mp4")
        (self.media / "a2.mp4").unlink()   # 文件早就不在了，记录还在

        data = self.service.delete_episode_files(7, ["0:1", "0:2", "0:9"])
        self.assertEqual(data["deleted"], 2, "有记录的集都要清掉（文件不在也能清记录）")
        self.assertEqual([item["episode_key"] for item in data["failed"]], ["0:9"], "没有记录的集报失败")
        self.assertEqual(self.service.store.files_for_anime(7), [])
        self.assertFalse((self.media / "a1.mp4").exists(), "文件要真的从磁盘删掉")

    def test_batch_delete_needs_a_selection(self):
        with self.assertRaises(Exception):
            self.service.delete_episode_files(7, [])


if __name__ == "__main__":
    unittest.main()
