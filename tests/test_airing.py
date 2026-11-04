"""逐集播出进度：Bangumi 日期 + 放送时刻（日本时间）换算成北京时间后比较。"""
import unittest
from datetime import date, datetime, timedelta, timezone

from handbook import airing

BEIJING = timezone(__import__("datetime").timedelta(hours=8))


def slot(source_time="25:30~", weekday=1, calendar_weekday=2):
    return {
        "id": 1,
        "kind": "weekly",
        "source_time": source_time,
        "source_weekday": weekday,
        "weekday": weekday,
        "calendar_weekday": calendar_weekday,
    }


def anime(dates, count=None, extra_types=True):
    episodes = [
        {"type": 0, "sort": 49 + index, "airdate": value}
        for index, value in enumerate(dates)
    ]
    if extra_types:
        episodes.append({"type": 2, "sort": 1, "airdate": dates[0] if dates else ""})
    return {"episodes": episodes, "episode_count": count if count is not None else len(dates)}


class AiringTest(unittest.TestCase):
    def test_2530_jst_is_0030_beijing(self):
        at, precision = airing.airing_at({"airdate": "2026-10-05"}, slot("25:30~"))
        self.assertEqual(precision, "minute")
        self.assertEqual(at.strftime("%Y-%m-%d %H:%M"), "2026-10-06 00:30")

    def test_2600_jst_is_0100_beijing(self):
        at, precision = airing.airing_at({"airdate": "2026-10-03"}, slot("26:00~", weekday=6, calendar_weekday=7))
        self.assertEqual(precision, "minute")
        self.assertEqual(at.strftime("%Y-%m-%d %H:%M"), "2026-10-04 01:00")

    def test_counts_only_after_the_beijing_instant(self):
        data = anime(["2026-10-05", "2026-10-12", "2026-10-19"])
        before = airing.compute_airing(
            data, slot(), now=datetime(2026, 10, 5, 23, 0, tzinfo=BEIJING)
        )
        self.assertEqual(before["aired"], 0)
        self.assertEqual(before["next_label"], "10/06 00:30")
        after = airing.compute_airing(
            data, slot(), now=datetime(2026, 10, 6, 0, 31, tzinfo=BEIJING)
        )
        self.assertEqual(after["aired"], 1)
        self.assertEqual(after["next_label"], "10/13 00:30")

    def test_date_only_waits_until_the_day_ends(self):
        data = anime(["2026-10-05", "2026-10-12"])
        item = {"source_time": "", "source_weekday": 1, "weekday": 1, "calendar_weekday": 1}
        same_day = airing.compute_airing(
            data, item, now=datetime(2026, 10, 5, 23, 0, tzinfo=BEIJING)
        )
        self.assertEqual(same_day["precision"], "date")
        self.assertEqual(same_day["aired"], 0)
        next_day = airing.compute_airing(
            data, item, now=datetime(2026, 10, 6, 0, 5, tzinfo=BEIJING)
        )
        self.assertEqual(next_day["aired"], 1)
        self.assertIn("时刻待公布", next_day["next_label"])

    def test_weekday_mismatch_degrades_to_date(self):
        # Bangumi says Monday, the slot is Saturday: do not invent a time.
        at, precision = airing.airing_at({"airdate": "2026-10-05"}, slot("20:00~", weekday=6, calendar_weekday=6))
        self.assertEqual(precision, "date")
        self.assertEqual(at.isoformat(), "2026-10-05")

    def test_uses_ordinal_not_count(self):
        dates = [(date(2026, 10, 5) + timedelta(weeks=index)).isoformat() for index in range(12)]
        data = anime(dates, count=12)
        # Only the first five Mondays have passed by 2026-11-03.
        result = airing.compute_airing(
            data, slot(), now=datetime(2026, 11, 3, 12, 0, tzinfo=BEIJING)
        )
        self.assertEqual(result["total"], 12)
        self.assertEqual(result["aired"], 5)
        self.assertEqual(result["next_episode"], 6)

    def test_dirty_dates_and_month_only_are_skipped(self):
        data = anime(["2017-1-8", "2022-09-21\u200b", "2027-04", ""])
        result = airing.compute_airing(
            data, slot("20:00~", weekday=7, calendar_weekday=7),
            now=datetime(2026, 11, 4, 12, 0, tzinfo=BEIJING),
        )
        self.assertIsNotNone(result)
        self.assertEqual(result["aired"], 2)
        self.assertEqual(result["total"], 4)

    def test_no_regular_episodes_returns_none(self):
        self.assertIsNone(airing.compute_airing({"episodes": [{"type": 2, "airdate": "2026-10-05"}]}, slot()))

    def test_episode_count_larger_than_listed_is_kept(self):
        result = airing.compute_airing(
            anime(["2026-10-05"]), slot(), now=datetime(2026, 10, 6, 1, 0, tzinfo=BEIJING)
        )
        self.assertEqual(result["total"], 1)
        result = airing.compute_airing(
            {"episodes": [{"type": 0, "airdate": "2026-10-05"}], "episode_count": 12},
            slot(),
            now=datetime(2026, 10, 6, 1, 0, tzinfo=BEIJING),
        )
        self.assertEqual(result["total"], 12)
        self.assertEqual(result["aired"], 1)


if __name__ == "__main__":
    unittest.main()
