import re
import unittest
from pathlib import Path

from handbook.common import INITIAL_VISIBILITY, with_initial_visibility

INDEX_HTML = Path(__file__).resolve().parent.parent / "static" / "index.html"


def tag_for(html: str, element_id: str) -> str:
    match = re.search(r'<[^>]*\bid="' + re.escape(element_id) + r'"[^>]*>', html)
    if not match:
        raise AssertionError(f"{element_id} not found")
    return match.group(0)


class InitialVisibilityTest(unittest.TestCase):
    def test_markup_ships_hidden(self):
        """元素默认必须是隐藏的，否则首屏会闪一下。"""
        html = INDEX_HTML.read_text(encoding="utf-8")
        for element_id in INITIAL_VISIBILITY:
            with self.subTest(element_id=element_id):
                self.assertIn("hidden", tag_for(html, element_id))

    def test_disabled_setting_stays_hidden_and_missing_key_is_revealed(self):
        html = INDEX_HTML.read_text(encoding="utf-8")
        rendered = with_initial_visibility(html, {"show_collection_rating_control": False})
        self.assertIn("hidden", tag_for(rendered, "collectionRatingControl"))
        # 未写入的设置按开启处理，与前端 enabledSetting() 一致。
        self.assertNotIn("hidden", tag_for(rendered, "createCollectionButton"))
        self.assertNotIn("hidden", tag_for(rendered, "sidebarToggle"))

    def test_all_disabled_leaves_markup_untouched(self):
        html = INDEX_HTML.read_text(encoding="utf-8")
        settings = {key: False for key in INITIAL_VISIBILITY.values()}
        self.assertEqual(with_initial_visibility(html, settings), html)

    def test_only_class_attribute_is_touched(self):
        html = '<button aria-hidden="true" class="btn hidden" id="sidebarToggle">x</button>'
        rendered = with_initial_visibility(html, {})
        self.assertIn('class="btn"', rendered)
        self.assertIn('aria-hidden="true"', rendered)


if __name__ == "__main__":
    unittest.main()
