import unittest

from handbook.shortcuts import normalize_shortcuts


class ShortcutTest(unittest.TestCase):
    def test_legacy_single_key_is_upgraded_to_list(self):
        value = {"enabled": False, "bindings": {"collection": {"enabled": True, "key": "Ctrl+Alt+k"}, "schedule": {"enabled": False, "key": "Ctrl+Alt+k"}, "shutdown": {"enabled": False, "key": ""}}}
        self.assertEqual(
            normalize_shortcuts(value),
            {
                "enabled": False,
                "bindings": {
                    "collection": {"enabled": True, "keys": ["Ctrl+Alt+k"]},
                    "schedule": {"enabled": False, "keys": ["Ctrl+Alt+k"]},
                    "shutdown": {"enabled": False, "keys": []},
                },
            },
        )
        self.assertEqual(normalize_shortcuts({}), {"enabled": True, "bindings": {}})

    def test_multiple_keys_per_action(self):
        value = {"bindings": {"collection": {"enabled": True, "keys": ["1", "Ctrl+1", "1"]}}}
        self.assertEqual(normalize_shortcuts(value)["bindings"]["collection"]["keys"], ["1", "Ctrl+1"])

    def test_invalid_or_conflicting(self):
        for value in [
            [],
            {"enabled": "false"},
            {"bindings": {"unknown": {"enabled": False, "keys": ["1"]}}},
            {"bindings": {"collection": {"enabled": True, "keys": ["Ctrl+Ctrl+k"]}}},
            {"bindings": {"collection": {"enabled": True, "keys": ["bad key"]}}},
            {"bindings": {"collection": {"enabled": True, "keys": ["1"]}, "schedule": {"enabled": True, "keys": ["2", "1"]}}},
            {"bindings": {"collection": {"enabled": True, "keys": ["1", "2", "3", "4", "5", "6", "7", "8", "9"]}}},
            {"bindings": {"collection": {"enabled": True, "keys": "1"}}},
        ]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_shortcuts(value)

    def test_mouse_buttons(self):
        value = {"enabled": True, "bindings": {"previous": {"enabled": True, "keys": ["MouseBack", "ArrowLeft"]}, "next": {"enabled": True, "keys": ["Ctrl+MouseForward"]}}}
        self.assertEqual(normalize_shortcuts(value)["bindings"]["previous"]["keys"], ["MouseBack", "ArrowLeft"])
        value["bindings"]["next"]["keys"] = ["MouseBack"]
        with self.assertRaises(ValueError):
            normalize_shortcuts(value)

    def test_quick_record_key_conflicts_across_app_and_player(self):
        binding = {"enabled": True, "keys": ["Ctrl+Shift+Enter"]}
        self.assertEqual(normalize_shortcuts({"bindings": {"quick_record": binding}})["bindings"]["quick_record"], binding)
        for action in ("new_record", "player_skip"):
            with self.subTest(action=action), self.assertRaises(ValueError):
                normalize_shortcuts({"bindings": {"quick_record": binding, action: binding}})


if __name__ == "__main__":
    unittest.main()
