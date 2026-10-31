from __future__ import annotations
from handbook import database, desktop, http, metadata, related, webdav


import tempfile
import threading
import unittest
from copy import deepcopy
from unittest.mock import patch
from pathlib import Path
from urllib.request import urlopen

from handbook import common as app


def sample_item(anime_id: int, collection_type: int, name: str) -> dict:
    return {
        "id": anime_id,
        "type": collection_type,
        "name": name,
        "name_cn": "",
        "summary": "",
        "air_date": "",
        "image_url": "",
        "updated_at": "",
    }


def sample_episodes() -> list[dict]:
    return [
        {"id": 101, "type": 0, "sort": 1, "ep": 1, "name": "第1話"},
        {"id": 102, "type": 0, "sort": 2, "ep": 2, "name": "第2話"},
        {"id": 201, "type": 2, "sort": 1, "ep": 0, "name": "OP"},
        {"id": 301, "type": 3, "sort": 1, "ep": 0, "name": "ED"},
    ]


class HandbookDBTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.db = database.HandbookDB(Path(self.tempdir.name) / "handbook.db")

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def test_webdav_auto_sync_checkbox_values_are_parsed_as_booleans(self) -> None:
        parser = webdav.WebDAVSyncService._as_bool
        self.assertFalse(parser(False))
        self.assertFalse(parser("false"))
        self.assertFalse(parser("关闭"))
        self.assertTrue(parser(True))
        self.assertTrue(parser("true"))
        self.assertTrue(parser("开启"))

    def test_webdav_merge_keeps_different_anime_and_episode_records(self) -> None:
        tables = {table: [] for table in database.HandbookDB.CLOUD_TABLES}
        local = {"format": 1, "tables": {key: list(value) for key, value in tables.items()}}
        remote = {"format": 1, "tables": {key: list(value) for key, value in tables.items()}}
        local["tables"]["anime"] = [{"id": 1, "updated_at": "2026-09-15T10:00:00+08:00", "watched_episodes": '["ep-1"]'}]
        remote["tables"]["anime"] = [{"id": 1, "updated_at": "2026-09-15T10:01:00+08:00", "watched_episodes": '["ep-2"]'}, {"id": 2, "updated_at": "2026-09-15T10:02:00+08:00", "watched_episodes": '["ep-1"]'}]
        local["tables"]["events"] = [{"id": 1, "event_type": "watch", "anime_id": 1, "episodes": '["ep-1"]', "content": "", "created_at": "2026-09-15T10:00:00+08:00"}]
        remote["tables"]["events"] = [{"id": 1, "event_type": "watch", "anime_id": 1, "episodes": '["ep-2"]', "content": "", "created_at": "2026-09-15T10:01:00+08:00"}, {"id": 2, "event_type": "watch", "anime_id": 2, "episodes": '["ep-1"]', "content": "", "created_at": "2026-09-15T10:02:00+08:00"}]
        merged = webdav.WebDAVSyncService.merge_record_states(local, remote)
        self.assertEqual(len(merged["tables"]["events"]), 3)
        self.assertEqual(app.json_list(merged["tables"]["anime"][0]["watched_episodes"]), ["ep-1", "ep-2"])

    def test_webdav_merge_uses_earlier_record_for_the_same_episode(self) -> None:
        tables = {table: [] for table in database.HandbookDB.CLOUD_TABLES}
        local = {"format": 1, "tables": {key: list(value) for key, value in tables.items()}}
        remote = {"format": 1, "tables": {key: list(value) for key, value in tables.items()}}
        local["tables"]["events"] = [{"id": 1, "event_type": "watch", "anime_id": 1, "episodes": '["ep-1"]', "content": "old", "created_at": "2026-09-15T10:00:00+08:00"}]
        remote["tables"]["events"] = [{"id": 2, "event_type": "watch", "anime_id": 1, "episodes": '["ep-1"]', "content": "new", "created_at": "2026-09-15T10:01:00+08:00"}]
        merged = webdav.WebDAVSyncService.merge_record_states(local, remote)
        self.assertEqual(len(merged["tables"]["events"]), 1)
        self.assertEqual(merged["tables"]["events"][0]["content"], "old")

    def test_webdav_merge_compares_real_instants_and_works_in_both_directions(self) -> None:
        local = {"format": 1, "tables": {table: [] for table in database.HandbookDB.CLOUD_TABLES}}
        remote = deepcopy(local)
        local["tables"]["events"] = [{"id": 1, "event_type": "watch", "anime_id": 1, "episodes": '["ep-1"]', "created_at": "2026-09-15T10:00:00+08:00"}]
        remote["tables"]["events"] = [{"id": 2, "event_type": "watch", "anime_id": 1, "episodes": '["ep-1"]', "created_at": "2026-09-15T03:00:00Z"}]
        for a, b in ((local, remote), (remote, local)):
            events = webdav.WebDAVSyncService.merge_record_states(a, b)["tables"]["events"]
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]["created_at"], "2026-09-15T10:00:00+08:00")

    def test_webdav_merge_splits_overlapping_batches_preserves_notes_and_is_idempotent(self) -> None:
        self.db.import_kazumi([sample_item(1, 1, "watching"), sample_item(2, 1, "other")])
        self.db.update_bgm_metadata(1, episode_count=2, episodes=sample_episodes()[:2])
        self.db.update_bgm_metadata(2, episode_count=2, episodes=sample_episodes()[:2])
        self.db.set_progress(1, ["bgm:101", "bgm:102"])
        self.db.add_note("desktop note")
        local = self.db.export_cloud_state()
        remote = deepcopy(local)
        remote["tables"]["events"] = []
        template = next(event for event in local["tables"]["events"] if event["event_type"] == "watch")
        # Each device has overlapping batch records with colliding SQLite IDs.
        local["tables"]["events"][0].update(episodes='["bgm:101","bgm:102"]', created_at="2026-09-15T10:00:00+08:00")
        remote["tables"]["events"] = [dict(template, id=template["id"], episodes='["bgm:102"]', created_at="2026-09-15T01:00:00Z"), dict(template, id=2, anime_id=2, episodes='["bgm:101"]', created_at="2026-09-15T04:00:00Z"), dict(local["tables"]["events"][-1], content="mobile note")]
        before_local, before_remote = deepcopy(local), deepcopy(remote)
        merged = webdav.WebDAVSyncService.merge_record_states(local, remote)
        self.assertEqual(local, before_local)
        self.assertEqual(remote, before_remote)
        events = merged["tables"]["events"]
        self.assertEqual(len({event["id"] for event in events}), len(events))
        self.assertEqual({event["content"] for event in events if event["event_type"] == "note"}, {"desktop note", "mobile note"})
        watch = {(event["anime_id"], app.json_list(event["episodes"])[0]): event["created_at"] for event in events if event["event_type"] == "watch"}
        self.assertEqual(watch[(1, "bgm:101")], "2026-09-15T10:00:00+08:00")
        self.assertEqual(watch[(1, "bgm:102")], "2026-09-15T01:00:00Z")
        self.assertEqual(len(watch), 3)
        self.db.import_cloud_state(merged)
        exported = self.db.export_cloud_state()
        again = webdav.WebDAVSyncService.merge_record_states(exported, remote)
        self.assertEqual(again["tables"]["events"], merged["tables"]["events"])

    def test_webdav_merge_equal_and_missing_times_are_deterministic(self) -> None:
        select = webdav.WebDAVSyncService._earlier_row
        early = {"id": 1, "created_at": "2026-09-15T10:00:00"}
        late = {"id": 2, "created_at": "2026-09-15T03:00:00Z"}
        self.assertEqual(select(early, late, "created_at"), early)
        self.assertEqual(select({"id": 3, "created_at": "invalid"}, early, "created_at"), early)
        equivalent = {"id": 2, "created_at": "2026-09-15T02:00:00Z"}
        self.assertEqual(select(early, equivalent, "created_at"), select(equivalent, early, "created_at"))

    def test_webdav_repeated_batch_keeps_remapped_ids(self) -> None:
        local = {"format": 1, "tables": {table: [] for table in database.HandbookDB.CLOUD_TABLES}}
        remote = deepcopy(local)
        local["tables"]["events"] = [{"id": 1, "event_type": "watch", "anime_id": 1, "episodes": '["ep-1","ep-2"]', "content": "", "created_at": "2026-09-15T10:00:00+08:00"}]
        remote["tables"]["events"] = [{"id": 1, "event_type": "watch", "anime_id": 1, "episodes": '["ep-2","ep-3"]', "content": "", "created_at": "2026-09-15T09:00:00+08:00"}]
        merged = webdav.WebDAVSyncService.merge_record_states(local, remote)
        for _ in range(3):
            again = webdav.WebDAVSyncService.merge_record_states(merged, remote)
            self.assertEqual(again["tables"]["events"], merged["tables"]["events"])
            merged = again

    def test_webdav_sync_auto_merges_then_uses_lightweight_unchanged_check(self) -> None:
        self.db.import_kazumi([sample_item(1, 1, "watching")])
        self.db.update_bgm_metadata(1, episode_count=2, episodes=sample_episodes()[:2])
        baseline = self.db.export_cloud_state()
        self.db.set_progress(1, ["bgm:101"])
        local = self.db.export_cloud_state()
        local["tables"]["events"][0]["created_at"] = "2026-09-15T10:00:00+08:00"
        self.db.import_cloud_state(local)
        remote = deepcopy(baseline)
        template = local["tables"]["events"][0]
        remote["tables"]["events"] = [dict(template, episodes='["bgm:101","bgm:102"]', created_at="2026-09-15T03:00:00Z")]
        remote["tables"]["anime"][0]["watched_episodes"] = '["bgm:101","bgm:102"]'
        config = {"url": "https://example.invalid/dav", "username": "test", "password": "test", "profiles": {}}
        item = {"account_id": "test-account", "last_hash": webdav.WebDAVSyncService._state_hash(baseline), "last_etag": "old"}
        # Construct without touching the real user's config or cloud account.
        service = object.__new__(webdav.WebDAVSyncService)
        service._lock = threading.RLock()
        with patch.object(service, "_read", return_value=config), patch.object(service, "_profile_config", return_value=item), patch.object(service, "_ensure_remote_folder"), patch.object(service, "_write"), patch.object(service, "_push_kazumi", return_value=None), patch.object(service, "_remote_probe", side_effect=[(200, "changed"), (200, "merged"), (200, "merged")]), patch.object(service, "_remote_state", return_value=({"state": remote}, service._state_hash(remote))) as fetch, patch.object(service, "_upload_state", side_effect=lambda c, a, state: service._state_hash(state)) as upload:
            result = service.sync(self.db)
            self.assertEqual(result["action"], "merged")
            self.assertNotIn("conflict", result)
            watched = [event for event in self.db.export_cloud_state()["tables"]["events"] if event["event_type"] == "watch"]
            self.assertEqual(len(watched), 2)
            self.assertEqual(next(event for event in watched if app.json_list(event["episodes"]) == ["bgm:101"])["created_at"], "2026-09-15T10:00:00+08:00")
            self.assertEqual(service.sync(self.db)["action"], "unchanged")
            self.assertEqual(fetch.call_count, 1)
            self.assertEqual(upload.call_count, 1)

    def test_bgm_metadata_initializes_progress_by_collection(self) -> None:
        self.db.import_kazumi(
            [
                sample_item(1, 4, "finished"),
                sample_item(2, 1, "watching"),
            ]
        )

        self.db.update_bgm_metadata(1, episode_count=4, episodes=sample_episodes())
        self.db.update_bgm_metadata(2, episode_count=4, episodes=sample_episodes())

        finished = self.db.get_anime(1)
        watching = self.db.get_anime(2)
        self.assertEqual(
            finished["watched_episode_keys"],
            ["bgm:101", "bgm:102", "bgm:201", "bgm:301"],
        )
        self.assertEqual(finished["episode_summary"], "本篇 2 · OP 1 · ED 1")
        self.assertEqual(finished["watched_count"], 4)
        self.assertEqual(watching["watched_episodes"], [])
        self.assertEqual(watching["watched_count"], 0)

    def test_anime_collection_api_returns_filtered_data(self) -> None:
        """Keep the lightweight collection endpoint from silently closing connections."""
        self.db.import_kazumi(
            [
                sample_item(81, 1, "watching"),
                sample_item(82, 2, "planned"),
            ]
        )
        previous_database = desktop.DATABASE
        server = app.ThreadingHTTPServer(("127.0.0.1", 0), http.RequestHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        desktop.DATABASE = self.db
        thread.start()
        try:
            port = server.server_address[1]
            with urlopen(f"http://127.0.0.1:{port}/api/animes?category=1", timeout=3) as response:
                payload = app.json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 200)
            self.assertEqual([item["id"] for item in payload["animes"]], [81])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)
            desktop.DATABASE = previous_database

    def test_kazumi_watching_to_finished_adds_only_remaining_watch_record(self) -> None:
        self.db.import_kazumi([sample_item(70, 1, "moving")])
        self.db.update_bgm_metadata(70, episode_count=4)
        self.db.set_progress(70, [1, 2, 3])

        self.db.import_kazumi([sample_item(70, 4, "moving")])
        result = self.db.complete_kazumi_watching_transitions()
        anime = self.db.get_anime(70)
        events = self.db.timeline(show_watch=True, show_notes=False)

        self.assertEqual(result["recorded_episodes"], 1)
        self.assertEqual(anime["watched_count"], 4)
        self.assertEqual(events[0]["episodes"][0]["display_label"], "本篇 04")

    def test_kazumi_completion_records_remaining_episodes_after_episode_total_grows(self) -> None:
        """A pending 1 -> 4 move must not be mistaken for old full progress."""
        self.db.import_kazumi([sample_item(74, 1, "growing-total")])
        self.db.update_bgm_metadata(74, episode_count=2)
        self.db.set_progress(74, [1, 2])

        self.db.import_kazumi([sample_item(74, 4, "growing-total")])
        # This is the normal sync order: import, then refresh metadata, then
        # finish the pending transition. The refreshed total has two new eps.
        self.db.update_bgm_metadata(74, episode_count=4)
        result = self.db.complete_kazumi_watching_transitions()
        anime = self.db.get_anime(74)
        events = self.db.timeline(show_watch=True, show_notes=False)

        self.assertEqual(result["recorded_episodes"], 2)
        self.assertEqual(anime["watched_count"], 4)
        self.assertEqual(
            [episode["key"] for episode in events[0]["episodes"]],
            ["0:3", "0:4"],
        )

    def test_kazumi_completion_does_not_repeat_saved_progress_without_events(self) -> None:
        """Saved progress remains history even if an old record is missing."""
        self.db.import_kazumi([sample_item(73, 1, "saved-progress")])
        self.db.update_bgm_metadata(73, episode_count=4)
        with self.db.connect() as db:
            db.execute(
                "UPDATE anime SET watched_episodes = ? WHERE id = ?",
                ('["0:1", "0:2"]', 73),
            )

        self.db.import_kazumi([sample_item(73, 4, "saved-progress")])
        result = self.db.complete_kazumi_watching_transitions()
        events = self.db.timeline(show_watch=True, show_notes=False)

        self.assertEqual(result["recorded_episodes"], 2)
        self.assertEqual(len(events), 1)
        self.assertEqual([episode["key"] for episode in events[0]["episodes"]], ["0:3", "0:4"])

    def test_kazumi_directly_finished_does_not_create_watch_record(self) -> None:
        self.db.import_kazumi([sample_item(71, 4, "direct")])
        self.db.update_bgm_metadata(71, episode_count=3)

        result = self.db.complete_kazumi_watching_transitions()
        anime = self.db.get_anime(71)

        self.assertEqual(result["recorded_episodes"], 0)
        self.assertEqual(anime["watched_count"], 3)
        self.assertEqual(self.db.timeline(show_watch=True, show_notes=False), [])

    def test_kazumi_completion_transition_waits_for_episode_metadata(self) -> None:
        self.db.import_kazumi([sample_item(72, 1, "delayed")])
        self.db.import_kazumi([sample_item(72, 4, "delayed")])

        waiting = self.db.complete_kazumi_watching_transitions()
        self.assertEqual(waiting, {"completed": 0, "recorded_episodes": 0, "pending": 1})

        self.db.update_bgm_metadata(72, episode_count=2)
        completed = self.db.complete_kazumi_watching_transitions()
        self.assertEqual(completed, {"completed": 1, "recorded_episodes": 2, "pending": 0})
        self.assertEqual(len(self.db.timeline(show_watch=True, show_notes=False)), 1)

    def test_episode_title_cache_is_marked_only_after_title_sync(self) -> None:
        self.db.import_kazumi([sample_item(30, 1, "titles")])
        self.db.update_bgm_metadata(30, episode_count=2)
        self.assertFalse(self.db.get_anime(30)["episode_titles_synced"])
        self.db.update_bgm_metadata(
            30,
            episode_count=2,
            episodes=sample_episodes(),
            episode_titles_synced=True,
        )
        self.assertTrue(self.db.get_anime(30)["episode_titles_synced"])

    def test_character_profiles_fetch_concurrently_and_keep_credit_order(self) -> None:
        service = metadata.SyncService(self.db)
        barrier = threading.Barrier(4)
        lock = threading.Lock()
        active = 0
        peak = 0

        def fetch(url, **kwargs):
            nonlocal active, peak
            if "/subjects/" in url:
                return [{"id": number, "name": f"JP{number}"} for number in range(1, 5)]
            number = int(url.rsplit("/", 1)[1])
            with lock:
                active += 1
                peak = max(peak, active)
            try:
                barrier.wait(timeout=5)
                if number == 2:
                    raise TimeoutError("optional profile unavailable")
                return {"infobox": [{"key": "简体中文名", "value": f"CN{number}"}]}
            finally:
                with lock:
                    active -= 1

        with patch.object(service, "_fetch_bgm_json", side_effect=fetch), patch.object(service, "_subject_character_page_order", return_value=[]):
            characters = service.fetch_bgm_characters(91)
        self.assertEqual(peak, 4)
        self.assertEqual([item["character_id"] for item in characters], [1, 2, 3, 4])
        self.assertEqual([item["name_cn"] for item in characters], ["CN1", "JP2", "CN3", "CN4"])
        with patch.object(service, "_fetch_bgm_json", return_value=[{"id": 1}, {"id": 2}]), patch.object(service, "_subject_character_page_order", return_value=[2, 1]):
            self.assertEqual([item["character_id"] for item in service.fetch_bgm_characters(91)], [2, 1])

    def test_initial_appearance_payload_is_safe_and_excludes_other_settings(self) -> None:
        marker = '<script id="initialAppearance" type="application/json">{}</script>'
        unsafe = '</script><script>alert(1)</script>'
        rendered = app.with_initial_appearance(marker, {"theme_color": "custom", "custom_theme_color": unsafe, "private_setting": "secret"}, "account-1")
        self.assertEqual(rendered.count('</script>'), 1)
        self.assertNotIn("secret", rendered)
        payload = app.json.loads(rendered.split('>', 1)[1].rsplit('</script>', 1)[0])
        self.assertEqual(payload["settings"]["custom_theme_color"], unsafe)
        self.assertEqual(payload["account_id"], "account-1")

    def test_character_cache_round_trip(self) -> None:
        self.db.import_kazumi([sample_item(91, 1, "characters")])

        stored = self.db.replace_anime_characters(
            91,
            [
                {
                    "character_id": 9,
                    "name": "\u65e5\u6587\u540d",
                    "name_cn": "\u4e2d\u6587\u540d",
                    "image_url": "https://example.invalid/character.jpg",
                    "cv_names": ["CV A", "CV B"],
                }
            ],
        )

        self.assertEqual(stored[0]["name_cn"], "\u4e2d\u6587\u540d")
        self.assertEqual(stored[0]["cv_names"], ["CV A", "CV B"])
        self.assertEqual(self.db.list_anime_characters(91), stored)

    def test_character_cache_keeps_bangumi_credit_order(self) -> None:
        self.db.import_kazumi([sample_item(92, 1, "character-order")])
        stored = self.db.replace_anime_characters(
            92,
            [
                {"character_id": 30, "name": "Z", "name_cn": "最后", "image_url": "", "cv_names": []},
                {"character_id": 10, "name": "A", "name_cn": "最先", "image_url": "", "cv_names": []},
                {"character_id": 20, "name": "M", "name_cn": "中间", "image_url": "", "cv_names": []},
            ],
        )

        self.assertEqual([item["character_id"] for item in stored], [30, 10, 20])
        self.assertFalse(self.db.anime_characters_need_order_refresh(92))

    def test_bangumi_source_profiles_require_complete_http_urls(self) -> None:
        sources = app.normalize_bgm_sources([
            {
                "id": "official",
                "name": "Bangumi 官方",
                "site_base": "https://bgm.tv/",
                "api_base": "https://api.bgm.tv/",
            }
        ])
        self.assertEqual(sources[0]["site_base"], "https://bgm.tv")
        self.assertEqual(sources[0]["api_base"], "https://api.bgm.tv")
        with self.assertRaises(ValueError):
            app.normalize_bgm_sources([
                {"id": "bad", "name": "错误", "site_base": "bgm.tv", "api_base": "https://api.bgm.tv"}
            ])

    def test_airing_progress_counts_only_released_regular_episodes(self) -> None:
        episodes = [
            {"id": 1, "type": 0, "sort": 1, "ep": 1, "airdate": "2026-07-06"},
            {"id": 2, "type": 0, "sort": 2, "ep": 2, "airdate": "2026-07-13"},
            {"id": 3, "type": 0, "sort": 3, "ep": 3, "airdate": "2026-07-20"},
            {"id": 4, "type": 2, "sort": 1, "ep": 0, "airdate": "2026-07-06"},
        ]
        normalized = app.normalize_episodes(episodes)
        self.assertEqual(
            app.aired_main_episode_count(
                normalized, as_of=app.date.fromisoformat("2026-07-15")
            ),
            2,
        )

        self.db.import_kazumi([sample_item(31, 1, "airing")])
        self.db.update_bgm_metadata(
            31,
            episode_count=3,
            aired_episode_count=2,
            episode_release_synced=True,
        )
        anime = self.db.get_anime(31)
        self.assertEqual(anime["aired_episode_count"], 2)
        self.assertTrue(anime["episode_release_synced_at"])

    def test_airing_refresh_preserves_existing_op_ed_groups(self) -> None:
        self.db.import_kazumi([sample_item(32, 1, "grouped")])
        self.db.update_bgm_metadata(32, episode_count=4, episodes=sample_episodes())
        self.db.update_bgm_metadata(
            32,
            episode_count=4,
            aired_episode_count=2,
            episode_release_synced=True,
        )

        anime = self.db.get_anime(32)
        self.assertEqual(anime["episode_summary"], "本篇 2 · OP 1 · ED 1")
        self.assertEqual([group["type_label"] for group in anime["episode_groups"]], ["本篇", "OP", "ED"])

    def test_legacy_generated_episode_keys_resolve_after_group_restore(self) -> None:
        self.db.import_kazumi([sample_item(33, 1, "legacy")])
        self.db.update_bgm_metadata(33, episode_count=4, episodes=sample_episodes())
        with self.db.connect() as db:
            db.execute("UPDATE anime SET watched_episodes = '[]' WHERE id = 33")
            db.execute(
                """
                INSERT INTO events(event_type, anime_id, episodes, content, created_at)
                VALUES ('watch', 33, '["0:1","0:2"]', '', '2026-07-15T12:00:00+08:00')
                """
            )

        self.assertEqual(self.db.recover_progress_from_watch_events([33]), 1)
        anime = self.db.get_anime(33)
        event = self.db.timeline(show_watch=True, show_notes=False)[0]
        self.assertEqual(anime["watched_episode_keys"], ["bgm:101", "bgm:102"])
        self.assertEqual(
            [episode["display_label"] for episode in event["episodes"]],
            ["本篇 01", "本篇 02"],
        )

    def test_ranking_board_keeps_unranked_and_tier_positions(self) -> None:
        self.db.import_kazumi([sample_item(40, 1, "a"), sample_item(41, 2, "b")])
        board = self.db.create_ranking_board("测试榜")
        self.assertEqual([tier["name"] for tier in board["tiers"]], ["S", "A", "B", "C", "D"])
        board = self.db.import_ranking_items(board["id"], [40, 41])
        self.assertEqual(len(board["items"]), 2)
        board = self.db.save_ranking_placements(
            board["id"], {str(board["tiers"][0]["id"]): [41], "unranked": [40]}
        )
        positions = {item["anime_id"]: item["tier_id"] for item in board["items"]}
        self.assertEqual(positions[41], board["tiers"][0]["id"])
        self.assertIsNone(positions[40])
        self.assertTrue(self.db.delete_unranked_ranking_item(board["id"], 40))
        self.assertEqual([item["anime_id"] for item in self.db.get_ranking_board(board["id"])["items"]], [41])
        self.assertTrue(self.db.delete_ranking_board(board["id"]))
        self.assertIsNone(self.db.get_ranking_board(board["id"]))

    def test_ranking_templates_only_copy_tier_setup(self) -> None:
        default_template = self.db.list_ranking_templates()[0]
        self.assertEqual(default_template["tiers"], ["S", "A", "B", "C", "D"])
        template = self.db.create_ranking_template("三档", ["喜欢", "普通", "不喜欢"])
        board = self.db.create_ranking_board("模板测试", template["id"])
        self.assertEqual([tier["name"] for tier in board["tiers"]], ["喜欢", "普通", "不喜欢"])
        self.assertEqual(board["items"], [])
        self.assertTrue(self.db.delete_ranking_template(template["id"]))

    def test_set_progress_records_only_new_episodes(self) -> None:
        self.db.import_kazumi([sample_item(3, 1, "progress")])
        self.db.update_bgm_metadata(3, episode_count=4, episodes=sample_episodes())

        first = self.db.set_progress(3, [1, 2])
        second = self.db.set_progress(3, ["bgm:101", "bgm:102", "bgm:201"])
        removal = self.db.set_progress(3, ["bgm:101", "bgm:201"])
        events = self.db.timeline(show_watch=True, show_notes=False)

        self.assertEqual(first["recorded_episodes"], ["bgm:101", "bgm:102"])
        self.assertEqual(second["recorded_episodes"], ["bgm:201"])
        self.assertEqual(removal["recorded_episodes"], [])
        self.assertEqual(len(events), 2)
        self.assertEqual(
            [episode["display_label"] for episode in events[0]["episodes"]],
            ["OP 01"],
        )
        self.assertEqual(
            [episode["display_label"] for episode in events[1]["episodes"]],
            ["本篇 01"],
        )
        self.assertEqual(
            self.db.get_anime(3)["watched_episode_keys"],
            ["bgm:101", "bgm:201"],
        )

    def test_set_progress_removal_does_not_return_after_restart_recovery(self) -> None:
        self.db.import_kazumi([sample_item(35, 1, "progress-removal")])
        self.db.update_bgm_metadata(35, episode_count=4, episodes=sample_episodes())
        self.db.set_progress(35, [1, 2])

        self.db.set_progress(35, [1])
        self.db.recover_progress_from_watch_events([35])

        anime = self.db.get_anime(35)
        events = self.db.timeline(show_watch=True, show_notes=False)
        self.assertEqual(anime["watched_episode_keys"], ["bgm:101"])
        self.assertEqual(len(events), 1)
        self.assertEqual(
            [episode["display_label"] for episode in events[0]["episodes"]],
            ["本篇 01"],
        )

    def test_progress_recovers_from_watch_events_without_duplicate_record(self) -> None:
        """A lost progress snapshot must not make old watches record twice."""
        self.db.import_kazumi([sample_item(34, 1, "reconcile")])
        self.db.update_bgm_metadata(34, episode_count=4, episodes=sample_episodes())
        self.db.set_progress(34, [1, 2, "bgm:201"])
        with self.db.connect() as db:
            db.execute("UPDATE anime SET watched_episodes = '[]' WHERE id = 34")

        result = self.db.set_progress(34, [1, 2, "bgm:201"])
        anime = self.db.get_anime(34)
        events = self.db.timeline(show_watch=True, show_notes=False)

        self.assertEqual(result["recorded_episodes"], [])
        self.assertEqual(anime["watched_episode_keys"], ["bgm:101", "bgm:102", "bgm:201"])
        self.assertEqual(len(events), 1)

    def test_timeline_uses_4am_day_boundary(self) -> None:
        self.db.import_kazumi([sample_item(4, 1, "timeline")])
        self.db.update_bgm_metadata(4, episode_count=12)
        with self.db.connect() as db:
            db.execute(
                """
                INSERT INTO events(event_type, anime_id, episodes, content, created_at)
                VALUES ('watch', 4, '[1]', '', '2026-07-09T03:30:00+08:00')
                """
            )
            db.execute(
                """
                INSERT INTO events(event_type, anime_id, episodes, content, created_at)
                VALUES ('watch', 4, '[2,3]', '', '2026-07-09T05:00:00+08:00')
                """
            )
            db.execute(
                """
                INSERT INTO events(event_type, anime_id, episodes, content, created_at)
                VALUES ('note', 4, '[]', '凌晨分日测试', '2026-07-09T05:10:00+08:00')
                """
            )

        days = self.db.timeline_days(show_watch=True, show_notes=True)

        self.assertEqual([day["date"] for day in days], ["2026-07-09", "2026-07-08"])
        self.assertEqual(days[0]["episode_total"], 2)
        self.assertEqual(days[0]["anime_total"], 1)
        self.assertEqual(len(days[0]["events"]), 2)
        self.assertEqual(days[1]["episode_total"], 1)

    def test_category_episode_visibility_setting(self) -> None:
        settings = self.db.get_settings()
        visibility = settings["category_episode_visibility"]
        visibility["1"] = False
        self.db.set_setting("category_episode_visibility", visibility)

        saved = self.db.get_settings()["category_episode_visibility"]

        self.assertFalse(saved["1"])
        self.assertTrue(saved["4"])

    def test_category_progress_visibility_setting(self) -> None:
        settings = self.db.get_settings()
        visibility = settings["category_progress_visibility"]
        visibility["2"] = False
        self.db.set_setting("category_progress_visibility", visibility)

        saved = self.db.get_settings()["category_progress_visibility"]

        self.assertTrue(saved["1"])
        self.assertFalse(saved["2"])
        self.assertTrue(saved["4"])

    def test_anime_comment_is_kept_with_the_anime_and_timeline(self) -> None:
        self.db.import_kazumi([sample_item(6, 1, "comment")])

        event_id = self.db.add_anime_comment(6, "这一集的氛围很喜欢")
        comments = self.db.list_anime_comments(6)
        days = self.db.timeline_days(show_watch=False, show_notes=True)

        self.assertEqual(comments[0]["id"], event_id)
        self.assertEqual(comments[0]["content"], "这一集的氛围很喜欢")
        self.assertEqual(days[0]["events"][0]["event_type"], "anime_comment")
        self.assertEqual(days[0]["events"][0]["anime_id"], 6)

    def test_anime_comment_can_be_updated_and_deleted_from_its_event(self) -> None:
        self.db.import_kazumi([sample_item(61, 1, "comment-edit")])
        event_id = self.db.add_anime_comment(61, "旧评论")

        self.assertTrue(
            self.db.update_event(
                event_id,
                content="新评论",
                anime_id=61,
                theme="anime_comment",
                raw_directives="#主题 番剧评论\n#动漫 comment-edit\n新评论",
            )
        )
        self.assertEqual(self.db.list_anime_comments(61)[0]["content"], "新评论")
        self.assertEqual(self.db.timeline(show_watch=False, show_notes=False, show_comments=True)[0]["content"], "新评论")

        self.assertTrue(self.db.delete_event(event_id))
        self.assertEqual(self.db.list_anime_comments(61), [])
        self.assertEqual(self.db.timeline(show_watch=False, show_notes=False, show_comments=True), [])

    def test_episode_review_keeps_multiple_themes_without_counting_as_watch(self) -> None:
        self.db.import_kazumi([sample_item(62, 1, "episode-review")])
        self.db.update_bgm_metadata(62, episode_count=4, episodes=sample_episodes())
        event_id = self.db.add_note(
            "好看",
            62,
            "watch",
            themes=["watch", "episode_review"],
            episode_keys=["bgm:101"],
            raw_directives="#主题 观看记录\n#主题 单集评价\n#动漫 episode-review\n#集数 本篇 01\n好看",
        )

        events = self.db.timeline(show_watch=False, show_notes=True, show_comments=False)
        self.assertEqual(events[0]["id"], event_id)
        self.assertEqual(events[0]["themes"], ["watch", "episode_review"])
        self.assertEqual(events[0]["episodes"][0]["key"], "bgm:101")
        days = self.db.timeline_days(show_watch=True, show_notes=True, show_comments=True)
        self.assertEqual(days[0]["episode_total"], 0)

    def test_record_directives_keep_free_episode_text_after_edit(self) -> None:
        self.db.import_kazumi([sample_item(64, 1, "free-episode")])
        self.db.update_bgm_metadata(64, episode_count=4, episodes=sample_episodes())
        event_id = self.db.add_note(
            "旧正文",
            64,
            "watch",
            themes=["watch"],
            episode_keys=["bgm:101"],
            raw_directives="#主题 观看记录\n#动漫 free-episode\n#集数 本篇 01\n旧正文",
        )
        edited = "#主题 观看记录\n#动漫 free-episode\n#集数 EP4\n新正文"

        self.assertTrue(
            self.db.update_event(
                event_id,
                content="新正文",
                anime_id=64,
                theme="watch",
                themes=["watch"],
                raw_directives=edited,
                episode_text="EP4",
            )
        )

        event = self.db.timeline(show_watch=False, show_notes=True, show_comments=False)[0]
        self.assertEqual(event["raw_directives"], edited)
        # Quick-operation annotations are retained, while the editable display
        # text is deliberately free-form and is read from raw_directives.
        self.assertEqual(event["episodes"][0]["key"], "bgm:101")

    def test_episode_record_annotations_group_quick_records_by_episode(self) -> None:
        self.db.import_kazumi([sample_item(63, 1, "episode-annotations")])
        self.db.update_bgm_metadata(63, episode_count=4, episodes=sample_episodes())
        self.db.add_note(
            "这一集很好看",
            63,
            "episode_review",
            themes=["episode_review", "oped"],
            episode_keys=["bgm:101"],
        )
        self.db.add_note(
            "不应显示",
            63,
            "other",
            themes=["other"],
            episode_keys=["bgm:102"],
        )

        annotations = self.db.episode_record_annotations(63)

        self.assertEqual(list(annotations), ["bgm:101"])
        self.assertEqual(annotations["bgm:101"][0]["themes"], ["episode_review", "oped"])
        self.assertEqual(annotations["bgm:101"][0]["content"], "这一集很好看")

    def test_timeline_can_filter_comments_separately_from_other_records(self) -> None:
        self.db.import_kazumi([sample_item(7, 1, "filter")])
        self.db.add_note("普通记录")
        self.db.add_anime_comment(7, "番剧评论")

        only_other = self.db.timeline(
            show_watch=False, show_notes=True, show_comments=False
        )
        only_comments = self.db.timeline(
            show_watch=False, show_notes=False, show_comments=True
        )

        self.assertEqual([event["event_type"] for event in only_other], ["note"])
        self.assertEqual(
            [event["event_type"] for event in only_comments], ["anime_comment"]
        )

    def test_new_record_default_mode_setting(self) -> None:
        self.assertFalse(self.db.get_settings()["new_record_defaults_to_other"])
        self.db.set_setting("new_record_defaults_to_other", True)
        self.assertTrue(self.db.get_settings()["new_record_defaults_to_other"])

    def test_theme_color_setting(self) -> None:
        self.assertEqual(self.db.get_settings()["theme_color"], "forest")
        self.db.set_setting("theme_color", "ocean")
        self.assertEqual(self.db.get_settings()["theme_color"], "ocean")

    def test_collection_rating_visibility_setting(self) -> None:
        self.assertTrue(self.db.get_settings()["show_bgm_rating_in_collection"])
        self.db.set_setting("show_bgm_rating_in_collection", False)
        self.assertFalse(
            self.db.get_settings()["show_bgm_rating_in_collection"]
        )

    def test_bgm_rating_metadata_is_stored_locally(self) -> None:
        self.db.import_kazumi([sample_item(10, 1, "rating")])
        self.db.update_bgm_metadata(
            10,
            episode_count=1,
            rating_score=8.2,
            rating_rank=123,
            rating_total=4567,
            rating_synced=True,
        )

        anime = self.db.get_anime(10)

        self.assertEqual(anime["bgm_score"], 8.2)
        self.assertEqual(anime["bgm_rank"], 123)
        self.assertEqual(anime["bgm_rating_total"], 4567)
        self.assertTrue(anime["bgm_rating_synced_at"])
        self.assertEqual(anime["bgm_rating_version"], 2)

    def test_personal_rating_can_be_cleared_with_its_timeline_records(self) -> None:
        self.db.import_kazumi([sample_item(11, 1, "personal rating")])
        self.db.add_anime_rating(11, "五星上")
        self.db.add_anime_rating(11, "S")

        deleted = self.db.clear_anime_rating(11)

        self.assertEqual(deleted, 2)
        self.assertEqual(self.db.get_anime(11)["personal_rating_text"], "")
        self.assertEqual(self.db.timeline(show_watch=False, show_notes=True), [])

    def test_age_related_search_term_and_result_parser(self) -> None:
        service = related.AgeRelatedService(self.db, None)  # type: ignore[arg-type]
        page = '''
          <div class="card cata_video_item py-4">
            <a href="http://www.agedm.io/detail/20160052"><img data-original="https://example.com/older.jpg"></a>
            <span class="video_play_status">第13集(完结)</span>
            <h5 class="card-title"><a href="http://www.agedm.io/detail/20160052">吹响！上低音号 第二季</a></h5>
            <div class="video_detail_info"><span>原版名称：</span>響け！ユーフォニアム2</div>
            <div class="video_detail_info"><span>首播时间：</span>2016-10-05</div>
          </div>
          <div class="card cata_video_item py-4">
            <a href="http://www.agedm.io/detail/20240053"><img data-original="https://example.com/cover.jpg"></a>
            <span class="video_play_status">第13集(完结)</span>
            <h5 class="card-title"><a href="http://www.agedm.io/detail/20240053">吹响！上低音号 第三季</a></h5>
            <div class="video_detail_info"><span>原版名称：</span>響け！ユーフォニアム３</div>
            <div class="video_detail_info"><span>首播时间：</span>2024-04-07</div>
          </div>
        '''

        items = service.parse_search(page)

        self.assertEqual(service.search_term("響け！ユーフォニアム３"), "響け")
        self.assertEqual(items[0]["title"], "吹响！上低音号 第二季")
        self.assertEqual(items[0]["episode_count"], 13)
        self.assertEqual(items[0]["air_date"], "2016-10-05")

    def test_timeline_pages_keep_days_complete_and_cover_all_records(self) -> None:
        for day in range(1, 5):
            for number in range(12):
                event_id = self.db.add_note(f"entry {day}-{number}")
                with self.db.connect() as db:
                    db.execute("UPDATE events SET created_at=? WHERE id=?", (f"2026-09-{day:02d}T12:00:00+08:00", event_id))
        first = self.db.timeline_page(limit=15)
        self.assertEqual([d["date"] for d in first["days"]], ["2026-09-04", "2026-09-03"])
        self.assertEqual(first["next_offset"], 24)
        self.assertTrue(first["has_more"])
        second = self.db.timeline_page(limit=15, offset=first["next_offset"])
        self.assertFalse(second["has_more"])
        actual = [e["id"] for page in [first, second] for d in page["days"] for e in d["events"]]
        expected = [e["id"] for d in self.db.timeline_days() for e in d["events"]]
        self.assertEqual(actual, expected)
        self.assertEqual(self.db.timeline_page(offset=100)["days"], [])

    def test_available_timeline_themes_ignore_search_selection_and_paging(self):
        self.db.add_note("first", themes=["episode_review", "oped"])
        self.db.add_note("second", theme="other")
        expected = ["episode_review", "oped", "other"]
        for kwargs in ({}, {"search": "missing"}, {"themes": ["other"]}, {"offset": 100}):
            self.assertEqual(self.db.timeline_page(**kwargs)["available_themes"], expected)
        with self.db.connect() as db:
            db.execute("DELETE FROM events")
        self.assertEqual(self.db.timeline_page()["available_themes"], [])

    def test_timeline_pages_filter_before_paging(self) -> None:
        self.db.import_kazumi([sample_item(8, 1, "search-title")])
        for i in range(35):
            self.db.add_note(f"plain {i}")
        wanted = self.db.add_note("target content", 8, theme="episode_review")
        self.assertEqual(self.db.timeline_page(themes=["absent"])["days"], [])
        for options in [{"themes": ["episode_review"]}, {"search": "target"}, {"search": "search-title"}]:
            page = self.db.timeline_page(limit=1, **options)
            self.assertEqual([e["id"] for d in page["days"] for e in d["events"]], [wanted])
            self.assertFalse(page["has_more"])

    def test_statistics_groups_watch_episodes_and_record_types(self) -> None:
        self.db.import_kazumi([sample_item(8, 1, "statistics")])
        self.db.update_bgm_metadata(8, episode_count=2)
        self.db.set_progress(8, [1, 2])
        self.db.add_note("普通记录")
        self.db.add_anime_comment(8, "评论")

        watch = self.db.statistics("day", "watch")
        comments = self.db.statistics("day", "comment")
        other = self.db.statistics("day", "other")

        self.assertEqual(watch[0]["episodes"], 2)
        self.assertEqual(watch[0]["records"], 1)
        self.assertEqual(comments[0]["records"], 1)
        self.assertEqual(other[0]["records"], 1)

    def test_statistics_preserves_internal_zero_periods_without_padding_edges(self) -> None:
        cases = [
            ("day", "2026-09-14T12:00:00", "2026-09-16T12:00:00", ["2026-09-14", "2026-09-15", "2026-09-16"]),
            ("day", "2024-02-28T12:00:00", "2024-03-01T12:00:00", ["2024-02-28", "2024-02-29", "2024-03-01"]),
            ("week", "2020-12-21T12:00:00", "2021-01-04T12:00:00", ["2020-W52", "2020-W53", "2021-W01"]),
            ("month", "2025-12-15T12:00:00", "2026-02-15T12:00:00", ["2025-12", "2026-01", "2026-02"]),
            ("year", "2024-09-14T12:00:00", "2026-09-16T12:00:00", ["2024", "2025", "2026"]),
        ]
        first_id = self.db.add_note("first", theme="watch", episode_keys=[1])
        last_id = self.db.add_note("last", theme="watch", episode_keys=[2, 3])
        # Unrelated records must not extend the selected theme's date range.
        unrelated = self.db.add_note("other")
        for period, first, last, labels in cases:
            with self.subTest(period=period, first=first):
                with self.db.connect() as db:
                    db.execute("UPDATE events SET created_at=? WHERE id=?", (first, first_id))
                    db.execute("UPDATE events SET created_at=? WHERE id=?", (last, last_id))
                    db.execute("UPDATE events SET created_at=? WHERE id=?", ("2020-01-01T12:00:00", unrelated))
                series = self.db.statistics(period, "watch")
                self.assertEqual([item["label"] for item in series], labels)
                self.assertEqual(series[1], {"label": labels[1], "episodes": 0, "records": 0})
                self.assertEqual(sum(item["records"] for item in series), 2)
        self.assertEqual(self.db.statistics("day", "absent-theme"), [])

    def test_statistics_zero_days_respect_day_start_hour(self) -> None:
        first = self.db.add_note("first")
        last = self.db.add_note("last")
        with self.db.connect() as db:
            db.execute("UPDATE events SET created_at=? WHERE id=?", ("2026-09-15T03:00:00", first))
            db.execute("UPDATE events SET created_at=? WHERE id=?", ("2026-09-16T12:00:00", last))
        self.assertEqual([row["label"] for row in self.db.statistics("day", "other")], ["2026-09-14", "2026-09-15", "2026-09-16"])

    def test_unchanged_episode_balance_settings_keep_original_anchor(self) -> None:
        self.db.set_setting("episode_balance_anchor", "2026-08-11")
        self.db.set_setting("episode_balance_initial", 237)
        self.db.set_setting("episode_balance_daily_target", 8)

        self.db.update_episode_balance_settings(initial=237, daily_target=8)

        settings = self.db.get_settings()
        self.assertEqual(settings["episode_balance_anchor"], "2026-08-11")
        self.assertEqual(settings["episode_balance_initial"], 237)
        self.assertEqual(settings["episode_balance_daily_target"], 8)

    def test_timeline_searches_anime_names_and_record_content(self) -> None:
        self.db.import_kazumi([sample_item(9, 1, "search-title")])
        self.db.add_note("一段特别的内容", 9)
        self.db.add_note("另一条记录")

        by_anime = self.db.timeline(search="search-title")
        by_content = self.db.timeline(search="特别的内容")

        self.assertEqual(len(by_anime), 1)
        self.assertEqual(by_anime[0]["anime_id"], 9)
        self.assertEqual(len(by_content), 1)
        self.assertEqual(by_content[0]["content"], "一段特别的内容")

    def test_custom_collection_hides_item_from_builtin_when_enabled(self) -> None:
        self.db.import_kazumi(
            [
                sample_item(10, 1, "builtin-visible"),
                sample_item(11, 1, "customized"),
            ]
        )
        collection = self.db.create_custom_collection("百合")
        self.db.add_to_custom_collection(collection["id"], 11)

        hidden_builtin = self.db.list_anime(
            1, hide_customized_from_builtin=True
        )
        visible_builtin = self.db.list_anime(
            1, hide_customized_from_builtin=False
        )
        custom_items = self.db.list_anime(
            custom_collection_id=collection["id"]
        )
        stats = self.db.stats()

        self.assertEqual([item["id"] for item in hidden_builtin], [10])
        self.assertEqual({item["id"] for item in visible_builtin}, {10, 11})
        self.assertEqual([item["id"] for item in custom_items], [11])
        self.assertEqual(stats["category_counts"]["1"], 1)
        self.assertEqual(stats["custom_collection_counts"][str(collection["id"])], 1)
        self.assertEqual(stats["anime_total"], 2)

    def test_custom_collection_membership_and_delete(self) -> None:
        self.db.import_kazumi([sample_item(12, 2, "custom-delete")])
        collection = self.db.create_custom_collection("短篇")

        added = self.db.add_to_custom_collection(collection["id"], 12)
        self.assertEqual(added["custom_collection_ids"], [collection["id"]])

        removed = self.db.remove_from_custom_collection(collection["id"], 12)
        self.assertEqual(removed["custom_collection_ids"], [])

        self.db.add_to_custom_collection(collection["id"], 12)
        self.assertTrue(self.db.delete_custom_collection(collection["id"]))
        latest = self.db.get_anime(12)
        self.assertEqual(latest["custom_collection_ids"], [])

    def test_builtin_category_visibility_setting(self) -> None:
        settings = self.db.get_settings()
        visibility = settings["builtin_category_visibility"]
        visibility["2"] = False
        self.db.set_setting("builtin_category_visibility", visibility)

        saved = self.db.get_settings()["builtin_category_visibility"]

        self.assertFalse(saved["2"])
        self.assertTrue(saved["1"])

    def test_kazumi_position_and_custom_card_order_are_persisted(self) -> None:
        self.db.import_kazumi(
            [sample_item(21, 1, "second"), sample_item(20, 1, "first")]
        )
        imported = {item["id"]: item for item in self.db.list_anime()}
        self.assertEqual(imported[21]["kazumi_position"], 0)
        self.assertEqual(imported[20]["kazumi_position"], 1)

        self.db.set_custom_sort_order([20, 21])
        ordered = {item["id"]: item for item in self.db.list_anime()}
        self.assertEqual(ordered[20]["custom_sort_order"], 0)
        self.assertEqual(ordered[21]["custom_sort_order"], 1)

    def test_watched_progress_is_trimmed_when_episode_count_decreases(self) -> None:
        self.db.import_kazumi([sample_item(5, 4, "trim")])
        self.db.update_bgm_metadata(5, episode_count=5)
        self.db.update_bgm_metadata(5, episode_count=3)

        anime = self.db.get_anime(5)

        self.assertEqual(anime["watched_episode_keys"], ["0:1", "0:2", "0:3"])
        self.assertEqual(anime["watched_count"], 3)


if __name__ == "__main__":
    unittest.main()
