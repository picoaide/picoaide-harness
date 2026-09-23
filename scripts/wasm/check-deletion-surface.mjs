#!/usr/bin/env node
/**
 * 删除面 / 包清单 / 旧能力指纹（2026-09-23 第三轮审计 W-1 的修法）。
 *
 * **为什么必须有这条判据**（W-1a / W-1b 两个已复现的假绿）：
 *   1. 「删除面」原先是 `scripts/verify-wasm-client-only.sh` 里 4 条**字面量路径**的
 *      `[ -e ]`：`mv server/internal/wasmapp server/wasmapp-legacy` 之后，4 条
 *      「删除面不存在」全部**真空成立**并打印 PASS，EXIT=0；同时残留扫描的
 *      「五桶」计数同步缩水（B 34→20、C 479→381）—— 预算按"扫到的集合"算，
 *      **缩小覆盖面反而让门禁更好过**。
 *   2. 「零残留」判的是 2026-09-19 那份**词汇表**：换个名字重新实现同一能力
 *      （按 Host 反查 app_id + 一次性换票 Cookie）不会命中任何一条正则，EXIT=0。
 *
 * 修法（一律 fail-loud，判据真源 = `scripts/wasm/wasm-gate-inventory.json`）：
 *   A. 删除面清单驱动：逐条断言 absent（路径/glob），并回头断言设计总纲 §8.4 里
 *      **仍有**该条目的 anchor —— 文档与清单脱钩时门禁自己红，而不是继续拿旧清单通过。
 *   B. 包清单**双向**断言：`server/internal/wasmapp` 下"含 .go 的目录集合"必须
 *      逐字等于登记清单。树被搬走（登记了却不在）、被删空、或新增/改名一个包
 *      （在却没登记）都会红 —— 后者正是 W-1b 的形态。
 *   C. 旧能力**结构指纹**：不看名字看语义形状（按 Host 分发、换票 Cookie、入口路由
 *      字面量、应用 origin/基域型 env 名）。命中即红，除非在 inventory 的
 *      `capabilityAllowlist` 里**逐条登记**（带理由；登记项必须存在且仍然命中，
 *      否则算陈旧登记 ⇒ 红）。
 *
 * 用法：node scripts/wasm/check-deletion-surface.mjs
 * 退出码：0 = 删除面干净、包清单一致、无未登记的旧能力指纹；1 = 任一不满足（逐条打印）。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const INVENTORY_PATH = join(ROOT, 'scripts/wasm/wasm-gate-inventory.json')
const REL = path => path.replace(`${ROOT}/`, '')

const failures = []
function ok(message) {
  console.log(`  PASS ${message}`)
}
function bad(message) {
  failures.push(message)
  console.error(`  FAIL ${message}`)
}

console.log('== 删除面 / 包清单 / 旧能力指纹（§8.4 真源驱动；W-1 的修法）')

// ---------------------------------------------------------------------------
// 0. 真源文件：缺了/坏了都不得当通过（默认值 = 静默放宽，正是要消灭的东西）
// ---------------------------------------------------------------------------
if (!existsSync(INVENTORY_PATH)) {
  console.error(`  FAIL 判据真源缺失：${REL(INVENTORY_PATH)}（没有它就没有删除面/包清单/登记表）`)
  process.exit(1)
}
let inventory
try {
  inventory = JSON.parse(readFileSync(INVENTORY_PATH, 'utf8'))
} catch (cause) {
  console.error(`  FAIL 判据真源无法解析：${REL(INVENTORY_PATH)}：${cause.message}`)
  process.exit(1)
}

function requireInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    bad(`判据真源字段非法：${label} = ${JSON.stringify(value)}（必须是非负整数）`)
    return null
  }
  return value
}

// ---------------------------------------------------------------------------
// A. 删除面（清单驱动 + 文档 anchor 反查）
// ---------------------------------------------------------------------------
const design = inventory.design ?? {}
const docPath = join(ROOT, design.doc ?? '')
if (!existsSync(docPath)) {
  bad(`设计总纲不存在：${design.doc}（删除面的真源缺失 ⇒ 清单无从校验）`)
} else {
  const doc = readFileSync(docPath, 'utf8')
  const heading = design.section ?? ''
  const start = doc.indexOf(heading)
  if (start < 0) {
    bad(`设计总纲里找不到小节 ${JSON.stringify(heading)}（${design.doc}）—— 真源章节被改名/删除`)
  }
  const rest = start < 0 ? '' : doc.slice(start + heading.length)
  const nextHeading = rest.indexOf('\n### ')
  const section = nextHeading < 0 ? rest : rest.slice(0, nextHeading)

  const absentPaths = inventory.deletionSurface?.absentPaths ?? []
  const absentGlobs = inventory.deletionSurface?.absentGlobs ?? []
  if (absentPaths.length === 0 && absentGlobs.length === 0) {
    bad('删除面清单是空的 —— 空清单等于没有判据（拒绝空集通过）')
  }
  let clean = 0
  for (const entry of [...absentPaths, ...absentGlobs]) {
    const target = entry.path ?? entry.glob
    if (typeof target !== 'string' || typeof entry.anchor !== 'string') {
      bad(`删除面条目形状非法（需要 path/glob + anchor）：${JSON.stringify(entry)}`)
      continue
    }
    if (start >= 0 && !section.includes(entry.anchor)) {
      bad(`删除面条目与设计总纲 §8.4 脱钩：清单写了 ${target}，但 ${design.doc} 的该节里已找不到 anchor `
        + `${JSON.stringify(entry.anchor)} —— 要么补回文档，要么同步清单（不得只改一边）`)
      continue
    }
    if (entry.path !== undefined) {
      if (existsSync(join(ROOT, entry.path))) {
        bad(`删除面仍存在：${entry.path}（${entry.reason ?? '§8.4'}）`)
      } else {
        clean += 1
      }
    } else {
      const matched = globMatch(entry.glob)
      if (matched.length > 0) {
        bad(`删除面仍存在：${entry.glob} 命中 ${matched.length} 个文件（${matched.slice(0, 5).join(' ')}；${entry.reason ?? '§8.4'}）`)
      } else {
        clean += 1
      }
    }
  }
  if (clean === [...absentPaths, ...absentGlobs].length && clean > 0) {
    ok(`删除面 ${clean} 条全部不存在，且逐条与设计总纲 §8.4 的 anchor 对得上（清单驱动，不再靠目录在不在）`)
  }
}

/** 只支持 `*`（不跨目录）的 glob —— 删除面清单只用到这一种形态。 */
function globMatch(pattern) {
  const dir = join(ROOT, pattern.slice(0, pattern.lastIndexOf('/')))
  const base = pattern.slice(pattern.lastIndexOf('/') + 1)
  if (!existsSync(dir)) return []
  const escaped = base.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '[^/]*')
  const re = new RegExp(`^${escaped}$`, 'u')
  return readdirSync(dir).filter(name => re.test(name)).map(name => `${REL(dir)}/${name}`)
}

// ---------------------------------------------------------------------------
// B. 包清单双向断言（树被搬走 / 被删空 / 新增改名都会红）
// ---------------------------------------------------------------------------
const inventorySpec = inventory.packageInventory ?? {}
const pkgRoot = join(ROOT, inventorySpec.root ?? '')
const excludeDirNames = new Set(inventorySpec.excludeDirNames ?? ['testdata'])
function goPackageDirs(root) {
  const found = []
  const walk = dir => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const hasGo = entries.some(entry => entry.isFile() && entry.name.endsWith('.go'))
    if (hasGo) found.push(REL(dir))
    for (const entry of entries) {
      if (!entry.isDirectory() || excludeDirNames.has(entry.name)) continue
      walk(join(dir, entry.name))
    }
  }
  walk(root)
  return found
}
if (!existsSync(pkgRoot)) {
  bad(`包清单根目录不存在：${inventorySpec.root}（树被搬走/改名 ⇒ §8.4 的"删除面不存在"会真空成立；这正是 W-1a）`)
} else {
  const registered = new Set((inventorySpec.packages ?? []).map(name => `${inventorySpec.root}/${name}`.replace(/\/+/gu, '/')))
  if (registered.size === 0) bad(`包清单为空：${inventorySpec.root} 下必须有登记清单（空清单等于没有判据）`)
  const onDisk = new Set(goPackageDirs(pkgRoot))
  const missing = [...registered].filter(path => !onDisk.has(path))
  const unregistered = [...onDisk].filter(path => !registered.has(path))
  for (const path of missing) {
    bad(`登记的包不在磁盘上：${path}（树被搬走/包被删？§8.4 的删除面判据在父目录改名时会真空成立）`)
  }
  for (const path of unregistered) {
    bad(`未登记的包：${path} —— 新增/改名的包必须在 ${REL(INVENTORY_PATH)} 的 packageInventory.packages 里登记`
      + `（换个名字重新实现同一能力正是 W-1b 的形态；登记 = 一个进 diff 的有意识动作）`)
  }
  if (missing.length === 0 && unregistered.length === 0 && registered.size > 0) {
    ok(`包清单双向一致：${inventorySpec.root} 下 ${onDisk.size} 个包 == 登记的 ${registered.size} 个（多一个/少一个都红）`)
  }
}

// ---------------------------------------------------------------------------
// C. 旧能力结构指纹（不看名字看形状）+ 逐条登记
// ---------------------------------------------------------------------------
const CAPABILITIES = [
  {
    key: 'legacy-host-dispatch',
    label: '按请求 Host 反查应用（子域/后缀分发）',
    why: '旧模型的入口：用请求 Host 的后缀匹配反推 app_id（新模型里 app_id 来自路由路径，绝不从 Host 反解）',
    test: source => RE_HOST_READ.test(source) && RE_HOST_MINE.test(source),
  },
  {
    key: 'legacy-ticket-cookie',
    label: '应用平台树里的一次性换票 Cookie',
    why: '旧模型用 Set-Cookie 换票把身份交给应用子域；新模型身份只来自员工 bearer',
    scope: /^server\/(?:internal\/wasmapp|cmd)\//u,
    test: source => /SetCookie\s*\(/u.test(source) && /ticket/iu.test(source),
  },
  {
    key: 'legacy-entry-route',
    label: '应用入口路由字面量（/entry… 或 ServeEntry）',
    why: '§8.4 删掉的入口形态：浏览器式入口路由（新模型入口是客户端 scheme + 本机 loopback 路由）',
    test: source => /["'`]\/entry[/"'`?]/u.test(source) || /\bServeEntry\b/u.test(source),
  },
  {
    key: 'legacy-app-origin-env',
    label: '应用 origin / 基域型环境变量名',
    why: '§8.4 的配置面：PICOAI_*ORIGIN*/BASE_DOMAIN/APPS_DOMAIN 这类"应用对外主机名"开关（PICOAI_TRUSTED_HOSTS 是 OIDC 部署面，不属此列）',
    test: source => /PICOAI_[A-Z0-9_]*(?:ORIGIN|BASE_DOMAIN|APPS?_DOMAIN)[A-Z0-9_]*/u.test(source),
  },
]
// R1：从**入站请求**读 Host；R2：把 Host 当**域名后缀**来切（第二个操作数带 suffix/domain/origin）。
// 两条同时成立才算指纹 —— 单独读 Host（自身源拼装、loopback 判定）是新模型的正常写法。
const RE_HOST_READ = /(?:^|[^.\w])(?:r|req|request)\.Host\b|c\.Request\.Host\b/u
const RE_HOST_MINE = /(?:TrimSuffix|HasSuffix|TrimPrefix|HasPrefix|CutSuffix|CutPrefix)\s*\([^)\n]*\b(?:host|Host)\b[^)\n]*,\s*[^)\n]{0,60}?(?:[Ss]uffix|[Dd]omain|[Oo]rigin)[^)\n]{0,40}?\)|SplitN\s*\(\s*\w*[Hh]ost\w*\s*,\s*"\."\s*,/u

const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'server'], {
  cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
})
if (listed.status !== 0) {
  bad(`git ls-files 失败（rc=${listed.status}）：${(listed.stderr ?? '').trim()} —— 判据自己坏了不得当通过`)
}
const goFiles = (listed.stdout ?? '').split('\n').filter(Boolean)
  .filter(file => file.endsWith('.go') && !file.endsWith('_test.go'))

const allowlist = inventory.capabilityAllowlist?.entries ?? []
const allowBudget = requireInteger(inventory.budgetAllowlist ?? inventory.budgets?.capabilityAllowlist, 'budgets.capabilityAllowlist')
const allowKeys = new Set()
for (const entry of allowlist) {
  if (typeof entry.file !== 'string' || typeof entry.capability !== 'string' || typeof entry.reason !== 'string' || entry.reason.trim() === '') {
    bad(`capabilityAllowlist 条目形状非法（需要 file/capability/reason）：${JSON.stringify(entry)}`)
    continue
  }
  if (!existsSync(join(ROOT, entry.file))) {
    bad(`capabilityAllowlist 登记的文件不存在（陈旧登记，请删除）：${entry.file}`)
    continue
  }
  const capability = CAPABILITIES.find(candidate => candidate.key === entry.capability)
  if (capability === undefined) {
    bad(`capabilityAllowlist 登记的指纹名未知：${entry.capability}（可选：${CAPABILITIES.map(c => c.key).join(', ')}）`)
    continue
  }
  allowKeys.add(`${entry.capability}::${entry.file}`)
}
if (allowBudget !== null && allowlist.length > allowBudget) {
  bad(`capabilityAllowlist 有 ${allowlist.length} 条 > 上限 ${allowBudget}：登记不是无上限白名单（要加就显式改 budgets.capabilityAllowlist 并说明）`)
}

const hits = []
const staleRegistrations = new Set(allowKeys)
for (const file of goFiles) {
  if (!file.startsWith('server/')) continue
  let source
  try {
    source = readFileSync(join(ROOT, file), 'utf8')
  } catch {
    continue
  }
  for (const capability of CAPABILITIES) {
    if (capability.scope !== undefined && !capability.scope.test(file)) continue
    if (!capability.test(source)) continue
    hits.push({ file, capability })
    staleRegistrations.delete(`${capability.key}::${file}`)
  }
}
for (const key of staleRegistrations) {
  const [capability, file] = key.split('::')
  bad(`capabilityAllowlist 登记已失效（该文件不再命中指纹 ${capability}）：${file} —— 陈旧登记必须删除，否则登记表会腐烂成永久豁免`)
}
const unregistered = hits.filter(hit => !allowKeys.has(`${hit.capability.key}::${hit.file}`))
for (const hit of unregistered) {
  bad(`旧能力指纹命中且未登记：${hit.capability.label} —— ${hit.file}`
    + `（${hit.capability.why}；如确认与旧模型无关，在 ${REL(INVENTORY_PATH)} 的 capabilityAllowlist 里登记并写理由）`)
}
if (unregistered.length === 0 && staleRegistrations.size === 0) {
  ok(`旧能力指纹零未登记命中（${CAPABILITIES.length} 类结构指纹：${CAPABILITIES.map(c => c.key).join(', ')}；登记 ${allowlist.length} 条 ≤ ${allowBudget ?? '?'}）`)
}

console.log('')
if (failures.length > 0) {
  console.error(`删除面判据未通过：${failures.length} 条`)
  process.exit(1)
}
console.log('删除面 / 包清单 / 旧能力指纹全部通过 ✅')
