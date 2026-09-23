#!/usr/bin/env python3
"""OpenLDAP + RBAC + 渠道(品牌) 集成测试(真实服务端)。

要验证的契约(每条都必须有**有判别力**的判据,不成立即 FAIL):
1. LDAP 员工面登录成功(alice,role=user)
2. 本地 admin 后台登录成功(拿到 csrf_token)
3. auditor 员工面被拒(401 **且** error.code=AUDITOR_NOT_ALLOWED)
4. auditor 后台登录成功,权限恰好 = 三只读(audit:read/usage:read/user:read)
5. auditor **读**端点可用(200),**写**端点被 RBAC 拒(403 FORBIDDEN);
   对照:同一写端点在**无会话**时必须是 401(证明 403 来自权限判定,不是"什么都拒")
6. GET /api/client/v2/channel 返回真契约(channel_id/title/login.display_name 非空,
   logo_url 指向 /api/client/v2/channel/logo)
7. 门户首页 200 且是门户页(含「客户端下载」一节)

两处历史缺陷(2026-09-23 审计 W3-03/W3-04,均已修):
    · `:77-82` 断言的是 2026-09-10 已被渠道配置取代的旧 brand 契约
      (`"enabled":true` / `"Acme AI"`)⇒ `/channel` 响应里根本没有这两个键,
      该用例**必然**走 else 分支并判失败(不可达的 PASS)。
    · `:70-75` 的"auditor 写面被拒(非 200)"用**伪造** cookie(`picoaide_session=x`)
      ⇒ 恒 401 ⇒ `st != 200` 恒真:验证的是"伪造会话被拒",不是"auditor 无写权限",
      且真出现 RBAC fall-open(200/400)时也测不出。现在用真会话 + 真 CSRF 断言 403。

环境缺失时**显式 SKIP**(退出码 77),绝不打印 PASS:
    · /healthz 不可达;· /api/server/admin/auth/methods 显示 ldap 未配置
退出码:0 = PASS;1 = FAIL(契约不满足);2 = 用法错误;77 = SKIP(未验证任何东西)。

用法:
    python3 ldap-rbac-brand-test.py [server_base]
    python3 ldap-rbac-brand-test.py --self-test     # 判据自检,不需要服务端/容器
数据(integration-tests/README.md):LDAP alice/alice123;admin/admin123456;audit01/audit12345。
未覆盖(显式记账,不是静默跳过):§1.2 的「测试连接」端点需要 admin 会话 + 真实 LDAP bind,
本脚本不写配置,留待人工/webadmin 用例。
"""
import http.cookiejar
import json
import sys
import urllib.error
import urllib.request

DEFAULT_BASE = 'http://127.0.0.1:8091'
LDAP_USER, LDAP_PASSWORD = 'alice', 'alice123'
ADMIN_USER, ADMIN_PASSWORD = 'admin', 'admin123456'
AUDITOR_USER, AUDITOR_PASSWORD = 'audit01', 'audit12345'
READONLY_PERMS = {'audit:read', 'usage:read', 'user:read'}
LOGO_PATH = '/api/client/v2/channel/logo'

EXIT_PASS, EXIT_FAIL, EXIT_USAGE, EXIT_SKIP = 0, 1, 2, 77


# ---------------------------------------------------------------------------
# HTTP 会话(cookie jar:管理后台的会话是 HttpOnly cookie,不是 bearer)
# ---------------------------------------------------------------------------
class Session:
    """一个独立的浏览器会话(自带 cookie jar)。"""

    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def call(self, method, url, body=None, headers=None):
        """返回 (status, raw_body, headers)。连接失败 → status=0。"""
        data = None if body is None else json.dumps(body).encode()
        hdrs = dict(headers or {})
        if data is not None:
            hdrs.setdefault('Content-Type', 'application/json')
        req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
        try:
            with self.opener.open(req, timeout=10) as resp:
                return resp.status, resp.read().decode('utf-8', 'replace'), dict(resp.headers)
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read().decode('utf-8', 'replace'), dict(exc.headers or {})
        except Exception as exc:  # noqa: BLE001 - 连接类错误统一成 status=0
            return 0, str(exc), {}

    def get(self, url, headers=None):
        return self.call('GET', url, None, headers)

    def post(self, url, body=None, headers=None):
        return self.call('POST', url, body if body is not None else {}, headers)

    def put(self, url, body=None, headers=None):
        return self.call('PUT', url, body if body is not None else {}, headers)


def json_body(raw):
    """解析 JSON 响应体。返回 (obj, problems)。"""
    try:
        return json.loads(raw or '{}'), []
    except ValueError as exc:
        return None, [f'响应不是 JSON({exc}): {raw[:120]}']


def error_code(raw):
    obj, _ = json_body(raw)
    if isinstance(obj, dict):
        err = obj.get('error')
        if isinstance(err, dict):
            return str(err.get('code') or '')
    return ''


# ---------------------------------------------------------------------------
# 判据(纯函数,便于 --self-test 用合成夹具证明"有判别力")
# ---------------------------------------------------------------------------
def employee_login_problems(status, raw, expected_user, expected_role='user'):
    """员工面登录成功判据:200 + token + 身份/角色匹配。"""
    if status != 200:
        return [f'登录返回 {status}: {raw[:120]}']
    obj, problems = json_body(raw)
    if problems:
        return problems
    problems = []
    if not obj.get('token'):
        problems.append('响应没有 token 字段')
    user = obj.get('user') or {}
    if str(user.get('username') or '') != expected_user:
        problems.append(f'登录身份是 {user.get("username")!r},不是 {expected_user!r}')
    if expected_role and str(user.get('role') or '') != expected_role:
        problems.append(f'role 是 {user.get("role")!r},不是 {expected_role!r}')
    return problems


def auditor_employee_login_problems(status, raw):
    """auditor 不得登录员工面:401 + AUDITOR_NOT_ALLOWED。"""
    problems = []
    if status != 401:
        problems.append(f'状态码应为 401,实际 {status}(200 = auditor 被放进员工面)')
    code = error_code(raw)
    if code != 'AUDITOR_NOT_ALLOWED':
        problems.append(f'error.code 应为 AUDITOR_NOT_ALLOWED,实际 {code!r}')
    return problems


def permissions_problems(raw):
    """auditor 权限必须是恰好三只读。"""
    obj, problems = json_body(raw)
    if problems:
        return problems
    perms = (obj.get('user') or {}).get('permissions')
    if not isinstance(perms, list):
        return [f'登录响应里没有 user.permissions 数组: {raw[:120]}']
    actual = {str(p) for p in perms}
    if actual != READONLY_PERMS:
        return [f'权限集合是 {sorted(actual)},期望恰好 {sorted(READONLY_PERMS)}']
    return []


def auditor_write_problems(status, raw):
    """auditor 写端点判据:**403 FORBIDDEN**(既不是 401"会话无效",也不是落进 handler)。"""
    code = error_code(raw)
    if status == 403:
        if code and code != 'FORBIDDEN':
            return [f'403 但 error.code={code!r},期望 FORBIDDEN(CSRF_EXPIRED 说明 CSRF 没带上)']
        return []
    if status == 401:
        return [f'401({code or "无 code"}) —— 会话/CSRF 没带上或无效,'
                '这条断言会退化成"伪造会话被拒",验证不到 RBAC']
    if status in (200, 201, 204):
        return [f'{status} —— RBAC fall-open:auditor 的写请求落到了 handler']
    return [f'状态码应为 403,实际 {status}: {raw[:120]}']


def anonymous_write_problems(status, raw):
    """对照判据:无会话时同一写端点必须 401(证明 403 来自权限判定)。"""
    if status == 401:
        return []
    return [f'无会话时应 401,实际 {status}(说明上面的 403 可能来自别的东西)']


def auditor_read_problems(status, raw):
    """auditor 读过端点(audit:read)必须 200。"""
    if status != 200:
        return [f'auditor 读端点应 200,实际 {status}: {raw[:120]}']
    return []


def channel_contract_problems(status, raw):
    """GET /api/client/v2/channel 的真契约(server/internal/channel 的 channel.Response)。"""
    if status != 200:
        return [f'GET /channel 返回 {status}: {raw[:120]}']
    obj, problems = json_body(raw)
    if problems:
        return problems
    problems = []
    for key in ('channel_id', 'title'):
        if not str(obj.get(key) or '').strip():
            problems.append(f'{key} 为空(missing 或空串)')
    login = obj.get('login')
    if not isinstance(login, dict):
        problems.append('没有 login 对象')
        login = {}
    if not str(login.get('display_name') or '').strip():
        problems.append('login.display_name 为空(登录页显示名没下发)')
    # 素材字段是**相对路径**(唯一真源 internal/router 的 /api/client/v2/channel/*):
    # 给了就必须指向本站端点,否则客户端会拿到破图/外链。
    assets = (
        ('login.logo_url', login.get('logo_url'), '/api/client/v2/channel/logo'),
        ('client.logo_url', (obj.get('client') or {}).get('logo_url') if isinstance(obj.get('client'), dict) else None,
         '/api/client/v2/channel/logo'),
        ('favicon_url', obj.get('favicon_url'), '/api/client/v2/channel/favicon'),
    )
    for name, value, want in assets:
        text = str(value or '')
        if text and want not in text:
            problems.append(f'{name}={text[:80]!r} 不指向 {want}')
    # 已被删除的旧 brand 契约:出现即说明有人把旧字段判据写回来了。
    if 'enabled' in obj:
        problems.append('响应里出现已删除的旧 brand 字段 enabled —— 判据应基于 channel.Response')
    return problems


def portal_problems(status, headers, body):
    """门户首页判据:200 + text/html + 有「客户端下载」一节。"""
    problems = []
    if status != 200:
        return [f'门户首页返回 {status}']
    ctype = str((headers or {}).get('Content-Type') or '')
    if 'text/html' not in ctype.lower():
        problems.append(f'Content-Type 不是 text/html: {ctype!r}')
    if '<h2>客户端下载</h2>' not in body:
        problems.append('页面缺少「客户端下载」一节(门户首屏第一动作)')
    return problems


# ---------------------------------------------------------------------------
# 用例自检:每条判据都要**拒绝**它的负例(只有正例过 = 恒真)
# ---------------------------------------------------------------------------
GOOD_CHANNEL = json.dumps({
    'channel_id': 'official',
    'title': 'Example Harness',
    'login': {'display_name': 'Example', 'tagline': 't', 'welcome': 'w', 'logo_url': LOGO_PATH},
    'client': {'display_name': 'Example', 'logo_url': LOGO_PATH},
}, ensure_ascii=False)


def self_test():
    cases = []

    def expect(label, problems, want_empty):
        cases.append((label, (not problems) == want_empty, problems))

    expect('员工登录/正例', employee_login_problems(200, '{"token":"t","user":{"username":"alice","role":"user"}}', 'alice'), True)
    expect('员工登录/负例:别的人', employee_login_problems(200, '{"token":"t","user":{"username":"bob","role":"user"}}', 'alice'), False)
    expect('员工登录/负例:没有 token', employee_login_problems(200, '{"user":{"username":"alice","role":"user"}}', 'alice'), False)
    expect('员工登录/负例:401', employee_login_problems(401, '{}', 'alice'), False)

    expect('auditor 员工面/正例', auditor_employee_login_problems(401, '{"error":{"code":"AUDITOR_NOT_ALLOWED"}}'), True)
    expect('auditor 员工面/负例:被放进来', auditor_employee_login_problems(200, '{"token":"t"}'), False)
    expect('auditor 员工面/负例:是别的 401',
           auditor_employee_login_problems(401, '{"error":{"code":"AUTH_FAILED"}}'), False)

    expect('auditor 权限/正例', permissions_problems('{"user":{"permissions":["audit:read","usage:read","user:read"]}}'), True)
    expect('auditor 权限/负例:多了写权限',
           permissions_problems('{"user":{"permissions":["audit:read","usage:read","user:read","user:write"]}}'), False)
    expect('auditor 权限/负例:缺字段', permissions_problems('{"user":{}}'), False)

    expect('auditor 写/正例:403 FORBIDDEN', auditor_write_problems(403, '{"error":{"code":"FORBIDDEN"}}'), True)
    expect('auditor 写/负例:401(伪造/无会话那种恒真形态)', auditor_write_problems(401, '{"error":{"code":"AUTH_REQUIRED"}}'), False)
    expect('auditor 写/负例:CSRF 没过', auditor_write_problems(403, '{"error":{"code":"CSRF_EXPIRED"}}'), False)
    expect('auditor 写/负例:fall-open 200', auditor_write_problems(200, '{"user":{}}'), False)
    expect('auditor 写/负例:fall-open 400 落到 handler', auditor_write_problems(400, '{"error":{"code":"VALIDATION"}}'), False)

    expect('无会话对照/正例:401', anonymous_write_problems(401, '{"error":{"code":"AUTH_REQUIRED"}}'), True)
    expect('无会话对照/负例:403', anonymous_write_problems(403, '{"error":{"code":"FORBIDDEN"}}'), False)

    expect('auditor 读/正例:200', auditor_read_problems(200, '{"items":[]}'), True)
    expect('auditor 读/负例:403', auditor_read_problems(403, '{"error":{"code":"FORBIDDEN"}}'), False)

    expect('channel/正例', channel_contract_problems(200, GOOD_CHANNEL), True)
    expect('channel/负例:旧 brand 契约(enabled=false)',
           channel_contract_problems(200, '{"enabled":false}'), False)
    expect('channel/负例:旧 brand 契约(enabled=true + Acme AI)',
           channel_contract_problems(200, '{"enabled":true,"name":"Acme AI"}'), False)
    expect('channel/负例:channel_id 为空',
           channel_contract_problems(200, json.dumps({'channel_id': '', 'title': 'x', 'login': {'display_name': 'y'}})), False)
    expect('channel/负例:login.display_name 缺失',
           channel_contract_problems(200, json.dumps({'channel_id': 'a', 'title': 'x', 'login': {}})), False)
    expect('channel/负例:logo_url 不是渠道端点',
           channel_contract_problems(200, json.dumps({'channel_id': 'a', 'title': 'x',
                                                      'login': {'display_name': 'y', 'logo_url': '/logo.svg'}})), False)
    expect('channel/负例:500', channel_contract_problems(500, 'boom'), False)

    expect('门户/正例', portal_problems(200, {'Content-Type': 'text/html; charset=utf-8'},
                                     '<html><h2>客户端下载</h2></html>'), True)
    expect('门户/负例:不是门户页', portal_problems(200, {'Content-Type': 'text/html'}, '<html>hello</html>'), False)
    expect('门户/负例:JSON 错误页', portal_problems(404, {'Content-Type': 'application/json'}, '{}'), False)

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
    server, want_self_test, positional = DEFAULT_BASE, False, []
    for item in argv:
        if item == '--self-test':
            want_self_test = True
        elif item in ('-h', '--help'):
            print(__doc__)
            raise SystemExit(EXIT_PASS)
        elif item.startswith('-'):
            print(f'ldap-rbac-brand-test: 未知参数 {item}(用 --help)', file=sys.stderr)
            raise SystemExit(EXIT_USAGE)
        else:
            positional.append(item)
    if len(positional) > 1:
        print('ldap-rbac-brand-test: 最多给一个位置参数(server_base)', file=sys.stderr)
        raise SystemExit(EXIT_USAGE)
    if positional:
        server = positional[0].rstrip('/')
    return server, want_self_test


def main(argv):
    server, want_self_test = parse_args(argv)
    if want_self_test:
        return self_test()

    results = []

    def check(name, problems, detail=''):
        ok = not problems
        results.append(ok)
        print(f'{"✓" if ok else "✗"} {name}{("  " + detail) if detail else ""}')
        for problem in problems:
            print(f'    - {problem}')
        return ok

    print(f'== LDAP + RBAC + 渠道集成测试(server={server}) ==')

    # 0. 环境探测:先分清"环境没起来(SKIP)"与"契约不满足(FAIL)"。
    probe = Session()
    status, body, _ = probe.get(server + '/healthz')
    if status != 200:
        print(f'SKIP: {server}/healthz 不可达/非 200(status={status}) —— 服务端没起来,本次未验证任何东西')
        return EXIT_SKIP
    status, body, _ = probe.get(server + '/api/server/admin/auth/methods')
    if status == 200:
        try:
            configured = {m.get('name') for m in json.loads(body).get('methods', []) if m.get('configured')}
        except (ValueError, AttributeError):
            configured = set()
        if configured and 'ldap' not in configured:
            print(f'SKIP: 服务端未启用 LDAP(configured={sorted(configured)}) —— '
                  '本用例验证的是 LDAP 登录/RBAC,配置缺失时未验证任何东西')
            return EXIT_SKIP

    # 1. LDAP 员工面登录(独立会话,与后面 admin/auditor 的 cookie 互不干扰)。
    employee = Session()
    status, body, _ = employee.post(server + '/api/client/v2/auth/login',
                                    {'username': LDAP_USER, 'password': LDAP_PASSWORD})
    check('LDAP 员工登录成功且 role=user',
          employee_login_problems(status, body, LDAP_USER), f'st={status}')

    # 2. admin 后台登录。
    admin = Session()
    status, body, _ = admin.post(server + '/api/server/admin/login',
                                 {'username': ADMIN_USER, 'password': ADMIN_PASSWORD})
    admin_problems = [] if status == 200 and 'csrf_token' in body else [f'st={status} body={body[:120]}']
    check('admin 后台登录成功(带 csrf_token)', admin_problems, f'st={status}')

    # 3. auditor 员工面被拒。
    status, body, _ = employee.post(server + '/api/client/v2/auth/login',
                                    {'username': AUDITOR_USER, 'password': AUDITOR_PASSWORD})
    check('auditor 员工面被拒(401 AUDITOR_NOT_ALLOWED)',
          auditor_employee_login_problems(status, body), f'st={status}')

    # 4. auditor 后台登录 + 权限集合。
    auditor = Session()
    status, body, _ = auditor.post(server + '/api/server/admin/login',
                                   {'username': AUDITOR_USER, 'password': AUDITOR_PASSWORD})
    auditor_problems = [] if status == 200 else [f'auditor 后台登录 st={status} body={body[:120]}']
    check('auditor 后台登录成功', auditor_problems, f'st={status}')
    check('auditor 权限=三只读', permissions_problems(body))

    # 5. RBAC:读 200 / 写 403(真会话 + 真 CSRF),再加"无会话 → 401"的对照。
    csrf = ''
    try:
        csrf = str(json.loads(body).get('csrf_token') or '')
    except ValueError:
        pass
    status, body, _ = auditor.get(server + '/api/server/admin/audit')
    check('auditor 读端点可用(200,audit:read)', auditor_read_problems(status, body), f'st={status}')
    # 写探针用 POST /users(perm=user:write,auditor 没有):**请求体故意不合法**,
    # 这样即使 RBAC 真 fall-open,handler 也只会 400 校验失败、不会改动任何数据 ——
    # 而 400 恰是我们判 FAIL 的形态(见 auditor_write_problems),不会假绿。
    status, body, _ = auditor.post(server + '/api/server/admin/users', {},
                                   {'X-CSRF-Token': csrf})
    check('auditor 写端点被 RBAC 拒(403 FORBIDDEN)', auditor_write_problems(status, body), f'st={status}')
    status, body, _ = employee.post(server + '/api/server/admin/users', {})
    check('对照:无管理会话时同一写端点 401', anonymous_write_problems(status, body), f'st={status}')

    # 6. 渠道内容契约(取代旧 brand 契约)。
    status, body, _ = probe.get(server + '/api/client/v2/channel')
    check('GET /api/client/v2/channel 满足渠道契约', channel_contract_problems(status, body), f'st={status}')

    # 7. 门户首页。
    status, body, headers = probe.get(server + '/')
    check('门户首页是门户页(含「客户端下载」)', portal_problems(status, headers, body), f'st={status}')

    print('  ·  未覆盖(显式记账):§1.2「测试连接」端点需 admin 会话 + 真实 LDAP bind,留待 webadmin 用例')
    ok = all(results)
    print('RESULT:', 'PASS' if ok else 'FAIL')
    return EXIT_PASS if ok else EXIT_FAIL


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
