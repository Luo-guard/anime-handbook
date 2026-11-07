"""周表地区筛选：地区判定、合并保留、缓存补全。

三个周表来源自身都没有「国漫/日漫/美漫」字段；地区只存在于 Bangumi 的
meta tags 里（条目页顶部 TV / 日本 / 2026年10月 那一行），所以这里锁住
三条取数路径：metaTags、用户标签兜底、逐条详情补全。
"""
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import schedule


class OriginFromTagsTest(unittest.TestCase):
    def test_meta_tags_region(self):
        self.assertEqual(schedule.origin_from_tags(["TV", "日本", "漫画改"]), "jp")
        self.assertEqual(schedule.origin_from_tags(["中国", "WEB"]), "cn")
        self.assertEqual(schedule.origin_from_tags(["喜剧", "美国", "WEB"]), "us")
        self.assertEqual(schedule.origin_from_tags(["TV", "韩国"]), "kr")
        self.assertEqual(schedule.origin_from_tags(["TV", "法国"]), "other")

    def test_dict_tags_and_empty(self):
        tags = [{"name": "TV", "count": 10}, {"name": "日本", "count": 3}]
        self.assertEqual(schedule.origin_from_tags(tags), "jp")
        self.assertEqual(schedule.origin_from_tags([]), "")
        self.assertEqual(schedule.origin_from_tags(None), "")
        self.assertEqual(schedule.origin_from_tags(["TV", "WEB"]), "")

    def test_country_beats_other_tags(self):
        # 国家词可能排在后面（用户标签按热度排序），仍要优先认出来。
        tags = ["2026年10月", "漫画改", "TV", "战斗", "日本"]
        self.assertEqual(schedule.origin_from_tags(tags), "jp")


class ParseBangumiOriginTest(unittest.TestCase):
    def test_metatags_win(self):
        document = {"1": [{"subject": {
            "id": 1, "name": "x", "nameCN": "测试", "metaTags": ["TV", "日本"],
            "tags": [{"name": "原创", "count": 5}], "rating": {"score": 7, "total": 10},
        }}]}
        row = schedule.parse_bangumi(document)[0]
        self.assertEqual(row["origin"], "jp")
        # 展示用标签仍只取前五个，不被地区扫描改动。
        self.assertEqual(row["tags"], ["原创"])

    def test_falls_back_to_user_tags(self):
        document = {"1": [{"subject": {
            "id": 2, "name": "y", "nameCN": "国产", "metaTags": [],
            "tags": [{"name": "TV", "count": 9}, {"name": "中国", "count": 2}],
            "rating": {"score": 6, "total": 3},
        }}]}
        self.assertEqual(schedule.parse_bangumi(document)[0]["origin"], "cn")

    def test_missing_region_is_empty(self):
        document = {"1": [{"subject": {"id": 3, "name": "z", "nameCN": "无", "rating": {}}}]}
        self.assertEqual(schedule.parse_bangumi(document)[0]["origin"], "")


class MergeKeepsOriginTest(unittest.TestCase):
    def test_schedule_row_does_not_erase_region(self):
        yuc = [{"title": "某番", "aliases": ["某番"], "kind": "weekly", "weekday": 1,
                "origin": "", "time": "", "release": ""}]
        bangumi = [{"id": 9, "title": "某番", "aliases": ["某番"], "kind": "weekly",
                    "weekday": 1, "origin": "jp", "score": 8, "votes": 100, "air_date": "2026-10-05"}]
        rows = schedule.merge_sources(yuc, bangumi)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["origin"], "jp")

    def test_catalog_keeps_origin_when_other_source_lacks_it(self):
        first = [{"id": 11, "origin": "cn", "title": "甲", "aliases": ["甲"]}]
        second = [{"id": 11, "origin": "", "title": "甲", "aliases": ["甲"], "summary": "简介"}]
        merged = schedule.metadata_catalog(second, first)
        self.assertEqual(merged[0]["origin"], "cn")


class OriginCacheTest(unittest.TestCase):
    def payload(self, tags):
        return json.dumps({"id": 1, "meta_tags": tags}).encode()

    def test_fetch_one_caches_every_answer(self):
        seen = []

        def fake_fetch(url, *, body=None, timeout=15):
            seen.append(url)
            return self.payload(["TV", "中国"])

        with TemporaryDirectory() as root:
            cache = schedule.OriginCache(Path(root), fetch=fake_fetch)
            self.assertEqual(cache.fetch_one(589775), "cn")
            self.assertEqual(cache.fetch_one(589775), "cn")
            cache.save()
            self.assertEqual(len(seen), 1)
            self.assertEqual(json.loads((Path(root) / "origins.json").read_text(encoding="utf-8")),
                             {"589775": "cn"})

    def test_missing_region_is_cached_as_empty(self):
        def fake_fetch(url, *, body=None, timeout=15):
            return self.payload([])

        with TemporaryDirectory() as root:
            cache = schedule.OriginCache(Path(root), fetch=fake_fetch)
            self.assertEqual(cache.fetch_one(5), "")
            # 空值也要记住，否则每次刷新都重问一遍。
            self.assertEqual(cache.get(5), "")

    def test_failed_request_does_not_poison_cache(self):
        def fake_fetch(url, *, body=None, timeout=15):
            raise OSError("network down")

        with TemporaryDirectory() as root:
            cache = schedule.OriginCache(Path(root), fetch=fake_fetch)
            self.assertEqual(cache.fetch_one(7), "")
            self.assertIsNone(cache.get(7))

    def test_fill_only_touches_missing_rows(self):
        def fake_fetch(url, *, body=None, timeout=15):
            return self.payload(["TV", "美国"])

        with TemporaryDirectory() as root:
            cache = schedule.OriginCache(Path(root), fetch=fake_fetch)
            items = [
                {"id": 1, "origin": "jp"},
                {"id": 2, "origin": ""},
                {"id": None, "origin": ""},
                {"id": 3},
            ]
            cache.fill(items, budget=10)
            self.assertEqual([row["origin"] for row in items], ["jp", "us", "", "us"])

    def test_budget_limits_requests(self):
        calls = []

        def fake_fetch(url, *, body=None, timeout=15):
            calls.append(url)
            return self.payload(["TV", "日本"])

        with TemporaryDirectory() as root:
            cache = schedule.OriginCache(Path(root), fetch=fake_fetch)
            cache._warmed = True  # 预热另算一次请求，这里只看详情预算
            items = [{"id": n, "origin": ""} for n in range(1, 11)]
            cache.fill(items, budget=3)
            self.assertEqual(len(calls), 3)
            self.assertEqual(sum(1 for row in items if row["origin"]), 3)


if __name__ == "__main__":
    unittest.main()
