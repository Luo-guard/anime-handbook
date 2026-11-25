"""任务状态不能被旧快照「倒回去」。

后台有好几处在写同一个任务：进度轮询（3 秒一拍）、批量队列、归档线程、用户点暂停。
以前都是「读出来 → 改 → 整行写回」，谁后写谁赢，于是会出现：

- 一集刚入库，下一拍拿的是旧快照，又写回「下载中 / 正在整理」；
- 失败原因刚写进去，下一拍把它清空；
- 批量下载完成的那一刻，`_await_web_task` 把已经 ready 的任务改回 processing。

现在这些写入都带「只允许从哪些状态改」的条件（同一条 SQL 里判断 + 写入），这里守住它。
"""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from handbook import database, offline_config, offline_service, web_download
from handbook.offline import OfflineStore
from handbook.offline_service import OfflineService


class FakeWebTask:
    def __init__(self, status="downloading", progress=0.5, paused=False, error=""):
        self.total_bytes = 100
        self._snapshot = {
            "status": status, "progress": progress, "paused": paused, "error": error,
            "bytes": int(100 * progress), "speed": 10, "segments": 4, "done_segments": 2,
        }

    def snapshot(self):
        return dict(self._snapshot)


class FakeQB:
    def __init__(self, task):
        self.task = task

    def torrent(self, _hash):
        return self.task


class StatusGuardTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.media = self.root / "media"
        self.media.mkdir()
        self.db = database.HandbookDB(self.root / "handbook.db", asset_root=self.root)
        offline_config.save(self.root, {"media_root": str(self.media)})
        self.store = OfflineStore(self.db)
        self.service = OfflineService(self.db)

    def tearDown(self):
        self.tmp.cleanup()

    def job(self, *, status, source_kind="web", episode_key="0:1", torrent_hash=""):
        return self.store.create_job(
            anime_id=11, episode_key=episode_key, status=status,
            source_kind=source_kind, torrent_hash=torrent_hash, torrent_name="测试任务",
        )

    # ---- 存储层：条件写入 ----

    def test_a_stale_poll_cannot_pull_a_ready_job_back(self):
        job = self.job(status="ready")
        self.store.set_status(
            int(job["id"]), "downloading", progress=40, error="",
            allow_from=("queued", "downloading"),
        )
        fresh = self.store.job(int(job["id"])) or {}
        self.assertEqual(fresh.get("status"), "ready", "已入库不能被旧快照改回下载中")
        self.assertNotEqual(float(fresh.get("progress") or 0), 40)

    def test_a_stale_poll_cannot_clear_the_failure_reason(self):
        job = self.job(status="failed")
        self.store.set_status(int(job["id"]), "failed", error="解析这一集失败：这条线路没有这一集")
        self.store.set_status(
            int(job["id"]), "downloading", progress=10, error="",
            allow_from=("queued", "downloading"),
        )
        fresh = self.store.job(int(job["id"])) or {}
        self.assertEqual(fresh.get("status"), "failed")
        self.assertIn("解析这一集失败", str(fresh.get("error")), "失败原因不能被下一拍清掉")

    def test_progress_still_updates_while_the_job_is_downloading(self):
        job = self.job(status="downloading")
        self.store.set_status(
            int(job["id"]), "downloading", progress=42, error="",
            allow_from=("queued", "downloading"),
        )
        fresh = self.store.job(int(job["id"])) or {}
        self.assertEqual(fresh.get("status"), "downloading")
        self.assertAlmostEqual(float(fresh.get("progress") or 0), 42)

    def test_archive_finished_midway_is_not_turned_back_into_processing(self):
        job = self.job(status="ready")
        self.store.set_status(
            int(job["id"]), "processing", progress=100, error="",
            allow_from=("queued", "downloading", "failed", "processing"),
        )
        self.assertEqual((self.store.job(int(job["id"])) or {}).get("status"), "ready")

    # ---- 同步循环：旧快照不生效 ----

    def test_web_poll_does_not_turn_a_finished_job_back_into_downloading(self):
        job = self.job(status="ready")
        stale = dict(job)
        stale["status"] = "downloading"      # 上一拍拿到的快照
        with patch.object(web_download, "get", return_value=FakeWebTask(progress=0.62)):
            self.service._sync([stale])
        fresh = self.store.job(int(job["id"])) or {}
        self.assertEqual(fresh.get("status"), "ready", "网站资源下完了又被写回下载中")

    def test_bt_poll_does_not_clear_a_failure_reason(self):
        """旧快照还在「下载中」，qB 也说在下载：不能把已经记下的失败原因抹掉。"""
        job = self.job(status="failed", source_kind="", torrent_hash="b" * 40)
        self.store.set_status(int(job["id"]), "failed", error="下载出错")
        stale = dict(job)
        stale["status"] = "downloading"
        task = {"hash": job["torrent_hash"], "name": "测试任务", "size": 100, "progress": 0.5,
                "state": "downloading", "dlspeed": 10, "upspeed": 0, "eta": 5, "num_seeds": 1}
        with patch.object(OfflineService, "client", return_value=FakeQB(task)):
            self.service._sync([stale])
        fresh = self.store.job(int(job["id"])) or {}
        self.assertEqual(fresh.get("status"), "failed")
        self.assertIn("下载出错", str(fresh.get("error")), "失败原因不能被下一拍清掉")

    def test_bt_poll_does_not_reschedule_archive_for_a_finished_job(self):
        job = self.job(status="ready", source_kind="", torrent_hash="a" * 40)
        stale = dict(job)
        stale["status"] = "downloading"
        task = {"hash": job["torrent_hash"], "name": "测试任务", "size": 100, "progress": 1.0,
                "state": "uploading", "dlspeed": 0, "upspeed": 0, "eta": 0, "num_seeds": 0}
        with patch.object(OfflineService, "client", return_value=FakeQB(task)), \
                patch.object(OfflineService, "_schedule_archive") as schedule:
            self.service._sync([stale])
        self.assertEqual((self.store.job(int(job["id"])) or {}).get("status"), "ready")
        schedule.assert_not_called()

    # ---- 重启后卡住的「正在整理」自愈 ----

    def test_a_job_stuck_in_processing_is_archived_again(self):
        job = self.job(status="processing")
        with patch.object(web_download, "get", return_value=None), \
                patch.object(OfflineService, "_schedule_archive") as schedule:
            self.service._sync([dict(job)])
        schedule.assert_called_once_with(int(job["id"]))

    def test_a_running_archive_is_not_scheduled_twice(self):
        job = self.job(status="processing")
        with offline_service._ARCHIVE_LOCK:
            offline_service._ARCHIVING.add((self.service._web_owner(), int(job["id"])))
        try:
            with patch.object(web_download, "get", return_value=None), \
                    patch.object(OfflineService, "_schedule_archive") as schedule:
                self.service._sync([dict(job)])
            schedule.assert_not_called()
        finally:
            with offline_service._ARCHIVE_LOCK:
                offline_service._ARCHIVING.discard((self.service._web_owner(), int(job["id"])))


if __name__ == "__main__":
    unittest.main()
