"""归档流程：从下载目录找到视频 → remux → 写 local_files。

用真实的临时视频文件跑 ffmpeg，qB 用假客户端替身。
"""
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from handbook import database, offline_config, media
from handbook.offline import OfflineStore
from handbook.offline_service import OfflineError, OfflineService


class FakeClient:
    def __init__(self, content_path: str):
        self.content_path = content_path
        self.deleted: tuple | None = None

    def torrent(self, _hash):
        return {"content_path": self.content_path, "save_path": self.content_path, "state": "uploading"}

    def version(self):
        return "v5.1.0"

    def delete(self, hashes, delete_files=False):
        self.deleted = (hashes, delete_files)


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "需要本机 ffmpeg")
class ArchiveTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.media_tmp = tempfile.TemporaryDirectory()
        cls.source_dir = Path(cls.media_tmp.name) / "download" / "番剧合集"
        cls.source_dir.mkdir(parents=True)
        for index in (1, 2):
            subprocess.run(
                [
                    "ffmpeg", "-y", "-loglevel", "error",
                    "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
                    "-t", "1",
                    "-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le",
                    "-x265-params", "log-level=none",
                    "-c:a", "aac", "-shortest",
                    str(cls.source_dir / f"[LoliHouse] 测试番 - {index:02d} [1080p].mkv"),
                ],
                capture_output=True,
                timeout=180,
                check=True,
            )

    @classmethod
    def tearDownClass(cls):
        cls.media_tmp.cleanup()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.db = database.HandbookDB(self.root / "handbook.db", asset_root=self.root)
        self.store = OfflineStore(self.db)
        self.media_root = self.root / "media"
        offline_config.save(
            self.root,
            {"media_root": str(self.media_root), "seed_after_done": True},
        )

    def tearDown(self):
        self.tmp.cleanup()

    def make_job(self, content_path: str, name: str = "测试番") -> dict:
        return self.store.create_job(
            anime_id=99,
            torrent_hash="abc123",
            torrent_name=name,
            source_title="[LoliHouse] 测试番 [1080p]",
            save_path=content_path,
        )

    def test_archives_every_file_and_marks_ready(self):
        job = self.make_job(str(self.source_dir))
        service = OfflineService(self.db)
        fake = FakeClient(str(self.source_dir))
        with patch.object(OfflineService, "client", new=lambda _self, config=None: fake):
            service._archive(job["id"])

        files = self.store.files_for_anime(99)
        self.assertEqual([row["episode_key"] for row in files], ["0:1", "0:2"])
        for row in files:
            target = Path(row["file_path"])
            self.assertTrue(target.is_file(), target)
            self.assertEqual(target.suffix, ".mp4")
            self.assertGreater(row["file_size"], 0)
            self.assertGreater(row["duration_ms"], 0)
        self.assertEqual(self.store.job(job["id"])["status"], "ready")

        folder = Path(files[0]["file_path"]).parent
        self.assertEqual(folder.name, "测试番")
        self.assertTrue((folder / "第 01 集.mp4").is_file())
        self.assertTrue((folder / "第 02 集.mp4").is_file())
        # 做种开着时不该去删原始文件。
        self.assertIsNone(fake.deleted)

    def test_second_run_does_not_duplicate(self):
        job = self.make_job(str(self.source_dir))
        service = OfflineService(self.db)
        fake = FakeClient(str(self.source_dir))
        with patch.object(OfflineService, "client", new=lambda _self, config=None: fake):
            service._archive(job["id"])
            first = len(self.store.files_for_anime(99))
            service._archive(job["id"])
        self.assertEqual(len(self.store.files_for_anime(99)), first)

    def test_cleans_source_when_seeding_disabled(self):
        offline_config.save(self.root, {"media_root": str(self.media_root), "seed_after_done": False})
        job = self.make_job(str(self.source_dir))
        service = OfflineService(self.db)
        fake = FakeClient(str(self.source_dir))
        with patch.object(OfflineService, "client", new=lambda _self, config=None: fake):
            service._archive(job["id"])
        self.assertEqual(fake.deleted, (["abc123"], True))

    def test_missing_video_fails_loudly(self):
        empty = self.root / "empty"
        empty.mkdir()
        job = self.make_job(str(empty))
        service = OfflineService(self.db)
        fake = FakeClient(str(empty))
        with patch.object(OfflineService, "client", new=lambda _self, config=None: fake):
            with self.assertRaises(OfflineError) as caught:
                service._archive(job["id"])
        self.assertIn("没有找到视频文件", str(caught.exception))

    def test_unparsable_names_fail_with_actionable_message(self):
        folder = self.root / "weird"
        folder.mkdir()
        shutil.copy(
            next(self.source_dir.glob("*.mkv")),
            folder / "[VCB-Studio] Full Metal Panic BDRip 1080p.mkv",
        )
        job = self.make_job(str(folder))
        service = OfflineService(self.db)
        fake = FakeClient(str(folder))
        with patch.object(OfflineService, "client", new=lambda _self, config=None: fake):
            with self.assertRaises(OfflineError) as caught:
                service._archive(job["id"])
        self.assertIn("认不出集数", str(caught.exception))

    def test_single_file_uses_declared_episode_key(self):
        folder = self.root / "single"
        folder.mkdir()
        shutil.copy(next(self.source_dir.glob("*.mkv")), folder / "无集数标记.mkv")
        job = self.store.create_job(
            anime_id=99, torrent_hash="solo", torrent_name="测试番", episode_key="0:7"
        )
        service = OfflineService(self.db)
        fake = FakeClient(str(folder))
        with patch.object(OfflineService, "client", new=lambda _self, config=None: fake):
            service._archive(job["id"])
        rows = self.store.files_for_anime(99)
        self.assertEqual([row["episode_key"] for row in rows], ["0:7"])


if __name__ == "__main__":
    unittest.main()
