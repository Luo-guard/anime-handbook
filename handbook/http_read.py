"""Read route controller; transport and errors live on RequestHandler."""
from __future__ import annotations
from .http_context import (HTTPStatus, Path, ScheduleService, VideoLinks, attach_collection, find_background_asset, json, mimetypes, parse_qs, re, safe_asset_id, season_key, send_asset, urlparse)
from .common import MAX_DETAIL_LINKS
from .link_rules import cache_path, load_cache, payload as rules_payload
from urllib.parse import quote, unquote

from . import media as media_tools
from . import offline_config
from .offline import OfflineStore
from .offline_service import OfflineError, OfflineService


class ReadRoutes:
    def _serve_local_file(self, target: Path, content_type: str) -> None:
        """带 Range 的本地文件流。

        ``<video>`` 能拖进度条全靠 Range；整文件一次性吐出去的话，跳到第 12 分钟
        等于从头再下一遍。
        """
        if not target.is_file():
            self.send_error_json(404, "本地文件不在了，可能被移动或删除")
            return
        total = target.stat().st_size
        start, end, partial = 0, total - 1, False
        header = str(self.headers.get("Range") or "").strip()
        if header.startswith("bytes="):
            spec = header[6:].split(",")[0].strip()
            left, _, right = spec.partition("-")
            try:
                if left:
                    start = int(left)
                    if right:
                        end = min(int(right), total - 1)
                elif right:
                    start = max(0, total - int(right))
            except ValueError:
                start, end = 0, total - 1
            else:
                partial = True
            if start >= total or start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{total}")
                self.end_headers()
                return
        length = max(0, end - start + 1)
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", content_type)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{total}")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            with target.open("rb") as handle:
                handle.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = handle.read(min(256 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            # 用户拖动进度条会主动断开旧请求，属于正常现象。
            pass

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        try:
            if path == "/api/background":
                profile_id = safe_asset_id(query.get("profile", [""])[0], "default")
                account_id = safe_asset_id(query.get("account", [""])[0], "local")
                image = find_background_asset(account_id, profile_id, root=self.background_root) if profile_id else None
                image = image or next(iter(self.background_root.glob("background.*")), None)
                if not image:
                    self.send_error(HTTPStatus.NOT_FOUND)
                    return
                body = image.read_bytes()
                # The URL carries ?v=<version> whenever the image changes, so a
                # versioned request can be cached for good.  Older callers keep
                # revalidating, but ETag makes that a 304 instead of megabytes.
                etag = f'"{int(image.stat().st_mtime)}-{len(body)}"'
                if self.headers.get("If-None-Match") == etag:
                    self.send_response(HTTPStatus.NOT_MODIFIED)
                    self.send_header("ETag", etag)
                    self.end_headers()
                    return
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", mimetypes.guess_type(image.name)[0] or "image/jpeg")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("ETag", etag)
                self.send_header(
                    "Cache-Control",
                    "private, max-age=31536000, immutable" if query.get("v") else "no-cache",
                )
                self.end_headers()
                self.wfile.write(body)
            elif path == "/api/health":
                self.send_json({"ok": True, "features": {"schedule_sorting": 2, "keyboard_shortcuts": 1, "deferred_theme_background": 1}})
            elif path == "/api/bootstrap":
                self.send_json(
                    {
                        "profiles": self.profiles.list_profiles(),
                        "active_profile": self.profiles.profile(),
                        "sharing": self.sharing.status(),
                        "webdav": self.webdav.status(),
                        "animes": self._with_progress(self.database.list_anime()),
                        "custom_collections": self.database.list_custom_collections(),
                        "ranking_boards": self.database.list_ranking_boards(),
                        "ranking_templates": self.database.list_ranking_templates(),
                        "settings": self.database.get_settings(),
                        "stats": self.database.stats(),
                        "sync": self.sync.status,
                        "revision": self.database.revision,
                    }
                )
            elif path == "/api/schedule":
                season = season_key(query.get("season", [""])[0])
                source = query.get("source", ["yuc"])[0]
                if source == "as":
                    document = self.as_calendar.get(season, week=query.get("week", [""])[0], refresh=query.get("refresh", [""])[0] == "true")
                    cached = self.schedule.load(season) or {}
                    metadata = {row["id"]: row for row in cached.get("items", []) if row.get("id")}
                    # Enrich only by a verified Bangumi ID; never blend list membership.
                    document = {**document, "items": [{**row, **{key: metadata.get(row.get("id"), {}).get(key, row.get(key)) for key in ("score", "votes", "votes_known", "summary")}} for row in document["items"]]}
                else:
                    document = self.schedule.for_source(source).get(season, refresh=query.get("refresh", [""])[0] == "true")
                if source == "yuc":
                    document = {**document, "items": [row for row in document["items"] if not row["key"].startswith("bgm-")]}
                with self.database.connect() as db:
                    local = [dict(row) for row in db.execute(
                        "SELECT id,name,name_cn,collection_type,bgm_score,bgm_rating_total FROM anime WHERE active=1"
                    )]
                document = attach_collection(document, local)
                if self.database.get_settings().get("schedule_airing_source") == "as":
                    progress = self.animeschedule.get_many([row.get("id") or row.get("local_id") for row in document["items"]])
                    for row in document["items"]:
                        value = progress.get(str(row.get("id") or row.get("local_id")))
                        row["as_airing"] = value if value and not value.get("unavailable") else row.get("as_airing") or value
                self.send_json(document)
            elif path == "/api/schedule/cover":
                if query.get("source", ["yuc"])[0] == "as":
                    body, mime = self.as_calendar.cover(query.get("week", [""])[0], query.get("key", [""])[0])
                else:
                    body, mime = self.schedule.for_source(query.get("source", ["yuc"])[0]).cover(season_key(query.get("season", [""])[0]), query.get("key", [""])[0])
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "public, max-age=86400")
                self.end_headers()
                self.wfile.write(body)
            elif path == "/api/profiles":
                self.send_json({"profiles": self.profiles.list_profiles(), "active_profile": self.profiles.profile()})
            elif path == "/api/sharing":
                self.send_json({
                    "sharing": self.sharing.status(),
                    "available_profiles": self.sharing.available_profiles(),
                    "device_requests": self.sharing.device_requests(),
                })
            elif path == "/api/webdav":
                self.send_json({"webdav": self.webdav.status()})
            elif path == "/api/link-rules":
                # 只读本机缓存；用户点「刷新规则」才会联网，见 POST 同名接口。
                self.send_json(rules_payload(load_cache(cache_path(self.database.asset_root)), MAX_DETAIL_LINKS))
            elif path == "/api/offline/search":
                # 关键词由前端手填，不做番名匹配；蜜柑单次最多返回 100 条。
                keyword = query.get("q", [""])[0]
                limit = int(query.get("limit", ["40"])[0] or 40)
                anime_id = int(query.get("anime_id", ["0"])[0] or 0)
                self.send_json(OfflineService(self.database).search(keyword, limit=limit, anime_id=anime_id))
            elif path == "/api/offline/state":
                anime_id = int(query.get("anime_id", ["0"])[0] or 0)
                if anime_id <= 0:
                    raise ValueError("番剧 ID 无效")
                self.send_json(OfflineService(self.database).state(anime_id))
            elif path == "/api/offline/subscriptions":
                raw = query.get("anime_id", [""])[0]
                anime_id = int(raw) if str(raw).isdigit() and int(raw) > 0 else None
                self.send_json(OfflineService(self.database).subscriptions(anime_id))
            elif path == "/api/offline/summary":
                self.send_json(OfflineService(self.database).summary())
            elif path == "/api/offline/settings":
                config = offline_config.load(self.database.asset_root)
                self.send_json({
                    "ok": True,
                    "config": config,
                    "paths": offline_config.resolved(config),
                    "default_media_root": offline_config.default_media_root(),
                    "writable": offline_config.ensure_dirs(config),
                })
            elif path.startswith("/api/offline/stream/"):
                file_id = int(path.rsplit("/", 1)[-1])
                row = OfflineStore(self.database).file(file_id)
                if not row:
                    raise ValueError("这一集还没有本地文件")
                self._serve_local_file(Path(str(row.get("file_path") or "")), "video/mp4")
            elif path.startswith("/api/offline/subtitle/"):
                file_id = int(path.rsplit("/", 1)[-1])
                row = OfflineStore(self.database).file(file_id)
                if not row:
                    raise ValueError("这一集没有字幕")
                subtitle = Path(str(row.get("subtitle_path") or ""))
                if not subtitle.is_file():
                    self.send_error_json(404, "字幕文件不存在")
                    return
                body = subtitle.read_bytes()
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                self.wfile.write(body)
            elif path.startswith("/api/offline/fonts/"):
                file_id = int(path.rsplit("/", 1)[-1])
                row = OfflineStore(self.database).file(file_id)
                if not row:
                    raise ValueError("这一集没有本地文件")
                folder = Path(str(row.get("file_path") or "")).parent / "_fonts"
                items = []
                if folder.is_dir():
                    for candidate in sorted(folder.iterdir()):
                        if not candidate.is_file() or candidate.suffix.lower() not in media_tools.FONT_SUFFIXES:
                            continue
                        items.append({
                            "name": candidate.name,
                            "url": f"/api/offline/font/{file_id}/{quote(candidate.name, safe='')}",
                            "size": candidate.stat().st_size,
                        })
                self.send_json({"ok": True, "items": items})
            elif path.startswith("/api/offline/font/"):
                rest = path[len("/api/offline/font/"):]
                file_id_text, _, encoded_name = rest.partition("/")
                file_id = int(file_id_text)
                name = unquote(encoded_name)
                row = OfflineStore(self.database).file(file_id)
                if not row or not name or "/" in name or "\\" in name or name.startswith("."):
                    self.send_error_json(404, "字体不存在")
                    return
                target = Path(str(row.get("file_path") or "")).parent / "_fonts" / name
                if not target.is_file() or target.suffix.lower() not in media_tools.FONT_SUFFIXES:
                    self.send_error_json(404, "字体不存在")
                    return
                mime = media_tools.FONT_MIME.get(target.suffix.lower(), "application/octet-stream")
                send_asset(self, target.read_bytes(), mime, cache="private, no-cache")
            elif path == "/api/jump-history":
                limit = int(query.get("limit", ["80"])[0] or 80)
                self.send_json({"items": self.database.list_jumps(limit)})
            elif path == "/api/video-links":
                store = VideoLinks(self.database)
                anime_id = int(query.get("anime_id", ["0"])[0])
                self.send_json({"features": {"optional_video_default": 1}, "scope": store.scope, "items": store.list(anime_id), "animes": [{"id": a["id"], "name": a["display_name"]} for a in self.database.list_anime()]})
            elif path == "/api/collection-search":
                keyword = query.get("q", [""])[0].strip()[:100]
                if not keyword:
                    raise ValueError("请输入番剧名称")
                # Bangumi 只提供 match/heat/rank/score 四种排序，没有按放送时间；
                # time 由前端对返回结果本地排序，这里仍然请求匹配度最高的 20 条。
                sort = query.get("sort", ["match"])[0]
                if sort not in {"match", "heat", "rank", "score", "time"}:
                    sort = "match"
                from schedule import ScheduleService
                body = {"keyword": keyword, "filter": {"type": [2]}, "sort": "match" if sort == "time" else sort}
                result = json.loads(ScheduleService.fetch("https://api.bgm.tv/v0/search/subjects?limit=20", body=body))
                self.send_json({"items": result.get("data", []), "sort": sort})
            elif path == "/api/collection-outbox":
                with self.database.connect() as db:
                    rows = [dict(row) for row in db.execute("SELECT anime_id,status,error FROM kazumi_outbox")]
                self.send_json({"items": rows})
            elif path == "/api/animes":
                category = int(query["category"][0]) if query.get("category") else None
                custom_collection_id = (
                    int(query["custom_collection_id"][0])
                    if query.get("custom_collection_id")
                    else None
                )
                settings = self.database.get_settings()
                hide_customized = self.parse_bool(
                    query.get(
                        "hide_customized",
                        [
                            str(
                                settings.get(
                                    "hide_custom_collection_items_from_builtin",
                                    True,
                                )
                            )
                        ],
                    )[0]
                )
                self.send_json(
                    {
                        "animes": self.database.list_anime(
                            category,
                            custom_collection_id=custom_collection_id,
                            hide_customized_from_builtin=hide_customized,
                        )
                    }
                )
            elif path == "/api/rankings":
                self.send_json({"boards": self.database.list_ranking_boards()})
            elif path == "/api/ranking-templates":
                self.send_json({"templates": self.database.list_ranking_templates()})
            elif path.startswith("/api/rankings/"):
                board = self.database.get_ranking_board(int(path.split("/")[3]))
                if board:
                    self.send_json({"board": board})
                else:
                    self.send_error_json(404, "排行榜不存在")
            elif path.endswith("/characters") and path.startswith("/api/animes/"):
                anime_id = int(path.split("/")[3])
                if self.database.get_anime(anime_id):
                    self.send_json({
                        "characters": self.database.list_anime_characters(anime_id),
                        "needs_order_refresh": self.database.anime_characters_need_order_refresh(anime_id),
                    })
                else:
                    self.send_error_json(404, "动画不存在")
            elif path.endswith("/episode-records") and path.startswith("/api/animes/"):
                anime_id = int(path.split("/")[3])
                if self.database.get_anime(anime_id):
                    self.send_json({"annotations": self.database.episode_record_annotations(anime_id)})
                else:
                    self.send_error_json(404, "动漫不存在")
            elif path.endswith("/comments") and path.startswith("/api/animes/"):
                anime_id = int(path.split("/")[3])
                self.send_json({"comments": self.database.list_anime_comments(anime_id)})
            elif path.startswith("/api/animes/"):
                anime_id = int(path.rsplit("/", 1)[1])
                anime = self.database.get_anime(anime_id)
                if anime:
                    self.send_json({"anime": self._with_progress([anime])[0]})
                else:
                    self.send_error_json(404, "动漫不存在")
            elif path == "/api/timeline":
                if "limit" in query:
                    self.send_json(self.database.timeline_page(
                        search=query.get("q", [""])[0],
                        themes=query.get("theme", []),
                        offset=int(query.get("offset", ["0"])[0]),
                        limit=int(query["limit"][0]),
                    ))
                    return
                settings = self.database.get_settings()
                show_watch = self.parse_bool(
                    query.get(
                        "watch", [str(settings["show_watch_events"])]
                    )[0]
                )
                show_notes = self.parse_bool(
                    query.get(
                        "notes", [str(settings["show_note_events"])]
                    )[0]
                )
                show_comments = self.parse_bool(
                    query.get(
                        "comments", [str(settings["show_comment_events"])]
                    )[0]
                )
                search = query.get("q", [""])[0]
                self.send_json(
                    {
                        "days": self.database.timeline_days(
                            show_watch=show_watch,
                            show_notes=show_notes,
                            show_comments=show_comments,
                            search=search,
                        )
                    }
                )
            elif path == "/api/statistics":
                period = query.get("period", ["day"])[0]
                record_type = query.get("type", ["all"])[0]
                self.send_json(
                    {"series": self.database.statistics(period, record_type), "balance": self.database.episode_balance()}
                )
            elif path == "/api/status":
                # 轮询接口只带轻量数据：收藏内容变化由 revision 标记，
                # 前端发现版本变了再调 /api/collection-state 拉一次全量。
                self.send_json(
                    {
                        "sync": self.sync.status,
                        "stats": self.database.stats(),
                        "revision": self.database.revision,
                    }
                )
            elif path == "/api/airing":
                animes = self._with_progress(self.database.list_anime())
                payload = {"animes": [{"id": anime["id"], "airing": anime.get("airing"),
                    **({"as_airing": anime["as_airing"]} if "as_airing" in anime else {})} for anime in animes]}
                if self.database.get_settings().get("schedule_airing_source") == "as":
                    ids = [int(value) for value in query.get("ids", [""])[0].split(",")[:500] if value.isdecimal()]
                    payload["schedule_airing"] = self.animeschedule.get_many(ids)
                    if query.get("calendar_source", [""])[0] == "as":
                        calendar = self.as_calendar.get("", week=query.get("week", [""])[0])
                        payload["calendar_airing"] = {row["key"]: row.get("as_airing") for row in calendar["items"]}
                self.send_json(payload)
            elif path == "/api/collection-state":
                self.send_json(
                    {
                        "animes": self._with_progress(self.database.list_anime()),
                        "custom_collections": self.database.list_custom_collections(),
                    }
                )
            elif path.startswith("/api/covers/"):
                anime_id = int(path.rsplit("/", 1)[1])
                tag = getattr(self.sync, "cover_etag", lambda _: None)(anime_id)
                request_tags = [part.strip().removeprefix("W/") for part in self.headers.get("If-None-Match", "").split(",")]
                if tag and (tag.removeprefix("W/") in request_tags or "*" in request_tags):
                    self.send_response(304)
                    self.send_header("Cache-Control", "private, no-cache")
                    self.send_header("ETag", tag)
                    self.end_headers()
                    return
                cover = self.sync.cover(anime_id)
                if not cover:
                    self.send_error(404)
                    return
                body, mime = cover
                tag = getattr(self.sync, "cover_etag", lambda _: None)(anime_id)
                send_asset(self, body, mime, cache="private, no-cache", etag=tag)
            elif path.startswith("/api/character-covers/"):
                parts = path.strip("/").split("/")
                if len(parts) != 4:
                    self.send_error(HTTPStatus.NOT_FOUND)
                    return
                try:
                    anime_id, character_id = int(parts[2]), int(parts[3])
                except ValueError:
                    self.send_error(HTTPStatus.NOT_FOUND)
                    return
                cover = self.sync.character_cover(anime_id, character_id)
                if not cover:
                    self.send_error(HTTPStatus.NOT_FOUND)
                    return
                body, mime = cover
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "public, max-age=86400")
                self.end_headers()
                self.wfile.write(body)
            elif path.startswith("/api/record-images/"):
                filename = Path(path).name
                if filename != path.rsplit("/", 1)[-1] or not re.fullmatch(r"[A-Za-z0-9_-]+\.(?:png|jpg|webp)", filename):
                    self.send_error(HTTPStatus.NOT_FOUND)
                    return
                image_path = self.record_image_root / filename
                if not image_path.is_file():
                    self.send_error(HTTPStatus.NOT_FOUND)
                    return
                body = image_path.read_bytes()
                mime = mimetypes.guess_type(image_path.name)[0] or "application/octet-stream"
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "public, max-age=86400")
                self.end_headers()
                self.wfile.write(body)
            elif path.startswith("/api/"):
                self.send_error_json(404, "接口不存在")
            else:
                self.serve_static(path)
        except OfflineError as error:
            # 蜜柑或 qB 那边的故障，用 502 表达「上游不可用」，前端文案照抄消息即可。
            self.send_error_json(502, str(error))
        except (ValueError, KeyError) as error:
            self.send_error_json(getattr(error, "status", 400), str(error))
        except Exception as error:
            self.unexpected_error(error)
