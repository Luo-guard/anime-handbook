"""Seasonal airing calendar. Public-source cache is separate from account data."""
from __future__ import annotations

import hashlib
import json
import re
import ssl
import threading
import time
import unicodedata
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import quote, urlparse

BEIJING = timezone(timedelta(hours=8))
WEEKDAYS = "一二三四五六日"


def season_key(value: str) -> str:
    if not re.fullmatch(r"(?:19|20|21)\d{2}(?:01|04|07|10)", value):
        raise ValueError("季度格式无效")
    return value


def broadcast_slot(weekday: int, text: str) -> dict:
    """Source uses broadcast hours such as Monday 25:30 (Tuesday 01:30)."""
    match = re.search(r"(?<!\d)(\d{1,2}):(\d{2})", text)
    if not match or not 1 <= weekday <= 7:
        return {"weekday": weekday, "time": "", "time_order": 9999, "calendar_weekday": weekday}
    hour, minute = map(int, match.groups())
    if hour > 47 or minute > 59:
        return {"weekday": weekday, "time": "", "time_order": 9999, "calendar_weekday": weekday}
    minutes = hour * 60 + minute
    day = (weekday - 1 + (minutes - 240) // 1440) % 7 + 1
    actual = (weekday - 1 + minutes // 1440) % 7 + 1
    return {"weekday": day, "calendar_weekday": actual,
            "time": f"{hour % 24:02d}:{minute:02d}", "time_order": (minutes - 240) % 1440}


class Node:
    def __init__(self, tag="", attrs=(), parent=None):
        self.tag, self.attrs, self.parent, self.children = tag, dict(attrs), parent, []

    def walk(self):
        yield self
        for child in self.children:
            if isinstance(child, Node):
                yield from child.walk()

    def text(self):
        return "".join(child.text() if isinstance(child, Node) else child for child in self.children).strip()

    def lines(self):
        """Preserve explicit title/subtitle breaks supplied by the publisher."""
        def contents(node):
            if node.tag == "br":
                return "\n"
            return "".join(contents(child) if isinstance(child, Node) else child for child in node.children)
        return [line.strip() for line in contents(self).splitlines() if line.strip()]

    def has(self, class_name):
        return class_name in self.attrs.get("class", "").split()


class SourceHTML(HTMLParser):
    def __init__(self, text):
        super().__init__(convert_charrefs=True)
        self.root = self.current = Node()
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        child = Node(tag, attrs, self.current)
        self.current.children.append(child)
        if tag not in {"img", "br", "hr", "input", "meta", "link", "source", "wbr", "area", "embed"}:
            self.current = child
        elif tag == "br":
            child.children.append(" ")

    def handle_endtag(self, tag):
        node = self.current
        while node.parent is not None:
            if node.tag == tag:
                self.current = node.parent
                break
            node = node.parent

    def handle_data(self, data):
        self.current.children.append(data)


def parse_yuc(html: str) -> list[dict]:
    nodes = list(SourceHTML(html).root.walk())
    weekday = 0
    network = False
    rows = []
    for node in nodes:
        if node.has("date2"):
            text = node.text()
            match = re.search(r"周([一二三四五六日天])", text)
            if match:
                weekday = WEEKDAYS.index(match[1].replace("天", "日")) + 1
                network = False
            elif "网络放送" in text:
                network = True
                weekday = 0
        if not node.attrs.get("class", "").startswith("date_title") or not (weekday or network):
            continue
        card = node
        while card.parent is not None and "float" not in card.attrs.get("style", ""):
            card = card.parent
        descendants = list(card.walk())
        find_text = lambda cls: next((n.text() for n in descendants if n.has(cls)), "")
        poster = next((n for n in descendants if n.tag == "img"), None)
        title = re.sub(r"\s+", " ", node.text()).strip()
        if not title:
            continue
        # The publisher uses several colors/classes for the same time field.
        # Read its content inside the poster region, not one presentation class.
        poster_region = next((n for n in descendants if n.has("div_date") or n.has("div_date_")), None)
        raw_time = next((n.text() for n in poster_region.walk()
                         if n.tag == "p" and re.search(r"(?<!\d)\d{1,2}:\d{2}", n.text())), "") if poster_region else ""
        release_text = find_text("pmfs2") if network else next((n.text() for n in descendants
            if any(re.fullmatch(r"imgep\d*", cls) for cls in n.attrs.get("class", "").split())), "")
        # Episode-count badges such as (全24话) occupy the same source position
        # as premiere dates, but are not dates and must not be rendered as “起”.
        release = release_text if re.search(r"\d{1,2}/\d{1,2}", release_text) else ""
        release_note = find_text("pmex") if network else (release_text if not release else "")
        links = list(dict.fromkeys(n.attrs.get("href", "") for n in descendants if n.tag == "a" and n.attrs.get("href", "").startswith("https://")))
        platforms = []
        for link in links:
            host = urlparse(link).hostname or ""
            label = next((label for part, label in [("netflix", "Netflix"), ("primevideo", "Prime Video"), ("gamer.com.tw", "巴哈姆特"), ("bilibili", "哔哩哔哩"), ("crunchyroll", "Crunchyroll"), ("iq.com", "爱奇艺"), ("qq.com", "腾讯视频")] if part in host), host)
            platforms.append({"name": label, "url": link})
        rows.append({"title": title, "kind": "network" if network else "weekly",
                     **broadcast_slot(weekday, raw_time), "source_time": raw_time,
                     "release": release, "release_note": release_note,
                     "image_url": (poster.attrs.get("data-src") or poster.attrs.get("src", "")) if poster else "",
                     "platforms": platforms, "aliases": [title]})
    # A weekly card often omits the subtitle. The same page's introduction
    # explicitly separates its main title and subtitle with <br>; retain that
    # relationship instead of guessing that arbitrary title prefixes are aliases.
    introductions = []
    for node in nodes:
        if node.attrs.get("class", "").startswith("title_main"):
            children = list(node.walk())
            cn = next((n for n in children if n.attrs.get("class", "").startswith("title_cn")), None)
            jp = next((n for n in children if n.attrs.get("class", "").startswith("title_jp")), None)
            if cn is not None:
                titles = []
                for title in [cn, jp]:
                    if title is not None:
                        titles.append(title.text())
                        lines = title.lines()
                        if lines:
                            titles.append(lines[0])
                introductions.append({"aliases": [cn.text(), *cn.lines()[:1]], "titles": list(dict.fromkeys(titles))})
    for row in rows:
        match = best_match(row["aliases"], introductions)
        if match:
            row["aliases"] = list(dict.fromkeys(row["aliases"] + match["titles"]))
    return rows


def normalized_title(value):
    text = unicodedata.normalize("NFKC", value).casefold()
    def number(value):
        if value.isdecimal():
            return str(int(value))
        if re.fullmatch(r"[ivx]+", value):
            values = {"i": 1, "v": 5, "x": 10}
            return str(sum(-values[c] if i + 1 < len(value) and values[c] < values[value[i + 1]] else values[c]
                           for i, c in enumerate(value)))
        digits = {c: i for i, c in enumerate("零一二三四五六七八九")}
        digits.update({"〇": 0, "两": 2})
        if "十" in value:
            tens, ones = value.split("十", 1)
            return str((digits.get(tens, 1) if tens else 1) * 10 + digits.get(ones, 0))
        return str(digits.get(value, value))
    numeral = r"(?:\d{1,3}|[零〇一二三四五六七八九十两]{1,3}|[ivx]{1,5})"
    text = re.sub(r"第\s*(" + numeral + r")\s*[季期]", lambda m: "season" + number(m[1]), text)
    text = re.sub(r"season\s*(" + numeral + r")(?![a-z])", lambda m: "season" + number(m[1]), text)
    # Common original-language sequel suffix: 統べるⅡ -> 統べるseason2.
    text = re.sub(r"(?<=[\u3040-\u9fff])\s*(ii|iii|iv|vi|vii|viii|ix|x)$", lambda m: "season" + number(m[1]), text)
    return re.sub(r"[^\w]", "", text).replace("_", "")


def best_match(aliases, candidates):
    names = {normalized_title(n) for n in aliases if n}
    if not names:
        return None
    seasons = {n for name in names for n in re.findall(r"season(\d+)", name)}
    if seasons:
        candidates = [candidate for candidate in candidates if seasons.intersection(
            n for alias in candidate.get("aliases", []) for n in re.findall(r"season(\d+)", normalized_title(alias)))]
    exact = []
    for candidate in candidates:
        common = names.intersection(normalized_title(n) for n in candidate.get("aliases", []) if n)
        if common:
            exact.append((max(map(len, common)), candidate))
    if exact:
        # A full original title outranks a shared short franchise alias.
        exact.sort(key=lambda pair: pair[0], reverse=True)
        return exact[0][1] if len(exact) == 1 or exact[0][0] > exact[1][0] else None
    scored = []
    for candidate in candidates:
        other = {normalized_title(n) for n in candidate.get("aliases", []) if n}
        # Compare compatible alias pairs. One alternate spelling must not veto
        # another valid pair, while different seasons/parts remain incompatible.
        score = max((SequenceMatcher(None, a, b).ratio() for a in names for b in other
                     if re.findall(r"\d+", a) == re.findall(r"\d+", b)), default=0)
        scored.append((score, candidate))
    scored.sort(key=lambda pair: pair[0], reverse=True)
    if scored and scored[0][0] >= .84 and (len(scored) == 1 or scored[0][0] - scored[1][0] >= .08):
        return scored[0][1]
    return None


def parse_bangumi(document) -> list[dict]:
    rows = []
    for weekday in range(1, 8):
        for entry in document.get(str(weekday), []):
            item = entry.get("subject", entry)
            rating = item.get("rating") or {}
            title = item.get("name_cn") or item.get("nameCN") or item.get("name") or ""
            if not item.get("id") or not title:
                continue
            tags = item.get("tags") or item.get("metaTags") or []
            air_date = item.get("date") or item.get("air_date", "")
            if not air_date:
                date_match = re.search(r"(\d{4})年(\d{1,2})月(\d{1,2})日", item.get("info") or "")
                if date_match:
                    year, month, day = map(int, date_match.groups())
                    try:
                        air_date = datetime(year, month, day).date().isoformat()
                    except ValueError:
                        pass
            rows.append({"id": int(item["id"]), "title": title,
                         "aliases": [title, item.get("name", "")], "kind": "weekly",
                         "weekday": weekday, "calendar_weekday": weekday, "time": "", "source_time": "", "time_order": 9999,
                         "score": rating.get("score", 0), "votes": rating.get("total", 0),
                         "votes_known": "total" in rating,
                         "image_url": (item.get("images") or {}).get("large", ""),
                         "air_date": air_date,
                         "summary": str(item.get("summary") or "")[:1800],
                         "tags": [(t.get("name", "") if isinstance(t, dict) else str(t)) for t in tags[:5]],
                         "release": "", "release_note": "", "platforms": []})
    return list({r["id"]: r for r in rows}.values())


def metadata_catalog(*sources):
    """Coalesce metadata by its authoritative subject ID before title matching."""
    catalog = {}
    for item in (item for source in sources for item in source):
        if not item.get("id"):
            continue
        previous = catalog.get(item["id"])
        if previous:
            incoming = item
            item = {**item, **previous, "aliases": list(dict.fromkeys(previous.get("aliases", []) + item.get("aliases", [])))}
            # An empty field in one API is not authoritative missing data.
            for field in ["summary", "tags", "air_date", "image_url", "score", "votes"]:
                if not item.get(field):
                    item[field] = incoming.get(field)
            item["votes_known"] = previous.get("votes_known", False) or incoming.get("votes_known", False)
        catalog[item["id"]] = item
    return list(catalog.values())


def merge_sources(yuc, bangumi, supplemental=()):
    # Supplemental catalogues never append unrelated works to this season.
    candidates = metadata_catalog(bangumi, supplemental)
    rows, used = [], set()
    for item in yuc:
        match = best_match(item["aliases"], candidates)
        if match and match["id"] not in used:
            row = {**match, **item, "id": match["id"], "aliases": list(dict.fromkeys(item["aliases"] + match["aliases"]))}
            used.add(match["id"])
        else:
            row = dict(item)
        row["key"] = hashlib.sha256((row["kind"] + row["title"]).encode()).hexdigest()[:20]
        rows.append(row)
    for item in bangumi:
        if item["id"] not in used:
            complete = next(row for row in candidates if row["id"] == item["id"])
            rows.append({**complete, "key": f"bgm-{item['id']}"})
    for row in rows:
        if row["kind"] == "weekly" and not row.get("release") and row.get("air_date"):
            try:
                premiere = datetime.strptime(row["air_date"], "%Y-%m-%d")
                row["release"] = f"{premiere.month}/{premiere.day}~"
                row["release_source"] = "bangumi"
            except ValueError:
                pass
    return rows


class ScheduleService:
    TTL = 6 * 60 * 60
    SCHEMA_VERSION = 5

    def __init__(self, root: Path):
        self.root = root
        self.lock = threading.Lock()
        self.jobs = set()
        self.errors = {}
        self.attempts = {}

    @staticmethod
    def fetch(url, *, body=None):
        headers = {"User-Agent": "AnimeHandbook/1.0 (personal airing calendar)", "Accept": "application/json,text/html"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, headers=headers)
        with urllib.request.urlopen(request, timeout=15) as response:
            data = response.read(3 * 1024 * 1024 + 1)
            if len(data) > 3 * 1024 * 1024:
                raise ValueError("周表来源响应过大")
            return data

    def load(self, season):
        season_key(season)
        try:
            return json.loads((self.root / f"{season}.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def fetch_yuc(self, season):
        # The publisher also serves this public calendar on HTTP (its canonical
        # page URLs use HTTP). Use that endpoint only for an expired HTTPS
        # certificate; never change TLS verification or account request handling.
        season_key(season)
        try:
            return self.fetch(f"https://yuc.wiki/{season}/")
        except urllib.error.URLError as error:
            if isinstance(error.reason, ssl.SSLCertVerificationError) and error.reason.verify_code == 10:
                return self.fetch(f"http://yuc.wiki/{season}/")
            raise

    def get(self, season, *, refresh=False):
        season_key(season)
        data = self.load(season)
        with self.lock:
            stale = not data or data.get("schema_version") != self.SCHEMA_VERSION or time.time() - data.get("fetched_at", 0) > self.TTL
            cooldown = time.time() - self.attempts.get(season, 0) < 60
            if (refresh or stale) and season not in self.jobs and len(self.jobs) < 2 and not cooldown:
                self.jobs.add(season)
                self.attempts[season] = time.time()
                threading.Thread(target=self._refresh, args=(season,), daemon=True).start()
            return {**(data or {"season": season, "items": [], "fetched_at": 0}),
                    "loading": season in self.jobs, "error": self.errors.get(season, "")}

    def search_metadata(self, query):
        """Cache candidate data, not a hand-maintained title-to-ID override."""
        digest = hashlib.sha256(query.encode()).hexdigest()
        path = self.root / "lookups" / f"{digest}.json"
        try:
            cached = json.loads(path.read_text(encoding="utf-8"))
            ttl = self.TTL if cached["items"] else 3600
            if time.time() - cached["fetched_at"] < ttl:
                return cached["items"]
        except (OSError, ValueError, KeyError):
            cached = None
        try:
            data = json.loads(self.fetch("https://api.bgm.tv/v0/search/subjects?limit=8",
                body={"keyword": query, "filter": {"type": [2]}}))
            items = parse_bangumi({"1": [{"subject": row} for row in data.get("data", [])]})
        except Exception:
            if cached and cached.get("items"):
                return cached["items"]
            raise
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_name(f"{digest}-{threading.get_ident()}.tmp")
        temp.write_text(json.dumps({"items": items, "fetched_at": time.time()}, ensure_ascii=False), encoding="utf-8")
        temp.replace(path)
        return items

    def resolve_metadata(self, row):
        aliases = row.get("aliases", [row["title"]])
        originals = [name for name in aliases if re.search(r"[\u3040-\u30ff]", name)]
        queries = list(dict.fromkeys([*(sorted(originals, key=len, reverse=True)[:1]),
                                      max(aliases, key=len)]))
        for query in queries:
            candidates = self.search_metadata(query)
            match = best_match(aliases, candidates)
            if match:
                return match
        return None

    def _refresh(self, season):
        errors = []
        year, month = int(season[:4]), int(season[4:])
        end = f"{year + (month == 10)}-{(month + 2) % 12 + 1:02d}-01"
        source = f"https://yuc.wiki/{season}/"
        try:
            def yuc():
                parsed = parse_yuc(self.fetch_yuc(season).decode("utf-8"))
                if not parsed:
                    raise ValueError("页面暂未提供可识别的季度周表")
                return parsed

            def bgm():
                return parse_bangumi(json.loads(self.fetch(f"https://api.kazumi.fyi/kazumi/v1/calendar/season?start={year}-{month:02d}-01&end={end}")))

            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(yuc), pool.submit(bgm)]
                values = []
                for label, future in zip(["長門番堂", "Bangumi 季度数据"], futures):
                    try:
                        values.append(future.result())
                    except Exception:
                        values.append([])
                        errors.append(f"{label}暂不可用")
            old = self.load(season)
            # On partial outages preserve the known schedule instead of replacing it
            # with a degraded result. The warning makes stale data explicit.
            if errors and old:
                raise ValueError("；".join(errors) + "，继续显示上次缓存")
            supplemental = []
            missing = [row for row in values[0] if best_match(row["aliases"], values[1]) is None]
            if missing:
                def current_calendar():
                    now = datetime.now(BEIJING)
                    current = f"{now.year}{((now.month - 1) // 3) * 3 + 1:02d}"
                    if season != current:
                        return []
                    return parse_bangumi(json.loads(self.fetch("https://next.bgm.tv/p1/calendar")))

                def previous_catalog():
                    previous_year = year - (month == 1)
                    previous_month = month - 3 if month > 1 else 10
                    previous_key = f"{previous_year}{previous_month:02d}"
                    cached = self.load(previous_key)
                    if cached and cached.get("items"):
                        return [row for row in cached["items"] if row.get("id")]
                    # The previous page supplies localized/original-name aliases
                    # for continuing works absent from this season's introductions.
                    previous_end = f"{year}-{month:02d}-01"
                    with ThreadPoolExecutor(max_workers=2) as pool:
                        names = pool.submit(lambda: parse_yuc(self.fetch_yuc(previous_key).decode("utf-8")))
                        metadata = pool.submit(lambda: parse_bangumi(json.loads(self.fetch(
                            f"https://api.kazumi.fyi/kazumi/v1/calendar/season?start={previous_year}-{previous_month:02d}-01&end={previous_end}"))))
                        return [row for row in merge_sources(names.result(), metadata.result()) if row.get("id")]

                with ThreadPoolExecutor(max_workers=2) as pool:
                    jobs = [pool.submit(current_calendar), pool.submit(previous_catalog)]
                    for job in jobs:
                        try:
                            supplemental.extend(job.result())
                        except Exception:
                            errors.append("部分补充资料暂不可用")
            catalog = metadata_catalog(values[1], supplemental)
            unresolved = [row for row in values[0] if best_match(row["aliases"], catalog) is None]
            # Resolve remaining identities through the same pipeline for every
            # season. Small batches bound network concurrency; repeated service
            # failures stop this round instead of hammering the remote API.
            failures = 0
            with ThreadPoolExecutor(max_workers=2) as pool:
                for start in range(0, len(unresolved), 2):
                    if failures >= 3:
                        break
                    jobs = [pool.submit(self.resolve_metadata, row) for row in unresolved[start:start + 2]]
                    for job in jobs:
                        try:
                            match = job.result()
                            if match:
                                supplemental.append(match)
                        except Exception:
                            failures += 1
            if failures:
                errors.append("部分 Bangumi 条目暂时无法补全，将在下次更新时重试")
            items = merge_sources(*values, supplemental=supplemental)
            if not items:
                raise ValueError("该季度暂未取得周表数据，请稍后刷新或选择其他季度")
            data = {"season": season, "items": items, "fetched_at": time.time(), "schema_version": self.SCHEMA_VERSION,
                    "sources": [source, "https://api.kazumi.fyi"], "warnings": errors}
            self.root.mkdir(parents=True, exist_ok=True)
            temp = self.root / f"{season}.tmp"
            temp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            temp.replace(self.root / f"{season}.json")
            with self.lock:
                self.errors.pop(season, None)
        except Exception as error:
            with self.lock:
                self.errors[season] = str(error)
        finally:
            with self.lock:
                self.jobs.discard(season)

    def cover(self, season, key):
        data = self.load(season) or {}
        item = next((row for row in data.get("items", []) if row["key"] == key), None)
        if not item:
            raise ValueError("封面不存在")
        url = item.get("image_url", "")
        parsed = urlparse(url)
        if parsed.scheme not in {"https", "http"} or parsed.username is not None or parsed.port not in {None, 80, 443} or parsed.hostname not in {"i0.hdslb.com", "i1.hdslb.com", "i2.hdslb.com", "lain.bgm.tv", "api.bgm.tv"}:
            raise ValueError("封面来源不支持")
        url = "https://" + parsed.netloc + parsed.path + ("?" + parsed.query if parsed.query else "")
        digest = hashlib.sha256(url.encode()).hexdigest()
        folder = self.root / "covers"
        path = folder / (digest + ".img")
        meta = folder / (digest + ".json")
        if path.is_file() and meta.is_file():
            return path.read_bytes(), json.loads(meta.read_text())["mime"]
        urls = [url]
        mirror = "https://wsrv.nl/?url=" + quote(url, safe="")
        if parsed.hostname in {"lain.bgm.tv", "api.bgm.tv"}:
            urls.insert(0, mirror)
        else:
            urls.append(mirror)
        for address in urls:
            try:
                # Match the source page's referrerPolicy=no-referrer. Sending
                # yuc.wiki as Referer causes hdslb to reject otherwise valid covers.
                req = urllib.request.Request(address, headers={"User-Agent": "Mozilla/5.0 AnimeHandbook/1.0"})
                with urllib.request.urlopen(req, timeout=12) as response:
                    mime = response.headers.get_content_type()
                    body = response.read(8 * 1024 * 1024 + 1)
                    if mime not in {"image/jpeg", "image/png", "image/webp", "image/gif"} or not body or len(body) > 8 * 1024 * 1024:
                        raise ValueError("封面格式无效")
                    folder.mkdir(parents=True, exist_ok=True)
                    # Duplicate image requests may race; complete bodies are kept
                    # in memory and each writer uses its own temporary file.
                    temp = folder / f"{digest}-{threading.get_ident()}.tmp"
                    temp.write_bytes(body)
                    temp.replace(path)
                    temp_meta = folder / f"{digest}-{threading.get_ident()}.json.tmp"
                    temp_meta.write_text(json.dumps({"mime": mime}), encoding="utf-8")
                    temp_meta.replace(meta)
                    return body, mime
            except Exception:
                continue
        raise ValueError("封面暂不可用")


def attach_collection(document, local):
    """Apply current account state without writing public seasonal metadata into it."""
    by_id = {int(row["id"]): row for row in local}
    by_title = {}
    for row in local:
        for name in {row.get("name_cn", ""), row.get("name", "")} - {""}:
            by_title.setdefault(normalized_title(name), {})[row["id"]] = row
    items = []
    for row in document.get("items", []):
        match = by_id.get(row.get("id"))
        if not row.get("id") and not match:
            # Account matching runs on every GET: exact indexed aliases are fast
            # and avoid assigning the wrong local sequel on fuzzy title matches.
            exact = {}
            for name in row.get("aliases", [row["title"]]):
                exact.update(by_title.get(normalized_title(name), {}))
            match = next(iter(exact.values())) if len(exact) == 1 else None
        items.append({**row, "local_id": match["id"] if match else None,
                      "collection_type": int(match["collection_type"]) if match else 0,
                      "score": row.get("score") or (match or {}).get("bgm_score", 0),
                      "votes": row.get("votes") or (match or {}).get("bgm_rating_total", 0),
                      "votes_known": row.get("votes_known", False) or bool((match or {}).get("bgm_rating_total"))})
    return {**document, "items": items}
