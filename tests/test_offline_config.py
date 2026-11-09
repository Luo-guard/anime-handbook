"""离线配置：默认值、类型收敛、落盘往返。"""
import json
import tempfile
import threading
import unittest
from pathlib import Path

from handbook import offline_config as cfg


class NormalizeTest(unittest.TestCase):
    def test_defaults(self):
        result = cfg.normalize({})
        self.assertEqual(result["qb_host"], "127.0.0.1")
        self.assertEqual(result["qb_port"], 8080)
        self.assertEqual(result["qb_category"], "AnimeHandbook")
        self.assertTrue(result["seed_after_done"])
        self.assertFalse(result["auto_follow"])
        self.assertEqual(result["last_group"], {})

    def test_non_dict_input_falls_back(self):
        self.assertEqual(cfg.normalize("nonsense")["qb_port"], 8080)
        self.assertEqual(cfg.normalize(None)["qb_port"], 8080)

    def test_paths_use_forward_slashes_and_no_trailing_separator(self):
        result = cfg.normalize({"media_root": "D:\\动漫\\离线视频\\", "download_root": "E:/tmp//"})
        self.assertEqual(result["media_root"], "D:/动漫/离线视频")
        self.assertEqual(result["download_root"], "E:/tmp")

    def test_port_is_clamped(self):
        self.assertEqual(cfg.normalize({"qb_port": 0})["qb_port"], 1)
        self.assertEqual(cfg.normalize({"qb_port": 99999})["qb_port"], 65535)
        self.assertEqual(cfg.normalize({"qb_port": "abc"})["qb_port"], 8080)

    def test_unknown_keys_are_dropped(self):
        result = cfg.normalize({"media_root": "D:/x", "evil": "rm -rf"})
        self.assertNotIn("evil", result)

    def test_last_group_only_keeps_digit_ids(self):
        result = cfg.normalize({"last_group": {"12": "VCB-Studio", "abc": "X", "13": ""}})
        self.assertEqual(result["last_group"], {"12": "VCB-Studio"})

    def test_empty_host_and_category_fall_back(self):
        result = cfg.normalize({"qb_host": "  ", "qb_category": ""})
        self.assertEqual(result["qb_host"], "127.0.0.1")
        self.assertEqual(result["qb_category"], "AnimeHandbook")


class ResolveTest(unittest.TestCase):
    def test_default_media_root_is_absolute(self):
        root = cfg.default_media_root()
        self.assertTrue(Path(root).is_absolute())
        # 默认放在项目内的 media/，跟项目同盘，备份/搬移时媒体跟着走
        self.assertEqual(Path(root), Path(cfg.__file__).resolve().parents[1] / "media")
        self.assertTrue(root.endswith("/media"))

    def test_download_root_defaults_inside_media_root(self):
        paths = cfg.resolved({"media_root": "D:/media", "download_root": ""})
        self.assertEqual(paths["media_root"], "D:/media")
        self.assertEqual(paths["download_root"], "D:/media/_incoming")

    def test_explicit_download_root_wins(self):
        paths = cfg.resolved({"media_root": "D:/media", "download_root": "E:/incoming"})
        self.assertEqual(paths["download_root"], "E:/incoming")


class PersistenceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_missing_file_returns_defaults(self):
        self.assertEqual(cfg.load(self.root)["qb_port"], 8080)

    def test_roundtrip(self):
        cfg.save(self.root, {"media_root": "D:/videos", "qb_port": 9091, "auto_follow": True})
        loaded = cfg.load(self.root)
        self.assertEqual(loaded["media_root"], "D:/videos")
        self.assertEqual(loaded["qb_port"], 9091)
        self.assertTrue(loaded["auto_follow"])

    def test_broken_json_returns_defaults(self):
        (self.root / cfg.CONFIG_FILE).write_text("{not json", encoding="utf-8")
        self.assertEqual(cfg.load(self.root)["qb_port"], 8080)

    def test_saved_file_is_readable_utf8(self):
        cfg.save(self.root, {"media_root": "D:/动漫/离线视频"})
        raw = json.loads((self.root / cfg.CONFIG_FILE).read_text(encoding="utf-8"))
        self.assertEqual(raw["media_root"], "D:/动漫/离线视频")

    def test_remember_group_persists(self):
        cfg.remember_group(self.root, 12, "VCB-Studio")
        cfg.remember_group(self.root, "13", "LoliHouse")
        groups = cfg.load(self.root)["last_group"]
        self.assertEqual(groups["12"], "VCB-Studio")
        self.assertEqual(groups["13"], "LoliHouse")

    def test_patch_only_touches_the_given_keys(self):
        """审计 N20：记住镜像主机不能把字幕组偏好一起写掉。"""
        cfg.save(self.root, {"media_root": "D:/media", "auto_follow": True})
        cfg.remember_group(self.root, 12, "VCB-Studio")
        cfg.patch(self.root, mikan_host="https://mikanime.tv")
        loaded = cfg.load(self.root)
        self.assertEqual(loaded["mikan_host"], "https://mikanime.tv")
        self.assertEqual(loaded["last_group"]["12"], "VCB-Studio")
        self.assertEqual(loaded["media_root"], "D:/media")
        self.assertTrue(loaded["auto_follow"])

    def test_concurrent_patches_do_not_lose_each_other(self):
        """两个线程同时「读-改-写」不同的键，两条都要留下。"""
        cfg.save(self.root, {"media_root": "D:/media"})
        threads = [
            threading.Thread(target=cfg.remember_group, args=(self.root, 21, "LoliHouse")),
            threading.Thread(target=cfg.patch, args=(self.root,), kwargs={"mikan_host": "https://mikanime.tv"}),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        loaded = cfg.load(self.root)
        self.assertEqual(loaded["last_group"]["21"], "LoliHouse")
        self.assertEqual(loaded["mikan_host"], "https://mikanime.tv")

    def test_settings_save_keeps_learned_state(self):
        """设置页只提交表单里的键，mikan_host / last_group 不该被清空。"""
        cfg.save(self.root, {"media_root": "D:/old", "auto_follow": False})
        cfg.remember_group(self.root, 12, "VCB-Studio")
        cfg.patch(self.root, mikan_host="https://mikanime.tv")
        cfg.save_settings(self.root, {"media_root": "D:/new", "auto_follow": True, "qb_port": 9091})
        loaded = cfg.load(self.root)
        self.assertEqual(loaded["media_root"], "D:/new")
        self.assertTrue(loaded["auto_follow"])
        self.assertEqual(loaded["qb_port"], 9091)
        self.assertEqual(loaded["mikan_host"], "https://mikanime.tv")
        self.assertEqual(loaded["last_group"]["12"], "VCB-Studio")

    def test_ensure_dirs_creates_and_writes(self):
        status = cfg.ensure_dirs({"media_root": str(self.root / "media"), "download_root": ""})
        self.assertTrue(status["ok"], status.get("error"))
        self.assertTrue((self.root / "media" / "_incoming").is_dir())

    def test_ensure_dirs_reports_unwritable(self):
        # 用一个已存在的文件当目录，mkdir 必然失败。
        blocker = self.root / "blocked"
        blocker.write_text("x", encoding="utf-8")
        status = cfg.ensure_dirs({"media_root": str(blocker / "sub"), "download_root": ""})
        self.assertFalse(status["ok"])
        self.assertIn("不可写", status["error"])

    def test_ensure_dirs_is_safe_under_concurrency(self):
        """审计 N14：固定探测名会让并发请求互相删文件，误报目录不可写。"""
        config = {"media_root": str(self.root / "concurrent"), "download_root": ""}
        errors = []
        barrier = threading.Barrier(16)

        def worker():
            try:
                barrier.wait(timeout=5)
                status = cfg.ensure_dirs(config)
                if not status["ok"]:
                    errors.append(status["error"])
            except Exception as error:  # noqa: BLE001 - 测试里要把所有失败都收上来
                errors.append(repr(error))

        threads = [threading.Thread(target=worker) for _ in range(16)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)
        self.assertEqual(errors, [], "并发探测不应误报不可写")
        root = self.root / "concurrent"
        self.assertEqual(list(root.glob(".handbook-write-test*")), [], "临时探测文件不能残留")
        self.assertFalse((root / ".handbook-write-test").exists(), "不再使用固定文件名")


if __name__ == "__main__":
    unittest.main()
