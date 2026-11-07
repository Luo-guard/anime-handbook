"""单集格子手势绑定表的校验规则。"""
from __future__ import annotations

import unittest

from handbook import episode_gestures as eg
from handbook.settings_service import normalize_settings


class GestureNormalizeTests(unittest.TestCase):
    def test_defaults(self):
        value = eg.normalize({})
        self.assertTrue(value["enabled"])
        self.assertTrue(value["keep_menu_on_release"])
        self.assertEqual(value["slots"]["top"], "play")
        self.assertEqual(value["slots"]["top_left"], "ed")
        self.assertEqual(value["bindings"]["RightClick"], "open_menu")
        self.assertEqual(value["bindings"]["LongClick"], "open_menu")
        self.assertFalse(eg.double_click_bound(value))

    def test_defaults_are_not_shared(self):
        first = eg.normalize({})
        first["slots"]["top"] = ""
        self.assertEqual(eg.normalize({})["slots"]["top"], "play")

    def test_one_action_can_bind_several_gestures(self):
        value = eg.normalize({"bindings": {
            "RightClick": "open_menu",
            "LongClick": "open_menu",
            "MiddleClick": "open_menu",
        }})
        self.assertEqual(eg.action_for_gesture(value, "MiddleClick"), "open_menu")

    def test_left_click_is_reserved(self):
        with self.assertRaisesRegex(ValueError, "固定"):
            eg.normalize({"bindings": {"Click": "play"}})

    def test_bare_click_with_modifier_is_allowed(self):
        value = eg.normalize({"bindings": {"Ctrl+Shift+Click": "play"}})
        self.assertEqual(eg.action_for_gesture(value, "Ctrl+Shift+Click"), "play")

    def test_unknown_gesture_and_action_rejected(self):
        for payload in (
            {"bindings": {"TripleClick": "play"}},
            {"bindings": {"RightClick": "fly"}},
            {"slots": {"top": "open_menu"}},
            {"slots": {"north": "play"}},
        ):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                eg.normalize(payload)

    def test_slot_can_be_removed(self):
        value = eg.normalize({"slots": dict(eg.DEFAULT_SLOTS, top="", bottom=None)})
        self.assertEqual(value["slots"]["top"], "")
        self.assertEqual(value["slots"]["bottom"], "")
        self.assertEqual(value["slots"]["top_right"], "score")

    def test_max_four_gestures_per_action(self):
        ok = eg.normalize({"bindings": {
            "RightClick": "play", "LongClick": "play", "MiddleClick": "play", "Alt+Click": "play",
        }})
        self.assertEqual(len([v for v in ok["bindings"].values() if v == "play"]), 4)
        with self.assertRaisesRegex(ValueError, "最多绑定"):
            eg.normalize({"bindings": {
                "RightClick": "play", "LongClick": "play", "MiddleClick": "play",
                "Alt+Click": "play", "Shift+Click": "play",
            }})

    def test_partial_bindings_keep_the_defaults(self):
        """审计 N18：只传一部分绑定时，没提到的保留默认（和 slots 一个口径）。"""
        value = eg.normalize({"bindings": {"Ctrl+Click": "play"}})
        self.assertEqual(value["bindings"]["Ctrl+Click"], "play")
        self.assertEqual(value["bindings"]["RightClick"], "open_menu")
        self.assertEqual(value["bindings"]["LongClick"], "open_menu")
        self.assertEqual(value["bindings"]["Alt+Click"], "reveal_in_folder")

    def test_empty_string_unbinds_a_default(self):
        """真要解绑就显式传空字符串 —— 缺键不再是「解绑」的意思。"""
        value = eg.normalize({"bindings": {"RightClick": ""}})
        self.assertNotIn("RightClick", value["bindings"])
        self.assertEqual(value["bindings"]["LongClick"], "open_menu")

    def test_double_click_flag(self):
        self.assertTrue(eg.double_click_bound(eg.normalize({"bindings": {"Ctrl+DoubleClick": "play"}})))
        self.assertFalse(eg.double_click_bound(eg.normalize({"bindings": {"RightClick": "play"}})))

    def test_invalid_types(self):
        for payload in ([], {"enabled": "yes"}, {"keep_menu_on_release": 1}, {"bindings": []}, {"slots": []}):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                eg.normalize(payload)


class SettingsIntegrationTests(unittest.TestCase):
    def test_settings_pipeline_accepts_gesture_config(self):
        current = {"keyboard_shortcuts": {}, "episode_gestures": {}}
        result = normalize_settings({"episode_gestures": {"bindings": {"RightClick": "play"}}}, current)
        self.assertEqual(result[0]["episode_gestures"]["bindings"]["RightClick"], "play")

    def test_settings_pipeline_rejects_bad_gesture(self):
        with self.assertRaises(ValueError):
            normalize_settings({"episode_gestures": {"bindings": {"Click": "play"}}}, {})


if __name__ == "__main__":
    unittest.main()
