"""设置开关 bgm_rating_link 的后端归一化：值必须能被保存、且收敛成布尔。"""
import unittest

from handbook import settings_service


class BgmRatingLinkTest(unittest.TestCase):
    def test_toggle_round_trips(self):
        for value in (True, False):
            with self.subTest(value=value):
                normalized, _, _ = settings_service._normalize_settings(
                    {"bgm_rating_link": value}, {"bgm_rating_link": True}
                )
                self.assertIs(normalized["bgm_rating_link"], value)

    def test_non_bool_is_coerced(self):
        for raw, expected in ((0, False), ("yes", True), (None, False)):
            with self.subTest(raw=raw):
                normalized, _, _ = settings_service._normalize_settings(
                    {"bgm_rating_link": raw}, {"bgm_rating_link": True}
                )
                self.assertIs(normalized["bgm_rating_link"], expected)

    def test_unrelated_submit_does_not_touch_the_value(self):
        # PATCH 只返回本次提交的键，没提交的开关不该被改写或塞进结果。
        normalized, _, _ = settings_service._normalize_settings(
            {"show_bgm_rating": False}, {"bgm_rating_link": True, "show_bgm_rating": True}
        )
        self.assertIs(normalized["show_bgm_rating"], False)
        self.assertNotIn("bgm_rating_link", normalized)


if __name__ == "__main__":
    unittest.main()
