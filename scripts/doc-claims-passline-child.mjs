#!/usr/bin/env node
/**
 * **通过行探测的独立子入口**（第十四轮 V14-A 的 VA-02-F2 收口，lane M 落地）。
 *
 * ## 它是什么
 *
 * `scripts/check-doc-claims.mjs` 的第 ② 层判据要回答一个问题：**"真实运行会把哪一行打出去？"**
 * —— 断言必须钉在**打印路径**上，而不是钉在一个变量上（第十三轮 V13-C 的探针 `d6`：
 * 断言钉 `summaryLine`、`console.log` 换成写死的假自述 ⇒ 守卫 EXIT=0 且打印一句比判据面宽的
 * 结论）。这一层原来靠"把**自己**再跑一遍、只多一个开关"，而那个开关先后走过两条**外部输入面**：
 *
 *   · 环境变量 `CHECK_DOC_CLAIMS_VERDICT_PROBE`（第十三轮 R14-F：CI 下判据的判据判它自己非法）；
 *   · argv `--verdict-probe`（第二次修法）。**argv 同样是外部输入面**：
 *     `NODE_OPTIONS="--import=<载荷>"` 能在主模块求值前 `process.argv.push('--verdict-probe')`
 *     —— V14-A 实测：d6 变异下朴素跑 EXIT=1、伪造跑 EXIT=0（两种 CI 语境都是），
 *     而 `NODE_OPTIONS` 正是第二次修法声明"已废除"的那条通道。
 *
 * ## 它做什么（只有一条路径）
 *
 * 1. **import 主模块** —— 同一份判据的实现。判据本体（扫描 / 逐条断言 / 缩面判据 /
 *    通过行自证）在主模块求值时已经跑完，这里拿到的是它的**结果**：
 *    `summaryLine` / `failures` / `hits` / `moduleHits` / `surfaceProblems`；
 * 2. 与主入口**同样的退出码**：缩面问题 ⇒ 2（拒绝），漂移/扫描器问题 ⇒ 1（拒绝），
 *    干净 ⇒ 0 并把通过行打到 stdout。
 *
 * ## 它**不**接受任何开关
 *
 * 只透传 `--root <dir>`（判定哪一棵树，与主入口同义）；任何其它参数一律 `exit 2`。
 * 所以"从 env / argv 伪造探测"在这里没有可伪造的东西：
 *   · 主入口已经没有探测模式（`--verdict-probe` 是**未知参数** ⇒ exit 2）；
 *   · 本文件是独立的、**登记在 install 期执行体锚定里**的入口（逐字节 == HEAD），
 *     要伪造它的输出就得改仓内文件 —— 那条通道由 `check-install-integrity.mjs` 看着。
 *
 * ## 残余面（认账）
 *
 * 能在**进程内执行任意代码**的对手（同一个 `NODE_OPTIONS=--import` 载荷改全局标记、
 * patch `import.meta`、替换 `node:fs`）不在本判据的拦截面里 —— 那是"控制进程启动"的对手。
 * 本判据拦的是**纯数据通道**：env、argv、仓内文件。
 *
 * ## 用法与退出码
 *
 * 用法：`node scripts/doc-claims-passline-child.mjs [--root <dir>]`（父进程自己会用这条命令）
 * 退出码：0 = 干净（stdout 只有通过行）；1 = 有漂移/扫描器问题；2 = 参数不合法或扫描面缩水。
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const argv = process.argv.slice(2)
let root = resolve(process.cwd())
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === '--root') {
    const value = argv[index + 1]
    if (value === undefined) {
      console.error('doc-claims-passline-child: --root 需要一个目录')
      process.exit(2)
    }
    root = resolve(value)
    index += 1
    continue
  }
  // **不接受任何开关**：这个入口的语义只有一条（跑同一份判据并打印通过行）。
  // 任何多余参数都可能是"想让它少判一步"的尝试 ⇒ fail-closed。
  console.error(`doc-claims-passline-child: 未知参数 ${argv[index]} —— 本入口不接受任何开关`
    + '（只允许 `--root <dir>`；通过行探测不是一个可以打开/关掉的模式）。')
  process.exit(2)
}

const childUrl = new URL('./check-doc-claims.mjs', import.meta.url)
if (!existsSync(childUrl)) {
  console.error('doc-claims-passline-child: 找不到同一目录下的 check-doc-claims.mjs ——'
    + ' 本入口与判据实现必须在同一个检出里成对存在（缺一则探测本身失去意义）。')
  process.exit(2)
}

// 旧 Node（没有 `import.meta.main`）上，主模块靠这个**进程内**标记区分"被 import"与"被当入口执行"。
// 它在 import 之前设置 ⇒ 环境变量 / 命令行都塞不进来（那是纯数据通道，改不了进程内 Symbol）。
globalThis[Symbol.for('picoaide.check-doc-claims.passline-child')] = true

const { failures, hits, moduleHits, surfaceProblems, summaryLine } = await import(childUrl.href)

if (surfaceProblems.length > 0) {
  for (const message of surfaceProblems) console.error(`  [SURFACE] ${message}`)
  console.error(`doc-claims-passline-child: 扫描面缩水/前置缺失 ${surfaceProblems.length} 处 ——`
    + ' 拒绝把"没扫到"当"一致"（与主入口同一个退出码）。')
  process.exit(2)
}
if (hits.length > 0 || moduleHits.length > 0 || failures.length > 0) {
  for (const message of failures) console.error(`  [SCAN] ${message}`)
  console.error(`doc-claims-passline-child: 文档数字漂移 ${hits.length + moduleHits.length} 处 /`
    + ` 扫描器问题 ${failures.length} 处 —— 拒绝打印通过行（与主入口同一个退出码）。`)
  process.exit(1)
}

// 干净：把**同一份判据算出来的**通过行打出去（父进程随后把这段字节抓回去反解断言）。
process.stdout.write(`${summaryLine}\n`)
