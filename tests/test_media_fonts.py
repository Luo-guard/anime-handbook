"""MKV 内封字体附件抽取。

字幕组常把 ASS 用到的字体塞进 MKV 附件里。抽出来交给 libass，
比任何回退字体都准；抽不到也不能让归档失败。
"""
from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from handbook import media


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "需要本机 ffmpeg/ffprobe")
class FontAttachmentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="hb-fonts-")
        self.root = Path(self.temp.name)
        self.font = self.root / "SubGroupFont.ttf"
        self.font.write_bytes(b"FONT-BYTES" * 64)
        base = self.root / "base.mp4"
        subprocess.run(
            [
                "ffmpeg", "-y", "-loglevel", "error",
                "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=1",
                "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(base),
            ],
            check=True, capture_output=True,
        )
        self.mkv = self.root / "episode.mkv"
        subprocess.run(
            [
                "ffmpeg", "-y", "-loglevel", "error",
                "-i", str(base),
                "-attach", str(self.font),
                "-metadata:s:t:0", "mimetype=font/ttf",
                "-c", "copy", str(self.mkv),
            ],
            check=True, capture_output=True,
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_lists_font_attachment_with_stream_ordinal(self):
        found = media.font_attachments(self.mkv)
        self.assertEqual(len(found), 1)
        # 视频轨 index=0、附件轨 index=1，但 dump_attachment 用的是附件流序号 0。
        self.assertEqual(found[0]["t_index"], 0)
        self.assertEqual(found[0]["filename"], "SubGroupFont.ttf")

    def test_extracted_bytes_are_identical(self):
        destination = self.root / "_fonts"
        made = media.extract_font_attachments(self.mkv, destination)
        self.assertEqual(len(made), 1)
        self.assertEqual(Path(made[0]).name, "SubGroupFont.ttf")
        self.assertEqual(Path(made[0]).read_bytes(), self.font.read_bytes())
        self.assertTrue(Path(made[0]).is_relative_to(destination))

    def test_plain_mp4_has_no_attachments(self):
        self.assertEqual(media.font_attachments(self.root / "base.mp4"), [])
        self.assertEqual(media.extract_font_attachments(self.root / "base.mp4", self.root / "_fonts"), [])

    def test_missing_file_returns_empty(self):
        self.assertEqual(media.font_attachments(self.root / "nope.mkv"), [])
        self.assertEqual(media.extract_font_attachments(self.root / "nope.mkv", self.root / "_fonts"), [])

    def test_non_font_attachment_is_ignored(self):
        # 附件名没有字体后缀时既不列出、也不抽取（例如字幕组塞的封面图）。
        original = media.font_attachments
        try:
            media.font_attachments = lambda *a, **k: [{"t_index": 0, "filename": "cover.png"}]
            self.assertEqual(media.extract_font_attachments(self.mkv, self.root / "_fonts"), [])
        finally:
            media.font_attachments = original

    def test_attachment_name_cannot_escape_target_dir(self):
        original = media.font_attachments
        try:
            media.font_attachments = lambda *a, **k: [{"t_index": 0, "filename": "../../evil.ttf"}]
            destination = self.root / "_fonts"
            made = media.extract_font_attachments(self.mkv, destination)
            self.assertEqual(len(made), 1)
            self.assertEqual(Path(made[0]).name, "evil.ttf")
            self.assertTrue(Path(made[0]).is_relative_to(destination))
            self.assertFalse((self.root.parent / "evil.ttf").exists())
        finally:
            media.font_attachments = original


if __name__ == "__main__":
    unittest.main()
