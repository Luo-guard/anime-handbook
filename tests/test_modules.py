"""Structural guarantees for the extracted runtime and browser modules."""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class ModuleStructureTest(unittest.TestCase):
    def test_online_import_does_not_initialize_desktop_or_create_local_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            code = '''import sys, os
from pathlib import Path
import server.runtime
import server.http
assert 'handbook.desktop' not in sys.modules
assert not list(Path(os.environ['ANIME_HANDBOOK_DATA_DIR']).iterdir())
'''
            result = subprocess.run([sys.executable, '-c', code], env={**os.environ, 'ANIME_HANDBOOK_DATA_DIR': tmp}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_old_app_module_is_only_a_launch_entry_without_reexports(self):
        result = subprocess.run([sys.executable, '-c', "import sys, app; assert 'handbook.desktop' not in sys.modules; assert not hasattr(app, 'HandbookDB'); assert not hasattr(app, 'RequestHandler')"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
