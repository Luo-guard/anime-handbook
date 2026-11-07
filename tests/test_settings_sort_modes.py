"""收藏排序模式的白名单：新增的 latest（最新一集）不能被后端悄悄丢掉。"""
import unittest

from handbook import settings_service


class CollectionSortModeTests(unittest.TestCase):
    def normalize(self, modes):
        pending, _, _ = settings_service.normalize_settings(
            {"collection_sort_modes": modes}, {}
        )
        return pending["collection_sort_modes"]

    def test_latest_is_accepted(self):
        # 前端把「最新一集」存成 mode "latest"；白名单漏了它就会被静默过滤，
        # 刷新后排序退回「名称」，看起来像设置没保存。
        self.assertEqual(self.normalize({"1": "latest"}), {"1": "latest"})

    def test_all_known_modes_pass(self):
        modes = {
            "1": "name", "2": "rank", "3": "popularity", "4": "airdate",
            "5": "latest", "6": "kazumi", "7": "custom",
        }
        self.assertEqual(self.normalize(modes), modes)

    def test_unknown_mode_is_dropped(self):
        self.assertEqual(self.normalize({"1": "latest", "2": "nope"}), {"1": "latest"})

    def test_directions_still_validate(self):
        pending, _, _ = settings_service.normalize_settings(
            {"collection_sort_directions": {"1": "asc", "2": "sideways"}}, {}
        )
        self.assertEqual(pending["collection_sort_directions"], {"1": "asc"})


if __name__ == "__main__":
    unittest.main()
