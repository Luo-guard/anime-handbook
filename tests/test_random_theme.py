"""打开时随机主题：服务端注入阶段就要定下用哪一套。"""
import json
import re
import unittest

from handbook import common

HTML = '<script id="initialAppearance" type="application/json">{}</script>'


def payload_of(output: str) -> dict:
    match = re.search(r">(\{.*?\})</script>", output)
    assert match, output[:200]
    return json.loads(match.group(1))


def base_settings(**overrides) -> dict:
    settings = {
        "theme_color": "forest",
        "custom_theme_color": "#2E6D4E",
        "custom_background_enabled": False,
        "custom_background_version": 0,
        "custom_background_overlay_opacity": 82,
        "active_theme_profile": "a",
        "theme_random_on_open": True,
        "theme_profiles": [
            {"id": "a", "name": "A", "theme_color": "forest"},
            {"id": "b", "name": "B", "theme_color": "ocean"},
            {
                "id": "c",
                "name": "C",
                "theme_color": "custom",
                "custom_theme_color": "#B85670",
                "custom_background_enabled": True,
                "custom_background_version": 7,
                "custom_background_overlay_opacity": 40,
            },
        ],
    }
    settings.update(overrides)
    return settings


class RandomThemeOnOpenTest(unittest.TestCase):
    def setUp(self):
        common._LAST_RANDOM_THEME = None

    def test_disabled_keeps_saved_profile(self):
        payload = payload_of(
            common.with_initial_appearance(HTML, base_settings(theme_random_on_open=False), "local")
        )
        self.assertIsNone(payload["random_theme_profile"])
        self.assertEqual(payload["settings"]["active_theme_profile"], "a")
        self.assertEqual(payload["settings"]["theme_color"], "forest")

    def test_enabled_applies_a_profile_with_its_background(self):
        for _ in range(6):
            payload = payload_of(common.with_initial_appearance(HTML, base_settings(), "local"))
            chosen = payload["random_theme_profile"]
            self.assertIn(chosen, {"a", "b", "c"})
            settings = payload["settings"]
            # 注入的外观必须和选中的方案一致，否则首屏就是错的。
            self.assertEqual(settings["active_theme_profile"], chosen)
            profile = next(item for item in base_settings()["theme_profiles"] if item["id"] == chosen)
            self.assertEqual(settings["theme_color"], profile["theme_color"])
            if chosen == "c":
                self.assertTrue(settings["custom_background_enabled"])
                self.assertEqual(settings["custom_background_version"], 7)
                self.assertEqual(settings["custom_background_overlay_opacity"], 40)
            else:
                self.assertFalse(settings["custom_background_enabled"])

    def test_does_not_repeat_the_previous_pick(self):
        picks = [
            payload_of(common.with_initial_appearance(HTML, base_settings(), "local"))["random_theme_profile"]
            for _ in range(12)
        ]
        self.assertEqual(set(picks), {"a", "b", "c"}, "all profiles should appear")
        for previous, current in zip(picks, picks[1:]):
            self.assertNotEqual(previous, current, f"consecutive repeat: {picks}")

    def test_single_profile_is_reused(self):
        settings = base_settings(theme_profiles=[{"id": "only", "name": "唯一", "theme_color": "rose"}])
        for _ in range(3):
            payload = payload_of(common.with_initial_appearance(HTML, settings, "local"))
            self.assertEqual(payload["random_theme_profile"], "only")
            self.assertEqual(payload["settings"]["theme_color"], "rose")

    def test_missing_or_empty_profiles_falls_back(self):
        for profiles in ([], None, [{"name": "没有 id"}]):
            with self.subTest(profiles=profiles):
                payload = payload_of(
                    common.with_initial_appearance(
                        HTML, base_settings(theme_profiles=profiles), "local"
                    )
                )
                self.assertIsNone(payload["random_theme_profile"])
                self.assertEqual(payload["settings"]["active_theme_profile"], "a")

    def test_picker_returns_a_copy_not_the_shared_dict(self):
        profile = common.pick_random_theme_profile(base_settings())
        profile["theme_color"] = "mutated"
        self.assertNotEqual(base_settings()["theme_profiles"][0]["theme_color"], "mutated")


if __name__ == "__main__":
    unittest.main()
