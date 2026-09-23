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
//   node preview.mjs dist/shared-notes-packed.wasm --dump-tables            # 看本地库里有哪些表/列/行数
//   node preview.mjs dist/shared-notes-packed.wasm --fresh                  # 先清空本地库再来一遍
//   node preview.mjs dist/shared-notes-packed.wasm --db /tmp/my-app.db      # 指定库文件位置
//
// **从 2026-09-21 起它用真正的 SQLite**（Node 内置 `node:sqlite`，Node ≥22.13 起无需开关）：
// 应用的 `db.define` / `db.query` / `db.exec` / 事务都落在**一个文件库**上，数据跨调用保留，
// 语义与线上一致（单语句闸门、语句种类白名单、保留列 `_row_id` 不可见、查询走只读连接）。
//
// 三件随之而来的好处：
//   · "写一条→读列表"这条最常见的开发循环**本地就能验证**（旧版是内存桩，写完全丢）；
//   · 分页/排序/聚合/唯一约束/类型行为都与线上同一套 SQLite 语义，不再是正则假装；
//   · 库文件就在磁盘上，**作者可以直接用它看数据**：
//       node preview.mjs dist/app.wasm --dump-tables        # 打印表 / 列 / 行数
//       sqlite3 dist/.preview/app.db 'select * from notes'  # 或任何 SQLite 工具
//
// 仍**不是**线上：没有 AI（wasm 侧本就没有，应用里的 AI 走页面里的客户端 AI loop
// `POST /__picoaide/ai/chat`，由客户端本地处理）、没有并发/配额、名单判定也仍是应用自己的事。
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
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
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
/**
 * 工具链段的**前缀**族：`.debug_*`（DWARF）。
 *
 * 为什么这条必须与 `pack-assets.mjs` / 服务端 `assets.ToolchainSectionPrefixes` 同源
 * （2026-09-21 审计）：编译器默认产出几 MB 的 `.debug_info` / `.debug_line`，平台在
 * 发布期**丢弃**它们（不进资源集、不可能被静态直出、`assets.read` 读不到）。
 * 本地预览若把 DWARF 当资源直出，作者会看到"本地能打开、线上 404"的假象，
 * 而"段总量预算"两侧也会给出两个数（预算口径见 pack-assets.mjs）。
 */
const TOOLCHAIN_SECTION_PREFIXES = ['.debug_']

/** isToolchainSection 报告一个自定义段名是否属于工具链段（精确名单 ∪ 前缀族）。 */
function isToolchainSection(name) {
  return TOOLCHAIN_SECTION_NAMES.has(name) ||
    TOOLCHAIN_SECTION_PREFIXES.some(prefix => name.startsWith(prefix))
}
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
      if (name !== RESERVED_ASSET_NAME && !isToolchainSection(name) && name !== '') {
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

/** 入口文档判定（与平台 `appserver.isEntryDocument` / serveStatic 规则 5 同口径）。 */
function isEntryPath(path) {
  // `pathnameOf` 已去掉结尾斜杠：目录形态 `/admin/` 到这里是 `/admin`，它在包内对应
  // `admin/index.html`（没有名为 `admin` 的资源 ⇒ 下面的 directAssetPath 自然回落给 wasm）。
  // 所以这里只判"包内文档名是 index.html"这一条，与平台 `isEntryDocument` 的判据同形：
  // `/`、`/index.html`、`<目录>/`（= `<目录>/index.html`）都是入口，其余不是。
  if (path === '/') return true
  return path.endsWith('/index.html')
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
    console.error('用法: node preview.mjs <app.wasm> [--path /] [--method GET] [--body ...] [--user zhangwei] ' +
      '[--anonymous] [--config <picoaide.app.json>] [--db <file>] [--data-dir <dir>] [--fresh] [--dump-tables]')
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

  // 本地库：真 SQLite 文件（`--dump-tables` 只读它、不跑 wasm）。
  const dbPath = resolveDBPath(args, wasmPath)
  if (args.fresh && existsSync(dbPath)) {
    rmSync(dbPath, { force: true })
    rmSync(`${dbPath}-wal`, { force: true })
    rmSync(`${dbPath}-shm`, { force: true })
    console.error(`[preview] --fresh：已清空本地库 ${dbPath}`)
  }
  let db
  try {
    db = new PreviewDB(dbPath)
  } catch (error) {
    console.error(`[preview] 打开本地库失败（${dbPath}）: ${error.message}`)
    console.error('提示：本项目用 Node 内置 node:sqlite（Node ≥22.13 / ≥23.4 无需开关；' +
      '更老的版本请升级 Node，或给 node 加 --experimental-sqlite）')
    process.exit(1)
  }
  console.error(`[preview] 本地库: ${dbPath}（数据跨调用保留；--dump-tables 看表，--fresh 清空）`)
  if (args.dumpTables) {
    for (const line of db.dumpTables()) console.log(line)
    db.close()
    return
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
  const host = new FakeHost(child.stdin, reader, config, args, assets, db)

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
  db.close()
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
 * 预览宿主里的**应用库**：真正的 SQLite（`node:sqlite`），语义对齐平台。
 *
 * 对齐平台的哪几条（这几条正是"本地绿、线上红"的高发区）：
 *   1. **单语句**：分号只能出现在字符串/注释里，其后除空白与注释外不得再有内容；
 *   2. **语句种类白名单**：`db.query` 只跑 SELECT，`db.exec` 只跑 INSERT/UPDATE/DELETE；
 *   3. **保留列不可见**：应用 SQL 里提到 `_row_id`（或它的别名 rowid/_rowid_/oid）一律拒；
 *      `SELECT *` 的结果里也要把它**剥掉**（平台在投影层剥，见 api/rows.go 的同款口径）；
 *   4. **查询走只读连接**（`readOnly: true`）：写语句在 query 路径上会被 SQLite 自己拒掉；
 *   5. **引擎内部对象不可碰**：`sqlite_` / `pragma_` 前缀的标识符一律拒（与平台 sqlgate 同判）。
 *
 * 与平台的**有意差异**（本地预览不该假装有配额）：不设 100 MB 库上限、不设单语句 5 s 预算、
 * 不做每请求计量。这些是运行期护栏，不是应用语义。
 */
class PreviewDB {
  /**
   * @param path - 库文件路径（`:memory:` 表示临时内存库）。
   */
  constructor(path) {
    this.path = path
    this.rw = new DatabaseSync(path)
    // 查询连接只读：让"在 query 里写数据"这类错误在本地就炸，而不是到线上才 DB_DENIED。
    this.ro = new DatabaseSync(path, { readOnly: true })
    this.txOpen = false
    // 与平台同族的加固（可复现的失败比"看起来一样"更重要）。
    this.rw.exec('PRAGMA busy_timeout = 3000')
  }

  /** 关闭两条连接（幂等）。 */
  close() {
    for (const db of [this.ro, this.rw]) {
      try { db.close() } catch { /* 已关闭 */ }
    }
  }

  /**
   * 扫描语句：返回 `{ kind }` 或抛出带 `DB_DENIED` 语义的错误。
   * @param sql - 语句原文。
   * @param allowed - 允许的语句种类（小写）。
   */
  #classify(sql, allowed) {
    const text = String(sql ?? '')
    if (text.trim() === '') throw new PreviewDBError('DB_DENIED', '空语句')
    if (text.length > 64 * 1024) throw new PreviewDBError('DB_DENIED', '语句超过 64 KiB')
    // 去掉字符串字面量与注释后再看分号与关键字（与平台同精神：不做完整 SQL 解析，
    // 但绝不被字符串里的分号骗过）。
    const bare = stripLiteralsAndComments(text)
    const semi = bare.indexOf(';')
    if (semi >= 0 && bare.slice(semi + 1).trim() !== '') {
      throw new PreviewDBError('DB_DENIED', '一次只能发一条语句（多语句会让 query/exec 的种类判据形同虚设）')
    }
    const first = /^\s*([A-Za-z]+)/.exec(bare)?.[1]?.toLowerCase() ?? ''
    if (first === 'with') throw new PreviewDBError('DB_DENIED', 'WITH（含 CTE）一律拒（与平台同判）')
    if (!allowed.includes(first)) {
      throw new PreviewDBError('DB_DENIED', `这条路径只允许 ${allowed.join('/').toUpperCase()}，收到 ${first.toUpperCase() || '(空)'}`)
    }
    if (/\b(sqlite_|pragma_)/i.test(bare)) {
      throw new PreviewDBError('DB_DENIED', 'sqlite_ / pragma_ 前缀的引擎内部对象不可访问')
    }
    if (/\b(_row_id|rowid|_rowid_|oid)\b/i.test(bare)) {
      throw new PreviewDBError('DB_DENIED', `平台保留列 ${RESERVED_ROW_ID} 不可提及（应用看不到它）`)
    }
    return first
  }

  /**
   * 建表（与平台 `db.define` 同语义：幂等 + 平台自动追加保留行号列）。
   * @param params - 帧里的 `db.define` 参数（table / columns）。
   */
  define(params) {
    const table = String(params.table ?? '')
    if (!/^[a-z][a-z0-9_]{0,30}$/.test(table)) {
      throw new PreviewDBError('DB_DENIED', `非法表名 ${table}（小写字母开头、[a-z0-9_]、≤31）`)
    }
    const columns = (params.columns ?? []).map(c => ({ name: String(c.name ?? ''), type: String(c.type ?? '').toUpperCase() }))
    for (const column of columns) {
      if (!/^[a-z][a-z0-9_]{0,30}$/.test(column.name)) {
        throw new PreviewDBError('DB_DENIED', `非法列名 ${column.name}`)
      }
      // 列类型枚举与平台 `limits.SQLColumnTypes` 逐字对齐：text / int / real / bool / datetime
      //（datetime 在 SQLite 里落 TEXT，见 limits.SQLColumnTypeToSQLite）。
      if (!['TEXT', 'INTEGER', 'REAL', 'BOOL', 'DATETIME'].includes(column.type)) {
        throw new PreviewDBError('DB_DENIED', `非法列类型 ${column.type}（平台枚举：text/int/real/bool/datetime）`)
      }
    }
    const existed = this.rw.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', table) !== undefined
    const defs = columns.map(c => `"${c.name}" ${SQLITE_TYPE[c.type] ?? 'TEXT'}`)
    defs.push(`"${RESERVED_ROW_ID}" INTEGER PRIMARY KEY AUTOINCREMENT`)
    this.rw.exec(`CREATE TABLE IF NOT EXISTS "${table}" (${defs.join(', ')})`)
    return { created: !existed, table, columns: columns.map(c => c.name) }
  }

  /**
   * 单条 SELECT（只读连接）。结果里剥掉保留列，与平台的应用视角一致。
   * @param sql - SELECT 语句。
   * @param args - 绑定参数。
   */
  query(sql, args) {
    this.#classify(sql, ['select'])
    const statement = this.ro.prepare(sql)
    // `returnArrays`：按位置取值（平台的 rows 就是数组的数组）。
    const rows = statement.all(...(args ?? []).map(normalizeArg))
    const columns = statement.columns().map(c => c.name).filter(name => name.toLowerCase() !== RESERVED_ROW_ID)
    const projected = rows.map(row => columns.map(name => toJsonValue(row[name])))
    statement.close?.()
    return { columns, rows: projected, truncated: false }
  }

  /**
   * 单条写语句。返回受影响行数（与平台 `db.exec` 的 `rows_affected` 同形）。
   * @param sql - INSERT / UPDATE / DELETE。
   * @param args - 绑定参数。
   */
  exec(sql, args) {
    this.#classify(sql, ['insert', 'update', 'delete'])
    const statement = this.rw.prepare(sql)
    const info = statement.run(...(args ?? []).map(normalizeArg))
    statement.close?.()
    return { rows_affected: Number(info.changes ?? 0) }
  }

  /** 开事务（平台：一次请求一个事务，这里按帧驱动）。 */
  begin() {
    if (this.txOpen) throw new PreviewDBError('DB_DENIED', '已经有进行中的事务')
    this.rw.exec('BEGIN')
    this.txOpen = true
    return { tx_id: 1 }
  }

  /** 提交。 */
  commit() {
    if (!this.txOpen) throw new PreviewDBError('DB_DENIED', '没有进行中的事务')
    this.rw.exec('COMMIT')
    this.txOpen = false
    return { committed: true }
  }

  /** 回滚（本地也能验"回滚真的没落库"这条最有教学价值的路径）。 */
  rollback() {
    if (!this.txOpen) throw new PreviewDBError('DB_DENIED', '没有进行中的事务')
    this.rw.exec('ROLLBACK')
    this.txOpen = false
    return { committed: false }
  }

  /** 打印表 / 列 / 行数（`--dump-tables`；也可以直接用 sqlite3 打开这个文件）。 */
  dumpTables() {
    const tables = this.ro.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    const lines = [`库文件: ${this.path}`]
    if (tables.length === 0) {
      lines.push('（还没有任何表：应用还没跑过 db.define）')
      return lines
    }
    for (const { name } of tables) {
      const columns = this.ro.prepare(`PRAGMA table_info("${name}")`).all().map(c => `${c.name}:${c.type}`)
      const rows = this.ro.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n
      lines.push(`- ${name}（${rows} 行）`)
      lines.push(`    列: ${columns.join(', ')}`)
    }
    return lines
  }
}

/** 预览宿主的错误类型：`code` 与平台错误码同族（`DB_DENIED` / `DB_LIMIT`）。 */
class PreviewDBError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** 平台保留行号列（应用不可见、也不能在 SQL 里提到）。 */
const RESERVED_ROW_ID = '_row_id'

/** 列类型枚举 → SQLite 列类型（与平台 `limits.SQLColumnTypeToSQLite` 同映射）。 */
const SQLITE_TYPE = { TEXT: 'TEXT', INTEGER: 'INTEGER', REAL: 'REAL', BOOL: 'INTEGER', DATETIME: 'TEXT' }

/**
 * 去掉字符串字面量与注释，只留可判定的"裸 SQL"。
 *
 * 为什么需要：`INSERT INTO t (body) VALUES ('a;b')` 里的分号是**数据**，不是语句分隔符；
 * 而 `INSERT ...; DROP TABLE t` 里的分号是真分隔符。平台有一份词法扫描做这件事
 * （`appdb/sqlgate.go`），这里是它的最小对齐版（预览工具不需要与它逐字节同源，
 * 但判据必须同向：字符串里的分号不算分隔符）。
 * @param sql - 原始语句。
 * @returns 抹掉字面量/注释后的文本（保留长度无关，只用于关键字与分号判定）。
 */
function stripLiteralsAndComments(sql) {
  let out = ''
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i++
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { i += 2; continue }
          break
        }
        i++
      }
      out += ' '
      continue
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++
      out += ' '
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i++
      out += ' '
      continue
    }
    out += ch
  }
  return out
}

/**
 * 把帧里传来的参数规整成 `node:sqlite` 能绑定的类型。
 *
 * 平台的 `db.query/db.exec` 只接受标量（对象/数组一律拒，见 appdb.normalizeArgs）；
 * 这里同向：非标量直接抛，避免"本地能跑、线上 DB_DENIED"。
 * @param value - 参数值。
 * @returns 可绑定的标量。
 */
function normalizeArg(value) {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return typeof value === 'boolean' ? (value ? 1 : 0) : value
  }
  throw new PreviewDBError('DB_DENIED', `参数只支持字符串/数字/布尔/null，收到 ${typeof value}`)
}

/**
 * 把 SQLite 值转成 JSON 友好的形状（平台把 BLOB 归一成字符串、时间归一成 RFC3339）。
 * @param value - `node:sqlite` 返回的值。
 * @returns JSON 值。
 */
function toJsonValue(value) {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
  if (typeof value === 'bigint') return Number(value)
  return value
}

/** 假宿主：把宿主函数实现成内存版，让应用的分支都能走通。 */
class FakeHost {
  constructor(stdin, reader, config, args, assets, db) {
    this.stdin = stdin
    this.reader = reader
    this.config = config
    this.args = args
    this.db = db
    /** 包内资源（从打包后的 wasm 里解析出来的自定义段）。 */
    this.assets = assets
    // 真 SQLite 库（见 PreviewDB）：数据跨调用保留，语义与线上一致。
    this.db = db
  }

  /**
   * 把一次库调用包成 JSON-RPC 应答：闸门与 SQLite 的错误都翻成 `{code, message}`。
   *
   * 错误码口径（与平台同族）：语句闸门/保留列/参数类型 ⇒ `DB_DENIED`；
   * SQLite 自己报的错（语法/约束/只读）⇒ `DB_DENIED` + 原文（原文是排障的关键，
   * 不要吞掉它 —— 本地预览的价值就在于"错误信息与线上一样具体"）。
   * @param ok - 成功应答构造器。
   * @param fail - 失败应答构造器。
   * @param fn - 实际动作。
   */
  #dbCall(ok, fail, fn) {
    try {
      return ok(fn())
    } catch (error) {
      if (error instanceof PreviewDBError) return fail(error.code, error.message)
      return fail('DB_DENIED', `${error.message}（SQLite 原文）`)
    }
  }

  answer(frame) {
    const { id, method, params } = frame
    const ok = result => ({ jsonrpc: '2.0', id, result })
    const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })
    switch (method) {
      case 'tx_begin':
        return this.#dbCall(ok, fail, () => this.db.begin())
      case 'tx_commit':
        return this.#dbCall(ok, fail, () => this.db.commit())
      case 'tx_rollback':
        return this.#dbCall(ok, fail, () => this.db.rollback())
      case 'db.define':
        return this.#dbCall(ok, fail, () => this.db.define(params))
      case 'db.query':
        return this.#dbCall(ok, fail, () => this.db.query(String(params.sql ?? ''), params.args))
      case 'db.exec':
        return this.#dbCall(ok, fail, () => this.db.exec(String(params.sql ?? ''), params.args))
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
  const out = {
    method: 'GET', path: '/', body: '', user: 'zhangwei', anonymous: false,
    wasm: '', config: '', db: '', dataDir: '', fresh: false, dumpTables: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--path') out.path = argv[++i]
    else if (arg === '--method') out.method = (argv[++i] ?? 'GET').toUpperCase()
    else if (arg === '--body') out.body = argv[++i] ?? ''
    else if (arg === '--user') out.user = argv[++i]
    else if (arg === '--anonymous') out.anonymous = true
    else if (arg === '--config') out.config = argv[++i] ?? ''
    else if (arg === '--db') out.db = argv[++i] ?? ''
    else if (arg === '--data-dir') out.dataDir = argv[++i] ?? ''
    else if (arg === '--fresh') out.fresh = true
    else if (arg === '--dump-tables') out.dumpTables = true
    else if (!arg.startsWith('--')) out.wasm = arg
  }
  return out
}

/**
 * 解析本地库文件路径（**默认持久化**，这是"能看数据"的前提）。
 *
 * 缺省落点：`<wasm 所在目录>/.preview/<wasm 文件名>.db`。选它的理由：
 *   - 跟产物放一起 ⇒ 同一个应用反复预览用的是同一个库，数据跨调用保留；
 *   - 目录名以点开头 ⇒ 不会被打包脚本/`ls` 当资源（`pack-assets.mjs` 只接受显式给的路径，
 *     但"看起来就不是源码"仍然有价值）；
 *   - `--data-dir` 可换目录，`--db` 可精确指定文件（例如放到工作区外做对比实验）。
 * @param args - 命令行参数。
 * @param wasmPath - 产物绝对路径。
 * @returns 库文件绝对路径。
 */
function resolveDBPath(args, wasmPath) {
  if (args.db) return resolve(args.db)
  const dir = args.dataDir ? resolve(args.dataDir) : join(dirname(wasmPath), '.preview')
  mkdirSync(dir, { recursive: true })
  return join(dir, `${basename(wasmPath).replace(/\.wasm$/i, '')}.db`)
}

/**
 * 自检（`--selftest`）：把预览库的**判据**变成可复跑的东西。
 *
 * 为什么放在脚本里而不是测试目录：这个文件是**随技能下发**的作者工具，作者改不了平台，
 * 但会遇到"本地预览和线上不一样"的困惑。把闸门行为固化成 `--selftest`（零依赖、临时库、
 * 跑完删）之后，作者随时能确认"我这份预览的语义没漂"。
 *
 * 覆盖（每条都对应一个曾经踩过的坑）：
 *   1. 建表幂等 + 跨连接可见（真库，不是内存桩）；
 *   2. `db.query` 里写数据 ⇒ DB_DENIED（线上是只读连接）；
 *   3. 多语句 ⇒ DB_DENIED（否则 query/exec 的种类判据形同虚设）；
 *   4. 提到 `_row_id` ⇒ DB_DENIED；`SELECT *` 的结果里也没有它；
 *   5. 事务回滚真的不落库（技能里专门讲的路径）。
 * @returns 失败条数（0 = 全过）。
 */
function runSelfTest() {
  const dir = join(tmpdir(), `picoaide-preview-selftest-${process.pid}`)
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, 'selftest.db')
  const failures = []
  const check = (name, fn) => {
    try {
      fn()
      console.log(`  ok   ${name}`)
    } catch (error) {
      failures.push(name)
      console.log(`  FAIL ${name}: ${error.message}`)
    }
  }
  const expectDenied = (fn, needle) => {
    try {
      fn()
    } catch (error) {
      if (!(error instanceof PreviewDBError) || error.code !== 'DB_DENIED') {
        throw new Error(`期望 DB_DENIED，实际 ${error.code ?? error.constructor.name}: ${error.message}`)
      }
      if (needle !== undefined && !error.message.includes(needle)) {
        throw new Error(`错误信息里应包含 ${needle}，实际: ${error.message}`)
      }
      return
    }
    throw new Error('期望被拒，实际通过了')
  }

  const db = new PreviewDB(dbPath)
  check('db.define 幂等（第一次 created=true，第二次 false）', () => {
    const first = db.define({ table: 'notes', columns: [{ name: 'body', type: 'text' }] })
    const second = db.define({ table: 'notes', columns: [{ name: 'body', type: 'text' }] })
    if (first.created !== true || second.created !== false) throw new Error(JSON.stringify({ first, second }))
  })
  check('写进去的数据在新连接里读得到（真库，不是内存桩）', () => {
    db.exec('INSERT INTO notes (body) VALUES (?)', ['hello'])
    const fresh = new PreviewDB(dbPath)
    const result = fresh.query('SELECT body FROM notes', [])
    fresh.close()
    if (result.rows.length !== 1 || result.rows[0][0] !== 'hello') throw new Error(JSON.stringify(result))
  })
  check('SELECT * 的结果里没有保留列 _row_id', () => {
    const result = db.query('SELECT * FROM notes', [])
    if (result.columns.includes(RESERVED_ROW_ID)) throw new Error(JSON.stringify(result.columns))
  })
  check('query 路径上写数据 ⇒ DB_DENIED', () => {
    expectDenied(() => db.query('INSERT INTO notes (body) VALUES (?)', ['x']), '只允许 SELECT')
  })
  check('多语句 ⇒ DB_DENIED', () => {
    expectDenied(() => db.exec('INSERT INTO notes (body) VALUES (?) ; DELETE FROM notes', ['x']), '一次只能发一条语句')
  })
  check('提到 _row_id ⇒ DB_DENIED', () => {
    expectDenied(() => db.query('SELECT _row_id FROM notes', []), RESERVED_ROW_ID)
  })
  check('事务回滚不落库', () => {
    db.begin()
    db.exec('INSERT INTO notes (body) VALUES (?)', ['rolled-back'])
    db.rollback()
    const count = db.query('SELECT COUNT(*) AS n FROM notes', []).rows[0][0]
    if (Number(count) !== 1) throw new Error(`回滚后行数应为 1，实际 ${count}`)
  })
  check('非法列类型 ⇒ DB_DENIED（与平台枚举一致）', () => {
    expectDenied(() => db.define({ table: 'bad', columns: [{ name: 'x', type: 'blob' }] }), '非法列类型')
  })
  check('入口文档（`/`、`/index.html`、`<目录>/`）一律交给 wasm，宿主不直出', () => {
    // 与平台 appserver.isEntryDocument 同口径：判据是"包内文档名是 index.html"，
    // 不是"路径恰好是 /"（子目录入口同样要由应用自己把门）。
    for (const entry of ['/', '/index.html', '/admin/index.html', '/a/b/index.html']) {
      if (!isEntryPath(entry)) throw new Error(`${entry} 应判为入口文档`)
      if (directAssetPath('GET', entry) !== null) throw new Error(`${entry} 不该由宿主直出`)
    }
    if (directAssetPath('GET', '/admin/app.js') !== 'admin/app.js') {
      throw new Error('子资源仍应由宿主直出（§4.6 缓存收益）')
    }
  })
  db.close()
  rmSync(dir, { recursive: true, force: true })

  console.log(failures.length === 0
    ? '[preview] --selftest 全过：本地库语义与平台同向'
    : `[preview] --selftest 失败 ${failures.length} 条：${failures.join(' / ')}`)
  return failures.length
}

// ===== 入口（放在最后：class 声明不提升，顶层 dispatch 必须等它们求值完）=====

if (process.env.PICOAIDE_PREVIEW_CHILD === '1') {
  await runWasmInChild()
} else if (process.argv.slice(2).includes('--selftest')) {
  process.exit(runSelfTest())
} else {
  await runFakeHost()
}
