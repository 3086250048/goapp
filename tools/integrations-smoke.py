#!/usr/bin/env python3
"""检查短信、高德、微信和 QQ 的配置与降级行为。"""

from __future__ import annotations

import json
import os
import secrets
import sys
import urllib.error
import urllib.request
from http.cookiejar import CookieJar


BASE_URL = (os.getenv("BASE_URL") or "http://127.0.0.1:18080").rstrip("/")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(path: str, method: str = "GET", payload=None, opener=None):
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE_URL + path, data=data, headers=headers, method=method)
    try:
        open_request = opener.open if opener else urllib.request.urlopen
        with open_request(req, timeout=20) as response:
            return response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers), error.read()


def main() -> None:
    status, _, body = request("/api/public-config")
    assert status == 200
    config = json.loads(body)["integrations"]
    print(f"短信：{config['sms']['provider']} enabled={config['sms']['enabled']}")
    print(f"高德：enabled={config['amap']['enabled']}")
    print(f"微信：enabled={config['wechat']['enabled']}")
    print(f"QQ：enabled={config['qq']['enabled']}")

    if config["sms"]["enabled"] and config["sms"]["demo"]:
        phone = "139" + "".join(str(secrets.randbelow(10)) for _ in range(8))
        status, _, body = request(
            "/api/auth/request-code", "POST", {"phone": phone}
        )
        assert status == 200 and json.loads(body).get("demoCode")
        print("✓ 体验短信验证码")
    elif config["sms"]["enabled"]:
        print("· 真实短信已配置；自检不主动发送计费短信")
    else:
        status, _, _ = request(
            "/api/auth/request-code",
            "POST",
            {"phone": "13900000000"},
        )
        assert status == 503
        print("✓ 短信未配置时明确拒绝")

    jar = CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    if config["amap"]["enabled"]:
        print("· 高德 Key 已配置；建议用真实定位做人工验收")
    else:
        status, _, _ = request(
            "/api/location/search?keywords=%E5%8C%97%E4%BA%AC",
            opener=opener,
        )
        assert status == 401
        if config["sms"]["demo"]:
            status, _, _ = request("/api/auth/demo", "POST", {}, opener)
            assert status == 200
            status, _, _ = request(
                "/api/location/search?keywords=%E5%8C%97%E4%BA%AC",
                opener=opener,
            )
            assert status == 503
            print("✓ 高德未配置时登录用户得到明确提示")
        else:
            print("✓ 高德未配置时地址接口受登录保护")

    no_redirect = urllib.request.build_opener(NoRedirect())
    for provider, host in (
        ("wechat", "open.weixin.qq.com"),
        ("qq", "graph.qq.com"),
    ):
        status, headers, _ = request(
            f"/api/auth/oauth/{provider}/start?return_to=%2F",
            opener=no_redirect,
        )
        if config[provider]["enabled"]:
            assert status in (301, 302, 303, 307, 308)
            assert host in headers.get("Location", "")
            print(f"✓ {provider} 授权跳转")
        else:
            assert status == 503
            print(f"✓ {provider} 未配置时明确拒绝")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"✗ {exc}", file=sys.stderr)
        raise
