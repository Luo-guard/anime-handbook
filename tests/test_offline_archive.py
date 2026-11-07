"""归档流程：从下载目录找到视频 → remux → 写 local_files。

用真实的临时视频文件跑 ffmpeg，qB 用假客户端替身。
"""
import shutil
import subprocess
import tempfile
import threading
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from handbook import database, offline_config, media
from handbook.common import now_iso
from handbook.offline import OfflineStore
from handbook.offline_service import OfflineError, OfflineService, MAX_ARCHIVE_RETRIES


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

    def test_partial_ingestion_is_not_ready(self):
        """合集里混进一个认不出集数的文件：已入库的保留，任务不能标记完成。"""
        folder = self.root / "partial"
        folder.mkdir()
        shutil.copy(next(self.source_dir.glob("*.mkv")), folder / "[LoliHouse] 测试番 - 01 [1080p].mkv")
        shutil.copy(next(self.source_dir.glob("*.mkv")), folder / "乱起的名字.mkv")
        job = self.make_job(str(folder))
        service = OfflineService(self.db)
        fake = FakeClient(str(folder))
        with patch.object(OfflineService, "client", new=lambda _self, config=None: fake):
            service._archive_job(job["id"])
        row = self.store.job(job["id"])
        self.assertEqual(row["status"], "failed")
        self.assertIn("只入库 1/2", row["error"])
        rows = self.store.files_for_anime(99)
        self.assertEqual([row["episode_key"] for row in rows], ["0:1"])
        # 重试时已入库的集不会重新封装：成品文件保持原样（改动时间不变）。
        first_mtime = Path(rows[0]["file_path"]).stat().st_mtime
        with patch.object(OfflineService, "client", new=lambda _self, config=None: fake):
            service._archive_job(job["id"])
        self.assertEqual(self.store.job(job["id"])["status"], "failed")
        self.assertEqual(len(self.store.files_for_anime(99)), 1)
        self.assertEqual(
            Path(self.store.files_for_anime(99)[0]["file_path"]).stat().st_mtime,
            first_mtime,
        )
        # 乱名字的文件被用户改好后，手动重试能补完剩下的并标记完成。
        # retry_archive 起的是后台线程，patch 必须等到线程结束（状态落定）再退出。
        shutil.move(str(folder / "乱起的名字.mkv"), str(folder / "[LoliHouse] 测试番 - 02 [1080p].mkv"))
        with patch.object(OfflineService, "client", new=lambda _self, config=None: fake):
            OfflineService(self.db).retry_archive(job["id"])
            store_wait_ready(self.store, job["id"])
        self.assertEqual(
            sorted(row["episode_key"] for row in self.store.files_for_anime(99)),
            ["0:1", "0:2"],
        )


def store_wait_ready(store: OfflineStore, media_id: int, timeout: float = 120.0) -> None:
    import time as _time

    deadline = _time.time() + timeout
    while _time.time() < deadline:
        row = store.job(media_id)
        if row["status"] in ("ready", "failed"):
            break
        _time.sleep(0.2)
    return


def backdate(store: OfflineStore, media_id: int, seconds: float = 60.0) -> None:
    stale = (datetime.now() - timedelta(seconds=seconds)).isoformat(timespec="seconds")
    with store.db.connect() as db:
        db.execute("UPDATE local_media SET updated_at = ? WHERE id = ?", (stale, media_id))


class ArchiveRetryTest(unittest.TestCase):
    """归档失败后的自动重试：限频、有上限、手动介入清零。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = database.HandbookDB(Path(self.tmp.name) / "handbook.db", asset_root=Path(self.tmp.name))
        self.store = OfflineStore(self.db)
        self.service = OfflineService(self.db)

    def tearDown(self):
        self.tmp.cleanup()

    def make_failed_job(self, attempts: int = 0) -> dict:
        job = self.store.create_job(anime_id=99, torrent_hash="abc", torrent_name="测试番")
        self.store.set_status(job["id"], "failed", error="归档失败：内容缺失", archive_retries=attempts)
        backdate(self.store, job["id"])
        return self.store.job(job["id"])

    def test_auto_retry_increments_and_schedules(self):
        job = self.make_failed_job()
        scheduled: list[int] = []
        with patch.object(self.service, "_schedule_archive", new=scheduled.append):
            self.service._sync([job])
        row = self.store.job(job["id"])
        self.assertEqual(row["status"], "processing")
        self.assertEqual(row["archive_retries"], 1)
        self.assertEqual(scheduled, [job["id"]])

    def test_retry_stops_at_limit(self):
        job = self.make_failed_job(attempts=MAX_ARCHIVE_RETRIES)
        scheduled: list[int] = []
        with patch.object(self.service, "_schedule_archive", new=scheduled.append):
            self.service._sync([job])
        row = self.store.job(job["id"])
        self.assertEqual(row["status"], "failed")
        self.assertEqual(row["archive_retries"], MAX_ARCHIVE_RETRIES)
        self.assertEqual(scheduled, [], "到顶后不再自动重试，等手动按钮")

    def test_retry_ignores_fresh_failures(self):
        """刚失败不到 30 秒的不重试，避免前端轮询高频触发。"""
        job = self.make_failed_job()
        self.store.set_status(job["id"], "failed", error="归档失败：内容缺失")
        scheduled: list[int] = []
        with patch.object(self.service, "_schedule_archive", new=scheduled.append):
            self.service._sync([self.store.job(job["id"])])
        self.assertEqual(scheduled, [])

    def test_manual_retry_resets_counter(self):
        job = self.make_failed_job(attempts=MAX_ARCHIVE_RETRIES)
        with patch.object(self.service, "_schedule_archive", new=lambda _id: None):
            self.service.retry_archive(job["id"])
        row = self.store.job(job["id"])
        self.assertEqual(row["status"], "processing")
        self.assertEqual(row["archive_retries"], 0)

    def test_sync_all_picks_up_retryable_failures(self):
        """后台心跳不依赖前端停在哪个页签：sync_all 自己找到待重试的任务。"""
        job = self.make_failed_job()
        scheduled: list[int] = []
        with patch.object(self.service, "_schedule_archive", new=scheduled.append):
            self.service.sync_all()
        self.assertEqual(scheduled, [job["id"]])
        self.assertEqual(self.store.job(job["id"])["archive_retries"], 1)

    def test_failure_message_shows_attempt_count(self):
        job = self.make_failed_job(attempts=2)
        self.service._mark_archive_failed(job["id"], OfflineError("文件不见了"))
        row = self.store.job(job["id"])
        self.assertTrue(row["error"].startswith("归档失败：文件不见了"))
        self.assertIn("自动重试 2/", row["error"])


class BackgroundWorkerTest(unittest.TestCase):
    def test_worker_starts_once_and_returns_stop(self):
        tmp = tempfile.TemporaryDirectory()
        try:
            db = database.HandbookDB(Path(tmp.name) / "handbook.db", asset_root=Path(tmp.name))
            from handbook import offline_service

            stop = offline_service.start_background_worker(
                lambda: db, threading.Event(), interval=3600
            )
            again = offline_service.start_background_worker(
                lambda: db, threading.Event(), interval=3600
            )
            self.assertIs(stop, again, "重复启动返回同一个停止信号，不开第二条心跳")
            stop.set()
        finally:
            tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
