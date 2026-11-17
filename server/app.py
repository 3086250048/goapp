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
from urllib.parse import quote, unquote, urlsplit

import segno


BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "prototype"
SEED_FILE = Path(__file__).resolve().with_name("seed.json")
DATA_DIR = Path(os.getenv("DATA_DIR", str(BASE_DIR / "data")))
DB_FILE = DATA_DIR / "goapp.sqlite3"
PORT = int(os.getenv("PORT", "8080"))
DEMO_MODE = os.getenv("DEMO_MODE", "0") == "1"
DEMO_OTP = os.getenv("DEMO_OTP", "123456" if DEMO_MODE else "")
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "0") == "1"
SESSION_DAYS = 30
OTP_MINUTES = 10
PHONE_RE = re.compile(r"^1[3-9]\d{9}$")

with SEED_FILE.open(encoding="utf-8") as seed_handle:
    SEED = json.load(seed_handle)

TAXONOMY = SEED["TAXONOMY"]
TRIPS = {trip["id"]: trip for trip in SEED["TRIPS"]}

DB_INIT_LOCK = threading.Lock()
DB_INITIALIZED = False


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
                """
            )
            updated_at = now_iso()
            for trip in SEED["TRIPS"]:
                conn.execute(
                    """
                    INSERT INTO trips(id, payload, active, updated_at)
                    VALUES (?, ?, 1, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        payload = excluded.payload,
                        active = 1,
                        updated_at = excluded.updated_at
                    """,
                    (trip["id"], json.dumps(trip, ensure_ascii=False), updated_at),
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


def iso_or_blank(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


class AppHandler(BaseHTTPRequestHandler):
    server_version = "Goapp/2.0"
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

    def dispatch(self, method: str) -> None:
        initialize_database()
        try:
            path = urlsplit(self.path).path
            if path.startswith("/api/"):
                self.handle_api(method, path)
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
        rel = unquote(request_path).lstrip("/")
        if not rel or rel.endswith("/"):
            rel += "index.html"
        candidate = (STATIC_DIR / rel).resolve()
        try:
            candidate.relative_to(STATIC_DIR.resolve())
        except ValueError:
            self.send_json({"error": "Not found"}, 404)
            return
        if not candidate.is_file():
            if "." not in Path(rel).name:
                candidate = STATIC_DIR / "index.html"
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

    def handle_api(self, method: str, path: str) -> None:
        conn = db()
        try:
            if method == "GET" and path == "/api/health":
                self.send_json({"ok": True, "database": "sqlite", "version": "2.0.0"})
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
        catalog = {"trips": list(TRIPS.values()), "taxonomy": TAXONOMY}
        if not user:
            self.send_json({"auth": False, "catalog": catalog})
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
        self, conn: sqlite3.Connection, user: sqlite3.Row, cookie: str | None = None
    ) -> None:
        headers = {"Set-Cookie": cookie} if cookie else None
        self.send_json(
            {
                "auth": True,
                "catalog": {"trips": list(TRIPS.values()), "taxonomy": TAXONOMY},
                "user": self.serialize_user(user),
                "addresses": self.serialize_addresses(conn, user["id"]),
                "orders": self.serialize_orders(conn, user["id"]),
                "lastChannel": "wechat",
                "demo": DEMO_MODE,
            },
            headers=headers,
        )

    def request_code(self, conn: sqlite3.Connection) -> None:
        body = self.read_json()
        phone = str(body.get("phone", "")).strip()
        if not PHONE_RE.fullmatch(phone):
            self.send_json({"error": "请输入正确的 11 位手机号"}, 400)
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
        code = DEMO_OTP if DEMO_MODE else f"{secrets.randbelow(1_000_000):06d}"
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
        conn.commit()
        response = {"ok": True, "expiresIn": OTP_MINUTES * 60}
        if DEMO_MODE:
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
        conn.commit()
        self.state_response(conn, user, cookie)

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
        trip = TRIPS["t1"]
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
            valid = self.valid_profile(profile, hobby, personality)
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

    def valid_profile(self, profile: dict, hobby: list, personality: list) -> bool:
        def valid_values(group: str, values: list, max_count: int) -> bool:
            allowed = {item[0] for item in TAXONOMY[group]["options"]}
            return len(values) <= max_count and len(set(values)) == len(values) and set(values) <= allowed

        if not valid_values("hobby", hobby, 5) or not valid_values("personality", personality, 3):
            return False
        occupation = profile.get("occupation")
        gender = profile.get("gender")
        if occupation:
            allowed_occupations = {item[0] for item in TAXONOMY["occupation"]["options"]}
            if occupation not in allowed_occupations:
                return False
        if gender:
            allowed_genders = {item[0] for item in TAXONOMY["gender"]["options"]}
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
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (address_id, user["id"], tag, name, line, detail, is_default, now_iso()),
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
        trip = TRIPS.get(str(body.get("tripId", "")))
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
