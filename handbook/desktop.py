from __future__ import annotations

from typing import Any
from http.server import ThreadingHTTPServer
import os
import sys
import threading
import traceback
import urllib.request
import webbrowser
from .assets import run_housekeeping
from .common import (DATA_ROOT, HOST, PORT, migrate_legacy_backgrounds, path_identity)
from .database import HandbookDB
from .metadata import SyncService
from .related import AgeRelatedService
from .profiles import ProfileManager
from .sharing import SharingService
from .webdav import WebDAVSyncService
from .control import DesktopHTTPServer

PROFILES = ProfileManager()
DATABASE = HandbookDB(PROFILES.database_path())
SYNC = SyncService(DATABASE)
AGE = AgeRelatedService(DATABASE, SYNC)
SHARING = SharingService(PROFILES)
WEBDAV = WebDAVSyncService(PROFILES)

def activate_profile(profile_id: str) -> dict[str, Any]:
    """Switch the in-process data services to the selected local profile."""
    global DATABASE, SYNC, AGE
    profile = PROFILES.activate(profile_id)
    DATABASE = HandbookDB(PROFILES.database_path(profile_id))
    SYNC = SyncService(DATABASE)
    AGE = AgeRelatedService(DATABASE, SYNC)
    return profile


def active_profile_write_issue(*, bind_unbound: bool = True) -> str | None:
    """Return a friendly reason when this computer must not edit the profile.

    A shared snapshot deliberately has no local Kazumi binding, so it is always
    read-only.  Local profiles may write only when their saved Kazumi file is
    the same file discovered on this computer.  This check lives on the server
    side so a stale browser UI cannot bypass it.
    """
    profile = PROFILES.profile()
    if bool(profile.get("shared")):
        return "这是好友共享账号，只能查看；请切换回绑定本机 Kazumi 的账号后再修改。"
    local_kazumi = SyncService.find_kazumi_database()
    if local_kazumi is None:
        return None if not profile.get("kazumi_path") else "已绑定的 Kazumi 数据库暂不可用。"
    bound = str(profile.get("kazumi_path") or "").strip()
    if not bound:
        if bind_unbound:
            PROFILES.update(str(profile["id"]), kazumi_path=str(local_kazumi))
            return None
        return "当前账号尚未绑定 Kazumi 数据库，不能修改。"
    if path_identity(bound) != path_identity(local_kazumi):
        return "当前账号绑定的 Kazumi 路径与本机不一致，不能修改。"
    return None


def require_active_profile_write_access(*, bind_unbound: bool = True) -> None:
    issue = active_profile_write_issue(bind_unbound=bind_unbound)
    if issue:
        raise PermissionError(issue)


def server_is_running() -> bool:
    try:
        with urllib.request.urlopen(
            f"http://{HOST}:{PORT}/api/health", timeout=1
        ) as response:
            return response.status == 200
    except (OSError, urllib.error.URLError):
        return False


def should_open_browser(
    argv: list[str] | None = None,
    environ: dict[str, str] | None = None,
) -> bool:
    """Decide whether launching should also open a browser window.

    A scratch instance (tests, screenshots, diagnosing a copy of the data) must
    never steal focus or cover whatever the person is looking at.  Such runs are
    recognisable by ``ANIME_HANDBOOK_DATA_DIR``: the launcher never sets it, so
    normal double-click startup still opens the handbook.  ``--browser`` forces
    the window back for anyone using a custom data directory on purpose.
    """
    args = list(sys.argv[1:] if argv is None else argv)
    env = os.environ if environ is None else environ
    if "--browser" in args:
        return True
    if "--no-browser" in args:
        return False
    if str(env.get("ANIME_HANDBOOK_NO_BROWSER") or "").strip().lower() in {"1", "true", "yes", "on"}:
        return False
    if str(env.get("ANIME_HANDBOOK_DATA_DIR") or "").strip():
        return False
    return True


def _startup_repairs(database: HandbookDB, sync: SyncService) -> None:
    """Repair legacy rows and sweep assets *after* the window is already open.

    These steps used to run before the port was bound.  The episode-key repair
    calls Bangumi for every mismatch, so a slow or offline network left the
    launcher on a blank screen for tens of seconds.  None of it is needed to
    render the first page; when it finishes we bump the revision so the page
    reloads the collection exactly once.
    """
    try:
        migrate_legacy_backgrounds()
    except Exception:
        traceback.print_exc()
    try:
        database.recover_progress_from_watch_events(
            [int(item["id"]) for item in database.list_anime()]
        )
    except Exception:
        traceback.print_exc()
    try:
        sync.repair_legacy_watch_episode_keys()
    except Exception:
        traceback.print_exc()
    try:
        accounts = {str(profile.get("id") or "") for profile in PROFILES.list_profiles()}
        accounts.add("local")
        accounts.discard("")
        run_housekeeping(
            database,
            database.get_settings(),
            accounts,
            profile_paths={account: PROFILES.database_path(account) for account in accounts},
            backup_root=DATA_ROOT / "backups",
        )
    except Exception:
        traceback.print_exc()
    try:
        database._touch_revision()
    except Exception:
        traceback.print_exc()


def main(*, open_browser: bool = True) -> None:
    url = f"http://{HOST}:{PORT}"
    if server_is_running():
        if open_browser:
            webbrowser.open(url)
        return
    server = DesktopHTTPServer((HOST, PORT), busy=lambda: bool(SYNC.status.get("running")))
    from .kazumi_writeback import start_worker
    writeback_stop = threading.Event()
    start_worker(writeback_stop)
    SYNC.start_background()
    SHARING.start_resident_refresh()
    WEBDAV.start_background(lambda: DATABASE)
    # The window must come up first; repairs and asset sweeps run behind it.
    threading.Thread(
        target=_startup_repairs,
        args=(DATABASE, SYNC),
        name="handbook-startup-repairs",
        daemon=True,
    ).start()
    if open_browser:
        threading.Timer(0.35, lambda: webbrowser.open(url)).start()
    print(f"动漫手账已启动：{url}")
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        writeback_stop.set()
        # Stop periodic writers before waiting for outstanding requests/tasks.
        WEBDAV._stop.set()
        WEBDAV._wake.set()
        SHARING._stop.set()
        server.server_close()
        if WEBDAV._thread:
            WEBDAV._thread.join()
        if SHARING._thread:
            SHARING._thread.join()
        with SYNC._lock:
            pass


