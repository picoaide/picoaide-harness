/**
 * `electron-shots.mjs` 的**判据表**(纯函数)+ 自检夹具 —— 运行期脚本与门禁消费同一份。
 *
 * 为什么单独成文件(2026-09-23 第四轮审计 R4-A-17 / R4-A-18):
 *   ① **运行期断言此前零守卫**:`electron-shots.mjs` 里 8 条 `check(…)` 被改成常量
 *      (`check('Step2 品牌 Acme AI', brand === true)` → `check(…, true)`,4 个 needle
 *      字面量全部保留)之后,`scripts/check-integration-tests.mjs` 仍然 **EXIT=0** ——
 *      门禁只对两个 `.py` 做端到端/变异验证,对这个脚本只有"文件里有没有这几句话"
 *      的字符串判据。
 *   ② **陈旧夹具**:同一处断言钉的是已退役的旧品牌夹具 `Acme AI`,而当前实现里登录页
 *      品牌区渲染的是**服务端渠道内容**的 `login.display_name`,回落值是随包品牌的
 *      `PicoAide`(`packages/host/enterprise/src/auth-gate.ts:433`,兜底分支 `:410-416`,
 *      随包默认值 `:667`)⇒ 该项在今天的正确环境里**永远不可能 PASS**。
 *
 * 处置:判据从脚本里抽到这张表,两边共用 ——
 *   · 运行期脚本按 **id** 逐条求值(观测对象由它现场采集);
 *   · 门禁跑 `node assertions.mjs --self-test`:每条判据都必须有**正例 + 负例**夹具,
 *     负例不被拒 = 判据退化成恒真 ⇒ 门禁红(把判据改成常量的变异在这里当场被咬住)。
 *
 * 判据签名:`evaluate(observation) → { ok: boolean, detail?: string }`。
 * `observation` 是**现场采集到的观测**(不是判断结果),字段见 `BASE_OBSERVATION`。
 *
 * 自检:`node assertions.mjs --self-test`;
 * 清单:`node assertions.mjs --list`。
 * 退出码:0 = 通过;1 = 夹具不符合预期(或判据缺正例/负例);2 = 用法错误。
 */
import { Buffer } from 'node:buffer'

/**
 * 登录页品牌名的**回落值** = 随包品牌的 `login.displayName`(官方渠道 `PicoAide`)。
 * 真源:`packages/host/enterprise/src/auth-gate.ts:667`(`BRAND.login.displayName`),
 * 渲染点同文件 `:433`(`login.display_name || BRAND.login.displayName`)。
 */
export const CHANNEL_FALLBACK_BRAND = 'PicoAide'

/**
 * 期望看到的品牌名:渠道内容驱动(与服务端 `GET /api/client/v2/channel` 同源,而不是
 * 一个写死的旧夹具名)。
 *
 * 两段回落(**顺序不能反**,第三十三轮 FIX-49① 补第二段):
 *   ① 服务端下发过渠道内容 ⇒ 用它的 `login.display_name`;
 *   ② 服务端**没有**渠道内容(未配置/旧服务端/网关没这条路由)⇒ 登录页渲染的是**随包品牌**
 *      (`auth-gate.ts:433` 的 `login.display_name || BRAND.login.displayName`,而
 *      `BRAND.login.displayName` 来自渠道包 `copy.login_display_name`,见
 *      `desktop-channel.ts:398`);
 *   ③ 包内也没有(官方构建)⇒ `PicoAide`。
 * 只做 ①③ 会在渠道包上把期望值算成 `PicoAide` —— 那条腿此前在渠道包上**根本没被求值**
 * (旧实现的 `if (step1)` 把它整条跳过了),所以这个洞一直没露出来。
 * @param channel - `/api/client/v2/channel` 的响应体(可缺省 = 服务端没给渠道内容)。
 * @param packageBrand - 随包品牌(`build/channel.json` 的 `copy.login_display_name`
 *   → `identity.short_name`;官方构建为 `null`)。
 * @returns 登录页品牌区应显示的名字。
 */
export function expectedBrandName(channel, packageBrand) {
  const raw = channel?.login?.display_name ?? channel?.client?.display_name
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
  if (typeof packageBrand === 'string' && packageBrand.trim() !== '') return packageBrand.trim()
  return CHANNEL_FALLBACK_BRAND
}

/** 截图必须大于这个字节数才算"真的抓到帧"(纯色/空图会远小于它;实测正常帧 ≈17 KB)。 */
const MIN_SCREENSHOT_BYTES = 1000

/** Step1(连接服务端)页面的判据标记;登录后该标记必须消失。 */
export const STEP1_MARKER = '连接服务端'

/** 观测对象的字段说明(运行期脚本按此采集;自检夹具按此构造)。 */
export const BASE_OBSERVATION = Object.freeze({
  server: '命令行/环境变量给出的服务端地址',
  serverValue: '页面 #server 输入框的当前值',
  pageText: 'document.body.innerText',
  methodCount: "document.querySelectorAll('.method').length",
  serverMethodCount: '服务端 GET /api/client/v2/auth/methods 下发的**可渲染**方式条数(取不到/形状不符为 null)',
  expectedBrand: '服务端渠道内容算出的品牌显示名(见 expectedBrandName)',
  screenshot: '{ name, size } 当前截图',
  baseline: '{ name, bytes } 基准截图(字节)',
  current: '{ name, bytes } 待比较的截图(字节)',
  phaseOk: '是否检测到两步式登录页(Step1 舞台处于 active)',
  /**
   * **包内**渠道配置里的 `defaults.server_url`(第三十三轮 FIX-49①)。
   *
   * 三态是**刻意**的:`null` = 读到了包内 `build/channel.json`、里面**没有**内置地址
   * (官方形态);字符串 = 内置了地址(渠道包交付形态);`undefined` = **读不出来**
   * (拿不准 ⇒ 判据必须判失败,不许挑一种"看起来像"的形态)。
   */
  builtInServerURL: '包内 build/channel.json 的 defaults.server_url(null=没有;字符串=内置;undefined=读不出来)',
  step1Active: 'Step1 舞台是否处于 active(#step1 的 class 里有 active)',
  serverInputVisible: '服务端地址输入框是否**可见**(#server 存在且 offsetParent 非 null)',
  loginFormPresent: '登录表单是否仍在页面上(#f2 / #btn / #server 任一存在)',
  loginErrorText: '登录页错误区文案(#err-step2 的 textContent;该元素已被应用外壳替换时为 null)',
  appShellMounted: '应用外壳是否已挂载(#root 存在且 childElementCount > 0)',
  error: '异常消息;没有异常时为 null',
})

/**
 * 判据表。每条都必须是**纯函数**,且对"观测缺失/类型不对"必须判失败(不能因为字段
 * 是 undefined 就当成通过 —— 那正是"恒真判据"的另一种写法)。
 */
export const SHOTS_ASSERTIONS = [
  {
    id: 'script-completed',
    name: '脚本执行完成(无未捕获异常)',
    evaluate: observation => (observation.error === null || observation.error === undefined
      ? { ok: true }
      : { ok: false, detail: String(observation.error) }),
  },
  {
    id: 'two-step-login-page',
    name: '检测到两步式登录页(包内无内置地址;内置地址 ⇒ 按设计 SKIP)',
    evaluate: observation => {
      const builtIn = observation.builtInServerURL
      // 包内**内置了**服务端地址(渠道包交付形态)⇒ 客户端 `autoConnect()` 直进 Step2,
      // 两步式流程按设计不适用 —— 显式报 SKIP(**不是**静默不求值,也不是判过)。
      if (typeof builtIn === 'string' && builtIn.trim() !== '') {
        return { ok: true, skip: `包内内置服务端地址(${builtIn.trim()})⇒ 按设计跳过 Step1,两步式流程不适用` }
      }
      if (builtIn === undefined) {
        return { ok: false, detail: '读不出包内 build/channel.json 的 defaults.server_url ⇒ 无法判定登录页该是哪种形态(拿不准就判失败)' }
      }
      return observation.phaseOk === true
        ? { ok: true }
        : { ok: false, detail: '未检测到(可能已登录或页面不同)' }
    },
  },
  {
    id: 'screenshot-nonempty',
    name: '截图非空(真的抓到帧)',
    evaluate: observation => {
      const size = observation.screenshot?.size
      if (typeof size !== 'number' || !Number.isFinite(size)) {
        return { ok: false, detail: `截图尺寸不可读(${JSON.stringify(size)})` }
      }
      return { ok: size > MIN_SCREENSHOT_BYTES, detail: `${size} B` }
    },
  },
  {
    id: 'step1-login-page',
    // 2026-09-27(第三十三轮 FIX-49①):旧谓词只认"页面文本里有 Step1 标记",守的其实是
    // **环境恰好是官方两步式**这个环境属性 —— 带 `defaults.server_url` 的渠道包按设计
    // 直进 Step2(LOGIN_HTML 的 `autoConnect()`),这条腿**结构上不可能 PASS**
    // (AE2 真机实测:同一 harness、同一网关,只差包里有没有内置地址 ⇒ 官方 PASS、
    //  渠道包 `[FAIL] Step1 登录页`)。现在判据跟随**包内** `build/channel.json` 的
    // `defaults.server_url`:内置 ⇒ 断"不得渲染 Step1";无内置 ⇒ 断"必须渲染 Step1"。
    name: '登录页形态与包内内置地址一致(内置 ⇒ 不得渲染 Step1;无内置 ⇒ 必须渲染)',
    evaluate: observation => {
      if (typeof observation.pageText !== 'string') return { ok: false, detail: '页面文本不可读' }
      if (typeof observation.step1Active !== 'boolean') {
        return { ok: false, detail: 'Step1 舞台状态不可读(#step1 的 active 类)' }
      }
      const builtIn = observation.builtInServerURL
      if (builtIn === undefined) {
        return { ok: false, detail: '读不出包内 build/channel.json 的 defaults.server_url ⇒ 无法判定登录页该是哪种形态(拿不准就判失败)' }
      }
      const rendered = observation.pageText.includes(STEP1_MARKER)
      if (typeof builtIn === 'string' && builtIn.trim() !== '') {
        return rendered === false && observation.step1Active === false
          ? { ok: true, detail: `包内内置服务端 ${builtIn.trim()} ⇒ 按设计不渲染 Step1` }
          : {
              ok: false,
              detail: `包内内置服务端 ${builtIn.trim()},却仍渲染了 Step1`
                + `(文本标记=${rendered},舞台 active=${observation.step1Active})`,
            }
      }
      return rendered === true && observation.step1Active === true
        ? { ok: true, detail: '包内无内置地址 ⇒ 两步式 Step1 必须渲染' }
        : {
            ok: false,
            detail: `包内无内置地址,Step1 却没渲染(文本标记=${rendered},舞台 active=${observation.step1Active})`,
          }
    },
  },
  {
    id: 'server-filled',
    name: '服务端地址已填入输入框(内置地址 ⇒ 按设计不暴露可编辑的地址输入框)',
    evaluate: observation => {
      const builtIn = observation.builtInServerURL
      if (typeof builtIn === 'string' && builtIn.trim() !== '') {
        // 内置地址 ⇒ 按设计**没有**"填写地址"这一步(2026-09-11 的产品约定:内置地址时
        // 不留"修改服务端地址"退路)。这条腿因此变成"地址输入框不得可见"——仍然是判据,
        // 不是静默跳过。
        if (typeof observation.serverInputVisible !== 'boolean') {
          return { ok: false, detail: '地址输入框的可见性不可读' }
        }
        return observation.serverInputVisible === false
          ? { ok: true, detail: `包内内置服务端 ${builtIn.trim()} ⇒ 不暴露地址输入步骤(输入框不可见)` }
          : { ok: false, detail: `包内内置服务端 ${builtIn.trim()},地址输入框却仍可见(产品约定:内置地址不留修改退路)` }
      }
      if (builtIn === undefined) {
        return { ok: false, detail: '读不出包内 build/channel.json 的 defaults.server_url ⇒ 无法判定这一步该不该存在' }
      }
      return typeof observation.serverValue === 'string' && observation.serverValue === observation.server
        ? { ok: true }
        : { ok: false, detail: `实际 ${JSON.stringify(observation.serverValue)}` }
    },
  },
  {
    id: 'step2-brand',
    name: 'Step2 品牌区显示**渠道显示名**(服务端 login.display_name,回落随包品牌)',
    evaluate: observation => {
      const expected = observation.expectedBrand
      if (typeof expected !== 'string' || expected === '') {
        return { ok: false, detail: '期望品牌名不可用(渠道内容与回落值都取不到)' }
      }
      if (typeof observation.pageText !== 'string') {
        return { ok: false, detail: '页面文本不可读' }
      }
      return {
        ok: observation.pageText.includes(expected),
        detail: `期望包含 ${JSON.stringify(expected)}`,
      }
    },
  },
  {
    id: 'method-picker',
    // 2026-09-27(第三十二轮 FIX-47/AD2-02):旧判据名「方式选择器存在」,谓词却是
    // `methodCount > 0` —— 它守的其实是"服务端恰好配了 ≥2 种登录方式"这个**环境属性**。
    // 登录页在只有 1 种方式时**按设计不渲染**选择器
    // (`packages/host/enterprise/src/auth-gate.ts:453-456` 的 `only` 分支:
    //  `if (only) { methodsBox.innerHTML = ''; return }`),
    // 所以在"刚装好、只配 local"的服务端(默认形态)上这条腿**结构上不可能 PASS**,
    // 且报 FAIL(1) 而不是 SKIP(77)。现在判据跟着服务端真下发的条数走。
    name: '方式选择器与服务端下发的方式数一致(≤1 种不渲染、≥2 种必须全部渲染)',
    evaluate: observation => {
      const serverCount = observation.serverMethodCount
      const rendered = observation.methodCount
      // 环境事实取不到 ⇒ 失败(不是"没有选择器 ⇒ 通过")。静默判过正是这条判据要消灭的形态。
      if (typeof serverCount !== 'number' || !Number.isInteger(serverCount) || serverCount < 0) {
        return { ok: false, detail: `服务端方式数不可读(${JSON.stringify(serverCount)})—— 没有环境事实时不得判过` }
      }
      if (typeof rendered !== 'number' || !Number.isInteger(rendered) || rendered < 0) {
        return { ok: false, detail: `页面方式数不可读(${JSON.stringify(rendered)};服务端 ${serverCount} 种)` }
      }
      if (serverCount <= 1) {
        return rendered === 0
          ? { ok: true, detail: `服务端 ${serverCount} 种 ⇒ 按设计不渲染选择器(count=0)` }
          : { ok: false, detail: `服务端只下发 ${serverCount} 种,页面却渲染了 ${rendered} 个选择器` }
      }
      return rendered === serverCount
        ? { ok: true, detail: `服务端 ${serverCount} 种,页面渲染 ${rendered} 个` }
        : { ok: false, detail: `服务端 ${serverCount} 种,页面只渲染 ${rendered} 个` }
    },
  },
  {
    id: 'step2-shot-differs-from-step1',
    name: '流程推进后的截图与初始截图**不同**(证明流程真的前进、截图真的重抓)',
    evaluate: observation => {
      const baseline = observation.baseline?.bytes
      const current = observation.current?.bytes
      if (!(baseline instanceof Uint8Array) || !(current instanceof Uint8Array)) {
        return { ok: false, detail: '缺少截图字节(无法比较)' }
      }
      const same = baseline.length === current.length && Buffer.compare(Buffer.from(baseline), Buffer.from(current)) === 0
      return same
        ? { ok: false, detail: `两张截图逐字节相同(${baseline.length} B)⇒ 页面没有前进,或截图没有真的重抓` }
        : { ok: true, detail: `${baseline.length} B vs ${current.length} B` }
    },
  },
  {
    id: 'left-login-page',
    // 2026-09-27(第三十三轮 FIX-49②):旧谓词是 `!pageText.includes('连接服务端')` ——
    // 它判的是"**离开了 Step1**",与"登录成功"毫无关系:登录被拒时页面停在 Step2
    // (`auth-gate.ts` 把错误写进 `#err2` 且不跳转),页面**早就离开 Step1 了**。
    // AE2 真机实测:网关 `/auth/login` 回 401 时 13 条判据**全绿、EXIT=0**,与真登录成功
    // 那一次的判据结论行**逐字相同**(只差截图字节数)⇒ "真机主流程开箱不可登录"这种最严重
    // 的形态会全绿收场。
    // 现在判据要的是**登录成功的正向证据**:登录表单消失 + 应用外壳已挂载 + 登录页无错误文案。
    name: '登录成功后进入应用(正向证据:登录表单消失 + 应用外壳已挂载 + 登录页无错误文案)',
    evaluate: observation => {
      if (typeof observation.pageText !== 'string') return { ok: false, detail: '页面文本不可读' }
      const problems = []
      if (observation.loginFormPresent === true) problems.push('登录表单仍在页面上(页面还停在登录页)')
      if (observation.appShellMounted !== true) problems.push('应用外壳未挂载(#root 不存在或没有子节点)')
      if (typeof observation.loginErrorText === 'string' && observation.loginErrorText.trim() !== '') {
        problems.push(`登录页显示了错误文案 ${JSON.stringify(observation.loginErrorText.trim().slice(0, 60))}`)
      }
      if (observation.step1Active === true) problems.push('Step1 舞台仍处于 active')
      return problems.length === 0
        ? { ok: true, detail: '登录表单已消失、应用外壳已挂载、登录页无错误文案' }
        : { ok: false, detail: problems.join('；') }
    },
  },
]

/** 按 id 取判据(取不到即抛 —— 运行期脚本里的 id 打错必须当场炸,不能静默少判一条)。 */
export function assertionById(id) {
  const found = SHOTS_ASSERTIONS.find(assertion => assertion.id === id)
  if (found === undefined) throw new Error(`未知判据 id: ${JSON.stringify(id)}`)
  return found
}

/** 一条"像是正常跑完"的观测(夹具基线;每条夹具只覆盖它关心的字段)。 */
function observation(overrides = {}) {
  return {
    server: 'http://127.0.0.1:8091',
    serverValue: 'http://127.0.0.1:8091',
    pageText: `${STEP1_MARKER} 下一步`,
    methodCount: 2,
    serverMethodCount: 2,
    expectedBrand: 'Example',
    screenshot: { name: '03-step2-brand.png', size: 17101 },
    baseline: { name: '01-login-step1.png', bytes: Uint8Array.from([1, 2, 3, 4]) },
    current: { name: '03-step2-brand.png', bytes: Uint8Array.from([9, 9, 9, 9, 9]) },
    // 基线 = **官方形态**（包内没有内置地址 ⇒ 两步式 Step1）—— 见各夹具的显式覆盖。
    builtInServerURL: null,
    step1Active: true,
    serverInputVisible: true,
    loginFormPresent: true,
    loginErrorText: null,
    appShellMounted: false,
    phaseOk: true,
    error: null,
    ...overrides,
  }
}

/** 渠道包(内置服务端地址)的基线:直进 Step2、不渲染 Step1、不暴露地址输入框。 */
function channelObservation(overrides = {}) {
  return observation({
    builtInServerURL: 'http://127.0.0.1:34568',
    step1Active: false,
    serverInputVisible: false,
    pageText: 'Example A 选择登录方式 账号密码登录',
    phaseOk: false,
    ...overrides,
  })
}

/** 登录**成功**之后的基线(登录表单已消失、应用外壳已挂载)。 */
function loggedInObservation(overrides = {}) {
  return observation({
    pageText: '会话列表 新会话',
    step1Active: false,
    loginFormPresent: false,
    loginErrorText: null,
    appShellMounted: true,
    ...overrides,
  })
}

/**
 * 自检夹具:**每条判据都必须有正例与负例**。
 * 负例不被拒 = 判据退化成恒真(或恒假)—— 这正是门禁要咬住的形态。
 */
export const SELF_TEST_FIXTURES = [
  { id: 'script-completed', expect: true, why: '正常跑完:error 为 null', observation: observation() },
  { id: 'script-completed', expect: false, why: '负例:连接应用失败', observation: observation({ error: 'cannot connect to app' }) },
  { id: 'script-completed', expect: false, why: '负例:异常被包成 Error 之外的取值', observation: observation({ error: 'capture failed' }) },

  { id: 'two-step-login-page', expect: true, why: '正常:Step1 舞台 active(官方形态)', observation: observation({ phaseOk: true }) },
  {
    id: 'two-step-login-page',
    expect: 'skip',
    why: '渠道包(内置服务端地址)⇒ 两步式流程按设计不适用,必须**显式 SKIP**(不是静默不求值、也不是判过)',
    observation: channelObservation(),
  },
  { id: 'two-step-login-page', expect: false, why: '负例:直接进了应用(没有 Step1)', observation: observation({ phaseOk: false }) },
  { id: 'two-step-login-page', expect: false, why: '负例:观测缺失', observation: observation({ phaseOk: undefined }) },
  {
    id: 'two-step-login-page',
    expect: false,
    why: '负例:读不出包内渠道配置(undefined)⇒ 拿不准就判失败,不许挑一种形态',
    observation: observation({ builtInServerURL: undefined }),
  },

  { id: 'screenshot-nonempty', expect: true, why: '正常帧 ≈17 KB', observation: observation({ screenshot: { name: 'x.png', size: 17101 } }) },
  { id: 'screenshot-nonempty', expect: false, why: '负例:空图(0 B)', observation: observation({ screenshot: { name: 'x.png', size: 0 } }) },
  { id: 'screenshot-nonempty', expect: false, why: '负例:纯色小图(500 B,低于下界)', observation: observation({ screenshot: { name: 'x.png', size: 500 } }) },
  { id: 'screenshot-nonempty', expect: false, why: '负例:尺寸不可读', observation: observation({ screenshot: { name: 'x.png' } }) },

  { id: 'step1-login-page', expect: true, why: '正常(官方形态):包内无内置地址 ⇒ 必须渲染 Step1', observation: observation() },
  {
    id: 'step1-login-page',
    expect: true,
    why: '正常(渠道包):包内内置地址 ⇒ 按设计**不得**渲染 Step1(autoConnect 直进 Step2)',
    observation: channelObservation(),
  },
  {
    id: 'step1-login-page',
    expect: false,
    why: '负例(渠道包):内置了地址却仍渲染 Step1 ⇒ 产品约定被破坏',
    observation: channelObservation({ step1Active: true, pageText: `${STEP1_MARKER} 下一步` }),
  },
  {
    id: 'step1-login-page',
    expect: false,
    why: '负例(官方形态):没有内置地址却没渲染 Step1(修前渠道包的那条必红腿,在这里必须仍是红)',
    observation: observation({ pageText: '欢迎回来', step1Active: false }),
  },
  { id: 'step1-login-page', expect: false, why: '负例:页面文本不可读', observation: observation({ pageText: undefined }) },
  {
    id: 'step1-login-page',
    expect: false,
    why: '负例:Step1 舞台状态不可读(undefined)⇒ 不得因为读不到就判过',
    observation: observation({ step1Active: undefined }),
  },
  {
    id: 'step1-login-page',
    expect: false,
    why: '负例:读不出包内渠道配置(undefined)⇒ 拿不准就判失败',
    observation: observation({ builtInServerURL: undefined }),
  },

  { id: 'server-filled', expect: true, why: '正常(官方形态):输入框值等于期望地址', observation: observation() },
  {
    id: 'server-filled',
    expect: true,
    why: '正常(渠道包):内置地址 ⇒ 按设计不暴露可编辑的地址输入框',
    observation: channelObservation(),
  },
  {
    id: 'server-filled',
    expect: false,
    why: '负例(渠道包):内置了地址却仍暴露可见的地址输入框(产品约定:内置地址不留修改退路)',
    observation: channelObservation({ serverInputVisible: true }),
  },
  {
    id: 'server-filled',
    expect: false,
    why: '负例(渠道包):输入框可见性不可读 ⇒ 拿不准就判失败',
    observation: channelObservation({ serverInputVisible: undefined }),
  },
  { id: 'server-filled', expect: false, why: '负例:输入框仍是空/旧值', observation: observation({ serverValue: '' }) },
  { id: 'server-filled', expect: false, why: '负例:输入框值不可读', observation: observation({ serverValue: undefined }) },
  {
    id: 'server-filled',
    expect: false,
    why: '负例:读不出包内渠道配置(undefined)⇒ 拿不准就判失败',
    observation: observation({ builtInServerURL: undefined }),
  },

  {
    id: 'step2-brand',
    expect: true,
    why: '正常:页面显示服务端渠道显示名',
    observation: observation({ expectedBrand: 'Example', pageText: 'Example 选择登录方式' }),
  },
  {
    id: 'step2-brand',
    expect: false,
    why: '负例:页面显示的是别的名字(旧夹具 Acme AI 会在这里被拒)',
    observation: observation({ expectedBrand: 'Example', pageText: 'Acme AI 选择登录方式' }),
  },
  {
    id: 'step2-brand',
    expect: false,
    why: '负例:期望品牌名取不到',
    observation: observation({ expectedBrand: '' }),
  },
  {
    id: 'step2-brand',
    expect: false,
    why: '负例:页面文本不可读',
    observation: observation({ expectedBrand: 'Example', pageText: undefined }),
  },

  // method-picker:判据跟**服务端下发的条数**走,两格都要有正例。
  // 夹具基线是 server=2/count=2;下面每条显式覆盖它关心的那两个字段。
  {
    id: 'method-picker',
    expect: true,
    why: '正例 n<=1 格:服务端只配 local ⇒ 页面按设计**不渲染**选择器,这是 PASS 不是 FAIL',
    observation: observation({ serverMethodCount: 1, methodCount: 0 }),
  },
  {
    id: 'method-picker',
    expect: true,
    why: '正例 n<=1 格边界:服务端一种都没配(0)⇒ 同样不渲染',
    observation: observation({ serverMethodCount: 0, methodCount: 0 }),
  },
  { id: 'method-picker', expect: true, why: '正例 n>=2 格:服务端 2 种、页面 2 个', observation: observation({ serverMethodCount: 2, methodCount: 2 }) },
  { id: 'method-picker', expect: true, why: '正例 n>=2 格:服务端 3 种、页面 3 个', observation: observation({ serverMethodCount: 3, methodCount: 3 }) },
  {
    id: 'method-picker',
    expect: false,
    why: '负例(旧判据的形态):服务端只 1 种却**渲染了**选择器 ⇒ 页面多渲染,必须红',
    observation: observation({ serverMethodCount: 1, methodCount: 1 }),
  },
  {
    id: 'method-picker',
    expect: false,
    why: '负例:服务端 2 种、页面一个都没渲染(选择器缺失)',
    observation: observation({ serverMethodCount: 2, methodCount: 0 }),
  },
  {
    id: 'method-picker',
    expect: false,
    why: '负例:服务端 2 种、页面少渲染一个(反向对照:证明判据不是恒真)',
    observation: observation({ serverMethodCount: 2, methodCount: 1 }),
  },
  {
    id: 'method-picker',
    expect: false,
    why: '负例:服务端 3 种、页面只渲染 2 个',
    observation: observation({ serverMethodCount: 3, methodCount: 2 }),
  },
  {
    id: 'method-picker',
    expect: false,
    why: '负例:服务端方式数取不到(null)—— 不得静默判过',
    observation: observation({ serverMethodCount: null, methodCount: 0 }),
  },
  {
    id: 'method-picker',
    expect: false,
    why: '负例:服务端方式数不可读(undefined)',
    observation: observation({ serverMethodCount: undefined, methodCount: 2 }),
  },
  {
    id: 'method-picker',
    expect: false,
    why: '负例:服务端方式数不是数字(形状不符)',
    observation: observation({ serverMethodCount: '2', methodCount: 2 }),
  },
  {
    id: 'method-picker',
    expect: false,
    why: '负例:页面方式数不可读(undefined),而服务端可读 ⇒ 仍必须红',
    observation: observation({ serverMethodCount: 2, methodCount: undefined }),
  },

  {
    id: 'step2-shot-differs-from-step1',
    expect: true,
    why: '正常:两张图内容不同',
    observation: observation(),
  },
  {
    id: 'step2-shot-differs-from-step1',
    expect: false,
    why: '负例:同一张图被写了两次(随仓 5 张截图里 4 张 md5 相同的形态)',
    observation: observation({ baseline: { bytes: Uint8Array.from([1, 2, 3]) }, current: { bytes: Uint8Array.from([1, 2, 3]) } }),
  },
  {
    id: 'step2-shot-differs-from-step1',
    expect: false,
    why: '负例:缺少截图字节',
    observation: observation({ current: undefined }),
  },

  {
    id: 'left-login-page',
    expect: true,
    why: '正常:登录表单消失 + 应用外壳已挂载 + 无错误文案',
    observation: loggedInObservation(),
  },
  {
    id: 'left-login-page',
    expect: false,
    why: '负例(第三十三轮 FIX-49② 的现场形态):页面停在 Step2 且带错误文案(登录被拒)'
      + '—— 旧谓词 `!pageText.includes("连接服务端")` 在**这一格**判 PASS(整轮全绿的成因)',
    observation: observation({
      pageText: 'Example 选择登录方式 账号密码登录 账号或密码错误',
      step1Active: false,
      loginFormPresent: true,
      loginErrorText: '账号或密码错误',
      appShellMounted: false,
    }),
  },
  {
    id: 'left-login-page',
    expect: false,
    why: '负例:登录表单还在(页面没走)',
    observation: observation({ pageText: '账号或密码错误', step1Active: false, loginFormPresent: true }),
  },
  {
    id: 'left-login-page',
    expect: false,
    why: '负例:登录表单消失了但应用外壳没挂载(#root 空 ⇒ 无任何 UI,曾是真机 P0 的形态)',
    observation: observation({ pageText: '', step1Active: false, loginFormPresent: false, appShellMounted: false }),
  },
  {
    id: 'left-login-page',
    expect: false,
    why: '负例:仍停在 Step1',
    observation: observation({ pageText: `${STEP1_MARKER}`, step1Active: true, loginFormPresent: true }),
  },
  { id: 'left-login-page', expect: false, why: '负例:页面文本不可读', observation: observation({ pageText: undefined }) },
]

/**
 * 跑自检:每条判据的每条夹具都必须给出期望结论,且每条判据都必须有正例与负例。
 *
 * `expect` 三态(第三十三轮 FIX-49① 起):
 *   · `true` / `false` —— 判据的 `ok` 结论(且 `true` 必须是**普通通过**,不是 SKIP);
 *   · `'skip'` —— 判据返回 `{ ok: true, skip: '<理由>' }`(按设计不适用时**显式**报 SKIP)。
 * 三态是刻意分开的:把 SKIP 当成普通通过 ⇒ `expect: 'skip'` 的夹具会红;把 SKIP 当成失败
 * ⇒ 同样红。这样"静默不求值"与"把不适用伪装成通过"两种形态都逃不出去。
 * @returns `{ failures, total, passed }`。
 */
export function runSelfTest() {
  const failures = []
  for (const assertion of SHOTS_ASSERTIONS) {
    const cases = SELF_TEST_FIXTURES.filter(fixture => fixture.id === assertion.id)
    if (!cases.some(fixture => fixture.expect === true)) {
      failures.push(`判据 ${assertion.id} 没有**正例**夹具(恒假的判据同样没有判别力)`)
    }
    if (!cases.some(fixture => fixture.expect === false)) {
      failures.push(`判据 ${assertion.id} 没有**负例**夹具(被掏空成恒真的判据在这里不会被发现)`)
    }
  }
  for (const fixture of SELF_TEST_FIXTURES) {
    const assertion = SHOTS_ASSERTIONS.find(item => item.id === fixture.id)
    if (assertion === undefined) {
      failures.push(`夹具 ${fixture.id} 指向不存在的判据`)
      continue
    }
    const result = assertion.evaluate(fixture.observation)
    const shapeOk = result !== null && typeof result === 'object' && typeof result.ok === 'boolean'
    const actual = !shapeOk
      ? undefined
      : (result.ok === false ? false : (typeof result.skip === 'string' && result.skip !== '' ? 'skip' : true))
    if (actual !== fixture.expect) {
      failures.push(`${fixture.id}: 期望 ok=${fixture.expect},实得 ${String(actual)}(${fixture.why})`)
    }
  }
  const total = SELF_TEST_FIXTURES.length
  return { failures, total, passed: total - failures.length }
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('用法: node assertions.mjs --self-test | --list')
    console.log('  --self-test  逐条判据跑正例 + 负例(门禁用;exit 1 = 有夹具不符合预期)')
    console.log('  --list       打印判据清单(供人工/脚本核对覆盖)')
    process.exit(0)
  }
  if (args.includes('--list')) {
    for (const assertion of SHOTS_ASSERTIONS) console.log(`${assertion.id}\t${assertion.name}`)
    console.log(`judged assertions: ${SHOTS_ASSERTIONS.length}`)
    console.log(`self-test fixtures: ${SELF_TEST_FIXTURES.length}`)
    process.exit(0)
  }
  if (!args.includes('--self-test')) {
    console.error('[USAGE] 需要 --self-test 或 --list(本模块不驱动应用;跑真机流程用 electron-shots.mjs)')
    process.exit(2)
  }
  const { failures, total, passed } = runSelfTest()
  for (const failure of failures) console.log(`[FAIL] ${failure}`)
  console.log(`self-test: ${passed}/${total} 条判据夹具符合预期`)
  process.exit(failures.length === 0 ? 0 : 1)
}
