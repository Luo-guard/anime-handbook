from handbook import database

"""Failure recovery and concurrency invariants, without changing product behavior."""
import hashlib
import json
import sqlite3
import tempfile
import unittest
import zipfile
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from unittest.mock import MagicMock, patch

from handbook import common as app
from server.runtime import OnlineMetadata, image_url_allowed
from tools.package_online import build


class StabilityTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def test_snapshot_exports_share_destination_without_sharing_staging_files(self):
        db = database.HandbookDB(self.root / 'source.db')
        target = self.root / 'snapshot.db'
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda _: db.export_snapshot(target), range(8)))
        with closing(sqlite3.connect(target)) as snapshot:
            self.assertEqual(snapshot.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
        self.assertFalse(list(self.root.glob('snapshot.db.*.tmp')))

    def test_failed_snapshot_preserves_previous_export_and_closes_connections(self):
        db = database.HandbookDB(self.root / 'source.db')
        target = self.root / 'snapshot.db'
        target.write_bytes(b'previous snapshot')
        source, output = MagicMock(), MagicMock()
        source.backup.side_effect = OSError('disk error')
        with patch.object(app.sqlite3, 'connect', side_effect=[source, output]):
            with self.assertRaises(OSError):
                db.export_snapshot(target)
        source.close.assert_called_once()
        output.close.assert_called_once()
        self.assertEqual(target.read_bytes(), b'previous snapshot')
        self.assertFalse(list(self.root.glob('snapshot.db.*.tmp')))

    def test_invalid_image_urls_are_rejected_without_exceptions(self):
        for url in ['https://lain.bgm.tv:abc/x', 'https://[broken', 'https://lain.bgm.tv:999999/x', 'https://lain.bgm.tv@evil.test/x']:
            self.assertFalse(image_url_allowed(url))
        self.assertTrue(image_url_allowed('https://lain.bgm.tv/pic/cover.jpg'))

    def test_corrupt_image_cache_is_refetched_then_reused(self):
        service = object.__new__(OnlineMetadata)
        service.cover_root = self.root
        url = 'https://lain.bgm.tv/pic/cover.jpg'
        cached = self.root / hashlib.sha256(url.encode()).hexdigest()
        cached.write_bytes(b'incomplete cache')
        response = MagicMock()
        response.headers.get_content_type.return_value = 'image/jpeg'
        response.read.return_value = b'image content'
        opener = MagicMock()
        opener.open.return_value.__enter__.return_value = response
        with patch('server.runtime.urllib.request.build_opener', return_value=opener):
            self.assertEqual(service.cached_image(url), (b'image content', 'image/jpeg'))
            self.assertEqual(service.cached_image(url), (b'image content', 'image/jpeg'))
        opener.open.assert_called_once()
        self.assertFalse(list(self.root.glob('*.tmp')))

    def test_package_concurrency_manifest_and_failed_build_preserve_previous_archive(self):
        (self.root / 'app.py').write_text('example', encoding='utf-8')
        (self.root / 'schedule.py').write_text('example', encoding='utf-8')
        with ThreadPoolExecutor(max_workers=3) as pool:
            archives = list(pool.map(lambda _: build(self.root), range(5)))
        archive = archives[0]
        with zipfile.ZipFile(archive) as bundle:
            manifest = json.loads(bundle.read('MANIFEST.sha256.json'))
            for name, digest in manifest.items():
                self.assertEqual(hashlib.sha256(bundle.read(name)).hexdigest(), digest)
        previous = archive.read_bytes()
        with patch.object(zipfile.ZipFile, 'writestr', side_effect=OSError('disk error')):
            with self.assertRaises(OSError):
                build(self.root)
        self.assertEqual(archive.read_bytes(), previous)
        self.assertFalse(list(archive.parent.glob('*.tmp')))
