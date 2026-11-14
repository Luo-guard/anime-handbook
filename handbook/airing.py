"""Airing progress for collection items (meaning A: schedule, not resource sites).

Bangumi gives one date per episode; the seasonal schedule gives the broadcast
clock (Japan time, possibly 24:00+). Combining them yields the exact airing
instant. The schedule is a calendar, not a claim that a Chinese streaming copy
is already available.
"""
from __future__ import annotations

import re
import math
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

JST = timezone(timedelta(hours=9))
BEIJING = timezone(timedelta(hours=8))

DATE_RE = re.compile(r"(\d{4})-(\d{1,2})-(\d{1,2})")
CLOCK_RE = re.compile(r"(?<!\d)(\d{1,2}):(\d{2})")


def parse_airdate(value: Any) -> date | None:
    """Bangumi sometimes returns 2017-1-8, 2027-04 or a zero-width space."""
    text = str(value or "").replace("\u200b", "").strip()
    match = DATE_RE.search(text)
    if not match:
        return None
    try:
        return date(*map(int, match.groups()))
    except ValueError:
        return None


def slot_offset(item: dict[str, Any]) -> int | None:
    """Minutes since the broadcast day's 00:00 JST; 25:30 becomes 1530."""
    match = CLOCK_RE.search(str(item.get("source_time") or ""))
    if not match:
        return None
    hour, minute = map(int, match.groups())
    if not (0 <= hour <= 47 and 0 <= minute <= 59):
        return None
    return hour * 60 + minute


def source_weekday(item: dict[str, Any]) -> int | None:
    """The source's broadcast weekday, recovered for older caches too."""
    raw = item.get("source_weekday")
    if isinstance(raw, int) and 1 <= raw <= 7:
        return raw
    offset = slot_offset(item)
    try:
        calendar = int(item.get("calendar_weekday"))
    except (TypeError, ValueError):
        return None
    if offset is None:
        return calendar if 1 <= calendar <= 7 else None
    return (calendar - 1 - (1 if offset >= 1440 else 0)) % 7 + 1


def airing_at(episode: dict[str, Any], item: dict[str, Any]) -> tuple[datetime | date | None, str]:
    """Return (instant/date, precision). Precision is minute, date or none."""
    air_date = parse_airdate(episode.get("airdate"))
    if air_date is None:
        return None, "none"
    offset = slot_offset(item)
    weekday = source_weekday(item)
    # A mismatch means Bangumi's date is not this slot's broadcast day. Play it
    # safe: count by date only instead of inventing a precise time.
    if offset is None or weekday is None or air_date.isoweekday() != weekday:
        return air_date, "date"
    at = datetime.combine(air_date, time(), JST) + timedelta(minutes=offset)
    return at.astimezone(BEIJING), "minute"


def compute_airing(anime: dict[str, Any], item: dict[str, Any], now: datetime | None = None) -> dict[str, Any] | None:
    """Compute aired count and the next episode for one collection item.

    ``aired`` is the ordinal of the last reached regular episode (1-based), not
    a count, so a missing airdate in the middle cannot shift the display.
    """
    episodes = [
        episode
        for episode in (anime.get("episodes") or [])
        if isinstance(episode, dict) and int(episode.get("type") or 0) == 0
    ]
    if not episodes:
        return None
    current = now or datetime.now(BEIJING)
    if current.tzinfo is None:
        current = current.replace(tzinfo=BEIJING)
    current = current.astimezone(BEIJING)

    total = max(len(episodes), int(anime.get("episode_count") or 0))
    def number(episode):
        try:
            value = float(episode.get("sort", episode.get("ep")))
            return int(value) if math.isfinite(value) and value > 0 and value.is_integer() else None
        except (ValueError, TypeError):
            return None
    numbers = [number(episode) for episode in episodes]
    known = [value for value in numbers if value is not None]
    # Continued series can label this season 49..60. Normalize that offset,
    # but keep gaps within 1..total (1,3 must never become episode 1,2).
    offset = min(known) - 1 if known and min(known) > 1 and max(known) > total else 0
    numbered = [(value - offset if value is not None else index, episode)
                for index, (value, episode) in enumerate(zip(numbers, episodes), 1)]
    numbered.sort(key=lambda pair: pair[0])
    total = max(total, max(index for index, _ in numbered))
    aired = 0
    latest_aired_at = ""
    next_episode: tuple[int, dict[str, Any], datetime | date, str] | None = None
    precision = "minute"
    valid = 0
    for index, episode in numbered:
        at, level = airing_at(episode, item)
        if at is None:
            continue
        valid += 1
        if level == "date":
            precision = "date"
            reached = at < current.date()
        else:
            reached = at <= current
        if reached:
            aired = max(aired, index)
            latest_aired_at = max(latest_aired_at, at.isoformat())
        elif next_episode is None:
            next_episode = (index, episode, at, level)

    if not valid:
        return None

    result: dict[str, Any] = {
        "aired": aired,
        "latest_aired_at": latest_aired_at,
        "total": total,
        "precision": precision,
        "next_at": None,
        "next_label": "",
        "next_episode": None,
    }
    if next_episode is not None:
        index, _, at, level = next_episode
        result["next_episode"] = index
        if level == "minute" and isinstance(at, datetime):
            result["next_at"] = int(at.timestamp())
            result["next_label"] = at.strftime("%m/%d %H:%M")
        else:
            result["next_label"] = f"{at.strftime('%m/%d')}（时刻待公布）"
    return result
