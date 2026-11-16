"""Find and cache a landscape image when an anime's artwork header is opened."""

from __future__ import annotations

from http.client import HTTPException
from io import BytesIO
import json
import re
import threading
import time
import unicodedata
from uuid import uuid4
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from lxml import etree, html
from PIL import Image, ImageOps
from .common import DEFAULT_ARTWORK_MISS_HOURS


IMAGE_BYTES = 16 * 1024 * 1024
DOCUMENT_BYTES = 2 * 1024 * 1024
ERRORS = (OSError, HTTPException, ValueError, TypeError, KeyError, etree.LxmlError, Image.DecompressionBombError)
SEARCH_SLOTS = threading.BoundedSemaphore(3)
CACHE_LOCKS = tuple(threading.Lock() for _ in range(32))
CACHE_VERSION = "v2"
ARTWORK_RETRY_SECONDS = 6 * 3600
CROSSOVER_TAGS = {"crossover", "crossovers", "クロスオーバー", "跨作品"}
HOSTS = {
    "alphacoders.com", "wall.alphacoders.com", "wallhaven.cc", "w.wallhaven.cc",
    "api.anime-pictures.net", "opreviews.anime-pictures.net", "www.pixiv.net", "i.pximg.net",
}


def _allowed(url):
    target = urlsplit(url)
    host = target.hostname or ""
    return (
        target.scheme == "https" and not target.username and not target.password
        and target.port in (None, 443)
        and (host in HOSTS or re.fullmatch(r"images\d*\.alphacoders\.com", host))
    )


class ArtworkRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not _allowed(newurl):
            raise ValueError("Unsupported artwork redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class Lookup:
    def __init__(self):
        self.deadline = time.monotonic() + 18
        self.opener = build_opener(ArtworkRedirect())
        self.catalogue_available = False

    def read(self, url, *, referer="", image=False):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Artwork lookup deadline")
        if not _allowed(url):
            raise ValueError("Unsupported artwork URL")
        headers = {"User-Agent": "AnimeHandbook/1.0"}
        if referer:
            headers["Referer"] = referer
        limit = IMAGE_BYTES if image else DOCUMENT_BYTES
        with self.opener.open(Request(url, headers=headers), timeout=min(3, remaining)) as response:
            if image and response.headers.get_content_type() not in {"image/jpeg", "image/png", "image/webp", "image/avif"}:
                raise ValueError("Unsupported artwork image type")
            data = response.read(limit + 1)
            if not data or len(data) > limit:
                raise ValueError("Unsupported artwork size")
            return data, response.geturl()

    def json(self, url, *, referer=""):
        result = json.loads(self.read(url, referer=referer)[0])
        self.catalogue_available = True
        return result

    def page(self, url):
        raw, address = self.read(url)
        page = html.fromstring(raw)
        self.catalogue_available = True
        return page, address


def _key(value):
    return "".join(char for char in unicodedata.normalize("NFKC", value).casefold() if char.isalnum())


def _titles(anime, aliases):
    titles = []
    for title in (anime.get("name"), anime.get("name_cn"), *aliases):
        if not title or not _key(title):
            continue
        base = re.sub(r"\s*(?:第\s*[\d一二三四五六七八九十]+\s*[季期]|season\s+\d+|\d+(?:st|nd|rd|th)\s+season)\s*$", "", title, flags=re.I).rstrip(" :：-")
        titles.extend(value[:120] for value in (base, title) if value)
    return list(dict.fromkeys(titles))


def _landscape(width, height, *, preview=False):
    return width >= (600 if preview else 1280) and height >= (300 if preview else 700) and 1.55 <= width / height <= 2.02


def _dimensions(text):
    match = re.search(r"(\d{3,5})\s*[x×]\s*(\d{3,5})", text, re.I)
    return tuple(map(int, match.groups())) if match else (0, 0)


def _number(value):
    return int(str(value).strip().replace(",", "")) if re.fullmatch(r"[\d,]+", str(value).strip()) else 0


def _ordered(candidates):
    for _, url, referer in sorted(candidates, key=lambda row: row[0], reverse=True):
        if url:
            yield url, referer


def _alpha(lookup, titles):
    expected = {_key(title) for title in titles}
    names = list(dict.fromkeys([titles[0], *(title for title in titles if title.isascii()), *titles]))
    for title in names[:2]:
        query = urlencode({"q": title, "type": "wallpaper"})
        page, address = lookup.page(f"https://alphacoders.com/search/view?{query}")
        candidates = []
        for card in page.xpath('//*[contains(concat(" ", @class, " "), " thumb-container-wallpaper-desktop ")]'):
            tags = {_key(tag) for tag in card.xpath('.//a[contains(@class,"thumb-tag-masonry")]//text()')}
            # Search can redirect on a partial word. The gallery URL alone says nothing about a card.
            if not expected.intersection(tags) or tags & CROSSOVER_TAGS:
                continue
            info = " ".join(card.xpath('.//*[contains(@class,"thumb-info-masonry")]//text()'))
            if not _landscape(*_dimensions(info)):
                continue
            url = card.xpath('string(.//meta[@itemprop="contentUrl"]/@content)')
            votes = _number(card.xpath('string(.//span[contains(@class,"button-green")])'))
            candidates.append((votes, url, address))
        if candidates:
            yield from _ordered(candidates)
            return


def _wallhaven(lookup, titles):
    names = sorted(titles, key=lambda title: not title.isascii())
    expected = {_key(title) for title in titles}
    for title in names[:2]:
        query = urlencode({
            "q": title, "purity": "100", "categories": "010", "sorting": "favorites",
            "order": "desc", "atleast": "1280x720", "ratios": "16x9,16x10",
        })
        rows = lookup.json(f"https://wallhaven.cc/api/v1/search?{query}").get("data", [])
        for row in rows[:5]:
            if not _landscape(row["dimension_x"], row["dimension_y"]):
                continue
            wallpaper_id = row["id"]
            if not re.fullmatch(r"[a-z0-9]{6}", wallpaper_id):
                continue
            detail = lookup.json(f"https://wallhaven.cc/api/v1/w/{wallpaper_id}")["data"]
            tags = {_key(tag["name"]) for tag in detail.get("tags", [])}
            if detail.get("purity") == "sfw" and tags & expected and not tags & (CROSSOVER_TAGS | {"animescreenshot"}):
                yield detail["path"], ""


def _anime_picture_tag_matches(tag, expected):
    return tag.get("type") == 3 and any(
        _key(tag.get(field) or "") in expected for field in ("tag", "tag_jp", "tag_ru")
    )


def _anime_pictures(lookup, titles):
    sources = "https://api.anime-pictures.net/api/v3/posts"
    expected = {_key(title) for title in titles}
    names = sorted(titles, key=lambda title: not title.isascii())
    for title in names[:3]:
        query = urlencode({"lang": "en", "page": 0, "search_tag": title.lower(), "order_by": "rating"})
        try:
            data = lookup.json(f"{sources}?{query}")
        except OSError as error:
            if getattr(error, "code", None) == 400:
                continue
            raise
        tag = data.get("exclusive_tag") or {}
        if not _anime_picture_tag_matches(tag, expected):
            continue
        rows = [
            row for row in data.get("posts", []) if row.get("erotics") == 0
            and not row.get("spoiler") and _landscape(row["width"], row["height"])
        ]
        rows.sort(key=lambda row: (row["score"], row["score_number"], row["download_count"]), reverse=True)
        for row in rows[:5]:
            detail = lookup.json(f"{sources}/{int(row['id'])}")
            tags = [entry["tag"] for entry in detail.get("tags", []) if isinstance(entry.get("tag"), dict)]
            works = [entry for entry in tags if entry.get("type") == 3]
            if (not works or not all(_anime_picture_tag_matches(work, expected) for work in works)
                    or any(_key(entry.get("tag") or "") in CROSSOVER_TAGS for entry in tags)):
                continue
            yield detail["post"]["big_preview"], "https://anime-pictures.net/"
        if rows:
            return


def _pixiv(lookup, titles):
    titles = [unicodedata.normalize("NFKC", title) for title in titles]
    expected = {_key(title) for title in titles}
    terms = list(dict.fromkeys([titles[0], titles[0].rstrip("!"), *titles]))[:2]
    candidates = []
    seen = set()
    for title in terms:
        for page in (1, 2):
            query = urlencode({
                "word": title, "order": "date_d", "mode": "safe", "s_mode": "s_tag_full",
                "type": "illust", "p": page,
            })
            url = f"https://www.pixiv.net/ajax/search/artworks/{quote(title, safe='')}?{query}"
            try:
                rows = lookup.json(url, referer="https://www.pixiv.net/")["body"]["illustManga"]["data"]
            except ERRORS:
                break
            for row in rows:
                width, height = row.get("width", 0), row.get("height", 0)
                work_id = str(row.get("id") or "")
                if (row.get("xRestrict") != 0 or row.get("aiType") == 2 or row.get("illustType") != 0
                        or not _landscape(width, height) or width * height > 24_000_000
                        or not work_id.isdecimal() or work_id in seen):
                    continue
                seen.add(work_id)
                referer = f"https://www.pixiv.net/artworks/{work_id}"
                try:
                    detail = lookup.json(f"https://www.pixiv.net/ajax/illust/{work_id}", referer=referer)["body"]
                except ERRORS:
                    continue
                tags = {_key(tag.get("tag") or "") for tag in (detail.get("tags") or {}).get("tags", [])}
                if detail.get("xRestrict") == 0 and tags & expected and not tags & CROSSOVER_TAGS:
                    candidates.append((detail.get("bookmarkCount", 0), detail["urls"]["original"], referer))
                if len(candidates) >= 6:
                    break
            if len(candidates) >= 6:
                break
        if len(candidates) >= 6:
            break
    yield from _ordered(candidates)


PROVIDERS = (_alpha, _wallhaven, _anime_pictures, _pixiv)


def _image(lookup, url, referer):
    data, _ = lookup.read(url, referer=referer, image=True)
    with Image.open(BytesIO(data)) as image:
        if getattr(image, "is_animated", False) or image.width * image.height > 24_000_000:
            return None
        oriented = ImageOps.exif_transpose(image)
        preview = urlsplit(url).hostname == "opreviews.anime-pictures.net"
        if not _landscape(*oriented.size, preview=preview):
            return None
        oriented.thumbnail((1920, 1200), Image.Resampling.LANCZOS)
        output = BytesIO()
        oriented.convert("RGB").save(output, format="WEBP", quality=86)
        return output.getvalue()


class ArtworkCataloguesUnavailable(Exception):
    pass


def _find(titles):
    lookup = Lookup()
    for provider in PROVIDERS:
        try:
            for url, referer in provider(lookup, titles):
                try:
                    image = _image(lookup, url, referer)
                except ERRORS:
                    continue
                if image:
                    return image
        except ERRORS:
            continue
    if not lookup.catalogue_available:
        raise ArtworkCataloguesUnavailable
    return None


def get_artwork(root, anime, aliases=(), *, miss_hours=DEFAULT_ARTWORK_MISS_HOURS):
    anime_id = int(anime["id"])
    path = root / "detail-artwork" / CACHE_VERSION / f"{anime_id}.webp"
    retry = path.with_suffix(".retry")
    lock = CACHE_LOCKS[anime_id % len(CACHE_LOCKS)]
    with lock:
        previous = b""
        try:
            stat = path.stat()
            previous = path.read_bytes()
            ttl = (30 * 24 if previous else miss_hours) * 3600
            if (not previous and miss_hours == 0) or time.time() - stat.st_mtime < ttl:
                return previous or None
        except OSError:
            pass
        try:
            if time.time() - retry.stat().st_mtime < ARTWORK_RETRY_SECONDS:
                return previous or None
        except OSError:
            pass
        if not SEARCH_SLOTS.acquire(blocking=False):
            return previous or None
        try:
            titles = _titles(anime, aliases)
            temporary = path.with_suffix(f".{uuid4().hex}.tmp")
            try:
                result = (_find(titles) if titles else None) or previous
            except ArtworkCataloguesUnavailable:
                try:
                    retry.parent.mkdir(parents=True, exist_ok=True)
                    retry.touch()
                except OSError:
                    pass
                return previous or None
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                temporary.write_bytes(result)
                temporary.replace(path)
                retry.unlink(missing_ok=True)
            except OSError:
                pass
            finally:
                temporary.unlink(missing_ok=True)
            return result or None
        finally:
            SEARCH_SLOTS.release()
