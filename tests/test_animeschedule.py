import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from handbook.animeschedule import AnimeScheduleService, choose_match, compute_progress, progress_weeks, title_key
from handbook.settings_service import normalize_settings


def candidate(route="correct", mal="12", al="34", db="56"):
    return {"route": route, "websites": {
        "mal": f"myanimelist.net/anime/{mal}/title",
        "aniList": f"anilist.co/anime/{al}/title",
        "anidb": f"anidb.net/anime/{db}",
    }}


class AnimeScheduleTest(unittest.TestCase):
    def test_id_match_requires_corroboration(self):
        row = candidate()
        self.assertIs(choose_match({"mal_id": "12", "anilist_id": "34"}, [row]), row)
        self.assertIsNone(choose_match({"mal_id": "12"}, [row]))

    def test_conflicting_id_or_multiple_routes_rejected(self):
        ids = {"mal_id": "12", "anilist_id": "34", "anidb_id": "56"}
        self.assertIsNone(choose_match(ids, [candidate(db="57")]))
        self.assertIsNone(choose_match(ids, [candidate("part-1"), candidate("part-2")]))
        self.assertIsNotNone(choose_match(ids, [candidate(), candidate("short", mal="99", al="98")]))

    def test_progress_uses_released_events_not_next_episode_minus_one(self):
        now = datetime(2026, 11, 5, tzinfo=timezone.utc)
        rows = [
            {"route": "show", "airType": "raw", "episodeNumber": 6, "episodeDate": "2026-11-02T21:00:00+08:00"},
            {"route": "show", "airType": "sub", "episodeNumber": 7, "episodeDate": "2026-11-09T21:01:00+08:00"},
            {"route": "show", "airType": "dub", "episodeNumber": 9, "episodeDate": "2026-11-01T00:00:00Z"},
        ]
        result = compute_progress("show", rows, 12, now)
        self.assertEqual((result["aired"], result["total"], result["next_episode"]), (6, 12, 7))
        self.assertEqual(result["next_label"], "11/09 21:01")
        self.assertEqual(result["latest_aired_at"], "2026-11-02T21:00:00+08:00")
        self.assertIsNone(compute_progress("show", rows[1:2], 12, now))

    def test_raw_sub_same_episode_earliest_time_and_batch_number(self):
        now = datetime(2026, 11, 5, 12, tzinfo=timezone.utc)
        rows = [
            {"route": "show", "airType": "raw", "episodeNumber": 6, "episodeDate": "2026-11-05T13:00:00Z"},
            {"route": "show", "airType": "sub", "episodeNumber": 6, "episodeDate": "2026-11-05T12:00:00Z", "episodes": 12},
        ]
        self.assertEqual(compute_progress("show", rows, now=now)["aired"], 6)
        self.assertEqual(compute_progress("show", rows, now=now)["total"], 12)

    def test_missing_invalid_dates_do_not_invent_progress(self):
        self.assertIsNone(compute_progress("x", [{"route": "x", "airType": "raw", "episodeNumber": 1, "episodeDate": "0001-01-01T00:00:00Z"}]))
        self.assertIsNone(compute_progress("x", []))

    def test_settings_independent_and_invalid_values_rejected(self):
        pending, _, _ = normalize_settings({
            "collection_airing_source": "as", "schedule_airing_source": "bgm", "detail_airtime_source": "yuc",
            "hide_missing_as_schedule": False,
        }, {})
        self.assertEqual(pending["collection_airing_source"], "as")
        self.assertEqual(pending["schedule_airing_source"], "bgm")
        self.assertEqual(pending["detail_airtime_source"], "yuc")
        self.assertIs(pending["hide_missing_as_schedule"], False)
        for value in (None, [], {}, "other", 1):
            with self.assertRaises(ValueError):
                normalize_settings({"schedule_airing_source": value}, {})
            with self.assertRaises(ValueError):
                normalize_settings({"detail_airtime_source": value}, {})

    def test_reads_do_not_fetch_when_unconfigured(self):
        with tempfile.TemporaryDirectory() as root, patch.dict("os.environ", {"ANIMESCHEDULE_TOKEN": ""}):
            service = AnimeScheduleService(root)
            with patch.object(service, "_get", side_effect=AssertionError("no network")):
                result = service.get_many([1])
            self.assertEqual(result["1"]["status"], "unconfigured")
            self.assertIsNone(service.worker)

    def test_refresh_and_reload_keep_id_binding_but_compute_time_again(self):
        with tempfile.TemporaryDirectory() as root:
            service = AnimeScheduleService(root)
            service.mapping = {"1": {"mal_id": "12", "anilist_id": "34"}}
            service.mapping_loaded = time.time()
            with patch.object(service, "_refresh_weeks"), patch.object(service, "_get", return_value={"anime": [candidate()], "totalAmount": 1}) as get:
                service.refresh([1])
                service.cache["records"]["1"]["fetched"] = 0
                service.refresh([1])
                self.assertEqual(get.call_count, 1)
            restored = AnimeScheduleService(root)
            self.assertEqual(restored.cache["records"]["1"]["route"], "correct")
            self.assertNotIn("token", Path(root, "progress.json").read_text())

    def test_detail_backfills_finished_status_without_inventing_progress(self):
        with tempfile.TemporaryDirectory() as root:
            service = AnimeScheduleService(root)
            service.cache["records"]["1"] = {"route": "correct", "total": 12}
            with patch.object(service, "token", return_value="configured"), patch.object(
                service, "_get", return_value={"route": "correct", "status": "Finished", "episodes": 12},
            ) as get:
                service.refresh_detail_status(1)
                service.refresh_detail_status(1)
            get.assert_called_once_with("anime/correct")
            restored = AnimeScheduleService(root)
            with patch.object(restored, "token", return_value=""):
                progress = restored.get_many([1])["1"]
            self.assertEqual(progress["show_status"], "finished")
            self.assertTrue(progress["unavailable"])
            self.assertNotIn("aired", progress)

    def test_detail_can_match_an_upcoming_anime_outside_the_timetable(self):
        with tempfile.TemporaryDirectory() as root:
            service = AnimeScheduleService(root)
            service.mapping = {"1": {"mal_id": "12", "anilist_id": "34"}}
            service.mapping_loaded = time.time()
            with patch.object(service, "token", return_value="configured"), patch.object(
                service, "_get", return_value={"anime": [{**candidate(), "status": "Upcoming"}]},
            ) as get:
                service.refresh_detail_status(1)
                service.refresh_detail_status(1)
            get.assert_called_once_with("anime?mal-ids=12&page=1")
            with patch.object(service, "token", return_value=""):
                self.assertEqual(service.get_many([1])["1"]["show_status"], "upcoming")

    def test_worker_failure_backs_off_without_poisoning_existing_cache(self):
        with tempfile.TemporaryDirectory() as root:
            service = AnimeScheduleService(root)
            service.cache["records"]["1"] = {"route": "correct"}
            service.pending[1] = None
            with patch.object(service, "refresh", side_effect=TimeoutError()), patch("handbook.animeschedule.record_failure"):
                service._run()
            self.assertGreater(service.retry_at, 0)
            self.assertEqual(service.cache["records"]["1"]["route"], "correct")
            self.assertFalse(service.inflight)

    def test_collection_looks_up_only_unlinked_titles_seen_in_timetable(self):
        with tempfile.TemporaryDirectory() as root:
            service = AnimeScheduleService(root)
            year, week = progress_weeks()[0]
            service.cache["weeks"][f"{year}-{week}"] = {"rows": [
                {"route": "correct", "native": "名探偵プリキュア！", "airType": "raw",
                 "episodeDate": "2020-02-01T08:30:00+08:00", "episodeNumber": 41},
                {"route": "known", "title": "Known", "airType": "raw"},
            ]}
            service.cache["records"]["3"] = {"route": "known", "fetched": 0}
            service.mapping = {str(i): {"mal_id": str(i), "anilist_id": "34"} for i in range(1, 4)}
            service.mapping_loaded = time.time()
            names = {1: {title_key("名探偵プリキュア!")}, 2: {"finished"}, 3: {"known"}}
            with patch.object(service, "_refresh_weeks"), patch.object(
                service, "_get", return_value={"anime": [candidate(mal="1")]},
            ) as get:
                service.refresh(names, titles=names)
                service.refresh(names, titles=names)
            get.assert_called_once_with("anime?mal-ids=1&page=1")
            self.assertEqual(service.get_many(names, titles=names)["1"]["aired"], 41)
            self.assertNotIn("2", service.cache["records"])


if __name__ == "__main__":
    unittest.main()
