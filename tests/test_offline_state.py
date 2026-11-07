"""离线 state 的「这集还能不能播」判断（审计 N11）。

以前只有 local_files 一行记录，文件被外部删掉后界面照样显示「可以播放」，
点下去才在 /api/offline/stream 吃一个 404。现在 state 每次都核对 file_path，
检查只发生在读取层：盘插回来、文件放回原位就自动恢复，不改数据库。
"""
import tempfile
import unittest
from pathlib import Path

from handbook import database, offline_config
from handbook.offline import OfflineStore
from handbook.offline_service import OfflineService


class OfflineStateMissingTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.media = self.root / "media"
        self.media.mkdir()
        self.db = database.HandbookDB(self.root / "handbook.db", asset_root=self.root)
        offline_config.save(self.root, {"media_root": str(self.media), "auto_follow": False})
        self.store = OfflineStore(self.db)
        self.service = OfflineService(self.db)

    def tearDown(self):
        self.tmp.cleanup()

    def make_file(self, key: str, *, name: str, subtitle: str = "") -> dict:
        path = self.media / name
        path.write_bytes(b"x" * 32)
        subtitle_path = ""
        if subtitle:
            sub = self.media / subtitle
            sub.write_text("[Script Info]\n", encoding="utf-8")
            subtitle_path = str(sub)
        return self.store.replace_file(
            anime_id=11,
            episode_key=key,
            file_path=str(path),
            file_size=32,
            duration_ms=1440000,
            subtitle_path=subtitle_path,
        )

    def test_existing_file_is_playable(self):
        self.make_file("0:1", name="第 01 集.mp4", subtitle="第 01 集.ass")
        state = self.service.state(11, refresh=False)
        self.assertEqual(state["ready_episodes"], ["0:1"])
        self.assertEqual(state["missing_keys"], [])
        self.assertEqual(state["missing_count"], 0)
        row = state["files"][0]
        self.assertTrue(row["exists"])
        self.assertTrue(row["has_subtitle"])

    def test_deleted_file_is_not_reported_as_playable(self):
        row = self.make_file("0:1", name="第 01 集.mp4")
        Path(row["file_path"]).unlink()
        state = self.service.state(11, refresh=False)
        self.assertEqual(state["ready_episodes"], [])
        self.assertEqual(state["missing_keys"], ["0:1"])
        self.assertEqual(state["missing_count"], 1)
        self.assertFalse(state["files"][0]["exists"])

    def test_subtitle_is_checked_separately(self):
        """视频还在、字幕被删：能播，但不再标「字幕」。"""
        row = self.make_file("0:2", name="第 02 集.mp4", subtitle="第 02 集.ass")
        Path(row["subtitle_path"]).unlink()
        state = self.service.state(11, refresh=False)
        self.assertTrue(state["files"][0]["exists"])
        self.assertFalse(state["files"][0]["has_subtitle"])
        self.assertEqual(state["ready_episodes"], ["0:2"])

    def test_record_is_kept_so_the_file_can_come_back(self):
        """外接盘临时没插：记录要留着，盘插回来自动恢复播放。"""
        row = self.make_file("0:3", name="第 03 集.mp4")
        original = Path(row["file_path"])
        parked = self.root / "拔掉的盘" / "第 03 集.mp4"
        parked.parent.mkdir()
        original.rename(parked)

        self.assertFalse(self.service.state(11, refresh=False)["files"][0]["exists"])
        # 记录没被删，续播进度也还在。
        kept = self.store.file_for(11, "0:3")
        self.assertIsNotNone(kept)
        self.assertEqual(kept["duration_ms"], 1440000)

        parked.rename(original)
        state = self.service.state(11, refresh=False)
        self.assertTrue(state["files"][0]["exists"])
        self.assertEqual(state["ready_episodes"], ["0:3"])

    def test_missing_list_keeps_episode_order(self):
        for key, name in (("0:10", "第 10 集.mp4"), ("0:2", "第 02 集.mp4")):
            row = self.make_file(key, name=name)
            Path(row["file_path"]).unlink()
        state = self.service.state(11, refresh=False)
        self.assertEqual(state["missing_keys"], ["0:2", "0:10"])


if __name__ == "__main__":
    unittest.main()
