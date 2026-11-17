#!/usr/bin/env python3
"""Dependency-free HTTP smoke test for the deployed Goapp service."""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from datetime import date, timedelta
from http.cookiejar import CookieJar


BASE_URL = (os.getenv("BASE_URL") or "http://127.0.0.1:18080").rstrip("/")
jar = CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def request(path: str, method: str = "GET", payload=None) -> tuple[int, str, bytes]:
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE_URL + path, data=data, headers=headers, method=method)
    with opener.open(req, timeout=20) as response:
        return response.status, response.headers.get("Content-Type", ""), response.read()


def json_request(path: str, method: str = "GET", payload=None) -> dict:
    status, _, body = request(path, method, payload)
    if status != 200 and status != 201:
        raise AssertionError(f"{path}: HTTP {status}")
    return json.loads(body)


def main() -> None:
    health = json_request("/api/health")
    assert health["ok"] and health["database"] == "sqlite"
    print("✓ health / SQLite")

    status, content_type, body = request("/")
    assert status == 200 and "text/html" in content_type
    assert b"app.js" in body
    status, _, app_body = request("/app.js")
    assert status == 200 and b"APP_VER = '2.3.0'" in app_body
    print("✓ static PWA")

    state = json_request("/api/auth/demo", "POST", {})
    assert state["auth"] and state["user"]["nickname"]
    assert len(state["addresses"]) == 1
    print("✓ demo session")

    travel = (date.today() + timedelta(days=2)).isoformat()
    created = json_request(
        "/api/orders",
        "POST",
        {
            "tripId": "t1",
            "people": 4,
            "travelDate": travel,
            "channel": "wechat",
        },
    )["order"]
    assert created["status"] == "paid" and created["perPerson"] == 221
    assert len(created["vouchers"]) == 3
    print("✓ server pricing / order / voucher fan-out")

    voucher_id = created["vouchers"][0]["id"]
    status, content_type, body = request(f"/api/vouchers/{voucher_id}/qr.svg")
    assert status == 200 and content_type.startswith("image/svg+xml")
    assert b"<svg" in body
    print("✓ scannable QR SVG")

    refreshed = json_request("/api/bootstrap")
    assert refreshed["auth"] and any(o["id"] == created["id"] for o in refreshed["orders"])
    print("✓ SQLite persistence after reload")

    json_request("/api/auth/logout", "POST", {})
    assert json_request("/api/bootstrap")["auth"] is False
    print("✓ logout / session revocation")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"✗ {exc}", file=sys.stderr)
        raise
