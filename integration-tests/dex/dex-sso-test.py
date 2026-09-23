#!/usr/bin/env python3
"""Dex SSO 集成测试 — 完整 OIDC 授权码流(模拟浏览器)。

要验证的契约(每一步都必须有**有判别力**的判据,不成立即 FAIL):
1. GET  /api/client/v2/auth/oidc/login → 302,Location 指向 IdP(并下发 state cookie)
2. 跟随该 Location:必须真的落在 **IdP 的登录页**(页面上有密码表单字段)
3. POST IdP 凭据:必须**离开**登录页(停在带错误文案的登录表单上 = 凭据被拒)
4. IdP 要求授权确认时 POST approve:必须继续往服务端回调走
5. 服务端回调:必须 302 到**深链** `<scheme>://auth?token=…&user=…`(读 Location 头)
6. 深链 token 必须能调 /api/client/v2/auth/me,且返回的就是**本次登录的那个账号**

为什么"手动跟随重定向"(2026-09-23 审计 W3-02):
    urllib **无法跟随自定义 scheme**(`picoaide://…`):它抛 HTTPError,而旧 `fetch()` 的
    异常分支返回的是**传入的 url**(=回调地址)⇒ `'picoaide://' in url` 恒假、else 分支
    必然执行 —— 即使 SSO 全流程正常,用例也永远 `RESULT: FAIL`(深链断言结构上不可达)。
    本脚本改为手动跟随 http(s) 重定向、一遇到非 http(s) 的 Location 就停下并把它当深链
    读出来(见 `follow()`)。**负向对照**:把深链换成 http 目标时 `follow()` 会继续跟随到
    终点 ⇒ "有没有拿到深链"是有判别力的,不是恒真/恒假。

环境缺失时**显式 SKIP**(退出码 77),绝不打印 PASS:
    · /healthz 不可达(服务端没起)
    · /api/server/admin/auth/methods 显示 oidc/openid 都未配置
退出码:0 = PASS;1 = FAIL(契约不满足);2 = 用法错误;77 = SKIP(未验证任何东西)。

用法:
    python3 dex-sso-test.py [server_base] [--user <login>] [--password <pw>]
    python3 dex-sso-test.py --self-test      # 判据自检,不需要服务端/Docker/Dex
环境变量:DEX_BASE(可选)断言 IdP 落在该 origin;DEX_DEEP_LINK_SCHEME(可选)断言深链 scheme;
        DEX_EXPECTED_USER 覆盖期望账号。
数据(integration-tests/dex/config.yaml):admin@example.com / admin123。
"""
import http.cookiejar
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_BASE = 'http://127.0.0.1:8091'
DEFAULT_USER = 'admin@example.com'
DEFAULT_PASSWORD = 'admin123'
PROVIDER = 'oidc'
CALLBACK_PATH = f'/api/client/v2/auth/{PROVIDER}/callback'

EXIT_PASS, EXIT_FAIL, EXIT_USAGE, EXIT_SKIP = 0, 1, 2, 77

# ---------------------------------------------------------------------------
# HTTP 原语(全部**不**自动跟随重定向 —— 跟随由 follow() 显式驱动)
# ---------------------------------------------------------------------------
class NoRedirect(urllib.request.HTTPRedirectHandler):
    """让 3xx 原样返回(带 Location 头),而不是自动跟随。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def make_opener(jar):
    return urllib.request.build_opener(NoRedirect(), urllib.request.HTTPCookieProcessor(jar))


def request(op, url, data=None, headers=None):
    """单次请求,不跟随重定向。返回 (status, location, body, headers)。"""
    req = urllib.request.Request(url, data=data, headers=headers or {})
    try:
        with op.open(req, timeout=15) as r:
            return r.status, r.headers.get('Location', ''), r.read().decode('utf-8', 'replace'), dict(r.headers)
    except urllib.error.HTTPError as e:
        # NoRedirect 让 3xx 走这里 —— 状态码与 Location 头都在,是本脚本的主路径。
        return e.code, (e.headers.get('Location', '') if e.headers else ''), \
            e.read().decode('utf-8', 'replace'), dict(e.headers or {})
    except urllib.error.URLError as e:
        return 0, '', str(e), {}


def is_http(url):
    return url.lower().startswith(('http://', 'https://'))


def follow(op, url, data=None, headers=None, max_hops=10):
    """手动跟随 http(s) 重定向。

    返回 (status, final_url, body, headers, deep_link, hops)：
    遇到**非 http(s)** 的 Location(即桌面深链)时立刻停下,把它放在 deep_link 里;
    其它情况 deep_link 为空串。hops = [(status, url), …] 供诊断与"经过回调"断言。
    """
    current, payload, req_headers = url, data, headers
    hops = []
    status, location, body, resp_headers = 0, '', '', {}
    for _ in range(max_hops):
        status, location, body, resp_headers = request(op, current, data=payload, headers=req_headers)
        hops.append((status, current))
        if status in (301, 302, 303, 307, 308) and location:
            if not is_http(location):
                return status, current, body, resp_headers, location, hops
            # 303/302 → 后续按 GET 走(丢弃 POST 体),与浏览器语义一致。
            current, payload, req_headers = location, None, None
            continue
        break
    return status, current, body, resp_headers, '', hops


# ---------------------------------------------------------------------------
# 判据(纯函数,便于 --self-test 用合成夹具证明"有判别力")
# ---------------------------------------------------------------------------
def parse_deep_link(location):
    """把深链 Location 拆成 (scheme, host, query dict)。"""
    parsed = urllib.parse.urlparse(location)
    return parsed.scheme.lower(), parsed.netloc, urllib.parse.parse_qs(parsed.query)


def deep_link_problems(location, expected_scheme=''):
    """深链判据:自定义 scheme + host=auth + 非空 token。空列表 = 通过。"""
    problems = []
    if not location:
        return ['回调响应没有 Location 头(服务端没有下发深链)']
    scheme, host, query = parse_deep_link(location)
    if scheme in ('', 'http', 'https'):
        return [f'Location 不是自定义 scheme 深链,而是 {location[:120]}']
    if expected_scheme and scheme != expected_scheme:
        problems.append(f'深链 scheme={scheme!r} 与期望 {expected_scheme!r} 不一致')
    if host != 'auth':
        problems.append(f'深链 host 必须是 auth,实际 {host!r}')
    token = (query.get('token') or [''])[0]
    if len(token) < 16:
        problems.append(f'深链 token 缺失或过短(len={len(token)})')
    return problems


def login_page_problems(url, body, idp_origin):
    """步骤 2 判据:必须落在 IdP origin 且页面上有密码表单。"""
    problems = []
    if not idp_origin or not url.startswith(idp_origin):
        problems.append(f'没有落在 IdP({idp_origin or "未知"})上,实际 {url[:120]}')
    lower = body.lower()
    if not any(marker in lower for marker in ('type="password"', "type='password'", 'name="password"')):
        problems.append('IdP 页面没有密码表单字段 —— 没到登录页')
    return problems


def login_submit_problems(status, body):
    """步骤 3 判据:提交凭据后必须离开登录页。"""
    problems = []
    if status == 0:
        return ['IdP 登录 POST 没有响应(连接失败)']
    if status >= 400:
        problems.append(f'IdP 登录 POST 返回 {status}')
    lower = body.lower()
    for marker in ('invalid login', 'incorrect username', 'invalid credentials', '用户名或密码错误', '密码错误'):
        if marker in lower:
            problems.append(f'IdP 回显登录失败文案({marker!r})')
    if any(marker in lower for marker in ('type="password"', "type='password'", 'name="password"')):
        problems.append('提交凭据后仍停在登录表单(凭据被拒或表单参数不对)')
    return problems


def approve_problems(status, url, body):
    """步骤 4 判据:提交 approve 后必须离开授权确认页。"""
    problems = []
    if status == 0:
        return ['授权确认 POST 没有响应(连接失败)']
    if status >= 400:
        problems.append(f'授权确认 POST 返回 {status}')
    if 'approval' in url:
        problems.append(f'提交 approve 后仍停在授权确认页: {url[:120]}')
    lower = body.lower()
    if any(marker in lower for marker in ('type="password"', "type='password'", 'name="password"')):
        problems.append('提交 approve 后回到了登录表单')
    return problems


def me_problems(status, body, expected_user, expected_email):
    """/auth/me 判据:200 + JSON + 身份就是本次登录的账号。"""
    problems = []
    if status != 200:
        return [f'/auth/me 返回 {status}: {body[:120]}']
    try:
        payload = json.loads(body)
    except ValueError as exc:
        return [f'/auth/me 不是 JSON({exc}): {body[:120]}']
    user = payload.get('user') or {}
    username = str(user.get('username') or '')
    email = str(user.get('email') or '')
    if not username and not email:
        return ['/auth/me 没有 username/email 字段']
    # 只认"本次登录的那个账号":任意其它账号(或空)都不是通过。
    if username != expected_user and email != expected_email:
        problems.append(f'/auth/me 的身份是 {username!r}/{email!r},不是本次登录的 {expected_user!r}')
    return problems


# ---------------------------------------------------------------------------
# 用例自检(不需要服务端):每条判据都要**拒绝**它的负例 —— 只有正例过 = 恒真
# ---------------------------------------------------------------------------
GOOD_DEEP_LINK = 'picoaide://auth?token=' + 'a1b2c3d4' * 5 + '&user=admin'
GOOD_LOGIN_PAGE = '<html><form method="post" action="/dex/auth/local?req=x">' \
    '<input type="text" name="login"><input type="password" name="password"></form></html>'


def self_test():
    cases = []

    def expect(label, problems, want_empty):
        cases.append((label, (len(problems) == 0) == want_empty, problems))

    expect('深链/正例(picoaide://auth?token=…)', deep_link_problems(GOOD_DEEP_LINK), True)
    expect('深链/负例:http 目标', deep_link_problems('http://127.0.0.1:8091/api/client/v2/auth/oidc/callback?code=x'), False)
    expect('深链/负例:相对地址', deep_link_problems('/auth/callback?code=x'), False)
    expect('深链/负例:空 Location', deep_link_problems(''), False)
    expect('深链/负例:host 不是 auth', deep_link_problems('picoaide://evil?token=' + 'a' * 40), False)
    expect('深链/负例:token 过短', deep_link_problems('picoaide://auth?token=abc'), False)
    expect('深链/负例:scheme 与期望不符',
           deep_link_problems(GOOD_DEEP_LINK, expected_scheme='example-harness'), False)
    expect('深链/正例:scheme 命中期望',
           deep_link_problems(GOOD_DEEP_LINK, expected_scheme='picoaide'), True)

    idp = 'http://127.0.0.1:5556'
    expect('IdP 登录页/正例', login_page_problems(idp + '/dex/auth/local?req=x', GOOD_LOGIN_PAGE, idp), True)
    expect('IdP 登录页/负例:停在服务端(未到 IdP)',
           login_page_problems('http://127.0.0.1:8091/api/client/v2/auth/oidc/login', GOOD_LOGIN_PAGE, idp), False)
    expect('IdP 登录页/负例:没有密码表单',
           login_page_problems(idp + '/dex/auth/local', '<html>error</html>', idp), False)

    expect('提交登录/正例:303 离开登录页', login_submit_problems(303, ''), True)
    expect('提交登录/负例:仍停在登录表单', login_submit_problems(200, GOOD_LOGIN_PAGE), False)
    expect('提交登录/负例:回显登录失败', login_submit_problems(200, '<p>Invalid login</p>'), False)
    expect('提交登录/负例:5xx', login_submit_problems(500, 'boom'), False)

    expect('授权确认/正例:已离开 approval', approve_problems(200, 'http://127.0.0.1:8091/api/client/v2/auth/oidc/callback?code=x', ''), True)
    expect('授权确认/负例:仍停在 approval 页',
           approve_problems(200, 'http://127.0.0.1:5556/dex/approval?req=x', '<form action="/approval"></form>'), False)
    expect('授权确认/负例:回到登录表单', approve_problems(200, 'http://127.0.0.1:5556/dex/auth/local', GOOD_LOGIN_PAGE), False)
    expect('授权确认/负例:5xx', approve_problems(500, 'http://127.0.0.1:5556/dex/approval', 'boom'), False)

    expect('me/正例:本次登录账号', me_problems(200, '{"user":{"username":"admin"}}', 'admin', 'admin@example.com'), True)
    expect('me/正例:邮箱命中', me_problems(200, '{"user":{"email":"admin@example.com"}}', 'admin', 'admin@example.com'), True)
    expect('me/负例:别的账号', me_problems(200, '{"user":{"username":"alice"}}', 'admin', 'admin@example.com'), False)
    expect('me/负例:仅含 admin 字样的其它字段',
           me_problems(200, '{"user":{"id":7,"role":"admin"}}', 'admin', 'admin@example.com'), False)
    expect('me/负例:401', me_problems(401, '{"error":{"code":"AUTH_REQUIRED"}}', 'admin', 'admin@example.com'), False)

    bad = [label for label, ok, _ in cases if not ok]
    for label, ok, detail in cases:
        print(f'  {"ok  " if ok else "FAIL"} {label}{"" if ok else "  " + str(detail)}')
    print(f'self-test: {len(cases) - len(bad)}/{len(cases)} 条判据夹具符合预期')
    if bad:
        print(f'self-test: FAIL —— 有判别力的判据不足: {bad}')
        return EXIT_FAIL
    return EXIT_PASS


# ---------------------------------------------------------------------------
def parse_args(argv):
    server, user, password, want_self_test = DEFAULT_BASE, DEFAULT_USER, DEFAULT_PASSWORD, False
    positional = []
    rest = list(argv)
    while rest:
        item = rest.pop(0)
        if item == '--self-test':
            want_self_test = True
        elif item == '--user' and rest:
            user = rest.pop(0)
        elif item == '--password' and rest:
            password = rest.pop(0)
        elif item in ('-h', '--help'):
            print(__doc__)
            raise SystemExit(EXIT_PASS)
        elif item.startswith('-'):
            print(f'dex-sso-test: 未知参数 {item}(用 --help)', file=sys.stderr)
            raise SystemExit(EXIT_USAGE)
        else:
            positional.append(item)
    if len(positional) > 1:
        print('dex-sso-test: 最多给一个位置参数(server_base)', file=sys.stderr)
        raise SystemExit(EXIT_USAGE)
    if positional:
        server = positional[0].rstrip('/')
    return server, user, password, want_self_test


def main(argv):
    server, login, password, want_self_test = parse_args(argv)
    if want_self_test:
        return self_test()

    expected_user = os.environ.get('DEX_EXPECTED_USER') or login.split('@')[0]
    expected_email = login
    idp_expected = os.environ.get('DEX_BASE', '').rstrip('/')
    expected_scheme = os.environ.get('DEX_DEEP_LINK_SCHEME', '')

    results = []

    def check(name, problems, detail=''):
        ok = not problems
        results.append(ok)
        print(f'{"✓" if ok else "✗"} {name}{("  " + detail) if detail else ""}')
        for problem in problems:
            print(f'    - {problem}')
        return ok

    print(f'== Dex SSO 集成测试(server={server} provider={PROVIDER} login={login}) ==')

    jar = http.cookiejar.CookieJar()
    op = make_opener(jar)

    # 0. 环境探测 —— 先分清"环境没起来(SKIP)"与"契约不满足(FAIL)"。
    status, _, body, _ = request(op, server + '/healthz')
    if status != 200:
        print(f'SKIP: {server}/healthz 不可达/非 200(status={status}) —— 服务端没起来,本次未验证任何东西')
        return EXIT_SKIP
    status, _, methods_body, _ = request(op, server + '/api/server/admin/auth/methods')
    if status == 200:
        try:
            names = {m.get('name') for m in json.loads(methods_body).get('methods', []) if m.get('configured')}
        except (ValueError, AttributeError):
            names = set()
        if names and not names & {'oidc', 'openid'}:
            print(f'SKIP: 服务端未配置浏览器跳转登录(configured={sorted(names)}) —— '
                  '本用例验证的是 OIDC 授权码流,配置缺失时未验证任何东西')
            return EXIT_SKIP

    # 1. 启动登录流:不跟随,拿 state cookie + IdP 授权地址。
    status, authorize, _, _ = request(op, f'{server}/api/client/v2/auth/{PROVIDER}/login')
    check(f'[1] GET /auth/{PROVIDER}/login → 302 且 Location 指向 IdP',
          [] if status == 302 and authorize else [f'status={status} Location={authorize[:80]!r}'],
          f'status={status} Location={authorize[:70]}')
    if status != 302 or not authorize:
        print('RESULT: FAIL')
        return EXIT_FAIL

    # 2. 跟随到 IdP(第一次跳转就吃自定义 scheme 的话说明配置把 IdP 指成了非 http)。
    status, url, body, _, deep_link, hops = follow(op, authorize)
    check('[2] 落在 IdP 登录页(有密码表单)',
          login_page_problems(url, body, idp_expected or urllib.parse.urlparse(authorize).scheme + '://'
                              + urllib.parse.urlparse(authorize).netloc),
          f'status={status} url={url[:90]}')
    if not results[-1]:
        print('RESULT: FAIL')
        return EXIT_FAIL

    # 3. 提交凭据(表单 POST 到当前 url,带 state;Dex 表单无 csrf)。
    form = urllib.parse.urlencode({'login': login, 'password': password}).encode()
    status, url, body, _, deep_link, hops = follow(
        op, url, data=form,
        headers={'Content-Type': 'application/x-www-form-urlencoded', 'Referer': url})
    check('[3] 提交 IdP 凭据后离开登录页', login_submit_problems(status, body),
          f'status={status} url={url[:90]}')

    # 4. IdP 要求授权确认时继续提交(不能只是"看到 approval 就跳过")。
    if 'approval' in url:
        form = urllib.parse.urlencode({'approve': 'true', 'grant_scope': 'openid profile email'}).encode()
        status, url, body, _, deep_link, hops = follow(
            op, url, data=form,
            headers={'Content-Type': 'application/x-www-form-urlencoded', 'Referer': url})
        check('[4] 授权确认后离开 approval(继续往回调走)', approve_problems(status, url, body),
              f'status={status} url={url[:90]}')
    else:
        print(f'  ·  [4] IdP 未要求授权确认(直接回调),跳过 approve 提交')

    reached_callback = any(CALLBACK_PATH in hop_url and 'code=' in hop_url for _, hop_url in hops)
    check(f'[5] 授权码回到 {CALLBACK_PATH}', [] if reached_callback else ['回调链里没有出现带 code 的回调地址'],
          '；'.join(f'{code} {hop[:70]}' for code, hop in hops[-3:]))

    # 5. 回调必须下发深链 —— 读 Location 头(不跟随自定义 scheme)。
    check('[5] 回调 302 到深链 <scheme>://auth?token=…', deep_link_problems(deep_link, expected_scheme),
          f'Location={deep_link[:90]}')
    if not deep_link:
        print('  （深链缺失:回调响应见上一步诊断；服务端 302 目标不是自定义 scheme 即判失败）')
        print('RESULT: FAIL')
        return EXIT_FAIL

    # 6. 深链 token 必须真的能登录,且是本次登录的账号。
    _, _, query = parse_deep_link(deep_link)
    token = (query.get('token') or [''])[0]
    print(f'  ·  深链 token 长度={len(token)}')
    status, _, body, _ = request(make_opener(http.cookiejar.CookieJar()), f'{server}/api/client/v2/auth/me',
                                 headers={'Authorization': 'Bearer ' + token})
    check('[6] 深链 token 调 /auth/me 且身份=本次登录账号',
          me_problems(status, body, expected_user, expected_email), f'status={status} body={body[:90]}')

    ok = all(results)
    print('RESULT:', 'PASS' if ok else 'FAIL')
    return EXIT_PASS if ok else EXIT_FAIL


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
