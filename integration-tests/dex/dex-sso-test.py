#!/usr/bin/env python3
"""Dex SSO 集成测试 — 完整 OIDC 授权码流(模拟浏览器)。

验证:
1. 服务端 /api/auth/oidc/login 302 → Dex(state cookie)
2. Dex 登录表单提交 → 授权码
3. 服务端 /api/auth/oidc/callback 换 token → picoaide:// 深链
4. 深链 token 可调用 /api/auth/me(员工面登录成功)

用法: python3 dex-sso-test.py [server_base] (默认 http://127.0.0.1:8091)
"""
import http.cookiejar
import sys
import urllib.parse
import urllib.request
import re
import ssl

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8091'
DEX = 'http://127.0.0.1:5556'

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # 不自动跟随, 返回 Location

class FollowRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return super().redirect_request(req, fp, code, msg, headers, newurl)

def make_opener(cj, follow=True):
    handler = FollowRedirect() if follow else NoRedirect()
    return urllib.request.build_opener(handler, urllib.request.HTTPCookieProcessor(cj))

def fetch(op, url, data=None, headers=None):
    req = urllib.request.Request(url, data=data, headers=headers or {})
    try:
        with op.open(req, timeout=15) as r:
            return r.status, r.geturl(), r.read().decode('utf-8', errors='replace'), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, url, e.read().decode('utf-8', errors='replace'), dict(e.headers)
    except urllib.error.URLError as e:
        return 0, url, str(e), {}

def main():
    ok = True
    # 1. 启动 OIDC 登录: 不跟随 → 拿 state cookie + Location 到 Dex
    cj = http.cookiejar.CookieJar()
    op = make_opener(cj, follow=False)
    st, url, body, hdrs = fetch(op, BASE + '/api/auth/oidc/login')
    loc = hdrs.get('Location', '')
    print(f'[1] oidc/login -> {st} Location={loc[:70]}')
    if st != 302 or loc == '':
        print('  FAIL: 未 302'); ok = False; return
    # 2. 直接访问服务端 302 的 Location(完整参数: state/code_challenge)
    op2 = make_opener(cj, follow=True)
    st, url, body, hdrs = fetch(op2, loc)
    print(f'[2] dex authorize -> {st} url={url[:90]}')
    if 'login' not in url and 'auth/local' not in body:
        print('  FAIL: 未到 Dex 登录页'); ok = False
    # 3. 提交 Dex 登录(POST 到当前 url, 带 state; Dex 表单无 csrf)
    st, url, body, hdrs = fetch(op2, url, data=urllib.parse.urlencode({
        'login': 'admin@example.com', 'password': 'admin123',
    }).encode(), headers={'Content-Type': 'application/x-www-form-urlencoded', 'Referer': url})
    print(f'[3] dex login -> {st} url={url[:100]}')
    # 4. 授权确认(approve) → 跳回服务端回调(code)
    if 'approval' in url:
        st, url, body, hdrs = fetch(op2, url, data=urllib.parse.urlencode({
            'approve': 'true', 'grant_scope': 'openid profile email',
        }).encode(), headers={'Content-Type': 'application/x-www-form-urlencoded', 'Referer': url})
        print(f'[4] dex approve -> {st} url={url[:100]}')
    # 5. 回调(跟随重定向到 picoaide:// — urllib 不支持, 捕获 URL)
    cj2 = http.cookiejar.CookieJar()
    op3 = make_opener(cj2, follow=True)
    # 用服务端回调所需 cookie: oidc state cookie 在 cj 中(域 127.0.0.1:8091)
    st, url, body, hdrs = fetch(op2, url)
    print(f'[5] callback -> {st} url={url[:130]}')
    if 'picoaide://' in url:
        token = urllib.parse.parse_qs(urllib.parse.urlparse(url).query).get('token', [''])[0]
        print(f'  OK: 深链 token 长度={len(token)}')
        # 6. 用 token 调 /api/auth/me
        st, url, body, hdrs = fetch(op2, BASE + '/api/auth/me', headers={'Authorization': 'Bearer ' + token})
        print(f'[6] /api/auth/me -> {st} {body[:120]}')
        if st != 200 or 'admin@example.com' not in body and 'admin' not in body:
            print('  FAIL: me 校验'); ok = False
    else:
        print('  FAIL: 未拿到深链'); ok = False
    print('RESULT:', 'PASS' if ok else 'FAIL')
    sys.exit(0 if ok else 1)

if __name__ == '__main__':
    main()
