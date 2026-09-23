/**
 * WASM 协议探针的**证据行**协议（2026-09-23 第五轮审计 R4-A N2 的修复之一）。
 *
 * 现场（R5-D 报告 §N2 / VERIFY.md §7-N2）：门禁的组级不变量是**计数**不变量
 * （"该组 PASS ≥ 1"），于是两种绕过都成立：
 *   · 早退分支把 `skip` 写成 `pass`（跳过却打印 PASS）⇒ `group 6 pass=1 skip=0` + EXIT=0；
 *   · 把探针换成 `exit 0` 桩并打印**伪造的** VERDICT 行 ⇒ 4 PASS / EXIT=0。
 *
 * 处置：真探针必须产出**结构化、带本次运行 nonce 的证据行**，门禁按"被发现的探针集合
 * == 有证据的探针集合"做**集合**判定（不再是 PASS 计数），并用自证样本把
 * "`exit 0` 桩"与"跳过却打 PASS"两种形态钉死。
 *
 * 用法（探针在设置退出码**之前**调用，且在**所有**退出路径上都要调用）：
 * ```js
 * const { attest } = require('./probe-attest.cjs')
 * attest({ probe: __filename, pass, fail, skip, platformCovered: PROBE_COVERED })
 * app.exit(code)
 * ```
 * 输出（恰好一行，门禁按 `^PROBE-ATTEST ` 前缀解析）：
 * `PROBE-ATTEST probe=<basename> assertions=<n> pass=<n> fail=<n> skip=<n> platformCovered=<0|1> nonce=<nonce>`
 *
 * 三条纪律：
 *   1. **只打一行**：重复行会让门禁判"证据协议坏了"（不是"取第一条就算过"）；
 *   2. `assertions = pass + fail + skip` 必须自洽（门禁会复算）；
 *   3. nonce 取自环境变量 `PROBE_ATTEST_NONCE`（门禁每次运行随机生成）——
 *      写死的伪造行在**非本次运行**的 nonce 上必然对不上。
 *
 * 这个文件是 CommonJS（探针是 `.cjs`，用 `require`），且**不依赖任何 Electron API**：
 * 门禁的自证样本用纯 Node 直接驱动同一套协议。
 */

/** 取门禁本次运行的 nonce（缺省为空串：门禁没给 nonce 时证据必然判不通过）。 */
function attestNonce() {
  const value = process.env.PROBE_ATTEST_NONCE
  return typeof value === 'string' ? value : ''
}

/**
 * 打印一条结构化证据行。
 * @param {object} facts - `{ probe, pass, fail, skip, platformCovered }`；
 *   `probe` 可以是 `__filename` / 探针文件名 / 逻辑 id（门禁按 basename 比对）。
 * @returns {string} 打出来的那一行（便于测试）。
 */
function attest(facts) {
  const probe = String(facts?.probe ?? '').split(/[\\/]/u).pop() || 'unknown-probe'
  const pass = Number(facts?.pass ?? 0) | 0
  const fail = Number(facts?.fail ?? 0) | 0
  const skip = Number(facts?.skip ?? 0) | 0
  const assertions = Number.isFinite(facts?.assertions) ? Number(facts.assertions) | 0 : pass + fail + skip
  const covered = facts?.platformCovered === false || facts?.platformCovered === 0 ? 0 : 1
  const line = `PROBE-ATTEST probe=${probe} assertions=${assertions} pass=${pass} fail=${fail}`
    + ` skip=${skip} platformCovered=${covered} nonce=${attestNonce()}`
  console.log(line)
  return line
}

module.exports = { attest, attestNonce }
