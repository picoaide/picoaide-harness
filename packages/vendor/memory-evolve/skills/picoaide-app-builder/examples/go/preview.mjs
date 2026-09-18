#!/usr/bin/env node
// preview.mjs —— 用 Node 自带的 `node:wasi` 在本地把应用跑起来（零外部依赖）。
//
// 为什么要有它：平台的 ABI 是"stdin/stdout 上的帧 + 宿主用 JSON-RPC 应答"。在本地
// 没有宿主，所以这个脚本扮演宿主：它把请求帧喂给 wasm，按需应答 db.* / ai.chat /
// log / assets.read，然后把应用写出的最终响应信封打印出来。
//
// 用法（在 examples/go/ 目录下）：
//
//   GOOS=wasip1 GOARCH=wasm go build -o shared-notes.wasm .
//   node preview.mjs shared-notes.wasm
//   node preview.mjs shared-notes.wasm --path /api/notes --method POST --body 'body=hello'
//   node preview.mjs shared-notes.wasm --user not-in-list      # 看"无权限页"长什么样
//   node preview.mjs shared-notes.wasm --anonymous             # 看匿名分支（public 应用）
//
// 得到的不是"像线上一样"的预览（没有真实数据库、没有真实 AI），而是**协议层**的
// 端到端验证：帧读写、路由分支、白名单判定、失败分支的响应是否都成立。
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
    // auth.mode 取自应用的 access（三选一）；这里是假宿主，直接把它透给应用。
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

/** 假宿主：把宿主函数实现成内存版，让应用的分支都能走通。 */
class FakeHost {
  constructor(stdin, reader, config, args) {
    this.stdin = stdin
    this.reader = reader
    this.config = config
    this.args = args
    this.notes = []
    this.nextRowId = 1
    this.definedTables = new Set()
  }

  answer(frame) {
    const { id, method, params } = frame
    const ok = result => ({ jsonrpc: '2.0', id, result })
    const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })
    switch (method) {
      case 'db.define': {
        const created = !this.definedTables.has(params.table)
        this.definedTables.add(params.table)
        return ok({ created, table: params.table, columns: params.columns.map(c => c.name) })
      }
      case 'db.query': {
        const limit = Number(params.args?.[0] ?? 50)
        const rows = [...this.notes]
          .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
          .slice(0, limit)
          .map(n => [n.author, n.body, n.created_at])
        return ok({ columns: ['author', 'body', 'created_at'], rows, truncated: false })
      }
      case 'db.exec': {
        if (!/^INSERT INTO notes/i.test(params.sql)) {
          return fail('DB_DENIED', `preview 只实现了 notes 表的 INSERT，收到: ${params.sql}`)
        }
        const [author, body, created_at] = params.args ?? []
        this.notes.push({ rowId: this.nextRowId++, author, body, created_at })
        return ok({ rows_affected: 1 })
      }
      case 'ai.chat':
        // 真实平台会阻塞数秒并计费；预览里给一段固定文本，用来验证等待态与渲染。
        return ok({ content: '（本地预览）本周便签集中在两件事：发布流程梳理、值班表确认。', model: 'preview', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
      case 'log':
        console.error(`[app:${params.level ?? 'info'}] ${params.message}`)
        return ok({ accepted: 1 })
      case 'assets.read': {
        if (params.path !== 'picoaide.app.json') return fail('NOT_FOUND', `没有这个资源: ${params.path}`)
        const text = JSON.stringify(this.config)
        return ok({ content_type: 'application/json', size: Buffer.byteLength(text), text })
      }
      default:
        return fail('VALIDATION', `预览宿主没有实现 ${method}`)
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
