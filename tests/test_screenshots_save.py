import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from handbook import offline_config, screenshots


class ScreenshotSaveTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.asset_root = Path(temp.name)
        self.screenshot_root = self.asset_root / "screenshots"
        offline_config.save(self.asset_root, {"screenshot_root": str(self.screenshot_root)})
        self.target = self.screenshot_root / "测试番" / "第08集_12-30.png"

    def save(self, frame):
        return screenshots.save_png(
            self.asset_root, anime="测试番", episode="第08集", seconds=750.0,
            data_url=base64.b64encode(frame).decode("ascii"),
        )

    def test_concurrent_same_name_saves_both_frames(self):
        png = b"\x89PNG\r\n\x1a\n"
        frames = [png + b"frame-a", png + b"frame-b"]
        ready = threading.Barrier(2, timeout=5)
        open_file = Path.open

        def concurrent_open(path, mode="r", *args, **kwargs):
            if path == self.target and mode in {"wb", "xb"}:
                ready.wait()
            return open_file(path, mode, *args, **kwargs)

        with patch.object(Path, "open", concurrent_open), ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(self.save, frames))

        self.assertEqual({result["name"] for result in results}, {"第08集_12-30.png", "第08集_12-30-2.png"})
        for result, frame in zip(results, frames, strict=True):
            self.assertEqual((self.screenshot_root / result["relative"]).read_bytes(), frame)
        self.assertEqual(self.save(png + b"frame-c")["name"], "第08集_12-30-3.png")

    def test_failed_write_clears_partial_file(self):
        frame = b"\x89PNG\r\n\x1a\nframe"
        open_file = Path.open

        @contextmanager
        def interrupted_write(output):
            class PartialOutput:
                def write(self, data):
                    output.write(data[:8])
                    raise OSError("interrupted")

            with output:
                yield PartialOutput()

        def failing_open(path, mode="r", *args, **kwargs):
            output = open_file(path, mode, *args, **kwargs)
            return interrupted_write(output) if path == self.target and mode == "xb" else output

        with patch.object(Path, "open", failing_open), self.assertRaisesRegex(OSError, "interrupted"):
            self.save(frame)
        self.assertFalse(self.target.exists())
        self.assertEqual(self.save(frame)["name"], self.target.name)
