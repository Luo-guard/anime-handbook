"""Deployment must not silently publish missing or corrupt ASS resources."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from tools.package_online import SUBTITLE_FILES, build, check_subtitles


def prepare_fixture(root):
    folder = root / 'static/vendor/jassub'
    hashes = {}
    for name in SUBTITLE_FILES:
        file = folder / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(b'test resource')
        hashes[name] = hashlib.sha256(file.read_bytes()).hexdigest()
    (folder / 'assets-manifest.json').write_text(json.dumps({'files': hashes}), encoding='utf-8')


class SubtitleAssetsTest(unittest.TestCase):
    def test_missing_and_damaged_assets_refuse_packaging(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with self.assertRaisesRegex(RuntimeError, 'prepare_subtitles'):
                build(root)
            self.assertFalse((root / 'releases').exists())
            prepare_fixture(root)
            check_subtitles(root)
            (root / 'static/vendor/jassub/wasm/jassub-worker.wasm').write_bytes(b'corrupt')
            with self.assertRaisesRegex(RuntimeError, 'prepare_subtitles'):
                build(root)

    def test_package_contains_all_assets_and_not_build_dependencies(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            prepare_fixture(root)
            for name in ('app.py', 'schedule.py'):
                (root / name).write_text('# fixture', encoding='utf-8')
            with zipfile.ZipFile(build(root)) as archive:
                for name in SUBTITLE_FILES:
                    self.assertIn(f'static/vendor/jassub/{name}', archive.namelist())
                self.assertFalse(any('node_modules' in name for name in archive.namelist()))
