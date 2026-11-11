"""Background subscription checks use temporary data and fake network clients."""
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from handbook import database, mikan, offline_config, offline_service
from handbook.common import now_iso


def inline_thread(*, target, **kwargs):
    return SimpleNamespace(start=target)


class OfflineWorkerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = database.HandbookDB(self.root / "handbook.db", asset_root=self.root)
        self.service = offline_service.OfflineService(self.db)
        offline_config.save(self.root, {"auto_follow": True, "media_root": str(self.root / "media")})
        self.sub = self.service.store.add_subscription(anime_id=7, keyword="测试番", group_name="A")
        self.service.store.touch_subscription(
            self.sub["id"], last_checked="2026-01-01T00:00:00+08:00", last_torrent="e1"
        )
        for patcher in (
            patch.dict("os.environ", {"ANIME_HANDBOOK_SANDBOX": "0"}),
            patch.object(offline_service, "_AUTO_CHECK_RUNNING", False),
            patch.object(offline_service, "_AUTO_CHECK_NEXT", {}),
            patch.object(offline_service.threading, "Thread", side_effect=inline_thread),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def heartbeat(self):
        stop = Mock()
        stop.wait.side_effect = [False, True]
        with patch.object(offline_service, "_WORKER_STOP", None):
            offline_service.start_background_worker(lambda: self.db, stop=stop)

    def test_heartbeat_downloads_new_episode_without_opening_a_page(self):
        entries = [{"id": key, "title": f"[A] 测试番 - {number:02d}", "group": "A",
                    "torrent_url": f"https://example.test/{key}.torrent", "published_at": ""}
                   for key, number in [("e1", 1), ("e2", 2)]]
        with patch.object(mikan, "search", return_value={"items": entries}), \
                patch.object(offline_service.OfflineService, "download", return_value={"ok": True}) as download, \
                patch.object(offline_service.OfflineService, "sync_all"), \
                patch.object(offline_service.OfflineService, "state", side_effect=AssertionError("No page request")):
            self.heartbeat()
            self.heartbeat()
        download.assert_called_once()
        self.assertEqual(download.call_args.kwargs["torrent_url"], "https://example.test/e2.torrent")
        self.assertEqual(self.service.store.subscriptions()[0]["last_torrent"], "e2")

    def test_feed_failure_is_throttled_and_retried(self):
        with patch.object(mikan, "search", side_effect=mikan.MikanError("offline")) as search, \
                patch.object(offline_service.time, "monotonic", return_value=100):
            self.service.maybe_auto_check()
            self.service.maybe_auto_check()
            search.assert_called_once()
            with patch.object(offline_service.time, "monotonic", return_value=161):
                self.service.maybe_auto_check()
            self.assertEqual(search.call_count, 2)
        self.assertFalse(offline_service._AUTO_CHECK_RUNNING)
        self.assertEqual(self.service.store.subscriptions()[0]["last_torrent"], "e1")

    def test_disabled_sandbox_and_recent_subscriptions_do_not_query_feed(self):
        with patch.object(mikan, "search") as search:
            offline_config.patch(self.root, auto_follow=False)
            self.service.maybe_auto_check()
            offline_config.patch(self.root, auto_follow=True)
            with patch.dict("os.environ", {"ANIME_HANDBOOK_SANDBOX": "1"}):
                self.service.maybe_auto_check()
            self.service.store.touch_subscription(self.sub["id"], last_checked=now_iso())
            self.service.maybe_auto_check()
            search.assert_not_called()

    def test_running_check_is_not_started_again(self):
        with patch.object(offline_service, "_AUTO_CHECK_RUNNING", True), \
                patch.object(mikan, "search") as search:
            self.service.maybe_auto_check()
            search.assert_not_called()

    def test_subscription_failure_does_not_block_download_heartbeat(self):
        with patch.object(offline_service.OfflineService, "maybe_auto_check", side_effect=OSError("config")), \
                patch.object(offline_service.OfflineService, "sync_all") as sync:
            self.heartbeat()
            sync.assert_called_once()


if __name__ == "__main__":
    unittest.main()
