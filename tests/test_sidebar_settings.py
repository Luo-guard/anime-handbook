"""侧边栏相关设置的归一化：媒体库（library）必须和其它页面同等对待。

历史上这三处白名单都漏了 library，前端改完保存时被静默丢弃，
表现就是「媒体库无法隐藏 / 上移下移不生效 / 改名没反应」。
"""
import unittest

from handbook.settings_service import normalize_settings


def normalize(body, current=None):
    pending, _, _ = normalize_settings(body, current or {})
    return pending


class SidebarLibrarySettingsTest(unittest.TestCase):
    def test_order_keeps_library_position(self):
        order = ["collection", "schedule", "library", "timeline", "statistics", "ranking", "settings"]
        self.assertEqual(normalize({"sidebar_order": order})["sidebar_order"], order)
        # 放最前也要保留
        top = ["library", "collection", "schedule", "timeline", "statistics", "ranking", "settings"]
        self.assertEqual(normalize({"sidebar_order": top})["sidebar_order"], top)

    def test_order_completion_inserts_library(self):
        pending = normalize({"sidebar_order": ["schedule", "collection"]})
        self.assertIn("library", pending["sidebar_order"])
        self.assertEqual(pending["sidebar_order"][:2], ["schedule", "collection"])

    def test_page_name_accepts_library(self):
        self.assertEqual(normalize({"sidebar_labels": {"library": "我的库"}})["sidebar_labels"], {"library": "我的库"})

    def test_default_view_accepts_library(self):
        self.assertEqual(normalize({"default_view": "library"})["default_view"], "library")
        with self.assertRaises(ValueError):
            normalize({"default_view": "unknown-page"})


if __name__ == "__main__":
    unittest.main()
