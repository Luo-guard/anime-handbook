"""媒体处理：集数识别、ffprobe、remux、字幕抽取。

除了「真实封装」那一组会调用本机 ffmpeg（用 1 秒的空视频，几十毫秒完成），
其余都是纯函数，不碰外部命令。
"""
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from handbook import media


class EpisodeNumberTest(unittest.TestCase):
    def test_fansub_dash_form(self):
        self.assertEqual(media.episode_number("[LoliHouse] 某番 - 12 [WebRip 1080p HEVC-10bit].mkv"), 12)

    def test_chinese_episode_form(self):
        self.assertEqual(media.episode_number("[组] 某番 第07话 [1080p].mkv"), 7)

    def test_sxxexx_form(self):
        self.assertEqual(media.episode_number("Show.S01E05.1080p.mkv"), 5)

    def test_bare_number_file(self):
        self.assertEqual(media.episode_number("01.mkv"), 1)
        self.assertEqual(media.episode_number("003.mp4"), 3)

    def test_resolution_and_year_are_not_mistaken_for_episodes(self):
        # 1080p / 2026 都不该被当成集数；这里没有可靠的集数，应返回 0。
        self.assertEqual(media.episode_number("[VCB-Studio] Full Metal Panic BDRip 1080p.mkv"), 0)

    def test_bracket_noise_is_ignored(self):
        # 方括号里的 “01-12+SPx1” 是合集范围，不是当前集数。
        self.assertEqual(media.episode_number("[7³ACG] 番 [01-12+SPx1][1080p].mkv"), 0)

    def test_ep_key_and_filename(self):
        self.assertEqual(media.episode_key(7), "0:7")
        self.assertEqual(media.episode_filename(7), "第 07 集")
        self.assertEqual(media.episode_filename(123), "第 123 集")


class SafeNameTest(unittest.TestCase):
    def test_strips_windows_forbidden_characters(self):
        self.assertEqual(media.safe_name('Re:Zero / 从零开始<异世界>'), "Re Zero 从零开始 异世界")

    def test_empty_falls_back(self):
        self.assertEqual(media.safe_name("   ", fallback="未命名"), "未命名")
        self.assertEqual(media.safe_name("///"), "未命名番剧")

    def test_truncates(self):
        self.assertLessEqual(len(media.safe_name("番" * 200)), 80)


class VideoFilesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def make(self, name: str, size: int = 6 * 1024 * 1024) -> Path:
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"0" * size)
        return path

    def test_sorted_by_episode_and_filters_noise(self):
        self.make("番 - 02.mkv")
        self.make("番 - 01.mkv")
        self.make("番 - 01.sample.mkv")
        self.make("说明.txt")
        self.make("番 - 03.mkv", size=0)  # 空壳文件，当作没写完
        names = [path.name for path in media.video_files(self.root)]
        self.assertEqual(names, ["番 - 01.mkv", "番 - 02.mkv"])

    def test_single_file_input(self):
        target = self.make("番 - 05.mkv")
        self.assertEqual(media.video_files(target), [target])

    def test_missing_path_is_empty(self):
        self.assertEqual(media.video_files(self.root / "没有这个目录"), [])


class ToolPathTest(unittest.TestCase):
    def test_finds_ffmpeg_on_path(self):
        found = media.tool_path("ffmpeg")
        self.assertTrue(found)

    def test_missing_tool_is_empty(self):
        self.assertEqual(media.tool_path("definitely-not-a-real-binary-xyz"), "")


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "需要本机 ffmpeg")
class RealRemuxTest(unittest.TestCase):
    """真跑一遍 ffmpeg，确认 hvc1 标记和字幕抽取都对。"""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tmp.name)
        cls.source = cls.root / "src.mkv"
        command = [
            "ffmpeg", "-y", "-loglevel", "error",
            "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=12",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
            "-t", "1",
            "-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le",
            "-x265-params", "log-level=none",
            "-c:a", "aac", "-shortest",
            str(cls.source),
        ]
        subprocess.run(command, capture_output=True, timeout=180, check=True)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_probe_reads_codec(self):
        info = media.probe(self.source)
        self.assertEqual(info["codec"], "hevc")
        self.assertIn("10", info["pix_fmt"])
        self.assertEqual(info["width"], 320)
        self.assertGreater(info["duration_ms"], 0)

    def test_remux_marks_hvc1_and_keeps_size(self):
        target = self.root / "out.mp4"
        result = media.remux(self.source, target, codec="hevc")
        self.assertTrue(target.is_file())
        self.assertEqual(result["size"], target.stat().st_size)
        # 无损换壳：体积应当和源文件几乎一致（mp4 头比 mkv 略小）。
        ratio = target.stat().st_size / self.source.stat().st_size
        self.assertGreater(ratio, 0.8)
        self.assertLess(ratio, 1.2)
        info = media.probe(target)
        self.assertEqual(info["codec"], "hevc")
        raw = target.read_bytes()
        self.assertIn(b"hvc1", raw[:4096])

    def test_remux_cleans_up_on_failure(self):
        broken = self.root / "broken.mkv"
        broken.write_bytes(b"not a video at all")
        target = self.root / "broken-out.mp4"
        with self.assertRaises(media.MediaError):
            media.remux(broken, target, codec="h264")
        self.assertFalse(target.exists())
        self.assertEqual(list(self.root.glob("*.remuxing.mp4")), [])

    def test_extract_subtitle_returns_empty_when_absent(self):
        self.assertEqual(media.extract_subtitle(self.source, self.root / "none.ass"), "")


if __name__ == "__main__":
    unittest.main()
