from __future__ import annotations

from typing import Any
from pathlib import Path
import json
import os
import re
import threading
import uuid
from .common import (DATA_ROOT, DB_PATH, PROFILE_REGISTRY_PATH, json_dumps, now_iso)
from .database import HandbookDB

class ProfileManager:
    """Keep independently stored handbook profiles on one computer.

    The legacy single-user database deliberately remains in place as the first
    profile.  New profiles get their own database below ``data/profiles``.
    This makes the change backward compatible and lets Syncthing share a
    profile snapshot without exposing or overwriting another profile.
    """

    def __init__(self, registry_path: Path = PROFILE_REGISTRY_PATH) -> None:
        self.registry_path = Path(registry_path)
        self._lock = threading.RLock()
        self.registry_path.parent.mkdir(parents=True, exist_ok=True)
        self._ensure_registry()

    @staticmethod
    def _new_sharing_id() -> str:
        """Return a stable opaque identifier for a published profile."""
        return f"profile-{uuid.uuid4().hex}"

    @classmethod
    def _normalize_registry(cls, data: Any) -> tuple[dict[str, Any], bool]:
        """Migrate legacy profile registries without moving their databases."""
        if not isinstance(data, dict):
            return cls._default_registry(), True
        profiles = data.get("profiles")
        if not isinstance(profiles, list) or not profiles:
            return cls._default_registry(), True
        changed = False
        for profile in profiles:
            if not isinstance(profile, dict):
                continue
            sharing_id = str(profile.get("sharing_id") or "").strip()
            if not re.fullmatch(r"[A-Za-z0-9_-]{8,80}", sharing_id):
                profile["sharing_id"] = cls._new_sharing_id()
                changed = True
        if not str(data.get("active_profile_id") or "").strip():
            data["active_profile_id"] = str(profiles[0].get("id") or "local")
            changed = True
        if int(data.get("version") or 0) < 2:
            data["version"] = 2
            changed = True
        return data, changed

    def _read(self) -> dict[str, Any]:
        try:
            data = json.loads(self.registry_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            data = {}
        return self._normalize_registry(data)[0]

    @staticmethod
    def _default_registry() -> dict[str, Any]:
        return {
            "version": 2,
            "active_profile_id": "local",
            "profiles": [
                {
                    "id": "local",
                    "name": "我的手账",
                    "database": str(DB_PATH),
                    "kazumi_path": "",
                    "created_at": now_iso(),
                    "legacy": True,
                    "sharing_id": ProfileManager._new_sharing_id(),
                }
            ],
        }

    def _write(self, data: dict[str, Any]) -> None:
        temporary = self.registry_path.with_suffix(".tmp")
        temporary.write_text(json_dumps(data), encoding="utf-8")
        os.replace(temporary, self.registry_path)

    def _ensure_registry(self) -> None:
        with self._lock:
            try:
                raw = json.loads(self.registry_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                raw = None
            data, changed = self._normalize_registry(raw)
            if changed or not self.registry_path.is_file():
                self._write(data)

    def list_profiles(self) -> list[dict[str, Any]]:
        with self._lock:
            data = self._read()
            active_id = str(data.get("active_profile_id") or "local")
            return [
                {
                    "id": str(item.get("id") or ""),
                    "name": str(item.get("name") or "未命名手账"),
                    "kazumi_path": str(item.get("kazumi_path") or ""),
                    "created_at": str(item.get("created_at") or ""),
                    "legacy": bool(item.get("legacy")),
                    "shared": bool(item.get("shared")),
                    "sharing_id": str(item.get("sharing_id") or ""),
                    "active": str(item.get("id") or "") == active_id,
                }
                for item in data["profiles"]
                if isinstance(item, dict) and item.get("id")
            ]

    def profile(self, profile_id: str | None = None) -> dict[str, Any]:
        with self._lock:
            data = self._read()
            selected = str(profile_id or data.get("active_profile_id") or "local")
            for item in data["profiles"]:
                if isinstance(item, dict) and str(item.get("id")) == selected:
                    return dict(item)
        raise KeyError("找不到该手账账号")

    def database_path(self, profile_id: str | None = None) -> Path:
        profile = self.profile(profile_id)
        raw = str(profile.get("database") or "")
        if not raw:
            raise ValueError("该手账账号没有数据库路径")
        return Path(raw)

    def profile_by_sharing_id(self, sharing_id: str) -> dict[str, Any] | None:
        """Find the local account that owns or mirrors a shared snapshot."""
        candidate = str(sharing_id or "")
        with self._lock:
            data = self._read()
            for item in data["profiles"]:
                if isinstance(item, dict) and str(item.get("sharing_id") or "") == candidate:
                    return dict(item)
        return None

    def create(self, name: str, kazumi_path: str = "") -> dict[str, Any]:
        name = str(name or "").strip()[:40]
        if not name:
            raise ValueError("请输入手账账号名称")
        profile_id = uuid.uuid4().hex[:12]
        profile_dir = self.registry_path.parent / profile_id
        profile = {
            "id": profile_id,
            "name": name,
            "database": str(profile_dir / "handbook.db"),
            "kazumi_path": str(kazumi_path or "").strip(),
            "created_at": now_iso(),
            "legacy": False,
            "sharing_id": self._new_sharing_id(),
        }
        with self._lock:
            data = self._read()
            data["profiles"].append(profile)
            self._write(data)
        # Initialize immediately so an empty profile is a complete handbook.
        HandbookDB(Path(profile["database"]))
        return profile

    def ensure_shared(self, profile_id: str, name: str) -> dict[str, Any]:
        """Create a stable local mirror for a profile published by a friend."""
        safe_id = re.sub(r"[^A-Za-z0-9_-]", "", str(profile_id))[:80]
        if not safe_id:
            raise ValueError("共享账号标识无效")
        with self._lock:
            data = self._read()
            for item in data["profiles"]:
                if not isinstance(item, dict) or str(item.get("sharing_id") or "") != safe_id:
                    continue
                if not item.get("shared"):
                    raise ValueError("Shared profile ID conflicts with a local account")
                display_name = str(name or "").strip()[:40]
                if display_name and item.get("name") != display_name:
                    item["name"] = display_name
                    self._write(data)
                return dict(item)
        # The external sharing ID is deliberately not treated as a local
        # profile ID.  Legacy versions used `local` for every installation;
        # resolving it here was what made a friend's load overwrite the
        # currently open account.
        local_id = safe_id
        with self._lock:
            existing_ids = {
                str(item.get("id") or "")
                for item in self._read()["profiles"]
                if isinstance(item, dict)
            }
        if local_id in existing_ids:
            local_id = f"mirror-{uuid.uuid4().hex[:12]}"
        profile = {
            "id": local_id,
            "name": str(name or "共享手账").strip()[:40] or "共享手账",
            "database": str(self.registry_path.parent / local_id / "handbook.db"),
            "kazumi_path": "",
            "created_at": now_iso(),
            "legacy": False,
            "shared": True,
            "sharing_id": safe_id,
        }
        with self._lock:
            data = self._read()
            data["profiles"].append(profile)
            self._write(data)
        HandbookDB(Path(profile["database"]))
        return profile

    def update(self, profile_id: str, *, name: Any = None, kazumi_path: Any = None) -> dict[str, Any]:
        with self._lock:
            data = self._read()
            for item in data["profiles"]:
                if isinstance(item, dict) and str(item.get("id")) == profile_id:
                    if name is not None:
                        candidate = str(name).strip()[:40]
                        if not candidate:
                            raise ValueError("账号名称不能为空")
                        item["name"] = candidate
                    if kazumi_path is not None:
                        item["kazumi_path"] = str(kazumi_path).strip()
                    self._write(data)
                    return dict(item)
        raise KeyError("找不到该手账账号")

    def activate(self, profile_id: str) -> dict[str, Any]:
        self.profile(profile_id)
        with self._lock:
            data = self._read()
            data["active_profile_id"] = profile_id
            self._write(data)
        return self.profile(profile_id)

    def delete(self, profile_id: str) -> dict[str, Any]:
        """Remove one locally stored profile without touching its shared snapshot.

        A shared profile may be published by a friend and can be loaded again
        later.  Therefore this deliberately removes only the local registry
        entry and its local SQLite mirror, never anything below ``shared``.
        """
        profile_id = str(profile_id or "").strip()
        if not profile_id:
            raise ValueError("缺少要删除的账号")

        with self._lock:
            data = self._read()
            active_id = str(data.get("active_profile_id") or "")
            if profile_id == active_id:
                raise ValueError("不能删除当前打开的账号，请先切换到其他账号")
            kept: list[dict[str, Any]] = []
            deleted: dict[str, Any] | None = None
            for item in data["profiles"]:
                if isinstance(item, dict) and str(item.get("id") or "") == profile_id:
                    deleted = dict(item)
                else:
                    kept.append(item)
            if deleted is None:
                raise KeyError("找不到该手账账号")
            data["profiles"] = kept
            self._write(data)

        # Profile database paths are application-owned.  Keep deletion scoped
        # to them, and never recursively remove an arbitrary directory.
        database = Path(str(deleted.get("database") or "")).resolve()
        data_root = DATA_ROOT.resolve()
        profile_root = self.registry_path.parent.resolve()
        is_owned_database = database == DB_PATH.resolve() or database.is_relative_to(profile_root)
        if is_owned_database:
            for suffix in ("", "-wal", "-shm"):
                Path(f"{database}{suffix}").unlink(missing_ok=True)
            parent = database.parent
            if parent != data_root:
                try:
                    parent.rmdir()
                except OSError:
                    pass
        return deleted


