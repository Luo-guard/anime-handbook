from __future__ import annotations

from typing import Any
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import as_completed
from datetime import date
from datetime import datetime
import json
import os
import re
import subprocess
import threading
import time
from datetime import timedelta
import urllib.request
from .common import (APP_ROOT, aired_main_episode_count, json_dumps, normalize_episodes, now_iso)
from .database import HandbookDB

class SyncService:
    def __init__(self, database: HandbookDB) -> None:
        self.database = database
        self.cover_root = database.asset_root / "covers"
        self.character_cover_root = database.asset_root / "character-covers"
        self._lock = threading.Lock()
        self._episode_request_lock = threading.Lock()
        self._episode_last_request = 0.0
        self.status: dict[str, Any] = {
            "running": False,
            "phase": "idle",
            "message": "尚未同步",
            "last_success_at": None,
            "last_error": None,
            "kazumi_path": None,
            "enriched": 0,
            "pending": 0,
        }

    @staticmethod
    def _is_in_release_window(air_date_value: Any) -> bool:
        """Whether an anime is recent enough to warrant daily airing checks."""
        try:
            started = date.fromisoformat(str(air_date_value or "")[:10])
        except ValueError:
            return False
        today = datetime.now().astimezone().date()
        # Covers normal seasonal shows and longer-running series while avoiding
        # an episode request for every old completed title on every sync.
        return started <= today and today - started <= timedelta(days=730)

    @staticmethod
    def _release_count_is_current(item: dict[str, Any]) -> bool:
        synced = str(item.get("episode_release_synced_at") or "")[:10]
        today = datetime.now().astimezone().date().isoformat()
        return synced == today

    def _should_track_release_count(self, item: dict[str, Any], air_date_value: Any) -> bool:
        # Only the active "watching" collection needs a daily episode-release
        # check.  Every other collection is enriched when first imported, then
        # left alone during routine startup syncs.
        return int(item.get("collection_type") or 0) == 1

    @staticmethod
    def find_kazumi_database() -> Path | None:
        explicit = os.environ.get("KAZUMI_DB_PATH")
        if explicit and Path(explicit).is_file():
            return Path(explicit)
        local = Path(os.environ.get("LOCALAPPDATA", ""))
        candidates: list[Path] = []
        packages = local / "Packages"
        if packages.is_dir():
            candidates.extend(
                packages.glob(
                    "com.flutter.kazumi*/LocalCache/Roaming/"
                    "com.example/kazumi/hive/collectibles.hive"
                )
            )
        roaming = Path(os.environ.get("APPDATA", ""))
        candidates.extend(
            [
                roaming / "com.example" / "kazumi" / "hive" /
                "collectibles.hive",
                local / "com.example" / "kazumi" / "hive" /
                "collectibles.hive",
            ]
        )
        existing = [path for path in candidates if path.is_file()]
        return max(existing, key=lambda item: item.stat().st_mtime) if existing else None

    @staticmethod
    def reader_path() -> Path:
        executable = APP_ROOT / "tools" / "kazumi_reader.exe"
        if executable.is_file():
            return executable
        return APP_ROOT / "tools" / "kazumi_reader" / "kazumi_reader.exe"

    def sync(self, *, enrich_all: bool = False) -> dict[str, Any]:
        if not self._lock.acquire(blocking=False):
            return {"ok": False, "message": "同步正在进行"}
        self.status.update(
            running=True,
            phase="kazumi",
            message="正在读取 Kazumi 收藏…",
            last_error=None,
            enriched=0,
        )
        try:
            source = self.find_kazumi_database()
            self.status["kazumi_path"] = str(source) if source else None
            if not source:
                raise RuntimeError("未找到 Kazumi 的 collectibles.hive")
            reader = self.reader_path()
            if not reader.is_file():
                raise RuntimeError("Kazumi 只读解析器尚未构建")
            result = subprocess.run(
                [str(reader), str(source)],
                capture_output=True,
                timeout=30,
                check=False,
            )
            if result.returncode != 0:
                detail = result.stderr.decode("utf-8", errors="replace").strip()
                if "used by another process" in detail or "访问" in detail:
                    detail = "Kazumi 正在使用收藏数据库；关闭 Kazumi 后再同步"
                raise RuntimeError(detail or "读取 Kazumi 收藏失败")
            items = json.loads(result.stdout.decode("utf-8"))
            imported = self.database.import_kazumi(items)
            self.status.update(
                phase="bgm",
                message=f"已读取 {len(items)} 部收藏，正在补全章节、评分与排名…",
            )
            enriched = self.enrich_missing(refresh_all=enrich_all)
            completed = self.database.complete_kazumi_watching_transitions()
            self.status.update(
                running=False,
                phase="idle",
                message=(
                    f"同步完成：{len(items)} 部收藏，更新 {enriched} 部 Bangumi 信息"
                    + (f"，补记 {completed['recorded_episodes']} 集" if completed["recorded_episodes"] else "")
                ),
                last_success_at=now_iso(),
                last_error=None,
                enriched=enriched,
                pending=0,
            )
            return {"ok": True, "imported": imported, "enriched": enriched}
        except Exception as error:
            message = str(error)
            self.status.update(
                running=False,
                phase="error",
                message=message,
                last_error=message,
            )
            return {"ok": False, "message": message}
        finally:
            self._lock.release()

    def start_background(self, *, enrich_all: bool = False) -> bool:
        if self.status.get("running"):
            return False
        thread = threading.Thread(
            target=self.sync,
            kwargs={"enrich_all": enrich_all},
            name="anime-handbook-sync",
            daemon=True,
        )
        thread.start()
        return True

    def enrich_missing(self, *, refresh_all: bool = False) -> int:
        candidates = self.database.list_anime()
        fetch_episode_titles = bool(
            self.database.get_settings().get("show_episode_titles_on_hover")
        )
        if not refresh_all:
            candidates = [
                item
                for item in candidates
                if item["episode_count"] is None
                or (fetch_episode_titles and not item.get("episode_titles_synced"))
                or int(item.get("bgm_rating_version") or 0) < 2
                or (
                    self._should_track_release_count(item, item.get("air_date"))
                    and not self._release_count_is_current(item)
                )
            ]
        self.status["pending"] = len(candidates)
        if not candidates:
            return 0
        enriched = 0
        with ThreadPoolExecutor(max_workers=6) as executor:
            futures = {
                executor.submit(self.fetch_bgm_bundle, int(item["id"]), item): item
                for item in candidates
            }
            for future in as_completed(futures):
                try:
                    metadata = future.result()
                    self.database.update_bgm_metadata(
                        int(metadata["id"]),
                        episode_count=int(
                            metadata.get("total_episodes")
                            or metadata.get("eps")
                            or 0
                        ),
                        # None means this refresh did not request an episode
                        # list. Passing [] here used to replace cached Bangumi
                        # keys with generated 0:1, 0:2… keys, which made old
                        # watch records impossible to match.
                        episodes=metadata.get("_episodes"),
                        image_url=str(
                            (metadata.get("images") or {}).get("large") or ""
                        ),
                        name=str(metadata.get("name") or ""),
                        name_cn=str(metadata.get("name_cn") or ""),
                        summary=str(metadata.get("summary") or ""),
                        air_date=str(metadata.get("date") or ""),
                        rating_score=metadata.get("_rating_score"),
                        rating_rank=metadata.get("_rating_rank"),
                        rating_total=metadata.get("_rating_total"),
                        rating_synced=True,
                        episode_titles_synced=bool(
                            metadata.get("_episode_titles_synced")
                        ),
                        aired_episode_count=metadata.get("_aired_episode_count"),
                        episode_release_synced=bool(
                            metadata.get("_episode_release_synced")
                        ),
                    )
                    enriched += 1
                    self.status["enriched"] = enriched
                    self.status["pending"] = len(candidates) - enriched
                except Exception:
                    # One unavailable subject must not abort the remaining sync.
                    continue
        return enriched

    def fetch_bgm(self, anime_id: int) -> dict[str, Any]:
        base = str(self.database.get_settings()["bgm_api_base"]).rstrip("/")
        request = urllib.request.Request(
            f"{base}/v0/subjects/{anime_id}",
            headers={
                "User-Agent": "AnimeHandbook/1.0 "
                "(local personal collection manager)",
                "Accept": "application/json",
            },
        )
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.loads(response.read().decode("utf-8"))

    def _wait_for_episode_request_slot(self) -> None:
        with self._episode_request_lock:
            remaining = 0.65 - (time.monotonic() - self._episode_last_request)
            if remaining > 0:
                time.sleep(remaining)
            self._episode_last_request = time.monotonic()

    def _bgm_api_bases(self) -> list[str]:
        """Return the selected API endpoint followed by a safe official fallback.

        Custom mirrors are useful for browsing, but some of them do not expose
        the complete v0 character API.  Character data is optional metadata, so
        falling back to the official API is preferable to making the whole tab
        unusable when a mirror is incomplete or temporarily unavailable.
        """
        configured = str(self.database.get_settings().get("bgm_api_base") or "").rstrip("/")
        candidates = [configured, "https://api.bgm.tv"]
        return list(dict.fromkeys(item for item in candidates if item))

    def _fetch_bgm_json(self, url: str, *, timeout: int = 20, attempts: int = 3) -> Any:
        """Fetch a small Bangumi JSON resource with bounded retry/backoff."""
        last_error: Exception | None = None
        for attempt in range(attempts):
            request = urllib.request.Request(
                url,
                headers={
                    "User-Agent": "AnimeHandbook/1.0 (local personal collection manager)",
                    "Accept": "application/json",
                },
            )
            self._wait_for_episode_request_slot()
            try:
                with urllib.request.urlopen(request, timeout=timeout) as response:
                    return json.loads(response.read().decode("utf-8"))
            except urllib.error.HTTPError as error:
                last_error = error
                # 404 means this mirror simply does not provide the endpoint;
                # let the caller immediately try the next API base.
                if error.code == 404:
                    break
                if error.code not in {429, 500, 502, 503, 504} or attempt == attempts - 1:
                    break
                retry_after = error.headers.get("Retry-After", "")
                try:
                    delay = min(12.0, max(1.0, float(retry_after)))
                except ValueError:
                    delay = min(12.0, 1.2 * (2**attempt))
                time.sleep(delay)
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
                last_error = error
                if attempt == attempts - 1:
                    break
                time.sleep(min(8.0, 1.0 * (2**attempt)))
        if last_error:
            raise last_error
        raise RuntimeError("Bangumi request failed")

    def _fetch_bgm_text(self, url: str, *, timeout: int = 20, attempts: int = 3) -> str:
        """Fetch a Bangumi HTML page using the same modest retry policy.

        The public v0 API deliberately makes no promise about the visual
        order of subject credits.  The subject's character page is therefore
        the authoritative source for the order presented to the user.
        """
        last_error: Exception | None = None
        for attempt in range(attempts):
            request = urllib.request.Request(
                url,
                headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 Chrome/124 Safari/537.36",
                    "Accept": "text/html,application/xhtml+xml",
                },
            )
            self._wait_for_episode_request_slot()
            try:
                with urllib.request.urlopen(request, timeout=timeout) as response:
                    return response.read().decode("utf-8", "replace")
            except urllib.error.HTTPError as error:
                last_error = error
                if error.code == 404 or error.code not in {429, 500, 502, 503, 504} or attempt == attempts - 1:
                    break
                time.sleep(min(12.0, 1.2 * (2**attempt)))
            except (urllib.error.URLError, TimeoutError, OSError) as error:
                last_error = error
                if attempt == attempts - 1:
                    break
                time.sleep(min(8.0, 1.0 * (2**attempt)))
        if last_error:
            raise last_error
        raise RuntimeError("Bangumi page request failed")

    def _bgm_site_bases(self) -> list[str]:
        configured = str(self.database.get_settings().get("bgm_site_base") or "").rstrip("/")
        return list(dict.fromkeys(item for item in (configured, "https://bgm.tv") if item))

    def _subject_character_page_order(self, anime_id: int) -> list[int]:
        """Read the visual character order from Bangumi's subject page.

        The page repeats a character ID in its card, so retain the first
        occurrence only.  If a mirror/page is unavailable, callers can still
        safely keep the API order instead of losing all character data.
        """
        for base in self._bgm_site_bases():
            try:
                html = self._fetch_bgm_text(f"{base}/subject/{anime_id}/characters")
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
                continue
            ids: list[int] = []
            seen: set[int] = set()
            for value in re.findall(r'href=["\'](?:https?://[^"\']+)?/character/(\d+)["\']', html):
                character_id = int(value)
                if character_id not in seen:
                    seen.add(character_id)
                    ids.append(character_id)
            if ids:
                return ids
        return []

    def fetch_bgm_episodes(self, anime_id: int) -> list[dict[str, Any]]:
        base = str(self.database.get_settings()["bgm_api_base"]).rstrip("/")
        offset = 0
        limit = 100
        episodes: list[dict[str, Any]] = []
        while True:
            request = urllib.request.Request(
                f"{base}/v0/episodes?subject_id={anime_id}"
                f"&limit={limit}&offset={offset}",
                headers={
                    "User-Agent": "AnimeHandbook/1.0 "
                    "(local personal collection manager)",
                    "Accept": "application/json",
                },
            )
            payload: dict[str, Any] | None = None
            for attempt in range(4):
                self._wait_for_episode_request_slot()
                try:
                    with urllib.request.urlopen(request, timeout=20) as response:
                        payload = json.loads(response.read().decode("utf-8"))
                    break
                except urllib.error.HTTPError as error:
                    if error.code != 429 or attempt == 3:
                        raise
                    retry_after = error.headers.get("Retry-After", "")
                    try:
                        delay = min(20.0, max(1.0, float(retry_after)))
                    except ValueError:
                        delay = min(20.0, 1.5 * (2**attempt))
                    time.sleep(delay)
            if payload is None:
                raise RuntimeError("章节数据暂不可用")
            batch = payload.get("data") or []
            if not isinstance(batch, list):
                break
            episodes.extend(item for item in batch if isinstance(item, dict))
            total = int(payload.get("total") or len(episodes))
            offset += len(batch)
            if not batch or offset >= total:
                break
        return episodes

    def fetch_bgm_characters(self, anime_id: int) -> list[dict[str, Any]]:
        """Fetch a subject's character credits on demand and keep the request light."""
        payload: Any | None = None
        active_base = ""
        errors: list[str] = []
        for base in self._bgm_api_bases():
            try:
                payload = self._fetch_bgm_json(
                    f"{base}/v0/subjects/{anime_id}/characters", timeout=20
                )
                active_base = base
                break
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as error:
                errors.append(f"{base}: {error}")
        if payload is None:
            detail = "; ".join(errors) or "no compatible Bangumi API"
            raise RuntimeError(f"人物资料请求失败（{detail}）")
        raw_items = payload.get("data") if isinstance(payload, dict) else payload
        def character_profile(raw: dict[str, Any]) -> dict[str, Any]:
            images = raw.get("images") if isinstance(raw.get("images"), dict) else {}
            image_url = str(images.get("large") or images.get("medium") or images.get("grid") or "")
            actors = raw.get("actors") if isinstance(raw.get("actors"), list) else []
            cv_names = [str(actor.get("name") or "").strip() for actor in actors if isinstance(actor, dict) and str(actor.get("name") or "").strip()]
            name_cn = str(raw.get("name_cn") or "").strip()
            # Subject credits contain the Japanese name but usually omit the
            # Chinese alias. Resolve the small character profile on demand;
            # failures are intentionally non-fatal for the remaining cast.
            try:
                detail = self._fetch_bgm_json(
                    f"{active_base}/v0/characters/{int(raw['id'])}", timeout=12, attempts=2
                )
                for field in (detail.get("infobox") if isinstance(detail, dict) else []) or []:
                    if isinstance(field, dict) and str(field.get("key") or "") in {"简体中文名", "中文名"}:
                        name_cn = str(field.get("value") or "").strip()
                        break
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError):
                pass
            return {
                "character_id": int(raw["id"]),
                "name": str(raw.get("name") or ""),
                "name_cn": name_cn or str(raw.get("name") or ""),
                "image_url": image_url,
                "cv_names": list(dict.fromkeys(cv_names)),
            }

        credits = [raw for raw in raw_items if isinstance(raw, dict) and raw.get("id")] if isinstance(raw_items, list) else []
        # Keep concurrency bounded; map preserves API credit order on page failure.
        with ThreadPoolExecutor(max_workers=4) as executor:
            order_request = executor.submit(self._subject_character_page_order, anime_id)
            result = list(executor.map(character_profile, credits))
            page_order = order_request.result()
        # API credit order differs from the order on the public character
        # page (and can change between API versions).  Reorder the cached
        # records by the page order so our grid exactly follows bgm.tv.
        if page_order:
            positions = {character_id: position for position, character_id in enumerate(page_order)}
            result.sort(key=lambda item: (positions.get(int(item["character_id"]), len(positions)), int(item["character_id"])))
        return result

    def enrich_characters(self, anime_id: int) -> list[dict[str, Any]]:
        return self.database.replace_anime_characters(
            anime_id, self.fetch_bgm_characters(anime_id)
        )

    def fetch_bgm_bundle(
        self, anime_id: int, existing: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        metadata = self.fetch_bgm(anime_id)
        rating = metadata.get("rating") or {}
        metadata["_rating_score"] = rating.get("score")
        metadata["_rating_rank"] = rating.get("rank")
        metadata["_rating_total"] = rating.get("total")
        fetch_titles = bool(
            self.database.get_settings().get("show_episode_titles_on_hover")
        )
        should_refresh_release = (
            self._should_track_release_count(existing or {}, metadata.get("date"))
            and not self._release_count_is_current(existing or {})
        )
        if fetch_titles or should_refresh_release:
            try:
                synced_episodes = normalize_episodes(self.fetch_bgm_episodes(anime_id))
                # The episode request is already needed to calculate the aired
                # count. Keep that structural list too, so OP/ED groups remain
                # intact even when hover titles themselves stay disabled.
                metadata["_episodes"] = (
                    synced_episodes if fetch_titles or should_refresh_release else None
                )
                metadata["_episode_titles_synced"] = fetch_titles
                if should_refresh_release:
                    metadata["_aired_episode_count"] = aired_main_episode_count(
                        synced_episodes
                    )
                    metadata["_episode_release_synced"] = True
            except Exception:
                metadata["_episodes"] = None
                metadata["_episode_titles_synced"] = False
                metadata["_episode_release_synced"] = False
        else:
            metadata["_episodes"] = None
            metadata["_episode_titles_synced"] = False
            metadata["_episode_release_synced"] = False
        return metadata

    def enrich_episode_titles(self, anime_id: int) -> dict[str, Any]:
        anime = self.database.get_anime(anime_id)
        if not anime:
            raise KeyError("动漫不存在")
        if anime.get("episode_titles_synced"):
            return anime
        episodes = normalize_episodes(self.fetch_bgm_episodes(anime_id))
        self.database.update_bgm_metadata(
            anime_id,
            episode_count=max(int(anime.get("episode_count") or 0), len(episodes)),
            episodes=episodes,
            episode_titles_synced=True,
        )
        return self.database.get_anime(anime_id) or anime

    def restore_today_episode_groups(self) -> int:
        """Repair episode lists affected by an older airing-progress refresh.

        Before the preservation rule above existed, a refresh could replace an
        OP/ED-aware cached list with generated regular episodes. Only titles
        refreshed today can have been affected, so this is deliberately narrow
        and safe to run once during the upgrade.
        """
        today = datetime.now().astimezone().date().isoformat()
        candidates = [
            item
            for item in self.database.list_anime()
            if str(item.get("episode_release_synced_at") or "").startswith(today)
            and not item.get("episode_titles_synced")
        ]
        restored = 0
        restored_ids: list[int] = []
        for item in candidates:
            try:
                episodes = normalize_episodes(self.fetch_bgm_episodes(int(item["id"])))
                if not episodes:
                    continue
                self.database.update_bgm_metadata(
                    int(item["id"]),
                    episode_count=max(int(item.get("episode_count") or 0), len(episodes)),
                    episodes=episodes,
                    aired_episode_count=aired_main_episode_count(episodes),
                    episode_release_synced=True,
                )
                restored += 1
                restored_ids.append(int(item["id"]))
            except Exception:
                # Keep repairing the remaining collection if one subject is unavailable.
                continue
        self.database.recover_progress_from_watch_events(restored_ids)
        return restored

    def repair_legacy_watch_episode_keys(self) -> int:
        """Restore exact episode keys only for rows affected by the old refresh bug."""
        repaired_ids: list[int] = []
        for anime_id in self.database.legacy_bgm_watch_event_anime_ids():
            try:
                anime = self.database.get_anime(anime_id) or {}
                episodes = normalize_episodes(self.fetch_bgm_episodes(anime_id))
                if not episodes:
                    continue
                self.database.update_bgm_metadata(
                    anime_id,
                    episode_count=max(int(anime.get("episode_count") or 0), len(episodes)),
                    episodes=episodes,
                )
                repaired_ids.append(anime_id)
                # Repair requests are rare; space them out if an old database
                # contains more than one affected record.
                time.sleep(0.2)
            except Exception:
                continue
        return self.database.recover_progress_from_watch_events(repaired_ids)

    def cover(self, anime_id: int) -> tuple[bytes, str] | None:
        anime = self.database.get_anime(anime_id)
        if not anime:
            return None
        cached = self.cover_root / f"{anime_id}.img"
        meta = self.cover_root / f"{anime_id}.json"
        if cached.is_file():
            mime = "image/jpeg"
            if meta.is_file():
                try:
                    mime = json.loads(meta.read_text("utf-8")).get(
                        "content_type", mime
                    )
                except (OSError, json.JSONDecodeError):
                    pass
            return cached.read_bytes(), mime
        url = str(anime.get("image_url") or "")
        if not url:
            return None
        try:
            request = urllib.request.Request(
                url, headers={"User-Agent": "AnimeHandbook/1.0"}
            )
            with urllib.request.urlopen(request, timeout=15) as response:
                data = response.read()
                mime = response.headers.get_content_type()
            if data:
                cached.write_bytes(data)
                meta.write_text(
                    json_dumps({"content_type": mime, "source": url}),
                    encoding="utf-8",
                )
                return data, mime
        except (OSError, urllib.error.URLError):
            return None
        return None

    def character_cover(self, anime_id: int, character_id: int) -> tuple[bytes, str] | None:
        """Serve character portraits through a local cache, like anime covers."""
        characters = self.database.list_anime_characters(anime_id)
        character = next(
            (item for item in characters if int(item["character_id"]) == character_id),
            None,
        )
        if not character:
            return None
        cached = self.character_cover_root / f"{anime_id}-{character_id}.img"
        meta = self.character_cover_root / f"{anime_id}-{character_id}.json"
        if cached.is_file():
            mime = "image/jpeg"
            if meta.is_file():
                try:
                    mime = json.loads(meta.read_text("utf-8")).get("content_type", mime)
                except (OSError, json.JSONDecodeError):
                    pass
            return cached.read_bytes(), mime
        url = str(character.get("image_url") or "")
        if not url:
            return None
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "AnimeHandbook/1.0"})
            with urllib.request.urlopen(request, timeout=15) as response:
                data = response.read()
                mime = response.headers.get_content_type()
            if data:
                cached.write_bytes(data)
                meta.write_text(json_dumps({"content_type": mime, "source": url}), encoding="utf-8")
                return data, mime
        except (OSError, urllib.error.URLError):
            return None
        return None


