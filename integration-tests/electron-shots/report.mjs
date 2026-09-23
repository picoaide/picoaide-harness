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
 *   · `runReporterSelfCheck()` 把**全部夹具**经**同一条 `report()` 路径**求值:
 *     正例必须 ok、负例必须 !ok。恒真/恒假的 `report` 在这里必然产出与期望不同的结论
 *     —— 这正是 N7 的现场形态,而它是**可执行**的判据,不是源码扫描。
 *
 * 接线(有意的常量):运行期脚本必须 `import { createReporter } from './report.mjs'` 并用
 * 它逐条判;`scripts/check-integration-tests.mjs` 会跑
 * `node electron-shots.mjs --self-check`,并在**变异副本**上复跑同一命令要求它变红
 * (把 `report` 掏成恒真 ⇒ `--self-check` 非零)。
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
 * @returns `{ report, failures, events, exitCode }`。
 */
export function createReporter({ write = line => console.log(line) } = {}) {
  const events = []
  let failures = 0
  return {
    /**
     * 判一条并把结论打出去;失败计数只在**判定为不通过**时递增。
     * @returns 该条是否通过(透传判据结论)。
     */
    report(id, observation) {
      const { name, ok, detail } = judge(id, observation)
      write(`[${ok ? 'ok' : 'FAIL'}] ${name}${detail === undefined ? '' : ` — ${detail}`}`)
      events.push({ id, ok })
      if (!ok) failures += 1
      return ok
    },
    /** 已记录的失败条数(运行期脚本不再自己维护这个计数)。 */
    failures: () => failures,
    /** 逐条结论(自检/排障用)。 */
    events: () => [...events],
    /** 进程退出码:有失败即 1(与 `electron-shots.mjs` 的 EXIT_FAIL 同值)。 */
    exitCode: () => (failures > 0 ? 1 : 0),
  }
}

/**
 * **判定通道自证**:把 `assertions.mjs` 的全部夹具经 `report()` 求值,断言
 * `expect: true` 的夹具必须 ok、`expect: false` 的必须不 ok。
 *
 * 与 `assertions.mjs --self-test`(直接调 `evaluate`)的分工:那个证的是**判据本体**;
 * 这个证的是**运行期真正用的那条通道**。把 `report()` 内部掏成恒真/恒假,这里必然报出
 * 与 `expect` 不符的夹具(而 `assertions.mjs --self-test` 仍然是 29/29 —— 这正是 N7)。
 * @returns `{ failures, total, passed, lines }`。
 */
export function runReporterSelfCheck() {
  const failures = []
  const lines = []
  for (const fixture of SELF_TEST_FIXTURES) {
    const reporter = createReporter({ write: line => lines.push(line) })
    let returned
    try {
      // 每条夹具用一个**全新** reporter:失败计数与返回值必须互相印证。
      returned = reporter.report(fixture.id, fixture.observation)
    } catch (error) {
      failures.push(`${fixture.id}: report() 抛错(${error?.message ?? String(error)})—— ${fixture.why}`)
      continue
    }
    const counted = reporter.failures() > 0
    if (counted === returned) {
      failures.push(
        `${fixture.id}: 判定结论(${returned})与失败计数(${counted ? '有' : '无'})不一致 —— `
        + '退出码会失真(结论说通过却记了失败,或反过来)',
      )
      continue
    }
    if (returned !== fixture.expect) {
      failures.push(
        `${fixture.id}: 经 report() 求值期望 ok=${fixture.expect},实得 ok=${returned}(${fixture.why})`
        + ' ⇒ 判定通道没有透传判据结论(被掏成恒真/恒假)',
      )
    }
  }
  const total = SELF_TEST_FIXTURES.length
  // 通道必须**逐条打出结论行**(运行期日志是排障面;不打日志也算"没判")。
  if (lines.length !== total) {
    failures.push(`判定通道只打了 ${lines.length} 条结论行(期望 ${total} 条)—— report() 没有把每条判据的结论打出来`)
  }
  for (const line of lines) {
    if (!/^\[(?:ok|FAIL)\] /u.test(line)) {
      failures.push(`判定通道打出的结论行形状不对:${JSON.stringify(line)}`)
      break
    }
  }
  return { failures, total, passed: total - failures.length, lines }
}
