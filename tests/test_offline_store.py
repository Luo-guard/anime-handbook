"""离线记录两层结构：任务级 local_media、文件级 local_files。"""
import tempfile
import unittest
from pathlib import Path

from handbook import database
from handbook.offline import OfflineStore


class OfflineStoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.db = database.HandbookDB(root / "handbook.db", asset_root=root)
        self.store = OfflineStore(self.db)

    def tearDown(self):
        self.tmp.cleanup()

    def test_job_roundtrip(self):
        job = self.store.create_job(
            anime_id=7,
            torrent_hash="ABCDEF",
            torrent_name="某番 S01",
            source_title="[组] 某番 [1080p HEVC]",
            episode_key="本篇-1",
            group_name="组",
            resolution="1080p",
            codec="HEVC",
        )
        self.assertEqual(job["status"], "queued")
        self.assertEqual(job["anime_id"], 7)
        self.assertEqual(job["torrent_hash"], "ABCDEF")
        self.assertEqual(job["progress"], 0)
        self.assertEqual(len(self.store.jobs_for_anime(7)), 1)

    def test_same_hash_does_not_duplicate(self):
        first = self.store.create_job(anime_id=1, torrent_hash="abc", torrent_name="A")
        second = self.store.create_job(anime_id=1, torrent_hash="abc", torrent_name="A2", group_name="新组")
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(second["torrent_name"], "A2")
        self.assertEqual(second["group_name"], "新组")
        self.assertEqual(len(self.store.jobs_for_anime(1)), 1)

    def test_hash_lookup_is_case_insensitive(self):
        self.store.create_job(anime_id=1, torrent_hash="AbCdEf")
        self.assertIsNotNone(self.store.job_by_hash("abcdef"))
        self.assertIsNone(self.store.job_by_hash(""))

    def test_status_and_progress(self):
        job = self.store.create_job(anime_id=1, torrent_hash="h1")
        updated = self.store.set_status(job["id"], "downloading", progress=42.5)
        self.assertEqual(updated["status"], "downloading")
        self.assertEqual(updated["progress"], 42.5)
        clamped = self.store.set_status(job["id"], "downloading", progress=140)
        self.assertEqual(clamped["progress"], 100)
        failed = self.store.set_status(job["id"], "failed", error="没种了")
        self.assertEqual(failed["error"], "没种了")

    def test_unknown_status_rejected(self):
        job = self.store.create_job(anime_id=1, torrent_hash="h2")
        with self.assertRaises(ValueError):
            self.store.set_status(job["id"], "weird")
        with self.assertRaises(ValueError):
            self.store.create_job(anime_id=1, torrent_hash="h3", status="weird")

    def test_active_jobs_only_lists_unfinished(self):
        a = self.store.create_job(anime_id=1, torrent_hash="a")
        b = self.store.create_job(anime_id=1, torrent_hash="b")
        self.store.create_job(anime_id=1, torrent_hash="c")
        self.store.set_status(b["id"], "ready")
        active = {job["torrent_hash"] for job in self.store.active_jobs()}
        self.assertIn("a", active)
        self.assertIn("c", active)
        self.assertNotIn("b", active)
        self.assertEqual(a["status"], "queued")

    def test_files_replace_instead_of_stack(self):
        job = self.store.create_job(anime_id=3, torrent_hash="x")
        first = self.store.replace_file(
            anime_id=3, episode_key="本篇-1", file_path="D:/a/第 01 集.mp4", file_size=100, media_id=job["id"]
        )
        self.assertEqual(first["file_size"], 100)
        second = self.store.replace_file(
            anime_id=3, episode_key="本篇-1", file_path="D:/b/第 01 集.mp4", file_size=200, media_id=job["id"]
        )
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(second["file_path"], "D:/b/第 01 集.mp4")
        self.assertEqual(len(self.store.files_for_anime(3)), 1)

    def test_resume_progress_is_kept(self):
        self.store.replace_file(anime_id=4, episode_key="本篇-2", file_path="D:/x.mp4", duration_ms=1440000)
        self.store.set_resume(4, "本篇-2", 83000)
        self.assertEqual(self.store.file_for(4, "本篇-2")["resume_ms"], 83000)

    def test_missing_episode_key_rejected(self):
        with self.assertRaises(ValueError):
            self.store.replace_file(anime_id=1, episode_key="  ", file_path="D:/x.mp4")

    def test_delete_file_and_job(self):
        job = self.store.create_job(anime_id=5, torrent_hash="y")
        self.store.replace_file(anime_id=5, episode_key="本篇-1", file_path="D:/x.mp4")
        self.assertTrue(self.store.delete_file(5, "本篇-1"))
        self.assertIsNone(self.store.file_for(5, "本篇-1"))
        self.assertTrue(self.store.delete_job(job["id"]))
        self.assertIsNone(self.store.job(job["id"]))

    def test_files_are_sorted_by_episode_number(self):
        """审计 N16：0:10 不能排在 0:2 前面。"""
        for key in ("0:10", "0:2", "0:1", "1:3", "0:11"):
            self.store.replace_file(anime_id=6, episode_key=key, file_path=f"D:/x/{key}.mp4")
        self.assertEqual(
            [row["episode_key"] for row in self.store.files_for_anime(6)],
            ["0:1", "0:2", "0:10", "0:11", "1:3"],
        )

    def test_summary_counts(self):
        a = self.store.create_job(anime_id=1, torrent_hash="s1")
        b = self.store.create_job(anime_id=1, torrent_hash="s2")
        self.store.set_status(b["id"], "ready")
        self.store.replace_file(anime_id=1, episode_key="本篇-1", file_path="D:/x.mp4")
        counts = self.store.summary()
        self.assertEqual(counts["queued"], 1)
        self.assertEqual(counts["ready"], 1)
        self.assertEqual(counts["files"], 1)
        self.assertEqual(a["status"], "queued")


if __name__ == "__main__":
    unittest.main()
