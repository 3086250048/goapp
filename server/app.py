#!/usr/bin/env python3
"""Goapp backend: static PWA, REST API, SQLite persistence and real QR vouchers."""

from __future__ import annotations

import hashlib
import hmac
import io
import json
import math
import mimetypes
import os
import re
import secrets
import sqlite3
import threading
import uuid
from datetime import date, datetime, timedelta, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, unquote, urlencode, urlsplit
from urllib.request import Request, urlopen

import segno


BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "prototype"
ADMIN_STATIC_DIR = BASE_DIR / "admin"
APP_VERSION = "2.3.0"
SEED_FILE = Path(__file__).resolve().with_name("seed.json")
DATA_DIR = Path(os.getenv("DATA_DIR", str(BASE_DIR / "data")))
DB_FILE = DATA_DIR / "goapp.sqlite3"
PORT = int(os.getenv("PORT", "8080"))
DEMO_MODE = os.getenv("DEMO_MODE", "0") == "1"
DEMO_OTP = os.getenv("DEMO_OTP", "123456" if DEMO_MODE else "")
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "0") == "1"
ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "")
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "").rstrip("/")
SMS_PROVIDER = os.getenv("SMS_PROVIDER", "demo").strip().lower()
ALIYUN_ACCESS_KEY_ID = os.getenv("ALIYUN_ACCESS_KEY_ID", "")
ALIYUN_ACCESS_KEY_SECRET = os.getenv("ALIYUN_ACCESS_KEY_SECRET", "")
ALIYUN_SMS_SIGN_NAME = os.getenv("ALIYUN_SMS_SIGN_NAME", "")
ALIYUN_SMS_TEMPLATE_CODE = os.getenv("ALIYUN_SMS_TEMPLATE_CODE", "")
AMAP_WEB_SERVICE_KEY = os.getenv("AMAP_WEB_SERVICE_KEY", "")
WECHAT_APP_ID = os.getenv("WECHAT_APP_ID", "")
WECHAT_APP_SECRET = os.getenv("WECHAT_APP_SECRET", "")
WECHAT_REDIRECT_URI = os.getenv("WECHAT_REDIRECT_URI", "")
QQ_APP_ID = os.getenv("QQ_APP_ID", "")
QQ_APP_SECRET = os.getenv("QQ_APP_SECRET", "")
QQ_REDIRECT_URI = os.getenv("QQ_REDIRECT_URI", "")
SESSION_DAYS = 30
ADMIN_SESSION_HOURS = 12
OAUTH_STATE_MINUTES = 10
OAUTH_PENDING_MINUTES = 15
OTP_MINUTES = 10
PHONE_RE = re.compile(r"^1[3-9]\d{9}$")

with SEED_FILE.open(encoding="utf-8") as seed_handle:
    SEED = json.load(seed_handle)

TAXONOMY = SEED["TAXONOMY"]

DB_INIT_LOCK = threading.Lock()
DB_INITIALIZED = False
ADMIN_LOGIN_LOCK = threading.Lock()
ADMIN_LOGIN_FAILURES: dict[str, list[datetime]] = {}


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def today_local() -> date:
    return datetime.now().astimezone().date()


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_FILE, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 10000")
    return conn


def initialize_database() -> None:
    global DB_INITIALIZED
    if DB_INITIALIZED:
        return
    with DB_INIT_LOCK:
        if DB_INITIALIZED:
            return
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        conn = db()
        try:
            conn.executescript(
                """
                PRAGMA journal_mode = WAL;

                CREATE TABLE IF NOT EXISTS trips (
                    id TEXT PRIMARY KEY,
                    payload TEXT NOT NULL,
                    active INTEGER NOT NULL DEFAULT 1,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    phone TEXT NOT NULL UNIQUE,
                    nickname TEXT NOT NULL,
                    hobby_json TEXT NOT NULL DEFAULT '[]',
                    personality_json TEXT NOT NULL DEFAULT '[]',
                    occupation TEXT,
                    gender TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS otp_challenges (
                    id TEXT PRIMARY KEY,
                    phone TEXT NOT NULL,
                    code_hash TEXT NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    consumed_at TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_otp_phone_created
                    ON otp_challenges(phone, created_at DESC);

                CREATE TABLE IF NOT EXISTS addresses (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    tag TEXT NOT NULL,
                    name TEXT NOT NULL,
                    address TEXT NOT NULL,
                    detail TEXT NOT NULL DEFAULT '',
                    is_default INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_addresses_user
                    ON addresses(user_id, is_default DESC, created_at);

                CREATE TABLE IF NOT EXISTS orders (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    order_no TEXT NOT NULL UNIQUE,
                    trip_id TEXT NOT NULL,
                    trip_title TEXT NOT NULL,
                    tags_json TEXT NOT NULL,
                    cover_json TEXT NOT NULL,
                    stop_count INTEGER NOT NULL,
                    duration_hours INTEGER NOT NULL,
                    travel_date TEXT NOT NULL,
                    people INTEGER NOT NULL,
                    total INTEGER NOT NULL,
                    per_person INTEGER NOT NULL,
                    address_json TEXT NOT NULL,
                    channel TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_orders_user_created
                    ON orders(user_id, created_at DESC);

                CREATE TABLE IF NOT EXISTS vouchers (
                    id TEXT PRIMARY KEY,
                    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
                    seq INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    type TEXT NOT NULL,
                    code TEXT NOT NULL UNIQUE,
                    redeem_code TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'unused',
                    used_at TEXT,
                    note TEXT NOT NULL,
                    UNIQUE(order_id, seq)
                );

                CREATE INDEX IF NOT EXISTS idx_vouchers_order
                    ON vouchers(order_id, seq);

                CREATE TABLE IF NOT EXISTS taxonomy_tags (
                    id TEXT PRIMARY KEY,
                    group_name TEXT NOT NULL,
                    code TEXT NOT NULL,
                    label TEXT NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(group_name, code)
                );

                CREATE INDEX IF NOT EXISTS idx_taxonomy_group_sort
                    ON taxonomy_tags(group_name, enabled DESC, sort_order, label);

                CREATE TABLE IF NOT EXISTS admin_sessions (
                    token_hash TEXT PRIMARY KEY,
                    admin_name TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry
                    ON admin_sessions(expires_at);

                CREATE TABLE IF NOT EXISTS admin_audit (
                    id TEXT PRIMARY KEY,
                    admin_name TEXT NOT NULL,
                    action TEXT NOT NULL,
                    target_type TEXT NOT NULL,
                    target_id TEXT,
                    details_json TEXT NOT NULL,
                    ip TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_admin_audit_created
                    ON admin_audit(created_at DESC);

                CREATE TABLE IF NOT EXISTS oauth_identities (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    provider TEXT NOT NULL,
                    openid TEXT NOT NULL,
                    unionid TEXT,
                    nickname TEXT,
                    avatar_url TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(provider, openid)
                );

                CREATE INDEX IF NOT EXISTS idx_oauth_identity_user
                    ON oauth_identities(user_id, provider);

                CREATE TABLE IF NOT EXISTS oauth_states (
                    state_hash TEXT PRIMARY KEY,
                    provider TEXT NOT NULL,
                    return_to TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS oauth_pending (
                    token_hash TEXT PRIMARY KEY,
                    provider TEXT NOT NULL,
                    openid TEXT NOT NULL,
                    unionid TEXT,
                    nickname TEXT,
                    avatar_url TEXT,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    UNIQUE(provider, openid)
                );
                """
            )
            trip_columns = {
                row["name"] for row in conn.execute("PRAGMA table_info(trips)").fetchall()
            }
            if "sort_order" not in trip_columns:
                conn.execute(
                    "ALTER TABLE trips ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0"
                )
            address_columns = {
                row["name"]
                for row in conn.execute("PRAGMA table_info(addresses)").fetchall()
            }
            if "longitude" not in address_columns:
                conn.execute("ALTER TABLE addresses ADD COLUMN longitude REAL")
            if "latitude" not in address_columns:
                conn.execute("ALTER TABLE addresses ADD COLUMN latitude REAL")
            updated_at = now_iso()
            for sort_order, trip in enumerate(SEED["TRIPS"]):
                conn.execute(
                    """
                    INSERT OR IGNORE INTO trips(id, payload, active, sort_order, updated_at)
                    VALUES (?, ?, 1, ?, ?)
                    """,
                    (
                        trip["id"],
                        json.dumps(trip, ensure_ascii=False),
                        sort_order,
                        updated_at,
                    ),
                )
                conn.execute(
                    """
                    UPDATE trips SET sort_order = ?
                    WHERE id = ? AND sort_order = 0
                    """,
                    (sort_order, trip["id"]),
                )
            for group_name, group in TAXONOMY.items():
                for sort_order, option in enumerate(group["options"]):
                    code, label = option
                    conn.execute(
                        """
                        INSERT OR IGNORE INTO taxonomy_tags(
                            id, group_name, code, label, enabled, sort_order,
                            created_at, updated_at
                        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
                        """,
                        (
                            uuid.uuid4().hex,
                            group_name,
                            code,
                            label,
                            sort_order,
                            updated_at,
                            updated_at,
                        ),
                    )
            conn.commit()
        finally:
            conn.close()
        DB_INITIALIZED = True


def hash_token(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def random_code(length: int = 16) -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(length))


def random_numeric(length: int = 8) -> str:
    return "".join(str(secrets.randbelow(10)) for _ in range(length))


def order_number() -> str:
    stamp = datetime.now().strftime("%Y%m%d%H%M%S")
    return f"TT{stamp}{secrets.randbelow(900) + 100}"


def parse_json(value: str | None, fallback):
    try:
        return json.loads(value) if value else fallback
    except (TypeError, json.JSONDecodeError):
        return fallback


TAG_GROUPS = ("hobby", "personality", "occupation", "gender")


def taxonomy_from_db(conn: sqlite3.Connection) -> dict:
    taxonomy = {}
    for group_name in TAG_GROUPS:
        base = TAXONOMY[group_name]
        rows = conn.execute(
            """
            SELECT code, label FROM taxonomy_tags
            WHERE group_name = ? AND enabled = 1
            ORDER BY sort_order, label
            """,
            (group_name,),
        ).fetchall()
        taxonomy[group_name] = {
            "title": base["title"],
            "hint": base["hint"],
            "mode": base["mode"],
            "max": base["max"],
            "min": base.get("min", 0),
            "options": [[row["code"], row["label"]] for row in rows],
        }
    return taxonomy


def all_tag_codes(conn: sqlite3.Connection) -> dict[str, set[str]]:
    result = {group: set() for group in TAG_GROUPS}
    rows = conn.execute("SELECT group_name, code FROM taxonomy_tags").fetchall()
    for row in rows:
        if row["group_name"] in result:
            result[row["group_name"]].add(row["code"])
    return result


def tag_usage_map(conn: sqlite3.Connection) -> dict[tuple[str, str], int]:
    usage = {}
    for user in conn.execute(
        "SELECT hobby_json, personality_json, occupation, gender FROM users"
    ).fetchall():
        values = {
            "hobby": parse_json(user["hobby_json"], []),
            "personality": parse_json(user["personality_json"], []),
            "occupation": [user["occupation"]] if user["occupation"] else [],
            "gender": [user["gender"]] if user["gender"] else [],
        }
        for group_name, codes in values.items():
            for code in codes:
                key = (group_name, code)
                usage[key] = usage.get(key, 0) + 1
    return usage


def trip_rows(
    conn: sqlite3.Connection, active_only: bool = True
) -> list[dict]:
    where = " WHERE active = 1" if active_only else ""
    rows = conn.execute(
        "SELECT * FROM trips" + where + " ORDER BY sort_order, updated_at DESC"
    ).fetchall()
    result = []
    for row in rows:
        payload = parse_json(row["payload"], {})
        payload["id"] = row["id"]
        payload["sortOrder"] = row["sort_order"]
        payload["active"] = bool(row["active"])
        payload["updatedAt"] = row["updated_at"]
        result.append(payload)
    return result


def trip_by_id(
    conn: sqlite3.Connection, trip_id: str, active_only: bool = True
) -> dict | None:
    sql = "SELECT * FROM trips WHERE id = ?"
    params = [trip_id]
    if active_only:
        sql += " AND active = 1"
    row = conn.execute(sql, params).fetchone()
    if not row:
        return None
    payload = parse_json(row["payload"], {})
    payload["id"] = row["id"]
    payload["sortOrder"] = row["sort_order"]
    payload["active"] = bool(row["active"])
    payload["updatedAt"] = row["updated_at"]
    return payload


def trip_stats(trip: dict, people: int) -> dict:
    pp = 0
    gp = 0
    for stop in trip["stops"]:
        for item in stop["items"]:
            if item["mode"] == "gp":
                gp += int(item["price"])
            else:
                pp += int(item["price"])
    rate = 0.85 if people >= 5 else 0.9 if people >= 4 else 1
    total = math.floor(pp * people * rate + 0.5) + gp
    return {
        "pp": pp,
        "gp": gp,
        "rate": rate,
        "total": total,
        "perPerson": math.floor(total / people + 0.5),
    }


def sms_configured() -> bool:
    if SMS_PROVIDER == "demo":
        return DEMO_MODE
    if SMS_PROVIDER == "aliyun":
        return all(
            (
                ALIYUN_ACCESS_KEY_ID,
                ALIYUN_ACCESS_KEY_SECRET,
                ALIYUN_SMS_SIGN_NAME,
                ALIYUN_SMS_TEMPLATE_CODE,
            )
        )
    return False


def oauth_provider_configured(provider: str) -> bool:
    if provider == "wechat":
        return bool(WECHAT_APP_ID and WECHAT_APP_SECRET)
    if provider == "qq":
        return bool(QQ_APP_ID and QQ_APP_SECRET)
    return False


def amap_configured() -> bool:
    return bool(AMAP_WEB_SERVICE_KEY)


def http_json(url: str, params: dict, timeout: int = 12) -> dict:
    request = Request(
        f"{url}?{urlencode(params)}",
        headers={"Accept": "application/json", "User-Agent": "Goapp/2.3"},
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise ValueError(f"第三方服务请求失败：{exc}") from exc
    if not isinstance(payload, dict):
        raise ValueError("第三方服务返回格式错误")
    return payload


def send_aliyun_sms(phone: str, code: str, out_id: str) -> None:
    try:
        from alibabacloud_dysmsapi20170525 import models as sms_models
        from alibabacloud_dysmsapi20170525.client import Client as SmsClient
        from alibabacloud_tea_openapi import models as open_api_models
        from alibabacloud_tea_util import models as util_models

        config = open_api_models.Config(
            access_key_id=ALIYUN_ACCESS_KEY_ID,
            access_key_secret=ALIYUN_ACCESS_KEY_SECRET,
        )
        config.endpoint = "dysmsapi.aliyuncs.com"
        client = SmsClient(config)
        request = sms_models.SendSmsRequest(
            phone_numbers=phone,
            sign_name=ALIYUN_SMS_SIGN_NAME,
            template_code=ALIYUN_SMS_TEMPLATE_CODE,
            template_param=json.dumps({"code": code}, separators=(",", ":")),
            out_id=out_id[:64],
        )
        response = client.send_sms_with_options(request, util_models.RuntimeOptions())
        if response.body.code != "OK":
            raise ValueError(response.body.message or "短信发送失败")
    except ImportError as exc:
        raise ValueError("阿里云短信 SDK 未安装") from exc
    except Exception as exc:
        raise ValueError(f"短信服务请求失败：{exc}") from exc


def public_integrations() -> dict:
    return {
        "sms": {
            "provider": SMS_PROVIDER,
            "enabled": sms_configured(),
            "demo": SMS_PROVIDER == "demo" and DEMO_MODE,
        },
        "amap": {"enabled": amap_configured()},
        "wechat": {"enabled": oauth_provider_configured("wechat")},
        "qq": {"enabled": oauth_provider_configured("qq")},
    }


def iso_or_blank(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


class AppHandler(BaseHTTPRequestHandler):
    server_version = f"Goapp/{APP_VERSION}"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        print(
            f'{self.client_address[0]} [{self.log_date_time_string()}] '
            f"{fmt % args}",
            flush=True,
        )

    def do_GET(self) -> None:
        self.dispatch("GET")

    def do_HEAD(self) -> None:
        self.dispatch("HEAD")

    def do_POST(self) -> None:
        self.dispatch("POST")

    def do_PATCH(self) -> None:
        self.dispatch("PATCH")

    def do_DELETE(self) -> None:
        self.dispatch("DELETE")

    def dispatch(self, method: str) -> None:
        initialize_database()
        try:
            path = urlsplit(self.path).path
            if path.startswith("/api/"):
                self.handle_api(method, path)
            elif path == "/admin":
                self.send_response(HTTPStatus.PERMANENT_REDIRECT)
                self.send_header("Location", "/admin/")
                self.send_header("Content-Length", "0")
                self.end_headers()
            elif method in ("GET", "HEAD"):
                self.serve_static(path, head_only=method == "HEAD")
            else:
                self.send_json({"error": "Method not allowed"}, 405)
        except BrokenPipeError:
            return
        except Exception as exc:
            print(f"Unhandled request error: {exc!r}", flush=True)
            if not self.wfile.closed:
                self.send_json({"error": "服务暂时不可用"}, 500)

    def read_json(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length > 1_000_000:
            raise ValueError("请求体过大")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError("请求格式错误") from None
        if not isinstance(value, dict):
            raise ValueError("请求格式错误")
        return value

    def send_json(self, payload, status: int = 200, headers: dict | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8"
        )
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if headers:
            for key, value in headers.items():
                if isinstance(value, (list, tuple)):
                    for item in value:
                        self.send_header(key, item)
                else:
                    self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_bytes(
        self,
        body: bytes,
        content_type: str,
        status: int = 200,
        cache: str = "no-cache",
        extra_headers: dict | None = None,
        head_only: bool = False,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        if extra_headers:
            for key, value in extra_headers.items():
                self.send_header(key, value)
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def serve_static(self, request_path: str, head_only: bool = False) -> None:
        if request_path.startswith("/admin/"):
            static_root = ADMIN_STATIC_DIR
            rel = unquote(request_path[len("/admin/") :]).lstrip("/")
        else:
            static_root = STATIC_DIR
            rel = unquote(request_path).lstrip("/")
        if not rel or rel.endswith("/"):
            rel += "index.html"
        candidate = (static_root / rel).resolve()
        try:
            candidate.relative_to(static_root.resolve())
        except ValueError:
            self.send_json({"error": "Not found"}, 404)
            return
        if not candidate.is_file():
            if "." not in Path(rel).name:
                candidate = static_root / "index.html"
            else:
                self.send_json({"error": "Not found"}, 404)
                return
        body = candidate.read_bytes()
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        if candidate.suffix == ".webmanifest":
            content_type = "application/manifest+json"
        cache = "no-store" if candidate.name == "sw.js" else "no-cache"
        if candidate.parent.name == "icons":
            cache = "public, max-age=86400"
        self.send_bytes(
            body,
            content_type,
            cache=cache,
            extra_headers={"X-Frame-Options": "SAMEORIGIN"},
            head_only=head_only,
        )

    def cookies(self) -> SimpleCookie:
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except Exception:
            pass
        return cookie

    def current_user(self, conn: sqlite3.Connection) -> sqlite3.Row | None:
        cookie = self.cookies()
        morsel = cookie.get("goapp_session")
        if not morsel:
            return None
        token_hash = hash_token(morsel.value)
        row = conn.execute(
            """
            SELECT u.* FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ? AND s.expires_at > ?
            """,
            (token_hash, now_iso()),
        ).fetchone()
        return row

    def create_session(self, conn: sqlite3.Connection, user_id: str) -> tuple[str, str]:
        token = secrets.token_urlsafe(36)
        now = datetime.now(timezone.utc)
        expires = now + timedelta(days=SESSION_DAYS)
        conn.execute(
            "INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (hash_token(token), user_id, now_iso(), expires.replace(microsecond=0).isoformat()),
        )
        parts = [
            f"goapp_session={token}",
            "Path=/",
            "HttpOnly",
            "SameSite=Lax",
            f"Max-Age={SESSION_DAYS * 86400}",
        ]
        if COOKIE_SECURE:
            parts.append("Secure")
        return token, "; ".join(parts)

    def clear_session(self, conn: sqlite3.Connection) -> str:
        cookie = self.cookies()
        morsel = cookie.get("goapp_session")
        if morsel:
            conn.execute("DELETE FROM sessions WHERE token_hash = ?", (hash_token(morsel.value),))
        parts = ["goapp_session=", "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"]
        if COOKIE_SECURE:
            parts.append("Secure")
        return "; ".join(parts)

    def external_base_url(self) -> str:
        if PUBLIC_BASE_URL:
            return PUBLIC_BASE_URL
        host = self.headers.get("Host", "").strip()
        proto = self.headers.get("X-Forwarded-Proto", "").split(",")[0].strip()
        if not proto:
            proto = "https" if host and not host.startswith(("127.", "localhost")) else "http"
        return f"{proto}://{host}" if host else "http://127.0.0.1"

    def oauth_redirect_uri(self, provider: str) -> str:
        configured = WECHAT_REDIRECT_URI if provider == "wechat" else QQ_REDIRECT_URI
        return configured or (
            f"{self.external_base_url()}/api/auth/oauth/{provider}/callback"
        )

    def send_redirect(self, location: str, cookies: list[str] | None = None) -> None:
        self.send_response(HTTPStatus.FOUND)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        for cookie in cookies or []:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()

    def oauth_start(self, conn: sqlite3.Connection, provider: str) -> None:
        if not oauth_provider_configured(provider):
            name = "微信" if provider == "wechat" else "QQ"
            self.send_json({"error": f"{name}登录尚未配置"}, 503)
            return
        return_to = self.query_value("return_to", "/")
        if not return_to.startswith("/") or return_to.startswith("//"):
            return_to = "/"
        state = secrets.token_urlsafe(32)
        now = datetime.now(timezone.utc)
        conn.execute(
            """
            INSERT INTO oauth_states(
                state_hash, provider, return_to, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (
                hash_token(state),
                provider,
                return_to,
                now.replace(microsecond=0).isoformat(),
                (now + timedelta(minutes=OAUTH_STATE_MINUTES))
                .replace(microsecond=0)
                .isoformat(),
            ),
        )
        conn.commit()
        redirect_uri = self.oauth_redirect_uri(provider)
        if provider == "wechat":
            params = {
                "appid": WECHAT_APP_ID,
                "redirect_uri": redirect_uri,
                "response_type": "code",
                "scope": "snsapi_login",
                "state": state,
            }
            url = (
                "https://open.weixin.qq.com/connect/qrconnect?"
                + urlencode(params)
                + "#wechat_redirect"
            )
        else:
            params = {
                "response_type": "code",
                "client_id": QQ_APP_ID,
                "redirect_uri": redirect_uri,
                "state": state,
                "scope": "get_user_info",
                "display": "mobile",
            }
            url = "https://graph.qq.com/oauth2.0/authorize?" + urlencode(params)
        self.send_redirect(url)

    def exchange_wechat_identity(self, code: str) -> dict:
        token = http_json(
            "https://api.weixin.qq.com/sns/oauth2/access_token",
            {
                "appid": WECHAT_APP_ID,
                "secret": WECHAT_APP_SECRET,
                "code": code,
                "grant_type": "authorization_code",
            },
        )
        if token.get("errcode"):
            raise ValueError(token.get("errmsg") or "微信授权失败")
        openid = str(token.get("openid", ""))
        if not openid:
            raise ValueError("微信未返回 openid")
        profile = http_json(
            "https://api.weixin.qq.com/sns/userinfo",
            {
                "access_token": token["access_token"],
                "openid": openid,
                "lang": "zh_CN",
            },
        )
        if profile.get("errcode"):
            raise ValueError(profile.get("errmsg") or "微信用户信息获取失败")
        return {
            "openid": openid,
            "unionid": token.get("unionid") or profile.get("unionid"),
            "nickname": profile.get("nickname") or "",
            "avatar": profile.get("headimgurl") or "",
        }

    def exchange_qq_identity(self, code: str) -> dict:
        token = http_json(
            "https://graph.qq.com/oauth2.0/token",
            {
                "grant_type": "authorization_code",
                "client_id": QQ_APP_ID,
                "client_secret": QQ_APP_SECRET,
                "code": code,
                "redirect_uri": self.oauth_redirect_uri("qq"),
                "fmt": "json",
            },
        )
        if token.get("error"):
            raise ValueError(token.get("error_description") or "QQ 授权失败")
        access_token = str(token.get("access_token", ""))
        if not access_token:
            raise ValueError("QQ 未返回 access_token")
        identity = http_json(
            "https://graph.qq.com/oauth2.0/me",
            {"access_token": access_token, "fmt": "json"},
        )
        openid = str(identity.get("openid", ""))
        if not openid:
            raise ValueError("QQ 未返回 openid")
        profile = http_json(
            "https://graph.qq.com/user/get_user_info",
            {
                "access_token": access_token,
                "oauth_consumer_key": QQ_APP_ID,
                "openid": openid,
            },
        )
        if profile.get("ret") not in (0, "0", None):
            raise ValueError(profile.get("msg") or "QQ 用户信息获取失败")
        return {
            "openid": openid,
            "unionid": None,
            "nickname": profile.get("nickname") or "",
            "avatar": profile.get("figureurl_qq_2") or "",
        }

    def oauth_callback(self, conn: sqlite3.Connection, provider: str) -> None:
        if self.query_value("error"):
            self.send_redirect("/?oauth=error#/register")
            return
        state = self.query_value("state")
        code = self.query_value("code")
        state_row = conn.execute(
            "SELECT * FROM oauth_states WHERE state_hash = ? AND provider = ?",
            (hash_token(state), provider),
        ).fetchone()
        if (
            not state_row
            or state_row["expires_at"] <= now_iso()
            or not code
            or not oauth_provider_configured(provider)
        ):
            self.send_redirect("/?oauth=invalid#/register")
            return
        conn.execute(
            "DELETE FROM oauth_states WHERE state_hash = ?",
            (state_row["state_hash"],),
        )
        try:
            identity = (
                self.exchange_wechat_identity(code)
                if provider == "wechat"
                else self.exchange_qq_identity(code)
            )
        except ValueError as exc:
            print(f"OAuth {provider} failed: {exc}", flush=True)
            conn.commit()
            self.send_redirect("/?oauth=error#/register")
            return
        linked = conn.execute(
            "SELECT * FROM oauth_identities WHERE provider = ? AND openid = ?",
            (provider, identity["openid"]),
        ).fetchone()
        if linked:
            conn.execute(
                """
                UPDATE oauth_identities SET unionid = ?, nickname = ?,
                    avatar_url = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    identity.get("unionid"),
                    identity.get("nickname"),
                    identity.get("avatar"),
                    now_iso(),
                    linked["id"],
                ),
            )
            user = conn.execute(
                "SELECT * FROM users WHERE id = ?", (linked["user_id"],)
            ).fetchone()
            token, cookie = self.create_session(conn, user["id"])
            conn.commit()
            self.send_redirect("/?oauth=ok#/home", [cookie])
            return
        pending_token = secrets.token_urlsafe(32)
        expires = datetime.now(timezone.utc) + timedelta(minutes=OAUTH_PENDING_MINUTES)
        conn.execute(
            """
            INSERT INTO oauth_pending(
                token_hash, provider, openid, unionid, nickname,
                avatar_url, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(provider, openid) DO UPDATE SET
                token_hash = excluded.token_hash,
                unionid = excluded.unionid,
                nickname = excluded.nickname,
                avatar_url = excluded.avatar_url,
                created_at = excluded.created_at,
                expires_at = excluded.expires_at
            """,
            (
                hash_token(pending_token),
                provider,
                identity["openid"],
                identity.get("unionid"),
                identity.get("nickname"),
                identity.get("avatar"),
                now_iso(),
                expires.replace(microsecond=0).isoformat(),
            ),
        )
        conn.commit()
        parts = [
            f"goapp_oauth_pending={pending_token}",
            "Path=/",
            "HttpOnly",
            "SameSite=Lax",
            f"Max-Age={OAUTH_PENDING_MINUTES * 60}",
        ]
        if COOKIE_SECURE:
            parts.append("Secure")
        self.send_redirect("/?oauth=bind#/register", ["; ".join(parts)])

    def bind_pending_oauth(
        self, conn: sqlite3.Connection, user: sqlite3.Row
    ) -> str | None:
        morsel = self.cookies().get("goapp_oauth_pending")
        if not morsel:
            return None
        pending = conn.execute(
            """
            SELECT * FROM oauth_pending
            WHERE token_hash = ? AND expires_at > ?
            """,
            (hash_token(morsel.value), now_iso()),
        ).fetchone()
        if not pending:
            return None
        linked = conn.execute(
            """
            SELECT * FROM oauth_identities
            WHERE provider = ? AND openid = ?
            """,
            (pending["provider"], pending["openid"]),
        ).fetchone()
        now = now_iso()
        if not linked:
            conn.execute(
                """
                INSERT INTO oauth_identities(
                    id, user_id, provider, openid, unionid, nickname,
                    avatar_url, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    uuid.uuid4().hex,
                    user["id"],
                    pending["provider"],
                    pending["openid"],
                    pending["unionid"],
                    pending["nickname"],
                    pending["avatar_url"],
                    now,
                    now,
                ),
            )
        elif linked["user_id"] == user["id"]:
            conn.execute(
                """
                UPDATE oauth_identities SET unionid = ?, nickname = ?,
                    avatar_url = ?, updated_at = ? WHERE id = ?
                """,
                (
                    pending["unionid"],
                    pending["nickname"],
                    pending["avatar_url"],
                    now,
                    linked["id"],
                ),
            )
        conn.execute(
            "DELETE FROM oauth_pending WHERE token_hash = ?",
            (hash_token(morsel.value),),
        )
        parts = [
            "goapp_oauth_pending=",
            "Path=/",
            "HttpOnly",
            "SameSite=Lax",
            "Max-Age=0",
        ]
        if COOKIE_SECURE:
            parts.append("Secure")
        return "; ".join(parts)

    def location_search(self, conn: sqlite3.Connection) -> None:
        if not self.require_user(conn):
            return
        if not amap_configured():
            self.send_json({"error": "高德地图尚未配置"}, 503)
            return
        keywords = self.query_value("keywords").strip()
        if not keywords:
            self.send_json({"error": "请输入地点关键词"}, 400)
            return
        params = {
            "key": AMAP_WEB_SERVICE_KEY,
            "keywords": keywords,
            "city_limit": "false",
            "page_size": "20",
            "page_num": "1",
        }
        city = self.query_value("city").strip()
        if city:
            params["region"] = city
        payload = http_json("https://restapi.amap.com/v5/place/text", params)
        if payload.get("status") != "1":
            self.send_json({"error": payload.get("info") or "高德地点搜索失败"}, 502)
            return
        self.send_json(
            {
                "items": [
                    {
                        "id": poi.get("id", ""),
                        "name": poi.get("name", ""),
                        "address": poi.get("address", ""),
                        "district": poi.get("adname", ""),
                        "city": poi.get("cityname", ""),
                        "location": poi.get("location", ""),
                        "distance": poi.get("distance", ""),
                        "type": poi.get("type", ""),
                    }
                    for poi in payload.get("pois", [])
                ]
            }
        )

    def amap_gcj_location(self, longitude: str, latitude: str, coordsys: str) -> str:
        location = f"{longitude},{latitude}"
        if coordsys != "gps":
            return location
        payload = http_json(
            "https://restapi.amap.com/v3/assistant/coordinate/convert",
            {
                "key": AMAP_WEB_SERVICE_KEY,
                "locations": location,
                "coordsys": "gps",
            },
        )
        if payload.get("status") != "1":
            raise ValueError(payload.get("info") or "坐标转换失败")
        return str(payload.get("locations") or location)

    def location_reverse(self, conn: sqlite3.Connection) -> None:
        if not self.require_user(conn):
            return
        if not amap_configured():
            self.send_json({"error": "高德地图尚未配置"}, 503)
            return
        longitude = self.query_value("lng")
        latitude = self.query_value("lat")
        if not re.fullmatch(r"-?\d+(?:\.\d+)?", longitude) or not re.fullmatch(
            r"-?\d+(?:\.\d+)?", latitude
        ):
            self.send_json({"error": "经纬度格式错误"}, 400)
            return
        try:
            location = self.amap_gcj_location(
                longitude, latitude, self.query_value("coordsys", "gcj")
            )
        except ValueError as exc:
            self.send_json({"error": str(exc)}, 502)
            return
        payload = http_json(
            "https://restapi.amap.com/v3/geocode/regeo",
            {
                "key": AMAP_WEB_SERVICE_KEY,
                "location": location,
                "extensions": "base",
            },
        )
        if payload.get("status") != "1":
            self.send_json({"error": payload.get("info") or "逆地理编码失败"}, 502)
            return
        regeocode = payload.get("regeocode") or {}
        address = regeocode.get("formatted_address") or ""
        self.send_json(
            {
                "address": address,
                "location": location,
                "pois": (regeocode.get("pois") or [])[:8],
            }
        )

    def location_static(self, conn: sqlite3.Connection) -> None:
        if not self.require_user(conn):
            return
        if not amap_configured():
            self.send_json({"error": "高德地图尚未配置"}, 503)
            return
        longitude = self.query_value("lng")
        latitude = self.query_value("lat")
        if not re.fullmatch(r"-?\d+(?:\.\d+)?", longitude) or not re.fullmatch(
            r"-?\d+(?:\.\d+)?", latitude
        ):
            self.send_json({"error": "经纬度格式错误"}, 400)
            return
        params = {
            "key": AMAP_WEB_SERVICE_KEY,
            "location": f"{longitude},{latitude}",
            "zoom": "15",
            "size": "750*700",
            "scale": "2",
            "traffic": "0",
        }
        request = Request(
            "https://restapi.amap.com/v3/staticmap?" + urlencode(params),
            headers={"User-Agent": "Goapp/2.3"},
        )
        try:
            with urlopen(request, timeout=12) as response:
                content_type = response.headers.get("Content-Type", "image/png")
                body = response.read()
        except (HTTPError, URLError, TimeoutError) as exc:
            self.send_json({"error": f"高德地图加载失败：{exc}"}, 502)
            return
        if not content_type.startswith("image/"):
            self.send_json({"error": "高德地图返回异常"}, 502)
            return
        self.send_bytes(body, content_type, cache="private, no-store")

    def handle_api(self, method: str, path: str) -> None:
        conn = db()
        try:
            if path.startswith("/api/admin/"):
                self.handle_admin_api(conn, method, path)
                return
            if method == "GET" and path == "/api/health":
                self.send_json({"ok": True, "database": "sqlite", "version": APP_VERSION})
                return
            if method == "GET" and path == "/api/public-config":
                self.send_json({"integrations": public_integrations()})
                return
            oauth_start = re.fullmatch(r"/api/auth/oauth/(wechat|qq)/start", path)
            if method == "GET" and oauth_start:
                self.oauth_start(conn, oauth_start.group(1))
                return
            oauth_callback = re.fullmatch(r"/api/auth/oauth/(wechat|qq)/callback", path)
            if method == "GET" and oauth_callback:
                self.oauth_callback(conn, oauth_callback.group(1))
                return
            if method == "GET" and path == "/api/bootstrap":
                self.get_bootstrap(conn)
                return
            if method == "POST" and path == "/api/auth/request-code":
                self.request_code(conn)
                return
            if method == "POST" and path == "/api/auth/verify":
                self.verify_code(conn)
                return
            if method == "POST" and path == "/api/auth/demo":
                self.demo_login(conn)
                return
            if method == "POST" and path == "/api/auth/logout":
                self.read_json()
                cookie = self.clear_session(conn)
                conn.commit()
                self.send_json({"ok": True}, headers={"Set-Cookie": cookie})
                return
            if method == "PATCH" and path == "/api/profile":
                self.update_profile(conn, nickname_only=False)
                return
            if method == "PATCH" and path == "/api/nickname":
                self.update_profile(conn, nickname_only=True)
                return
            if method == "POST" and path == "/api/addresses":
                self.create_address(conn)
                return
            if method == "POST" and path == "/api/orders":
                self.create_order(conn)
                return
            if method == "GET" and path == "/api/location/search":
                self.location_search(conn)
                return
            if method == "GET" and path == "/api/location/reverse":
                self.location_reverse(conn)
                return
            if method == "GET" and path == "/api/location/static":
                self.location_static(conn)
                return
            voucher_match = re.fullmatch(r"/api/vouchers/([^/]+)/qr\.svg", path)
            if method == "GET" and voucher_match:
                self.send_voucher_qr(conn, voucher_match.group(1))
                return
            self.send_json({"error": "Not found"}, 404)
        finally:
            conn.close()

    def require_user(self, conn: sqlite3.Connection) -> sqlite3.Row | None:
        user = self.current_user(conn)
        if not user:
            self.send_json({"error": "请先登录"}, 401)
        return user

    def get_bootstrap(self, conn: sqlite3.Connection) -> None:
        user = self.current_user(conn)
        catalog = self.catalog(conn)
        if not user:
            self.send_json(
                {
                    "auth": False,
                    "catalog": catalog,
                    "integrations": public_integrations(),
                }
            )
            return
        self.send_json(
            {
                "auth": True,
                "catalog": catalog,
                "user": self.serialize_user(user),
                "addresses": self.serialize_addresses(conn, user["id"]),
                "orders": self.serialize_orders(conn, user["id"]),
                "lastChannel": "wechat",
                "demo": DEMO_MODE,
                "integrations": public_integrations(),
                "oauthBindings": self.oauth_bindings(conn, user["id"]),
            }
        )

    def serialize_user(self, user: sqlite3.Row) -> dict:
        return {
            "id": user["id"],
            "phone": user["phone"],
            "nickname": user["nickname"],
            "profile": {
                "hobby": parse_json(user["hobby_json"], []),
                "personality": parse_json(user["personality_json"], []),
                "occupation": user["occupation"],
                "gender": user["gender"],
            },
        }

    def catalog(self, conn: sqlite3.Connection) -> dict:
        return {
            "trips": trip_rows(conn, active_only=True),
            "taxonomy": taxonomy_from_db(conn),
        }

    def oauth_bindings(self, conn: sqlite3.Connection, user_id: str) -> list[str]:
        return [
            row["provider"]
            for row in conn.execute(
                "SELECT DISTINCT provider FROM oauth_identities WHERE user_id = ?",
                (user_id,),
            ).fetchall()
        ]

    def serialize_addresses(self, conn: sqlite3.Connection, user_id: str) -> list[dict]:
        rows = conn.execute(
            """
            SELECT * FROM addresses WHERE user_id = ?
            ORDER BY is_default DESC, created_at ASC
            """,
            (user_id,),
        ).fetchall()
        return [
            {
                "id": row["id"],
                "tag": row["tag"],
                "name": row["name"],
                "address": row["address"],
                "detail": row["detail"],
                "isDefault": bool(row["is_default"]),
                "longitude": row["longitude"],
                "latitude": row["latitude"],
            }
            for row in rows
        ]

    def order_status(self, row: sqlite3.Row, vouchers: list[sqlite3.Row]) -> str:
        statuses = [voucher["status"] for voucher in vouchers]
        if statuses and all(value == "used" for value in statuses):
            return "completed"
        if any(value == "used" for value in statuses):
            return "partially_used"
        if row["travel_date"] < today_local().isoformat():
            return "expired"
        return "paid"

    def serialize_orders(self, conn: sqlite3.Connection, user_id: str) -> list[dict]:
        rows = conn.execute(
            "SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC",
            (user_id,),
        ).fetchall()
        result = []
        for row in rows:
            vouchers = conn.execute(
                "SELECT * FROM vouchers WHERE order_id = ? ORDER BY seq",
                (row["id"],),
            ).fetchall()
            status = self.order_status(row, vouchers)
            result.append(
                {
                    "id": row["id"],
                    "no": row["order_no"],
                    "status": status,
                    "createdAt": row["created_at"],
                    "travelDate": row["travel_date"],
                    "people": row["people"],
                    "tripId": row["trip_id"],
                    "title": row["trip_title"],
                    "tags": parse_json(row["tags_json"], []),
                    "cover": parse_json(row["cover_json"], {}),
                    "stopCount": row["stop_count"],
                    "durationHours": row["duration_hours"],
                    "total": row["total"],
                    "perPerson": row["per_person"],
                    "address": parse_json(row["address_json"], None),
                    "channel": row["channel"],
                    "vouchers": [
                        {
                            "id": voucher["id"],
                            "seq": voucher["seq"],
                            "name": voucher["name"],
                            "type": voucher["type"],
                            "code": voucher["code"],
                            "redeem": voucher["redeem_code"],
                            "status": voucher["status"],
                            "usedAt": voucher["used_at"],
                            "note": voucher["note"],
                        }
                        for voucher in vouchers
                    ],
                }
            )
        pending = {"paid", "partially_used"}
        active = [order for order in result if order["status"] in pending]
        inactive = [order for order in result if order["status"] not in pending]
        active.sort(key=lambda order: (order["travelDate"], order["createdAt"]))
        return active + inactive

    def state_response(
        self,
        conn: sqlite3.Connection,
        user: sqlite3.Row,
        cookie: str | None = None,
        extra_cookies: list[str] | None = None,
    ) -> None:
        cookies = ([cookie] if cookie else []) + (extra_cookies or [])
        headers = {"Set-Cookie": cookies} if cookies else None
        self.send_json(
            {
                "auth": True,
                "catalog": self.catalog(conn),
                "user": self.serialize_user(user),
                "addresses": self.serialize_addresses(conn, user["id"]),
                "orders": self.serialize_orders(conn, user["id"]),
                "lastChannel": "wechat",
                "demo": DEMO_MODE,
                "integrations": public_integrations(),
                "oauthBindings": self.oauth_bindings(conn, user["id"]),
            },
            headers=headers,
        )

    def request_code(self, conn: sqlite3.Connection) -> None:
        body = self.read_json()
        phone = str(body.get("phone", "")).strip()
        if not PHONE_RE.fullmatch(phone):
            self.send_json({"error": "请输入正确的 11 位手机号"}, 400)
            return
        if not sms_configured():
            self.send_json(
                {"error": "短信服务尚未配置，请联系管理员完成实名短信接入"},
                503,
            )
            return
        recent = conn.execute(
            """
            SELECT created_at FROM otp_challenges
            WHERE phone = ? ORDER BY created_at DESC LIMIT 1
            """,
            (phone,),
        ).fetchone()
        if recent:
            created = datetime.fromisoformat(recent["created_at"])
            if datetime.now(timezone.utc) - created < timedelta(seconds=60):
                self.send_json({"error": "验证码发送过于频繁，请稍后再试"}, 429)
                return
        code = (
            DEMO_OTP
            if SMS_PROVIDER == "demo"
            else f"{secrets.randbelow(1_000_000):06d}"
        )
        challenge_id = uuid.uuid4().hex
        created_at = datetime.now(timezone.utc)
        expires_at = created_at + timedelta(minutes=OTP_MINUTES)
        conn.execute(
            """
            INSERT INTO otp_challenges(id, phone, code_hash, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                challenge_id,
                phone,
                hash_token(f"{challenge_id}:{code}"),
                created_at.replace(microsecond=0).isoformat(),
                expires_at.replace(microsecond=0).isoformat(),
            ),
        )
        if SMS_PROVIDER == "aliyun":
            try:
                send_aliyun_sms(phone, code, challenge_id)
            except ValueError as exc:
                conn.rollback()
                print(f"Aliyun SMS failed: {type(exc).__name__}", flush=True)
                self.send_json({"error": "验证码发送失败，请稍后重试"}, 502)
                return
        conn.commit()
        response = {"ok": True, "expiresIn": OTP_MINUTES * 60}
        if SMS_PROVIDER == "demo" and DEMO_MODE:
            response["demoCode"] = code
        self.send_json(response)

    def verify_code(self, conn: sqlite3.Connection) -> None:
        body = self.read_json()
        phone = str(body.get("phone", "")).strip()
        code = str(body.get("code", "")).strip()
        if not PHONE_RE.fullmatch(phone) or not re.fullmatch(r"\d{6}", code):
            self.send_json({"error": "手机号或验证码格式错误"}, 400)
            return
        challenge = conn.execute(
            """
            SELECT * FROM otp_challenges
            WHERE phone = ? AND consumed_at IS NULL
            ORDER BY created_at DESC LIMIT 1
            """,
            (phone,),
        ).fetchone()
        if not challenge or challenge["expires_at"] <= now_iso():
            self.send_json({"error": "验证码已过期，请重新获取"}, 400)
            return
        if challenge["attempts"] >= 5:
            self.send_json({"error": "验证码尝试次数过多，请重新获取"}, 429)
            return
        expected = hash_token(f"{challenge['id']}:{code}")
        if not hmac.compare_digest(expected, challenge["code_hash"]):
            conn.execute(
                "UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = ?",
                (challenge["id"],),
            )
            conn.commit()
            self.send_json({"error": "验证码不正确"}, 400)
            return
        now = now_iso()
        conn.execute(
            "UPDATE otp_challenges SET consumed_at = ? WHERE id = ?",
            (now, challenge["id"]),
        )
        user = conn.execute("SELECT * FROM users WHERE phone = ?", (phone,)).fetchone()
        if not user:
            user_id = uuid.uuid4().hex
            conn.execute(
                """
                INSERT INTO users(id, phone, nickname, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (user_id, phone, f"出行者{phone[-4:]}", now, now),
            )
            user = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        token, cookie = self.create_session(conn, user["id"])
        pending_cookie = self.bind_pending_oauth(conn, user)
        conn.commit()
        self.state_response(
            conn,
            user,
            cookie,
            [pending_cookie] if pending_cookie else None,
        )

    def demo_login(self, conn: sqlite3.Connection) -> None:
        if not DEMO_MODE:
            self.send_json({"error": "体验登录未开启"}, 403)
            return
        self.read_json()
        now = now_iso()
        user_id = uuid.uuid4().hex
        phone = f"demo-{user_id}"
        conn.execute(
            """
            INSERT INTO users(
                id, phone, nickname, hobby_json, personality_json, occupation,
                gender, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                user_id,
                phone,
                "周末出逃",
                json.dumps(["food", "citywalk", "cafe"]),
                json.dumps(["planner", "introverted"]),
                "tech",
                "female",
                now,
                now,
            ),
        )
        address_id = uuid.uuid4().hex
        conn.execute(
            """
            INSERT INTO addresses(
                id, user_id, tag, name, address, detail, is_default, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
            """,
            (
                address_id,
                user_id,
                "家",
                "阳光里小区 3 号楼",
                "朝阳区望京街道阜通东大街 6 号",
                "2 单元 1801",
                now,
            ),
        )
        self.seed_demo_orders(conn, user_id)
        token, cookie = self.create_session(conn, user_id)
        conn.commit()
        user = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        self.state_response(conn, user, cookie)

    def seed_demo_orders(self, conn: sqlite3.Connection, user_id: str) -> None:
        address = conn.execute(
            "SELECT * FROM addresses WHERE user_id = ? LIMIT 1", (user_id,)
        ).fetchone()
        if not address:
            return
        address_snapshot = {
            "id": address["id"],
            "tag": address["tag"],
            "name": address["name"],
            "address": address["address"],
            "detail": address["detail"],
            "isDefault": True,
        }
        trip = trip_by_id(conn, "t1") or SEED["TRIPS"][0]
        travel = today_local() + timedelta(days=2)
        self.insert_order(
            conn,
            user_id,
            trip,
            2,
            travel,
            "wechat",
            address_snapshot,
            voucher_status="unused",
        )
        historical = today_local() - timedelta(days=12)
        self.insert_order(
            conn,
            user_id,
            trip,
            2,
            historical,
            "wechat",
            address_snapshot,
            voucher_status="used",
        )

    def update_profile(
        self, conn: sqlite3.Connection, nickname_only: bool = False
    ) -> None:
        user = self.require_user(conn)
        if not user:
            return
        body = self.read_json()
        if nickname_only:
            nickname = str(body.get("nickname", "")).strip()
            if not 2 <= len(nickname) <= 12:
                self.send_json({"error": "昵称需 2–12 个字"}, 400)
                return
            conn.execute(
                "UPDATE users SET nickname = ?, updated_at = ? WHERE id = ?",
                (nickname, now_iso(), user["id"]),
            )
        else:
            profile = body.get("profile")
            if not isinstance(profile, dict):
                self.send_json({"error": "画像格式错误"}, 400)
                return
            hobby = profile.get("hobby") or []
            personality = profile.get("personality") or []
            occupation = profile.get("occupation") or None
            gender = profile.get("gender") or None
            if not isinstance(hobby, list) or not 1 <= len(hobby) <= 5:
                self.send_json({"error": "爱好需选择 1–5 个"}, 400)
                return
            if not isinstance(personality, list) or len(personality) > 3:
                self.send_json({"error": "性格最多选择 3 个"}, 400)
                return
            valid = self.valid_profile(conn, profile, hobby, personality)
            if not valid:
                self.send_json({"error": "画像选项无效"}, 400)
                return
            nickname = str(body.get("nickname", user["nickname"])).strip()
            if nickname and not 2 <= len(nickname) <= 12:
                self.send_json({"error": "昵称需 2–12 个字"}, 400)
                return
            conn.execute(
                """
                UPDATE users SET nickname = ?, hobby_json = ?, personality_json = ?,
                    occupation = ?, gender = ?, updated_at = ? WHERE id = ?
                """,
                (
                    nickname or user["nickname"],
                    json.dumps(hobby),
                    json.dumps(personality),
                    occupation,
                    gender,
                    now_iso(),
                    user["id"],
                ),
            )
        conn.commit()
        updated = conn.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()
        self.state_response(conn, updated)

    def valid_profile(
        self,
        conn: sqlite3.Connection,
        profile: dict,
        hobby: list,
        personality: list,
    ) -> bool:
        taxonomy = taxonomy_from_db(conn)

        def valid_values(group: str, values: list, max_count: int) -> bool:
            allowed = {item[0] for item in taxonomy[group]["options"]}
            return len(values) <= max_count and len(set(values)) == len(values) and set(values) <= allowed

        if not valid_values("hobby", hobby, 5) or not valid_values("personality", personality, 3):
            return False
        occupation = profile.get("occupation")
        gender = profile.get("gender")
        if occupation:
            allowed_occupations = {item[0] for item in taxonomy["occupation"]["options"]}
            if occupation not in allowed_occupations:
                return False
        if gender:
            allowed_genders = {item[0] for item in taxonomy["gender"]["options"]}
            if gender not in allowed_genders:
                return False
        return True

    def create_address(self, conn: sqlite3.Connection) -> None:
        user = self.require_user(conn)
        if not user:
            return
        body = self.read_json()
        tag = str(body.get("tag", "其他")).strip()[:8]
        name = str(body.get("name", "")).strip()[:80]
        line = str(body.get("address", "")).strip()[:180]
        detail = str(body.get("detail", "")).strip()[:120]
        longitude = body.get("longitude")
        latitude = body.get("latitude")
        try:
            longitude = float(longitude) if longitude not in (None, "") else None
            latitude = float(latitude) if latitude not in (None, "") else None
        except (TypeError, ValueError):
            self.send_json({"error": "地址坐标格式错误"}, 400)
            return
        if not name or not line:
            self.send_json({"error": "地址信息不完整"}, 400)
            return
        count = conn.execute(
            "SELECT COUNT(*) FROM addresses WHERE user_id = ?", (user["id"],)
        ).fetchone()[0]
        if count >= 5:
            self.send_json({"error": "最多保存 5 个地址"}, 400)
            return
        address_id = uuid.uuid4().hex
        is_default = 1 if count == 0 else 0
        conn.execute(
            """
            INSERT INTO addresses(
                id, user_id, tag, name, address, detail, is_default, created_at
                , longitude, latitude
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                address_id,
                user["id"],
                tag,
                name,
                line,
                detail,
                is_default,
                now_iso(),
                longitude,
                latitude,
            ),
        )
        conn.commit()
        self.state_response(conn, user)

    def valid_travel_date(self, travel: date) -> tuple[bool, str]:
        today = today_local()
        offset = (travel - today).days
        if offset < 0:
            return False, "出行日期已过去"
        if offset > 13:
            return False, "目前仅开放未来 14 天"
        if offset in (6, 7):
            return False, "该日期已满"
        return True, ""

    def insert_order(
        self,
        conn: sqlite3.Connection,
        user_id: str,
        trip: dict,
        people: int,
        travel: date,
        channel: str,
        address_snapshot: dict,
        voucher_status: str = "unused",
    ) -> str:
        stats = trip_stats(trip, people)
        weekend = travel.weekday() >= 5
        total = stats["total"] + (50 * people if weekend else 0)
        order_id = uuid.uuid4().hex
        created_at = now_iso()
        no = order_number()
        while conn.execute("SELECT 1 FROM orders WHERE order_no = ?", (no,)).fetchone():
            no = order_number()
        conn.execute(
            """
            INSERT INTO orders(
                id, user_id, order_no, trip_id, trip_title, tags_json, cover_json,
                stop_count, duration_hours, travel_date, people, total, per_person,
                address_json, channel, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                order_id,
                user_id,
                no,
                trip["id"],
                trip["title"],
                json.dumps(trip["tags"], ensure_ascii=False),
                json.dumps(trip["cover"], ensure_ascii=False),
                len(trip["stops"]),
                trip["durationHours"],
                travel.isoformat(),
                people,
                total,
                math.floor(total / people + 0.5),
                json.dumps(address_snapshot, ensure_ascii=False),
                channel,
                created_at,
            ),
        )
        for index, stop in enumerate(trip["stops"], start=1):
            used = voucher_status == "used"
            used_at = (
                f"{travel.month}月{travel.day}日 11:{10 + index:02d}" if used else None
            )
            conn.execute(
                """
                INSERT INTO vouchers(
                    id, order_id, seq, name, type, code, redeem_code, status, used_at, note
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    uuid.uuid4().hex,
                    order_id,
                    index,
                    stop["name"],
                    stop["type"],
                    random_code(),
                    random_numeric(),
                    voucher_status,
                    used_at,
                    f"到「{stop['name']}」核销台出示",
                ),
            )
        return order_id

    def create_order(self, conn: sqlite3.Connection) -> None:
        user = self.require_user(conn)
        if not user:
            return
        body = self.read_json()
        trip = trip_by_id(conn, str(body.get("tripId", "")))
        try:
            people = int(body.get("people"))
            travel = date.fromisoformat(str(body.get("travelDate", "")))
        except (TypeError, ValueError):
            self.send_json({"error": "订单参数错误"}, 400)
            return
        if not trip or not 1 <= people <= 6:
            self.send_json({"error": "订单参数错误"}, 400)
            return
        valid, message = self.valid_travel_date(travel)
        if not valid:
            self.send_json({"error": message}, 409)
            return
        address = conn.execute(
            """
            SELECT * FROM addresses WHERE user_id = ?
            ORDER BY is_default DESC, created_at ASC LIMIT 1
            """,
            (user["id"],),
        ).fetchone()
        if not address:
            self.send_json({"error": "请先设置出发地址"}, 409)
            return
        address_snapshot = {
            "id": address["id"],
            "tag": address["tag"],
            "name": address["name"],
            "address": address["address"],
            "detail": address["detail"],
            "isDefault": bool(address["is_default"]),
        }
        channel = str(body.get("channel", "wechat"))
        if channel not in ("wechat", "alipay"):
            channel = "wechat"
        order_id = self.insert_order(
            conn, user["id"], trip, people, travel, channel, address_snapshot
        )
        conn.commit()
        orders = self.serialize_orders(conn, user["id"])
        order = next(item for item in orders if item["id"] == order_id)
        self.send_json({"ok": True, "order": order}, 201)

    def query_params(self) -> dict[str, list[str]]:
        return parse_qs(urlsplit(self.path).query, keep_blank_values=True)

    def query_value(self, name: str, default: str = "") -> str:
        values = self.query_params().get(name)
        return values[0] if values else default

    def handle_admin_api(
        self, conn: sqlite3.Connection, method: str, path: str
    ) -> None:
        if method == "POST" and path == "/api/admin/login":
            self.admin_login(conn)
            return
        if method == "GET" and path == "/api/admin/me":
            admin = self.current_admin(conn)
            if not admin:
                self.send_json({"error": "管理员未登录"}, 401)
                return
            self.send_json(
                {
                    "authenticated": True,
                    "admin": {"username": admin["admin_name"]},
                    "version": APP_VERSION,
                }
            )
            return

        admin = self.current_admin(conn)
        if not admin:
            self.send_json({"error": "管理员登录已失效"}, 401)
            return
        admin_name = admin["admin_name"]

        if method == "POST" and path == "/api/admin/logout":
            self.read_json()
            cookie = self.clear_admin_session(conn)
            conn.commit()
            self.send_json({"ok": True}, headers={"Set-Cookie": cookie})
            return
        if method == "GET" and path == "/api/admin/dashboard":
            self.admin_dashboard(conn)
            return
        if path == "/api/admin/trips":
            if method == "GET":
                self.admin_list_trips(conn)
            elif method == "POST":
                self.admin_create_trip(conn, admin_name)
            else:
                self.send_json({"error": "Method not allowed"}, 405)
            return
        trip_match = re.fullmatch(r"/api/admin/trips/([^/]+)", path)
        if trip_match:
            if method == "GET":
                self.admin_get_trip(conn, trip_match.group(1))
            elif method == "PATCH":
                self.admin_update_trip(conn, admin_name, trip_match.group(1))
            elif method == "DELETE":
                self.read_json()
                self.admin_delete_trip(conn, admin_name, trip_match.group(1))
            else:
                self.send_json({"error": "Method not allowed"}, 405)
            return
        if path == "/api/admin/users":
            if method == "GET":
                self.admin_list_users(conn)
            elif method == "POST":
                self.admin_create_user(conn, admin_name)
            else:
                self.send_json({"error": "Method not allowed"}, 405)
            return
        user_match = re.fullmatch(r"/api/admin/users/([^/]+)", path)
        if user_match:
            if method == "GET":
                self.admin_get_user(conn, user_match.group(1))
            elif method == "PATCH":
                self.admin_update_user(conn, admin_name, user_match.group(1))
            elif method == "DELETE":
                self.read_json()
                self.admin_delete_user(conn, admin_name, user_match.group(1))
            else:
                self.send_json({"error": "Method not allowed"}, 405)
            return
        if path == "/api/admin/tags":
            if method == "GET":
                self.admin_list_tags(conn)
            elif method == "POST":
                self.admin_create_tag(conn, admin_name)
            else:
                self.send_json({"error": "Method not allowed"}, 405)
            return
        tag_match = re.fullmatch(r"/api/admin/tags/([^/]+)", path)
        if tag_match:
            if method == "PATCH":
                self.admin_update_tag(conn, admin_name, tag_match.group(1))
            elif method == "DELETE":
                self.read_json()
                self.admin_delete_tag(conn, admin_name, tag_match.group(1))
            else:
                self.send_json({"error": "Method not allowed"}, 405)
            return
        if method == "GET" and path == "/api/admin/orders":
            self.admin_list_orders(conn)
            return
        order_match = re.fullmatch(r"/api/admin/orders/([^/]+)", path)
        if method == "GET" and order_match:
            self.admin_get_order(conn, order_match.group(1))
            return
        if method == "GET" and path == "/api/admin/audit":
            self.admin_list_audit(conn)
            return
        self.send_json({"error": "Not found"}, 404)

    def login_is_blocked(self) -> bool:
        ip = self.client_address[0]
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=10)
        with ADMIN_LOGIN_LOCK:
            attempts = [
                value for value in ADMIN_LOGIN_FAILURES.get(ip, []) if value >= cutoff
            ]
            ADMIN_LOGIN_FAILURES[ip] = attempts
            return len(attempts) >= 5

    def record_login_failure(self) -> None:
        ip = self.client_address[0]
        with ADMIN_LOGIN_LOCK:
            ADMIN_LOGIN_FAILURES.setdefault(ip, []).append(datetime.now(timezone.utc))

    def clear_login_failures(self) -> None:
        with ADMIN_LOGIN_LOCK:
            ADMIN_LOGIN_FAILURES.pop(self.client_address[0], None)

    def admin_login(self, conn: sqlite3.Connection) -> None:
        if not ADMIN_PASSWORD:
            self.send_json({"error": "后台密码未配置，请更新部署环境"}, 503)
            return
        if self.login_is_blocked():
            self.send_json({"error": "登录失败次数过多，请 10 分钟后再试"}, 429)
            return
        body = self.read_json()
        username = str(body.get("username", "")).strip()
        password = str(body.get("password", ""))
        valid_username = hmac.compare_digest(username, ADMIN_USERNAME)
        valid_password = hmac.compare_digest(password, ADMIN_PASSWORD)
        if not valid_username or not valid_password:
            self.record_login_failure()
            self.send_json({"error": "管理员账号或密码错误"}, 401)
            return
        self.clear_login_failures()
        token = secrets.token_urlsafe(36)
        now = datetime.now(timezone.utc)
        expires = now + timedelta(hours=ADMIN_SESSION_HOURS)
        conn.execute(
            """
            INSERT INTO admin_sessions(token_hash, admin_name, created_at, expires_at)
            VALUES (?, ?, ?, ?)
            """,
            (
                hash_token(token),
                ADMIN_USERNAME,
                now_iso(),
                expires.replace(microsecond=0).isoformat(),
            ),
        )
        self.audit(
            conn,
            ADMIN_USERNAME,
            "admin.login",
            "session",
            None,
            {"ip": self.client_address[0]},
        )
        conn.commit()
        cookie_parts = [
            f"goapp_admin_session={token}",
            "Path=/",
            "HttpOnly",
            "SameSite=Strict",
            f"Max-Age={ADMIN_SESSION_HOURS * 3600}",
        ]
        if COOKIE_SECURE:
            cookie_parts.append("Secure")
        self.send_json(
            {
                "authenticated": True,
                "admin": {"username": ADMIN_USERNAME},
                "version": APP_VERSION,
            },
            headers={"Set-Cookie": "; ".join(cookie_parts)},
        )

    def current_admin(self, conn: sqlite3.Connection) -> sqlite3.Row | None:
        morsel = self.cookies().get("goapp_admin_session")
        if not morsel:
            return None
        return conn.execute(
            """
            SELECT * FROM admin_sessions
            WHERE token_hash = ? AND expires_at > ?
            """,
            (hash_token(morsel.value), now_iso()),
        ).fetchone()

    def clear_admin_session(self, conn: sqlite3.Connection) -> str:
        morsel = self.cookies().get("goapp_admin_session")
        if morsel:
            conn.execute(
                "DELETE FROM admin_sessions WHERE token_hash = ?",
                (hash_token(morsel.value),),
            )
        parts = [
            "goapp_admin_session=",
            "Path=/",
            "HttpOnly",
            "SameSite=Strict",
            "Max-Age=0",
        ]
        if COOKIE_SECURE:
            parts.append("Secure")
        return "; ".join(parts)

    def audit(
        self,
        conn: sqlite3.Connection,
        admin_name: str,
        action: str,
        target_type: str,
        target_id: str | None,
        details: dict,
    ) -> None:
        conn.execute(
            """
            INSERT INTO admin_audit(
                id, admin_name, action, target_type, target_id,
                details_json, ip, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                uuid.uuid4().hex,
                admin_name,
                action,
                target_type,
                target_id,
                json.dumps(details, ensure_ascii=False),
                self.client_address[0],
                now_iso(),
            ),
        )

    def admin_dashboard(self, conn: sqlite3.Connection) -> None:
        counts = {}
        for name, sql in {
            "users": "SELECT COUNT(*) FROM users",
            "orders": "SELECT COUNT(*) FROM orders",
            "vouchers": "SELECT COUNT(*) FROM vouchers",
            "tags": "SELECT COUNT(*) FROM taxonomy_tags",
            "enabledTags": "SELECT COUNT(*) FROM taxonomy_tags WHERE enabled = 1",
            "trips": "SELECT COUNT(*) FROM trips",
            "activeTrips": "SELECT COUNT(*) FROM trips WHERE active = 1",
        }.items():
            counts[name] = conn.execute(sql).fetchone()[0]
        revenue = conn.execute("SELECT COALESCE(SUM(total), 0) FROM orders").fetchone()[0]
        unused = conn.execute(
            "SELECT COUNT(*) FROM vouchers WHERE status = 'unused'"
        ).fetchone()[0]
        used = conn.execute(
            "SELECT COUNT(*) FROM vouchers WHERE status = 'used'"
        ).fetchone()[0]
        week_ago = (datetime.now(timezone.utc) - timedelta(days=7)).replace(
            microsecond=0
        ).isoformat()
        counts["newUsers7d"] = conn.execute(
            "SELECT COUNT(*) FROM users WHERE created_at >= ?", (week_ago,)
        ).fetchone()[0]
        counts["todayOrders"] = conn.execute(
            "SELECT COUNT(*) FROM orders WHERE substr(created_at, 1, 10) = ?",
            (today_local().isoformat(),),
        ).fetchone()[0]
        recent_orders = self.admin_orders_data(conn, "", "", 1, 6)["items"]
        recent_users = [
            self.admin_user_dict(row)
            for row in conn.execute(
                """
                SELECT u.*,
                    (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count,
                    (SELECT COALESCE(SUM(total), 0) FROM orders o WHERE o.user_id = u.id) AS spend,
                    (SELECT COUNT(*) FROM addresses a WHERE a.user_id = u.id) AS address_count
                FROM users u ORDER BY u.created_at DESC LIMIT 5
                """
            ).fetchall()
        ]
        self.send_json(
            {
                "metrics": {
                    **counts,
                    "revenue": revenue,
                    "vouchersUnused": unused,
                    "vouchersUsed": used,
                },
                "recentOrders": recent_orders,
                "recentUsers": recent_users,
                "demoMode": DEMO_MODE,
            }
        )

    def admin_trip_dict(self, row: sqlite3.Row, full: bool = False) -> dict:
        payload = parse_json(row["payload"], {})
        result = {
            "id": row["id"],
            "title": payload.get("title", ""),
            "city": payload.get("city", ""),
            "durationHours": payload.get("durationHours", 0),
            "distance": payload.get("distance", 0),
            "tags": payload.get("tags", []),
            "cover": payload.get("cover", {}),
            "stopCount": len(payload.get("stops", [])),
            "active": bool(row["active"]),
            "sortOrder": row["sort_order"],
            "updatedAt": row["updated_at"],
        }
        try:
            result["perPerson"] = trip_stats(payload, 2)["perPerson"]
        except (TypeError, ValueError, KeyError):
            result["perPerson"] = 0
        if full:
            result["stops"] = payload.get("stops", [])
        return result

    def admin_list_trips(self, conn: sqlite3.Connection) -> None:
        q = self.query_value("q").strip()
        active_filter = self.query_value("active").strip()
        try:
            page = max(1, int(self.query_value("page", "1")))
            limit = min(100, max(1, int(self.query_value("limit", "30"))))
        except ValueError:
            self.send_json({"error": "分页参数错误"}, 400)
            return
        clauses = []
        params = []
        if q:
            clauses.append("(payload LIKE ? OR id LIKE ?)")
            params.extend([f"%{q}%", f"%{q}%"])
        if active_filter in ("0", "1"):
            clauses.append("active = ?")
            params.append(int(active_filter))
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        total = conn.execute("SELECT COUNT(*) FROM trips" + where, params).fetchone()[0]
        rows = conn.execute(
            "SELECT * FROM trips"
            + where
            + " ORDER BY sort_order, updated_at DESC LIMIT ? OFFSET ?",
            [*params, limit, (page - 1) * limit],
        ).fetchall()
        self.send_json(
            {
                "items": [self.admin_trip_dict(row) for row in rows],
                "total": total,
                "page": page,
                "limit": limit,
            }
        )

    def admin_get_trip(self, conn: sqlite3.Connection, trip_id: str) -> None:
        row = conn.execute("SELECT * FROM trips WHERE id = ?", (trip_id,)).fetchone()
        if not row:
            self.send_json({"error": "首页项目不存在"}, 404)
            return
        self.send_json({"trip": self.admin_trip_dict(row, full=True)})

    def admin_trip_values(self, body: dict) -> tuple[dict | None, list[str]]:
        warnings = []
        title = str(body.get("title", "")).strip()
        city = str(body.get("city", "")).strip()
        tags = body.get("tags", [])
        cover = body.get("cover", {})
        stops = body.get("stops", [])
        try:
            duration = int(body.get("durationHours", 0))
            distance = int(body.get("distance", 0))
            sort_order = int(body.get("sortOrder", 0))
        except (TypeError, ValueError):
            self.send_json({"error": "时长、距离或排序必须为整数"}, 400)
            return None, warnings
        if not 4 <= len(title) <= 30:
            self.send_json({"error": "标题需为 4–30 个字"}, 400)
            return None, warnings
        if not 1 <= len(city) <= 20:
            self.send_json({"error": "城市需为 1–20 个字"}, 400)
            return None, warnings
        if not 1 <= duration <= 24:
            self.send_json({"error": "行程时长需在 1–24 小时"}, 400)
            return None, warnings
        if not 0 <= distance <= 200_000:
            self.send_json({"error": "距离需在 0–200 公里"}, 400)
            return None, warnings
        if not 0 <= sort_order <= 9999:
            self.send_json({"error": "排序值需在 0–9999"}, 400)
            return None, warnings
        if (
            not isinstance(tags, list)
            or not 1 <= len(tags) <= 2
            or len(set(tags)) != len(tags)
            or not set(tags) <= {"play", "food"}
        ):
            self.send_json({"error": "首页项目至少选择玩或吃一个标签"}, 400)
            return None, warnings
        if not isinstance(cover, dict):
            self.send_json({"error": "封面配置错误"}, 400)
            return None, warnings
        color_re = re.compile(r"^#[0-9A-Fa-f]{6}$")
        from_color = str(cover.get("from", ""))
        to_color = str(cover.get("to", ""))
        emoji = str(cover.get("emoji", "")).strip()
        if (
            not color_re.fullmatch(from_color)
            or not color_re.fullmatch(to_color)
            or not 1 <= len(emoji) <= 12
        ):
            self.send_json({"error": "封面颜色或 emoji 无效"}, 400)
            return None, warnings
        if not isinstance(stops, list) or not 1 <= len(stops) <= 12:
            self.send_json({"error": "行程需包含 1–12 个站点"}, 400)
            return None, warnings
        normalized_stops = []
        for stop_index, stop in enumerate(stops, start=1):
            if not isinstance(stop, dict):
                self.send_json({"error": f"第 {stop_index} 站格式错误"}, 400)
                return None, warnings
            name = str(stop.get("name", "")).strip()
            stop_type = str(stop.get("type", "play"))
            time_value = str(stop.get("time", "")).strip()
            leg = str(stop.get("leg", "")).strip()
            try:
                stay = int(stop.get("stay", 0))
            except (TypeError, ValueError):
                stay = 0
            if not 1 <= len(name) <= 40:
                self.send_json({"error": f"第 {stop_index} 站名称无效"}, 400)
                return None, warnings
            if stop_type not in ("play", "food"):
                self.send_json({"error": f"第 {stop_index} 站类型无效"}, 400)
                return None, warnings
            if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", time_value):
                self.send_json({"error": f"第 {stop_index} 站时间需为 HH:MM"}, 400)
                return None, warnings
            if not 1 <= stay <= 720:
                self.send_json({"error": f"第 {stop_index} 站停留时间无效"}, 400)
                return None, warnings
            if len(leg) > 40:
                self.send_json({"error": f"第 {stop_index} 站交通说明过长"}, 400)
                return None, warnings
            items = stop.get("items", [])
            if not isinstance(items, list) or not 1 <= len(items) <= 20:
                self.send_json({"error": f"第 {stop_index} 站需包含 1–20 个消费项"}, 400)
                return None, warnings
            normalized_items = []
            for item_index, item in enumerate(items, start=1):
                if not isinstance(item, dict):
                    self.send_json({"error": f"第 {stop_index} 站第 {item_index} 个消费项格式错误"}, 400)
                    return None, warnings
                item_name = str(item.get("name", "")).strip()
                icon = str(item.get("icon", "")).strip()
                mode = str(item.get("mode", "pp"))
                try:
                    price = int(item.get("price", 0))
                except (TypeError, ValueError):
                    price = -1
                if not 1 <= len(item_name) <= 40 or not 1 <= len(icon) <= 12:
                    self.send_json({"error": f"第 {stop_index} 站消费项名称或图标无效"}, 400)
                    return None, warnings
                if mode not in ("pp", "gp") or not 0 <= price <= 100_000:
                    self.send_json({"error": f"第 {stop_index} 站消费项价格或计价方式无效"}, 400)
                    return None, warnings
                normalized_items.append(
                    {
                        "icon": icon,
                        "name": item_name,
                        "price": price,
                        "mode": mode,
                    }
                )
            normalized_stops.append(
                {
                    "name": name,
                    "type": stop_type,
                    "time": time_value,
                    "stay": stay,
                    "leg": leg,
                    "items": normalized_items,
                }
            )
        if not 12 <= len(title) <= 18:
            warnings.append("标题建议控制在 12–18 字")
        if not re.search(r"[逛游徒步漫步展温泉骑行露营爬赏探吃食餐咖啡夜市烧烤茶酒甜]", title):
            warnings.append("标题缺少明确的玩或食关键词")
        enabled = body.get("active", body.get("enabled", True))
        if isinstance(enabled, str):
            enabled = enabled.lower() in ("1", "true", "yes")
        return (
            {
                "title": title,
                "tags": tags,
                "durationHours": duration,
                "distance": distance,
                "city": city,
                "cover": {
                    "from": from_color.upper(),
                    "to": to_color.upper(),
                    "emoji": emoji,
                },
                "stops": normalized_stops,
                "sortOrder": sort_order,
                "active": bool(enabled),
            },
            warnings,
        )

    def admin_create_trip(self, conn: sqlite3.Connection, admin_name: str) -> None:
        values, warnings = self.admin_trip_values(self.read_json())
        if values is None:
            return
        trip_id = "t_" + uuid.uuid4().hex[:10]
        now = now_iso()
        payload = {
            key: values[key]
            for key in ("title", "tags", "durationHours", "distance", "city", "cover", "stops")
        }
        conn.execute(
            """
            INSERT INTO trips(id, payload, active, sort_order, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                trip_id,
                json.dumps(payload, ensure_ascii=False),
                1 if values["active"] else 0,
                values["sortOrder"],
                now,
            ),
        )
        self.audit(
            conn,
            admin_name,
            "trip.create",
            "trip",
            trip_id,
            {"title": values["title"], "active": values["active"]},
        )
        conn.commit()
        row = conn.execute("SELECT * FROM trips WHERE id = ?", (trip_id,)).fetchone()
        self.send_json(
            {
                "ok": True,
                "trip": self.admin_trip_dict(row, full=True),
                "warnings": warnings,
            },
            201,
        )

    def admin_update_trip(
        self, conn: sqlite3.Connection, admin_name: str, trip_id: str
    ) -> None:
        existing = conn.execute(
            "SELECT * FROM trips WHERE id = ?", (trip_id,)
        ).fetchone()
        if not existing:
            self.send_json({"error": "首页项目不存在"}, 404)
            return
        values, warnings = self.admin_trip_values(self.read_json())
        if values is None:
            return
        payload = {
            key: values[key]
            for key in ("title", "tags", "durationHours", "distance", "city", "cover", "stops")
        }
        conn.execute(
            """
            UPDATE trips SET payload = ?, active = ?, sort_order = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                json.dumps(payload, ensure_ascii=False),
                1 if values["active"] else 0,
                values["sortOrder"],
                now_iso(),
                trip_id,
            ),
        )
        self.audit(
            conn,
            admin_name,
            "trip.update",
            "trip",
            trip_id,
            {"title": values["title"], "active": values["active"]},
        )
        conn.commit()
        row = conn.execute("SELECT * FROM trips WHERE id = ?", (trip_id,)).fetchone()
        self.send_json(
            {
                "ok": True,
                "trip": self.admin_trip_dict(row, full=True),
                "warnings": warnings,
            }
        )

    def admin_delete_trip(
        self, conn: sqlite3.Connection, admin_name: str, trip_id: str
    ) -> None:
        row = conn.execute("SELECT * FROM trips WHERE id = ?", (trip_id,)).fetchone()
        if not row:
            self.send_json({"error": "首页项目不存在"}, 404)
            return
        payload = parse_json(row["payload"], {})
        conn.execute("DELETE FROM trips WHERE id = ?", (trip_id,))
        self.audit(
            conn,
            admin_name,
            "trip.delete",
            "trip",
            trip_id,
            {"title": payload.get("title", ""), "active": bool(row["active"])},
        )
        conn.commit()
        self.send_json({"ok": True})

    def admin_user_dict(self, row: sqlite3.Row) -> dict:
        keys = set(row.keys())
        return {
            "id": row["id"],
            "phone": row["phone"],
            "nickname": row["nickname"],
            "profile": {
                "hobby": parse_json(row["hobby_json"], []),
                "personality": parse_json(row["personality_json"], []),
                "occupation": row["occupation"],
                "gender": row["gender"],
            },
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "orderCount": row["order_count"] if "order_count" in keys else None,
            "spend": row["spend"] if "spend" in keys else None,
            "addressCount": row["address_count"] if "address_count" in keys else None,
        }

    def admin_user_query(self) -> str:
        return """
            SELECT u.*,
                (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count,
                (SELECT COALESCE(SUM(total), 0) FROM orders o WHERE o.user_id = u.id) AS spend,
                (SELECT COUNT(*) FROM addresses a WHERE a.user_id = u.id) AS address_count
            FROM users u
        """

    def admin_list_users(self, conn: sqlite3.Connection) -> None:
        q = self.query_value("q").strip()
        try:
            page = max(1, int(self.query_value("page", "1")))
            limit = min(100, max(1, int(self.query_value("limit", "20"))))
        except ValueError:
            self.send_json({"error": "分页参数错误"}, 400)
            return
        where = ""
        params = []
        if q:
            where = " WHERE u.phone LIKE ? OR u.nickname LIKE ?"
            params = [f"%{q}%", f"%{q}%"]
        total = conn.execute(
            "SELECT COUNT(*) FROM users u" + where, params
        ).fetchone()[0]
        rows = conn.execute(
            self.admin_user_query()
            + where
            + " ORDER BY u.created_at DESC LIMIT ? OFFSET ?",
            [*params, limit, (page - 1) * limit],
        ).fetchall()
        self.send_json(
            {
                "items": [self.admin_user_dict(row) for row in rows],
                "total": total,
                "page": page,
                "limit": limit,
            }
        )

    def normalize_admin_user(
        self,
        conn: sqlite3.Connection,
        body: dict,
        existing: sqlite3.Row | None = None,
    ) -> dict | None:
        phone = str(body.get("phone", existing["phone"] if existing else "")).strip()
        nickname = str(
            body.get("nickname", existing["nickname"] if existing else "")
        ).strip()
        if not PHONE_RE.fullmatch(phone):
            self.send_json({"error": "手机号格式错误"}, 400)
            return None
        if not 2 <= len(nickname) <= 12:
            self.send_json({"error": "昵称需 2–12 个字"}, 400)
            return None
        old_profile = (
            {
                "hobby": parse_json(existing["hobby_json"], []),
                "personality": parse_json(existing["personality_json"], []),
                "occupation": existing["occupation"],
                "gender": existing["gender"],
            }
            if existing
            else {"hobby": [], "personality": [], "occupation": None, "gender": None}
        )
        profile = body.get("profile", old_profile)
        if not isinstance(profile, dict):
            self.send_json({"error": "画像格式错误"}, 400)
            return None
        hobby = profile.get("hobby", old_profile["hobby"]) or []
        personality = profile.get("personality", old_profile["personality"]) or []
        occupation = profile.get("occupation", old_profile["occupation"]) or None
        gender = profile.get("gender", old_profile["gender"]) or None
        codes = all_tag_codes(conn)
        if (
            not isinstance(hobby, list)
            or len(hobby) > 5
            or len(set(hobby)) != len(hobby)
            or not set(hobby) <= codes["hobby"]
        ):
            self.send_json({"error": "爱好标签无效"}, 400)
            return None
        if (
            not isinstance(personality, list)
            or len(personality) > 3
            or len(set(personality)) != len(personality)
            or not set(personality) <= codes["personality"]
        ):
            self.send_json({"error": "性格标签无效"}, 400)
            return None
        if occupation and occupation not in codes["occupation"]:
            self.send_json({"error": "职业标签无效"}, 400)
            return None
        if gender and gender not in codes["gender"]:
            self.send_json({"error": "性别标签无效"}, 400)
            return None
        return {
            "phone": phone,
            "nickname": nickname,
            "hobby": hobby,
            "personality": personality,
            "occupation": occupation,
            "gender": gender,
        }

    def admin_create_user(self, conn: sqlite3.Connection, admin_name: str) -> None:
        body = self.read_json()
        values = self.normalize_admin_user(conn, body)
        if values is None:
            return
        if conn.execute(
            "SELECT 1 FROM users WHERE phone = ?", (values["phone"],)
        ).fetchone():
            self.send_json({"error": "该手机号已存在"}, 409)
            return
        user_id = uuid.uuid4().hex
        now = now_iso()
        conn.execute(
            """
            INSERT INTO users(
                id, phone, nickname, hobby_json, personality_json,
                occupation, gender, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                user_id,
                values["phone"],
                values["nickname"],
                json.dumps(values["hobby"], ensure_ascii=False),
                json.dumps(values["personality"], ensure_ascii=False),
                values["occupation"],
                values["gender"],
                now,
                now,
            ),
        )
        self.audit(
            conn,
            admin_name,
            "user.create",
            "user",
            user_id,
            {"phone": values["phone"], "nickname": values["nickname"]},
        )
        conn.commit()
        row = conn.execute(
            self.admin_user_query() + " WHERE u.id = ?", (user_id,)
        ).fetchone()
        self.send_json({"ok": True, "user": self.admin_user_dict(row)}, 201)

    def admin_get_user(self, conn: sqlite3.Connection, user_id: str) -> None:
        row = conn.execute(
            self.admin_user_query() + " WHERE u.id = ?", (user_id,)
        ).fetchone()
        if not row:
            self.send_json({"error": "用户不存在"}, 404)
            return
        self.send_json(
            {
                "user": self.admin_user_dict(row),
                "addresses": self.serialize_addresses(conn, user_id),
                "orders": self.serialize_orders(conn, user_id),
            }
        )

    def admin_update_user(
        self, conn: sqlite3.Connection, admin_name: str, user_id: str
    ) -> None:
        existing = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if not existing:
            self.send_json({"error": "用户不存在"}, 404)
            return
        body = self.read_json()
        values = self.normalize_admin_user(conn, body, existing)
        if values is None:
            return
        conflict = conn.execute(
            "SELECT 1 FROM users WHERE phone = ? AND id <> ?",
            (values["phone"], user_id),
        ).fetchone()
        if conflict:
            self.send_json({"error": "该手机号已被其他用户使用"}, 409)
            return
        conn.execute(
            """
            UPDATE users SET phone = ?, nickname = ?, hobby_json = ?,
                personality_json = ?, occupation = ?, gender = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                values["phone"],
                values["nickname"],
                json.dumps(values["hobby"], ensure_ascii=False),
                json.dumps(values["personality"], ensure_ascii=False),
                values["occupation"],
                values["gender"],
                now_iso(),
                user_id,
            ),
        )
        self.audit(
            conn,
            admin_name,
            "user.update",
            "user",
            user_id,
            {"phone": values["phone"], "nickname": values["nickname"]},
        )
        conn.commit()
        row = conn.execute(
            self.admin_user_query() + " WHERE u.id = ?", (user_id,)
        ).fetchone()
        self.send_json({"ok": True, "user": self.admin_user_dict(row)})

    def admin_delete_user(
        self, conn: sqlite3.Connection, admin_name: str, user_id: str
    ) -> None:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row:
            self.send_json({"error": "用户不存在"}, 404)
            return
        order_count = conn.execute(
            "SELECT COUNT(*) FROM orders WHERE user_id = ?", (user_id,)
        ).fetchone()[0]
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        self.audit(
            conn,
            admin_name,
            "user.delete",
            "user",
            user_id,
            {"phone": row["phone"], "nickname": row["nickname"], "orders": order_count},
        )
        conn.commit()
        self.send_json({"ok": True})

    def admin_list_tags(self, conn: sqlite3.Connection) -> None:
        group_name = self.query_value("group").strip()
        q = self.query_value("q").strip()
        clauses = []
        params = []
        if group_name:
            clauses.append("group_name = ?")
            params.append(group_name)
        if q:
            clauses.append("(code LIKE ? OR label LIKE ?)")
            params.extend([f"%{q}%", f"%{q}%"])
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        rows = conn.execute(
            """
            SELECT * FROM taxonomy_tags
            """
            + where
            + " ORDER BY CASE group_name WHEN 'hobby' THEN 1 WHEN 'personality' THEN 2 "
            "WHEN 'occupation' THEN 3 ELSE 4 END, sort_order, label",
            params,
        ).fetchall()
        usage = tag_usage_map(conn)
        items = [
            {
                "id": row["id"],
                "group": row["group_name"],
                "code": row["code"],
                "label": row["label"],
                "enabled": bool(row["enabled"]),
                "sortOrder": row["sort_order"],
                "usage": usage.get((row["group_name"], row["code"]), 0),
                "createdAt": row["created_at"],
                "updatedAt": row["updated_at"],
            }
            for row in rows
        ]
        self.send_json({"items": items, "groups": TAXONOMY})

    def validate_tag_fields(
        self, body: dict, existing: sqlite3.Row | None = None
    ) -> dict | None:
        group_name = str(body.get("group", existing["group_name"] if existing else ""))
        code = str(body.get("code", existing["code"] if existing else "")).strip()
        label = str(body.get("label", existing["label"] if existing else "")).strip()
        enabled = body.get("enabled", bool(existing["enabled"]) if existing else True)
        try:
            sort_order = int(
                body.get("sortOrder", existing["sort_order"] if existing else 0)
            )
        except (TypeError, ValueError):
            self.send_json({"error": "排序值必须是整数"}, 400)
            return None
        if group_name not in TAG_GROUPS:
            self.send_json({"error": "标签分组无效"}, 400)
            return None
        if not re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", code):
            self.send_json({"error": "标签代码需为小写字母、数字、_ 或 -"}, 400)
            return None
        if not 1 <= len(label) <= 16:
            self.send_json({"error": "标签名称需为 1–16 个字"}, 400)
            return None
        if not 0 <= sort_order <= 9999:
            self.send_json({"error": "排序值需在 0–9999"}, 400)
            return None
        return {
            "group": group_name,
            "code": code,
            "label": label,
            "enabled": bool(enabled),
            "sortOrder": sort_order,
        }

    def admin_create_tag(self, conn: sqlite3.Connection, admin_name: str) -> None:
        body = self.read_json()
        values = self.validate_tag_fields(body)
        if values is None:
            return
        if conn.execute(
            "SELECT 1 FROM taxonomy_tags WHERE group_name = ? AND code = ?",
            (values["group"], values["code"]),
        ).fetchone():
            self.send_json({"error": "该分组下标签代码已存在"}, 409)
            return
        tag_id = uuid.uuid4().hex
        now = now_iso()
        conn.execute(
            """
            INSERT INTO taxonomy_tags(
                id, group_name, code, label, enabled, sort_order, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                tag_id,
                values["group"],
                values["code"],
                values["label"],
                1 if values["enabled"] else 0,
                values["sortOrder"],
                now,
                now,
            ),
        )
        self.audit(
            conn,
            admin_name,
            "tag.create",
            "tag",
            tag_id,
            values,
        )
        conn.commit()
        self.send_json({"ok": True, "id": tag_id, "tag": values}, 201)

    def admin_update_tag(
        self, conn: sqlite3.Connection, admin_name: str, tag_id: str
    ) -> None:
        existing = conn.execute(
            "SELECT * FROM taxonomy_tags WHERE id = ?", (tag_id,)
        ).fetchone()
        if not existing:
            self.send_json({"error": "标签不存在"}, 404)
            return
        values = self.validate_tag_fields(self.read_json(), existing)
        if values is None:
            return
        usage = tag_usage_map(conn).get((existing["group_name"], existing["code"]), 0)
        if (
            usage
            and (
                values["group"] != existing["group_name"]
                or values["code"] != existing["code"]
            )
        ):
            self.send_json({"error": "已被使用的标签不能修改分组或代码"}, 409)
            return
        if values["group"] != existing["group_name"] or values["code"] != existing["code"]:
            conflict = conn.execute(
                """
                SELECT 1 FROM taxonomy_tags
                WHERE group_name = ? AND code = ? AND id <> ?
                """,
                (values["group"], values["code"], tag_id),
            ).fetchone()
            if conflict:
                self.send_json({"error": "该分组下标签代码已存在"}, 409)
                return
        conn.execute(
            """
            UPDATE taxonomy_tags SET group_name = ?, code = ?, label = ?,
                enabled = ?, sort_order = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                values["group"],
                values["code"],
                values["label"],
                1 if values["enabled"] else 0,
                values["sortOrder"],
                now_iso(),
                tag_id,
            ),
        )
        self.audit(
            conn,
            admin_name,
            "tag.update",
            "tag",
            tag_id,
            {"before": {"group": existing["group_name"], "code": existing["code"]}, **values},
        )
        conn.commit()
        self.send_json({"ok": True, "tag": values})

    def admin_delete_tag(
        self, conn: sqlite3.Connection, admin_name: str, tag_id: str
    ) -> None:
        existing = conn.execute(
            "SELECT * FROM taxonomy_tags WHERE id = ?", (tag_id,)
        ).fetchone()
        if not existing:
            self.send_json({"error": "标签不存在"}, 404)
            return
        group_name = existing["group_name"]
        code = existing["code"]
        usage = tag_usage_map(conn).get((group_name, code), 0)
        force = self.query_value("force") == "1"
        if usage and not force:
            self.send_json(
                {
                    "error": f"该标签正被 {usage} 位用户使用，确认后会从用户画像中移除",
                    "code": "TAG_IN_USE",
                    "usage": usage,
                },
                409,
            )
            return
        if usage:
            for user in conn.execute("SELECT * FROM users").fetchall():
                hobby = [
                    value
                    for value in parse_json(user["hobby_json"], [])
                    if not (group_name == "hobby" and value == code)
                ]
                personality = [
                    value
                    for value in parse_json(user["personality_json"], [])
                    if not (group_name == "personality" and value == code)
                ]
                occupation = (
                    None
                    if group_name == "occupation" and user["occupation"] == code
                    else user["occupation"]
                )
                gender = (
                    None
                    if group_name == "gender" and user["gender"] == code
                    else user["gender"]
                )
                conn.execute(
                    """
                    UPDATE users SET hobby_json = ?, personality_json = ?,
                        occupation = ?, gender = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        json.dumps(hobby),
                        json.dumps(personality),
                        occupation,
                        gender,
                        now_iso(),
                        user["id"],
                    ),
                )
        conn.execute("DELETE FROM taxonomy_tags WHERE id = ?", (tag_id,))
        self.audit(
            conn,
            admin_name,
            "tag.delete",
            "tag",
            tag_id,
            {"group": group_name, "code": code, "label": existing["label"], "usage": usage},
        )
        conn.commit()
        self.send_json({"ok": True, "removedFromUsers": usage})

    def admin_orders_data(
        self,
        conn: sqlite3.Connection,
        q: str,
        status_filter: str,
        page: int,
        limit: int,
    ) -> dict:
        where = ""
        params = []
        if q:
            where = """
                WHERE o.order_no LIKE ? OR o.trip_title LIKE ?
                    OR u.phone LIKE ? OR u.nickname LIKE ?
            """
            params = [f"%{q}%"] * 4
        rows = conn.execute(
            """
            SELECT o.*, u.phone, u.nickname
            FROM orders o JOIN users u ON u.id = o.user_id
            """
            + where
            + " ORDER BY o.created_at DESC",
            params,
        ).fetchall()
        items = []
        for row in rows:
            vouchers = conn.execute(
                "SELECT * FROM vouchers WHERE order_id = ? ORDER BY seq",
                (row["id"],),
            ).fetchall()
            status = self.order_status(row, vouchers)
            if status_filter and status != status_filter:
                continue
            items.append(
                {
                    "id": row["id"],
                    "no": row["order_no"],
                    "status": status,
                    "createdAt": row["created_at"],
                    "travelDate": row["travel_date"],
                    "people": row["people"],
                    "title": row["trip_title"],
                    "total": row["total"],
                    "perPerson": row["per_person"],
                    "channel": row["channel"],
                    "user": {
                        "id": row["user_id"],
                        "phone": row["phone"],
                        "nickname": row["nickname"],
                    },
                    "voucherCount": len(vouchers),
                    "vouchersUsed": sum(
                        1 for voucher in vouchers if voucher["status"] == "used"
                    ),
                }
            )
        total = len(items)
        offset = (page - 1) * limit
        return {
            "items": items[offset : offset + limit],
            "total": total,
            "page": page,
            "limit": limit,
        }

    def admin_list_orders(self, conn: sqlite3.Connection) -> None:
        try:
            page = max(1, int(self.query_value("page", "1")))
            limit = min(100, max(1, int(self.query_value("limit", "20"))))
        except ValueError:
            self.send_json({"error": "分页参数错误"}, 400)
            return
        self.send_json(
            self.admin_orders_data(
                conn,
                self.query_value("q").strip(),
                self.query_value("status").strip(),
                page,
                limit,
            )
        )

    def admin_get_order(self, conn: sqlite3.Connection, order_id: str) -> None:
        row = conn.execute(
            """
            SELECT o.*, u.phone, u.nickname
            FROM orders o JOIN users u ON u.id = o.user_id
            WHERE o.id = ?
            """,
            (order_id,),
        ).fetchone()
        if not row:
            self.send_json({"error": "订单不存在"}, 404)
            return
        vouchers = conn.execute(
            "SELECT * FROM vouchers WHERE order_id = ? ORDER BY seq", (order_id,)
        ).fetchall()
        self.send_json(
            {
                "order": {
                    "id": row["id"],
                    "no": row["order_no"],
                    "status": self.order_status(row, vouchers),
                    "createdAt": row["created_at"],
                    "travelDate": row["travel_date"],
                    "people": row["people"],
                    "title": row["trip_title"],
                    "total": row["total"],
                    "perPerson": row["per_person"],
                    "address": parse_json(row["address_json"], None),
                    "channel": row["channel"],
                    "user": {
                        "id": row["user_id"],
                        "phone": row["phone"],
                        "nickname": row["nickname"],
                    },
                },
                "vouchers": [
                    {
                        "id": voucher["id"],
                        "seq": voucher["seq"],
                        "name": voucher["name"],
                        "code": voucher["code"],
                        "redeem": voucher["redeem_code"],
                        "status": voucher["status"],
                        "usedAt": voucher["used_at"],
                    }
                    for voucher in vouchers
                ],
            }
        )

    def admin_list_audit(self, conn: sqlite3.Connection) -> None:
        try:
            page = max(1, int(self.query_value("page", "1")))
            limit = min(100, max(1, int(self.query_value("limit", "30"))))
        except ValueError:
            self.send_json({"error": "分页参数错误"}, 400)
            return
        total = conn.execute("SELECT COUNT(*) FROM admin_audit").fetchone()[0]
        rows = conn.execute(
            """
            SELECT * FROM admin_audit ORDER BY created_at DESC LIMIT ? OFFSET ?
            """,
            (limit, (page - 1) * limit),
        ).fetchall()
        self.send_json(
            {
                "items": [
                    {
                        "id": row["id"],
                        "admin": row["admin_name"],
                        "action": row["action"],
                        "targetType": row["target_type"],
                        "targetId": row["target_id"],
                        "details": parse_json(row["details_json"], {}),
                        "ip": row["ip"],
                        "createdAt": row["created_at"],
                    }
                    for row in rows
                ],
                "total": total,
                "page": page,
                "limit": limit,
            }
        )

    def send_voucher_qr(self, conn: sqlite3.Connection, voucher_id: str) -> None:
        user = self.require_user(conn)
        if not user:
            return
        voucher = conn.execute(
            """
            SELECT v.* FROM vouchers v
            JOIN orders o ON o.id = v.order_id
            WHERE v.id = ? AND o.user_id = ?
            """,
            (voucher_id, user["id"]),
        ).fetchone()
        if not voucher:
            self.send_json({"error": "凭证不存在"}, 404)
            return
        output = io.BytesIO()
        segno.make(f"GOAPP:{voucher['code']}", error="m").save(
            output, kind="svg", scale=5, border=4, dark="#000000", light="#ffffff"
        )
        self.send_bytes(
            output.getvalue(),
            "image/svg+xml; charset=utf-8",
            cache="private, no-store",
        )


def main() -> None:
    initialize_database()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), AppHandler)
    server.daemon_threads = True
    print(
        f"Goapp listening on http://0.0.0.0:{PORT} "
        f"(db={DB_FILE}, demo_mode={DEMO_MODE})",
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
