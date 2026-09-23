/**
 * `electron-shots` 的**运行期判定通道**(运行期脚本与门禁消费同一份)。
 *
 * 为什么单独成文件(2026-09-23 第五轮审计 R5-D / R4-A 复审 N7):
 *   第四轮把**判据本体**外置到了 `assertions.mjs`,但"运行期有没有真的按表判"仍然只是
 *   `electron-shots.mjs` 里的一段**可变代码**。现场形态:`report()` 内部改成
 *   `const { ok, detail } = { ok: true, detail: 'MUTATED' }`(9 处 `report(id, …)` 引用
 *   一字未改)⇒ `check-integration-tests` **EXIT=0**、`--self-test 29/29` 照旧 ——
 *   门禁钉的是"文本引用",不是"真的求值"。
 *
 * 处置:**判定与计数下沉到这里**,运行期脚本只做接线,门禁对这条通道做**动态**验证:
 *   · `judge(id, observation)` 是唯一判定入口:按 id 取表里的判据 → 求值 →
 *     校验返回形状(必须 `{ ok: boolean }`;返回别的形状**抛错**,不允许静默当通过);
 *   · `createReporter()` 持有失败计数与退出码判据(运行期脚本不再自己算 `failures`);
 *   · `runReporterSelfCheck(channel)` 把**全部夹具**经**运行期自己那条 `report()`**
 *     求值:正例必须 ok、负例必须 !ok。恒真/恒假的 `report` 在这里必然产出与期望不同的
 *     结论 —— 这正是 N7 的现场形态,而它是**可执行**的判据,不是源码扫描。
 *
 * 2026-09-23 复审 D-1 的补课(channel 参数):上面那句"同一条 report()"此前并不成立 ——
 * 自检在**本文件内部另建**一个 reporter,而 `electron-shots.mjs` 里那句可变的包装
 * (`const report = (id, obs) => reporter.report(id, obs)`)被换成键序变形的常量对象或
 * early-return 恒真之后,自检照样 29/29(静态判据只认 `ok` 在**首键**的写法)。
 * 现在自检**必须**收到运行期解构出来的同一批绑定(`{ report, failures, lines }`),
 * 形状不合法当场抛错 —— 自检证明的就是运行期真正在走的那条通道。
 *
 * 接线(有意的常量):运行期脚本必须 `import { createReporter } from './report.mjs'`,
 * **解构绑定**它自己的方法(`const { report, failures, lines, exitCode } = reporter`,
 * 不允许再包一层),并把 `{ report, failures, lines }` 交给 `--self-check`;
 * `scripts/check-integration-tests.mjs` 会跑 `node electron-shots.mjs --self-check`,
 * 并在**变异副本**上复跑同一命令要求它变红(恒真/计票掏空/运行期包装被替换 ⇒ 非零)。
 *
 * 退出码(与 `electron-shots.mjs` 的契约一致):0 = 全部夹具符合预期;1 = 有不符合。
 */
import { assertionById, SELF_TEST_FIXTURES } from './assertions.mjs'

/**
 * 按 id 求值判据表里的断言。**唯一判定入口**。
 *
 * 三条硬约束:
 *   ① 未知 id **当场抛错**(id 打错必须炸,不能静默少判一条);
 *   ② `evaluate()` 返回形状不合法也抛错 —— "观测缺失就当成通过"是恒真判据的另一种写法;
 *   ③ 返回值只透传判据结论(`ok` / `detail`)与判据名,不在这一层做任何再判断。
 * @param id - 判据 id(见 assertions.mjs 的 SHOTS_ASSERTIONS)。
 * @param observation - 现场采集到的观测(字段见 assertions.mjs 的 BASE_OBSERVATION)。
 * @returns `{ id, name, ok, detail }`。
 */
export function judge(id, observation) {
  const assertion = assertionById(id)
  const result = assertion.evaluate(observation)
  if (result === null || typeof result !== 'object' || typeof result.ok !== 'boolean') {
    throw new TypeError(
      `判据 ${id} 的 evaluate() 必须返回 { ok: boolean },实得 ${JSON.stringify(result)}`
      + ` —— 形状不合法的返回值不得被当成结论(那正是"恒真/静默通过"的另一种写法)`,
    )
  }
  return { id, name: assertion.name, ok: result.ok, detail: result.detail }
}

/**
 * 判定通道的实例:持有失败计数与退出码判据。
 * @param options - `write` 是输出函数(默认 `console.log`,自检时换成收集器)。
 * @returns `{ report, failures, events, lines, exitCode }` —— 运行期脚本必须
 *   **解构绑定**这些方法(不允许自己包一层箭头函数:包装层就是 R5-D-1 的逃逸点)。
 */
export function createReporter({ write = line => console.log(line) } = {}) {
  const events = []
  const printed = []
  let failures = 0
  const emit = line => {
    printed.push(line)
    write(line)
  }
  return {
    /**
     * 判一条并把结论打出去;失败计数只在**判定为不通过**时递增。
     * @returns 该条是否通过(透传判据结论)。
     */
    report(id, observation) {
      const { name, ok, detail } = judge(id, observation)
      emit(`[${ok ? 'ok' : 'FAIL'}] ${name}${detail === undefined ? '' : ` — ${detail}`}`)
      events.push({ id, ok })
      if (!ok) failures += 1
      return ok
    },
    /** 已记录的失败条数(运行期脚本不再自己维护这个计数)。 */
    failures: () => failures,
    /** 逐条结论(自检/排障用)。 */
    events: () => [...events],
    /** 本通道真的打出去的结论行(自检沿**运行期同一条通道**核对"每条都打了")。 */
    lines: () => [...printed],
    /** 进程退出码:有失败即 1(与 `electron-shots.mjs` 的 EXIT_FAIL 同值)。 */
    exitCode: () => (failures > 0 ? 1 : 0),
  }
}

/**
 * **判定通道自证**:把 `assertions.mjs` 的全部夹具经**运行期真正在用的那条
 * `report()`** 求值,断言 `expect: true` 的夹具必须 ok、`expect: false` 的必须不 ok。
 *
 * 参数是**运行期通道本身**(`createReporter()` 的返回值解构出来的三个绑定)——
 * 这是 R5-D-1 的修法:此前自检在内部另建一个 reporter,于是
 * `electron-shots.mjs` 里那句可变的包装
 * (`const report = (id, obs) => reporter.report(id, obs)`)被改成
 * `({ detail:'MUTATED', ok:true })`(键序变形)、`() => true`(恒真)或 early-return
 * 之后,自检照样 11/11 —— 门禁钉的是"文本引用",不是"运行期真的走这条通道"。
 * 现在自检消费的就是运行期那份绑定:包装被换掉 ⇒ 夹具结论与 `expect` 不符 ⇒ 非零。
 *
 * 与 `assertions.mjs --self-test`(直接调 `evaluate`)的分工:那个证的是**判据本体**;
 * 这个证的是**运行期真正用的那条通道**。
 * @param channel - `{ report, failures, lines }`(必须来自 `createReporter()`);
 *   形状不合法**当场抛错** —— 缺参数时"自检通过"是假绿,不是宽容。
 * @returns `{ failures, total, passed, lines }`。
 */
export function runReporterSelfCheck(channel) {
  const { report, failures, lines } = channel ?? {}
  if (typeof report !== 'function' || typeof failures !== 'function' || typeof lines !== 'function') {
    throw new TypeError(
      'runReporterSelfCheck 必须收到运行期**同一条**判定通道({ report, failures, lines })'
      + ` —— 实得 ${JSON.stringify({ report: typeof report, failures: typeof failures, lines: typeof lines })}。`
      + '自检另建通道 = 证明的不是运行期那条(R5-D-1 的形态),因此这里 fail-loud。',
    )
  }
  const failures_list = []
  const linesBefore = lines().length
  for (const fixture of SELF_TEST_FIXTURES) {
    const before = failures()
    let returned
    try {
      // 沿**运行期绑定**求值:包装被掏空/恒真/键序变形都会在这里露出与 expect 不符。
      returned = report(fixture.id, fixture.observation)
    } catch (error) {
      failures_list.push(`${fixture.id}: report() 抛错(${error?.message ?? String(error)})—— ${fixture.why}`)
      continue
    }
    const counted = failures() > before
    if (counted === returned) {
      failures_list.push(
        `${fixture.id}: 判定结论(${returned})与失败计数(${counted ? '有' : '无'})不一致 —— `
        + '退出码会失真(结论说通过却记了失败,或反过来)',
      )
      continue
    }
    if (returned !== fixture.expect) {
      failures_list.push(
        `${fixture.id}: 经 report() 求值期望 ok=${fixture.expect},实得 ok=${String(returned)}(${fixture.why})`
        + ' ⇒ 判定通道没有透传判据结论(被掏成恒真/恒假/键序变形)',
      )
    }
  }
  const total = SELF_TEST_FIXTURES.length
  // 通道必须**逐条打出结论行**(运行期日志是排障面;不打日志也算"没判")。
  const emitted = lines().slice(linesBefore)
  if (emitted.length !== total) {
    failures_list.push(
      `判定通道只打了 ${emitted.length} 条结论行(期望 ${total} 条)—— report() 没有把每条判据的结论打出来`,
    )
  }
  for (const line of emitted) {
    if (!/^\[(?:ok|FAIL)\] /u.test(line)) {
      failures_list.push(`判定通道打出的结论行形状不对:${JSON.stringify(line)}`)
      break
    }
  }
  return { failures: failures_list, total, passed: total - failures_list.length, lines: emitted }
}
