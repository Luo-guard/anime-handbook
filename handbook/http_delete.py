"""Delete route controller; transport and errors live on RequestHandler."""
from __future__ import annotations
from .http_context import (background_stem, parse_qs, safe_asset_id, unquote, urlparse)


class DeleteRoutes:
    def do_DELETE(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        try:
            if path.startswith("/api/profiles/"):
                profile_id = unquote(path.rsplit("/", 1)[1])
                deleted = self.profiles.delete(profile_id)
                sharing = self.sharing.forget_profile(str(deleted.get("sharing_id") or ""))
                self.send_json({"ok": True, "deleted_profile": deleted, "profiles": self.profiles.list_profiles(), "sharing": sharing})
                return

            self.require_write_access()
            if path == "/api/background":
                theme_id = safe_asset_id(query.get("profile", [""])[0], "default")
                account_id = safe_asset_id(query.get("account", [""])[0], str(self.profiles.profile().get("id") or "local"))
                removed = 0
                for image in self.background_root.glob(f"{background_stem(account_id, theme_id)}.*"):
                    image.unlink(missing_ok=True)
                    removed += 1
                # Only the background in use may turn the switch off.  Deleting a
                # removed theme's image must not hide the background of the theme
                # the window is currently showing.
                settings = self.database.get_settings()
                active_theme = safe_asset_id(settings.get("active_theme_profile"), "default")
                active_account = safe_asset_id(
                    str(self.profiles.profile().get("id") or "local"), "local"
                )
                if active_theme == theme_id and active_account == account_id:
                    self.database.set_setting("custom_background_enabled", False)
                self.send_json({"ok": True, "removed": removed, "settings": self.database.get_settings()})
            elif path.startswith("/api/events/"):
                event_id = int(path.rsplit("/", 1)[1])
                deleted = self.database.delete_event(event_id)
                if deleted:
                    self.sweep_record_images_later()
                self.send_json({"ok": deleted}, 200 if deleted else 404)
            elif path.startswith("/api/custom-collections/") and "/items/" in path:
                parts = path.split("/")
                collection_id = int(parts[3])
                anime_id = int(parts[5])
                anime = self.database.remove_from_custom_collection(
                    collection_id, anime_id
                )
                self.send_json(
                    {
                        "ok": True,
                        "anime": anime,
                        "custom_collections": self.database.list_custom_collections(),
                        "stats": self.database.stats(),
                    }
                )
            elif path.startswith("/api/custom-collections/"):
                collection_id = int(path.rsplit("/", 1)[1])
                deleted = self.database.delete_custom_collection(collection_id)
                self.send_json(
                    {
                        "ok": deleted,
                        "custom_collections": self.database.list_custom_collections(),
                        "stats": self.database.stats(),
                        "animes": self.database.list_anime(),
                    },
                    200 if deleted else 404,
                )
            elif path.startswith("/api/ranking-templates/"):
                template_id = int(path.rsplit("/", 1)[1])
                deleted = self.database.delete_ranking_template(template_id)
                self.send_json({"ok": deleted, "templates": self.database.list_ranking_templates()}, 200 if deleted else 404)
            elif path.startswith("/api/rankings/"):
                parts = path.split("/")
                board_id = int(parts[3])
                if len(parts) == 6 and parts[4] == "items":
                    deleted = self.database.delete_unranked_ranking_item(board_id, int(parts[5]))
                    self.send_json({"ok": deleted, "board": self.database.get_ranking_board(board_id), "boards": self.database.list_ranking_boards()}, 200 if deleted else 404)
                    return
                deleted = self.database.delete_ranking_board(board_id)
                self.send_json(
                    {"ok": deleted, "boards": self.database.list_ranking_boards()},
                    200 if deleted else 404,
                )
            else:
                self.send_error_json(404, "接口不存在")
        except PermissionError as error:
            self.send_error_json(403, str(error))
        except (ValueError, KeyError) as error:
            self.send_error_json(getattr(error, "status", 400), str(error))
        except Exception as error:
            self.unexpected_error(error)
