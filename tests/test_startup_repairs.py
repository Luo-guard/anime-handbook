"""Startup order: the window must open before any repair touches the network."""
from __future__ import annotations

import threading
import time
import unittest
from unittest.mock import patch

from handbook import desktop


class StubDatabase:
    def __init__(self):
        self.progress_calls = 0
        self.revision_bumps = 0

    def list_anime(self):
        return [{"id": 1}, {"id": 2}]

    def recover_progress_from_watch_events(self, ids):
        self.progress_calls += 1
        self.ids = ids

    def get_settings(self):
        return {"theme_profiles": [{"id": "default"}]}

    def _touch_revision(self):
        self.revision_bumps += 1


class StubSync:
    def __init__(self):
        self.repairs = 0
        self.fail = False

    def repair_legacy_watch_episode_keys(self):
        self.repairs += 1
        if self.fail:
            raise RuntimeError("Bangumi is unreachable")


class StartupOrderTest(unittest.TestCase):
    def test_server_serves_before_repairs_run(self):
        order = []
        serving = threading.Event()

        def slow_repair(database, sync):
            serving.wait(timeout=1)
            order.append("repair")

        class FakeServer:
            def __init__(self, *args, **kwargs):
                pass

            def serve_forever(self, poll_interval=0.25):
                order.append("serve")
                serving.set()

            def server_close(self):
                pass

        with patch.object(desktop, "_startup_repairs", slow_repair), \
             patch.object(desktop, "DesktopHTTPServer", FakeServer), \
             patch.object(desktop, "server_is_running", return_value=False), \
             patch.object(desktop.SYNC, "start_background"), \
             patch.object(desktop.SHARING, "start_resident_refresh"), \
             patch.object(desktop.WEBDAV, "start_background"), \
             patch.object(desktop.webbrowser, "open") as open_browser, \
             patch("handbook.kazumi_writeback.start_worker", lambda *args, **kwargs: None):
            desktop.main(open_browser=False)

        for _ in range(100):
            if order == ["serve", "repair"]:
                break
            time.sleep(0.01)
        self.assertEqual(order, ["serve", "repair"], "the port must be open before the repair starts")
        open_browser.assert_not_called()

    def test_repair_failure_does_not_stop_the_remaining_steps(self):
        database, sync = StubDatabase(), StubSync()
        sync.fail = True
        calls = []

        with patch.object(desktop, "migrate_legacy_backgrounds", side_effect=RuntimeError("bad image")), \
             patch.object(desktop, "run_housekeeping", lambda *args, **kwargs: calls.append("housekeeping")) as housekeeping:
            desktop._startup_repairs(database, sync)

        self.assertEqual(database.ids, [1, 2])
        self.assertEqual(sync.repairs, 1, "the network repair was attempted")
        self.assertEqual(calls, ["housekeeping"], "a failed repair still lets the sweep run")
        self.assertEqual(database.revision_bumps, 1, "the page is told to reload once at the end")

    def test_successful_repairs_bump_the_revision_once(self):
        database, sync = StubDatabase(), StubSync()
        with patch.object(desktop, "migrate_legacy_backgrounds"), \
             patch.object(desktop, "run_housekeeping"):
            desktop._startup_repairs(database, sync)
        self.assertEqual(database.progress_calls, 1)
        self.assertEqual(sync.repairs, 1)
        self.assertEqual(database.revision_bumps, 1)


if __name__ == "__main__":
    unittest.main()
