import unittest

from handbook.common import normalize_custom_search_links, normalize_detail_links, normalize_link_sync


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


class DetailLinksTest(unittest.TestCase):
    def test_presets_and_custom_order_is_kept(self):
        value = [
            {"id": "a1", "kind": "bgm", "name": "Bangumi #{id}", "url": "{site}/subject/{id}", "enabled": True},
            {"id": "b2", "kind": "bilibili", "name": "B站搜索", "url": "https://search.bilibili.com/all?keyword={title}", "enabled": False},
            {"id": "c3", "kind": "custom", "name": "次元城", "url": "https://www.cycani.org/category?q={title}", "enabled": True},
        ]
        self.assertEqual(normalize_detail_links(value), value)
        self.assertEqual([item["name"] for item in normalize_detail_links(list(reversed(value)))], ["次元城", "B站搜索", "Bangumi #{id}"])

    def test_kind_defaults_to_custom(self):
        link = normalize_detail_links([{"name": "x", "url": "https://a.b/?q="}])[0]
        self.assertEqual(link["kind"], "custom")
        self.assertEqual(link["id"], "")

    def test_sync_records(self):
        self.assertEqual(normalize_link_sync(["a1", " b2 ", ""]), ["a1", "b2"])
        for value in ["a1", ["a1", 3], None]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_link_sync(value)

    def test_invalid_links(self):
        for value in [
            "https://a.b/",
            [{"name": "", "url": "https://a.b/"}],
            [{"name": "x", "url": "ftp://a.b/"}],
            [{"name": "x", "url": "https://a.b/", "enabled": "yes"}],
            [{"name": "x", "url": "https://a.b/", "kind": "other"}],
            [{"name": "x" * 31, "url": "https://a.b/"}],
            [{"name": "x", "url": "https://a.b/"} for _ in range(13)],
        ]:
            with self.subTest(value=str(value)[:60]), self.assertRaises(ValueError):
                normalize_detail_links(value)


if __name__ == "__main__":
    unittest.main()
