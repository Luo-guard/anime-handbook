
"""Offline administration. Passwords are prompted, never passed on the command line."""
from __future__ import annotations
from handbook import database

import argparse
import getpass
import json
import os
import re
import shutil
import sqlite3
from contextlib import closing
from pathlib import Path

from .auth import Accounts
from .runtime import Runtime, core


def import_local(runtime, accounts, username, source, assets_dir=None):
    """Read an existing desktop DB read-only, import only into an empty online account."""
    source = Path(source).resolve(strict=True)
    services = runtime.services(accounts.user(username))
    with services.lock:
        with services.database.connect() as db:
            if db.execute("SELECT COUNT(*) FROM anime").fetchone()[0] or db.execute("SELECT COUNT(*) FROM events").fetchone()[0]:
                raise ValueError("目标账号已有数据；请使用新的空账号，避免覆盖线上记录")
        with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as db:
            db.row_factory = sqlite3.Row
            db.execute("BEGIN")
            tables = {table: [dict(row) for row in db.execute(f'SELECT * FROM "{table}"')] for table in database.HandbookDB.CLOUD_TABLES}
        # Never migrate device bindings, credentials, custom network endpoints or auto-start.
        allowed_settings = set(services.database.get_settings()) - {
            "bgm_sources", "active_bgm_source", "bgm_api_base", "bgm_site_base", "launch_at_login",
            "bound_kazumi_path", "autostart_active", "pending_kazumi_completed_transitions", "top_sync_action"}
        tables["settings"] = [row for row in tables["settings"] if row["key"] in allowed_settings]
        services.database.import_cloud_state({"format": 1, "tables": tables})
        services.secure_settings()
        asset_root = Path(assets_dir).resolve() if assets_dir else source.parent
        source_account = "local"
        registry = asset_root / "profiles" / "registry.json"
        if registry.is_file():
            profiles = json.loads(registry.read_text("utf-8")).get("profiles", [])
            matched = [p for p in profiles if Path(str(p.get("database", ""))).resolve() == source]
            if len(matched) == 1:
                source_account = core.safe_asset_id(matched[0].get("id"), "local")
        # Only copy images referenced by this account, never another account's media.
        copied, missing = 0, []
        services.record_image_root.mkdir(parents=True, exist_ok=True)
        for name in services.database.referenced_record_images():
            p = asset_root / "record-images" / name
            if p.is_file() and not p.is_symlink():
                shutil.copy2(p, services.record_image_root / name)
                copied += 1
            else:
                missing.append(name)
        for theme in services.database.get_settings().get("theme_profiles", []):
            theme_id = core.safe_asset_id(theme.get("id"), "default")
            root = services.background_root
            p = core.find_background_asset(source_account, theme_id, root=asset_root / "background")
            if p and p.is_file() and not p.is_symlink():
                root.mkdir(parents=True, exist_ok=True)
                shutil.copy2(p, root / (core.background_stem(accounts.user(username)["id"], theme_id) + p.suffix))
        services.changed()
        return {"animes": len(tables["anime"]), "events": len(tables["events"]), "images_copied": copied, "missing_images": missing}


def main():
    parser = argparse.ArgumentParser(description="动漫手账线上账号管理；操作独立线上目录")
    parser.add_argument("--data-dir", type=Path, default=Path(os.environ.get("HANDBOOK_ONLINE_DATA", ".online-data")))
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("create-user", "reset-password"):
        commands.add_parser(name).add_argument("username")
    commands.add_parser("list-users")
    invite = commands.add_parser("create-invite")
    invite.add_argument("--days", type=int, default=7)
    commands.add_parser("revoke-invite").add_argument("code")
    imp = commands.add_parser("import-local")
    imp.add_argument("username")
    imp.add_argument("--source", type=Path, required=True, help="本机 handbook.db 的路径，只读")
    imp.add_argument("--assets-dir", type=Path, help="原本机 data 根目录；账号数据库在 profiles 子目录时需指定")
    args = parser.parse_args()
    runtime = Runtime(args.data_dir)
    accounts = Accounts(runtime.root)
    if args.command in {"create-user", "reset-password"}:
        password = getpass.getpass("密码（至少 12 位）: ")
        if password != getpass.getpass("再次输入密码: "):
            raise SystemExit("两次密码不一致")
        if args.command == "create-user":
            accounts.create(args.username, password)
        else:
            accounts.reset_password(args.username, password)
        print("账号已创建" if args.command == "create-user" else "密码已更新，旧登录已失效")
    elif args.command == "create-invite":
        print(accounts.create_invitation(args.days))
        print(f"单次使用，{args.days} 天有效；请私下发给朋友，数据库不保存明文。")
    elif args.command == "revoke-invite":
        print("邀请码已撤销" if accounts.revoke_invitation(args.code) else "邀请码不存在")
    elif args.command == "list-users":
        with accounts.connect() as db:
            for row in db.execute("SELECT username FROM users WHERE role='member' ORDER BY username"):
                print(row[0])
    else:
        print(json.dumps(import_local(runtime, accounts, args.username, args.source, args.assets_dir), ensure_ascii=False))


if __name__ == "__main__":
    main()
