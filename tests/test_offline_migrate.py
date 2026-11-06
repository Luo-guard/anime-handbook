"""媒体库迁移：复制、校验、切换指向；失败就不动。"""
import tempfile
import unittest
from pathlib import Path

from handbook import database, offline_config
from handbook.offline import OfflineStore
from handbook.offline_service import OfflineError, OfflineService


class MigrateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.db = database.HandbookDB(self.root / "handbook.db", asset_root=self.root)
        self.store = OfflineStore(self.db)
        self.media = self.root / "media"
        (self.media / "测试番").mkdir(parents=True)
        offline_config.save(self.root, {"media_root": str(self.media)})
        self.service = OfflineService(self.db)

    def tearDown(self):
        self.tmp.cleanup()

    def make_episode(self, number: int, content: bytes = b"video-bytes") -> dict:
        target = self.media / "测试番" / f"第 {number:02d} 集.mp4"
        target.write_bytes(content)
        subtitle = self.media / "测试番" / f"第 {number:02d} 集.ass"
        subtitle.write_text("[Script Info]", encoding="utf-8")
        self.store.replace_file(
            anime_id=1,
            episode_key=f"0:{number}",
            file_path=str(target),
            file_size=len(content),
            subtitle_path=str(subtitle),
        )
        return self.store.file_for(1, f"0:{number}")

    def test_copies_and_switches_root(self):
        self.make_episode(1)
        self.make_episode(2)
        destination = self.root / "new-media"
        result = self.service.migrate_media_root(str(destination))
        self.assertTrue(result["switched"])
        self.assertEqual(result["copied"], 2)
        self.assertEqual(result["failed"], [])
        moved = self.store.file_for(1, "0:1")
        self.assertTrue(Path(moved["file_path"]).is_file())
        self.assertTrue(str(moved["file_path"]).replace("\\", "/").startswith(str(destination).replace("\\", "/")))
        self.assertTrue((destination / "测试番" / "第 01 集.mp4").is_file())
        self.assertTrue((destination / "测试番" / "第 01 集.ass").is_file())
        # 默认不动源文件
        self.assertTrue((self.media / "测试番" / "第 01 集.mp4").is_file())
        self.assertEqual(offline_config.resolved(offline_config.load(self.root))["media_root"],
                         str(destination).replace("\\", "/"))

    def test_same_directory_rejected(self):
        with self.assertRaises(OfflineError) as caught:
            self.service.migrate_media_root(str(self.media))
        self.assertIn("同一个", str(caught.exception))

    def test_empty_target_rejected(self):
        with self.assertRaises(OfflineError):
            self.service.migrate_media_root("   ")

    def test_missing_source_blocks_switch(self):
        row = self.make_episode(1)
        Path(row["file_path"]).unlink()
        destination = self.root / "new-media"
        result = self.service.migrate_media_root(str(destination))
        self.assertFalse(result["switched"])
        self.assertEqual(result["copied"], 0)
        self.assertEqual(len(result["failed"]), 1)
        # 目录没切换，数据库仍指向原路径
        self.assertEqual(
            offline_config.resolved(offline_config.load(self.root))["media_root"],
            str(self.media).replace("\\", "/"),
        )

    def test_delete_source_when_explicitly_requested(self):
        self.make_episode(1)
        destination = self.root / "new-media"
        self.service.migrate_media_root(str(destination), delete_source=True)
        self.assertFalse((self.media / "测试番" / "第 01 集.mp4").exists())
        self.assertTrue((destination / "测试番" / "第 01 集.mp4").is_file())

    def test_resume_progress_survives_migration(self):
        self.make_episode(1)
        self.store.set_resume(1, "0:1", 12345)
        self.service.migrate_media_root(str(self.root / "new-media"))
        self.assertEqual(self.store.file_for(1, "0:1")["resume_ms"], 12345)


if __name__ == "__main__":
    unittest.main()
