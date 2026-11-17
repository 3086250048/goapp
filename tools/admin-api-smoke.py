#!/usr/bin/env python3
"""管理后台 API 全链路自检；会创建并清理临时标签和用户。"""

from __future__ import annotations

import json
import os
import secrets
import sys
import urllib.error
import urllib.request
from http.cookiejar import CookieJar


BASE_URL = (os.getenv("BASE_URL") or "http://127.0.0.1:18080").rstrip("/")
USERNAME = os.getenv("ADMIN_USERNAME", "admin")
PASSWORD = os.getenv("ADMIN_PASSWORD", "")
jar = CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def request(path: str, method: str = "GET", payload=None):
    body = None
    headers = {}
    if payload is not None:
        body = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE_URL + path, data=body, headers=headers, method=method)
    try:
        with opener.open(req, timeout=20) as response:
            return response.status, response.headers.get("Content-Type", ""), response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.headers.get("Content-Type", ""), error.read()


def json_request(path: str, method: str = "GET", payload=None, expected=(200, 201)):
    status, _, body = request(path, method, payload)
    if status not in expected:
        raise AssertionError(f"{path}: HTTP {status} {body[:200]!r}")
    return json.loads(body)


def main() -> None:
    if not PASSWORD:
        raise RuntimeError("缺少 ADMIN_PASSWORD")
    status, content_type, body = request("/admin/")
    assert status == 200 and "text/html" in content_type and b"admin.js" in body
    print("✓ 后台静态页面")

    unauth_status, _, _ = request("/api/admin/dashboard")
    assert unauth_status == 401
    print("✓ 未登录访问被拒绝")

    login = json_request(
        "/api/admin/login",
        "POST",
        {"username": USERNAME, "password": PASSWORD},
    )
    assert login["authenticated"] and login["admin"]["username"] == USERNAME
    print("✓ 管理员登录")

    dashboard = json_request("/api/admin/dashboard")
    assert dashboard["metrics"]["users"] >= 0
    print("✓ 仪表盘")

    suffix = secrets.token_hex(4)
    trip_payload = {
        "title": "自检城市漫步 + 特色咖啡",
        "city": "本地",
        "durationHours": 5,
        "distance": 2300,
        "sortOrder": 998,
        "active": True,
        "tags": ["play", "food"],
        "cover": {"from": "#D79A6A", "to": "#8A4B2C", "emoji": "☕"},
        "stops": [
            {
                "name": "自检街区",
                "type": "play",
                "time": "10:00",
                "stay": 90,
                "leg": "步行 5 分钟",
                "items": [
                    {"icon": "🚶", "name": "街区漫步", "price": 0, "mode": "pp"},
                    {"icon": "☕", "name": "手冲咖啡", "price": 38, "mode": "pp"},
                ],
            }
        ],
    }
    trip = json_request("/api/admin/trips", "POST", trip_payload)["trip"]
    catalog = json_request("/api/bootstrap")["catalog"]["trips"]
    assert any(item["id"] == trip["id"] for item in catalog)
    print("✓ 首页项目创建并进入用户目录")

    trip_payload["title"] = "自检城市夜游 + 特色咖啡"
    trip_payload["active"] = False
    json_request(f"/api/admin/trips/{trip['id']}", "PATCH", trip_payload)
    catalog = json_request("/api/bootstrap")["catalog"]["trips"]
    assert all(item["id"] != trip["id"] for item in catalog)
    print("✓ 首页项目下线")

    tag_code = f"smoke_{suffix}"
    tag = json_request(
        "/api/admin/tags",
        "POST",
        {
            "group": "hobby",
            "code": tag_code,
            "label": "自检标签",
            "sortOrder": 999,
            "enabled": True,
        },
    )
    phone = "139" + "".join(str(secrets.randbelow(10)) for _ in range(8))
    user = json_request(
        "/api/admin/users",
        "POST",
        {
            "phone": phone,
            "nickname": "后台自检用户",
            "profile": {
                "hobby": [tag_code],
                "personality": [],
                "occupation": None,
                "gender": None,
            },
        },
    )["user"]
    print("✓ 临时标签与用户创建")

    updated = json_request(
        f"/api/admin/users/{user['id']}",
        "PATCH",
        {
            "phone": phone,
            "nickname": "后台自检已改",
            "profile": user["profile"],
        },
    )["user"]
    assert updated["nickname"] == "后台自检已改"
    print("✓ 用户修改")

    status, _, body = request(
        f"/api/admin/tags/{tag['id']}",
        "DELETE",
        {},
    )
    assert status == 409 and json.loads(body)["code"] == "TAG_IN_USE"
    json_request(f"/api/admin/tags/{tag['id']}?force=1", "DELETE", {})
    cleaned = json_request(f"/api/admin/users/{user['id']}")["user"]
    assert tag_code not in cleaned["profile"]["hobby"]
    print("✓ 标签引用清理")

    json_request(f"/api/admin/users/{user['id']}", "DELETE", {})
    json_request(f"/api/admin/trips/{trip['id']}", "DELETE", {})
    orders = json_request("/api/admin/orders?limit=1")
    audit = json_request("/api/admin/audit?limit=10")
    assert orders["total"] >= 0 and audit["total"] >= 1
    assert any(item["action"] == "user.delete" for item in audit["items"])
    assert any(item["action"] == "trip.delete" for item in audit["items"])
    print("✓ 用户/首页项目删除、订单查询与审计")

    json_request("/api/admin/logout", "POST", {})
    assert request("/api/admin/dashboard")[0] == 401
    print("✓ 管理员退出")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"✗ {exc}", file=sys.stderr)
        raise
