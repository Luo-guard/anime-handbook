"""截图批量删除：多删不误伤、单张失败不拖累整批、目录越界要挡住。"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from handbook import offline_config, screenshots


class DeleteImagesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.shots = self.root / "media" / "截图"
        self.shots.mkdir(parents=True)
        offline_config.save(self.root, {"media_root": str(self.root / "media")})

    def tearDown(self):
        self.tmp.cleanup()

    def _image(self, folder: str, name: str) -> str:
        target = self.shots / folder / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 16)
        return f"{folder}/{name}"

    def test_deletes_every_selected_and_cleans_empty_folder(self):
        a = self._image("番剧A", "第01集_00-10.png")
        b = self._image("番剧A", "第01集_00-20.png")
        c = self._image("番剧B", "第02集_00-30.png")

        result = screenshots.delete_images(self.root, [a, b, c])

        self.assertTrue(result["ok"])
        self.assertEqual(sorted(result["deleted"]), sorted([a, b, c]))
        self.assertEqual(result["failed"], [])
        self.assertFalse((self.shots / "番剧A").exists(), "整组删空后文件夹要收掉")
        self.assertFalse((self.shots / "番剧B").exists())

    def test_one_missing_file_does_not_block_the_rest(self):
        a = self._image("番剧A", "第01集_00-10.png")
        missing = "番剧A/不存在.png"

        result = screenshots.delete_images(self.root, [a, missing])

        self.assertEqual(result["deleted"], [a])
        self.assertEqual([item["relative"] for item in result["failed"]], [missing])
        self.assertFalse((self.shots / "番剧A" / "第01集_00-10.png").exists())

    def test_rejects_paths_outside_the_screenshot_root(self):
        outside = self.root / "隐私.png"
        outside.write_bytes(b"\x89PNG\r\n\x1a\n")

        result = screenshots.delete_images(self.root, ["../隐私.png", str(outside)])

        self.assertEqual(result["deleted"], [])
        self.assertEqual(len(result["failed"]), 2)
        self.assertTrue(outside.exists(), "截图目录外的文件一张都不能动")

    def test_empty_selection_is_an_error(self):
        with self.assertRaises(ValueError):
            screenshots.delete_images(self.root, [])
        with self.assertRaises(ValueError):
            screenshots.delete_images(self.root, ["", "   "])

    def test_duplicate_entries_only_delete_once(self):
        a = self._image("番剧A", "第01集_00-10.png")

        result = screenshots.delete_images(self.root, [a, a, a])

        self.assertEqual(result["deleted"], [a])

    def test_lists_only_the_associated_anime_folders(self):
        related = self._image("番剧_第一季", "shot.png")
        self._image("番剧_第二季", "other.png")
        (self.shots / "原名").mkdir()

        groups = screenshots.list_library(self.root, anime_names=("番剧:第一季", "原名"))["groups"]
        self.assertEqual([group["folder"] for group in groups], ["番剧_第一季", "原名"])
        self.assertEqual([image["relative"] for image in groups[0]["images"]], [related])
        self.assertEqual(groups[1]["images"], [])
        self.assertEqual(screenshots.list_library(self.root, anime_names=())["groups"], [])


if __name__ == "__main__":
    unittest.main()
