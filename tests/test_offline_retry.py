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


if __name__ == "__main__":
    unittest.main()
