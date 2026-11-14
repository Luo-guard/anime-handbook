"""Kazumi 规则仓库：只取站点名与搜索地址，过滤掉无法直接跳转的规则。"""
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from handbook import link_rules

BASE_RULE = {
    "type": "anime",
    "name": "MXdm",
    "version": "2.4",
    "usePost": False,
    "baseURL": "https://www.dcc3.com",
    "searchURL": "https://www.dcc3.com/search/?wd=@keyword",
}


def archive_of(files: dict[str, object], *, prefix: str = "KazumiRules-main/") -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, payload in files.items():
            text = payload if isinstance(payload, str) else json.dumps(payload)
            zf.writestr(prefix + name, text)
    return buffer.getvalue()


class RuleToLinkTest(unittest.TestCase):
    def test_plain_get_search_becomes_a_link(self):
        link = link_rules.rule_to_link("MXdm", BASE_RULE)
        self.assertEqual(link["name"], "MXdm")
        self.assertEqual(link["host"], "dcc3.com")
        self.assertEqual(link["template"], "https://www.dcc3.com/search/?wd={title}")
        self.assertEqual(link["id"], "rule-mxdm")

    def test_keyword_placeholder_is_normalised(self):
        rule = dict(BASE_RULE, searchURL="https://x.test/s?q={keyword}")
        self.assertEqual(link_rules.rule_to_link("x", rule)["template"], "https://x.test/s?q={title}")

    def test_post_api_and_non_anime_rules_are_skipped(self):
        self.assertIsNone(link_rules.rule_to_link("x", dict(BASE_RULE, usePost=True)))
        self.assertIsNone(link_rules.rule_to_link("x", dict(BASE_RULE, searchMode="api")))
        self.assertIsNone(link_rules.rule_to_link("x", dict(BASE_RULE, deprecated=True)))
        self.assertIsNone(link_rules.rule_to_link("x", dict(BASE_RULE, searchURL="")))
        self.assertIsNone(link_rules.rule_to_link("x", dict(BASE_RULE, type="comic")))
        self.assertIsNone(link_rules.rule_to_link("x", dict(BASE_RULE, searchURL="https://x.test/s?q=fixed")))
        self.assertIsNone(link_rules.rule_to_link("x", dict(BASE_RULE, searchURL="vbscript:alert(1)")))
        self.assertIsNone(link_rules.rule_to_link("x", "not a dict"))

    def test_missing_name_falls_back_to_file_name(self):
        link = link_rules.rule_to_link("Legacy", {**BASE_RULE, "name": ""})
        self.assertEqual(link["name"], "Legacy")


class ExtractRulesTest(unittest.TestCase):
    def test_uses_only_active_rules_in_official_index(self):
        payload = archive_of({
            "index.json": [{"name": name} for name in ("a", "B", "retired", "missing", ".github/workflows/ci")],
            "a.json": dict(BASE_RULE, name="A"),
            "B.json": dict(BASE_RULE, name="B", searchURL="https://b.test/s?wd=@keyword", baseURL="https://b.test"),
            ".github/workflows/ci.json": dict(BASE_RULE, name="CI"),
            "retired.json": dict(BASE_RULE, name="Retired", deprecated=True, searchURL="https://retired.test/?q=@keyword"),
            "unlisted.json": dict(BASE_RULE, name="Unlisted", searchURL="https://unlisted.test/?q=@keyword"),
            "LICENSE": "not json",
        })
        links = link_rules.extract_rules(payload)
        self.assertEqual([link["name"] for link in links], ["A", "B"])

    def test_bad_json_and_duplicate_templates_are_dropped(self):
        payload = archive_of({
            "index.json": [{"name": name} for name in ("a", "broken", "copy")],
            "a.json": dict(BASE_RULE, name="A"),
            "broken.json": "{not json",
            "copy.json": dict(BASE_RULE, name="Copy of A"),
        })
        links = link_rules.extract_rules(payload)
        self.assertEqual(len(links), 1, links)
        self.assertEqual(links[0]["name"], "A")

    def test_results_are_sorted_by_name(self):
        payload = archive_of({
            "index.json": [{"name": "z"}, {"name": "a"}],
            "z.json": dict(BASE_RULE, name="zeta"),
            "a.json": dict(BASE_RULE, name="Alpha", searchURL="https://a.test/?q=@keyword", baseURL="https://a.test"),
        })
        self.assertEqual([link["name"] for link in link_rules.extract_rules(payload)], ["Alpha", "zeta"])

    def test_missing_or_invalid_index_is_reported(self):
        for files in ({}, {"index.json": {"name": "a"}}, {"index.json": "not json"}):
            with self.subTest(files=files), self.assertRaisesRegex(link_rules.RuleFetchError, "官方索引"):
                link_rules.extract_rules(archive_of(files))

    def test_broken_archive_is_reported(self):
        with self.assertRaises(link_rules.RuleFetchError):
            link_rules.extract_rules(b"not a zip at all")


class CacheTest(unittest.TestCase):
    def test_missing_or_broken_cache_reads_as_empty(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "link-rules.json"
            self.assertEqual(link_rules.load_cache(path)["items"], [])
            path.write_text("{broken", encoding="utf-8")
            self.assertEqual(link_rules.load_cache(path)["items"], [])
            path.write_text("[1, 2, 3]", encoding="utf-8")
            self.assertEqual(link_rules.load_cache(path)["items"], [])

    def test_unfiltered_cache_is_ignored(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "link-rules.json"
            path.write_text(json.dumps({"items": [{"id": "rule-retired"}], "fetched_at": 1000}), encoding="utf-8")
            self.assertEqual(link_rules.load_cache(path)["items"], [])
            self.assertEqual(link_rules.load_cache(path)["fetched_at"], 0)

    def test_refresh_writes_cache_and_keeps_old_file_on_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "link-rules.json"
            with patch.object(link_rules, "fetch_rules", return_value=[link_rules.rule_to_link("MXdm", BASE_RULE)]):
                document = link_rules.refresh(path)
            self.assertEqual(path.exists(), True)
            self.assertEqual(len(link_rules.load_cache(path)["items"]), 1)
            self.assertEqual(document["source"], "KazumiRules")

            with patch.object(link_rules, "fetch_rules", side_effect=link_rules.RuleFetchError("offline")):
                with self.assertRaises(link_rules.RuleFetchError):
                    link_rules.refresh(path)
            self.assertEqual(len(link_rules.load_cache(path)["items"]), 1, "failed refresh must not wipe the cache")

    def test_payload_marks_stale_and_carries_limit(self):
        fresh = link_rules.payload({"items": [{"id": "a"}], "fetched_at": 1_000, "source": "KazumiRules"}, 12, now=1_100)
        self.assertEqual(fresh["stale"], False)
        self.assertEqual(fresh["limit"], 12)
        self.assertEqual(len(fresh["items"]), 1)
        stale = link_rules.payload({"items": [{"id": "a"}], "fetched_at": 1_000}, 12, now=1_000 + link_rules.CACHE_TTL + 1)
        self.assertEqual(stale["stale"], True)
        empty = link_rules.payload({"items": [], "fetched_at": 0}, 12, now=99_999)
        self.assertEqual(empty["stale"], False, "no cache is not stale, it is simply empty")


class FetchRulesTest(unittest.TestCase):
    def test_fetch_reads_the_archive(self):
        payload = archive_of({"index.json": [{"name": "a"}], "a.json": dict(BASE_RULE, name="A")})

        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        with patch.object(link_rules.urllib.request, "urlopen", return_value=Response(payload)):
            self.assertEqual([link["name"] for link in link_rules.fetch_rules()], ["A"])

    def test_network_failure_becomes_a_readable_error(self):
        with patch.object(link_rules.urllib.request, "urlopen", side_effect=OSError("boom")):
            with self.assertRaises(link_rules.RuleFetchError) as caught:
                link_rules.fetch_rules()
        self.assertIn("规则仓库", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
