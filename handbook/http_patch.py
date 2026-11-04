"""Patch route controller; transport and errors live on RequestHandler."""
from __future__ import annotations
from .http_context import (Any, CATEGORY_NAMES, save_settings, urlparse)


class PatchRoutes:
    def do_PATCH(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        try:
            body = self.read_json()
            if not path.startswith("/api/profiles/"):
                self.require_write_access()
            if path.startswith("/api/profiles/"):
                profile_id = path.rsplit("/", 1)[1]
                if self.profiles.profile(profile_id).get("shared"):
                    raise PermissionError("好友共享账号只能查看，不能修改账号资料。")
                profile = self.profiles.update(
                    profile_id,
                    name=body["name"] if "name" in body else None,
                    kazumi_path=body["kazumi_path"] if "kazumi_path" in body else None,
                )
                self.send_json({"ok": True, "profile": profile, "profiles": self.profiles.list_profiles()})
            elif path.startswith("/api/events/"):
                event_id = int(path.rsplit("/", 1)[1])
                anime_id = body.get("anime_id")
                updated = self.database.update_event(
                    event_id,
                    content=str(body.get("content") or ""),
                    anime_id=int(anime_id) if anime_id else None,
                    theme=str(body.get("theme") or ""),
                    themes=[str(item) for item in body.get("themes", [])]
                    if isinstance(body.get("themes"), list)
                    else None,
                    rating=float(body["rating"]) if body.get("rating") not in (None, "") else None,
                    raw_directives=str(body.get("raw_directives") or ""),
                    episode_text=str(body.get("episodes") or ""),
                )
                if updated:
                    self.sweep_record_images_later()
                self.send_json({"ok": updated}, 200 if updated else 404)
            elif path == "/api/settings":
                save_settings(self, body)
            elif path.startswith("/api/rankings/"):
                parts = path.split("/")
                board_id = int(parts[3])
                if len(parts) >= 6 and parts[4] == "tiers":
                    board = self.database.rename_ranking_tier(board_id, int(parts[5]), str(body.get("name") or ""))
                else:
                    board = self.database.update_ranking_board(board_id, str(body.get("name") or ""))
                self.send_json({"ok": True, "board": board, "boards": self.database.list_ranking_boards()})
            elif path.startswith("/api/custom-collections/"):
                collection_id = int(path.rsplit("/", 1)[1])
                # 只传了哪个字段就改哪个：改名和改映射互不影响。
                changes: dict[str, Any] = {}
                if "name" in body:
                    changes["name"] = str(body.get("name") or "")
                if "kazumi_category" in body:
                    changes["kazumi_category"] = body.get("kazumi_category")
                if not changes:
                    raise ValueError("没有需要修改的内容")
                collection = self.database.update_custom_collection(
                    collection_id, **changes
                )
                self.send_json(
                    {
                        "ok": True,
                        "collection": collection,
                        "custom_collections": self.database.list_custom_collections(),
                    }
                )
            elif path.startswith("/api/categories/"):
                category = int(path.rsplit("/", 1)[1])
                if category not in CATEGORY_NAMES:
                    raise ValueError("收藏分类不存在")
                settings = self.database.get_settings()
                visibility = settings["category_episode_visibility"]
                visibility[str(category)] = bool(
                    body.get("show_episode_count", True)
                )
                self.database.set_setting(
                    "category_episode_visibility", visibility
                )
                self.send_json({"ok": True, "visibility": visibility})
            else:
                self.send_error_json(404, "接口不存在")
        except PermissionError as error:
            self.send_error_json(403, str(error))
        except (ValueError, KeyError) as error:
            self.send_error_json(getattr(error, "status", 400), str(error))
        except Exception as error:
            self.unexpected_error(error)
