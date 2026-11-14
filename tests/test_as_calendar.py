import json
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import schedule
from handbook.animeschedule import AnimeScheduleService
from handbook.as_calendar import ASCalendar, build_calendar, image_path, week_key
from handbook.settings_service import normalize_settings


def event(number=6, at="2026-11-05T21:00:00+08:00", kind="raw", route="fixture"):
    return {"route": route, "episodeNumber": number, "episodeDate": at, "airType": kind,
            "native": "テスト", "title": "Fixture", "imageVersionRoute": "anime/jpg/default/fixture.jpg"}


class ASCalendarTest(unittest.TestCase):
    def test_week_validation_and_0400_year_boundary(self):
        self.assertEqual(week_key(now=datetime(2027, 1, 4, 3, tzinfo=timezone.utc).astimezone(timezone.utc)), "2027-W01")
        self.assertEqual(week_key(now=datetime(2027, 1, 3, 19, 59, tzinfo=timezone.utc)), "2026-W53")
        self.assertEqual(week_key(now=datetime(2027, 1, 3, 20, tzinfo=timezone.utc)), "2027-W01")
        self.assertEqual(week_key("2026-W53"), "2026-W53")
        for value in ("2025-W53", "2026-W00", "../../secret", "2026-W99"):
            with self.assertRaises(ValueError):
                week_key(value)

    def test_raw_sub_deduplicated_and_dub_excluded(self):
        doc = build_calendar("2026-W45", [event(), event(at="2026-11-05T21:01:00+08:00", kind="sub"), event(kind="dub")])
        self.assertEqual(len(doc["items"]), 1)
        self.assertEqual(doc["items"][0]["bj_time"], "21:00")

    def test_delayed_slot_is_visible_but_not_counted_as_released(self):
        rows = [dict(event(6), airingStatus="delayed-air"), event(5, "2026-10-29T21:00:00+08:00")]
        result = build_calendar("2026-W45", rows)["items"][0]
        self.assertTrue(result["delayed"])
        self.assertEqual(result["bj_time"], "")
        self.assertEqual(result["as_airing"]["aired"], 5)

    def test_midnight_next_monday_belongs_to_sunday(self):
        rows = [event(at="2026-11-09T03:59:00+08:00"), event(7, at="2026-11-09T04:00:00+08:00")]
        result = build_calendar("2026-W45", rows)["items"]
        self.assertEqual(len(result), 1)
        self.assertEqual((result[0]["weekday"], result[0]["bj_weekday"]), (7, 1))
        self.assertEqual(result[0]["bj_time"], "03:59")

    def test_previous_week_stream_prevents_recounting_this_week_tv(self):
        rows = [event(5, "2026-10-29T21:00:00+08:00", "sub"),
                event(5, "2026-11-05T21:00:00+08:00", "raw"),
                event(6, "2026-11-05T22:00:00+08:00", "sub")]
        result = build_calendar("2026-W45", rows)["items"]
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["tags"], ["第 6 集"])
        self.assertEqual(result[0]["bj_time"], "22:00")

    def test_batch_release_and_multiple_days_have_stable_keys(self):
        rows = [event(1), event(2), event(3), event(4, at="2026-11-06T21:00:00+08:00")]
        items = build_calendar("2026-W45", rows)["items"]
        self.assertEqual(len(items), 2)
        self.assertEqual(items[0]["tags"], ["本日 3 集"])
        self.assertEqual([x["key"] for x in items], [x["key"] for x in build_calendar("2026-W45", list(reversed(rows)))["items"]])

    def test_reuse_identity_preserves_source_membership(self):
        doc = build_calendar("2026-W45", [event()], {"fixture": {"bgm_id": "123", "name_cn": "中文名称"}})
        item = doc["items"][0]
        self.assertEqual((item["id"], item["title"]), (123, "中文名称"))
        result = schedule.attach_collection(doc, [{"id": 123, "collection_type": 1}, {"id": 456, "name_cn": "其他", "collection_type": 2}])
        self.assertEqual(len(result["items"]), 1)
        self.assertEqual(result["items"][0]["local_id"], 123)

    def test_unmapped_as_title_does_not_bind_local_collection(self):
        doc = build_calendar("2026-W45", [event()])
        result = schedule.attach_collection(doc, [{"id": 99, "name_cn": "テスト", "collection_type": 1}])
        self.assertIsNone(result["items"][0]["local_id"])

    def test_one_route_shared_by_multiple_bgm_ids_remains_unmapped(self):
        with tempfile.TemporaryDirectory() as root:
            service = AnimeScheduleService(root)
            service._write("external-ids.json", [{"bgm_id": str(i), "mal_id": "12", "anilist_id": "34"} for i in (1, 2)])
            cal = ASCalendar(service)
            cal.catalogue = {"fixture": {"route": "fixture", "websites": {"mal": "myanimelist.net/anime/12", "aniList": "anilist.co/anime/34"}}}
            self.assertEqual(cal.identities(), {})

    def test_calendar_bindings_reused_without_duplicate_metadata_requests(self):
        with tempfile.TemporaryDirectory() as root:
            service = AnimeScheduleService(root)
            cal = ASCalendar(service)
            cal.catalogue = {"fixture": {"route": "fixture", "episodes": 12, "_fetched_at": time.time()}}
            cal._cache_bindings({"fixture": {"bgm_id": "1"}})
            service.mapping = {"1": {"mal_id": "12", "anilist_id": "34"}}
            with patch.object(service, "ensure_mapping"), patch.object(service, "_refresh_weeks"), patch.object(service, "_get", side_effect=AssertionError("duplicate request")):
                service.refresh([1])
            self.assertEqual(service.cache["records"]["1"]["route"], "fixture")
            self.assertEqual(service.cache["records"]["1"]["total"], 12)

    def test_unconfigured_returns_visible_error_without_network(self):
        with tempfile.TemporaryDirectory() as root, patch.dict("os.environ", {"ANIMESCHEDULE_TOKEN": ""}):
            cal = ASCalendar(AnimeScheduleService(root))
            with patch.object(cal, "_refresh", side_effect=AssertionError("network")):
                result = cal.get("202610", week="2026-W45")
            self.assertIn("令牌", result["error"])
            self.assertFalse(result["loading"])

    def test_cached_calendar_survives_refresh_failure(self):
        with tempfile.TemporaryDirectory() as root:
            service = AnimeScheduleService(root)
            cal = ASCalendar(service)
            cal._write("2026-W45.json", build_calendar("2026-W45", [event()]))
            cal.jobs.add("2026-W45")
            with patch.object(service, "ensure_mapping", side_effect=TimeoutError()), patch("handbook.as_calendar.record_failure"):
                cal._refresh("2026-W45")
            self.assertEqual(len(cal._read("2026-W45.json", {})["items"]), 1)
            self.assertFalse(cal.jobs)
            self.assertIn("2026-W45", cal.errors)

    def test_schedule_cache_expires_after_six_hours_and_can_be_refreshed(self):
        key = "2026-W45"
        now = 1_800_000_000
        with tempfile.TemporaryDirectory() as root:
            service = AnimeScheduleService(root)
            for age, force, expected in ((21599, False, False), (21600, False, True), (60, True, True)):
                with self.subTest(age=age, force=force):
                    cal = ASCalendar(service)
                    cal._write(key + ".json", {**build_calendar(key, [event()]), "fetched_at": now - age})
                    service.cache["weeks"]["2026-45"] = {"schema": 3, "fetched": now - age, "rows": [event()]}
                    with patch("handbook.as_calendar.time.time", return_value=now), \
                            patch("handbook.as_calendar.threading.Thread") as worker, \
                            patch.object(service, "token", return_value="fixture"), \
                            patch.object(service, "_get", return_value=[event()]) as request:
                        result = cal.get("202610", week=key, refresh=force)
                        self.assertEqual(len(result["items"]), 1)
                        self.assertEqual(result["loading"], expected)
                        if expected:
                            self.assertEqual(worker.call_args.kwargs["args"], (key, force))
                        else:
                            worker.assert_not_called()
                        service.week_rows(2026, 45, force=force)
                        self.assertEqual(request.call_count, int(expected))

    def test_image_path_blocks_arbitrary_hosts_traversal_and_queries(self):
        self.assertEqual(image_path("anime/jpg/default/a.jpg"), "anime/jpg/default/a.jpg")
        for value in ("https://evil.test/a.jpg", "anime/../../token.txt", "anime/jpg/a.jpg?x=1", "anime/jpg/a.svg"):
            self.assertEqual(image_path(value), "")

    def test_third_source_settings(self):
        settings, _, _ = normalize_settings({"schedule_source": "as"}, {})
        self.assertEqual(settings["schedule_source"], "as")


if __name__ == "__main__":
    unittest.main()
