"""AnimeSchedule's actual dated weeks, adapted to the existing calendar UI."""
from __future__ import annotations

import hashlib
import json
import re
import threading
import time
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta

from .animeschedule import BEIJING, ID_FIELDS, choose_match, compute_progress, external_ids, parse_time
from .observability import record_failure


def week_key(value="", now=None):
    if not value:
        # The same 04:00 Beijing day boundary as the calendar tabs.
        current = now or datetime.now(BEIJING)
        if current.tzinfo is None:
            current = current.replace(tzinfo=BEIJING)
        year, week, _ = (current.astimezone(BEIJING) - timedelta(hours=4)).isocalendar()
    else:
        match = re.fullmatch(r"(20\d{2})-W(\d{2})", str(value))
        if not match:
            raise ValueError("AS 周次格式无效")
        year, week = map(int, match.groups())
    date.fromisocalendar(year, week, 1)  # Reject nonexistent week 53.
    return f"{year}-W{week:02d}"


def image_path(value):
    text = str(value or "")
    if not re.fullmatch(r"anime/[A-Za-z0-9/_.-]+\.(?:jpg|jpeg|png|webp)", text) or ".." in text.split("/"):
        return ""
    return text


def build_calendar(key, rows, identities=None, catalogue=None, origins=None):
    identities, catalogue, origins = identities or {}, catalogue or {}, origins or {}
    year, week = int(key[:4]), int(key[-2:])
    monday = date.fromisocalendar(year, week, 1)
    events = {}
    for row in rows:
        if row.get("airType") not in {"raw", "sub"} or row.get("airingStatus") in {"cancelled", "canceled"}:
            continue
        at, route, number = parse_time(row.get("episodeDate")), row.get("route"), row.get("episodeNumber")
        if not at or not isinstance(route, str) or not re.fullmatch(r"[a-z0-9-]+", route) or type(number) is not int or number < 1:
            continue
        event_key = (route, number)
        previous = events.get(event_key)
        delayed = row.get("airingStatus") == "delayed-air"
        previous_delayed = previous and previous[1].get("airingStatus") == "delayed-air"
        if previous is None or (previous_delayed and not delayed) or (delayed == bool(previous_delayed) and at < previous[0]):
            events[event_key] = (at, row)
    groups = defaultdict(list)
    for at, row in events.values():
        day = (at.astimezone(BEIJING) - timedelta(hours=4)).date()
        if monday <= day < monday + timedelta(days=7):
            groups[(row["route"], day)].append((at, row))
    items = []
    for (route, day), group in sorted(groups.items()):
        at, row = min(group, key=lambda entry: (entry[1].get("airingStatus") == "delayed-air", entry[0]))
        delayed = all(entry[1].get("airingStatus") == "delayed-air" for entry in group)
        local = at.astimezone(BEIJING)
        metadata, identity = catalogue.get(route, {}), identities.get(route, {})
        names = metadata.get("names") or {}
        title = identity.get("name_cn") or names.get("native") or row.get("native") or row.get("title") or route
        aliases = list(dict.fromkeys(str(value) for value in [title, row.get("native"), row.get("title"), row.get("romaji"), row.get("english"), *[v for v in names.values() if isinstance(v, str)]] if value))
        numbers = sorted({entry[1]["episodeNumber"] for entry in group})
        total = int(metadata.get("episodes") or 0)
        picture = image_path(row.get("imageVersionRoute") or metadata.get("imageVersionRoute"))
        premiere = parse_time(metadata.get("premier"))
        items.append({
            "key": hashlib.sha256(f"{key}:{route}:{day}".encode()).hexdigest()[:20],
            "id": int(identity["bgm_id"]) if identity.get("bgm_id") else None,
            "origin": origins.get(str(identity["bgm_id"]), "") if identity.get("bgm_id") else "",
            "title": title, "aliases": aliases, "kind": "weekly", "weekday": day.isoweekday(),
            "bj_weekday": local.isoweekday(), "bj_time": "" if delayed else local.strftime("%H:%M"), "delayed": delayed,
            "time_order": None if delayed else (local.hour * 60 + local.minute - 240) % 1440,
            "image_url": "https://img.animeschedule.net/production/assets/public/img/" + picture if picture else "",
            "image_path": picture, "route": route, "episode_count": total,
            "score": 0, "votes": 0, "votes_known": False,
            "air_date": premiere.date().isoformat() if premiere else "",
            "release": premiere.astimezone(BEIJING).strftime("%m/%d") if premiere else "",
            "tags": [f"第 {numbers[0]} 集" if len(numbers) == 1 else f"本日 {len(numbers)} 集"],
            "summary": "", "as_url": "https://animeschedule.net/anime/" + route,
            "as_airing": compute_progress(route, rows, total),
        })
    return {"source": "as", "schema_version": 1, "week": key, "week_monday": monday.isoformat(), "items": items,
            "fetched_at": time.time(), "warnings": [], "sources": ["https://animeschedule.net"]}


class ASCalendar:
    def __init__(self, service):
        from schedule import OriginCache
        self.service, self.root = service, service.root / "calendar"
        self.origins = OriginCache(service.root)
        self.lock = threading.RLock()
        self.jobs, self.errors, self.attempts = set(), {}, {}
        self.catalogue = self._read("catalogue.json", {})

    def _read(self, name, default):
        try:
            return json.loads((self.root / name).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return default

    def _write(self, name, value):
        self.root.mkdir(parents=True, exist_ok=True)
        temporary = self.root / f"{name}.{threading.get_ident()}.tmp"
        temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
        temporary.replace(self.root / name)

    def identities(self):
        mapping = self.service._read("external-ids.json", [])
        by_id = {str(row["bgm_id"]): row for row in mapping if row.get("bgm_id")}
        reverse = defaultdict(set)
        for bgm_id, row in by_id.items():
            for field in ID_FIELDS:
                if row.get(field):
                    reverse[(field, str(row[field]))].add(bgm_id)
        candidates = defaultdict(list)
        for anime in self.catalogue.values():
            ids = external_ids(anime)
            possible = set().union(*(reverse[(field, value)] for field, value in ids.items()))
            for bgm_id in possible:
                candidates[bgm_id].append(anime)
        matched_routes = defaultdict(dict)
        for bgm_id, values in candidates.items():
            expected = {field: str(by_id[bgm_id][field]) for field in ID_FIELDS if by_id[bgm_id].get(field)}
            match = choose_match(expected, values)
            if match:
                matched_routes[match["route"]][bgm_id] = by_id[bgm_id]
        result = {route: next(iter(values.values())) for route, values in matched_routes.items() if len(values) == 1}
        # Reuse prior verified progress bindings while the calendar fills its catalogue.
        with self.service.lock:
            records = dict(self.service.cache["records"])
        for bgm_id, record in records.items():
            route = record.get("route")
            if route and route not in self.catalogue and bgm_id in by_id:
                result.setdefault(route, by_id[bgm_id])
        return result

    def _store_metadata(self, animes):
        fields = ("route", "title", "names", "websites", "premier", "episodes", "imageVersionRoute")
        for anime in animes:
            if isinstance(anime, dict) and anime.get("route"):
                self.catalogue[anime["route"]] = {field: anime[field] for field in fields if field in anime}
                self.catalogue[anime["route"]]["_fetched_at"] = time.time()
        self._write("catalogue.json", self.catalogue)

    def _cache_bindings(self, identities):
        """Share verified calendar IDs with progress; do not query them twice."""
        with self.service.lock:
            for route, identity in identities.items():
                metadata = self.catalogue.get(route)
                if not metadata:
                    continue
                key = str(identity["bgm_id"])
                previous = self.service.cache["records"].get(key, {})
                fetched = metadata.get("_fetched_at", 0)
                if not fetched or (previous.get("route") == route and previous.get("fetched", 0) > fetched):
                    continue
                self.service.cache["records"][key] = {
                    "route": route, "total": int(metadata.get("episodes") or 0),
                    "fetched": fetched, "checked": previous.get("checked", 0),
                }
            self.service._write("progress.json", self.service.cache)

    def _refresh(self, key, force=False):
        try:
            year, week = int(key[:4]), int(key[-2:])
            self.service.ensure_mapping()
            rows = self.service.week_rows(year, week, force=force)
            previous_monday = date.fromisocalendar(year, week, 1) - timedelta(days=7)
            previous_year, previous_week, _ = previous_monday.isocalendar()
            # A streaming episode can have aired last week before this week's
            # TV event. Compare adjacent weeks before deduplicating by episode.
            rows = rows + self.service.week_rows(previous_year, previous_week, force=force)
            next_monday = date.fromisocalendar(year, week, 1) + timedelta(days=7)
            next_year, next_week, _ = next_monday.isocalendar()
            # Include next Monday's 00:00–03:59 in this broadcast Sunday's tab.
            rows = rows + self.service.week_rows(next_year, next_week, force=force)
            def save():
                identities = self.identities()
                self._cache_bindings(identities)
                self._write(key + ".json", build_calendar(key, rows, identities, self.catalogue, self.origins.snapshot()))
            save()  # First paint does not wait for every metadata request.
            # 地区只能逐条问 Bangumi（AS 自身没有地区字段）。先让卡片出来，
            # 再补一次并重写本周缓存；查过的 id 会留在 origins.json 里。
            self.origins.warm()
            document = self._read(key + ".json", {})
            pending = [item["id"] for item in document.get("items", []) if item.get("id") and not item.get("origin")]
            if pending:
                with ThreadPoolExecutor(max_workers=4) as pool:
                    list(pool.map(self.origins.fetch_one, pending[:80]))
                self.origins.save()
                save()
            routes = {item["route"] for item in build_calendar(key, rows)["items"]}
            def stale_routes():
                return {route for route in routes if time.time() - self.catalogue.get(route, {}).get("_fetched_at", 0) >= 86400}
            missing = stale_routes()
            if missing:
                monday = date.fromisocalendar(year, week, 1)
                season = ("winter", "spring", "summer", "fall")[(monday.month - 1) // 3]
                for page in range(1, 31):
                    payload = self.service._get(f"anime?years={monday.year}&seasons={season}&page={page}")
                    batch = payload.get("anime", [])
                    self._store_metadata(batch)
                    if not batch or page * 18 >= payload.get("totalAmount", 0):
                        break
                save()
                for route in sorted(stale_routes()):
                    if not re.fullmatch(r"[a-z0-9-]+", route):
                        continue
                    payload = self.service._get("anime/" + route)
                    if payload.get("route") == route:
                        self._store_metadata([payload])
                save()
            with self.lock:
                self.errors.pop(key, None)
        except Exception as error:
            record_failure("as_calendar_refresh", error)
            with self.lock:
                self.errors[key] = "AS 周表暂时无法更新，继续显示已有缓存"
        finally:
            with self.lock:
                self.jobs.discard(key)

    def get(self, season, *, week="", refresh=False):
        key = week_key(week)
        cached = self._read(key + ".json", None)
        configured = bool(self.service.token())
        with self.lock:
            stale = not cached or cached.get("schema_version") != 1 or time.time() - cached.get("fetched_at", 0) > 900
            retry_delay = 600 if key in self.errors else 60
            if configured and (refresh or stale) and key not in self.jobs and not self.jobs and time.time() - self.attempts.get(key, 0) > retry_delay:
                self.jobs.add(key)
                self.attempts[key] = time.time()
                threading.Thread(target=self._refresh, args=(key, refresh), name="handbook-as-calendar", daemon=True).start()
            data = cached or build_calendar(key, [])
            with self.service.lock:
                rows = [row for value in self.service.cache["weeks"].values() for row in value.get("rows", [])]
            data = {**data, "items": [{**item, "as_airing": compute_progress(item["route"], rows, item.get("episode_count", 0)) or item.get("as_airing")} for item in data["items"]]}
            return {**data, "season": season, "loading": key in self.jobs or (not cached and bool(self.jobs)),
                    "error": self.errors.get(key, "") if configured else "尚未配置 AnimeSchedule 令牌"}

    def cover(self, week, key):
        data = self._read(week_key(week) + ".json", {})
        item = next((row for row in data.get("items", []) if row.get("key") == key), None)
        picture = image_path((item or {}).get("image_path"))
        if not picture:
            raise ValueError("AS 封面不存在")
        digest = hashlib.sha256(picture.encode()).hexdigest()
        path = self.root / "covers" / (digest + ".img")
        mime = "image/png" if picture.endswith(".png") else "image/webp" if picture.endswith(".webp") else "image/jpeg"
        if path.exists():
            return path.read_bytes(), mime
        request = urllib.request.Request("https://img.animeschedule.net/production/assets/public/img/" + picture, headers={"User-Agent": "AnimeHandbook/1.0"})
        with urllib.request.urlopen(request, timeout=12) as response:
            body = response.read(8 * 1024 * 1024 + 1)
            if response.headers.get_content_type() != mime or not body or len(body) > 8 * 1024 * 1024:
                raise ValueError("AS 封面格式无效")
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f"{digest}-{threading.get_ident()}.tmp")
        temporary.write_bytes(body)
        temporary.replace(path)
        return body, mime
