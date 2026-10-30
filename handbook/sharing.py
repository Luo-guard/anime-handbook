from __future__ import annotations

from typing import Any
from pathlib import Path
import json
import os
import re
import shutil
import sqlite3
import threading
import time
import uuid
from .common import (APP_ROOT, BACKGROUND_ROOT, RECORD_IMAGE_ROOT, SHARING_CONFIG_PATH, background_stem, find_background_asset, json_dumps, now_iso, safe_asset_id)
from .database import HandbookDB
from .profiles import ProfileManager

class SharingService:
    """Profile snapshot exchange used by Syncthing shared folders.

    The service intentionally has no network dependency.  Syncthing transports
    this folder; the app only writes atomic snapshots and reads them on demand.
    """

    def __init__(self, profiles: ProfileManager) -> None:
        self.profiles = profiles
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread = None

    def _config(self) -> dict[str, Any]:
        try:
            config = json.loads(SHARING_CONFIG_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            config = {}
        if not isinstance(config, dict):
            config = {}
        config.setdefault("shared_folder", "")
        config.setdefault("device_name", os.environ.get("COMPUTERNAME") or "此电脑")
        config.setdefault("resident_profiles", [])
        config.setdefault("auto_publish", True)
        return config

    def _save_config(self, config: dict[str, Any]) -> None:
        SHARING_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        temporary = SHARING_CONFIG_PATH.with_suffix(".tmp")
        temporary.write_text(json_dumps(config), encoding="utf-8")
        os.replace(temporary, SHARING_CONFIG_PATH)

    @staticmethod
    def _merge_legacy_shared_folder(source: Path, destination: Path) -> dict[str, int]:
        """Copy data from the old ``共享`` folder into ``shared`` safely.

        Older builds stored account snapshots under ``<app>/共享`` while the
        Syncthing helper creates and shares ``<app>/shared``.  Copying (rather
        than moving) preserves a local backup and never overwrites a file that
        Syncthing has already placed in the canonical folder.
        """
        result = {"copied": 0, "existing": 0}
        if not source.is_dir() or source.resolve() == destination.resolve():
            return result
        for path in source.rglob("*"):
            if not path.is_file():
                continue
            target = destination / path.relative_to(source)
            if target.exists():
                result["existing"] += 1
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
            result["copied"] += 1
        return result

    def configure(self, shared_folder: str) -> dict[str, Any]:
        folder = Path(str(shared_folder or "")).expanduser()
        if not str(folder):
            raise ValueError("请选择 Syncthing 共享目录")
        folder = folder.resolve()
        folder.mkdir(parents=True, exist_ok=True)
        for name in ("profiles", "device-requests", "approved-devices"):
            (folder / name).mkdir(exist_ok=True)
        with self._lock:
            config = self._config()
            previous = Path(str(config.get("shared_folder") or "")).expanduser()
            legacy_root = (APP_ROOT / "共享").resolve()
            canonical_root = (APP_ROOT / "shared").resolve()
            migration = {"copied": 0, "existing": 0}
            try:
                # Only the known legacy folder is migrated automatically;
                # changing an arbitrary custom folder never copies its files.
                if previous.resolve() == legacy_root and folder == canonical_root:
                    migration = self._merge_legacy_shared_folder(previous, folder)
            except OSError:
                # Keep the valid new setting usable; saving again can retry a
                # migration if the legacy folder was temporarily inaccessible.
                pass
            config["shared_folder"] = str(folder)
            self._save_config(config)
        status = self.status()
        status["legacy_migration"] = migration
        return status

    def root(self) -> Path | None:
        raw = str(self._config().get("shared_folder") or "")
        folder = Path(raw) if raw else None
        return folder if folder and folder.is_dir() else None

    def status(self) -> dict[str, Any]:
        config = self._config()
        root = self.root()
        return {
            "configured": root is not None,
            "shared_folder": str(root or config.get("shared_folder") or ""),
            "device_name": str(config.get("device_name") or "此电脑"),
            "resident_profiles": list(config.get("resident_profiles") or []),
            "auto_publish": bool(config.get("auto_publish", True)),
        }

    def set_auto_publish(self, enabled: Any) -> dict[str, Any]:
        with self._lock:
            config = self._config()
            config["auto_publish"] = bool(enabled)
            self._save_config(config)
        return self.status()

    def set_resident_profiles(self, profile_ids: Any) -> dict[str, Any]:
        if not isinstance(profile_ids, list):
            raise ValueError("常驻加载账号格式无效")
        available = {str(item.get("profile_id")) for item in self.available_profiles()}
        selected = [str(item) for item in profile_ids if str(item) in available]
        with self._lock:
            config = self._config()
            config["resident_profiles"] = selected
            self._save_config(config)
        return self.status()

    def forget_profile(self, sharing_id: str) -> dict[str, Any]:
        """Stop automatically reloading a locally deleted shared account."""
        sharing_id = str(sharing_id or "")
        with self._lock:
            config = self._config()
            config["resident_profiles"] = [
                item for item in config.get("resident_profiles", []) if str(item) != sharing_id
            ]
            self._save_config(config)
        return self.status()

    def refresh_resident_profiles(self) -> None:
        for profile_id in list(self._config().get("resident_profiles") or []):
            try:
                self.load(str(profile_id))
            except (OSError, ValueError, sqlite3.Error):
                # A partial file can be visible for a short moment while
                # Syncthing is replacing it.  The next 30-minute pass retries.
                continue

    def start_resident_refresh(self) -> None:
        def worker() -> None:
            while not self._stop.is_set():
                self.refresh_resident_profiles()
                if self._config().get("auto_publish", True):
                    try:
                        from . import desktop
                        active_profile = desktop.PROFILES.profile()
                        self.publish(str(active_profile["id"]), desktop.DATABASE)
                    except (OSError, ValueError, PermissionError, sqlite3.Error, KeyError):
                        # Sharing may not yet be configured, or a database can
                        # be in the middle of a write.  The next pass retries.
                        pass
                self._stop.wait(30 * 60)
        self._thread = threading.Thread(target=worker, name="handbook-shared-profile-refresh", daemon=True)
        self._thread.start()

    @staticmethod
    def _copy_asset(source: Path, destination: Path) -> None:
        """Atomically copy one asset so Syncthing never sees a half-written file."""
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
        shutil.copy2(source, temporary)
        os.replace(temporary, destination)

    @staticmethod
    def _theme_ids(database: HandbookDB) -> list[str]:
        settings = database.get_settings()
        ids = [safe_asset_id(settings.get("active_theme_profile"))]
        for item in settings.get("theme_profiles", []):
            if isinstance(item, dict):
                theme_id = safe_asset_id(item.get("id"))
                if theme_id not in ids:
                    ids.append(theme_id)
        return ids

    def _export_assets(
        self, target_dir: Path, profile: dict[str, Any], database: HandbookDB
    ) -> dict[str, Any]:
        """Copy visual assets used by a profile beside its immutable snapshot."""
        asset_root = target_dir / "assets"
        backgrounds: list[dict[str, str]] = []
        for theme_id in self._theme_ids(database):
            source = find_background_asset(profile.get("id"), theme_id)
            if not source or not source.is_file():
                continue
            relative = Path("backgrounds") / f"{theme_id}{source.suffix.lower()}"
            self._copy_asset(source, asset_root / relative)
            backgrounds.append({"theme_id": theme_id, "file": relative.as_posix()})
        images: list[str] = []
        for filename in database.referenced_record_images():
            source = RECORD_IMAGE_ROOT / filename
            if not source.is_file():
                continue
            relative = Path("record-images") / filename
            self._copy_asset(source, asset_root / relative)
            images.append(filename)
        return {"backgrounds": backgrounds, "record_images": sorted(images)}

    def _restore_assets(
        self, target_dir: Path, profile: dict[str, Any], manifest: dict[str, Any]
    ) -> None:
        """Restore only assets declared by this snapshot into its local mirror."""
        assets = manifest.get("assets")
        if not isinstance(assets, dict):
            return  # Old snapshot: database-only is still a valid load.
        asset_root = target_dir / "assets"
        for item in assets.get("backgrounds", []):
            if not isinstance(item, dict):
                continue
            theme_id = safe_asset_id(item.get("theme_id"))
            relative = Path(str(item.get("file") or ""))
            if relative.parts[:1] != ("backgrounds",) or ".." in relative.parts:
                continue
            source = asset_root / relative
            if not source.is_file():
                continue
            for old in BACKGROUND_ROOT.glob(f"{background_stem(profile.get('id'), theme_id)}.*"):
                old.unlink(missing_ok=True)
            self._copy_asset(source, BACKGROUND_ROOT / f"{background_stem(profile.get('id'), theme_id)}{source.suffix.lower()}")
        for raw_name in assets.get("record_images", []):
            filename = str(raw_name or "")
            if not re.fullmatch(r"[A-Za-z0-9_-]+\.(?:png|jpg|webp)", filename):
                continue
            source = asset_root / "record-images" / filename
            if source.is_file():
                self._copy_asset(source, RECORD_IMAGE_ROOT / filename)

    def publish(self, profile_id: str, database: HandbookDB) -> dict[str, Any]:
        root = self.root()
        if root is None:
            raise ValueError("请先设置 Syncthing 共享目录")
        profile = self.profiles.profile(profile_id)
        if bool(profile.get("shared")):
            raise PermissionError("好友共享账号不能再次发布。")
        if str(profile.get("id")) == str(self.profiles.profile().get("id")):
            from .desktop import require_active_profile_write_access
            require_active_profile_write_access()
        sharing_id = re.sub(r"[^A-Za-z0-9_-]", "", str(profile.get("sharing_id") or ""))[:80]
        if not sharing_id:
            raise ValueError("Current profile has no sharing identifier; restart the handbook and try again")
        target_dir = root / "profiles" / sharing_id
        target_dir.mkdir(parents=True, exist_ok=True)
        snapshot = target_dir / "handbook.snapshot.db"
        assets = self._export_assets(target_dir, profile, database)
        database.export_snapshot(snapshot)
        manifest = {
            "profile_id": sharing_id,
            "local_profile_id": str(profile.get("id") or ""),
            "name": profile.get("name"),
            "published_at": now_iso(),
            "format": 3,
            "assets": assets,
        }
        temporary = target_dir / "manifest.tmp"
        temporary.write_text(json_dumps(manifest), encoding="utf-8")
        os.replace(temporary, target_dir / "manifest.json")
        return manifest

    def available_profiles(self) -> list[dict[str, Any]]:
        root = self.root()
        if root is None:
            return []
        results: list[dict[str, Any]] = []
        for manifest_path in (root / "profiles").glob("*/manifest.json"):
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(manifest, dict) or not manifest.get("profile_id"):
                continue
            published_id = str(manifest.get("profile_id"))
            try:
                format_version = int(manifest.get("format") or 1)
            except (TypeError, ValueError):
                format_version = 1
            # Old builds published every default profile as `local`.  Those
            # snapshots cannot be identified safely and would overwrite a
            # local profile when imported, so wait for their owner to publish
            # again using the per-profile sharing identifier.
            if format_version < 2 and published_id == "local":
                continue
            # Keep other legacy snapshots visible, but label them as
            # incompatible instead of letting users discover that only after
            # clicking "load".  Their former global `local` identifier is why
            # they cannot be imported safely.
            manifest["format"] = format_version
            manifest["legacy"] = format_version < 2
            manifest["available"] = (manifest_path.parent / "handbook.snapshot.db").is_file()
            local_profile = self.profiles.profile_by_sharing_id(published_id)
            manifest["loaded"] = bool(local_profile and local_profile.get("shared"))
            manifest["local"] = bool(local_profile and not local_profile.get("shared"))
            manifest["local_profile_id"] = str(local_profile.get("id") or "") if local_profile else ""
            results.append(manifest)
        return sorted(results, key=lambda item: str(item.get("name") or ""))

    def load(self, profile_id: str) -> dict[str, Any]:
        """Load a profile snapshot after the user explicitly opens it."""
        root = self.root()
        if root is None:
            raise ValueError("请先设置 Syncthing 共享目录")
        safe_id = re.sub(r"[^A-Za-z0-9_-]", "", str(profile_id))[:80]
        snapshot = root / "profiles" / safe_id / "handbook.snapshot.db"
        manifest_path = snapshot.with_name("manifest.json")
        if not snapshot.is_file() or not manifest_path.is_file():
            raise ValueError("共享目录中还没有这个账号的数据")
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError("共享账号清单损坏") from error
        manifest_id = str(manifest.get("profile_id") or "")
        if manifest_id != safe_id or int(manifest.get("format") or 1) < 2:
            raise ValueError("这是旧版本共享快照；请让发布者更新手账后重新发布")
        profile = self.profiles.ensure_shared(manifest_id, str(manifest.get("name") or "共享手账"))
        database = HandbookDB(self.profiles.database_path(str(profile["id"])))
        database.import_snapshot(snapshot)
        self._restore_assets(snapshot.parent, profile, manifest)
        return {"profile": profile, "manifest": manifest}

    def request_device(self, device_id: str, device_name: str) -> dict[str, Any]:
        root = self.root()
        if root is None:
            raise ValueError("请先设置 Syncthing 共享目录")
        safe_id = re.sub(r"[^A-Za-z0-9_-]", "", str(device_id))[:80]
        if not safe_id:
            raise ValueError("设备标识无效")
        request = {"device_id": safe_id, "device_name": str(device_name or "新设备")[:80], "requested_at": now_iso()}
        (root / "device-requests" / f"{safe_id}.json").write_text(json_dumps(request), encoding="utf-8")
        return request

    def import_device_request(self, request: Any) -> dict[str, Any]:
        if not isinstance(request, dict):
            raise ValueError("设备申请文件格式无效")
        return self.request_device(
            str(request.get("device_id") or ""),
            str(request.get("device_name") or "新设备"),
        )

    def device_requests(self) -> list[dict[str, Any]]:
        root = self.root()
        if root is None:
            return []
        records: list[dict[str, Any]] = []
        for path in (root / "device-requests").glob("*.json"):
            try:
                value = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(value, dict) and value.get("device_id"):
                records.append(value)
        return sorted(records, key=lambda item: str(item.get("requested_at") or ""), reverse=True)

    def approve_device(self, device_id: str) -> dict[str, Any]:
        root = self.root()
        if root is None:
            raise ValueError("请先设置 Syncthing 共享目录")
        safe_id = re.sub(r"[^A-Za-z0-9_-]", "", str(device_id))[:80]
        request_path = root / "device-requests" / f"{safe_id}.json"
        if not request_path.is_file():
            raise KeyError("找不到该设备申请")
        request = json.loads(request_path.read_text(encoding="utf-8"))
        approval = {**request, "approved_at": now_iso(), "approved_by": self._config().get("device_name")}
        (root / "approved-devices" / f"{safe_id}.json").write_text(json_dumps(approval), encoding="utf-8")
        request_path.unlink(missing_ok=True)
        return approval


