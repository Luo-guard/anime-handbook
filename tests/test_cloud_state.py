import json
import tempfile
import unittest
from pathlib import Path

from handbook import database
from handbook.webdav import WebDAVSyncService


def seed(database_file: database.HandbookDB, *, grid_columns: str = "4") -> None:
    """写入一部番、一条记录、一条内容设置和一条界面设置。"""
    episodes = [
        {"key": "bgm:1", "id": 1, "type": 0, "sort": 1, "ep": 1, "label": "01",
         "display_label": "本篇 01", "name": "旅の始まり", "name_cn": "旅途的开始",
         "airdate": "2023-09-29", "duration": "00:24:00"},
        {"key": "bgm:2", "id": 2, "type": 0, "sort": 2, "ep": 2, "label": "02",
         "display_label": "本篇 02", "name": "魔法", "name_cn": "魔法",
         "airdate": "2023-10-06", "duration": "00:24:00"},
        {"key": "bgm:9001", "id": 9001, "type": 2, "sort": 3, "ep": 0, "label": "01",
         "display_label": "OP 01", "name": "勇者", "name_cn": "勇者",
         "airdate": "2023-09-29", "duration": "00:01:30"},
    ]
    with database_file.connect() as db:
        db.execute(
            """
            INSERT INTO anime (
                id, name, name_cn, summary, air_date, image_url, collection_type,
                kazumi_updated_at, active, episode_count, watched_episodes,
                progress_initialized, created_at, updated_at, episodes, bgm_score,
                personal_score, personal_rating_text, collection_added_at,
                custom_sort_order, kazumi_position, episode_titles_synced
            ) VALUES (100, 'Sousou no Frieren', '葬送的芙莉莲', '一段很长的简介' * 50,
                      '2023-09-29', 'https://lain.bgm.tv/pic/cover/l/aa/bb/100.jpg', 1, '',
                      1, 28, '["bgm:1"]', 1, '2026-01-01T10:00:00+08:00',
                      '2026-01-02T10:00:00+08:00', ?, 8.6, 9.0, '神作',
                      '2026-01-01T10:00:00+08:00', 3, 2, 1)
            """,
            (json.dumps(episodes, ensure_ascii=False),),
        )
    database_file.add_note("第一集很好看", anime_id=100, theme="剧情", episode_keys=["bgm:1"])
    database_file.set_setting("record_themes", [{"id": "剧情", "name": "剧情"}])
    database_file.set_setting("collection_grid_columns", grid_columns)


class CloudStateFormatTests(unittest.TestCase):
    def test_export_is_compact_and_lossless_for_user_data(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = database.HandbookDB(root / "source.db", asset_root=root)
            seed(source)
            state = source.export_cloud_state()

        self.assertEqual(state["format"], 2)
        rows = state["tables"]["anime"]
        self.assertEqual(len(rows), 1)
        row = rows[0]
        # 缓存类字段不再上传
        for field in ("summary", "episode_count", "air_date", "bgm_score",
                      "episode_titles_synced", "bgm_synced_at"):
            self.assertNotIn(field, row)
        # 名称/封面保留（榜单、搜索、排序要用）
        self.assertEqual(row["name_cn"], "葬送的芙莉莲")
        self.assertIn("lain.bgm.tv", row["image_url"])
        # 用户数据完整
        self.assertEqual(row["collection_type"], 1)
        self.assertEqual(row["personal_score"], 9.0)
        self.assertEqual(row["watched_episodes"], '["bgm:1"]')
        # 分集压成 [编号, 集名, 类型]；类型 0 省略
        self.assertEqual(row["episodes"][0], [1, "本篇 01"])
        self.assertEqual(row["episodes"][2], [9001, "OP 01", 2])
        # 设置只带内容类
        keys = {item["key"] for item in state["tables"]["settings"]}
        self.assertIn("record_themes", keys)
        self.assertNotIn("collection_grid_columns", keys)
        # 记录表完整
        self.assertEqual(len(state["tables"]["events"]), 1)

    def test_round_trip_keeps_user_data_and_triggers_rebuild(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = database.HandbookDB(root / "source.db", asset_root=root)
            seed(source)
            state = source.export_cloud_state()

            target = database.HandbookDB(root / "target.db", asset_root=root)
            seed(target, grid_columns="2")          # 目标机有自己的界面偏好
            target.import_cloud_state(state)

            anime = target.get_anime(100)
            self.assertIsNotNone(anime)
            self.assertEqual(anime["name_cn"], "葬送的芙莉莲")
            self.assertEqual(anime["collection_type"], 1)
            self.assertEqual(anime["personal_score"], 9.0)
            self.assertEqual(anime["personal_rating_text"], "神作")
            self.assertEqual(list(anime["watched_episodes"]), ["bgm:1"])
            # episode_count 故意不传（DB 里为 NULL），恢复后由 bgm 补全
            with target.connect() as raw_db:
                stored = raw_db.execute(
                    "SELECT episode_count, bgm_rating_version FROM anime WHERE id = 100"
                ).fetchone()
            self.assertIsNone(stored[0])
            self.assertEqual(stored[1], 0)          # < 2 → enrich_missing 会重新抓
            self.assertEqual(anime["summary"], "")
            # 分集键与集名保留，移动端选集仍可用
            episodes = anime["episodes"]
            self.assertEqual([item["key"] for item in episodes], ["bgm:1", "bgm:2", "bgm:9001"])
            self.assertEqual(episodes[0]["display_label"], "本篇 01")
            self.assertEqual(episodes[2]["type"], 2)
            # 集标题故意为空 → 补全逻辑据此判断「同步恢复的条目，需要拉一次集信息」
            self.assertEqual(episodes[0]["name"], "")
            # 记录与内容设置同步；界面偏好保留本机
            with target.connect() as raw_db:
                notes = [row["content"] for row in raw_db.execute(
                    "SELECT content FROM events WHERE event_type = 'note'"
                ).fetchall()]
            self.assertEqual(notes, ["第一集很好看"])
            self.assertEqual(target.get_settings()["collection_grid_columns"], "2")
            self.assertTrue(target.get_settings().get("record_themes"))

    def test_legacy_format_one_still_imports(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = database.HandbookDB(root / "source.db", asset_root=root)
            seed(source)
            state = source.export_cloud_state()
            # 模拟旧客户端：全量列 + JSON 字符串分集
            for row in state["tables"]["anime"]:
                row["episodes"] = json.dumps(
                    [{"key": "bgm:1", "id": 1, "display_label": "本篇 01", "type": 0}],
                    ensure_ascii=False,
                )
                row["summary"] = "旧格式"
                row["episode_count"] = 1
            state["format"] = 1

            target = database.HandbookDB(root / "target.db", asset_root=root)
            target.import_cloud_state(state)
            anime = target.get_anime(100)
            self.assertEqual(anime["episode_count"], 1)
            self.assertEqual(anime["summary"], "旧格式")
            self.assertEqual(anime["episodes"][0]["key"], "bgm:1")

    def test_merge_keeps_newer_format_and_unions_settings(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            local_db = database.HandbookDB(root / "local.db", asset_root=root)
            seed(local_db)
            remote_db = database.HandbookDB(root / "remote.db", asset_root=root)
            seed(remote_db)
            remote_db.set_setting("schedule_hidden", [11])

            local = local_db.export_cloud_state()
            remote = remote_db.export_cloud_state()
            merged = WebDAVSyncService.merge_record_states(local, remote)

            self.assertEqual(merged["format"], 2)
            keys = {item["key"] for item in merged["tables"]["settings"]}
            self.assertIn("schedule_hidden", keys)
            self.assertIn("record_themes", keys)
            self.assertEqual(len(merged["tables"]["anime"]), 1)


if __name__ == "__main__":
    unittest.main()
