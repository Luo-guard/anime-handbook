"""Cached, read-only AnimeSchedule progress. Never changes collection progress.

Network work is confined to one background worker. Identity uses external IDs,
not title similarity; uncertain or split mappings remain unavailable.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .observability import record_failure

BEIJING = timezone(timedelta(hours=8))
API = "https://animeschedule.net/api/v3/"
MAPPING_URL = "https://raw.githubusercontent.com/Rhilip/BangumiExtLinker/main/data/anime_map.json"
ID_FIELDS = {
    "mal_id": ("mal", r"myanimelist\.net/anime/(\d+)", "mal-ids"),
    "anilist_id": ("aniList", r"anilist\.co/anime/(\d+)", "anilist-ids"),
    "anidb_id": ("anidb", r"anidb\.net/anime/(\d+)", "anidb-ids"),
}
WEEK_TTL = 900
UNMATCHED_TTL = 86400


def title_key(value):
    return "".join(char for char in unicodedata.normalize("NFKC", str(value or "")).casefold()
                   if char.isalnum())


def progress_weeks():
    current = datetime.now(BEIJING)
    return [(current + timedelta(weeks=offset)).isocalendar()[:2] for offset in (-1, 0, 1)]


def parse_time(value):
    try:
        result = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return result if result.year > 1 and result.tzinfo else None
    except (ValueError, TypeError):
        return None


def external_ids(anime):
    sites = anime.get("websites") or {}
    found = {}
    for key, (site, pattern, _) in ID_FIELDS.items():
        match = re.search(pattern, str(sites.get(site) or ""))
        if match:
            found[key] = match[1]
    return found


def choose_match(expected, candidates):
    """Require two agreeing IDs and reject contradictory IDs and ties."""
    matches = {}
    for anime in candidates:
        actual = external_ids(anime)
        shared = set(expected) & set(actual)
        if len(shared) < 2 or any(str(expected[key]) != actual[key] for key in shared):
            continue
        route = anime.get("route")
        if isinstance(route, str) and re.fullmatch(r"[a-z0-9-]+", route):
            matches[route] = anime
    return next(iter(matches.values())) if len(matches) == 1 else None


def compute_progress(route, rows, total=0, now=None):
    """Use actual dated raw/sub events; never extrapolate weekly episodes."""
    current = now or datetime.now(BEIJING)
    if current.tzinfo is None:
        current = current.replace(tzinfo=BEIJING)
    events = {}
    for row in rows:
        if row.get("route") != route or row.get("airType") not in {"raw", "sub"}:
            continue
        if row.get("airingStatus") in {"delayed-air", "cancelled", "canceled"}:
            continue
        at = parse_time(row.get("episodeDate"))
        number = row.get("episodeNumber")
        if at is None or type(number) is not int or number <= 0:
            continue
        # Raw/sub may describe the same episode; use its earliest release.
        events[number] = min(at, events.get(number, at))
        count = row.get("episodes")
        if type(count) is int and count > 0:
            total = max(total, count)
    if not events:
        return None
    reached = [number for number, at in events.items() if at <= current]
    aired = max(reached, default=0)
    # A future event alone does not prove its preceding episodes have aired.
    if not reached and min(events) > 1:
        return None
    future = sorted((at, number) for number, at in events.items() if at > current and number > aired)
    at, number = future[0] if future else (None, None)
    return {
        "aired": aired, "total": total, "precision": "minute", "source": "as",
        "next_at": int(at.timestamp()) if at else None,
        "next_episode": number,
        "next_label": at.astimezone(BEIJING).strftime("%m/%d %H:%M") if at else "",
        "url": "https://animeschedule.net/anime/" + route,
    }


class AnimeScheduleService:
    def __init__(self, root):
        self.root = Path(root)
        self.lock = threading.RLock()
        self.request_lock = threading.Lock()
        self.week_lock = threading.Lock()
        self.mapping_lock = threading.Lock()
        self.cache = self._read("progress.json", {"records": {}, "weeks": {}})
        if not isinstance(self.cache, dict):
            self.cache = {}
        for key in ("records", "weeks"):
            if not isinstance(self.cache.get(key), dict):
                self.cache[key] = {}
        self.mapping = None
        self.pending = {}
        self.inflight = set()
        self.worker = None
        self.retry_at = 0
        self.last_request = 0
        self.mapping_loaded = 0

    def _read(self, name, fallback):
        try:
            return json.loads((self.root / name).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return fallback

    def _write(self, name, data):
        self.root.mkdir(parents=True, exist_ok=True)
        temporary = self.root / (name + ".tmp")
        temporary.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        temporary.replace(self.root / name)

    def token(self):
        value = os.environ.get("ANIMESCHEDULE_TOKEN", "").strip()
        if value:
            return value
        try:
            return (self.root / "token.txt").read_text(encoding="utf-8-sig").strip()
        except OSError:
            return ""

    def _get(self, path):
        with self.request_lock:
            return self._request(path)

    def _request(self, path):
        # 120/minute upstream limit; keep this worker below 90/minute.
        time.sleep(max(0, .7 - (time.monotonic() - self.last_request)))
        self.last_request = time.monotonic()
        request = urllib.request.Request(API + path, headers={
            "Authorization": "Bearer " + self.token(), "User-Agent": "AnimeHandbook/1.0",
        })
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                return json.loads(response.read(8 * 1024 * 1024))
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return {"anime": []}
            raise

    def _load_mapping(self):
        path = self.root / "external-ids.json"
        data = self._read("external-ids.json", None)
        if data is None or time.time() - path.stat().st_mtime > 7 * 86400:
            try:
                request = urllib.request.Request(MAPPING_URL, headers={"User-Agent": "AnimeHandbook/1.0"})
                with urllib.request.urlopen(request, timeout=20) as response:
                    incoming = json.loads(response.read(32 * 1024 * 1024))
                if not isinstance(incoming, list):
                    raise ValueError("Invalid external ID catalogue")
                data = incoming
                self._write("external-ids.json", data)
            except Exception:
                if data is None:
                    raise
        return {str(row["bgm_id"]): {key: str(row[key]) for key in ID_FIELDS if row.get(key)}
                for row in data if row.get("bgm_id")}

    def ensure_mapping(self):
        with self.mapping_lock:
            if self.mapping is None or time.time() - self.mapping_loaded > 7 * 86400:
                self.mapping = self._load_mapping()
                self.mapping_loaded = time.time()
        return self.mapping

    def week_rows(self, year, week, *, force=False):
        with self.week_lock:
            return self._week_rows(year, week, force=force)

    def _week_rows(self, year, week, *, force):
        key = f"{year}-{week}"
        with self.lock:
            cached = self.cache["weeks"].get(key, {})
        if not force and cached.get("schema") == 3 and time.time() - cached.get("fetched", 0) < WEEK_TTL:
            return cached["rows"]
        rows = self._get("timetables/all?" + urllib.parse.urlencode({"year": year, "week": week, "tz": "Asia/Shanghai"}))
        if not isinstance(rows, list):
            raise ValueError("Invalid AnimeSchedule timetable")
        fields = ("route", "title", "native", "romaji", "english", "airType", "episodeDate", "episodeNumber", "episodes", "imageVersionRoute", "mediaTypes", "airingStatus")
        compact = [{key: row[key] for key in fields if key in row} for row in rows if isinstance(row, dict)]
        with self.lock:
            self.cache["weeks"][key] = {"fetched": time.time(), "schema": 3, "rows": compact}
            self._write("progress.json", self.cache)
        return compact

    def _refresh_weeks(self):
        weeks = progress_weeks()
        for year, week in weeks:
            self.week_rows(year, week)
        keys = {f"{year}-{week}" for year, week in weeks}
        with self.lock:
            self.cache["weeks"] = {key: value for key, value in self.cache["weeks"].items() if key in keys}

    def _progress_cache(self):
        return [self.cache["weeks"].get(f"{year}-{week}", {}) for year, week in progress_weeks()]

    @staticmethod
    def _title_routes(rows):
        index = {}
        for row in rows:
            if row.get("airType") not in {"raw", "sub"} or not row.get("route"):
                continue
            for field in ("title", "native", "romaji", "english"):
                key = title_key(row.get(field))
                if key:
                    index.setdefault(key, set()).add(row["route"])
        return index

    @staticmethod
    def _lookup_routes(titles, title_routes):
        return sorted(set().union(*(title_routes.get(title, ()) for title in titles or ())))

    @classmethod
    def _needs_lookup(cls, record, titles, title_routes, now):
        if record.get("route"):
            return False
        if titles is None:
            # The caller already selected the schedule's visible IDs.
            return now - record.get("fetched", 0) >= UNMATCHED_TTL
        scheduled = cls._lookup_routes(titles, title_routes)
        # A changed route or a new timetable match can bypass an old miss.
        return bool(scheduled and (scheduled != record.get("lookup_routes", [])
                                   or now - record.get("fetched", 0) >= UNMATCHED_TTL))

    def refresh(self, ids, *, titles=None):
        """Worker entry point, also usable by isolated integration checks."""
        self._refresh_weeks()
        with self.lock:
            weeks = self._progress_cache()
        title_routes = self._title_routes(row for week in weeks for row in week.get("rows", []))
        mapping = None
        for bgm_id in ids:
            key = str(bgm_id)
            names = (titles or {}).get(bgm_id)
            with self.lock:
                previous = self.cache["records"].get(key, {})
            if not self._needs_lookup(previous, names, title_routes, time.time()):
                continue
            if mapping is None:
                mapping = self.ensure_mapping()
            expected = mapping.get(key, {})
            candidate = None
            if len(expected) >= 2:
                field = next(field for field in ID_FIELDS if field in expected)
                query = urllib.parse.urlencode({ID_FIELDS[field][2]: expected[field]})
                candidates = []
                for page in range(1, 11):
                    payload = self._get("anime?" + query + f"&page={page}")
                    batch = payload.get("anime", [])
                    candidates.extend(batch)
                    if len(candidates) >= payload.get("totalAmount", len(candidates)) or not batch:
                        break
                else:
                    # An incomplete result set cannot establish uniqueness.
                    candidates = []
                candidate = choose_match(expected, candidates)
            with self.lock:
                # Calendar refresh may have linked this ID while the request was running.
                current = self.cache["records"].get(key, {})
                if current is not previous and current.get("route"):
                    continue
                confirmed = {"route": candidate["route"], "total": int(candidate.get("episodes") or 0)} if candidate else {}
                self.cache["records"][key] = {
                    **previous, **confirmed,
                    "lookup_routes": self._lookup_routes(names, title_routes),
                    "fetched": time.time(), "checked": time.time(),
                }
                self._write("progress.json", self.cache)

    def _run(self):
        try:
            while True:
                with self.lock:
                    if not self.pending:
                        self.worker = None
                        return
                    ids = sorted(self.pending)[:18]
                    titles = {value: self.pending.pop(value) for value in ids}
                    self.inflight = set(ids)
                self.refresh(ids, titles=titles)
                with self.lock:
                    self.inflight.clear()
        except Exception as error:
            record_failure("animeschedule_refresh", error)
            with self.lock:
                self.retry_at = time.time() + 600
                self.pending.clear()
                self.inflight.clear()
                self.worker = None

    def get_many(self, ids, *, titles=None):
        valid = {int(value) for value in ids if type(value) is int and value > 0}
        with self.lock:
            configured = bool(self.token())
            now = time.time()
            weeks = self._progress_cache()
            rows = [row for week in weeks for row in week.get("rows", [])]
            title_routes = self._title_routes(rows) if titles is not None else {}
            stale = any(now - week.get("fetched", 0) >= WEEK_TTL or week.get("schema") != 3 for week in weeks)
            if configured and now >= self.retry_at:
                for value in valid - self.inflight:
                    names = titles.get(value, ()) if titles is not None else None
                    record = self.cache["records"].get(str(value), {})
                    if stale or self._needs_lookup(record, names, title_routes, now):
                        if value not in self.pending or names is not None:
                            self.pending[value] = names
                if self.pending and self.worker is None:
                    self.worker = threading.Thread(target=self._run, name="handbook-as", daemon=True)
                    self.worker.start()
            rows_by_route = {}
            for row in rows:
                rows_by_route.setdefault(row.get("route"), []).append(row)
            latest = max((week.get("fetched", 0) for week in weeks), default=0)
            output = {}
            for value in valid:
                record = self.cache["records"].get(str(value), {})
                route = record.get("route")
                result = compute_progress(route, rows_by_route.get(route, ()), record.get("total", 0)) if route else None
                if result:
                    result["stale"] = now - latest > 6 * 3600
                output[str(value)] = result or {"source": "as", "unavailable": True,
                    "status": "loading" if value in self.pending or value in self.inflight else "unavailable" if configured else "unconfigured"}
            return output
