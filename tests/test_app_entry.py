"""Launching must not steal focus for scratch instances."""
import unittest
from pathlib import Path

from handbook.desktop import should_open_browser


class BrowserLaunchTest(unittest.TestCase):
    def test_normal_launch_opens_the_handbook(self):
        self.assertTrue(should_open_browser([], {}))

    def test_flag_and_environment_can_suppress_the_window(self):
        self.assertFalse(should_open_browser(['--no-browser'], {}))
        self.assertFalse(should_open_browser([], {'ANIME_HANDBOOK_NO_BROWSER': '1'}))
        self.assertFalse(should_open_browser([], {'ANIME_HANDBOOK_NO_BROWSER': 'true'}))

    def test_scratch_data_directory_stays_quiet(self):
        # Every screenshot pass and copy-of-data session sets this.
        self.assertFalse(should_open_browser([], {'ANIME_HANDBOOK_DATA_DIR': r'C:\Temp\handbook-test'}))
        self.assertFalse(should_open_browser(['--no-browser'], {'ANIME_HANDBOOK_DATA_DIR': r'C:\Temp\handbook-test'}))

    def test_browser_flag_wins_for_a_deliberate_custom_directory(self):
        self.assertTrue(
            should_open_browser(['--browser'], {'ANIME_HANDBOOK_DATA_DIR': r'C:\Temp\handbook-test'})
        )

    def test_entry_point_uses_the_shared_decision(self):
        source = Path('app.py').read_text(encoding='utf-8')
        self.assertIn('should_open_browser', source)
        self.assertNotIn('"--no-browser" not in sys.argv', source)


if __name__ == '__main__':
    unittest.main()
