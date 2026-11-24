"""规则站点换域名后不该被判成「链接与站点不一致」。

真实场景：baimao 规则里写的是 www.baimaodm.com，站点已经 301 到 www.bmddm.com，
搜索结果自然是新域名，旧校验只看规则里写死的域名，于是每次点结果都「无法播放」。
"""
import unittest
from unittest.mock import patch

from handbook import playback_rules


RULE = {
    "type": "anime",
    "name": "baimao",
    "baseURL": "https://www.baimaodm.com/",
    "searchURL": "https://www.baimaodm.com/s_all?ex=1&kw=@keyword",
}


class RuleHostTest(unittest.TestCase):
    def setUp(self):
        playback_rules._RULE_HOSTS.clear()
        playback_rules._HOST_PROBE.clear()

    def tearDown(self):
        playback_rules._RULE_HOSTS.clear()
        playback_rules._HOST_PROBE.clear()

    def test_configured_hosts_are_read_from_the_rule(self):
        self.assertEqual(playback_rules._configured_hosts(RULE), {"www.baimaodm.com"})

    def test_search_landing_host_is_remembered(self):
        playback_rules._remember_host("baimao", "https://www.bmddm.com/s_all?ex=1&kw=x")
        self.assertIn("www.bmddm.com", playback_rules._rule_hosts("baimao", RULE))

    def test_hosts_are_scoped_per_rule(self):
        playback_rules._remember_host("baimao", "https://www.bmddm.com/")
        self.assertNotIn("www.bmddm.com", playback_rules._rule_hosts("other", RULE))

    def test_discovery_follows_the_redirect_and_caches(self):
        calls = []

        def fake_read(url, headers, **_kwargs):
            calls.append(url)
            return b"<html></html>", "https://www.bmddm.com/"

        with patch.object(playback_rules, "_read", fake_read):
            hosts = playback_rules._discover_hosts("baimao", RULE)
            again = playback_rules._discover_hosts("baimao", RULE)
        self.assertEqual(hosts, {"www.bmddm.com"})
        self.assertEqual(again, {"www.bmddm.com"})
        self.assertEqual(len(calls), 1, "十分钟内应该复用探测结果")

    def test_new_domain_passes_the_check_instead_of_reporting_mismatch(self):
        playback_rules._remember_host("baimao", "https://www.bmddm.com/")
        with patch.object(playback_rules, "_page", side_effect=RuntimeError("stop-here")):
            roads = playback_rules._html_roads(RULE, "https://www.bmddm.com/anime/1", "baimao")
            with self.assertRaises(RuntimeError):
                next(roads)

    def test_unrelated_host_is_still_rejected(self):
        playback_rules._remember_host("baimao", "https://www.bmddm.com/")
        roads = playback_rules._html_roads(RULE, "https://evil.example.com/anime/1", "baimao")
        with self.assertRaises(playback_rules.RequestProblem) as caught:
            next(roads)
        self.assertIn("不一致", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
