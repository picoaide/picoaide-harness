#!/usr/bin/env node
/**
 * pack-assets.mjs —— 把「路径 → 文件」追加进一个**已编译好的** wasm 模块（自定义段）。
 *
 * 为什么需要这个脚本（R1-e2e-6）：平台把 wasm 的**自定义段**当作随包静态资源的一等
 * 载体 —— 段名就是包内逻辑路径，发布期被抽到宿主磁盘上（既能 `assets.read`，也能按
 * 路径直出、参与静态响应缓存）。但自定义段的二进制格式要自己拼，最容易踩的一条是：
 *
 *     段长度前缀（LEB128）**必须包含段名的长度前缀与段名本身**，
 *     不只是文件内容。漏了它，平台回 `SECTION_MALFORMED: 第 N 字节处的段长度前缀非法`，
 *     而 N 指向文件里的某个偏移 —— 作者得先知道规范才修得对。
 *
 * 本脚本是这件事的**官方实现**，规则全部复用平台真源（不是"再定一套"）：
 *
 *   段名 = 包内逻辑路径        server/internal/wasmapp/api/publish.go 的 splitAssetSections / isLogicalAssetPath
 *   保留资源 `picoaide.app.json`  server/internal/wasmapp/limits/limits.go 的 AppConfigFileName（平台独占，模块里的同名段会被忽略）
 *   工具链元数据段             server/internal/wasmapp/api/publish.go 的 toolchainSections（平台忽略，不会成为资源）
 *   路径规则（长度/段/字符）    server/internal/wasmapp/assets/assets.go 的 validateLogicalPath（MaxPathBytes / MaxSegmentBytes）
 *   自定义段总量上限           server/internal/wasmapp/limits/limits.go 的 SectionTotalMaxBytes
 *   LEB128 读法                server/internal/wasmapp/wasmmod/leb.go 的 readU32 / readName
 *
 * 零外部依赖（只用 Node 内置能力）；**绝不就地覆盖输入**（必须给 `--out`）。
 *
 * 用法（在技能目录或任何地方都能跑；路径按你当前的 shell 解析）：
 *
 *   node pack-assets.mjs \
 *     --in  shared-notes.wasm \
 *     --out shop/shared-notes-packed.wasm \
 *     web/index.html=index.html \
 *     web/app.css=static/app.css \
 *     web/logo.png=static/logo.png
 *
 * 也可以写成 `--asset web/index.html=index.html`（等价，便于脚本拼参数）。
 * `--help` 打印同样的说明。成功时打印每个段的字节数与"自定义段总量 / 上限"。
 *
 * 自证（产出必须能被平台接受）：
 *   cd server && go test ./internal/wasmmod -run PackAssets -v
 * 该用例现场编译一个 Go wasm、跑本脚本、再用平台自己的解析器
 * （wasmmod.Validate / ExtractCustomSections）断言：段被识别、路径与内容逐字节一致、
 * 保留资源不被覆盖、非法输入报错、`--out` 不与输入同文件。
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// 与平台真源对应的常量（Go 侧符号写在注释里；改平台规则时改这里并同步 go test 判据）
// ---------------------------------------------------------------------------

/** wasm 自定义段的 id（wasmmod/parse.go 的 SectionCustom）。 */
const CUSTOM_SECTION_ID = 0
/** core spec 里最后一个段 id（DataCount=12）；更大的 id 平台直接拒（wasmmod/parse.go）。 */
const MAX_KNOWN_SECTION_ID = 12
/** DataCount 段 id（Wasm 2.0 bulk-memory）；规范位置在 Element 之后、Code 之前。 */
const DATA_COUNT_SECTION_ID = 12
/** Element 段 id（DataCount 的下界判据用）。 */
const ELEMENT_SECTION_ID = 9
/** Code 段 id（DataCount 的上界判据用）。 */
const CODE_SECTION_ID = 10
/** core module 版本（组件模型是另一个版本号，平台不支持）。 */
const CORE_MODULE_VERSION = 1
/** `\0asm` 魔数。 */
const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d])

/** limits.AppConfigFileName：平台**独占**的保留资源。 */
const RESERVED_ASSET_NAME = 'picoaide.app.json'

/**
 * server/internal/wasmapp/assets 的 ToolchainSections：平台按"工具链元数据"分流掉，
 * 不会成为资源。往这些段名里塞文件 = 静默丢失
 * （Go 产物本来就带 `name` / `producers` / `go:buildid`）。
 */
const TOOLCHAIN_SECTION_NAMES = new Set([
  'name',
  'producers',
  'target_features',
  'dylink',
  'dylink.0',
  'linking',
  'sourceMappingURL',
  'external_debug_info',
])

/**
 * assets.ToolchainSectionPrefixes：**前缀形态**的工具链段名。
 * DWARF 调试段是一族（`.debug_info` / `.debug_line` / `.debug_abbrev` / …），
 * 逐个罗列必然漏；Rust/Zig/LLVM 默认产物会带几 MB 的 DWARF，平台按前缀忽略它们
 * （既不进资源集，也不会被静态直出）。这里 fail-loud 而不是静默丢弃。
 */
const TOOLCHAIN_SECTION_PREFIXES = ['.debug_']

/** 段名是否是工具链元数据（与 assets.IsToolchainSection 同一判据）。 */
function isToolchainSection(name) {
  return TOOLCHAIN_SECTION_NAMES.has(name) || TOOLCHAIN_SECTION_PREFIXES.some(p => name.startsWith(p))
}

/**
 * 段名是否计入 4 MiB 段总量预算（与 assets.CountsTowardSectionBudget **同一判据**）：
 * **只有 `.debug_*` 前缀族不计**。
 *
 * 为什么（2026-09-21 独立审计 D-A1）：`.debug_*`（DWARF）是平台在发布期**丢弃**的段
 * （不进资源集、不可能被静态直出、`assets.read` 也读不到），而真实工具链默认就会产出
 * 几百 KB ~ 几 MB（实测 Zig 0.14.0 `-O Debug` 产物 703,566 字节里 703,313 字节是 8 个
 * `.debug_*` 段）。把它们计入会让同一个模块出现**两个数** —— 资产口径说"通过"、段总量
 * 口径说"超限"（实测 3,584,077/4,194,304 vs 4,287,501/4,194,304），作者按哪个数改都是错的。
 * 精确名单里的 `name`/`producers`/… 与非路径名（`go:buildid`）小而有界，仍按保守口径计入。
 *
 * ⚠️ 这条判据与 Go 侧是**同一个测量**：改动必须两边同改（Go 侧
 * `internal/wasmapp/assets/assets_test.go` 有 Go↔Node 的逐字节对拍用例）。
 */
function countsTowardSectionBudget(name) {
  return !TOOLCHAIN_SECTION_PREFIXES.some(p => name.startsWith(p))
}

/** assets.MaxPathBytes：包内逻辑路径总长（**字节**，不是字符数）。 */
const MAX_PATH_BYTES = 256
/** assets.MaxSegmentBytes：单个路径段长度（字节）。 */
const MAX_SEGMENT_BYTES = 255
/**
 * limits.SectionTotalMaxBytes：段总量上限（4 MiB）。
 *
 * 口径 = **计入预算的**自定义段**负载**字节和（含段名的长度前缀与段名，不含段 id 与
 * 段长度前缀本身），见 wasmmod/parse.go 的 `info.CustomBytes += size`；
 * 哪些段计入见 countsTowardSectionBudget（`.debug_*` 不计）。
 */
const SECTION_TOTAL_MAX_BYTES = 4 << 20
/**
 * limits.WasmMaxBytes：`.wasm` 体积上限（32 MiB）。本脚本不据此拒绝（那是平台 upload 期
 * 的判据），只在 `.debug_*` 提示里给出参照 —— 它们不计入 4 MiB，但仍计入这个体积上限。
 */
const WASM_MAX_BYTES = 32 << 20

/** 带提示的错误：main 里统一渲染成 `pack-assets: 消息` + 提示行。 */
class PackerError extends Error {
  constructor(message, hints = []) {
    super(message)
    this.name = 'PackerError'
    this.hints = hints
  }
}

function fail(message, hints) {
  throw new PackerError(message, hints)
}

// ---------------------------------------------------------------------------
// wasm 段表：LEB128 与解析（读法对齐 wasmmod/leb.go，判据对齐 wasmmod/parse.go）
// ---------------------------------------------------------------------------

/** 读一个无符号 LEB128 u32；返回 { value, used }。溢出/截断即报错（与 Go 侧同语义）。 */
function readU32(buf, offset, what) {
  let out = 0
  for (let i = 0; ; i++) {
    if (i >= 5) fail(`${what}：LEB128 超过 32 位`, ['长度前缀最多 5 字节，第 5 字节只能有低 4 位'])
    if (offset + i >= buf.length) fail(`${what}：LEB128 在读满之前数据就结束了`)
    const c = buf[offset + i]
    const payload = c & 0x7f
    if (i === 4 && payload > 0x0f) fail(`${what}：LEB128 超过 32 位`)
    out |= payload << (7 * i)
    if ((c & 0x80) === 0) return { value: out >>> 0, used: i + 1 }
  }
}

/** 写一个无符号 LEB128 u32（`>>> 0` 保证按无符号处理）。 */
function encodeU32(value) {
  const out = []
  let v = value >>> 0
  for (;;) {
    let b = v & 0x7f
    v >>>= 7
    if (v !== 0) b |= 0x80
    out.push(b)
    if (v === 0) break
  }
  return Buffer.from(out)
}

/**
 * 解析模块的**段表**，返回 { customSections, budgetBytes, ignoredDebugBytes }。
 *
 * `budgetBytes` = **计入 4 MiB 段总量预算**的自定义段负载之和（`.debug_*` 不计，
 * 口径见 countsTowardSectionBudget）；`ignoredDebugBytes` = 被排除的那部分（只用于提示）。
 *
 * 只复刻平台对段表的判据（越界、LEB 合法、非自定义段至多一次、未知 id、
 * **含 DataCount(12) 的规范位置特例**），
 * 因为本脚本只追加自定义段、不改动既有字节 —— 「输入能过段表 ⇒ 输出还是能过」。
 * 导入面/导出面不在本脚本职责内（那是平台 upload 期校验的事）。
 */
function parseModule(buf) {
  if (buf.length < 8) fail('输入不足 8 字节，不是 wasm 模块')
  if (!buf.subarray(0, 4).equals(WASM_MAGIC)) {
    fail('输入的魔数不是 `\\0asm`，不是 wasm 模块', [
      'Go 的编译目标是 wasm32-wasip1：GOOS=wasip1 GOARCH=wasm go build',
    ])
  }
  const version = buf.readUInt32LE(4)
  if (version !== CORE_MODULE_VERSION) {
    fail(`输入的版本号是 ${version}，不是 core module 的 ${CORE_MODULE_VERSION}（组件模型平台不支持）`)
  }

  const customSections = []
  const seenSectionIDs = new Set()
  let budgetBytes = 0
  let ignoredDebugBytes = 0
  let lastSectionID = -1
  let offset = 8
  while (offset < buf.length) {
    const sectionStart = offset
    const id = buf[offset]
    offset += 1
    const sizeAt = offset
    const { value: size, used } = readU32(buf, offset, `第 ${offset} 字节处的段长度前缀（段 id=${id}）`)
    offset += used
    if (size > buf.length - offset) {
      fail(`段 id=${id} 声明长度 ${size} 字节，但文件只剩 ${buf.length - offset} 字节（段表越界/截断）`, [
        `段头在第 ${sectionStart} 字节（长度前缀在第 ${sizeAt} 字节）`,
      ])
    }
    const payload = buf.subarray(offset, offset + size)
    offset += size

    if (id === CUSTOM_SECTION_ID) {
      const { value: nameLength, used: namePrefix } = readU32(payload, 0, `第 ${sectionStart} 字节的自定义段名字长度`)
      if (nameLength > payload.length - namePrefix) {
        fail(`第 ${sectionStart} 字节的自定义段：段名声明 ${nameLength} 字节，但负载只剩 ${payload.length - namePrefix} 字节`)
      }
      const name = payload.subarray(namePrefix, namePrefix + nameLength).toString('utf8')
      customSections.push({ name, size, sectionStart })
      if (countsTowardSectionBudget(name)) budgetBytes += size
      else ignoredDebugBytes += size
      continue
    }
    // 段表判据必须与平台**逐条同判**（wasmmod/parse.go）—— 两边不同判的后果是
    // "脚本放行 ⇒ 平台发布被拒"或反过来"脚本误拒合法产物"（2026-09-21 审计：
    // 本脚本此前只做"纯 id 升序"，会把 TinyGo/LLVM 的**规范 DataCount 位置**误拒）。
    if (id > MAX_KNOWN_SECTION_ID) {
      fail(`未知段 id ${id}（第 ${sectionStart} 字节）：平台只支持 0–${MAX_KNOWN_SECTION_ID}` +
        `（Tag 段（13）属 Wasm 3.0 异常处理，本平台不启用该特性，段序摆对也无法编译）`)
    }
    // 重复判据**先于**顺序判据：两种病因可能同时成立，重复优先才能指出病根。
    if (seenSectionIDs.has(id)) {
      fail(`非自定义段 id=${id} 出现了两次（第 ${sectionStart} 字节）：每个 id 至多一次`)
    }
    seenSectionIDs.add(id)
    // DataCount(12) 是唯一不按数值升序的段：规范位置 = Element(9) 之后、Code(10) 之前。
    if (id === DATA_COUNT_SECTION_ID) {
      if (lastSectionID > ELEMENT_SECTION_ID) {
        fail(`段顺序非法：段 id=${id} 出现在段 id ${lastSectionID} 之后` +
          `（DataCount 必须在 Element 之后、Code 之前）`)
      }
    } else if (lastSectionID === DATA_COUNT_SECTION_ID) {
      if (id < CODE_SECTION_ID) {
        fail(`段顺序非法：段 id=${id} 出现在 DataCount 之后（DataCount 之后只允许 Code 及之后）`)
      }
    } else if (id < lastSectionID) {
      fail(`段顺序非法：段 id=${id} 出现在段 id ${lastSectionID} 之后（非自定义段必须按 id 升序）`)
    }
    lastSectionID = id
  }
  return { customSections, budgetBytes, ignoredDebugBytes }
}

/** 拼一个自定义段，返回 { section, payloadBytes }。
 *
 * `payloadBytes` 是平台口径的"段负载字节和"（含段名的长度前缀与段名，**不含**段 id 与
 * 段长度前缀本身）—— limits.SectionTotalMaxBytes 按它计费（wasmmod/parse.go 的
 * `info.CustomBytes += size`，size 就是这里说的负载长度）。
 */
function encodeAssetSection(name, content) {
  const nameBytes = Buffer.from(name, 'utf8')
  // ⚠️ 这一行是 R1-e2e-6 的坑：段长度前缀写的是**负载**长度
  // （名字长度前缀 + 名字 + 内容）。只写 `content.length` 会得到 SECTION_MALFORMED。
  const payload = Buffer.concat([encodeU32(nameBytes.length), nameBytes, content])
  const section = Buffer.concat([Buffer.from([CUSTOM_SECTION_ID]), encodeU32(payload.length), payload])
  return { section, payloadBytes: payload.length }
}

// ---------------------------------------------------------------------------
// 包内逻辑路径：对齐 assets.validateLogicalPath（**字节**长度、逐段判据、Clean 回环）
// ---------------------------------------------------------------------------

/** 纯字符串版本的 path.Clean（与 Go 的 path.Clean 同语义；用于"Clean 后必须等于原文"）。 */
function cleanPosix(p) {
  const absolute = p.startsWith('/')
  const out = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
      continue
    }
    out.push(seg)
  }
  const joined = out.join('/')
  if (absolute) return '/' + joined
  return joined === '' ? '.' : joined
}

/** 校验一个自定义段名（= 包内逻辑路径）；不合法直接抛错。 */
function assertAssetName(name) {
  if (name === '') fail('资源路径不能为空（写法是 SRC=DEST，DEST 是包内逻辑路径，如 index.html）')
  const bytes = Buffer.byteLength(name, 'utf8')
  if (bytes > MAX_PATH_BYTES) {
    fail(`资源路径 ${bytes} 字节超过上限 ${MAX_PATH_BYTES} 字节：${name}`, [
      '包内路径是**逻辑路径**（相对、以 / 分隔），不要写宿主文件路径',
    ])
  }
  if (name.startsWith('/')) {
    fail(`资源路径不能是绝对路径：${name}`, ['去掉开头的 `/`（如 static/app.css）'])
  }
  if (name.includes('\\')) fail(`资源路径不能用反斜杠：${name}`, ['路径分隔符统一用 `/`'])
  if (name.includes(':')) fail(`资源路径不能含冒号（会被当成盘符/协议）：${name}`)
  for (const ch of name) {
    const code = ch.codePointAt(0)
    if (code < 0x20 || code === 0x7f) fail(`资源路径含控制字符（U+${code.toString(16).padStart(4, '0')}）：${JSON.stringify(name)}`)
  }
  for (const seg of name.split('/')) {
    if (Buffer.byteLength(seg, 'utf8') > MAX_SEGMENT_BYTES) {
      fail(`资源路径的某一段超过 ${MAX_SEGMENT_BYTES} 字节：${name}`, ['单个目录名/文件名不得超过 255 字节（POSIX NAME_MAX）'])
    }
    if (seg === '') fail(`资源路径有空段（写了 \`//\` 或以 \`/\` 结尾）：${name}`)
    if (seg === '.') fail(`资源路径含 \`.\` 段：${name}`)
    if (seg === '..') fail(`资源路径含 \`..\` 段（不能穿越）：${name}`)
  }
  if (cleanPosix(name) !== name) {
    fail(`资源路径不是规范形式（Clean 后变成 ${cleanPosix(name)}）：${name}`)
  }
}

/** 保留资源 / 工具链段名的**拒绝**（它们加了也不会成为资源，必须 fail-loud）。 */
function assertNotReservedOrToolchain(dest, source) {
  const reservedHit = dest === RESERVED_ASSET_NAME || dest.split('/').includes(RESERVED_ASSET_NAME)
  if (reservedHit) {
    fail(`不能把 ${source} 打进 \`${RESERVED_ASSET_NAME}\`：它是**平台保留资源**`, [
      `${RESERVED_ASSET_NAME} 由平台在发布期写入（内容 = 你随包提交的 config），保留资源不能这样加`,
      `应用要用 assets.read("${RESERVED_ASSET_NAME}") 读配置 —— 那是平台写的，不是你嵌的`,
      '要放名单/机密：写进 config（whitelist），不要放进非保留资源（非保留资源会被直出给任何人）',
    ])
  }
  if (isToolchainSection(dest)) {
    fail(`段名 \`${dest}\` 是工具链元数据段（平台按 assets.IsToolchainSection 忽略，不会成为资源）`, [
      '换个包内路径（如 data/notes.json）：这个名字加了也会被平台静默丢掉',
      'Go 产物本来就有 name / producers / go:buildid 三个段，正是走这条分流',
      '`.debug_` 开头的 DWARF 调试段同样走这条分流（Rust/Zig/LLVM 默认产物会带几 MB）',
    ])
  }
}

// ---------------------------------------------------------------------------
// 命令行
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opt = { in: '', out: '', assets: [], help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') opt.help = true
    else if (arg === '--in' || arg === '--input') opt.in = argv[++i] ?? ''
    else if (arg === '--out' || arg === '--output') opt.out = argv[++i] ?? ''
    else if (arg === '--asset') opt.assets.push(argv[++i] ?? '')
    else if (arg.startsWith('--')) fail(`未知参数 ${arg}`, ['node pack-assets.mjs --help 看用法'])
    else opt.assets.push(arg)
  }
  return opt
}

function usage() {
  return `用法：node pack-assets.mjs --in <module.wasm> --out <packed.wasm> <SRC=DEST>...

  --in  <path>        已编译好的 wasm（保持不变，脚本只追加自定义段）
  --out <path>        输出路径（**必填**；不得与 --in 是同一个文件）
  <SRC=DEST>          源文件=包内逻辑路径，可重复；也可写 --asset SRC=DEST
  --help

例：
  node pack-assets.mjs --in app.wasm --out app-packed.wasm \\
    web/index.html=index.html web/app.css=static/app.css

规则（真源见脚本头部注释）：
  · 段名 = 包内逻辑路径（相对、以 / 分隔、不含 .. 与 :，单段不超过 ${MAX_SEGMENT_BYTES} 字节）
  · ${RESERVED_ASSET_NAME} 是平台保留资源，不能这样加（它由平台写入）
  · 工具链元数据段名（name / producers / …）会被平台忽略，脚本直接拒
  · 段总量上限 ${humanBytes(SECTION_TOTAL_MAX_BYTES)}（= **计入预算的**各段**负载**之和：含段名的长度前缀与段名，
    不含段 id 与长度前缀本身；Go 产物自带的 name 段也计入；.debug_*（DWARF）不计 ——
    平台发布期会丢弃它们，与 wasmmod.Validate 同一口径）`
}

function humanBytes(n) {
  if (n < 1024) return `${n} 字节`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`
}

/** 把 `SRC=DEST` 拆开（按**第一个** `=` 拆；源文件名里请避开 `=`）。 */
function parseSpec(spec, index) {
  const eq = spec.indexOf('=')
  if (eq < 0) {
    fail(`第 ${index} 个资源参数 \`${spec}\` 不是 SRC=DEST 形式`, [
      '例：web/index.html=index.html（左边是磁盘上的文件，右边是包内逻辑路径）',
      '只想"直接把整个目录塞进去"时，逐对写清楚更不容易错',
    ])
  }
  const source = spec.slice(0, eq)
  const dest = spec.slice(eq + 1)
  if (source === '') fail(`第 ${index} 个资源参数 \`${spec}\` 的源路径为空`)
  if (dest === '') fail(`第 ${index} 个资源参数 \`${spec}\` 的包内路径为空`)
  return { source, dest }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function run(argv) {
  const opt = parseArgs(argv)
  if (opt.help) {
    console.log(usage())
    return 0
  }

  if (opt.in === '') fail('缺少 --in（已编译好的 wasm 模块）', ['node pack-assets.mjs --help'])
  if (opt.out === '') {
    fail('缺少 --out', [
      '本脚本**绝不就地覆盖输入**：请给一个新路径，如 --out dist/app-packed.wasm',
      '顺带提醒：`go build -o 已存在文件` 不会截断旧文件、会留尾部垃圾 —— 编译产物也别就地覆盖',
    ])
  }
  if (opt.assets.length === 0) {
    fail('没有要追加的资源（至少要一个 SRC=DEST）', [
      '只想改配置（access/whitelist…）不用打包：picoaide.app.json 是随包单独提交的，不是段',
    ])
  }

  const inPath = resolve(opt.in)
  const outPath = resolve(opt.out)
  const inStat = statSync(inPath, { throwIfNoEntry: false })
  if (!inStat) fail(`--in 指向的文件不存在：${inPath}`)
  if (!inStat.isFile()) fail(`--in 不是普通文件：${inPath}`)

  // 绝不就地覆盖输入：同路径、同 realpath、同 inode（硬链接/符号链接指向同一文件）都拒。
  if (inPath === outPath) {
    fail('--out 与 --in 是同一个路径：本脚本绝不就地覆盖输入', [
      '换一个输出路径（如 --out dist/app-packed.wasm）再跑',
    ])
  }
  const outExists = existsSync(outPath)
  if (outExists) {
    const outStat = statSync(outPath)
    if (!outStat.isFile()) fail(`--out 已存在且不是普通文件：${outPath}`)
    if (outStat.dev === inStat.dev && outStat.ino === inStat.ino) {
      fail('--out 与 --in 指向同一个文件（硬链接/符号链接）：本脚本绝不就地覆盖输入')
    }
  }
  const outDir = dirname(outPath)
  if (!existsSync(outDir)) fail(`--out 的目录不存在：${outDir}`, ['先建好目录（本脚本不替你 mkdir）'])

  const input = readFileSync(inPath)
  const { customSections, budgetBytes, ignoredDebugBytes } = parseModule(input)
  const existingNames = new Set(customSections.map(s => s.name))

  // 解析 + 校验全部资源参数（先全部校验再写盘：失败时不留下半成品）。
  const planned = []
  const plannedNames = new Set()
  const specs = opt.assets.map((spec, i) => parseSpec(spec, i + 1))
  for (const { source, dest } of specs) {
    assertAssetName(dest)
    assertNotReservedOrToolchain(dest, source)
    if (plannedNames.has(dest)) {
      fail(`同一次调用里有重复的包内路径：${dest}`, ['平台对重名自定义段"只取第一个"，第二份会被静默丢弃'])
    }
    if (existingNames.has(dest)) {
      fail(`模块里已经有名为 \`${dest}\` 的自定义段（平台重名取第一个 ⇒ 你这份会被静默丢弃）`, [
        '改资源内容 = 发新版本；不要往同一个模块里叠同名段',
      ])
    }
    const sourcePath = resolve(source)
    const sourceStat = statSync(sourcePath, { throwIfNoEntry: false })
    if (!sourceStat) fail(`源文件不存在：${sourcePath}`)
    if (!sourceStat.isFile()) fail(`源路径不是普通文件：${sourcePath}`)
    const content = readFileSync(sourcePath)
    planned.push({ source: sourcePath, dest, content, ...encodeAssetSection(dest, content) })
    plannedNames.add(dest)
  }

  // 总量判据与平台同口径：**结果模块**里**计入预算的**自定义段的**负载**字节和
  // （含段名的长度前缀与段名；不含段 id 与长度前缀本身；`.debug_*` 不计）——
  // 见 limits.SectionTotalMaxBytes 与 countsTowardSectionBudget。
  const addedBytes = planned.reduce((sum, p) => sum + p.payloadBytes, 0)
  const totalBytes = budgetBytes + addedBytes
  const debugHint = ignoredDebugBytes > 0
    ? `模块里另有 ${ignoredDebugBytes} 字节的 .debug_*（DWARF）段：平台发布期会丢弃它们，不计入这 4 MiB`
    : '`.debug_*`（DWARF）调试段不计入这 4 MiB：平台发布期会丢弃它们'
  if (totalBytes > SECTION_TOTAL_MAX_BYTES) {
    fail(`自定义段总量会达到 ${totalBytes} 字节，超过平台上限 ${SECTION_TOTAL_MAX_BYTES} 字节`, [
      `已有计入预算的自定义段 ${budgetBytes} 字节（Go 产物的 name 段可能就有几十 KiB），本次要加 ${addedBytes} 字节`,
      '精简资源（HTML/JS 先 gzip 再内嵌）或删掉用不到的文件；超限平台会回 SECTION_OVERRIDE_OVERSIZE',
      debugHint + `（它们仍随模块计入 ${humanBytes(WASM_MAX_BYTES)} 的 .wasm 体积上限）`,
    ])
  }

  const packed = Buffer.concat([input, ...planned.map(p => p.section)])
  // 先写临时文件再 rename：失败不会留下半截产物，也不会动到输入。
  const tmpPath = `${outPath}.tmp-${process.pid}`
  writeFileSync(tmpPath, packed)
  renameSync(tmpPath, outPath)

  console.log(`已把 ${planned.length} 个资源追加进自定义段：${outPath}`)
  for (const p of planned) {
    console.log(`  ${p.dest}  (${humanBytes(p.content.length)}  ← ${p.source})`)
  }
  console.log(`模块 ${humanBytes(input.length)} → ${humanBytes(packed.length)}；自定义段总量 ${totalBytes} 字节 / ${SECTION_TOTAL_MAX_BYTES} 字节（${humanBytes(totalBytes)} / ${humanBytes(SECTION_TOTAL_MAX_BYTES)}；口径与平台 wasmmod.Validate 相同：.debug_* 不计）`)
  if (ignoredDebugBytes > 0) {
    console.log(`  · 另有 ${ignoredDebugBytes} 字节 .debug_*（DWARF）段不计入段总量（平台发布期丢弃；仍计入 ${humanBytes(WASM_MAX_BYTES)} 的 .wasm 体积上限）`)
  }
  console.log(`下一步：把 ${basename(outPath)} 与 picoaide.app.json 一起交给 wasm_app_validate / wasm_app_publish`)
  return 0
}

try {
  process.exitCode = run(process.argv.slice(2))
} catch (err) {
  if (err instanceof PackerError) {
    console.error(`pack-assets: ${err.message}`)
    for (const hint of err.hints) console.error(`  · ${hint}`)
  } else {
    console.error(`pack-assets: 内部错误：${err && err.stack ? err.stack : err}`)
  }
  process.exitCode = 1
}
