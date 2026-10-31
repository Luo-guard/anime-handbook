from __future__ import annotations

from typing import Any
from pathlib import Path
import base64
from datetime import datetime
import hashlib
import json
import os
from urllib.parse import quote
import re
import threading
from datetime import timedelta
from datetime import timezone
import urllib.request
from urllib.parse import urlparse
from .common import (WEBDAV_CONFIG_PATH, json_dumps, json_list, now_iso)
from .database import HandbookDB
from .profiles import ProfileManager

class WebDAVSyncService:
    """Nutstore WebDAV account sync.

    Credentials remain on this device in ``data/webdav.json``.  The remote
    file is a portable JSON account state, never a copy of Kazumi or our local
    cover cache.  The central file is deliberately last-submit-wins: when both
    sides changed since their last successful sync, the browser asks the user
    which side should be submitted.
    """

    ROOT = "AnimeHandbook-v1"
    # Kazumi 自己的云同步目录；只推送本机 hive 的副本，绝不改写它的合并逻辑。
    KAZUMI_ROOT = "kazumiSync"
    KAZUMI_BOXES = ("collectibles", "collectchanges")

    def __init__(self, profiles: ProfileManager, config_path: Path = WEBDAV_CONFIG_PATH) -> None:
        self.profiles = profiles
        self.config_path = Path(config_path)
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None
        self.config_path.parent.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _default_config() -> dict[str, Any]:
        return {"version": 1, "url": "https://dav.jianguoyun.com/dav/", "username": "", "password": "", "auto_sync": True, "profiles": {}}

    @staticmethod
    def _as_bool(value: Any, default: bool = False) -> bool:
        """Parse checkbox values from JSON and older/form clients safely."""
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return value != 0
        if isinstance(value, str):
            normalized = value.strip().lower()
            if normalized in {"true", "1", "yes", "on", "y", "是", "开启", "开"}:
                return True
            if normalized in {"false", "0", "no", "off", "n", "否", "关闭", "关", ""}:
                return False
        return default

    def _read(self) -> dict[str, Any]:
        try:
            raw = json.loads(self.config_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raw = {}
        config = self._default_config()
        if isinstance(raw, dict):
            config.update({key: raw.get(key, config[key]) for key in config})
        if not isinstance(config.get("profiles"), dict):
            config["profiles"] = {}
        return config

    def _write(self, config: dict[str, Any]) -> None:
        temporary = self.config_path.with_suffix(".tmp")
        temporary.write_text(json_dumps(config), encoding="utf-8")
        os.replace(temporary, self.config_path)

    @staticmethod
    def _account_id(value: Any) -> str:
        candidate = re.sub(r"[^A-Za-z0-9_-]", "", str(value or ""))[:80]
        if len(candidate) < 8:
            raise ValueError("云端账号标识至少需要 8 个字母、数字、下划线或连字符")
        return candidate

    def _profile_config(self, config: dict[str, Any], profile_id: str | None = None) -> dict[str, Any]:
        profile = self.profiles.profile(profile_id)
        key = str(profile["id"])
        item = config["profiles"].get(key)
        if not isinstance(item, dict):
            item = {"account_id": str(profile.get("sharing_id") or ""), "last_hash": "", "last_etag": "", "last_synced_at": "", "last_error": ""}
            config["profiles"][key] = item
        if not str(item.get("account_id") or ""):
            item["account_id"] = str(profile.get("sharing_id") or "")
        return item

    def status(self, profile_id: str | None = None) -> dict[str, Any]:
        with self._lock:
            config = self._read()
            item = self._profile_config(config, profile_id)
            return {
                "configured": bool(str(config.get("url") or "").strip() and str(config.get("username") or "").strip() and str(config.get("password") or "")),
                "url": str(config.get("url") or ""),
                "username": str(config.get("username") or ""),
                "password_configured": bool(str(config.get("password") or "")),
                "auto_sync": self._as_bool(config.get("auto_sync", True), True),
                "account_id": str(item.get("account_id") or ""),
                "last_synced_at": str(item.get("last_synced_at") or ""),
                "last_error": str(item.get("last_error") or ""),
            }

    def configure(self, *, url: Any, username: Any, password: Any, account_id: Any, auto_sync: Any) -> dict[str, Any]:
        base = str(url or "").strip()
        parsed = urlparse(base)
        if parsed.scheme not in {"https", "http"} or not parsed.netloc:
            raise ValueError("WebDAV 地址必须是完整的 http(s) 地址")
        username = str(username or "").strip()
        if not username:
            raise ValueError("请输入坚果云账号")
        with self._lock:
            config = self._read()
            config["url"] = base.rstrip("/") + "/"
            config["username"] = username
            supplied_password = str(password or "")
            if supplied_password:
                config["password"] = supplied_password
            if not str(config.get("password") or ""):
                raise ValueError("请输入坚果云应用密码")
            config["auto_sync"] = self._as_bool(auto_sync)
            item = self._profile_config(config)
            item["account_id"] = self._account_id(account_id)
            self._write(config)
            # Wake the background worker so changing the checkbox takes effect
            # immediately instead of waiting for the current 30-minute sleep.
            self._wake.set()
        return self.status()

    @staticmethod
    def _url(base: str, relative: str) -> str:
        return base.rstrip("/") + "/" + "/".join(quote(piece, safe="_-.") for piece in relative.split("/"))

    @staticmethod
    def _request(config: dict[str, Any], method: str, relative: str, body: bytes | None = None, content_type: str | None = None) -> tuple[int, bytes]:
        token = base64.b64encode(f"{config['username']}:{config['password']}".encode("utf-8")).decode("ascii")
        headers = {"Authorization": f"Basic {token}", "User-Agent": "AnimeHandbook/1.0"}
        if content_type:
            headers["Content-Type"] = content_type
        request = urllib.request.Request(WebDAVSyncService._url(str(config["url"]), relative), data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=25) as response:
                return int(response.status), response.read()
        except urllib.error.HTTPError as error:
            return int(error.code), error.read()
        except urllib.error.URLError as error:
            raise ValueError(f"无法连接坚果云：{error.reason}") from error

    @staticmethod
    def _remote_probe(config: dict[str, Any], account_id: str) -> tuple[int, str]:
        """Return the small WebDAV version marker without downloading account.json."""
        token = base64.b64encode(f"{config['username']}:{config['password']}".encode("utf-8")).decode("ascii")
        request = urllib.request.Request(
            WebDAVSyncService._url(str(config["url"]), f"{WebDAVSyncService.ROOT}/{account_id}/account.json"),
            headers={"Authorization": f"Basic {token}", "User-Agent": "AnimeHandbook/1.0"},
            method="HEAD",
        )
        try:
            with urllib.request.urlopen(request, timeout=25) as response:
                return int(response.status), str(response.headers.get("ETag") or "")
        except urllib.error.HTTPError as error:
            return int(error.code), ""
        except urllib.error.URLError as error:
            raise ValueError(f"无法连接坚果云：{error.reason}") from error

    @staticmethod
    def _state_hash(state: dict[str, Any]) -> str:
        """Hash account content, deliberately excluding transient export metadata."""
        payload = dict(state)
        payload.pop("exported_at", None)
        return hashlib.sha256(json_dumps(payload).encode("utf-8")).hexdigest()

    @staticmethod
    def _legacy_state_hash(state: dict[str, Any]) -> str:
        """Pre-1.0.4 hash retained only to migrate existing sync settings."""
        return hashlib.sha256(json_dumps(state).encode("utf-8")).hexdigest()

    def _ensure_remote_folder(self, config: dict[str, Any], account_id: str) -> None:
        for folder in (self.ROOT, f"{self.ROOT}/{account_id}"):
            status, _ = self._request(config, "MKCOL", folder)
            if status not in {201, 405}:  # 405 = directory already exists
                raise ValueError(f"坚果云无法创建同步目录（HTTP {status}）")

    def test(self) -> dict[str, Any]:
        with self._lock:
            config = self._read()
            item = self._profile_config(config)
            if not self.status().get("configured"):
                raise ValueError("请先填写坚果云地址、账号和应用密码")
            self._ensure_remote_folder(config, self._account_id(item.get("account_id")))
        return {"ok": True, "message": "坚果云连接成功，已准备好同步目录"}

    def _remote_state(self, config: dict[str, Any], account_id: str) -> tuple[dict[str, Any] | None, str]:
        status, body = self._request(config, "GET", f"{self.ROOT}/{account_id}/account.json")
        if status == 404:
            return None, ""
        if status != 200:
            raise ValueError(f"读取坚果云数据失败（HTTP {status}）")
        try:
            state = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("坚果云中的手账数据无法识别") from error
        payload = state.get("state") if isinstance(state, dict) else None
        if not isinstance(payload, dict):
            raise ValueError("坚果云中的手账数据格式不正确")
        digest = self._state_hash(payload)
        return state, digest

    def _upload_state(self, config: dict[str, Any], account_id: str, state: dict[str, Any]) -> str:
        # Include only a timestamp and payload. The timestamp is explanatory;
        # conflict detection uses the canonical payload hash instead.
        document = {"format": 1, "updated_at": now_iso(), "state": state}
        body = json_dumps(document).encode("utf-8")
        status, _ = self._request(config, "PUT", f"{self.ROOT}/{account_id}/account.json", body, "application/json; charset=utf-8")
        if status not in {200, 201, 204}:
            raise ValueError(f"上传坚果云数据失败（HTTP {status}）")
        return self._state_hash(state)

    @staticmethod
    def _row_moment(row: dict[str, Any], field: str) -> datetime | None:
        try:
            moment = datetime.fromisoformat(str(row.get(field) or "").replace("Z", "+00:00"))
            # Legacy timestamps without an offset were recorded in Beijing time.
            if moment.tzinfo is None:
                moment = moment.replace(tzinfo=timezone(timedelta(hours=8)))
            return moment.astimezone(timezone.utc)
        except (ValueError, TypeError, OverflowError):
            return None

    @classmethod
    def _select_row(cls, left: dict[str, Any], right: dict[str, Any], field: str, *, earlier: bool) -> dict[str, Any]:
        left_time, right_time = cls._row_moment(left, field), cls._row_moment(right, field)
        if left_time is None and right_time is not None:
            return right
        if right_time is None and left_time is not None:
            return left
        if left_time is not None and right_time is not None and left_time != right_time:
            return right if (right_time < left_time if earlier else right_time > left_time) else left
        # Equal instants (including differently formatted offsets) must converge
        # regardless of which device submits first.
        # IDs are device-local and may have been reassigned on a previous merge.
        # For otherwise identical rows keep the existing ID, avoiding endless
        # renumbering when the same batch is received again.
        return min((left, right), key=lambda row: json.dumps({key: value for key, value in row.items() if key != "id"}, ensure_ascii=False, sort_keys=True, separators=(",", ":")))

    @classmethod
    def _newer_row(cls, left: dict[str, Any], right: dict[str, Any], timestamp: str) -> dict[str, Any]:
        return cls._select_row(left, right, timestamp, earlier=False)

    @classmethod
    def _earlier_row(cls, left: dict[str, Any], right: dict[str, Any], timestamp: str) -> dict[str, Any]:
        return cls._select_row(left, right, timestamp, earlier=True)

    @classmethod
    def merge_record_states(cls, local: dict[str, Any], remote: dict[str, Any]) -> dict[str, Any]:
        """Merge concurrent watch records by anime id and episode key.

        Different anime or episodes remain independent. A true collision keeps
        the earliest viewing time, while watched progress is unioned to match the merged
        timeline.
        """
        local_tables = local.get("tables") if isinstance(local, dict) else None
        remote_tables = remote.get("tables") if isinstance(remote, dict) else None
        if not isinstance(local_tables, dict) or not isinstance(remote_tables, dict):
            raise ValueError("云端手账数据格式不正确")
        merged = {"format": 1, "exported_at": now_iso(), "tables": {}}
        for table in HandbookDB.CLOUD_TABLES:
            rows = local_tables.get(table, [])
            merged["tables"][table] = [dict(row) for row in rows if isinstance(row, dict)]

        local_anime = {str(row.get("id")): dict(row) for row in merged["tables"]["anime"] if row.get("id") is not None}
        for raw in remote_tables.get("anime", []):
            if not isinstance(raw, dict) or raw.get("id") is None:
                continue
            key, remote_row = str(raw["id"]), dict(raw)
            local_row = local_anime.get(key)
            if local_row is None:
                local_anime[key] = remote_row
                continue
            chosen = dict(cls._newer_row(local_row, remote_row, "updated_at"))
            watched = sorted({str(key) for key in json_list(local_row.get("watched_episodes")) + json_list(remote_row.get("watched_episodes"))})
            chosen["watched_episodes"] = json_dumps(watched)
            local_anime[key] = chosen
        merged["tables"]["anime"] = list(local_anime.values())

        # Split legacy multi-episode records before merging, so episode 1 on
        # one device can never erase episode 2 recorded on the other device.
        event_by_key: dict[str, dict[str, Any]] = {}
        for source in (local_tables.get("events", []), remote_tables.get("events", [])):
            for raw in source:
                if not isinstance(raw, dict):
                    continue
                event = dict(raw)
                if str(event.get("event_type") or "") == "watch" and event.get("anime_id") is not None:
                    episodes = json_list(event.get("episodes"))
                    if episodes:
                        for episode in episodes:
                            item = dict(event)
                            item["episodes"] = json_dumps([str(episode)])
                            key = f"watch:{item['anime_id']}:{episode}"
                            event_by_key[key] = cls._earlier_row(event_by_key[key], item, "created_at") if key in event_by_key else item
                        continue
                key = "event:" + json.dumps({
                    "type": event.get("event_type"), "anime": event.get("anime_id"),
                    "episodes": event.get("episodes"), "content": event.get("content"),
                    "created": event.get("created_at"),
                }, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                event_by_key.setdefault(key, event)
        events = [event_by_key[key] for key in sorted(event_by_key)]
        # Device-local SQLite ids can collide. Retain one when unique and give
        # the other merged record a fresh id before importing it.
        used_ids: set[int] = set()
        next_id = max((int(row.get("id") or 0) for row in events), default=0) + 1
        for event in events:
            try:
                event_id = int(event.get("id"))
            except (TypeError, ValueError):
                event_id = 0
            if event_id <= 0 or event_id in used_ids:
                event_id = next_id
                next_id += 1
                event["id"] = event_id
            used_ids.add(event_id)
        merged["tables"]["events"] = sorted(events, key=lambda row: int(row["id"]))
        return merged

    def sync(self, database: HandbookDB, *, resolution: str = "") -> dict[str, Any]:
        with self._lock:
            result = self._sync_once(database, resolution=resolution)
            if result.get("ok"):
                kazumi = self._push_kazumi(database)
                if kazumi:
                    result["kazumi"] = kazumi
            return result

    @staticmethod
    def _kazumi_running() -> bool:
        import subprocess

        options = {"creationflags": subprocess.CREATE_NO_WINDOW} if hasattr(subprocess, "CREATE_NO_WINDOW") else {}
        try:
            processes = subprocess.run(
                ["tasklist", "/FI", "IMAGENAME eq kazumi.exe", "/FO", "CSV", "/NH"],
                capture_output=True,
                timeout=10,
                **options,
            )
        except (OSError, subprocess.SubprocessError):
            return True
        return b"kazumi.exe" in processes.stdout.lower()

    @staticmethod
    def _hive_dir() -> Path | None:
        from .metadata import SyncService

        hive = SyncService.find_kazumi_database()
        return hive.parent if hive else None

    def _push_kazumi(self, database: HandbookDB) -> dict[str, Any] | None:
        """把本机 Kazumi 收藏库推到云端，等价于替 Kazumi 按一次同步。

        只有在“云端自上次同步后没有任何第三方改动”时才会写入，否则只记录云端版本
        并提示先打开 Kazumi 同步一次，避免覆盖手机等设备新增的数据。
        """
        if database.get_settings().get("webdav_kazumi_sync") is False:
            return None
        hive_dir = self._hive_dir()
        if not hive_dir:
            return {"ok": False, "action": "missing", "message": "未找到本机 Kazumi 收藏库，已跳过"}
        if self._kazumi_running():
            return {"ok": False, "action": "running", "message": "Kazumi 正在运行，已跳过 Kazumi 推送"}
        config = self._read()
        item = self._profile_config(config)
        files = {name: hive_dir / f"{name}.hive" for name in self.KAZUMI_BOXES}
        files = {name: path for name, path in files.items() if path.is_file()}
        if not files:
            return {"ok": False, "action": "missing", "message": "未找到 Kazumi 收藏库文件，已跳过"}
        status, _ = self._request(config, "MKCOL", self.KAZUMI_ROOT)
        if status not in {201, 405}:
            return {"ok": False, "action": "error", "message": f"坚果云无法创建 Kazumi 目录（HTTP {status}）"}
        remote: dict[str, str | None] = {}
        for name in files:
            code, body = self._request(config, "GET", f"{self.KAZUMI_ROOT}/{name}.tmp")
            if code == 404:
                remote[name] = None
            elif code == 200:
                remote[name] = hashlib.sha256(body).hexdigest()
            else:
                return {"ok": False, "action": "error", "message": f"读取云端 Kazumi 数据失败（HTTP {code}）"}
        baseline = item.get("kazumi_sync") if isinstance(item.get("kazumi_sync"), dict) else {}
        if baseline:
            dirty = [name for name in remote if remote[name] != baseline.get(name)]
            if dirty:
                item["kazumi_sync"] = remote
                self._write(config)
                return {"ok": False, "action": "changed", "message": "云端 Kazumi 数据有更新（可能来自手机），本次未推送；打开一次 Kazumi 同步后再点同步即可"}
        elif any(value is not None for value in remote.values()):
            item["kazumi_sync"] = remote
            self._write(config)
            return {"ok": False, "action": "baseline", "message": "已记录云端 Kazumi 版本，下次同步会把本机收藏一起传上去"}
        uploaded: dict[str, str | None] = {}
        for name, path in files.items():
            try:
                data = path.read_bytes()
            except OSError:
                return {"ok": False, "action": "error", "message": f"读取 {name}.hive 失败，请关闭 Kazumi 后重试"}
            code, _ = self._request(config, "PUT", f"{self.KAZUMI_ROOT}/{name}.tmp", data, "application/octet-stream")
            if code not in {200, 201, 204}:
                return {"ok": False, "action": "error", "message": f"上传 Kazumi 数据失败（HTTP {code}）"}
            uploaded[name] = hashlib.sha256(data).hexdigest()
        item["kazumi_sync"] = uploaded
        self._write(config)
        return {"ok": True, "action": "uploaded", "message": "已把本机 Kazumi 收藏同步到坚果云"}

    def _sync_once(self, database: HandbookDB, *, resolution: str = "") -> dict[str, Any]:
        with self._lock:
            config = self._read()
            profile_item = self._profile_config(config)
            if not bool(str(config.get("url") or "") and str(config.get("username") or "") and str(config.get("password") or "")):
                raise ValueError("请先完成坚果云配置")
            account_id = self._account_id(profile_item.get("account_id"))
            self._ensure_remote_folder(config, account_id)
            local_state = database.export_cloud_state()
            local_hash = self._state_hash(local_state)
            known_hash = str(profile_item.get("last_hash") or "")
            previous_etag = str(profile_item.get("last_etag") or "")
            remote_status, remote_etag = self._remote_probe(config, account_id)
            if remote_status not in {200, 404}:
                raise ValueError(f"读取坚果云数据失败（HTTP {remote_status}）")
            if remote_status == 200 and previous_etag and remote_etag and remote_etag == previous_etag:
                # The cloud file has not changed.  Avoid downloading megabytes
                # every 30 minutes merely to discover that fact.
                if known_hash and local_hash == known_hash:
                    profile_item.update({"last_synced_at": now_iso(), "last_error": ""})
                    self._write(config)
                    return {"ok": True, "action": "unchanged", "message": "两边数据已经是最新"}
                # The remote side is known unchanged, so a local edit can be
                # submitted directly without a redundant full download.
                uploaded = self._upload_state(config, account_id, local_state)
                _, uploaded_etag = self._remote_probe(config, account_id)
                profile_item.update({"last_hash": uploaded, "last_etag": uploaded_etag, "last_synced_at": now_iso(), "last_error": ""})
                self._write(config)
                return {"ok": True, "action": "uploaded", "message": "已将本机最新数据上传到坚果云"}

            remote_document, remote_document_hash = self._remote_state(config, account_id)
            remote_state = remote_document.get("state") if isinstance(remote_document, dict) else None
            if remote_document is None:
                uploaded = self._upload_state(config, account_id, local_state)
                _, uploaded_etag = self._remote_probe(config, account_id)
                profile_item.update({"last_hash": uploaded, "last_etag": uploaded_etag, "last_synced_at": now_iso(), "last_error": ""})
                self._write(config)
                return {"ok": True, "action": "uploaded", "message": "已将当前账号首次上传到坚果云"}
            if not isinstance(remote_state, dict):
                raise ValueError("坚果云中的手账数据格式不正确")
            # Existing installations stored a hash that included exported_at.
            # Convert it once so an unchanged account is not mistaken for an edit.
            if known_hash in {self._legacy_state_hash(local_state), self._legacy_state_hash(remote_state)}:
                known_hash = remote_document_hash if known_hash == self._legacy_state_hash(remote_state) else local_hash
            # A newly connected device treats the remote account as source of
            # truth. It avoids accidentally overwriting the cloud with its new
            # empty local profile.
            if not known_hash or resolution == "remote":
                database.import_cloud_state(remote_state)
                profile_item.update({"last_hash": remote_document_hash, "last_etag": remote_etag, "last_synced_at": now_iso(), "last_error": ""})
                self._write(config)
                return {"ok": True, "action": "downloaded", "message": "已从坚果云下载账号数据"}
            local_changed = local_hash != known_hash
            remote_changed = remote_document_hash != known_hash
            if local_changed and remote_changed and resolution != "local":
                merged_state = self.merge_record_states(local_state, remote_state)
                merged_hash = self._upload_state(config, account_id, merged_state)
                _, merged_etag = self._remote_probe(config, account_id)
                database.import_cloud_state(merged_state)
                profile_item.update({"last_hash": merged_hash, "last_etag": merged_etag, "last_synced_at": now_iso(), "last_error": ""})
                self._write(config)
                return {"ok": True, "action": "merged", "message": "已自动合并新增记录；同一番剧同一集保留较早观看时间"}
            if local_changed or resolution == "local":
                uploaded = self._upload_state(config, account_id, local_state)
                _, uploaded_etag = self._remote_probe(config, account_id)
                profile_item.update({"last_hash": uploaded, "last_etag": uploaded_etag, "last_synced_at": now_iso(), "last_error": ""})
                self._write(config)
                return {"ok": True, "action": "uploaded", "message": "已将本机最新数据上传到坚果云"}
            if remote_changed:
                database.import_cloud_state(remote_state)
                profile_item.update({"last_hash": remote_document_hash, "last_etag": remote_etag, "last_synced_at": now_iso(), "last_error": ""})
                self._write(config)
                return {"ok": True, "action": "downloaded", "message": "已下载坚果云最新数据"}
            profile_item.update({"last_hash": known_hash, "last_etag": remote_etag, "last_synced_at": now_iso(), "last_error": ""})
            self._write(config)
            return {"ok": True, "action": "unchanged", "message": "两边数据已经是最新"}

    def start_background(self, database_getter: Any) -> None:
        if self._thread and self._thread.is_alive():
            return
        def worker() -> None:
            while not self._stop.is_set():
                woke = self._wake.wait(30 * 60)
                if self._stop.is_set():
                    break
                if woke:
                    self._wake.clear()
                    continue
                self._wake.clear()
                try:
                    if self.status().get("configured") and self.status().get("auto_sync"):
                        self.sync(database_getter())
                except Exception as error:
                    with self._lock:
                        config = self._read()
                        self._profile_config(config)["last_error"] = str(error)[:240]
                        self._write(config)
        self._thread = threading.Thread(target=worker, name="webdav-sync", daemon=True)
        self._thread.start()


