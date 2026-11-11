"""媒体库迁移：复制、校验、切换指向；失败就不动。"""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

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

    def test_failure_rolls_back_and_keeps_database(self):
        """审计 N8：中途失败不能留下「DB 指新目录、配置指旧目录」两套库。

        旧逻辑边复制边改 DB，第 2 集失败时第 1、3 集已经切到新目录，配置却
        还指旧目录 —— 盘上两套、回收站和后续下载都走旧目录。
        """
        self.make_episode(1)
        broken = self.make_episode(2)
        self.make_episode(3)
        Path(broken["file_path"]).unlink()
        destination = self.root / "new-media"
        result = self.service.migrate_media_root(str(destination))
        self.assertFalse(result["switched"])
        self.assertTrue(result["rolled_back"])
        self.assertEqual(result["copied"], 0)
        self.assertEqual(result["attempted"], 2)
        self.assertEqual(len(result["failed"]), 1)
        # 数据库一条都没改，仍全部指向原目录。
        for number in (1, 3):
            row = self.store.file_for(1, f"0:{number}")
            self.assertTrue(
                str(row["file_path"]).replace("\\", "/").startswith(
                    str(self.media).replace("\\", "/")
                ),
                row["file_path"],
            )
        # 复制到新目录的副本已清掉，不留下半套媒体库。
        self.assertFalse((destination / "测试番" / "第 01 集.mp4").exists())
        self.assertFalse((destination / "测试番" / "第 03 集.mp4").exists())
        self.assertEqual(
            offline_config.resolved(offline_config.load(self.root))["media_root"],
            str(self.media).replace("\\", "/"),
        )

    def test_failed_migration_keeps_source_files(self):
        """失败时即使点开「删除源文件」也不能把原件删掉。"""
        self.make_episode(1)
        broken = self.make_episode(2)
        Path(broken["file_path"]).unlink()
        self.service.migrate_media_root(str(self.root / "new-media"), delete_source=True)
        self.assertTrue((self.media / "测试番" / "第 01 集.mp4").is_file())

    def test_migrates_fonts_directory(self):
        """审计 N8：_fonts 不迁的话，迁移后特效字幕会回退默认字体。"""
        self.make_episode(1)
        fonts = self.media / "测试番" / "_fonts"
        fonts.mkdir()
        (fonts / "方正准圆.ttf").write_bytes(b"font-bytes")
        destination = self.root / "new-media"
        result = self.service.migrate_media_root(str(destination))
        self.assertTrue(result["switched"])
        self.assertEqual(result["fonts"], 1)
        self.assertTrue((destination / "测试番" / "_fonts" / "方正准圆.ttf").is_file())

    def test_conflicting_destination_is_preserved_and_new_copies_roll_back(self):
        first = self.make_episode(1)
        second = self.make_episode(2, b"new video")
        destination = self.root / "new-media"
        conflict = destination / Path(second["file_path"]).relative_to(self.media)
        conflict.parent.mkdir(parents=True)
        conflict.write_bytes(b"old video")  # Same size, different content.

        result = self.service.migrate_media_root(str(destination), delete_source=True)

        self.assertFalse(result["switched"])
        self.assertIn("同名文件", result["failed"][0]["reason"])
        self.assertEqual(conflict.read_bytes(), b"old video")
        self.assertFalse((destination / Path(first["file_path"]).relative_to(self.media)).exists())
        self.assertTrue(Path(first["file_path"]).is_file())
        self.assertEqual(self.store.all_files(), [first, second])

    def test_identical_destination_can_be_reused(self):
        row = self.make_episode(1)
        destination = self.root / "new-media"
        video = destination / Path(row["file_path"]).relative_to(self.media)
        video.parent.mkdir(parents=True)
        video.write_bytes(Path(row["file_path"]).read_bytes())
        self.assertTrue(self.service.migrate_media_root(str(destination))["switched"])
        self.assertEqual(Path(self.store.file_for(1, "0:1")["file_path"]), video)

    def test_database_failure_restores_config_and_all_paths(self):
        first = self.make_episode(1)
        second = self.make_episode(2)
        destination = self.root / "new-media"
        before = self.service.config()
        replace_file = self.service.store.replace_file

        def fail_second(**fields):
            if fields["episode_key"] == "0:2":
                raise OSError("模拟第二条数据库写入失败")
            return replace_file(**fields)

        with patch.object(self.service.store, "replace_file", side_effect=fail_second):
            with self.assertRaisesRegex(OfflineError, "模拟第二条"):
                self.service.migrate_media_root(str(destination), delete_source=True)

        self.assertEqual(self.store.all_files(), [first, second])
        self.assertEqual(self.service.config(), before)
        self.assertEqual(list(destination.rglob("*.mp4")), [])
        self.assertTrue(Path(first["file_path"]).is_file())

    def test_config_failure_keeps_database_and_removes_copies(self):
        row = self.make_episode(1)
        destination = self.root / "new-media"
        before = self.service.config()
        with patch.object(offline_config, "save", side_effect=OSError("模拟配置写入失败")):
            with self.assertRaisesRegex(OfflineError, "模拟配置写入失败"):
                self.service.migrate_media_root(str(destination), delete_source=True)

        self.assertEqual(self.store.all_files(), [row])
        self.assertEqual(self.service.config(), before)
        self.assertEqual(list(destination.rglob("*.mp4")), [])
        self.assertTrue(Path(row["file_path"]).is_file())


if __name__ == "__main__":
    unittest.main()
