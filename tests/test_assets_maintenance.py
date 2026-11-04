"""Asset sweeps: only unreferenced, non-fresh files may be deleted."""
import os
import tempfile
import time
import unittest
from pathlib import Path

from handbook import assets


class FakeDatabase:
    def __init__(self, referenced):
        self.referenced = set(referenced)

    def referenced_record_images(self):
        return set(self.referenced)


class RecordImageTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.now = 1_800_000_000.0

    def tearDown(self):
        self.temp.cleanup()

    def write(self, name, *, age_seconds):
        path = self.root / name
        path.write_bytes(b'x')
        stamp = self.now - age_seconds
        os.utime(path, (stamp, stamp))
        return path

    def test_removes_old_unreferenced_images_only(self):
        used = self.write('record-used.png', age_seconds=9_000)
        orphan = self.write('record-orphan.png', age_seconds=9_000)
        fresh = self.write('record-fresh.png', age_seconds=5)

        removed = assets.prune_record_images(
            FakeDatabase({'record-used.png'}), root=self.root, now=self.now
        )

        self.assertEqual(removed, ['record-orphan.png'])
        self.assertTrue(used.exists(), 'referenced image stays')
        self.assertFalse(orphan.exists(), 'orphan is collected')
        self.assertTrue(fresh.exists(), 'an image uploaded a moment ago is protected')

    def test_missing_directory_is_not_an_error(self):
        self.assertEqual(
            assets.prune_record_images(FakeDatabase(set()), root=self.root / 'nope', now=self.now),
            [],
        )


class BackgroundTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.now = 1_800_000_000.0

    def tearDown(self):
        self.temp.cleanup()

    def write(self, name, *, age_seconds=90_000):
        # Background grace is 24 h, so "old" has to be older than that.
        path = self.root / name
        path.write_bytes(b'x')
        stamp = self.now - age_seconds
        os.utime(path, (stamp, stamp))
        return path

    def test_keeps_every_theme_and_account_but_drops_orphans(self):
        settings = {
            'theme_profiles': [
                {'id': 'default'},
                {'id': 'night'},
            ]
        }
        accounts = ['local', 'profile-abc']
        kept = [
            self.write('background.jpg'),
            self.write('background-default.jpg'),
            self.write('background-night.jpg'),
            self.write('background-local-night.png'),
            self.write('background-profile-abc-default.png'),
        ]
        orphan_theme = self.write('background-theme_1700000000000.jpg')
        orphan_account = self.write('background-profile-gone-default.png')
        fresh = self.write('background-brand-new.jpg', age_seconds=60)

        removed = assets.prune_backgrounds(
            settings, accounts, root=self.root, now=self.now
        )

        self.assertEqual(
            sorted(removed),
            ['background-profile-gone-default.png', 'background-theme_1700000000000.jpg'],
        )
        for path in kept:
            self.assertTrue(path.exists(), f'{path.name} belongs to a live theme or account')
        self.assertFalse(orphan_theme.exists())
        self.assertFalse(orphan_account.exists())
        self.assertTrue(fresh.exists(), 'a just-written background is protected')

    def test_legacy_names_survive_when_no_themes_are_saved(self):
        legacy = self.write('background-default.jpg')
        self.assertEqual(
            assets.prune_backgrounds({}, ['local'], root=self.root, now=self.now), []
        )
        self.assertTrue(legacy.exists())


class BackupTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def snapshot(self, name, *, age_seconds):
        path = self.root / name
        path.write_bytes(b'db')
        stamp = time.time() - age_seconds
        os.utime(path, (stamp, stamp))
        return path

    def test_keeps_newest_snapshots_and_reports_extra_directories(self):
        newest = self.snapshot('handbook-before-a.db', age_seconds=10)
        middle = self.snapshot('handbook-before-b.db', age_seconds=20)
        oldest = self.snapshot('handbook-before-c.db', age_seconds=30)
        (self.root / 'handbook-before-c.db-wal').write_bytes(b'wal')
        (self.root / 'old-folder').mkdir()
        (self.root / 'older-folder').mkdir()

        result = assets.prune_backups(self.root, keep=2, keep_dirs=1)

        self.assertEqual(result['removed'], ['handbook-before-c.db'])
        self.assertEqual(result['kept'], 2)
        self.assertFalse(oldest.exists())
        self.assertFalse((self.root / 'handbook-before-c.db-wal').exists(), 'wal sidecar follows')
        self.assertTrue(newest.exists())
        self.assertTrue(middle.exists())
        self.assertEqual(len(result['stale_directories']), 1, 'folders are reported, never removed')
        self.assertEqual(len(list(self.root.glob('*-folder'))), 2)

    def test_small_histories_are_left_alone(self):
        self.snapshot('only.db', age_seconds=5)
        self.assertEqual(assets.prune_backups(self.root, keep=5)['removed'], [])
        self.assertTrue((self.root / 'only.db').exists())

    def test_missing_root_is_safe(self):
        self.assertEqual(assets.prune_backups(self.root / 'absent'), {'removed': [], 'kept': 0, 'stale_directories': []})


class HousekeepingTest(unittest.TestCase):
    def test_runs_every_sweep(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name in ('record', 'background', 'backups'):
                (root / name).mkdir()
            (root / 'background' / 'background-ghost.jpg').write_bytes(b'x')
            old = time.time() - 90_000
            os.utime(root / 'background' / 'background-ghost.jpg', (old, old))
            result = assets.run_housekeeping(
                FakeDatabase(set()),
                {},
                ['local'],
                backup_root=root / 'backups',
                record_root=root / 'record',
                background_root=root / 'background',
            )
            self.assertEqual(result['backgrounds'], ['background-ghost.jpg'])
            self.assertEqual(result['record_images'], [])
            self.assertEqual(result['backups']['removed'], [])


if __name__ == '__main__':
    unittest.main()
