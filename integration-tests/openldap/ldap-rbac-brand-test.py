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

## 判据纪律(2026-09-23 第十三轮审计 F-01,P0)

上面 7 条契约落地为 `CRITERIA` 表的 **10 条判据** —— 这张表是**唯一真源**,运行期按 **id**
经 `contractkit.Reporter.report()` 求值,`--self-test` / `--self-check` 逐条自证。
为什么不能像 2026-09-23 之前那样把 `check(name, problems, detail)` 散在运行期代码里:

    把 8/10 条运行期判据换成 check(name, [], '') ⇒ --self-test 仍是 29/29、
    check-integration-tests 照打「2 个契约脚本判据自检通过」、REAL_GATE_EXIT=0

即"判据的自我陈述比它实际判的东西宽"。现在同样的掏空会让**负例夹具**当场失败
(每条判据都配了正例 + 负例;`scripts/check-integration-tests.mjs` 还会在**变异副本**上
逐条复跑,要求它变红 —— 见那里的 `criteria-tautology` / `judge-tautology` /
`count-side-zero` / `runtime-wrapper` 四个变异)。

## 两处历史缺陷(2026-09-23 审计 W3-03/W3-04,均已修)

    · `:77-82` 断言的是 2026-09-10 已被渠道配置取代的旧 brand 契约
      (`"enabled":true` / `"Acme AI"`)⇒ `/channel` 响应里根本没有这两个键,
      该用例**必然**走 else 分支并判失败(不可达的 PASS)。
    · `:70-75` 的"auditor 写面被拒(非 200)"用**伪造** cookie(`picoaide_session=x`)
      ⇒ 恒 401 ⇒ `st != 200` 恒真:验证的是"伪造会话被拒",不是"auditor 无写权限",
      且真出现 RBAC fall-open(200/400)时也测不出。现在用真会话 + 真 CSRF 断言 403。

## 环境缺失时**显式 SKIP**

退出码 77,绝不打印 PASS:
    · /healthz 不可达;· /api/server/admin/auth/methods 显示 ldap 未配置
退出码:0 = PASS;1 = FAIL(契约不满足);2 = 用法错误;77 = SKIP(未验证任何东西)。

用法:
    python3 ldap-rbac-brand-test.py [server_base]
    python3 ldap-rbac-brand-test.py --self-test        # 判据本体自证
    python3 ldap-rbac-brand-test.py --self-check       # 判定通道自证
    python3 ldap-rbac-brand-test.py --dump-criteria    # 判据表登记值(JSON)
数据(integration-tests/README.md):LDAP alice/alice123;admin/admin123456;audit01/audit12345。
未覆盖(显式记账,不是静默跳过):§1.2 的「测试连接」端点需要 admin 会话 + 真实 LDAP bind,
本脚本不写配置,留待人工/webadmin 用例。
"""
import http.cookiejar
import json
import os
import sys
import urllib.error
import urllib.request

# 契约判据通道(判定 + 计数 + 自检)在两个 .py 与门禁之间**只允许一份实现**。
# 关掉 .pyc 落地:本目录不在 .gitignore 的 __pycache__ 白名单里,导入本地模块
# 会在工作树里留下未跟踪目录(门禁每跑一次就多一份噪声)。
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
try:
    from contractkit import (  # noqa: E402 - 路径必须先插入,导入位置由设计决定
        EXIT_FAIL,
        EXIT_PASS,
        EXIT_SKIP,
        EXIT_USAGE,
        CriteriaError,
        Reporter,
        criteria_dump,
        observation_of,
        report_self_check_result,
        report_self_test_result,
        run_criteria_self_test,
        run_reporter_self_check,
    )
except ImportError as exc:  # pragma: no cover - 只在文件布局被破坏时触发
    print(f'ldap-rbac-brand-test: 无法加载契约判据通道 contractkit({exc})', file=sys.stderr)
    raise SystemExit(1)

DEFAULT_BASE = 'http://127.0.0.1:8091'
LDAP_USER, LDAP_PASSWORD = 'alice', 'alice123'
ADMIN_USER, ADMIN_PASSWORD = 'admin', 'admin123456'
AUDITOR_USER, AUDITOR_PASSWORD = 'audit01', 'audit12345'
READONLY_PERMS = {'audit:read', 'usage:read', 'user:read'}
LOGO_PATH = '/api/client/v2/channel/logo'


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
# 判据本体的辅助纯函数(只被 CRITERIA 的 evaluate 调用,便于逐条夹具取证)
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


def admin_login_problems(status, raw, label='admin', require_csrf=True):
    """后台登录成功判据:200(可选:响应里必须有非空 csrf_token)。"""
    if status != 200:
        return [f'{label} 后台登录 st={status} body={raw[:120]}']
    if not require_csrf:
        return []
    obj, problems = json_body(raw)
    if problems:
        return [f'{label} 后台登录{problems[0]}']
    if not str((obj or {}).get('csrf_token') or ''):
        return [f'{label} 后台登录响应缺 csrf_token: {raw[:120]}']
    return []


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
        ('login.logo_url', login.get('logo_url'), LOGO_PATH),
        ('client.logo_url', (obj.get('client') or {}).get('logo_url') if isinstance(obj.get('client'), dict) else None,
         LOGO_PATH),
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
# 判据表(**唯一真源**)
#
# ⚠️ 每条 `evaluate` 的**第一句**必须是 `obs = observation_of(obs, '<id>')`:
#    它既是观测形状校验,也是门禁端到端变异的**注入锚点**
#    (锚点消失时门禁判失败而不是静默跳过 —— 见 scripts/check-integration-tests.mjs)。
# ⚠️ 改这张表(增删判据 / 改 id / 改名字)**必须**同步门禁里的
#    `LDAP_EXPECTED_CRITERIA` 与夹具条数下限(登记值进 diff 才会被评审看见)。
# ---------------------------------------------------------------------------
def _eval_employee_login(obs):
    obs = observation_of(obs, 'employee-login')
    return employee_login_problems(obs.get('status'), obs.get('body', ''), obs.get('expected_user', ''))


def _eval_admin_login(obs):
    obs = observation_of(obs, 'admin-login')
    return admin_login_problems(obs.get('status'), obs.get('body', ''))


def _eval_auditor_employee_rejected(obs):
    obs = observation_of(obs, 'auditor-employee-rejected')
    return auditor_employee_login_problems(obs.get('status'), obs.get('body', ''))


def _eval_auditor_admin_login(obs):
    obs = observation_of(obs, 'auditor-admin-login')
    return admin_login_problems(obs.get('status'), obs.get('body', ''), label='auditor', require_csrf=False)


def _eval_auditor_permissions(obs):
    obs = observation_of(obs, 'auditor-permissions')
    return permissions_problems(obs.get('body', ''))


def _eval_auditor_read(obs):
    obs = observation_of(obs, 'auditor-read')
    return auditor_read_problems(obs.get('status'), obs.get('body', ''))


def _eval_auditor_write_forbidden(obs):
    obs = observation_of(obs, 'auditor-write-forbidden')
    return auditor_write_problems(obs.get('status'), obs.get('body', ''))


def _eval_anonymous_write_control(obs):
    obs = observation_of(obs, 'anonymous-write-control')
    return anonymous_write_problems(obs.get('status'), obs.get('body', ''))


def _eval_channel_contract(obs):
    obs = observation_of(obs, 'channel-contract')
    return channel_contract_problems(obs.get('status'), obs.get('body', ''))


def _eval_portal_download_section(obs):
    obs = observation_of(obs, 'portal-download-section')
    return portal_problems(obs.get('status'), obs.get('headers', {}), obs.get('body', ''))


CRITERIA = [
    {
        'id': 'employee-login',
        'name': 'LDAP 员工登录成功且 role=user',
        'evaluate': _eval_employee_login,
    },
    {
        'id': 'admin-login',
        'name': 'admin 后台登录成功(带 csrf_token)',
        'evaluate': _eval_admin_login,
    },
    {
        'id': 'auditor-employee-rejected',
        'name': 'auditor 员工面被拒(401 AUDITOR_NOT_ALLOWED)',
        'evaluate': _eval_auditor_employee_rejected,
    },
    {
        'id': 'auditor-admin-login',
        'name': 'auditor 后台登录成功',
        'evaluate': _eval_auditor_admin_login,
    },
    {
        'id': 'auditor-permissions',
        'name': 'auditor 权限=三只读',
        'evaluate': _eval_auditor_permissions,
    },
    {
        'id': 'auditor-read',
        'name': 'auditor 读端点可用(200,audit:read)',
        'evaluate': _eval_auditor_read,
    },
    {
        'id': 'auditor-write-forbidden',
        'name': 'auditor 写端点被 RBAC 拒(403 FORBIDDEN)',
        'evaluate': _eval_auditor_write_forbidden,
    },
    {
        'id': 'anonymous-write-control',
        'name': '对照:无管理会话时同一写端点 401',
        'evaluate': _eval_anonymous_write_control,
    },
    {
        'id': 'channel-contract',
        'name': 'GET /api/client/v2/channel 满足渠道契约',
        'evaluate': _eval_channel_contract,
    },
    {
        'id': 'portal-download-section',
        'name': '门户首页是门户页(含「客户端下载」)',
        'evaluate': _eval_portal_download_section,
    },
]


# ---------------------------------------------------------------------------
# 自检夹具:**每条判据都必须有正例与负例**(纯合成数据,不需要服务端/容器)
# ---------------------------------------------------------------------------
GOOD_CHANNEL = json.dumps({
    'channel_id': 'official',
    'title': 'Example Harness',
    'login': {'display_name': 'Example', 'tagline': 't', 'welcome': 'w', 'logo_url': LOGO_PATH},
    'client': {'display_name': 'Example', 'logo_url': LOGO_PATH},
}, ensure_ascii=False)

SELF_TEST_FIXTURES = [
    # ---- employee-login ----
    {
        'id': 'employee-login', 'expect': True,
        'why': '正常:alice / role=user / 有 token',
        'observation': {'status': 200, 'body': '{"token":"t","user":{"username":"alice","role":"user"}}',
                        'expected_user': 'alice'},
    },
    {
        'id': 'employee-login', 'expect': False,
        'why': '负例:别的人',
        'observation': {'status': 200, 'body': '{"token":"t","user":{"username":"bob","role":"user"}}',
                        'expected_user': 'alice'},
    },
    {
        'id': 'employee-login', 'expect': False,
        'why': '负例:没有 token',
        'observation': {'status': 200, 'body': '{"user":{"username":"alice","role":"user"}}',
                        'expected_user': 'alice'},
    },
    {
        'id': 'employee-login', 'expect': False,
        'why': '负例:401',
        'observation': {'status': 401, 'body': '{}', 'expected_user': 'alice'},
    },

    # ---- admin-login ----
    {
        'id': 'admin-login', 'expect': True,
        'why': '正常:200 + 非空 csrf_token',
        'observation': {'status': 200, 'body': '{"csrf_token":"csrf-admin","user":{"username":"admin"}}'},
    },
    {
        'id': 'admin-login', 'expect': False,
        'why': '负例:401',
        'observation': {'status': 401, 'body': '{"error":{"code":"AUTH_FAILED"}}'},
    },
    {
        'id': 'admin-login', 'expect': False,
        'why': '负例:200 但没有 csrf_token(写面会全被 CSRF 拒)',
        'observation': {'status': 200, 'body': '{"user":{"username":"admin"}}'},
    },
    {
        'id': 'admin-login', 'expect': False,
        'why': '负例:200 但不是 JSON',
        'observation': {'status': 200, 'body': '<html>login</html>'},
    },

    # ---- auditor-employee-rejected ----
    {
        'id': 'auditor-employee-rejected', 'expect': True,
        'why': '正常:401 + AUDITOR_NOT_ALLOWED',
        'observation': {'status': 401, 'body': '{"error":{"code":"AUDITOR_NOT_ALLOWED"}}'},
    },
    {
        'id': 'auditor-employee-rejected', 'expect': False,
        'why': '负例:被放进来',
        'observation': {'status': 200, 'body': '{"token":"t"}'},
    },
    {
        'id': 'auditor-employee-rejected', 'expect': False,
        'why': '负例:是别的 401',
        'observation': {'status': 401, 'body': '{"error":{"code":"AUTH_FAILED"}}'},
    },

    # ---- auditor-admin-login ----
    {
        'id': 'auditor-admin-login', 'expect': True,
        'why': '正常:200',
        'observation': {'status': 200, 'body': '{"csrf_token":"csrf-auditor","user":{"username":"audit01"}}'},
    },
    {
        'id': 'auditor-admin-login', 'expect': False,
        'why': '负例:401(后端会话没建起来)',
        'observation': {'status': 401, 'body': '{"error":{"code":"AUTH_FAILED"}}'},
    },

    # ---- auditor-permissions ----
    {
        'id': 'auditor-permissions', 'expect': True,
        'why': '正常:恰好三只读',
        'observation': {'body': '{"user":{"permissions":["audit:read","usage:read","user:read"]}}'},
    },
    {
        'id': 'auditor-permissions', 'expect': False,
        'why': '负例:多了写权限',
        'observation': {'body': '{"user":{"permissions":["audit:read","usage:read","user:read","user:write"]}}'},
    },
    {
        'id': 'auditor-permissions', 'expect': False,
        'why': '负例:缺字段',
        'observation': {'body': '{"user":{}}'},
    },

    # ---- auditor-read ----
    {
        'id': 'auditor-read', 'expect': True,
        'why': '正常:200',
        'observation': {'status': 200, 'body': '{"items":[]}'},
    },
    {
        'id': 'auditor-read', 'expect': False,
        'why': '负例:403',
        'observation': {'status': 403, 'body': '{"error":{"code":"FORBIDDEN"}}'},
    },

    # ---- auditor-write-forbidden ----
    {
        'id': 'auditor-write-forbidden', 'expect': True,
        'why': '正常:403 FORBIDDEN',
        'observation': {'status': 403, 'body': '{"error":{"code":"FORBIDDEN"}}'},
    },
    {
        'id': 'auditor-write-forbidden', 'expect': False,
        'why': '负例:401(伪造/无会话那种恒真形态)',
        'observation': {'status': 401, 'body': '{"error":{"code":"AUTH_REQUIRED"}}'},
    },
    {
        'id': 'auditor-write-forbidden', 'expect': False,
        'why': '负例:CSRF 没过',
        'observation': {'status': 403, 'body': '{"error":{"code":"CSRF_EXPIRED"}}'},
    },
    {
        'id': 'auditor-write-forbidden', 'expect': False,
        'why': '负例:fall-open 200',
        'observation': {'status': 200, 'body': '{"user":{}}'},
    },
    {
        'id': 'auditor-write-forbidden', 'expect': False,
        'why': '负例:fall-open 400 落到 handler',
        'observation': {'status': 400, 'body': '{"error":{"code":"VALIDATION"}}'},
    },

    # ---- anonymous-write-control ----
    {
        'id': 'anonymous-write-control', 'expect': True,
        'why': '正常:401',
        'observation': {'status': 401, 'body': '{"error":{"code":"AUTH_REQUIRED"}}'},
    },
    {
        'id': 'anonymous-write-control', 'expect': False,
        'why': '负例:403',
        'observation': {'status': 403, 'body': '{"error":{"code":"FORBIDDEN"}}'},
    },

    # ---- channel-contract ----
    {
        'id': 'channel-contract', 'expect': True,
        'why': '正常:真契约',
        'observation': {'status': 200, 'body': GOOD_CHANNEL},
    },
    {
        'id': 'channel-contract', 'expect': False,
        'why': '负例:旧 brand 契约(enabled=false)',
        'observation': {'status': 200, 'body': '{"enabled":false}'},
    },
    {
        'id': 'channel-contract', 'expect': False,
        'why': '负例:旧 brand 契约(enabled=true + Acme AI)',
        'observation': {'status': 200, 'body': '{"enabled":true,"name":"Acme AI"}'},
    },
    {
        'id': 'channel-contract', 'expect': False,
        'why': '负例:channel_id 为空',
        'observation': {'status': 200, 'body': json.dumps({'channel_id': '', 'title': 'x',
                                                           'login': {'display_name': 'y'}})},
    },
    {
        'id': 'channel-contract', 'expect': False,
        'why': '负例:login.display_name 缺失',
        'observation': {'status': 200, 'body': json.dumps({'channel_id': 'a', 'title': 'x', 'login': {}})},
    },
    {
        'id': 'channel-contract', 'expect': False,
        'why': '负例:logo_url 不是渠道端点',
        'observation': {'status': 200, 'body': json.dumps({'channel_id': 'a', 'title': 'x',
                                                           'login': {'display_name': 'y',
                                                                     'logo_url': '/logo.svg'}})},
    },
    {
        'id': 'channel-contract', 'expect': False,
        'why': '负例:500',
        'observation': {'status': 500, 'body': 'boom'},
    },

    # ---- portal-download-section ----
    {
        'id': 'portal-download-section', 'expect': True,
        'why': '正常:门户页含下载节',
        'observation': {'status': 200, 'headers': {'Content-Type': 'text/html; charset=utf-8'},
                        'body': '<html><h2>客户端下载</h2></html>'},
    },
    {
        'id': 'portal-download-section', 'expect': False,
        'why': '负例:不是门户页',
        'observation': {'status': 200, 'headers': {'Content-Type': 'text/html'}, 'body': '<html>hello</html>'},
    },
    {
        'id': 'portal-download-section', 'expect': False,
        'why': '负例:JSON 错误页',
        'observation': {'status': 404, 'headers': {'Content-Type': 'application/json'}, 'body': '{}'},
    },
]

# 夹具条数下限(棘轮):删夹具必须同时改这个常量与门禁里的登记值并写明理由。
LDAP_MIN_FIXTURES = 35


def _new_reporter():
    """运行期的判定通道(`--self-check` 与真实跑**共用同一个构造点**)。

    门禁的 `runtime-wrapper` 变异就注入在这里 —— 把通道换成恒真包装之后
    `--self-check` 必须非零(自检消费的就是运行期这条通道)。
    """
    return Reporter(CRITERIA)


# ---------------------------------------------------------------------------
def parse_args(argv):
    server, want_self_test, want_self_check, want_dump, positional = DEFAULT_BASE, False, False, False, []
    for item in argv:
        if item == '--self-test':
            want_self_test = True
        elif item == '--self-check':
            want_self_check = True
        elif item == '--dump-criteria':
            want_dump = True
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
    modes = [want_self_test, want_self_check, want_dump].count(True)
    if modes > 1:
        print('ldap-rbac-brand-test: --self-test / --self-check / --dump-criteria 只能给一个', file=sys.stderr)
        raise SystemExit(EXIT_USAGE)
    return server, want_self_test, want_self_check, want_dump


def self_test():
    """判据本体自证:每条判据的正/负例夹具都必须给出期望结论。"""
    result = run_criteria_self_test(CRITERIA, SELF_TEST_FIXTURES)
    status = report_self_test_result(result)
    if result['total'] < LDAP_MIN_FIXTURES:
        print(f'self-test: 夹具只剩 {result["total"]} 条(下限 {LDAP_MIN_FIXTURES})'
              ' —— 夹具被删到没有判别力;确实要下调请同时改 LDAP_MIN_FIXTURES 与门禁登记值')
        return EXIT_FAIL
    return status


def self_check():
    """判定通道自证:全部夹具经**运行期那条 report()** 求值。"""
    reporter = _new_reporter()
    try:
        result = run_reporter_self_check(reporter, CRITERIA, SELF_TEST_FIXTURES)
    except CriteriaError as exc:
        print(f'  FAIL {exc}')
        print('reporter self-check: 0/0 条夹具经 report() 求值符合预期')
        return EXIT_FAIL
    return report_self_check_result(result)


def main(argv):
    server, want_self_test, want_self_check, want_dump = parse_args(argv)
    if want_self_test:
        return self_test()
    if want_self_check:
        return self_check()
    if want_dump:
        print(json.dumps(criteria_dump(CRITERIA, SELF_TEST_FIXTURES), ensure_ascii=False, indent=2))
        return EXIT_PASS

    reporter = _new_reporter()

    def finish():
        ok = reporter.failures() == 0
        print('RESULT:', 'PASS' if ok else 'FAIL')
        return EXIT_PASS if ok else EXIT_FAIL

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
    reporter.report('employee-login', {'status': status, 'body': body, 'expected_user': LDAP_USER})

    # 2. admin 后台登录。
    admin = Session()
    status, body, _ = admin.post(server + '/api/server/admin/login',
                                 {'username': ADMIN_USER, 'password': ADMIN_PASSWORD})
    reporter.report('admin-login', {'status': status, 'body': body})

    # 3. auditor 员工面被拒。
    status, body, _ = employee.post(server + '/api/client/v2/auth/login',
                                    {'username': AUDITOR_USER, 'password': AUDITOR_PASSWORD})
    reporter.report('auditor-employee-rejected', {'status': status, 'body': body})

    # 4. auditor 后台登录 + 权限集合。
    auditor = Session()
    status, body, _ = auditor.post(server + '/api/server/admin/login',
                                   {'username': AUDITOR_USER, 'password': AUDITOR_PASSWORD})
    reporter.report('auditor-admin-login', {'status': status, 'body': body})
    reporter.report('auditor-permissions', {'body': body})

    # 5. RBAC:读 200 / 写 403(真会话 + 真 CSRF),再加"无会话 → 401"的对照。
    csrf = ''
    try:
        csrf = str(json.loads(body).get('csrf_token') or '')
    except ValueError:
        pass
    status, body, _ = auditor.get(server + '/api/server/admin/audit')
    reporter.report('auditor-read', {'status': status, 'body': body})
    # 写探针用 POST /users(perm=user:write,auditor 没有):**请求体故意不合法**,
    # 这样即使 RBAC 真 fall-open,handler 也只会 400 校验失败、不会改动任何数据 ——
    # 而 400 恰是我们判 FAIL 的形态(见 auditor_write_problems),不会假绿。
    status, body, _ = auditor.post(server + '/api/server/admin/users', {},
                                   {'X-CSRF-Token': csrf})
    reporter.report('auditor-write-forbidden', {'status': status, 'body': body})
    status, body, _ = employee.post(server + '/api/server/admin/users', {})
    reporter.report('anonymous-write-control', {'status': status, 'body': body})

    # 6. 渠道内容契约(取代旧 brand 契约)。
    status, body, _ = probe.get(server + '/api/client/v2/channel')
    reporter.report('channel-contract', {'status': status, 'body': body})

    # 7. 门户首页。
    status, body, headers = probe.get(server + '/')
    reporter.report('portal-download-section', {'status': status, 'headers': headers, 'body': body})

    print('  ·  未覆盖(显式记账):§1.2「测试连接」端点需 admin 会话 + 真实 LDAP bind,留待 webadmin 用例')
    return finish()


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
