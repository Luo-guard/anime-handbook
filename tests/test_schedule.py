from handbook import database, desktop, http

import json
import tempfile
import unittest
import threading
import urllib.request
import urllib.error
from email.message import Message
from pathlib import Path
from unittest.mock import patch

import schedule


HTML = """<div><table><tr><td class="date2">周一 (月)</td></tr></table></div>
<div style="float:left"><div class="div_date"><p class="imgtext4">25:30~</p><p class="imgep">10/5~</p><img data-src="https://i0.hdslb.com/test.jpg"></div>
<table><tr><td class="date_title_">测试番剧<br>第二季</td></tr><tr><td><a href="https://www.netflix.com/title/1"><p class="area">环大陆</p></a></td></tr></table></div>
<table><tr><td class="date2">网络放送 &amp; 其他</td></tr></table>
<div style="float:left"><div class="div_date_"><img data-src="https://i0.hdslb.com/network.jpg"></div><table><tr><td class="date_title_">网络番剧</td></tr><tr><td><p class="pmfs2">10/20网络放送</p><p class="pmex">(全10话)</p></td></tr></table></div>"""


class ScheduleTest(unittest.TestCase):
    def test_refresh_automatically_searches_missing_works_and_reuses_lookup_cache(self):
        with tempfile.TemporaryDirectory() as temp:
            service = schedule.ScheduleService(Path(temp))
            queries = []
            def fetch(url, *, body=None):
                if "yuc.wiki" in url:
                    return HTML.encode()
                if "/search/" in url:
                    queries.append(body["keyword"])
                    if "测试番剧" in body["keyword"]:
                        return json.dumps({"data": [{"id": 123, "name_cn": "测试番剧 第2期", "name": "Example Season2",
                            "rating": {"score": 7.1, "total": 321}, "tags": [{"name": "奇幻"}], "date": "2026-10-05"}]}).encode()
                    return b'{"data":[]}'
                return b'{}'
            with patch.object(service, "fetch", side_effect=fetch):
                service._refresh("202610")
                first = service.load("202610")
                weekly = next(row for row in first["items"] if row["kind"] == "weekly")
                self.assertEqual((weekly["id"], weekly["score"], weekly["votes"], weekly["time"]), (123, 7.1, 321, "01:30"))
                self.assertEqual(weekly["tags"], ["奇幻"])
                calls = len(queries)
                service._refresh("202610")
                self.assertEqual(len(queries), calls)

    def test_season_number_spellings_share_one_identity(self):
        names = ["佐佐木 第二季", "佐佐木第2期", "佐佐木 Season 2", "佐佐木 Season２", "佐佐木Ⅱ"]
        self.assertEqual(len({schedule.normalized_title(name) for name in names}), 1)
        candidate = {"id": 1, "aliases": ["佐佐木 第二季", "佐々木 第2期"]}
        for name in names:
            self.assertEqual(schedule.best_match([name], [candidate])["id"], 1)
        self.assertIsNone(schedule.best_match(["佐佐木 第3期"], [candidate]))
        self.assertIsNone(schedule.best_match(["佐佐木 Season2", "佐佐木"], [{"id": 2, "aliases": ["佐佐木"]}]))

    def test_full_original_title_wins_over_shared_franchise_alias(self):
        aliases = ["新网球王子", "新テニスの王子様 U-17 WORLD CUP 決勝メンバー決定戦"]
        candidates = [{"id": 1, "aliases": ["新网球王子"]}, {"id": 2, "aliases": [aliases[1]]}]
        self.assertEqual(schedule.best_match(aliases, candidates)["id"], 2)

    def test_catalog_fills_fields_missing_from_first_api(self):
        first = {"id": 1, "aliases": ["测试番剧"], "score": 0, "votes": 0, "tags": [], "air_date": "", "votes_known": False}
        second = {"id": 1, "aliases": ["原名"], "score": 6.5, "votes": 100, "tags": ["TV"], "air_date": "2026-10-01", "votes_known": True}
        row = schedule.metadata_catalog([first], [second])[0]
        self.assertEqual((row["score"], row["votes"], row["tags"], row["air_date"]), (6.5, 100, ["TV"], "2026-10-01"))
        self.assertTrue(row["votes_known"])
        self.assertEqual(first["tags"], [])

    def test_automatic_lookup_caches_positive_and_negative_results(self):
        with tempfile.TemporaryDirectory() as temp:
            service = schedule.ScheduleService(Path(temp))
            document = {"data": [{"id": 123, "name": "作品名 第2期", "name_cn": "作品名 第二季", "rating": {"score": 7, "total": 42}, "tags": [{"name": "TV"}]}]}
            with patch.object(service, "fetch", return_value=json.dumps(document).encode()) as fetch:
                row = service.resolve_metadata({"title": "作品名Season2", "aliases": ["作品名Season2"]})
                self.assertEqual(row["id"], 123)
                self.assertEqual(service.resolve_metadata({"title": "作品名Season2", "aliases": ["作品名Season2"]})["votes"], 42)
                self.assertEqual(fetch.call_count, 1)
            with patch.object(service, "fetch", return_value=b'{"data":[]}') as fetch:
                self.assertEqual(service.search_metadata("不存在的作品"), [])
                self.assertEqual(service.search_metadata("不存在的作品"), [])
                self.assertEqual(fetch.call_count, 1)

    def test_no_search_result_is_not_misrepresented_as_zero_voters(self):
        doc = {"items": [{"title": "unknown", "key": "a"}]}
        self.assertFalse(schedule.attach_collection(doc, [])["items"][0]["votes_known"])
        doc = {"items": [{"title": "known", "id": 1, "votes": 0, "votes_known": True}]}
        self.assertTrue(schedule.attach_collection(doc, [])["items"][0]["votes_known"])

    def test_supplemental_catalog_resolves_continuing_work_without_importing_old_season(self):
        yuc = [{"title": "本季仍在播放的作品", "aliases": ["本季仍在播放的作品"], "kind": "weekly", "weekday": 4,
                "time": "23:56", "release": "", "release_note": "(全26话)"}]
        previous = [
            {"id": 10, "title": "另一种译名", "aliases": ["另一种译名", "本季仍在播放的作品"], "kind": "weekly",
             "score": 4.9, "votes": 3400, "tags": ["漫画改"], "air_date": "2026-07-02"},
            {"id": 20, "title": "上季已完结的其他作品", "aliases": ["上季已完结的其他作品"], "kind": "weekly"},
        ]
        rows = schedule.merge_sources(yuc, [], supplemental=previous)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["id"], 10)
        self.assertEqual(rows[0]["time"], "23:56")
        self.assertEqual(rows[0]["score"], 4.9)
        self.assertEqual(rows[0]["release"], "7/2~")
        self.assertEqual(rows[0]["release_note"], "(全26话)")
        self.assertEqual(rows[0]["release_source"], "bangumi")

    def test_next_calendar_original_name_resolves_missing_season_metadata(self):
        document = {"4": [{"subject": {"id": 654294, "name": "冰剣の魔術師が世界を統べるⅡ",
            "nameCN": "冰剑的魔术师将要统一世界 第二季", "info": "12话 / 2026年10月8日 / staff",
            "metaTags": ["TV", "日本"], "rating": {"score": 5.54, "total": 46}}}]}
        supplement = schedule.parse_bangumi(document)
        self.assertEqual(supplement[0]["air_date"], "2026-10-08")
        row = {"title": "冰剑的魔术师将要统一世界 第2期", "aliases": ["冰剑的魔术师将要统一世界 第2期", "冰剣の魔術師が世界を統べるⅡ"],
               "kind": "weekly", "weekday": 4, "time": "00:58", "release": "10/8~"}
        rows = schedule.merge_sources([row], [], supplemental=supplement)
        self.assertEqual((rows[0]["id"], rows[0]["score"], rows[0]["votes"], rows[0]["release"]), (654294, 5.54, 46, "10/8~"))

    def test_time_color_does_not_change_field_semantics(self):
        for color_class in ["imgtext4", "imgtext5", "future-time-style"]:
            html = HTML.replace("imgtext4", color_class).replace("25:30~", "24:35~")
            row = schedule.parse_yuc(html)[0]
            self.assertEqual((row["weekday"], row["calendar_weekday"], row["time"]), (1, 2, "00:35"))
            self.assertEqual(row["source_time"], "24:35~")

    def test_premiere_badge_color_and_episode_count_are_separate_fields(self):
        row = schedule.parse_yuc(HTML.replace('class="imgep"', 'class="imgep2"'))[0]
        self.assertEqual(row["release"], "10/5~")
        row = schedule.parse_yuc(HTML.replace('10/5~', '(全24话)'))[0]
        self.assertEqual(row["release"], "")
        self.assertEqual(row["release_note"], "(全24话)")

    def test_public_calendar_can_use_publisher_http_when_certificate_expires(self):
        import ssl
        expired = ssl.SSLCertVerificationError("expired")
        expired.verify_code = 10
        service = schedule.ScheduleService(Path("unused-test-cache"))
        with patch.object(service, "fetch", side_effect=[urllib.error.URLError(expired), HTML.encode()]) as fetch:
            self.assertEqual(service.fetch_yuc("202610"), HTML.encode())
            self.assertEqual([call.args[0] for call in fetch.call_args_list], ["https://yuc.wiki/202610/", "http://yuc.wiki/202610/"])
        with patch.object(service, "fetch", side_effect=urllib.error.URLError("offline")) as fetch:
            with self.assertRaises(urllib.error.URLError):
                service.fetch_yuc("202610")
            self.assertEqual(fetch.call_count, 1)

    def test_short_calendar_title_resolves_through_explicit_introduction(self):
        html = HTML + '''<table><tr><td class="title_main_r">
          <p class="title_cn_r1">测试番剧<br>第二季</p>
          <p class="title_jp_r2">Example Animation<br>Second Season</p>
        </td></tr></table>'''
        # The schedule card uses only the main title, while the introduction
        # explicitly carries the full title and its original-language alias.
        html = html.replace('class="date_title_">测试番剧<br>第二季', 'class="date_title_">测试番剧')
        source = schedule.parse_yuc(html)
        self.assertIn("测试番剧第二季", source[0]["aliases"])
        metadata = [{"id": 123, "title": "测试番剧第二季", "aliases": ["测试番剧第二季", "Example Animation Second Season"],
                     "kind": "weekly", "weekday": 1, "score": 7.5, "votes": 120}]
        rows = schedule.merge_sources(source, metadata)
        self.assertEqual(len(rows), 2)  # one weekly item plus the unrelated network item
        weekly = next(row for row in rows if row["kind"] == "weekly")
        self.assertEqual((weekly["id"], weekly["time"], weekly["score"], weekly["votes"]), (123, "01:30", 7.5, 120))
        account = schedule.attach_collection({"items": rows}, [{"id": 123, "name_cn": "测试番剧第二季", "name": "", "collection_type": 1}])
        self.assertEqual(account["items"][0]["local_id"], 123)
        self.assertEqual(account["items"][0]["collection_type"], 1)

    def test_similar_title_is_not_a_main_title_alias_without_source_structure(self):
        html = HTML.replace('测试番剧<br>第二季', '测试番剧') + '''<table><tr><td class="title_main_r">
          <p class="title_cn_r">测试番剧第二季</p><p class="title_jp_r">Different Sequel</p>
        </td></tr></table>'''
        row = schedule.parse_yuc(html)[0]
        self.assertNotIn("测试番剧第二季", row["aliases"])

    def test_old_parser_cache_is_rebuilt_even_before_ttl(self):
        import time
        with tempfile.TemporaryDirectory() as temp:
            service = schedule.ScheduleService(Path(temp))
            (Path(temp) / "202610.json").write_text(json.dumps({"season": "202610", "items": [], "fetched_at": time.time()}))
            with patch("schedule.threading.Thread") as worker:
                self.assertTrue(service.get("202610")["loading"])
                self.assertEqual(worker.call_count, 1)

    def test_schedule_grouping_normalization(self):
        from handbook.common import normalize_schedule_grouping
        value = normalize_schedule_grouping({"mode": "status", "status_order": ["2", "uncollected"], "sorts": {"1": "score", "uncollected": "time"}})
        self.assertEqual(value["status_order"], ["2", "uncollected", "1", "3", "4", "5"])
        for invalid in [None, {"mode": "wrong"}, {"status_order": ["1", "1"]}, {"status_order": [{}]}, {"sorts": {"1": "invalid"}}, {"sorts": {"unknown": "score"}}, {"direction": "invalid"}, {"directions": {"1": "invalid"}}]:
            with self.assertRaises(ValueError):
                normalize_schedule_grouping(invalid)

    def test_settings_api_accepts_schedule_and_validates_filters(self):
        from handbook import common as app
        with tempfile.TemporaryDirectory() as temp:
            db = database.HandbookDB(Path(temp) / "test.db")
            server = app.ThreadingHTTPServer(("127.0.0.1", 0), http.RequestHandler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with patch.object(desktop, "DATABASE", db), patch.object(desktop, "require_active_profile_write_access"):
                    url = f"http://127.0.0.1:{server.server_port}/api/settings"
                    body = {"statistics_show_zero_periods": False, "show_shutdown_button": False, "schedule_grouping": {"mode": "collection", "collection_order": ["uncollected", "collected"], "sorts": {"collected": "score"}, "direction": "desc", "directions": {"collected": "asc"}}, "default_view": "schedule", "sidebar_visibility": {"schedule": False},
                            "sidebar_order": ["schedule", "collection"], "schedule_sort": "score",
                            "schedule_statuses": [1, 2], "schedule_uncollected": False, "schedule_card_fields": {"tags": False, "score": False}}
                    request = urllib.request.Request(url, data=json.dumps(body).encode(), method="PATCH", headers={"Content-Type": "application/json"})
                    result = json.load(urllib.request.urlopen(request))["settings"]
                    self.assertEqual(result["schedule_grouping"]["collection_order"], ["uncollected", "collected"])
                    self.assertEqual(result["schedule_grouping"]["directions"], {"collected": "asc"})
                    self.assertFalse(result["show_shutdown_button"])
                    self.assertEqual(result["default_view"], "schedule")
                    self.assertFalse(result["sidebar_visibility"]["schedule"])
                    self.assertEqual(result["sidebar_order"][:2], ["schedule", "collection"])
                    self.assertIn("ranking", result["sidebar_order"])
                    self.assertEqual(result["schedule_statuses"], [1, 2])
                    self.assertEqual(result["schedule_sort"], "score")
                    self.assertFalse(result["schedule_uncollected"])
                    self.assertFalse(result["schedule_card_fields"]["tags"])
                    self.assertFalse(result["schedule_card_fields"]["score"])
                    self.assertTrue(result["schedule_card_fields"]["votes"])
                    reopened = database.HandbookDB(Path(temp) / "test.db")
                    self.assertFalse(reopened.get_settings()["statistics_show_zero_periods"])
                    self.assertFalse(reopened.get_settings()["show_shutdown_button"])
                    self.assertFalse(reopened.get_settings()["schedule_card_fields"]["score"])
                    for invalid in [{"schedule_sort": "invalid"}, {"schedule_statuses": [0, 6]}, {"schedule_statuses": "all"}, {"schedule_card_fields": {"tags": "false"}}, {"schedule_card_fields": {"unknown": False}}]:
                        request = urllib.request.Request(url, data=json.dumps(invalid).encode(), method="PATCH", headers={"Content-Type": "application/json"})
                        with self.assertRaises(urllib.error.HTTPError) as error:
                            urllib.request.urlopen(request)
                        self.assertEqual(error.exception.code, 400)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=3)

    def test_covers_send_no_referrer_and_use_disk_cache(self):
        with tempfile.TemporaryDirectory() as temp:
            service = schedule.ScheduleService(Path(temp))
            (Path(temp) / "202610.json").write_text(json.dumps({"items": [{"key": "a", "image_url": "https://i0.hdslb.com/a.jpg"}]}))
            class Response:
                headers = Message()
                headers["Content-Type"] = "image/jpeg"
                def __enter__(self): return self
                def __exit__(self, *args): pass
                def read(self, *args): return b"test-image-bytes"
            with patch("schedule.urllib.request.urlopen", return_value=Response()) as fetch:
                first = service.cover("202610", "a")
                self.assertNotIn("Referer", fetch.call_args.args[0].headers)
                second = service.cover("202610", "a")
                self.assertEqual(first, second)
                self.assertEqual(fetch.call_count, 1)

    def test_season_path_validation(self):
        self.assertEqual(schedule.season_key("202610"), "202610")
        for value in ["../data", "202611", "20261", "202610/", "202610?x=1"]:
            with self.assertRaises(ValueError):
                schedule.season_key(value)

    def test_four_am_boundary_and_extended_hours(self):
        for weekday, text, expected_day, actual_day, clock in [
            (1, "03:59", 7, 1, "03:59"), (1, "04:00", 1, 1, "04:00"),
            (1, "23:59", 1, 1, "23:59"), (1, "24:00", 1, 2, "00:00"),
            (1, "25:30~", 1, 2, "01:30"), (7, "28:00", 1, 1, "04:00"),
        ]:
            with self.subTest(text=text, weekday=weekday):
                slot = schedule.broadcast_slot(weekday, text)
                self.assertEqual((slot["weekday"], slot["calendar_weekday"], slot["time"]), (expected_day, actual_day, clock))
        self.assertGreater(schedule.broadcast_slot(1, "25:30")["time_order"], schedule.broadcast_slot(1, "23:59")["time_order"])
        for value in ["待公布", "29:99", "99:00"]:
            self.assertEqual(schedule.broadcast_slot(1, value)["time"], "")

    def test_parse_weekly_and_network(self):
        rows = schedule.parse_yuc(HTML)
        self.assertEqual(len(rows), 2)
        first, network = rows
        self.assertEqual(first["weekday"], 1)
        self.assertEqual(first["time"], "01:30")
        self.assertEqual(first["release"], "10/5~")
        self.assertEqual(first["platforms"][0]["name"], "Netflix")
        self.assertEqual(network["kind"], "network")
        self.assertEqual(network["weekday"], 0)
        self.assertEqual(network["release_note"], "(全10话)")
        self.assertEqual(network["release"], "10/20网络放送")

    def test_matching_does_not_join_different_sequels(self):
        self.assertIsNone(schedule.best_match(["same"], [{"aliases": ["same"], "id": 1}, {"aliases": ["same"], "id": 2}]))
        self.assertIsNone(schedule.best_match(["example season 2"], [{"aliases": ["example season 3"]}]))
        self.assertIsNone(schedule.best_match(["totally different"], [{"aliases": ["test title"]}]))
        self.assertIsNone(schedule.best_match([""], [{"aliases": [""]}]))

    def test_merge_preserves_source_time_and_score_without_duplicates(self):
        yuc = schedule.parse_yuc(HTML)
        bgm = [{"id": 123, "title": "测试番剧第二季", "aliases": ["测试番剧第二季"], "score": 8.1, "votes": 300, "weekday": 2, "time": "", "kind": "weekly"}]
        result = schedule.merge_sources(yuc, bgm)
        self.assertEqual(len(result), 2)
        self.assertEqual((result[0]["id"], result[0]["weekday"], result[0]["time"], result[0]["score"]), (123, 1, "01:30", 8.1))
        self.assertEqual(len({row["key"] for row in result}), len(result))

    def test_attach_collection_is_account_specific_and_read_only(self):
        public = {"items": [{"id": 123, "key": "a", "title": "测试番剧", "aliases": ["测试番剧"]}]}
        local = [{"id": 123, "name_cn": "测试番剧", "name": "", "collection_type": 3, "bgm_score": 8, "bgm_rating_total": 99}]
        first = schedule.attach_collection(public, local)
        self.assertEqual(first["items"][0]["collection_type"], 3)
        self.assertEqual(first["items"][0]["local_id"], 123)
        self.assertEqual(schedule.attach_collection(public, [])["items"][0]["collection_type"], 0)
        self.assertNotIn("collection_type", public["items"][0])
        self.assertEqual(local[0]["collection_type"], 3)

    def test_cache_refresh_preserves_old_data_on_source_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            service = schedule.ScheduleService(Path(temp))
            old = {"season": "202610", "items": [{"key": "old"}], "fetched_at": 1}
            (Path(temp) / "202610.json").write_text(json.dumps(old))
            with patch.object(service, "fetch", side_effect=OSError("offline")):
                service._refresh("202610")
            self.assertEqual(service.load("202610"), old)
            self.assertIn("继续显示上次缓存", service.errors["202610"])

    def test_refresh_handles_partial_data_and_quarter_end(self):
        for season, expected_end in [("202610", "2027-01-01"), ("202601", "2026-04-01")]:
            with tempfile.TemporaryDirectory() as temp:
                service = schedule.ScheduleService(Path(temp))
                urls = []
                def fetch(url):
                    urls.append(url)
                    if "yuc.wiki" in url:
                        return HTML.encode()
                    raise OSError("offline")
                with patch.object(service, "fetch", side_effect=fetch):
                    service._refresh(season)
                data = service.load(season)
                self.assertEqual(len(data["items"]), 2)
                self.assertTrue(data["warnings"])
                self.assertTrue(any("end=" + expected_end in url for url in urls))

    def test_get_coalesces_requests_and_does_not_block_for_network(self):
        with tempfile.TemporaryDirectory() as temp:
            service = schedule.ScheduleService(Path(temp))
            with patch("schedule.threading.Thread") as worker:
                first = service.get("202610")
                second = service.get("202610", refresh=True)
                self.assertTrue(first["loading"] and second["loading"])
                self.assertEqual(worker.call_count, 1)

    def test_cover_rejects_arbitrary_urls_and_missing_keys(self):
        with tempfile.TemporaryDirectory() as temp:
            service = schedule.ScheduleService(Path(temp))
            (Path(temp) / "202610.json").write_text(json.dumps({"items": [{"key": "a", "image_url": "http://localhost/secret"}]}))
            with self.assertRaises(ValueError):
                service.cover("202610", "a")
            with self.assertRaises(ValueError):
                service.cover("202610", "../a")


if __name__ == "__main__":
    unittest.main()
