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
 * @param channel - `/api/client/v2/channel` 的响应体(可缺省 = 服务端没给渠道内容)。
 * @returns 登录页品牌区应显示的名字。
 */
export function expectedBrandName(channel) {
  const raw = channel?.login?.display_name ?? channel?.client?.display_name
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : CHANNEL_FALLBACK_BRAND
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
  expectedBrand: '服务端渠道内容算出的品牌显示名(见 expectedBrandName)',
  screenshot: '{ name, size } 当前截图',
  baseline: '{ name, bytes } Step1 的基准截图(字节)',
  current: '{ name, bytes } 待比较的截图(字节)',
  phaseOk: '是否检测到两步式登录页(Step1 标记存在)',
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
    name: '检测到两步式登录页',
    evaluate: observation => (observation.phaseOk === true
      ? { ok: true }
      : { ok: false, detail: '未检测到(可能已登录或页面不同)' }),
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
    name: `Step1 登录页(含「${STEP1_MARKER}」)`,
    evaluate: observation => (typeof observation.pageText === 'string' && observation.pageText.includes(STEP1_MARKER)
      ? { ok: true }
      : { ok: false, detail: '页面文本里没有 Step1 标记' }),
  },
  {
    id: 'server-filled',
    name: '服务端地址已填入输入框',
    evaluate: observation => (typeof observation.serverValue === 'string'
      && observation.serverValue === observation.server
      ? { ok: true }
      : { ok: false, detail: `实际 ${JSON.stringify(observation.serverValue)}` }),
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
    name: '方式选择器存在',
    evaluate: observation => (typeof observation.methodCount === 'number' && observation.methodCount > 0
      ? { ok: true, detail: `count=${observation.methodCount}` }
      : { ok: false, detail: `count=${JSON.stringify(observation.methodCount)}` }),
  },
  {
    id: 'step2-shot-differs-from-step1',
    name: 'Step2 截图与 Step1 **不同**(证明流程真的前进、截图真的重抓)',
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
    name: '登录后离开登录页',
    evaluate: observation => (typeof observation.pageText === 'string' && !observation.pageText.includes(STEP1_MARKER)
      ? { ok: true }
      : { ok: false, detail: '登录后页面文本里仍有 Step1 标记' }),
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
    expectedBrand: 'Example',
    screenshot: { name: '03-step2-brand.png', size: 17101 },
    baseline: { name: '01-login-step1.png', bytes: Uint8Array.from([1, 2, 3, 4]) },
    current: { name: '03-step2-brand.png', bytes: Uint8Array.from([9, 9, 9, 9, 9]) },
    phaseOk: true,
    error: null,
    ...overrides,
  }
}

/**
 * 自检夹具:**每条判据都必须有正例与负例**。
 * 负例不被拒 = 判据退化成恒真(或恒假)—— 这正是门禁要咬住的形态。
 */
export const SELF_TEST_FIXTURES = [
  { id: 'script-completed', expect: true, why: '正常跑完:error 为 null', observation: observation() },
  { id: 'script-completed', expect: false, why: '负例:连接应用失败', observation: observation({ error: 'cannot connect to app' }) },
  { id: 'script-completed', expect: false, why: '负例:异常被包成 Error 之外的取值', observation: observation({ error: 'capture failed' }) },

  { id: 'two-step-login-page', expect: true, why: '正常:Step1 标记存在', observation: observation({ phaseOk: true }) },
  { id: 'two-step-login-page', expect: false, why: '负例:直接进了应用(没有 Step1)', observation: observation({ phaseOk: false }) },
  { id: 'two-step-login-page', expect: false, why: '负例:观测缺失', observation: observation({ phaseOk: undefined }) },

  { id: 'screenshot-nonempty', expect: true, why: '正常帧 ≈17 KB', observation: observation({ screenshot: { name: 'x.png', size: 17101 } }) },
  { id: 'screenshot-nonempty', expect: false, why: '负例:空图(0 B)', observation: observation({ screenshot: { name: 'x.png', size: 0 } }) },
  { id: 'screenshot-nonempty', expect: false, why: '负例:纯色小图(500 B,低于下界)', observation: observation({ screenshot: { name: 'x.png', size: 500 } }) },
  { id: 'screenshot-nonempty', expect: false, why: '负例:尺寸不可读', observation: observation({ screenshot: { name: 'x.png' } }) },

  { id: 'step1-login-page', expect: true, why: '正常:页面含 Step1 标记', observation: observation() },
  { id: 'step1-login-page', expect: false, why: '负例:登录后页面', observation: observation({ pageText: '欢迎回来' }) },
  { id: 'step1-login-page', expect: false, why: '负例:页面文本不可读', observation: observation({ pageText: undefined }) },

  { id: 'server-filled', expect: true, why: '正常:输入框值等于期望地址', observation: observation() },
  { id: 'server-filled', expect: false, why: '负例:输入框仍是空/旧值', observation: observation({ serverValue: '' }) },
  { id: 'server-filled', expect: false, why: '负例:输入框值不可读', observation: observation({ serverValue: undefined }) },

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

  { id: 'method-picker', expect: true, why: '正常:2 个方式', observation: observation({ methodCount: 2 }) },
  { id: 'method-picker', expect: false, why: '负例:一个方式都没有', observation: observation({ methodCount: 0 }) },
  { id: 'method-picker', expect: false, why: '负例:选择器缺失(undefined)', observation: observation({ methodCount: undefined }) },

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

  { id: 'left-login-page', expect: true, why: '正常:登录后 Step1 标记消失', observation: observation({ pageText: '会话列表' }) },
  { id: 'left-login-page', expect: false, why: '负例:登录后仍停在登录页', observation: observation({ pageText: `${STEP1_MARKER}` }) },
  { id: 'left-login-page', expect: false, why: '负例:页面文本不可读', observation: observation({ pageText: undefined }) },
]

/**
 * 跑自检:每条判据的每条夹具都必须给出期望结论,且每条判据都必须有正例与负例。
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
    const ok = result !== null && typeof result === 'object' && typeof result.ok === 'boolean'
      ? result.ok
      : undefined
    if (ok !== fixture.expect) {
      failures.push(`${fixture.id}: 期望 ok=${fixture.expect},实得 ${String(ok)}(${fixture.why})`)
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
