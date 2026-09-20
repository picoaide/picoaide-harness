#!/usr/bin/env node
// preview.mjs —— 用 Node 自带的 `node:wasi` 在本地把应用跑起来（零外部依赖）。
//
// 为什么要有它：平台的 ABI 是"stdin/stdout 上的帧 + 宿主用 JSON-RPC 应答"。在本地
// 没有宿主，所以这个脚本扮演宿主：它把请求帧喂给 wasm，按需应答 db.* / log /
// assets.read，**并按宿主规则直出包内静态资源**（见下），最后把应用写出的响应信封打印出来。
//
// 用法（在 examples/go/ 目录下；**先用 pack-assets.mjs 打包**，否则包内没有资源）：
//
//   GOOS=wasip1 GOARCH=wasm go build -o shared-notes.wasm .
//   node ../../scripts/pack-assets.mjs --in shared-notes.wasm --out dist/shared-notes-packed.wasm \
//     web/index.html=index.html web/app.css=static/app.css web/app.js=static/app.js
//   node preview.mjs dist/shared-notes-packed.wasm                          # 入口页（走 wasm）
//   node preview.mjs dist/shared-notes-packed.wasm --path /static/app.js    # 宿主直出（不跑 wasm）
//   node preview.mjs dist/shared-notes-packed.wasm --path /api/notes
//   node preview.mjs dist/shared-notes-packed.wasm --path /api/notes --method POST \
//     --body '{"body":"hello"}'
//   node preview.mjs dist/shared-notes-packed.wasm --user not-in-list       # 看无权限页
//   node preview.mjs dist/shared-notes-packed.wasm --anonymous             # 模拟历史 public 应用
//
// 得到的不是"像线上一样"的预览（没有真实数据库，**每次调用都是一个全新的内存库**，
// 数据不跨调用保留；**wasm 侧也没有任何 AI 能力**：应用里的 AI 走页面里的客户端 AI loop
// `POST /__picoaide/ai/chat`，由客户端本地处理），而是**协议层**的端到端验证：
// 帧读写、路由分支、名单判定、静态资源直出、失败分支是否都成立。
//
// 直出规则（与平台同源，见 references/abi.md §3.7）：
//   · 只服务 GET/HEAD；`/api` 与 `/api/*` 一律交给 wasm；
//   · **入口文档**（`/`、`/index.html`、`<目录>/`）一律交给 wasm（名单判定在应用手里）；
//   · 其余路径：包内真有这个资源才直出，否则交给 wasm。
//
// 注：平台一律要求登录（没有匿名面）—— `--anonymous` 只用来回归**历史** public 应用；
// 应用在客户端里是 `<渠道 app 源 scheme>://<app_id>` 的一个 origin（scheme 随渠道配置），
// cookie 不可用（`document.cookie` 恒为空、`Set-Cookie` 不落盘）—— 状态放应用库。
//
// ⚠️ 只在 Linux/macOS 验证过（父子进程用管道相连）。Windows 上如果报 WASI 相关错误，
// 直接在平台上 validate（预检不占版本号）也一样能发现协议层问题。
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FRAME_MAGIC = 0x1e

/** 平台保留资源：由平台在发布期写入，包内不允许有同名段。 */
const RESERVED_ASSET_NAME = 'picoaide.app.json'
/** 工具链元数据段名：平台按元数据分流，不会当成资源（与 pack-assets.mjs 同源）。 */
const TOOLCHAIN_SECTION_NAMES = new Set([
  'name', 'producers', 'target_features', 'dylink', 'dylink.0', 'linking',
  'sourceMappingURL', 'external_debug_info',
])
/** 宿主保留命名空间（与宿主 isReservedHostPath 同口径）。 */
const RESERVED_HOST_PREFIX = '/__picoaide'

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

/** 读 LEB128 无符号整数（与 pack-assets.mjs / 平台 wasmmod 同读法）。 */
function readU32(buf, offset) {
  let result = 0
  let shift = 0
  let at = offset
  for (;;) {
    if (at >= buf.length) throw new Error('LEB128 越界')
    const byte = buf[at++]
    result |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) break
    shift += 7
    if (shift > 35) throw new Error('LEB128 过长')
  }
  return { value: result >>> 0, offset: at }
}

/**
 * 解析 wasm 自定义段，得到「包内逻辑路径 → 内容」。
 *
 * 这是**本地复刻**宿主发布期的抽取结果：段名就是包内逻辑路径，保留资源与工具链元数据
 * 段不算资源（与 pack-assets.mjs 的规则同源）。解析失败一律抛错 —— 预览不该在
 * "包是坏的"情况下假装跑通。
 * @param {Buffer} raw wasm 字节
 * @returns {Map<string, Buffer>}
 */
function parseAssets(raw) {
  if (raw.length < 8 || raw.readUInt32LE(0) !== 0x6d736100) throw new Error('不是 wasm 模块（魔数不符）')
  const assets = new Map()
  let at = 8
  while (at < raw.length) {
    const id = raw[at++]
    const size = readU32(raw, at)
    at = size.offset
    const end = at + size.value
    if (end > raw.length) throw new Error('段长度越界（模块被截断？）')
    if (id === 0) {
      const nameLen = readU32(raw, at)
      const nameStart = nameLen.offset
      const nameEnd = nameStart + nameLen.value
      const name = raw.subarray(nameStart, nameEnd).toString('utf8')
      const payload = raw.subarray(nameEnd, end)
      if (name !== RESERVED_ASSET_NAME && !TOOLCHAIN_SECTION_NAMES.has(name) && name !== '') {
        assets.set(name, payload)
      }
    }
    at = end
  }
  return assets
}

/** 路径归一化（去掉查询串与多余斜杠）。 */
function pathnameOf(url) {
  const cut = url.indexOf('?')
  const path = cut < 0 ? url : url.slice(0, cut)
  const withSlash = path.startsWith('/') ? path : `/${path}`
  return withSlash.length > 1 && withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash
}

/** 入口文档判定（与平台 serveStatic 规则 5 同口径）。 */
function isEntryPath(path) {
  if (path === '/' || path === '/index.html') return true
  return false
}

/** 这个请求该不该由宿主直出（返回包内逻辑路径或 null）。 */
function directAssetPath(method, path) {
  if (method !== 'GET' && method !== 'HEAD') return null
  if (path === RESERVED_HOST_PREFIX || path.startsWith(`${RESERVED_HOST_PREFIX}/`)) return null
  if (isEntryPath(path)) return null
  const logical = path.replace(/^\//, '')
  return logical === '' ? null : logical
}

/** 父进程：假宿主。发一个请求帧，应答应用的宿主调用，最后打印响应信封。 */
async function runFakeHost() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.wasm) {
    console.error('用法: node preview.mjs <app.wasm> [--path /] [--method GET] [--body ...] [--user zhangwei] [--anonymous] [--config <picoaide.app.json>]')
    process.exit(2)
  }
  const wasmPath = resolve(args.wasm)
  // 配置来源：**保留资源由平台在发布期写进版本资源目录**，本地预览就用一份磁盘上的
  // 同名文件顶替。缺省读本目录示例的那一份；`--config` 可以让别的应用预览自己的配置
  // （否则演示应用会拿着示例的 access/whitelist 跑，名单场景根本演示不出来）。
  const configPath = args.config ? resolve(args.config) : join(HERE, 'picoaide.app.json')
  let config
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    console.error(`[preview] 读应用配置失败（${configPath}）: ${error.message}`)
    process.exit(1)
  }

  // 包内资源：从**已打包**的 wasm 里读（段名 = 逻辑路径）。
  let assets
  try {
    assets = parseAssets(readFileSync(wasmPath))
  } catch (error) {
    console.error(`[preview] 解析包内资源失败: ${error.message}`)
    process.exit(1)
  }
  if (assets.size === 0) {
    console.error('[preview] 这个 wasm 里没有任何随包资源 —— 先用 scripts/pack-assets.mjs 打包，' +
      '例如：\n  node ../../scripts/pack-assets.mjs --in shared-notes.wasm --out dist/shared-notes-packed.wasm \\\n' +
      '    web/index.html=index.html web/app.css=static/app.css web/app.js=static/app.js')
    process.exit(2)
  }

  const path = pathnameOf(args.path)

  // ① 宿主直出：命中就**根本不执行 wasm**（与线上一致，也让"资源有没有打进去"立刻可见）。
  const direct = directAssetPath(args.method, path)
  if (direct !== null && assets.has(direct)) {
    const body = assets.get(direct)
    console.error(`[preview] 宿主直出静态资源（不经过 wasm）: ${path} → 包内 ${direct}（${body.length} 字节）`)
    console.log('HTTP 200')
    console.log(`Content-Type: ${contentTypeOf(direct)}`)
    console.log(`Content-Length: ${body.length}`)
    console.log('')
    console.log(body.toString('utf8'))
    return
  }
  if (direct !== null && !assets.has(direct)) {
    console.error(`[preview] 包内没有 ${direct}：这个请求会交给 wasm（应用自己的兜底/404 分支）`)
  }

  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), wasmPath], {
    env: { ...process.env, PICOAIDE_PREVIEW_CHILD: '1' },
    stdio: ['pipe', 'pipe', 'inherit'],
  })

  const reader = new FrameReader(child.stdout)
  const host = new FakeHost(child.stdin, reader, config, args, assets)

  // ② 宿主 → 应用：请求帧
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
    path,
    query: {},
    headers: {},
    body: args.body,
  }
  writeFrame(child.stdin, JSON.stringify(request))

  // ③ 循环：应用每写一帧，要么是宿主调用（应答它），要么是最终响应（结束）。
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

/** 按扩展名给 Content-Type（与平台响应头枚举同族）。 */
function contentTypeOf(logical) {
  const lower = logical.toLowerCase()
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html; charset=utf-8'
  if (lower.endsWith('.css')) return 'text/css; charset=utf-8'
  if (lower.endsWith('.js') || lower.endsWith('.mjs')) return 'text/javascript; charset=utf-8'
  if (lower.endsWith('.json')) return 'application/json; charset=utf-8'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  if (lower.endsWith('.png')) return 'image/png'
  return 'text/plain; charset=utf-8'
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

/**
 * 认 UPDATE 的三种常见形状（演示应用与示例都只用这几种）：
 *   `UPDATE t SET c = ? WHERE k = ?`
 *   `UPDATE t SET c = c + ? WHERE k = ?`（计数递增）
 *   `UPDATE t SET a = ?, b = ? WHERE k = ?`
 * 认不出来就**如实拒绝**（返回 null），不猜 —— 猜错会让作者在预览里得到与平台不同的结果。
 * @param sql - 语句原文。
 * @returns { table, assigns: [{column, delta?, value?}], where: {column} } 或 null。
 */
function parseUpdate(sql) {
  const m = /^\s*UPDATE\s+([A-Za-z_][A-Za-z0-9_]*)\s+SET\s+(.+?)\s+WHERE\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\?\s*;?\s*$/is.exec(sql)
  if (m === null) return null
  const assigns = []
  for (const part of m[2].split(',')) {
    const text = part.trim()
    let mm = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\?$/.exec(text)
    if (mm !== null) { assigns.push({ column: mm[1], value: true }); continue }
    // 计数递增：`c = c + ?` / `c = c + 1`（平台**允许**字面量 —— 它只查语句种类与保留列，
    // 不查参数化；演示应用两种写法都有，预览必须都认）。
    mm = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\1\s*([+-])\s*(\?|\d+)$/.exec(text)
    if (mm !== null) {
      assigns.push(mm[3] === '?' ? { column: mm[1], delta: mm[2] } : { column: mm[1], step: (mm[2] === '-' ? -1 : 1) * Number(mm[3]) })
      continue
    }
    return null
  }
  if (assigns.length === 0) return null
  return { table: m[1], assigns, where: m[3] }
}

/** 假宿主：把宿主函数实现成内存版，让应用的分支都能走通。 */
class FakeHost {
  constructor(stdin, reader, config, args, assets) {
    this.stdin = stdin
    this.reader = reader
    this.config = config
    this.args = args
    /** 包内资源（从打包后的 wasm 里解析出来的自定义段）。 */
    this.assets = assets
    // 内存表：表名 → { columns, rows }。按 SQL 里的表名分派（不把任何查询都当同一张表）。
    this.tables = new Map()
    this.nextRowId = 1
    // 事务：平台侧是"一次请求一个事务"，事务内只允许 db.query / db.exec 与两个出口。
    // 预览里用**整表快照**实现：begin 存一份，rollback 换回去，commit 丢掉快照。
    // 有它才能验"回滚真的没落库"这条最有教学价值的路径（技能里专门讲了它）。
    this.txId = 0
    this.txSnapshot = null
  }

  answer(frame) {
    const { id, method, params } = frame
    const ok = result => ({ jsonrpc: '2.0', id, result })
    const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })
    switch (method) {
      case 'tx_begin':
        this.txId += 1
        this.txSnapshot = new Map([...this.tables].map(([name, table]) => [
          name,
          { columns: [...table.columns], rows: table.rows.map(row => ({ ...row })) },
        ]))
        return ok({ tx_id: this.txId })
      case 'tx_commit':
        if (this.txSnapshot === null) return fail('DB_DENIED', '没有进行中的事务')
        this.txSnapshot = null
        return ok({ committed: true })
      case 'tx_rollback':
        if (this.txSnapshot === null) return fail('DB_DENIED', '没有进行中的事务')
        this.tables = this.txSnapshot
        this.txSnapshot = null
        return ok({ committed: false })
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
        // ① UPDATE：赋值与计数递增两种形状（版块计数、回帖计数、置顶都靠它）。
        const upd = parseUpdate(sql)
        if (upd !== null) {
          const table = this.tables.get(upd.table)
          if (table === undefined) return ok({ rows_affected: 0 })
          const args = params.args ?? []
          if (table.columns.indexOf(upd.where) === -1) {
            return fail('DB_DENIED', `未知的 WHERE 列 ${upd.where}`)
          }
          let affected = 0
          for (const row of table.rows) {
            if (row[upd.where] !== args[args.length - 1]) continue
            let cursor = 0
            for (const assign of upd.assigns) {
              const base = Number(row[assign.column] ?? 0)
              if (assign.value === true) {
                row[assign.column] = args[cursor++]
              } else if (assign.step !== undefined) {
                row[assign.column] = base + assign.step
              } else {
                row[assign.column] = base + (assign.delta === '-' ? -1 : 1) * Number(args[cursor++])
              }
            }
            affected += 1
          }
          return ok({ rows_affected: affected })
        }
        // ② INSERT。
        const parsed = parseInsert(sql)
        if (parsed === null) {
          return fail('DB_DENIED', `preview 只支持 "INSERT INTO <表> (<列…>) VALUES (?, …)" 与简单 UPDATE，收到: ${sql}`)
        }
        const values = params.args ?? []
        if (values.length !== parsed.columns.length) {
          return fail('DB_DENIED', `参数个数(${values.length})与列数(${parsed.columns.length})不符: ${sql}`)
        }
        const table = this.tables.get(parsed.table) ?? { columns: parsed.columns, rows: [] }
        this.tables.set(parsed.table, table)
        const row = {}
        parsed.columns.forEach((column, index) => { row[column] = values[index] })
        // 平台自动维护保留列 `_row_id`（应用看不到、也不能提到）；预览里留一份对齐语义。
        row._row_id = this.nextRowId++
        table.rows.push(row)
        return ok({ rows_affected: 1 })
      }
      case 'log':
        console.error(`[app:${params.level ?? 'info'}] ${params.message}`)
        return ok({ accepted: 1 })
      case 'assets.read': {
        const logical = String(params.path ?? '')
        // 保留资源由平台在发布期写入：本地用磁盘上的 picoaide.app.json 顶替。
        if (logical === RESERVED_ASSET_NAME) {
          const text = JSON.stringify(this.config)
          return ok({ content_type: 'application/json', size: Buffer.byteLength(text), encoding: 'text', text })
        }
        const body = this.assets.get(logical)
        if (body === undefined) {
          return fail('ASSET_DENIED', `包内没有资源 ${logical}（先用 pack-assets.mjs 打包）`)
        }
        if (body.length === 0) return ok({ content_type: 'application/octet-stream', size: 0, encoding: 'empty' })
        const text = body.toString('utf8')
        // 与平台同口径：声明为文本但字节不是合法 UTF-8 时给 base64，而不是替换成乱码。
        if (Buffer.from(text, 'utf8').equals(body)) {
          return ok({ content_type: contentTypeOf(logical), size: body.length, encoding: 'text', text })
        }
        return ok({ content_type: contentTypeOf(logical), size: body.length, encoding: 'base64', base64: body.toString('base64') })
      }
      default:
        // 平台的宿主能力是封闭清单：宿主没有的能力（**包括任何 AI 能力**）也走这里 ——
        // 应用里的 AI 走页面里的客户端 AI loop（`__picoaide/ai/chat`，客户端本地处理），
        // 不在 wasm 里，因此预览宿主也没有它。
        return fail('NOT_FOUND', `未知的宿主方法: ${method}`)
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
  const out = { method: 'GET', path: '/', body: '', user: 'zhangwei', anonymous: false, wasm: '', config: '' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--path') out.path = argv[++i]
    else if (arg === '--method') out.method = (argv[++i] ?? 'GET').toUpperCase()
    else if (arg === '--body') out.body = argv[++i] ?? ''
    else if (arg === '--user') out.user = argv[++i]
    else if (arg === '--anonymous') out.anonymous = true
    else if (arg === '--config') out.config = argv[++i] ?? ''
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
