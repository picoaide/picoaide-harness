#!/usr/bin/env node
// preview.mjs —— 用 Node 自带的 `node:wasi` 在本地把应用跑起来（零外部依赖）。
//
// 为什么要有它：平台的 ABI 是"stdin/stdout 上的帧 + 宿主用 JSON-RPC 应答"。在本地
// 没有宿主，所以这个脚本扮演宿主：它把请求帧喂给 wasm，按需应答 db.* / log /
// assets.read，然后把应用写出的最终响应信封打印出来。
//
// 用法（在 examples/go/ 目录下）：
//
//   GOOS=wasip1 GOARCH=wasm go build -o shared-notes.wasm .
//   node preview.mjs shared-notes.wasm
//   node preview.mjs shared-notes.wasm --path /api/notes --method POST --body 'body=hello'
//   node preview.mjs shared-notes.wasm --user not-in-list      # 看"无权限页"长什么样
//   node preview.mjs shared-notes.wasm --anonymous             # 模拟历史 public 应用（user=null）
//
// 得到的不是"像线上一样"的预览（没有真实数据库，**wasm 侧也没有 AI 能力**：应用里的 AI
// 走应用前端的前端桥 `POST /__picoaide/ai/chat`，由客户端本地处理），而是**协议层**的
// 端到端验证：帧读写、路由分支、白名单判定、失败分支的响应是否都成立。
//
// 注：平台一律要求登录（没有匿名面），`--anonymous` 只用来回归**历史** public 应用；
// 应用本身在客户端里是 `<渠道 app 源 scheme>://<app_id>` 的一个 origin（scheme 随渠道配置），cookie 不可用
// （`document.cookie` 恒为空、`Set-Cookie` 不落盘）—— 状态放应用库。
//
// ⚠️ 只在 Linux/macOS 验证过（父子进程用管道相连）。Windows 上如果报 WASI 相关错误，
// 直接在平台上 validate（预检不占版本号）也一样能发现协议层问题。
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FRAME_MAGIC = 0x1e

/** 子进程：用 node:wasi 执行应用的 _start（fd 0/1/2 即与父进程相连的管道）。 */
async function runWasmInChild() {
  const { WASI } = await import('node:wasi')
  const wasmPath = process.argv[2]
  const wasi = new WASI({ version: 'preview1', args: [], env: {}, returnOnExit: true })
  const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {
    wasi_snapshot_preview1: wasi.wasiImport,
  })
  const code = wasi.start(instance)
  process.exitCode = typeof code === 'number' ? code : 0
}

/** 父进程：假宿主。发一个请求帧，应答应用的宿主调用，最后打印响应信封。 */
async function runFakeHost() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.wasm) {
    console.error('用法: node preview.mjs <app.wasm> [--path /] [--method GET] [--body ...] [--user zhangwei] [--anonymous]')
    process.exit(2)
  }
  const wasmPath = resolve(args.wasm)
  const config = JSON.parse(readFileSync(join(HERE, 'picoaide.app.json'), 'utf8'))

  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), wasmPath], {
    env: { ...process.env, PICOAIDE_PREVIEW_CHILD: '1' },
    stdio: ['pipe', 'pipe', 'inherit'],
  })

  const reader = new FrameReader(child.stdout)
  const host = new FakeHost(child.stdin, reader, config, args)

  // ① 宿主 → 应用：请求帧
  const request = {
    abi: 'picoaide-app/1',
    app_id: 'shared-notes',
    version: '1.0.0',
    // auth.mode 取自应用的 access（写侧只有 login / whitelist；历史 public 读取侧按
    // login 处理）。这里是假宿主：`--anonymous` 用来模拟历史 public 应用（user=null）。
    auth: { mode: config.access || 'login', verified: !args.anonymous },
    user: args.anonymous
      ? null
      : { id: 10231, username: args.user, display_name: args.user === 'zhangwei' ? '张伟' : args.user, dept: '研发部', is_publisher: true },
    method: args.method,
    path: args.path,
    query: {},
    headers: {},
    body: args.body,
  }
  writeFrame(child.stdin, JSON.stringify(request))

  // ② 循环：应用每写一帧，要么是宿主调用（应答它），要么是最终响应（结束）。
  for (;;) {
    let payload
    try {
      payload = await reader.readFrame()
    } catch (error) {
      console.error(`[preview] 读帧失败: ${error.message}`)
      break
    }
    if (payload === null) break
    const frame = JSON.parse(payload)
    if (typeof frame.status === 'number' && !('jsonrpc' in frame)) {
      reportResponse(frame)
      break
    }
    if (!('jsonrpc' in frame)) {
      console.error(`[preview] 无法判别的帧: ${payload.slice(0, 200)}`)
      break
    }
    writeFrame(child.stdin, JSON.stringify(host.answer(frame)))
  }

  child.stdin.end()
  await new Promise(resolvePromise => child.on('close', resolvePromise))
}

/**
 * 解析预览宿主支持的 **SELECT 最小形态**：
 *   `SELECT <列…> FROM <表> [ORDER BY created_at DESC] [LIMIT ?]`
 *
 * 为什么刻意窄：预览宿主不是数据库，它的职责是让示例的**分支**都能走通。认不出来的
 * SQL 一律返回 `null` ⇒ 调用方 fail-loud（`DB_DENIED` + 原 SQL），**绝不猜、也绝不
 * 静默返回空集** —— 后者会让"查询写错了"看起来像"表里没数据"。
 */
function parseSelect(sql) {
  const m = /^\s*SELECT\s+(.+?)\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)\s*(.*?)\s*;?\s*$/is.exec(sql)
  if (m === null) return null
  const columns = m[1].split(',').map(s => s.trim())
  if (columns.length === 0) return null
  if (columns.some(c => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(c))) return null
  return {
    columns,
    table: m[2],
    orderByCreatedAtDesc: /ORDER\s+BY\s+created_at\s+DESC/is.test(m[3]),
  }
}

/**
 * 解析预览宿主支持的 **INSERT 最小形态**：
 *   `INSERT INTO <表> (<列…>) VALUES (?, …)`
 * 参数按**位置**对应列（与平台的参数化语义一致）；占位符只认 `?`。
 */
function parseInsert(sql) {
  const m = /^\s*INSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)\s*;?\s*$/is.exec(sql)
  if (m === null) return null
  const columns = m[2].split(',').map(s => s.trim())
  if (columns.length === 0) return null
  if (columns.some(c => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(c))) return null
  const placeholders = m[3].split(',').map(s => s.trim())
  if (placeholders.length !== columns.length) return null
  if (placeholders.some(p => p !== '?')) return null
  return { table: m[1], columns }
}

/** 假宿主：把宿主函数实现成内存版，让应用的分支都能走通。 */
class FakeHost {
  constructor(stdin, reader, config, args) {
    this.stdin = stdin
    this.reader = reader
    this.config = config
    this.args = args
    // 内存表：表名 → { columns, rows }。
    //
    // **按 SQL 里的表名分派，不再把任何查询都当 notes**（2026-09-20 修）。此前
    // `db.exec` 只认 `INSERT INTO notes` ⇒ 作者照抄这个示例、用例里的第二张表
    // （`summaries`，AI 总结落库）一写就在预览里 `DB_DENIED`；而 `db.query` 更是
    // **任何** SQL 都回便签行（示例的 `main.go` 里专门写了一段防御来识别这种"问 A 答 B"）。
    // 现在按 `db.define` 登记的表各自存行，示例与作者自己的表都能跑通。
    this.tables = new Map()
    this.nextRowId = 1
  }

  answer(frame) {
    const { id, method, params } = frame
    const ok = result => ({ jsonrpc: '2.0', id, result })
    const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })
    switch (method) {
      case 'db.define': {
        const columns = params.columns.map(c => c.name)
        const created = !this.tables.has(params.table)
        if (created) this.tables.set(params.table, { columns, rows: [] })
        return ok({ created, table: params.table, columns })
      }
      case 'db.query': {
        const sql = String(params.sql ?? '')
        const parsed = parseSelect(sql)
        if (parsed === null) {
          return fail('DB_DENIED', `preview 只支持 "SELECT <列…> FROM <表> [ORDER BY created_at DESC] [LIMIT ?]"，收到: ${sql}`)
        }
        const limit = Number(params.args?.[0] ?? 50)
        const rows = [...(this.tables.get(parsed.table)?.rows ?? [])]
        if (parsed.orderByCreatedAtDesc) {
          rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        }
        return ok({
          columns: parsed.columns,
          rows: rows.slice(0, limit).map(row => parsed.columns.map(c => (c in row ? row[c] : null))),
          truncated: false,
        })
      }
      case 'db.exec': {
        const sql = String(params.sql ?? '')
        const parsed = parseInsert(sql)
        if (parsed === null) {
          return fail('DB_DENIED', `preview 只支持 "INSERT INTO <表> (<列…>) VALUES (?, …)"，收到: ${sql}`)
        }
        const values = params.args ?? []
        if (values.length !== parsed.columns.length) {
          return fail('DB_DENIED', `参数个数(${values.length})与列数(${parsed.columns.length})不符: ${sql}`)
        }
        const table = this.tables.get(parsed.table) ?? { columns: parsed.columns, rows: [] }
        this.tables.set(parsed.table, table)
        const row = {}
        parsed.columns.forEach((column, index) => { row[column] = values[index] })
        // 平台自动维护行号列（应用看不到）；预览里也留一份，与线上语义对齐。
        row.rowId = this.nextRowId++
        table.rows.push(row)
        return ok({ rows_affected: 1 })
      }
      case 'log':
        console.error(`[app:${params.level ?? 'info'}] ${params.message}`)
        return ok({ accepted: 1 })
      case 'assets.read': {
        if (params.path !== 'picoaide.app.json') return fail('NOT_FOUND', `没有这个资源: ${params.path}`)
        const text = JSON.stringify(this.config)
        return ok({ content_type: 'application/json', size: Buffer.byteLength(text), text })
      }
      default:
        // 平台的宿主能力是封闭清单：平台没有的能力（例如 wasm 侧的 AI 调用）也走这里。
        // 应用里的 AI 走应用前端的前端桥 `POST /__picoaide/ai/chat`（客户端本地处理），
        // 不在 wasm 里，因此预览宿主也没有它。
        return fail('HOST_METHOD_UNKNOWN', `宿主没有 ${method} 这个方法（宿主的可用能力是封闭清单）`)
    }
  }
}

/** 按 ABI 读帧：RS + 十进制长度 + '\n' + JSON。 */
class FrameReader {
  constructor(stream) {
    this.buf = Buffer.alloc(0)
    this.stream = stream
    this.waiters = []
    this.ended = false
    stream.on('data', chunk => {
      this.buf = Buffer.concat([this.buf, chunk])
      this.pump()
    })
    stream.on('end', () => {
      this.ended = true
      this.pump()
    })
  }

  pump() {
    while (this.waiters.length > 0) {
      const frame = this.tryTake()
      if (frame === undefined) return
      this.waiters.shift()(frame)
    }
  }

  tryTake() {
    if (this.buf.length === 0) return this.ended ? null : undefined
    if (this.buf[0] !== FRAME_MAGIC) {
      // 非 RS 起始 = 应用写到了 stdout 上的日志（平台会丢弃它，预览里提示出来）。
      const nl = this.buf.indexOf(0x0a)
      const line = this.buf.subarray(0, nl < 0 ? this.buf.length : nl).toString('utf8')
      console.error(`[preview] 非帧输出（应用不应该写 stdout）: ${line}`)
      this.buf = nl < 0 ? Buffer.alloc(0) : this.buf.subarray(nl + 1)
      return this.tryTake()
    }
    const nl = this.buf.indexOf(0x0a, 1)
    if (nl < 0) return undefined
    const length = Number(this.buf.subarray(1, nl).toString('ascii'))
    if (!Number.isInteger(length) || length < 0) throw new Error('非法的帧长度前缀')
    if (this.buf.length < nl + 1 + length) return undefined
    const payload = this.buf.subarray(nl + 1, nl + 1 + length).toString('utf8')
    this.buf = this.buf.subarray(nl + 1 + length)
    return payload
  }

  readFrame() {
    const frame = this.tryTake()
    if (frame !== undefined) return Promise.resolve(frame)
    return new Promise(resolve => this.waiters.push(resolve))
  }
}

function writeFrame(stream, payload) {
  stream.write(Buffer.concat([Buffer.from([FRAME_MAGIC]), Buffer.from(String(Buffer.byteLength(payload)), 'ascii'), Buffer.from('\n'), Buffer.from(payload, 'utf8')]))
}

function reportResponse(frame) {
  console.log(`HTTP ${frame.status}`)
  for (const [key, value] of Object.entries(frame.headers ?? {})) console.log(`${key}: ${value}`)
  console.log('')
  console.log(frame.body)
}

function parseArgs(argv) {
  const out = { method: 'GET', path: '/', body: '', user: 'zhangwei', anonymous: false, wasm: '' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--path') out.path = argv[++i]
    else if (arg === '--method') out.method = (argv[++i] ?? 'GET').toUpperCase()
    else if (arg === '--body') out.body = argv[++i] ?? ''
    else if (arg === '--user') out.user = argv[++i]
    else if (arg === '--anonymous') out.anonymous = true
    else if (!arg.startsWith('--')) out.wasm = arg
  }
  return out
}

// ===== 入口（放在最后：class 声明不提升，顶层 dispatch 必须等它们求值完）=====

if (process.env.PICOAIDE_PREVIEW_CHILD === '1') {
  await runWasmInChild()
} else {
  await runFakeHost()
}
