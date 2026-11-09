"""Post route controller; transport and errors live on RequestHandler."""
from __future__ import annotations
from .http_context import (VideoLinks, _desktop, background_stem, base64, json, normalize_background_bytes, normalize_jump, re, safe_asset_id, save_collection, secrets, time, urlparse)
from .http_support import validate_command_body
from .assets import replace_background_bytes
from .common import MAX_DETAIL_LINKS
from .link_rules import RuleFetchError, cache_path, payload as rules_payload, refresh as refresh_rules
from . import offline_config
from . import screenshots as screenshot_tools
from . import danmaku as danmaku_tools
from .offline_service import OfflineError, OfflineService


class PostRoutes:
    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        try:
            body = self.read_json()
            validate_command_body(path, body)
            write_exempt_paths = {
                "/api/profiles",
                "/api/profiles/activate",
                "/api/sharing/configure",
                "/api/sharing/load",
                "/api/sharing/resident-profiles",
                "/api/sharing/auto-publish",
                "/api/sharing/device-request",
                "/api/sharing/import-device-request",
                "/api/sharing/approve-device",
                "/api/webdav/configure",
                "/api/webdav/test",
                "/api/webdav/sync",
                # 规则仓库缓存是全局文件，与当前账号能否写入收藏无关。
                "/api/link-rules/refresh",
                # 离线设置是本机配置（盘符、下载器端口），不写收藏数据。
                "/api/offline/settings",
                # 截图写的是本机图片库目录，同样是本机文件。
                "/api/offline/screenshot",
                "/api/offline/screenshot/delete",
                # 弹幕代理只是转发查询，不改动任何收藏数据。
                "/api/danmaku/proxy",
            }
            if path not in write_exempt_paths:
                self.require_write_access()
            if path == "/api/link-rules/refresh":
                try:
                    document = refresh_rules(cache_path(self.database.asset_root))
                except RuleFetchError as error:
                    self.send_json({"ok": False, "error": str(error), "items": [], "limit": MAX_DETAIL_LINKS}, 502)
                    return
                self.send_json(rules_payload(document, MAX_DETAIL_LINKS))
            elif path == "/api/offline/settings":
                config = offline_config.save_settings(self.database.asset_root, body)
                self.send_json({
                    "ok": True,
                    "config": config,
                    "paths": offline_config.resolved(config),
                    "writable": offline_config.ensure_dirs(config),
                })
            elif path == "/api/offline/screenshot":
                self.send_json(screenshot_tools.save_png(
                    self.database.asset_root,
                    anime=str(body.get("anime") or ""),
                    episode=str(body.get("episode") or ""),
                    seconds=body.get("seconds") or 0,
                    data_url=str(body.get("data") or ""),
                ))
            elif path == "/api/offline/screenshot/delete":
                self.send_json(screenshot_tools.delete_image(
                    self.database.asset_root,
                    str(body.get("relative") or ""),
                ))
            elif path == "/api/offline/download":
                service = OfflineService(self.database)
                self.send_json(service.download(
                    anime_id=int(body.get("anime_id") or 0),
                    torrent_url=str(body.get("torrent_url") or ""),
                    title=str(body.get("title") or ""),
                    episode_key=str(body.get("episode_key") or ""),
                    group_name=str(body.get("group_name") or ""),
                    resolution=str(body.get("resolution") or ""),
                    codec=str(body.get("codec") or ""),
                ))
            elif path == "/api/offline/resume":
                anime_id = int(body.get("anime_id") or 0)
                episode_key = str(body.get("episode_key") or "")
                if anime_id <= 0 or not episode_key:
                    raise ValueError("缺少番剧或集数")
                OfflineService(self.database).store.set_resume(
                    anime_id, episode_key, int(body.get("resume_ms") or 0)
                )
                self.send_json({"ok": True})
            elif path == "/api/offline/subscribe":
                service = OfflineService(self.database)
                if body.get("id") and not str(body.get("keyword") or "").strip():
                    # 只带 id 表示改已有订阅的开关，不新增记录。
                    updated = service.store.set_subscription_enabled(
                        int(body.get("id") or 0), body.get("enabled") is not False
                    )
                    if not updated:
                        raise ValueError("订阅不存在")
                    self.send_json({"ok": True, "subscription": updated})
                else:
                    self.send_json(service.subscribe(
                        anime_id=int(body.get("anime_id") or 0),
                        keyword=str(body.get("keyword") or ""),
                        group_name=str(body.get("group_name") or ""),
                        enabled=body.get("enabled") is not False,
                    ))
            elif path == "/api/offline/unsubscribe":
                self.send_json(OfflineService(self.database).unsubscribe(int(body.get("id") or 0)))
            elif path == "/api/offline/check":
                self.send_json(OfflineService(self.database).check_subscriptions(force=bool(body.get("force"))))
            elif path == "/api/offline/migrate":
                self.send_json(OfflineService(self.database).migrate_media_root(
                    str(body.get("target") or ""),
                    delete_source=bool(body.get("delete_source")),
                ))
            elif path == "/api/offline/retry":
                self.send_json(OfflineService(self.database).retry_archive(
                    int(body.get("media_id") or 0)
                ))
            elif path == "/api/offline/task":
                self.send_json(OfflineService(self.database).task_action(
                    int(body.get("media_id") or 0), str(body.get("action") or "")
                ))
            elif path == "/api/offline/delete":
                service = OfflineService(self.database)
                mode = str(body.get("mode") or "task")
                if mode == "file":
                    self.send_json(service.delete_episode_file(
                        int(body.get("anime_id") or 0), str(body.get("episode_key") or "")
                    ))
                elif mode in ("task", "task_files"):
                    self.send_json(service.delete_job(
                        int(body.get("media_id") or 0),
                        delete_files=(mode == "task_files"),
                        keep_files=(mode == "task"),
                    ))
                else:
                    raise ValueError("删除方式无效")
            elif path == "/api/danmaku/proxy":
                # 弹弹play 兼容 API 转发。凭证由浏览器本机带过来，不写进数据库，
                # 也就不会进整库快照或云同步；后端只负责签名与系统代理回退。
                text = danmaku_tools.fetch_upstream(
                    str(body.get("base") or ""),
                    str(body.get("path") or ""),
                    app_id=str(body.get("app_id") or ""),
                    app_secret=str(body.get("app_secret") or ""),
                )
                self.send_json({"ok": True, "text": text})
            elif path == "/api/jump-history":
                if str(body.get("action") or "") == "clear":
                    self.database.clear_jumps()
                    self.send_json({"ok": True, "items": []})
                else:
                    self.send_json({"ok": True, "items": self.database.record_jump(normalize_jump(body))})
            elif path == "/api/video-links":
                self.send_json({"ok": True, "items": VideoLinks(self.database).update(body)})
            elif path == "/api/profiles":
                profile = self.profiles.create(
                    str(body.get("name") or ""),
                    str(body.get("kazumi_path") or ""),
                )
                self.send_json({"ok": True, "profile": profile, "profiles": self.profiles.list_profiles()}, 201)
            elif path == "/api/collection-status":
                if self.database.get_settings().get("kazumi_read_only"):
                    raise PermissionError("已开启只读 Kazumi 数据，先到设置中关闭后再修改收藏")
                anime_id = int(body.get("anime_id", 0))
                if anime_id <= 0:
                    raise ValueError("番剧条目 ID 无效")
                status = body.get("status")
                if type(status) is not int or status not in range(1, 6):
                    raise ValueError("收藏状态无效")
                anime = self.database.change_collection_status(anime_id, status)
                if anime is None:
                    subject = self.sync.fetch_bgm(anime_id)
                    if int(subject.get("id") or 0) != anime_id:
                        raise ValueError("资料来源返回的番剧 ID 不匹配")
                    with self.database.transaction():
                        anime = save_collection(self.database, subject, status)
                        if anime.get("episode_count") is None:
                            rating=subject.get("rating") or {}
                            self.database.update_bgm_metadata(anime_id, episode_count=int(subject.get("total_episodes") or subject.get("eps") or 0), rating_score=rating.get("score"), rating_rank=rating.get("rank"), rating_total=rating.get("total"), rating_synced=True)
                self.send_json({"ok": True, "anime": self.database.get_anime(anime_id), "animes": self.database.list_anime(), "stats": self.database.stats()})
            elif path == "/api/profiles/activate":
                profile = _desktop().activate_profile(str(body.get("profile_id") or ""))
                self._profile_snapshot = _desktop().service_snapshot()
                self.send_json({
                    "ok": True,
                    "profile": profile,
                    "profiles": self.profiles.list_profiles(),
                    "settings": self.database.get_settings(),
                    "animes": self.database.list_anime(),
                    "stats": self.database.stats(),
                })
            elif path == "/api/sharing/configure":
                self.send_json({"ok": True, "sharing": self.sharing.configure(str(body.get("shared_folder") or ""))})
            elif path == "/api/sharing/publish":
                profile_id = str(body.get("profile_id") or self.profiles.profile().get("id"))
                if profile_id != str(self.profiles.profile().get("id")):
                    raise ValueError("只能发布当前已打开的手账账号")
                self.send_json({"ok": True, "snapshot": self.sharing.publish(profile_id, self.database)})
            elif path == "/api/sharing/load":
                loaded = self.sharing.load(str(body.get("profile_id") or ""))
                self.send_json({"ok": True, **loaded, "profiles": self.profiles.list_profiles()})
            elif path == "/api/sharing/resident-profiles":
                self.send_json({"ok": True, "sharing": self.sharing.set_resident_profiles(body.get("profile_ids"))})
            elif path == "/api/sharing/auto-publish":
                self.send_json({"ok": True, "sharing": self.sharing.set_auto_publish(body.get("enabled"))})
            elif path == "/api/sharing/device-request":
                request = self.sharing.request_device(str(body.get("device_id") or ""), str(body.get("device_name") or ""))
                self.send_json({"ok": True, "request": request}, 201)
            elif path == "/api/sharing/import-device-request":
                request = self.sharing.import_device_request(body.get("request"))
                self.send_json({"ok": True, "request": request}, 201)
            elif path == "/api/sharing/approve-device":
                approval = self.sharing.approve_device(str(body.get("device_id") or ""))
                self.send_json({"ok": True, "approval": approval})
            elif path == "/api/webdav/configure":
                self.send_json({"ok": True, "webdav": self.webdav.configure(
                    url=body.get("url"), username=body.get("username"), password=body.get("password"),
                    account_id=body.get("account_id"), auto_sync=body.get("auto_sync"),
                )})
            elif path == "/api/webdav/test":
                self.send_json(self.webdav.test())
            elif path == "/api/webdav/sync":
                result = self.webdav.sync(self.database, resolution=str(body.get("resolution") or ""))
                self.send_json({**result, "webdav": self.webdav.status(), "settings": self.database.get_settings(), "animes": self.database.list_anime(), "custom_collections": self.database.list_custom_collections(), "ranking_boards": self.database.list_ranking_boards(), "ranking_templates": self.database.list_ranking_templates(), "stats": self.database.stats()})
            elif path == "/api/background":
                raw = str(body.get("data") or "")
                match = re.fullmatch(r"data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)", raw)
                if not match:
                    raise ValueError("请选择 PNG、JPG 或 WebP 图片")
                image = base64.b64decode(match.group(2), validate=True)
                if len(image) > 8 * 1024 * 1024:
                    raise ValueError("背景图片不能超过 8 MB")
                extension = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}[match.group(1)]
                # Some Windows/phone image pickers expose HEIC files with a .jpg
                # name and image/jpeg MIME type. Browsers cannot render those bytes,
                # so normalize them to a real JPEG before persisting the profile.
                image, normalized_extension = normalize_background_bytes(image)
                extension = normalized_extension or extension
                self.background_root.mkdir(parents=True, exist_ok=True)
                theme_id = safe_asset_id(body.get("profile_id"), "default")
                account_id = safe_asset_id(body.get("account_id"), str(self.profiles.profile().get("id") or "local"))
                stem = background_stem(account_id, theme_id)
                replace_background_bytes(self.background_root, stem, extension, image)
                version = int(time.time() * 1000)
                if body.get("defer_settings") is not True:
                    self.database.set_setting("custom_background_enabled", True)
                    self.database.set_setting("custom_background_version", version)
                self.send_json({"ok": True, "version": version, "settings": self.database.get_settings()})
            elif path == "/api/record-images":
                raw = str(body.get("data") or "")
                match = re.fullmatch(
                    r"data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)", raw
                )
                if not match:
                    raise ValueError("请选择 PNG、JPG 或 WebP 图片")
                image = base64.b64decode(match.group(2), validate=True)
                if len(image) > 8 * 1024 * 1024:
                    raise ValueError("记录图片不能超过 8 MB")
                extension = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}[match.group(1)]
                image, normalized_extension = normalize_background_bytes(image)
                extension = normalized_extension or extension
                self.record_image_root.mkdir(parents=True, exist_ok=True)
                filename = f"record-{int(time.time() * 1000)}-{secrets.token_hex(5)}.{extension}"
                (self.record_image_root / filename).write_bytes(image)
                self.send_json({"ok": True, "url": f"/api/record-images/{filename}"}, 201)
            elif path == "/api/sync":
                started = self.sync.start_background(
                    enrich_all=bool(body.get("refresh_all", False))
                )
                self.send_json(
                    {
                        "ok": started,
                        "message": (
                            "同步已开始" if started else "同步正在进行"
                        ),
                    },
                    202 if started else 409,
                )
            elif path == "/api/custom-collections":
                collection = self.database.create_custom_collection(
                    str(body.get("name") or ""),
                    body.get("kazumi_category"),
                )
                self.send_json(
                    {
                        "ok": True,
                        "collection": collection,
                        "custom_collections": self.database.list_custom_collections(),
                        "stats": self.database.stats(),
                        "animes": self.database.list_anime(),
                    },
                    201,
                )
            elif path.startswith("/api/custom-collections/") and path.endswith(
                "/items"
            ):
                collection_id = int(path.split("/")[3])
                anime_id = int(body.get("anime_id") or 0)
                anime = self.database.add_to_custom_collection(collection_id, anime_id)
                self.send_json(
                    {
                        "ok": True,
                        "anime": anime,
                        "custom_collections": self.database.list_custom_collections(),
                        "stats": self.database.stats(),
                    }
                )
            elif path == "/api/notes":
                anime_id = body.get("anime_id")
                event_id = self.database.add_note(
                    str(body.get("content") or ""),
                    int(anime_id) if anime_id else None,
                    str(body.get("theme") or "other"),
                    themes=[str(item) for item in body.get("themes", [])]
                    if isinstance(body.get("themes"), list)
                    else None,
                    episode_keys=list(body.get("episode_keys") or []),
                    raw_directives=str(body.get("raw_directives") or ""),
                )
                self.send_json({"ok": True, "event_id": event_id}, 201)
            elif path.endswith("/rating") and path.startswith("/api/animes/"):
                anime_id = int(path.split("/")[3])
                rating = str(body.get("rating") or "").strip()
                if not rating:
                    deleted = self.database.clear_anime_rating(anime_id)
                    self.send_json({"ok": True, "deleted": deleted})
                else:
                    event_id = self.database.add_anime_rating(anime_id, rating)
                    self.send_json({"ok": True, "event_id": event_id}, 201)
            elif path == "/api/rankings":
                template_id = body.get("template_id")
                board = self.database.create_ranking_board(str(body.get("name") or ""), int(template_id) if template_id not in (None, "") else None)
                self.send_json({"ok": True, "board": board, "boards": self.database.list_ranking_boards()}, 201)
            elif path == "/api/ranking-templates":
                template = self.database.create_ranking_template(str(body.get("name") or ""), list(body.get("tiers") or []))
                self.send_json({"ok": True, "template": template, "templates": self.database.list_ranking_templates()}, 201)
            elif path.startswith("/api/rankings/"):
                parts = path.split("/")
                board_id = int(parts[3])
                if path.endswith("/tiers"):
                    board = self.database.add_ranking_tier(board_id, str(body.get("name") or ""))
                elif path.endswith("/import"):
                    board = self.database.import_ranking_items(board_id, list(body.get("anime_ids") or []))
                elif path.endswith("/move"):
                    placements = body.get("placements")
                    if not isinstance(placements, dict):
                        raise ValueError("排名位置格式错误")
                    board = self.database.save_ranking_placements(board_id, placements)
                else:
                    self.send_error_json(404, "接口不存在")
                    return
                self.send_json({"ok": True, "board": board, "boards": self.database.list_ranking_boards()})
            elif path == "/api/animes/custom-sort":
                anime_ids = body.get("anime_ids")
                if not isinstance(anime_ids, list):
                    raise ValueError("自定义排序格式错误")
                self.send_json(
                    {
                        "ok": True,
                        "animes": self.database.set_custom_sort_order(anime_ids),
                    }
                )
            elif path.endswith("/age-related") and path.startswith("/api/animes/"):
                anime_id = int(path.split("/")[3])
                self.send_json({"ok": True, "related": self.age.fetch_related(anime_id)})
            elif path.endswith("/characters") and path.startswith("/api/animes/"):
                if not self.database.get_settings().get("show_character_tab", True):
                    raise ValueError("请先在设置中开启人物分栏")
                anime_id = int(path.split("/")[3])
                self.send_json({"ok": True, "characters": self.sync.enrich_characters(anime_id)})
            elif path.endswith("/comments") and path.startswith("/api/animes/"):
                anime_id = int(path.split("/")[3])
                event_id = self.database.add_anime_comment(
                    anime_id,
                    str(body.get("content") or ""),
                    raw_directives=str(body.get("raw_directives") or ""),
                )
                self.send_json({"ok": True, "event_id": event_id}, 201)
            elif path.endswith("/episode-titles") and path.startswith("/api/animes/"):
                if not self.database.get_settings().get("show_episode_titles_on_hover"):
                    raise ValueError("请先在设置中开启单集名称悬浮提示")
                anime_id = int(path.split("/")[3])
                self.send_json(
                    {"ok": True, "anime": self.sync.enrich_episode_titles(anime_id)}
                )
            elif path.endswith("/progress") and path.startswith("/api/animes/"):
                anime_id = int(path.split("/")[3])
                episode_payload = body.get("episode_keys")
                if episode_payload is None:
                    episode_payload = body.get("episodes") or []
                result = self.database.set_progress(
                    anime_id, list(episode_payload or [])
                )
                self.send_json({"ok": True, **result})
            elif path.endswith("/episode-count") and path.startswith(
                "/api/animes/"
            ):
                anime_id = int(path.split("/")[3])
                anime = self.database.set_episode_count(
                    anime_id, int(body.get("episode_count") or 0)
                )
                self.send_json({"ok": True, "anime": anime})
            else:
                self.send_error_json(404, "接口不存在")
        except json.JSONDecodeError:
            self.send_error_json(400, "JSON 格式错误")
        except PermissionError as error:
            self.send_error_json(403, str(error))
        except OfflineError as error:
            self.send_error_json(502, str(error))
        except (ValueError, KeyError) as error:
            self.send_error_json(getattr(error, "status", 400), str(error))
        except Exception as error:
            self.unexpected_error(error)
