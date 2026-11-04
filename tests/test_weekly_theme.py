"""按周计划选主题：首屏注入阶段就要定下今天用哪一套，且周计划优先于随机。"""
import json
import re
import unittest
from datetime import datetime

from handbook import common

HTML = '<script id="initialAppearance" type="application/json">{}</script>'
MONDAY = datetime(2026, 11, 2, 10, 0)   # 2026-11-02 是周一
SUNDAY = datetime(2026, 11, 8, 10, 0)   # 2026-11-08 是周日


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
        "theme_random_on_open": False,
        "theme_weekly_plan_enabled": False,
        "theme_weekly_plan": {},
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


class WeeklyThemePlanTest(unittest.TestCase):
    def setUp(self):
        common._LAST_RANDOM_THEME = None

    def test_disabled_keeps_saved_profile(self):
        payload = payload_of(
            common.with_initial_appearance(
                HTML,
                base_settings(theme_weekly_plan={"1": "b"}, theme_weekly_plan_enabled=False),
                "local",
            )
        )
        self.assertIsNone(payload["weekly_theme_profile"])
        self.assertEqual(payload["settings"]["active_theme_profile"], "a")
        self.assertEqual(payload["settings"]["theme_color"], "forest")

    def test_monday_uses_the_monday_profile(self):
        payload = payload_of(
            common.with_initial_appearance(
                HTML,
                base_settings(theme_weekly_plan_enabled=True, theme_weekly_plan={"1": "b"}),
                "local",
                now=MONDAY,
            )
        )
        self.assertEqual(payload["weekly_theme_profile"], "b")
        self.assertEqual(payload["settings"]["active_theme_profile"], "b")
        self.assertEqual(payload["settings"]["theme_color"], "ocean")

    def test_sunday_uses_key_seven(self):
        chosen = common.pick_weekly_theme_profile(
            base_settings(theme_weekly_plan_enabled=True, theme_weekly_plan={"7": "c"}),
            now=SUNDAY,
        )
        self.assertEqual(chosen["id"], "c")
        payload = payload_of(
            common.with_initial_appearance(
                HTML,
                base_settings(theme_weekly_plan_enabled=True, theme_weekly_plan={"7": "c"}),
                "local",
                now=SUNDAY,
            )
        )
        self.assertEqual(payload["weekly_theme_profile"], "c")
        self.assertEqual(payload["settings"]["theme_color"], "custom")
        self.assertTrue(payload["settings"]["custom_background_enabled"])
        self.assertEqual(payload["settings"]["custom_background_version"], 7)
        self.assertEqual(payload["settings"]["custom_background_overlay_opacity"], 40)

    def test_empty_day_keeps_saved_and_suppresses_random(self):
        payload = payload_of(
            common.with_initial_appearance(
                HTML,
                base_settings(
                    theme_random_on_open=True,
                    theme_weekly_plan_enabled=True,
                    theme_weekly_plan={"1": ""},
                ),
                "local",
                now=MONDAY,
            )
        )
        self.assertIsNone(payload["weekly_theme_profile"])
        self.assertIsNone(payload["random_theme_profile"], "周计划开启时随机主题暂停")
        self.assertEqual(payload["settings"]["active_theme_profile"], "a")

    def test_unknown_profile_is_ignored_and_does_not_fall_back_to_random(self):
        payload = payload_of(
            common.with_initial_appearance(
                HTML,
                base_settings(
                    theme_random_on_open=True,
                    theme_weekly_plan_enabled=True,
                    theme_weekly_plan={"1": "ghost"},
                ),
                "local",
                now=MONDAY,
            )
        )
        self.assertIsNone(payload["weekly_theme_profile"])
        self.assertIsNone(payload["random_theme_profile"])
        self.assertEqual(payload["settings"]["active_theme_profile"], "a")

    def test_plan_wins_over_random(self):
        payload = payload_of(
            common.with_initial_appearance(
                HTML,
                base_settings(
                    theme_random_on_open=True,
                    theme_weekly_plan_enabled=True,
                    theme_weekly_plan={"1": "b"},
                ),
                "local",
                now=MONDAY,
            )
        )
        self.assertEqual(payload["weekly_theme_profile"], "b")
        self.assertIsNone(payload["random_theme_profile"])
        self.assertEqual(payload["settings"]["active_theme_profile"], "b")

    def test_pick_ignores_malformed_plan(self):
        for plan in (None, [], {"1": None}, {"1": "missing"}):
            with self.subTest(plan=plan):
                self.assertIsNone(
                    common.pick_weekly_theme_profile(
                        base_settings(theme_weekly_plan_enabled=True, theme_weekly_plan=plan),
                        now=MONDAY,
                    )
                )


if __name__ == "__main__":
    unittest.main()
