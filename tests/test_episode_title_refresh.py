from datetime import datetime, timedelta
from io import BytesIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from handbook.airing import BEIJING
from handbook.database import HandbookDB
from handbook.metadata import SyncService


class EpisodeTitleRefreshTest(unittest.TestCase):
    def test_overdue_missing_title_does_not_wait_for_next_episode(self):
        item = {"episodes": [
            {"type": 0, "sort": 22, "airdate": "2026-11-19", "name": ""},
            {"type": 0, "sort": 21, "airdate": "2026-11-12", "name": ""},
        ]}
        now = datetime(2026, 11, 19, 16, tzinfo=BEIJING)
        airtimes = {22: datetime(2026, 11, 19, 22, tzinfo=BEIJING)}
        self.assertIsNone(SyncService._episode_check_after(item, {}, now, airtimes))

    def test_subject_failure_does_not_skip_scheduled_episode_refresh(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            db = HandbookDB(root / "handbook.db", asset_root=root)
            db.import_kazumi([{"id": 12, "type": 1, "name": "作品"}])
            episode = {"id": 721, "type": 0, "sort": 21, "name": ""}
            db.update_bgm_metadata(12, episode_count=1, episodes=[episode],
                                   episode_titles_synced=True, rating_synced=True, rating_score=7.5)
            service = SyncService(db)
            with patch.object(service._airtime_schedule, "airtime_index", return_value={}), patch.object(
                service, "fetch_bgm", side_effect=HTTPError("https://api.bgm.tv", 503, "unavailable", {}, None),
            ), patch.object(service, "fetch_bgm_episodes", return_value=[{**episode, "name": "無理解", "name_cn": "误会"}]) as fetch:
                self.assertEqual(service.enrich_missing(), 1)
                fetch.assert_called_once_with(12)
            anime = db.get_anime(12)
            self.assertEqual(anime["episodes"][0]["name_cn"], "误会")
            self.assertEqual(anime["bgm_score"], 7.5)
            self.assertTrue(anime["episode_release_synced_at"])

    def test_waits_one_hour_after_cached_airtime(self):
        item = {"episodes": [{"type": 0, "airdate": "2026-11-15", "name": "", "name_cn": ""}]}
        slot = {"source_weekday": 7, "source_time": "24:00"}
        before = datetime(2026, 11, 15, 21, tzinfo=BEIJING)
        due = datetime(2026, 11, 16, 0, tzinfo=BEIJING)
        self.assertEqual(SyncService._episode_check_after(item, slot, before), due)
        self.assertIsNone(SyncService._episode_check_after(item, slot, due))
        self.assertIsNone(SyncService._episode_check_after(item, {}, before))
        item["episodes"][0]["sort"] = 8
        earlier = datetime(2026, 11, 15, 22, tzinfo=BEIJING)
        self.assertEqual(SyncService._episode_check_after(item, slot, before, {8: earlier}), earlier + timedelta(hours=1))

    def test_original_only_new_episode_uses_same_deferred_check(self):
        now = datetime(2026, 11, 19, 18, tzinfo=BEIJING)
        item = {"episodes": [
            {"type": 0, "sort": 6, "airdate": "2026-11-12", "name": "前回"},
            {"type": 0, "sort": 7, "airdate": "2026-11-19", "name": "新しい話"},
        ]}
        air = now.replace(hour=22)
        airtimes = {6: air - timedelta(days=7), 7: air}
        due = air + timedelta(hours=1)
        self.assertEqual(SyncService._episode_check_after(item, {}, now, airtimes), due)
        self.assertIsNone(SyncService._episode_check_after(item, {}, due, airtimes))
        item["episodes"][1]["name_cn"] = "新一集"
        self.assertIsNone(SyncService._episode_check_after(item, {}, now, airtimes))

    def test_empty_result_does_not_replace_episodes_or_mark_release_current(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            db = HandbookDB(root / "handbook.db", asset_root=root)
            db.import_kazumi([{"id": 12, "type": 1, "name": "作品"}])
            episode = {"id": 701, "type": 0, "sort": 7, "name_cn": "已保存的集名"}
            db.update_bgm_metadata(12, episode_count=7, episodes=[episode], aired_episode_count=7)
            service = SyncService(db)
            saved = db.get_anime(12)
            with patch.object(service._airtime_schedule, "airtime_index", return_value={}), patch.object(
                service, "fetch_bgm", return_value={"id": 12, "total_episodes": 7},
            ), patch.object(service, "fetch_bgm_episodes", return_value=[]) as fetch:
                service.enrich_missing()
                fetch.assert_called_once_with(12)
                self.assertFalse(service.enrich_episode_titles(12)["episode_titles_synced"])
            current = db.get_anime(12)
            for field in ("episodes", "episode_release_synced_at", "aired_episode_count"):
                self.assertEqual(current[field], saved[field])

    def test_interrupted_pagination_is_not_accepted_as_a_complete_episode_list(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            service = SyncService(HandbookDB(root / "handbook.db", asset_root=root))
            pages = [{"total": 2, "data": [{"id": 701}]}, {"total": 2, "data": []}]
            with patch.object(service, "_wait_for_episode_request_slot"), patch(
                "urllib.request.urlopen", side_effect=[BytesIO(json.dumps(page).encode()) for page in pages],
            ) as request:
                with self.assertRaisesRegex(ValueError, "章节列表不完整"):
                    service.fetch_bgm_episodes(12)
                self.assertEqual(request.call_count, 2)

    def test_daily_request_supplies_titles_without_repeating_when_current(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            db = HandbookDB(root / "handbook.db", asset_root=root)
            db.import_kazumi([{"id": 12, "type": 1, "name": "作品"}])
            old = [
                {"id": 701, "type": 0, "sort": 7, "name": "第七話", "name_cn": "第七话"},
                {"id": 702, "type": 0, "sort": 8, "name": ""},
            ]
            db.update_bgm_metadata(12, episode_count=8, episodes=old, episode_titles_synced=True, rating_synced=True)
            service = SyncService(db)
            upstream = [
                {**old[0], "name": "", "name_cn": ""},
                {**old[1], "name": "それはピンクの爆弾", "name_cn": "那是粉红色炸弹"},
            ]
            due = datetime.now().astimezone() + timedelta(hours=1)
            with patch.object(service._airtime_schedule, "airtime_index", return_value={12: {"source_time": "24:00"}}), patch.object(
                service, "_episode_check_after", side_effect=[due, None],
            ), patch.object(service, "fetch_bgm", return_value={"id": 12, "total_episodes": 8}), patch.object(
                service, "fetch_bgm_episodes", return_value=upstream,
            ) as fetch:
                self.assertEqual(service.enrich_missing(), 0)
                service.start_due_episode_checks()
                fetch.assert_not_called()
                service._deferred_episode_checks[12] = due - timedelta(hours=2)
                service.start_due_episode_checks()
                with service._lock:
                    pass
                self.assertEqual(service.enrich_missing(), 0)
                fetch.assert_called_once_with(12)
            episodes = db.get_anime(12)["episodes"]
            self.assertEqual([episode["name_cn"] for episode in episodes], ["第七话", "那是粉红色炸弹"])
            db.update_bgm_metadata(12, episode_count=9, episodes=None, rating_synced=True)
            self.assertEqual(db.get_anime(12)["episodes"], episodes)
