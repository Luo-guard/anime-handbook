"""归档失败的恢复路径：方括号集数识别 + 手动/自动重试（有次数上限）。"""
from __future__ import annotations

import unittest

from handbook import media
from handbook.offline_service import MAX_ARCHIVE_RETRIES, OfflineService


class BracketEpisodeTests(unittest.TestCase):
    def test_standard_subgroup_name(self):
        # 用户实际卡住的那个种子标题：集数只在方括号里。
        name = "[云光字幕组] 学生会也有洞！ Seitokai ni mo Ana wa Aru! [05][简体双语][1080p]招募翻译.mp4"
        self.assertEqual(media.episode_number(name), 5)

    def test_labelled_bracket_and_plain_number(self):
        self.assertEqual(media.episode_number("[组] 番 [第07话][BDRip].mp4"), 7)
        self.assertEqual(media.episode_number("[组] 番 [EP12].mkv"), 12)
        self.assertEqual(media.episode_number("番名 - 12.mkv"), 12)

    def test_resolution_year_and_bitrate_are_not_episodes(self):
        for name in ("[组] 番 [1080p][10bit].mkv", "[组] 番 [2026].mkv", "[组] 番 [x265].mkv"):
            with self.subTest(name=name):
                self.assertEqual(media.episode_number(name), 0)


class _StubStore:
    """只记录 set_status 调用，不连数据库。"""

    def __init__(self):
        self.statuses: list[tuple[int, str, dict]] = []

    def set_status(self, media_id: int, status: str, **fields) -> None:
        self.statuses.append((int(media_id), status, fields))


class _RecordingService(OfflineService):
    def __init__(self):  # 不连数据库、不连 qB
        self.scheduled: list[int] = []
        self.store = _StubStore()

    def _schedule_archive(self, media_id: int) -> None:
        self.scheduled.append(int(media_id))


class AutoRetryTests(unittest.TestCase):
    def setUp(self):
        self.service = _RecordingService()

    @staticmethod
    def job(**overrides):
        base = {
            "id": 7,
            "status": "failed",
            "error": "归档失败：下载目录里没有找到视频文件",
            "updated_at": "2026-11-06T10:00:00+08:00",
            "torrent_hash": "abc",
            "archive_retries": 0,
        }
        base.update(overrides)
        return base

    def test_archive_failure_is_retried_on_refresh(self):
        self.service._sync([self.job()])
        self.assertEqual(self.service.scheduled, [7])
        # 重试前先把计数 +1 并记为 processing，避免下一次轮询重复排程。
        self.assertEqual(self.service.store.statuses, [(7, "processing", {"error": "", "archive_retries": 1})])

    def test_other_failures_are_not_retried(self):
        self.service._sync([self.job(error="文件缺失，可能被移动或删除")])
        self.assertEqual(self.service.scheduled, [])

    def test_recent_failure_waits_before_retrying(self):
        self.service._sync([self.job(updated_at="2099-01-01T00:00:00+08:00")])
        self.assertEqual(self.service.scheduled, [])

    def test_retry_stops_at_limit(self):
        self.service._sync([self.job(archive_retries=MAX_ARCHIVE_RETRIES)])
        self.assertEqual(self.service.scheduled, [], "到顶后不再自动重试，等手动按钮")
        self.assertEqual(self.service.store.statuses, [])

    def test_active_jobs_are_left_to_the_normal_flow(self):
        self.service._sync([self.job(status="failed", error="归档失败：x"), self.job(id=8, status="ready")])
        self.assertEqual(self.service.scheduled, [7])



class _PauseClient:
    def __init__(self, state: str = "pausedDL"):
        self.state = state
        self.calls: list[tuple[str, tuple[str, ...]]] = []

    def pause(self, hashes):
        self.calls.append(("pause", tuple(hashes)))

    def resume(self, hashes):
        self.calls.append(("resume", tuple(hashes)))

    def torrent(self, _hash):
        return {"state": self.state, "progress": 0.4, "dlspeed": 0, "upspeed": 0, "eta": 0, "num_seeds": 2, "size": 100}


class _JobStore:
    def __init__(self, job):
        self.row = dict(job)
        self.statuses: list[tuple[int, str, dict]] = []

    def job(self, _media_id):
        return dict(self.row)

    def set_status(self, media_id, status, **fields):
        self.statuses.append((int(media_id), status, dict(fields)))
        self.row["status"] = status
        if "error" in fields:
            self.row["error"] = fields["error"]
        return dict(self.row)


class _PauseService(OfflineService):
    def __init__(self, client, job):
        self._client = client
        self.store = _JobStore(job)
        self.scheduled: list[int] = []

    def client(self, config=None):
        return self._client

    def _schedule_archive(self, media_id):
        self.scheduled.append(int(media_id))


class PauseStateTests(unittest.TestCase):
    """审计 N17：「已暂停」不再借 error 字段传，态由 live.paused 表达。"""

    @staticmethod
    def job(**overrides):
        base = {"id": 3, "status": "downloading", "error": "", "torrent_hash": "abc",
                "created_at": "2026-11-06T10:00:00+08:00", "archive_retries": 0}
        base.update(overrides)
        return base

    def test_qb_paused_states_are_recognised(self):
        from handbook.offline_service import is_paused_state

        # qB 4 用 pausedDL，qB 5 改名 stoppedDL；做种那边同理。
        for state in ("pausedDL", "stoppedDL", "pausedUP", "stoppedUP"):
            with self.subTest(state=state):
                self.assertTrue(is_paused_state(state))
        for state in ("downloading", "stalledDL", "uploading", "checkingDL", "error", ""):
            with self.subTest(state=state):
                self.assertFalse(is_paused_state(state))

    def test_pause_does_not_write_a_fake_error(self):
        client = _PauseClient()
        service = _PauseService(client, self.job())
        result = service.task_action(3, "pause")
        self.assertEqual(client.calls, [("pause", ("abc",))])
        self.assertTrue(result["paused"])
        for record in service.store.statuses:
            self.assertNotIn("error", record[2], "暂停不是错误，不能写进 error")
        self.assertEqual(service.store.row["status"], "downloading")

    def test_resume_clears_the_error(self):
        service = _PauseService(_PauseClient(), self.job(error="旧提示"))
        result = service.task_action(3, "resume")
        self.assertFalse(result["paused"])
        self.assertEqual(service.store.row["error"], "")

    def test_sync_reports_paused_flag(self):
        client = _PauseClient("stoppedDL")
        service = _PauseService(client, self.job(error="已暂停"))
        live = service._sync([self.job(error="已暂停")])
        self.assertTrue(live[3]["paused"])
        # 同时把之前混进 error 的「已暂停」清掉，error 只留真错误。
        self.assertEqual(service.store.row["error"], "")

    def test_sync_reports_not_paused_while_downloading(self):
        service = _PauseService(_PauseClient("downloading"), self.job())
        live = service._sync([self.job()])
        self.assertFalse(live[3]["paused"])


if __name__ == "__main__":
    unittest.main()
