#!/usr/bin/env python3
"""Dex SSO 集成测试 — 完整 OIDC 授权码流(模拟浏览器)。

要验证的契约(每一步都必须有**有判别力**的判据,不成立即 FAIL):
1. GET  /api/client/v2/auth/oidc/login → 302,Location 指向 IdP(并下发 state cookie)
2. 跟随该 Location:必须真的落在 **IdP 的登录页**(页面上有密码表单字段)
3. POST IdP 凭据:必须**离开**登录页(停在带错误文案的登录表单上 = 凭据被拒)
4. IdP 要求授权确认时 POST approve:必须继续往服务端回调走
5. 服务端回调:必须 302 到**深链** `<scheme>://auth?token=…&user=…`(读 Location 头);
   且回调链里必须真的出现过带 `code=` 的回调地址
6. 深链 token 必须能调 /api/client/v2/auth/me,且返回的就是**本次登录的那个账号**

## 判据纪律(2026-09-23 第十三轮审计 F-01,P0)

上面 6 条契约落地为 `CRITERIA` 表的 **7 条判据** —— 这张表是**唯一真源**,运行期按 **id**
经 `contractkit.Reporter.report()` 求值,`--self-test` / `--self-check` 逐条自证。
为什么不能像 2026-09-23 之前那样把 `check(name, problems, detail)` 散在运行期代码里:

    把 6/7 条运行期判据换成 check(name, [], '') ⇒ --self-test 仍是 24/24、
    check-integration-tests 照打「2 个契约脚本判据自检通过」、REAL_GATE_EXIT=0

即"判据的自我陈述比它实际判的东西宽"。现在同样的掏空会让**负例夹具**当场失败
(每条判据都配了正例 + 负例;`scripts/check-integration-tests.mjs` 还会在**变异副本**上
逐条复跑,要求它变红 —— 见那里的 `criteria-tautology` / `judge-tautology` /
`count-side-zero` / `runtime-wrapper` 四个变异)。

## 为什么"手动跟随重定向"(2026-09-23 审计 W3-02)

    urllib **无法跟随自定义 scheme**(`picoaide://…`):它抛 HTTPError,而旧 `fetch()` 的
    异常分支返回的是**传入的 url**(=回调地址)⇒ `'picoaide://' in url` 恒假、else 分支
    必然执行 —— 即使 SSO 全流程正常,用例也永远 `RESULT: FAIL`(深链断言结构上不可达)。
    本脚本改为手动跟随 http(s) 重定向、一遇到非 http(s) 的 Location 就停下并把它当深链
    读出来(见 `follow()`)。**负向对照**:把深链换成 http 目标时 `follow()` 会继续跟随到
    终点 ⇒ "有没有拿到深链"是有判别力的,不是恒真/恒假。

## 环境缺失时**显式 SKIP**

退出码 77,绝不打印 PASS:
    · /healthz 不可达(服务端没起)
    · /api/server/admin/auth/methods 显示 oidc/openid 都未配置
退出码:0 = PASS;1 = FAIL(契约不满足);2 = 用法错误;77 = SKIP(未验证任何东西)。

用法:
    python3 dex-sso-test.py [server_base] [--user <login>] [--password <pw>]
    python3 dex-sso-test.py --self-test        # 判据本体自证(每条判据的正/负例夹具)
    python3 dex-sso-test.py --self-check       # 判定通道自证(夹具经运行期 report() 求值)
    python3 dex-sso-test.py --dump-criteria    # 判据表登记值(JSON,供门禁对账)
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
    print(f'dex-sso-test: 无法加载契约判据通道 contractkit({exc})', file=sys.stderr)
    raise SystemExit(1)

DEFAULT_BASE = 'http://127.0.0.1:8091'
DEFAULT_USER = 'admin@example.com'
DEFAULT_PASSWORD = 'admin123'
PROVIDER = 'oidc'
CALLBACK_PATH = f'/api/client/v2/auth/{PROVIDER}/callback'

# SKIP 的**原因码闭集**(本用例允许打出的那几个)。
# 门禁(scripts/check-integration-tests.mjs)按它做双向对账:登记表里的 skipReasons 必须与这里
# 逐字相等、每个原因码都必须有调用点、每个调用点都必须给登记过的原因码。新增原因码要同时
# 改这里与门禁的 SKIP_REASON_CODES —— "未登记的原因"不再是一张免检牌。
SKIP_REASONS = ('missing-server', 'missing-provider')


def skip(reason, detail):
    """让本用例以 SKIP(77) 收尾的**唯一出口**;原因码必须登记在 SKIP_REASONS 里。"""
    assert reason in SKIP_REASONS, f'未登记的 SKIP 原因码: {reason}'
    assert detail, 'SKIP 必须带可读的观测细节(否则聚合层只剩"跳过"两个字)'
    print(f'SKIP[{reason}]: {detail} —— 本次未验证任何东西')
    return EXIT_SKIP

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

    返回 (status, final_url, body, headers, deep_link, hops):
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
# 判据本体的辅助纯函数(只被 CRITERIA 的 evaluate 调用,便于逐条夹具取证)
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
# 判据表(**唯一真源**)
#
# ⚠️ 每条 `evaluate` 的**第一句**必须是 `obs = observation_of(obs, '<id>')`:
#    它既是观测形状校验,也是门禁端到端变异的**注入锚点**
#    (锚点消失时门禁判失败而不是静默跳过 —— 见 scripts/check-integration-tests.mjs)。
# ⚠️ 改这张表(增删判据 / 改 id / 改名字)**必须**同步门禁里的
#    `DEX_EXPECTED_CRITERIA` 与夹具条数下限(登记值进 diff 才会被评审看见)。
# ---------------------------------------------------------------------------
def _eval_login_start(obs):
    obs = observation_of(obs, 'login-start')
    if obs.get('status') == 302 and obs.get('location'):
        return []
    return [f'status={obs.get("status")} Location={str(obs.get("location"))[:80]!r}']


def _eval_idp_login_page(obs):
    obs = observation_of(obs, 'idp-login-page')
    return login_page_problems(obs.get('url', ''), obs.get('body', ''), obs.get('idp_origin', ''))


def _eval_submit_credentials(obs):
    obs = observation_of(obs, 'submit-credentials')
    return login_submit_problems(obs.get('status'), obs.get('body', ''))


def _eval_approval_advance(obs):
    obs = observation_of(obs, 'approval-advance')
    # IdP 没要求授权确认时这一步**未被执行**(与旧脚本一致,是显式的"不适用"而不是静默通过;
    # 门禁的 `good` 假网关恒要求授权确认,所以这条判据在门禁里真的被求值)。
    if not obs.get('required'):
        return []
    return approve_problems(obs.get('status'), obs.get('url', ''), obs.get('body', ''))


def _eval_callback_reached(obs):
    obs = observation_of(obs, 'callback-reached')
    hops = obs.get('hops')
    if not isinstance(hops, list):
        return ['回调链不可读(hops 缺失)—— "有没有经过回调"无法判定']
    reached = any(isinstance(hop, (list, tuple)) and len(hop) == 2
                  and CALLBACK_PATH in str(hop[1]) and 'code=' in str(hop[1]) for hop in hops)
    if reached:
        return []
    return ['回调链里没有出现带 code 的回调地址']


def _eval_deep_link(obs):
    obs = observation_of(obs, 'deep-link')
    return deep_link_problems(obs.get('location', ''), obs.get('expected_scheme', ''))


def _eval_deep_link_identity(obs):
    obs = observation_of(obs, 'deep-link-identity')
    return me_problems(obs.get('status'), obs.get('body', ''),
                       obs.get('expected_user', ''), obs.get('expected_email', ''))


CRITERIA = [
    {
        'id': 'login-start',
        'name': f'[1] GET /auth/{PROVIDER}/login → 302 且 Location 指向 IdP',
        'evaluate': _eval_login_start,
    },
    {
        'id': 'idp-login-page',
        'name': '[2] 落在 IdP 登录页(有密码表单)',
        'evaluate': _eval_idp_login_page,
    },
    {
        'id': 'submit-credentials',
        'name': '[3] 提交 IdP 凭据后离开登录页',
        'evaluate': _eval_submit_credentials,
    },
    {
        'id': 'approval-advance',
        'name': '[4] 授权确认后离开 approval(继续往回调走)',
        'evaluate': _eval_approval_advance,
    },
    {
        'id': 'callback-reached',
        'name': f'[5] 授权码回到 {CALLBACK_PATH}',
        'evaluate': _eval_callback_reached,
    },
    {
        'id': 'deep-link',
        'name': '[5] 回调 302 到深链 <scheme>://auth?token=…',
        'evaluate': _eval_deep_link,
    },
    {
        'id': 'deep-link-identity',
        'name': '[6] 深链 token 调 /auth/me 且身份=本次登录账号',
        'evaluate': _eval_deep_link_identity,
    },
]


# ---------------------------------------------------------------------------
# 自检夹具:**每条判据都必须有正例与负例**(纯合成数据,不需要服务端/Docker/Dex)
# ---------------------------------------------------------------------------
GOOD_DEEP_LINK = 'picoaide://auth?token=' + 'a1b2c3d4' * 5 + '&user=admin'
GOOD_LOGIN_PAGE = '<html><form method="post" action="/dex/auth/local?req=x">' \
    '<input type="text" name="login"><input type="password" name="password"></form></html>'
IDP_ORIGIN = 'http://127.0.0.1:5556'
GOOD_HOPS = [(303, IDP_ORIGIN + '/dex/approval?req=x'),
             (302, 'http://127.0.0.1:8091' + CALLBACK_PATH + '?code=code-42&state=state-ffff')]

SELF_TEST_FIXTURES = [
    # ---- login-start ----
    {
        'id': 'login-start', 'expect': True,
        'why': '正常:302 + Location 指向 IdP',
        'observation': {'status': 302, 'location': IDP_ORIGIN + '/dex/auth/local?req=x'},
    },
    {
        'id': 'login-start', 'expect': False,
        'why': '负例:启动登录流返回 200(没有跳 IdP)',
        'observation': {'status': 200, 'location': ''},
    },
    {
        'id': 'login-start', 'expect': False,
        'why': '负例:302 但没有 Location 头',
        'observation': {'status': 302, 'location': ''},
    },

    # ---- idp-login-page ----
    {
        'id': 'idp-login-page', 'expect': True,
        'why': '正常:落在 IdP 且有密码表单',
        'observation': {'url': IDP_ORIGIN + '/dex/auth/local?req=x', 'body': GOOD_LOGIN_PAGE, 'idp_origin': IDP_ORIGIN},
    },
    {
        'id': 'idp-login-page', 'expect': False,
        'why': '负例:停在服务端(未到 IdP)',
        'observation': {'url': 'http://127.0.0.1:8091/api/client/v2/auth/oidc/login',
                        'body': GOOD_LOGIN_PAGE, 'idp_origin': IDP_ORIGIN},
    },
    {
        'id': 'idp-login-page', 'expect': False,
        'why': '负例:没有密码表单',
        'observation': {'url': IDP_ORIGIN + '/dex/auth/local', 'body': '<html>error</html>', 'idp_origin': IDP_ORIGIN},
    },

    # ---- submit-credentials ----
    {
        'id': 'submit-credentials', 'expect': True,
        'why': '正常:303 离开登录页',
        'observation': {'status': 303, 'body': ''},
    },
    {
        'id': 'submit-credentials', 'expect': False,
        'why': '负例:仍停在登录表单',
        'observation': {'status': 200, 'body': GOOD_LOGIN_PAGE},
    },
    {
        'id': 'submit-credentials', 'expect': False,
        'why': '负例:回显登录失败',
        'observation': {'status': 200, 'body': '<p>Invalid login</p>'},
    },
    {
        'id': 'submit-credentials', 'expect': False,
        'why': '负例:5xx',
        'observation': {'status': 500, 'body': 'boom'},
    },

    # ---- approval-advance ----
    {
        'id': 'approval-advance', 'expect': True,
        'why': '正常:已离开 approval',
        'observation': {'required': True, 'status': 200, 'url': 'http://127.0.0.1:8091' + CALLBACK_PATH + '?code=x', 'body': ''},
    },
    {
        'id': 'approval-advance', 'expect': True,
        'why': '不适用:IdP 未要求授权确认(该步未执行,显式记为通过而不是静默跳过)',
        'observation': {'required': False, 'status': 200, 'url': 'http://127.0.0.1:8091' + CALLBACK_PATH + '?code=x', 'body': ''},
    },
    {
        'id': 'approval-advance', 'expect': False,
        'why': '负例:仍停在 approval 页',
        'observation': {'required': True, 'status': 200, 'url': IDP_ORIGIN + '/dex/approval?req=x',
                        'body': '<form action="/approval"></form>'},
    },
    {
        'id': 'approval-advance', 'expect': False,
        'why': '负例:回到登录表单',
        'observation': {'required': True, 'status': 200, 'url': IDP_ORIGIN + '/dex/auth/local', 'body': GOOD_LOGIN_PAGE},
    },
    {
        'id': 'approval-advance', 'expect': False,
        'why': '负例:5xx',
        'observation': {'required': True, 'status': 500, 'url': IDP_ORIGIN + '/dex/approval', 'body': 'boom'},
    },

    # ---- callback-reached ----
    {
        'id': 'callback-reached', 'expect': True,
        'why': '正常:回调链里有带 code 的回调地址',
        'observation': {'hops': GOOD_HOPS},
    },
    {
        'id': 'callback-reached', 'expect': False,
        'why': '负例:回调链里从来没有回调地址(用户没被送回来)',
        'observation': {'hops': [(303, IDP_ORIGIN + '/dex/approval?req=x'), (200, IDP_ORIGIN + '/dex/approval?req=x')]},
    },
    {
        'id': 'callback-reached', 'expect': False,
        'why': '负例:经过回调但没有 code(W3-02 之前那条恒假断言的孪生形态)',
        'observation': {'hops': [(302, 'http://127.0.0.1:8091' + CALLBACK_PATH + '?state=x')]},
    },
    {
        'id': 'callback-reached', 'expect': False,
        'why': '负例:hops 缺失(观测不可读)',
        'observation': {},
    },

    # ---- deep-link ----
    {
        'id': 'deep-link', 'expect': True,
        'why': '正常:自定义 scheme + host=auth + 足够长的 token',
        'observation': {'location': GOOD_DEEP_LINK, 'expected_scheme': ''},
    },
    {
        'id': 'deep-link', 'expect': False,
        'why': '负例:http 目标(不是深链)',
        'observation': {'location': 'http://127.0.0.1:8091' + CALLBACK_PATH + '?code=x', 'expected_scheme': ''},
    },
    {
        'id': 'deep-link', 'expect': False,
        'why': '负例:相对地址',
        'observation': {'location': '/auth/callback?code=x', 'expected_scheme': ''},
    },
    {
        'id': 'deep-link', 'expect': False,
        'why': '负例:空 Location',
        'observation': {'location': '', 'expected_scheme': ''},
    },
    {
        'id': 'deep-link', 'expect': False,
        'why': '负例:host 不是 auth',
        'observation': {'location': 'picoaide://evil?token=' + 'a' * 40, 'expected_scheme': ''},
    },
    {
        'id': 'deep-link', 'expect': False,
        'why': '负例:token 过短',
        'observation': {'location': 'picoaide://auth?token=abc', 'expected_scheme': ''},
    },
    {
        'id': 'deep-link', 'expect': False,
        'why': '负例:scheme 与期望不符',
        'observation': {'location': GOOD_DEEP_LINK, 'expected_scheme': 'example-harness'},
    },
    {
        'id': 'deep-link', 'expect': True,
        'why': '正常:scheme 命中期望',
        'observation': {'location': GOOD_DEEP_LINK, 'expected_scheme': 'picoaide'},
    },

    # ---- deep-link-identity ----
    {
        'id': 'deep-link-identity', 'expect': True,
        'why': '正常:本次登录账号',
        'observation': {'status': 200, 'body': '{"user":{"username":"admin"}}',
                        'expected_user': 'admin', 'expected_email': 'admin@example.com'},
    },
    {
        'id': 'deep-link-identity', 'expect': True,
        'why': '正常:邮箱命中',
        'observation': {'status': 200, 'body': '{"user":{"email":"admin@example.com"}}',
                        'expected_user': 'admin', 'expected_email': 'admin@example.com'},
    },
    {
        'id': 'deep-link-identity', 'expect': False,
        'why': '负例:别的账号',
        'observation': {'status': 200, 'body': '{"user":{"username":"alice"}}',
                        'expected_user': 'admin', 'expected_email': 'admin@example.com'},
    },
    {
        'id': 'deep-link-identity', 'expect': False,
        'why': '负例:仅含 admin 字样的其它字段',
        'observation': {'status': 200, 'body': '{"user":{"id":7,"role":"admin"}}',
                        'expected_user': 'admin', 'expected_email': 'admin@example.com'},
    },
    {
        'id': 'deep-link-identity', 'expect': False,
        'why': '负例:401',
        'observation': {'status': 401, 'body': '{"error":{"code":"AUTH_REQUIRED"}}',
                        'expected_user': 'admin', 'expected_email': 'admin@example.com'},
    },
]

# 夹具条数下限(棘轮):删夹具必须同时改这个常量与门禁里的登记值并写明理由。
DEX_MIN_FIXTURES = 32


def _new_reporter():
    """运行期的判定通道(`--self-check` 与真实跑**共用同一个构造点**)。

    门禁的 `runtime-wrapper` 变异就注入在这里 —— 把通道换成恒真包装之后
    `--self-check` 必须非零(自检消费的就是运行期这条通道)。
    """
    return Reporter(CRITERIA)


# ---------------------------------------------------------------------------
def parse_args(argv):
    server, user, password = DEFAULT_BASE, DEFAULT_USER, DEFAULT_PASSWORD
    want_self_test, want_self_check, want_dump = False, False, False
    positional = []
    rest = list(argv)
    while rest:
        item = rest.pop(0)
        if item == '--self-test':
            want_self_test = True
        elif item == '--self-check':
            want_self_check = True
        elif item == '--dump-criteria':
            want_dump = True
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
    modes = [want_self_test, want_self_check, want_dump].count(True)
    if modes > 1:
        print('dex-sso-test: --self-test / --self-check / --dump-criteria 只能给一个', file=sys.stderr)
        raise SystemExit(EXIT_USAGE)
    return server, user, password, want_self_test, want_self_check, want_dump


def self_test():
    """判据本体自证:每条判据的正/负例夹具都必须给出期望结论。"""
    result = run_criteria_self_test(CRITERIA, SELF_TEST_FIXTURES)
    status = report_self_test_result(result)
    if result['total'] < DEX_MIN_FIXTURES:
        print(f'self-test: 夹具只剩 {result["total"]} 条(下限 {DEX_MIN_FIXTURES})'
              ' —— 夹具被删到没有判别力;确实要下调请同时改 DEX_MIN_FIXTURES 与门禁登记值')
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
    server, login, password, want_self_test, want_self_check, want_dump = parse_args(argv)
    if want_self_test:
        return self_test()
    if want_self_check:
        return self_check()
    if want_dump:
        print(json.dumps(criteria_dump(CRITERIA, SELF_TEST_FIXTURES), ensure_ascii=False, indent=2))
        return EXIT_PASS

    expected_user = os.environ.get('DEX_EXPECTED_USER') or login.split('@')[0]
    expected_email = login
    idp_expected = os.environ.get('DEX_BASE', '').rstrip('/')
    expected_scheme = os.environ.get('DEX_DEEP_LINK_SCHEME', '')

    reporter = _new_reporter()

    def finish():
        ok = reporter.failures() == 0
        print('RESULT:', 'PASS' if ok else 'FAIL')
        return EXIT_PASS if ok else EXIT_FAIL

    print(f'== Dex SSO 集成测试(server={server} provider={PROVIDER} login={login}) ==')

    jar = http.cookiejar.CookieJar()
    op = make_opener(jar)

    # 0. 环境探测 —— 先分清"环境没起来(SKIP)"与"契约不满足(FAIL)"。
    status, _, body, _ = request(op, server + '/healthz')
    if status != 200:
        return skip('missing-server',
                    f'{server}/healthz 不可达/非 200(status={status}) —— 服务端没起来')
    status, _, methods_body, _ = request(op, server + '/api/server/admin/auth/methods')
    if status == 200:
        try:
            names = {m.get('name') for m in json.loads(methods_body).get('methods', []) if m.get('configured')}
        except (ValueError, AttributeError):
            names = set()
        if names and not names & {'oidc', 'openid'}:
            return skip('missing-provider',
                        f'服务端未配置浏览器跳转登录(configured={sorted(names)}) —— '
                        '本用例验证的是 OIDC 授权码流')

    # 1. 启动登录流:不跟随,拿 state cookie + IdP 授权地址。
    status, authorize, _, _ = request(op, f'{server}/api/client/v2/auth/{PROVIDER}/login')
    if not reporter.report('login-start', {'status': status, 'location': authorize}):
        return finish()

    # 2. 跟随到 IdP(第一次跳转就吃自定义 scheme 的话说明配置把 IdP 指成了非 http)。
    status, url, body, _, deep_link, hops = follow(op, authorize)
    idp_origin = idp_expected or (urllib.parse.urlparse(authorize).scheme + '://'
                                  + urllib.parse.urlparse(authorize).netloc)
    if not reporter.report('idp-login-page', {'url': url, 'body': body, 'idp_origin': idp_origin}):
        return finish()

    # 3. 提交凭据(表单 POST 到当前 url,带 state;Dex 表单无 csrf)。
    form = urllib.parse.urlencode({'login': login, 'password': password}).encode()
    status, url, body, _, deep_link, hops = follow(
        op, url, data=form,
        headers={'Content-Type': 'application/x-www-form-urlencoded', 'Referer': url})
    reporter.report('submit-credentials', {'status': status, 'body': body})

    # 4. IdP 要求授权确认时继续提交(不能只是"看到 approval 就跳过")。
    approval_required = 'approval' in url
    if approval_required:
        form = urllib.parse.urlencode({'approve': 'true', 'grant_scope': 'openid profile email'}).encode()
        status, url, body, _, deep_link, hops = follow(
            op, url, data=form,
            headers={'Content-Type': 'application/x-www-form-urlencoded', 'Referer': url})
    else:
        print('  ·  [4] IdP 未要求授权确认(直接回调),approve 提交未执行')
    reporter.report('approval-advance',
                    {'required': approval_required, 'status': status, 'url': url, 'body': body})

    reporter.report('callback-reached', {'hops': hops})

    # 5. 回调必须下发深链 —— 读 Location 头(不跟随自定义 scheme)。
    reporter.report('deep-link', {'location': deep_link, 'expected_scheme': expected_scheme})
    if not deep_link:
        print('  （深链缺失:回调响应见上一步诊断；服务端 302 目标不是自定义 scheme 即判失败）')
        return finish()

    # 6. 深链 token 必须真的能登录,且是本次登录的账号。
    _, _, query = parse_deep_link(deep_link)
    token = (query.get('token') or [''])[0]
    print(f'  ·  深链 token 长度={len(token)}')
    status, _, body, _ = request(make_opener(http.cookiejar.CookieJar()), f'{server}/api/client/v2/auth/me',
                                 headers={'Authorization': 'Bearer ' + token})
    reporter.report('deep-link-identity', {'status': status, 'body': body,
                                           'expected_user': expected_user, 'expected_email': expected_email})

    return finish()


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
