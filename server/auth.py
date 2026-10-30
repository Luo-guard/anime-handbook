"""Persistent accounts, single-use invitations, and revocable sessions."""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import re
import secrets
import sqlite3
import time
from pathlib import Path


class Accounts:
    def __init__(self, root: Path):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "accounts.sqlite3"
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
                    salt TEXT NOT NULL, password TEXT NOT NULL, created_at REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS sessions (
                    token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
                    csrf TEXT NOT NULL, expires REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS login_attempts (
                    address TEXT NOT NULL, attempted REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS login_attempts_time ON login_attempts(attempted);
                CREATE TABLE IF NOT EXISTS invitations (
                    digest TEXT PRIMARY KEY, expires REAL NOT NULL,
                    used_by TEXT REFERENCES users(id), revoked INTEGER NOT NULL DEFAULT 0);
            """)
            if "role" not in {r[1] for r in db.execute("PRAGMA table_info(users)")}:
                db.execute("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def digest(password, salt):
        return hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()

    @staticmethod
    def validate(username, password):
        username = str(username).strip().lower()
        if not re.fullmatch(r"[a-z0-9_-]{3,40}", username) or username == "__demo__":
            raise ValueError("用户名需为 3～40 位英文字母、数字、下划线或短横线")
        if not 12 <= len(password) <= 200:
            raise ValueError("密码需为 12～200 个字符")
        return username

    def create(self, username, password):
        username = self.validate(username, password)
        uid, salt = secrets.token_hex(16), secrets.token_hex(16)
        with self.connect() as db:
            db.execute("INSERT INTO users(id,username,salt,password,created_at) VALUES (?,?,?,?,?)", (uid, username, salt, self.digest(password, salt), time.time()))
        return uid

    def throttle(self, address, scope, limit=20):
        now = time.time()
        key = scope + ":" + address
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM login_attempts WHERE attempted<?", (now - 900,))
            if db.execute("SELECT COUNT(*) FROM login_attempts WHERE address=?", (key,)).fetchone()[0] >= limit:
                raise PermissionError("尝试次数过多，请 15 分钟后重试")
            db.execute("INSERT INTO login_attempts VALUES (?,?)", (key, now))

    def create_invitation(self, days=7):
        if not 1 <= days <= 365:
            raise ValueError("有效天数需在 1～365 之间")
        code = secrets.token_urlsafe(24)
        with self.connect() as db:
            db.execute("INSERT INTO invitations(digest,expires) VALUES (?,?)", (hashlib.sha256(code.encode()).hexdigest(), time.time() + days * 86400))
        return code

    def revoke_invitation(self, code):
        with self.connect() as db:
            return db.execute("UPDATE invitations SET revoked=1 WHERE digest=?", (hashlib.sha256(code.strip().encode()).hexdigest(),)).rowcount > 0

    def register(self, username, password, code, address):
        self.throttle(address, "register", 10)
        username = self.validate(username, password)
        if len(code) > 200:
            raise ValueError("邀请码无效、已使用或已过期")
        uid, salt = secrets.token_hex(16), secrets.token_hex(16)
        hashed = self.digest(password, salt)
        with self.connect() as db:
            # Claim the invitation and create the account in one transaction.
            db.execute("BEGIN IMMEDIATE")
            invite = hashlib.sha256(code.strip().encode()).hexdigest()
            if not db.execute("SELECT 1 FROM invitations WHERE digest=? AND used_by IS NULL AND revoked=0 AND expires>?", (invite, time.time())).fetchone():
                raise ValueError("邀请码无效、已使用或已过期")
            try:
                db.execute("INSERT INTO users(id,username,salt,password,created_at) VALUES (?,?,?,?,?)", (uid, username, salt, hashed, time.time()))
            except sqlite3.IntegrityError as error:
                raise ValueError("用户名已被使用，请换一个") from error
            db.execute("UPDATE invitations SET used_by=? WHERE digest=?", (uid, invite))
        return self.issue_session(self.user(username))

    def demo_user(self):
        with self.connect() as db:
            # No usable password exists for the shared read-only identity.
            db.execute("INSERT OR IGNORE INTO users(id,username,salt,password,created_at,role) VALUES (?,?,?,?,?,?)", (secrets.token_hex(16), "__demo__", secrets.token_hex(16), "!", time.time(), "guest"))
        return self.user("__demo__")

    def guest(self, address):
        self.throttle(address, "guest", 40)
        return self.issue_session(self.demo_user(), lifetime=3600)

    def issue_session(self, user, lifetime=604800):
        token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        with self.connect() as db:
            db.execute("DELETE FROM sessions WHERE expires<?", (time.time(),))
            db.execute("INSERT INTO sessions VALUES (?,?,?,?)", (hashlib.sha256(token.encode()).hexdigest(), user["id"], csrf, time.time() + lifetime))
        return token, {**user, "csrf": csrf}

    def user(self, username):
        with self.connect() as db:
            row = db.execute("SELECT id,username,role FROM users WHERE username=?", (username.lower(),)).fetchone()
        if not row:
            raise ValueError("账号不存在")
        return dict(row)

    def login(self, username, password, address):
        if len(password) > 200:
            raise ValueError("用户名或密码错误")
        now = time.time()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM login_attempts WHERE attempted<?", (now - 900,))
            if db.execute("SELECT COUNT(*) FROM login_attempts WHERE address=?", (address,)).fetchone()[0] >= 20:
                raise PermissionError("尝试次数过多，请 15 分钟后重试")
            db.execute("INSERT INTO login_attempts VALUES (?,?)", (address, now))
            row = db.execute("SELECT * FROM users WHERE username=?", (str(username).lower(),)).fetchone()
        # Do the expensive hash even for unknown accounts.
        salt = row["salt"] if row else "00" * 16
        valid = secrets.compare_digest(self.digest(password, salt), row["password"] if row else "0" * 128)
        if not row or not valid or row["role"] != "member":
            raise ValueError("用户名或密码错误")
        return self.issue_session({k: row[k] for k in ("id", "username", "role")})

    def session(self, token):
        if not token or len(token) > 200:
            return None
        with self.connect() as db:
            row = db.execute("SELECT users.id,username,role,csrf FROM sessions JOIN users ON users.id=sessions.user_id WHERE token=? AND expires>?", (hashlib.sha256(token.encode()).hexdigest(), time.time())).fetchone()
        return dict(row) if row else None

    def logout(self, token):
        with self.connect() as db:
            db.execute("DELETE FROM sessions WHERE token=?", (hashlib.sha256(token.encode()).hexdigest(),))

    def reset_password(self, username, password):
        if not 12 <= len(password) <= 200:
            raise ValueError("密码需为 12～200 个字符")
        user = self.user(username)
        salt = secrets.token_hex(16)
        with self.connect() as db:
            db.execute("UPDATE users SET salt=?,password=? WHERE id=?", (salt, self.digest(password, salt), user["id"]))
            db.execute("DELETE FROM sessions WHERE user_id=?", (user["id"],))
