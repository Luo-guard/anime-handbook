"""自动追番：订阅存储与检查逻辑。

检查逻辑全部用假的蜜柑结果和假的下载动作，不联网、不碰 qB。
"""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from handbook import database, offline_config, mikan
from handbook.offline import OfflineStore
from handbook.offline_service import OfflineService


def item(torrent_id: str, group: str, published: str) -> dict:
    return {
        "id": torrent_id,
        "title": f"[{group}] 测试番 - {torrent_id}",
        "group": group,
        "published_at": published,
        "torrent_url": f"https://mikanime.tv/Download/{torrent_id}.torrent",
        "resolution": "1080p",
        "codec": "HEVC",
        "size_text": "1.0 GB",
    }


class SubscriptionStoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.db = database.HandbookDB(self.root / "handbook.db", asset_root=self.root)
        self.store = OfflineStore(self.db)

    def tearDown(self):
        self.tmp.cleanup()

    def test_same_triple_does_not_duplicate(self):
        first = self.store.add_subscription(anime_id=1, keyword="孤独摇滚", group_name="A")
        second = self.store.add_subscription(anime_id=1, keyword="孤独摇滚", group_name="A", enabled=False)
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(int(second["enabled"]), 0)
        self.assertEqual(len(self.store.subscriptions(1)), 1)

    def test_different_group_is_a_different_subscription(self):
        self.store.add_subscription(anime_id=1, keyword="孤独摇滚", group_name="A")
        self.store.add_subscription(anime_id=1, keyword="孤独摇滚", group_name="B")
        self.assertEqual(len(self.store.subscriptions(1)), 2)

    def test_blank_keyword_rejected(self):
        with self.assertRaises(ValueError):
            self.store.add_subscription(anime_id=1, keyword="   ")

    def test_enable_and_delete(self):
        sub = self.store.add_subscription(anime_id=1, keyword="番")
        updated = self.store.set_subscription_enabled(sub["id"], False)
        self.assertEqual(int(updated["enabled"]), 0)
        self.assertTrue(self.store.delete_subscription(sub["id"]))
        self.assertEqual(self.store.subscriptions(), [])

    def test_touch_records_baseline(self):
        sub = self.store.add_subscription(anime_id=1, keyword="番")
        self.store.touch_subscription(sub["id"], last_checked="2026-11-01T00:00:00", last_torrent="abc")
        row = self.store.subscriptions()[0]
        self.assertEqual(row["last_checked"], "2026-11-01T00:00:00")
        self.assertEqual(row["last_torrent"], "abc")

    def test_subscribe_reports_auto_follow_switch(self):
        """审计 N13：自动追番关着时，前端要能说清「还不会自动下载」。"""
        offline_config.save(self.root, {"media_root": str(self.root / "media"), "auto_follow": False})
        service = OfflineService(self.db)
        payload = service.subscribe(anime_id=1, keyword="番", group_name="A")
        self.assertFalse(payload["auto_follow"])
        self.assertFalse(service.subscriptions(1)["auto_follow"])

        offline_config.save(self.root, {"media_root": str(self.root / "media"), "auto_follow": True})
        self.assertTrue(service.subscribe(anime_id=1, keyword="番", group_name="B")["auto_follow"])
        self.assertTrue(service.subscriptions(1)["auto_follow"])


class CheckLogicTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.db = database.HandbookDB(self.root / "handbook.db", asset_root=self.root)
        self.store = OfflineStore(self.db)
        offline_config.save(self.root, {"media_root": str(self.root / "media"), "auto_follow": True})
        self.service = OfflineService(self.db)
        self.downloaded: list[dict] = []

        def fake_download(**kwargs):
            self.downloaded.append(kwargs)
            return {"ok": True}

        self.fake_download = fake_download
        self.patches = [
            patch.object(OfflineService, "download", new=lambda _self, **kw: fake_download(**kw)),
        ]
        for patcher in self.patches:
            patcher.start()

    def tearDown(self):
        for patcher in self.patches:
            patcher.stop()
        self.tmp.cleanup()

    def run_check(self, items, *, force=True, enabled=True):
        sub = self.store.add_subscription(anime_id=7, keyword="孤独摇滚", group_name="A", enabled=enabled)
        with patch.object(mikan, "search", return_value={"base": "https://mikanime.tv", "items": items, "truncated": False}):
            result = self.service.check_subscriptions(force=force)
        return sub, result

    def test_disabled_when_auto_follow_off_and_not_forced(self):
        offline_config.save(self.root, {"media_root": str(self.root / "media"), "auto_follow": False})
        self.store.add_subscription(anime_id=7, keyword="番")
        with patch.object(mikan, "search") as search:
            result = self.service.check_subscriptions(force=False)
        self.assertTrue(result["skipped"])
        self.assertEqual(result["downloaded"], 0)
        search.assert_not_called()

    def test_first_check_only_records_baseline(self):
        sub, result = self.run_check([item("t1", "A", "2026-11-01T10:00:00")])
        self.assertEqual(result["downloaded"], 0)
        self.assertEqual(self.downloaded, [])
        self.assertEqual(result["items"][0]["status"], "baseline")
        row = self.store.subscriptions()[0]
        self.assertEqual(row["last_checked"], "2026-11-01T10:00:00")
        self.assertEqual(row["last_torrent"], "t1")

    def test_newer_entry_is_downloaded_once(self):
        sub, _ = self.run_check([item("t1", "A", "2026-11-01T10:00:00")])
        self.downloaded.clear()
        _, result = self.run_check(
            [
                item("t1", "A", "2026-11-01T10:00:00"),
                item("t2", "A", "2026-11-03T10:00:00"),
            ]
        )
        self.assertEqual(result["downloaded"], 1)
        self.assertEqual(len(self.downloaded), 1)
        self.assertEqual(self.downloaded[0]["torrent_url"], "https://mikanime.tv/Download/t2.torrent")
        self.assertEqual(self.store.subscriptions()[0]["last_torrent"], "t2")

    def test_same_torrent_is_not_downloaded_twice(self):
        self.run_check([item("t2", "A", "2026-11-03T10:00:00")])
        self.downloaded.clear()
        _, result = self.run_check([item("t2", "A", "2026-11-03T10:00:00")])
        self.assertEqual(result["downloaded"], 0)
        self.assertEqual(self.downloaded, [])

    def test_other_group_is_ignored(self):
        self.run_check([item("t1", "A", "2026-11-01T10:00:00")])
        self.downloaded.clear()
        _, result = self.run_check([item("t9", "B", "2026-11-05T10:00:00")])
        self.assertEqual(result["downloaded"], 0)
        self.assertEqual(self.downloaded, [])

    def test_only_the_newest_is_taken_when_many_are_pending(self):
        self.run_check([item("t1", "A", "2026-11-01T10:00:00")])
        self.downloaded.clear()
        _, result = self.run_check(
            [
                item("t2", "A", "2026-11-02T10:00:00"),
                item("t3", "A", "2026-11-03T10:00:00"),
                item("t4", "A", "2026-11-04T10:00:00"),
            ]
        )
        self.assertEqual(result["downloaded"], 1)
        self.assertEqual(len(self.downloaded), 1)
        self.assertEqual(self.downloaded[0]["torrent_url"], "https://mikanime.tv/Download/t4.torrent")

    def test_search_failure_is_reported_not_raised(self):
        with patch.object(mikan, "search", side_effect=mikan.MikanError("连不上")):
            self.store.add_subscription(anime_id=7, keyword="番")
            result = self.service.check_subscriptions(force=True)
        self.assertEqual(result["items"][0]["status"], "error")
        self.assertIn("连不上", result["items"][0]["title"])

    def test_disabled_subscription_is_skipped(self):
        _, result = self.run_check([item("t1", "A", "2026-11-01T10:00:00")], enabled=False)
        self.assertEqual(result["checked"], 0)
        self.assertEqual(self.downloaded, [])


if __name__ == "__main__":
    unittest.main()
