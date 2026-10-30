from __future__ import annotations

from typing import Any
from urllib.parse import quote
import re
from html import unescape
import urllib.request
from .database import HandbookDB
from .metadata import SyncService

class AgeRelatedService:
    BASE_URL = "https://www.agedm.io"
    _SYMBOLS = r"[！!？?:：～~・…—－\-—/／|｜（）()\[\]【】「」『』]"

    def __init__(self, database: HandbookDB, sync: SyncService) -> None:
        self.database = database
        self.sync = sync

    @staticmethod
    def _text(value: str) -> str:
        return re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", "", value))).strip()

    @classmethod
    def search_term(cls, title: str) -> str:
        title = title.strip()
        match = re.search(cls._SYMBOLS, title)
        if not match:
            return title
        before = title[: match.start()].strip()
        if before:
            return before
        remainder = title[match.end() :]
        next_symbol = re.search(cls._SYMBOLS, remainder)
        return (remainder[: next_symbol.start()] if next_symbol else remainder).strip()

    def fetch_html(self, url: str) -> str:
        request = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (AnimeHandbook local related lookup)",
                "Accept": "text/html,application/xhtml+xml",
            },
        )
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.read().decode("utf-8", errors="replace")

    @staticmethod
    def _field(card: str, label: str) -> str:
        match = re.search(
            rf'<div class="video_detail_info[^>]*">\s*<span>{re.escape(label)}</span>(.*?)</div>',
            card,
            re.S,
        )
        return AgeRelatedService._text(match.group(1)) if match else ""

    def parse_search(self, page: str) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        for card in page.split('<div class="card cata_video_item py-4">')[1:]:
            detail = re.search(r"/detail/(\d+)", card)
            title = re.search(r'<h5 class="card-title">\s*<a[^>]*>(.*?)</a>', card, re.S)
            if not detail or not title:
                continue
            image = re.search(r'data-original="([^"]+)"', card)
            if not image:
                image = re.search(r'<img[^>]+src="([^"]+)"', card)
            status = re.search(r'class="video_play_status[^>]*">(.*?)</span>', card, re.S)
            episode_text = self._text(status.group(1)) if status else ""
            count_match = re.search(r"(?:第|01-)(\d+)集?", episode_text)
            items.append(
                {
                    "age_id": detail.group(1),
                    "title": self._text(title.group(1)),
                    "cover_url": unescape(image.group(1)) if image else "",
                    "air_date": self._field(card, "首播时间："),
                    "episode_text": episode_text,
                    "episode_count": int(count_match.group(1)) if count_match else None,
                    "age_url": f"{self.BASE_URL}/detail/{detail.group(1)}",
                    "original_name": self._field(card, "原版名称："),
                }
            )
        seen: set[str] = set()
        unique_items = [
            item for item in items if not (item["age_id"] in seen or seen.add(item["age_id"]))
        ]
        return sorted(
            unique_items,
            key=lambda item: (
                not bool(item.get("air_date")),
                str(item.get("air_date") or "9999-12-31"),
                str(item.get("title") or ""),
            ),
        )

    def fetch_related(self, anime_id: int) -> dict[str, Any]:
        cached = self.database.get_age_related_cache(anime_id)
        if cached:
            return cached
        anime = self.database.get_anime(anime_id)
        if not anime:
            raise KeyError("动漫不存在")
        metadata = self.sync.fetch_bgm(anime_id)
        japanese_name = str(metadata.get("name") or anime.get("name") or "")
        term = self.search_term(japanese_name)
        if not term:
            raise ValueError("未找到可用于 AGE 搜索的日文名")
        items = self.parse_search(
            self.fetch_html(f"{self.BASE_URL}/search?query={quote(term)}")
        )
        if not items and term != japanese_name:
            items = self.parse_search(
                self.fetch_html(f"{self.BASE_URL}/search?query={quote(japanese_name)}")
            )
        if not items:
            raise ValueError("AGE 未找到相关番剧")
        first = items[0]
        return self.database.save_age_related_cache(
            anime_id,
            search_term=term,
            source_title=first["title"],
            source_url=first["age_url"],
            items=items,
        )


