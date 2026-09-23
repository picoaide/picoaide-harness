/** Loader hook：把 `node:fs` 换成"在第 N 次 **fd 写**之后往目标技能目录里塞一个用户文件"
 * 的垫片，用来**确定性**复现独立复审 r3 F1 的 TOCTOU 窗口：
 *
 *   `isIdenticalTree` 判定通过 → `writePluginProvenance` 写 `channel: 'plugin'`
 *
 * 复审用"384MiB 大文件把比较窗口拉宽 + 定时写入"的撞窗口方式复现（3/5 命中）。
 * 这里改成语义等价的**注入**：生产路径写正文一律走 `writeFileSync(fd, data)`
 * （`lib/sync/filesets.js` 的原子写原语），采纳分支的**唯一**一次 fd 写就是
 * `release.json` 的临时文件；垫片在这一次 fd 写**之后**立刻按真实 fs 创建
 * `TOCTOU_FILE`（模拟用户/编辑器/同步盘在这几百微秒里落下一个文件），因此
 * "写溯源之后、写后复检之前"这一步是**必然**发生而不是碰运气。
 *
 * 为什么按 fd 写而不是按路径写做判据：夹具自身的建目录/写文件全部走**路径**形式，
 * 只有被测代码的落盘走 fd 形式 —— 注入点因此精确落在采纳路径上，不受夹具设置影响。
 *
 * ⚠️ **per-name 锁的那次 fd 写要排除**（F3 修复之后，取锁也会按 fd 写锁内容
 * `{"pid":…,"at":…}`）：不排除的话 `TOCTOU_ON=1` 会落在"取锁"那一刻，注入变成
 * "判定之前就多了一个文件"（被前置判据拒掉），用例会**因错误的原因变绿**。这里按
 * **写入内容**识别锁（锁内容是锁属主 JSON，技能内容不是），与
 * `fs-write-fault-hook.mjs` 同一判据。
 *
 * 其余导出全部从真实 fs 转发（导出名由真实模块的键生成，避免硬编码清单在
 * 被测模块多 import 一个 node:fs 名字时过期 —— 与 `fs-write-fault-hook.mjs` 同因）。
 *
 * Env（**在注入发生的那一刻**读取，因此子进程可以在算出落点之后再设置它）：
 *   TOCTOU_FILE    - 要注入的用户文件绝对路径（不给则仅计数，不注入）。
 *   TOCTOU_BODY    - 注入文件的内容（缺省一行中文备注）。
 *   TOCTOU_ON      - 第几次**技能内容** fd 写之后注入（1-based，缺省 1）。
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const realFs = require('node:fs')

export async function resolve(specifier, context, next) {
  if (specifier === 'node:fs') {
    return { url: 'node-fs-toctou:shim', shortCircuit: true, format: 'module' }
  }
  return next(specifier, context)
}

export async function load(url, context, next) {
  if (url === 'node-fs-toctou:shim') {
    const names = Object.keys(realFs)
      .filter((n) => n !== 'default' && n !== 'writeFileSync' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n))
    const source = [
      "import { dirname as dirOf } from 'node:path'",
      'const real = globalThis.__realFs',
      'const injectOn = Number(process.env.TOCTOU_ON ?? 1)',
      'let fdWrites = 0',
      'let injected = false',
      'const isLockWrite = (data) => {',
      '  try {',
      '    const text = typeof data === "string" ? data : (Buffer.isBuffer(data) ? data.toString("utf8") : String(data))',
      '    const parsed = JSON.parse(text)',
      '    return parsed !== null && typeof parsed === "object" && Number.isInteger(parsed.pid) && Number.isInteger(parsed.at)',
      '  } catch { return false }',
      '}',
      'const inject = () => {',
      '  const target = process.env.TOCTOU_FILE ?? ""',
      '  if (injected || target === "") return',
      '  injected = true',
      "  const body = process.env.TOCTOU_BODY ?? '我的笔记（在采纳窗口里写的）\\n'",
      '  real.mkdirSync(dirOf(target), { recursive: true })',
      '  real.writeFileSync(target, body)',
      '}',
      ...names.map((n) => `export const ${n} = real[${JSON.stringify(n)}]`),
      'export function writeFileSync(file, data, options) {',
      '  const written = real.writeFileSync(file, data, options)',
      '  if (typeof file === "number" && !isLockWrite(data)) {',
      '    fdWrites += 1',
      '    if (fdWrites === injectOn) inject()',
      '  }',
      '  return written',
      '}',
      'export default real',
    ].join('\n')
    return { format: 'module', shortCircuit: true, source }
  }
  return next(url, context)
}
