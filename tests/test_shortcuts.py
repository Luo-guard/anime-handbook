import unittest
from handbook.shortcuts import normalize_shortcuts
class ShortcutTest(unittest.TestCase):
    def test_settings_and_disabled_duplicates(self):
        value={"enabled":False,"bindings":{"collection":{"enabled":True,"key":"Ctrl+Alt+k"},"schedule":{"enabled":False,"key":"Ctrl+Alt+k"},"shutdown":{"enabled":False,"key":"Ctrl+Shift+q"}}}
        self.assertEqual(normalize_shortcuts(value),value)
        self.assertEqual(normalize_shortcuts({}),{"enabled":True,"bindings":{}})
    def test_invalid_or_conflicting(self):
        for value in [[],{"enabled":"false"},{"bindings":{"unknown":{"enabled":False,"key":"1"}}},{"bindings":{"collection":{"enabled":True,"key":"Ctrl+Ctrl+k"}}},{"bindings":{"collection":{"enabled":True,"key":"bad key"}}},{"bindings":{"collection":{"enabled":True,"key":"1"},"schedule":{"enabled":True,"key":"1"}}}]:
            with self.subTest(value=value),self.assertRaises(ValueError):normalize_shortcuts(value)

    def test_mouse_buttons(self):
        value={"enabled":True,"bindings":{"previous":{"enabled":True,"key":"MouseBack"},"next":{"enabled":True,"key":"Ctrl+MouseForward"}}}
        self.assertEqual(normalize_shortcuts(value),value)
        value["bindings"]["next"]["key"]="MouseBack"
        with self.assertRaises(ValueError):normalize_shortcuts(value)
