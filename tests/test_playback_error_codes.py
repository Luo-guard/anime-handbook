"""片源失败的「原因码」：前端要据此换一句能照着做的话，所以归类得守住。

以前只有一句「这个站点没有返回可用的选集」，站点点改版、规则过期、这条线路
没这集，长得一模一样；这里确保每种情况都有自己的码，而且「静默丢链接」不再
无声无息。
"""
import io
import unittest
from contextlib import contextmanager
from email.message import Message
from types import SimpleNamespace
from unittest.mock import patch

from handbook import playback_rules as rules
from handbook.http_support import RequestProblem

RULE = {
    "name": "Example",
    "baseURL": "https://example.com/",
    "searchURL": "https://example.com/?q=@keyword",
    "searchList": "//article",
    "searchName": "//a",
    "searchResult": "//a",
    "chapterRoads": "//ul",
    "chapterResult": "//a",
}


@contextmanager
def upstream(status, body):
    headers = Message()
    headers["Content-Type"] = "text/html"
    yield SimpleNamespace(status=status, headers=headers, read=io.BytesIO(body).read), "https://example.com/page"


class PlaybackErrorCodeTest(unittest.TestCase):
    def setUp(self):
        rules._CATALOGUES.clear()

    def tearDown(self):
        rules._CATALOGUES.clear()

    def test_search_calls_out_a_stale_rule_instead_of_returning_zero_results(self):
        """列表节点对上了、链接全是脚本跳转：这是规则过期，不是「站点没这部番」。"""
        html = b'<article><a href="javascript:void(0)">Ep 1</a></article>'
        with patch.object(rules, "_read", return_value=(html, "https://example.com/?q=x")):
            with self.assertRaises(RequestProblem) as caught:
                rules.search("example", RULE, "Example")
        self.assertEqual(caught.exception.code, "site_changed")
        self.assertIn("解析不出来", str(caught.exception))

    def test_search_reports_how_many_links_it_had_to_drop(self):
        html = (
            b'<article><a href="/a">Ep 1</a></article>'
            b'<article><a href="javascript:void(0)">Ep 2</a></article>'
        )
        with patch.object(rules, "_read", return_value=(html, "https://example.com/?q=x")):
            data = rules.search("example", RULE, "Example")
        self.assertEqual([item["title"] for item in data["items"]], ["Ep 1"])
        self.assertEqual(data["skipped"], 1, "被丢掉的链接数要说出来")

    def test_a_page_without_any_result_row_stays_an_empty_result(self):
        """页面正常、真没有结果：不要误报成规则过期（这一种分不出来）。"""
        html = b"<html><body>nothing here</body></html>"
        with patch.object(rules, "_read", return_value=(html, "https://example.com/?q=x")):
            data = rules.search("example", RULE, "Example")
        self.assertEqual(data["items"], [])
        self.assertNotIn("skipped", data)

    def test_catalogue_without_roads_is_reported_as_a_stale_rule(self):
        html = b"<html><body>site redesigned</body></html>"
        with patch.object(rules, "_read", return_value=(html, "https://example.com/show")):
            with self.assertRaises(RequestProblem) as caught:
                rules.catalogue("example", RULE, "https://example.com/show")
        self.assertEqual(caught.exception.code, "site_changed")
        self.assertIn("站点改版", str(caught.exception))

    def test_catalogue_counts_episodes_it_could_not_link(self):
        html = (
            b'<ul><li><a href="/1">01</a></li>'
            b'<li><a href="javascript:void(0)">02</a></li></ul>'
        )
        with patch.object(rules, "_read", return_value=(html, "https://example.com/show")):
            data = rules.catalogue("example", RULE, "https://example.com/show")
        self.assertEqual(len(data["sources"][0]["episodes"]), 1)
        self.assertEqual(data["skipped"], 1, "少了一集要说清楚是解析不出来")

    def test_missing_episode_has_its_own_code(self):
        html = b'<ul><li><a href="/1">01</a></li></ul>'
        with patch.object(rules, "_read", return_value=(html, "https://example.com/show")):
            data = rules.catalogue("example", RULE, "https://example.com/show")
            with self.assertRaises(RequestProblem) as caught:
                rules.play(
                    "example", RULE, "https://example.com/show",
                    str(data["sources"][0]["id"]), "episode-9",
                )
        self.assertEqual(caught.exception.code, "episode_missing")
        self.assertEqual(caught.exception.status, 404)

    def test_http_status_separates_missing_page_from_unreachable_site(self):
        with patch.object(rules, "request_public", return_value=upstream(404, b"")):
            with self.assertRaises(RequestProblem) as caught:
                rules._read("https://example.com/gone", {})
        self.assertEqual(caught.exception.code, "not_found")

        with patch.object(rules, "request_public", return_value=upstream(503, b"")):
            with self.assertRaises(RequestProblem) as caught:
                rules._read("https://example.com/busy", {})
        self.assertEqual(caught.exception.code, "site_unreachable")

    def test_connection_failure_is_unreachable(self):
        with patch.object(rules, "request_public", side_effect=OSError("boom")):
            with self.assertRaises(RequestProblem) as caught:
                rules._read("https://example.com/", {})
        self.assertEqual(caught.exception.code, "site_unreachable")

    def test_unusable_play_endpoint_is_no_media(self):
        rule = {
            "baseURL": "https://example.com/",
            "chapterApiConfig": {"request": {"headers": {"apikey": "k"}}},
            "_handbook_play": {
                "request": {
                    "url": "https://api.example.com/functions/v1/issue",
                    "method": "POST",
                    "body": {"episode_id": "@episode", "source_id": "@source"},
                },
                "okPath": "$.ok",
                "urlPath": "$.url",
            },
        }
        reply = b'{"ok": false}'
        with patch.object(rules, "_read", return_value=(reply, "https://api.example.com/x")):
            with self.assertRaises(RequestProblem) as caught:
                rules._issue_play(rule, rule["_handbook_play"], "1", "4", "203809")
        self.assertEqual(caught.exception.code, "no_media")


if __name__ == "__main__":
    unittest.main()
