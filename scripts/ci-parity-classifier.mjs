#!/usr/bin/env node
/**
 * scripts/ci-parity-classifier.mjs — **逐字抽出的 CI docs-only 分类器** + 判定矩阵
 * （第三十三轮 FIX-48⑤，判据本体由 `scripts/check-ci-parity.mjs` 的第 1 步驱动）。
 *
 * ## 为什么是"抽出 + 矩阵"而不是"抄一份逻辑"
 *
 * `.github/workflows/ci.yml` 的 `changes` job 决定 gate / server / 三平台 / release 要不要跑。
 * 它一旦把"代码改动"误判成 docs-only，**整条流水线零门禁通过**（第三轮审计 R3-C 的现场：
 * 旧写法 `docs/*|site/*|*.md` 里的 `*` 跨 `/`，于是 `server/skills` 下那些随包交付的
 * 文档也被算成文档面）。这条判据在本地没有任何等价物，所以本脚本：
 *
 *   1. 从 ci.yml 的 `changes` job 里**逐字抽出**那段 `run:` 块（GitHub 表达式换成 env 变量）
 *      —— 抽出的副本由 `scripts/check-ci-parity.mjs` 写在 `temp/ci-parity/extracted/`；
 *   2. 在一个**合成 git 仓库**里真跑 12 格：8 格 push 形态的路径分类 + 4 格 tag / fail-safe
 *      形态（tag 恒 code=true、`before` 全零恒 true、空 diff 恒 true、预发 tag 恒 true）。
 *
 * 手抄一份分类逻辑 = 下一次 CI 改了它就分叉，而"分叉的本地判据"比没有判据更坏
 * （它会以本地绿给出错误的安心感）。
 *
 * ## 用法
 *
 * ```
 * node scripts/ci-parity-classifier.mjs                     # 用默认抽出路径
 * node scripts/ci-parity-classifier.mjs --classifier <path> # 指定抽出的分类器
 * ```
 * 退出码：0 = 12 格全部符合期望；1 = 有格子不符（逐格打印 `BAD`）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 抽出的分类器（由 check-ci-parity.mjs 写；也可用 --classifier 指定）。 */
const argv = process.argv.slice(2)
const flagAt = argv.indexOf('--classifier')
const CLASSIFIER = flagAt >= 0
  ? argv[flagAt + 1]
  : join(ROOT, 'temp', 'ci-parity', 'extracted', 'ci-changes-scope.sh')

if (!existsSync(CLASSIFIER)) {
  console.error(`ci-parity-classifier: 找不到抽出的分类器 ${CLASSIFIER} ——`
    + ' 请先跑 `node scripts/check-ci-parity.mjs`（它负责从 ci.yml 逐字抽出）')
  process.exit(2)
}

/**
 * push 形态的分类矩阵：`[标签, 期望 code, 改动文件…]`。
 *
 * 期望值取自分类器自己的**书面口径**（抽出的正文里有那段注释，改宽改窄都该在这里被看见）：
 * `docs/**`、`site/**` 与**仓库根** markdown 是文档面；任何**含 `/` 的其他路径**是代码
 * （`server/skills` 与 `packages` 下的 `.md` 这类随包文档，判据在 Go 测试与包 check 里
 * ⇒ 判成 docs-only 就等于把它们整片跳过）；其余是代码。
 */
const PUSH_CASES = [
  ['只改 docs/**', 'false', ['docs/a.md']],
  ['只改 site/**', 'false', ['site/a.md']],
  ['只改仓库根 markdown', 'false', ['CONTRIBUTING.md']],
  ['改 docs/** + 根 md', 'false', ['docs/a.md', 'README.md']],
  ['改 server/skills 下的 .md（随包文档，判据在 Go 测试里）', 'true', ['server/skills/x.md']],
  ['改 packages 下的 .md（随包文档，判据在包 check 里）', 'true', ['packages/host/desktop/x.md']],
  ['docs 夹一个 .go', 'true', ['docs/a.md', 'server/main.go']],
  ['只改非 md 非 docs', 'true', ['scripts/x.mjs']],
]

/** 非 push 形态：`[标签, 期望 code, env 覆盖]`。 */
const SAFE_CASES = [
  ['tag（正式）→ 一律按有代码改动处理', 'true', { GITHUB_REF: 'refs/tags/v0.0.0' }],
  ['tag（预发）→ 同上', 'true', { GITHUB_REF: 'refs/tags/v0.0.0-beta.1' }],
  ['before 全零（强推/新建分支）→ fail-safe true', 'true', { BEFORE_SHA: '0'.repeat(40) }],
  ['空 diff（无改动）→ fail-safe true', 'true', { SAME_HEAD: '1' }],
]

const workdir = mkdtempSync(join(ROOT, 'temp', 'ci-parity-classifier-'))
const repo = join(workdir, 'repo')
mkdirSync(repo, { recursive: true })

/** 跑一条 git 命令（失败即抛，避免"合成仓库半成品"被当成判定结果）。 */
function git(args, options = {}) {
  const result = spawnSync('git', args, { cwd: options.cwd ?? repo, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败：${result.stderr?.trim() ?? ''}`)
  }
  return (result.stdout ?? '').trim()
}

git(['init', '-q', '-b', 'main', '.'])
git(['config', 'user.email', 'ci-parity@example.invalid'])
git(['config', 'user.name', 'ci parity'])
for (const dir of ['docs', 'site', 'server/skills', 'packages/host/desktop']) {
  mkdirSync(join(repo, dir), { recursive: true })
}
writeFileSync(join(repo, 'README.md'), 'seed\n')
git(['add', '-A'])
git(['commit', '-qm', 'seed'])
const baseSha = git(['rev-parse', 'HEAD'])

const failures = []
let observed = 0
const classifierHash = spawnSync('sha256sum', [CLASSIFIER], { encoding: 'utf8' }).stdout?.split(' ')[0] ?? '?'
console.log(`ci-parity-classifier: 分类器 ${CLASSIFIER.replace(`${ROOT}/`, '')}（sha256 ${classifierHash.slice(0, 16)}…）`)
console.log('')

/** 真跑一次分类器，返回它写出的 `code=` 值。 */
function classify(env) {
  const out = join(workdir, `out-${Math.random().toString(36).slice(2)}`)
  writeFileSync(out, '')
  const result = spawnSync('/bin/bash', [CLASSIFIER], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_REF: 'refs/heads/main',
      GITHUB_EVENT_NAME: 'push',
      BEFORE_SHA: baseSha,
      GITHUB_SHA: baseSha,
      ...env,
      GITHUB_OUTPUT: out,
    },
  })
  if (result.status !== 0) throw new Error(`分类器退出码 ${String(result.status)}：${result.stderr?.trim() ?? ''}`)
  const text = readFileSync(out, 'utf8')
  rmSync(out, { force: true })
  const code = /^code=(.*)$/mu.exec(text)?.[1]?.trim()
  if (code === undefined) throw new Error(`分类器没有写出 code=：${JSON.stringify(text)}`)
  return code
}

for (const [label, want, files] of PUSH_CASES) {
  git(['checkout', '-q', 'main'])
  git(['reset', '-q', '--hard', baseSha])
  git(['clean', '-qfd'])
  for (const file of files) {
    mkdirSync(join(repo, dirname(file)), { recursive: true })
    writeFileSync(join(repo, file), 'x\n')
  }
  git(['add', '-A'])
  git(['commit', '-qm', label])
  const head = git(['rev-parse', 'HEAD'])
  const code = classify({ GITHUB_SHA: head })
  observed += 1
  const ok = code === want
  if (!ok) failures.push(label)
  console.log(`${ok ? 'OK  ' : 'BAD '} ${label.padEnd(44)} files=${files.join(',').padEnd(38)} code=${code}`
    + ` docs-only=${code === 'false' ? 'true' : 'false'}`)
}

console.log('')
console.log('### 非 push 形态（tag / fail-safe）')
for (const [label, want, env] of SAFE_CASES) {
  const overrides = { ...env }
  if (overrides.SAME_HEAD !== undefined) {
    delete overrides.SAME_HEAD
    overrides.BEFORE_SHA = baseSha
    overrides.GITHUB_SHA = baseSha
  }
  const code = classify(overrides)
  observed += 1
  const ok = code === want
  if (!ok) failures.push(label)
  console.log(`${ok ? 'OK  ' : 'BAD '} ${label.padEnd(44)} code=${code}`)
}

rmSync(workdir, { recursive: true, force: true })
console.log('')
if (failures.length > 0) {
  console.error(`ci-parity-classifier: ${observed - failures.length}/${observed} 格符合期望；`
    + `不符：${failures.join(' / ')}`)
  console.error('  ⇒ 分类器的判定矩阵与书面口径分叉了（改宽或改窄都会让整条流水线跳过整片判据）。')
  process.exit(1)
}
console.log(`ci-parity-classifier: ${observed}/${observed} 格符合期望 ✅`
  + '（docs/site/根 md = 文档面；其余一律代码面；tag 与 fail-safe 恒 code=true）')
