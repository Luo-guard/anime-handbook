import unittest

from handbook.common import normalize_custom_search_links


class CustomSearchLinkTest(unittest.TestCase):
    def test_valid_links(self):
        value = [{"name": "次元城", "url": "https://www.cycani.org/category?q=", "enabled": True}]
        self.assertEqual(normalize_custom_search_links(value), value)
        self.assertEqual(normalize_custom_search_links([]), [])
        trimmed = normalize_custom_search_links([{"name": " 次元城 ", "url": " https://a.b/?q= "}])
        self.assertEqual(trimmed, [{"name": "次元城", "url": "https://a.b/?q=", "enabled": True}])

    def test_invalid_links(self):
        for value in [
            "https://a.b/",
            [{"name": "", "url": "https://a.b/"}],
            [{"name": "x", "url": ""}],
            [{"name": "x", "url": "ftp://a.b/"}],
            [{"name": "x", "url": "javascript:alert(1)"}],
            [{"name": "x", "url": "https://a.b/", "enabled": "yes"}],
            [{"name": "x" * 30, "url": "https://a.b/"}],
            [{"name": "x", "url": "https://a.b/" + "a" * 600}],
            [{"name": "x", "url": "https://a.b/"} for _ in range(13)],
        ]:
            with self.subTest(value=str(value)[:60]), self.assertRaises(ValueError):
                normalize_custom_search_links(value)


if __name__ == "__main__":
    unittest.main()
