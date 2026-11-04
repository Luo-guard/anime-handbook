"""Local asset housekeeping for record images, backgrounds and backups.

Every sweep compares what is referenced now with what is stored on disk, so
nothing here needs the network.  Freshly written files are protected by a grace
period: an editor may upload a picture minutes before the note is saved, and a
theme may point at a background that is written slightly before the settings
row is committed.
"""
from __future__ import annotations

import time
import json
import re
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any, Iterable

from .common import BACKGROUND_ROOT, RECORD_IMAGE_ROOT, background_stem, safe_asset_id

# An uploaded image becomes referenced only when the note is saved.
RECORD_IMAGE_GRACE = 60 * 60
# A theme's background is uploaded before the profile row is persisted.
BACKGROUND_GRACE = 24 * 60 * 60
# Historical snapshots in data/backups; keep the newest few, report the rest.
BACKUP_KEEP = 5
BACKUP_DIR_KEEP = 2


def _stored_files(root: Path) -> list[Path]:
    try:
        return [path for path in root.iterdir() if path.is_file() and not path.is_symlink()]
    except OSError:
        return []


def _is_fresh(path: Path, cutoff: float) -> bool:
    try:
        return path.stat().st_mtime > cutoff
    except OSError:
        return True


def profile_asset_references(paths: dict[str, Path]) -> tuple[set[str], dict[str, dict[str, Any]]]:
    """Read every account without initializing/migrating any database.

    Errors deliberately propagate: incomplete knowledge must never authorize
    deletion from a directory shared by all accounts.
    """
    images: set[str] = set()
    settings: dict[str, dict[str, Any]] = {}
    pattern = re.compile(r"/api/record-images/([A-Za-z0-9_-]+\.(?:png|jpg|webp))")
    for account, path in paths.items():
        with closing(sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True, timeout=5)) as db:
            for row in db.execute("SELECT content, raw_directives FROM events"):
                for value in row:
                    images.update(pattern.findall(str(value or "")))
            settings[account] = {key: json.loads(value) for key, value in db.execute("SELECT key, value FROM settings")}
    return images, settings


def prune_record_images(
    database,
    *,
    root: Path | None = None,
    referenced_images: set[str] | None = None,
    grace: int = RECORD_IMAGE_GRACE,
    now: float | None = None,
) -> list[str]:
    """Delete record images that no note references any more."""
    directory = Path(root) if root is not None else RECORD_IMAGE_ROOT
    if not directory.is_dir():
        return []
    referenced = database.referenced_record_images() | (referenced_images or set())
    cutoff = (time.time() if now is None else now) - grace
    removed: list[str] = []
    for path in _stored_files(directory):
        if path.name in referenced or _is_fresh(path, cutoff):
            continue
        try:
            path.unlink()
        except OSError:
            continue
        removed.append(path.name)
    return removed


def background_stems(settings: dict[str, Any], accounts: Iterable[str]) -> set[str]:
    """Every filename stem a background may legitimately use.

    Covers the current ``background-<account>-<theme>`` layout and the older
    ``background-<theme>`` / ``background`` names, so an upgrade does not wipe
    an image the running browser still requests.
    """
    themes = {"default"}
    for profile in settings.get("theme_profiles") or []:
        if isinstance(profile, dict):
            themes.add(safe_asset_id(profile.get("id"), "default"))
    stems = {"background"}
    for theme in themes:
        stems.add(f"background-{theme}")
        for account in accounts:
            stems.add(background_stem(account, theme))
    return stems


def prune_backgrounds(
    settings: dict[str, Any],
    accounts: Iterable[str],
    *,
    root: Path | None = None,
    account_settings: dict[str, dict[str, Any]] | None = None,
    grace: int = BACKGROUND_GRACE,
    now: float | None = None,
) -> list[str]:
    """Delete backgrounds that belong to no account and no theme any more."""
    directory = Path(root) if root is not None else BACKGROUND_ROOT
    if not directory.is_dir():
        return []
    accounts = [str(account).strip() for account in accounts if str(account or "").strip()]
    if not accounts:
        # Never sweep without knowing which accounts exist: every namespaced
        # image would look like an orphan.
        return []
    if account_settings is not None:
        if not set(accounts).issubset(account_settings):
            return []
        stems = set().union(*(background_stems(value, [account]) for account, value in account_settings.items()))
    else:
        stems = background_stems(settings, accounts)
    cutoff = (time.time() if now is None else now) - grace
    removed: list[str] = []
    for path in _stored_files(directory):
        if path.stem in stems or _is_fresh(path, cutoff):
            continue
        try:
            path.unlink()
        except OSError:
            continue
        removed.append(path.name)
    return removed


def prune_backups(
    root: Path | None,
    *,
    keep: int = BACKUP_KEEP,
    keep_dirs: int = BACKUP_DIR_KEEP,
) -> dict[str, Any]:
    """Keep the newest ``keep`` database snapshots; report excess directories.

    Directories are never deleted automatically: they hold the hand-made
    ``before-...`` snapshots and losing one silently would be worse than the
    disk space.  They are reported so the log can mention them.
    """
    if root is None:
        return {"removed": [], "kept": 0, "stale_directories": []}
    directory = Path(root)
    if not directory.is_dir():
        return {"removed": [], "kept": 0, "stale_directories": []}
    try:
        entries = list(directory.iterdir())
    except OSError:
        return {"removed": [], "kept": 0, "stale_directories": []}

    def modified(path: Path) -> float:
        try:
            return path.stat().st_mtime
        except OSError:
            return 0.0

    databases = sorted(
        (path for path in entries if path.is_file() and path.suffix.lower() == ".db"),
        key=modified,
        reverse=True,
    )
    removed: list[str] = []
    for path in databases[max(0, keep):]:
        for suffix in ("-wal", "-shm"):
            sidecar = path.with_name(path.name + suffix)
            if sidecar.is_file():
                try:
                    sidecar.unlink()
                except OSError:
                    pass
        try:
            path.unlink()
        except OSError:
            continue
        removed.append(path.name)

    folders = sorted((path for path in entries if path.is_dir()), key=modified, reverse=True)
    stale = [path.name for path in folders[max(0, keep_dirs):]]
    return {
        "removed": removed,
        "kept": min(len(databases), max(0, keep)),
        "stale_directories": stale,
    }


def run_housekeeping(
    database,
    settings: dict[str, Any],
    accounts: Iterable[str],
    *,
    profile_paths: dict[str, Path] | None = None,
    backup_root: Path | None = None,
    record_root: Path | None = None,
    background_root: Path | None = None,
) -> dict[str, Any]:
    """One sweep over every local asset directory; safe to call on a timer."""
    accounts = list(accounts)
    images, all_settings = set(), None
    if profile_paths is not None:
        try:
            images, all_settings = profile_asset_references(profile_paths)
            if not set(accounts).issubset(all_settings):
                raise ValueError("Incomplete account inventory")
        except (OSError, sqlite3.Error, ValueError):
            # Backups have their own retention policy; shared assets stay intact.
            return {"record_images": [], "backgrounds": [], "backups": prune_backups(backup_root), "assets_skipped": True}
    return {
        "record_images": prune_record_images(database, root=record_root, referenced_images=images),
        "backgrounds": prune_backgrounds(settings, accounts, root=background_root, account_settings=all_settings),
        "backups": prune_backups(backup_root),
    }
