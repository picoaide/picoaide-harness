#!/usr/bin/env node
/**
 * CI 渠道脚本的回归门禁。
 *
 * 为什么值得单独测:`scripts/ci-channels.sh` 与 `scripts/ci-package-clients.sh`
 * 决定**发哪些渠道、发到哪、以及渠道信息会不会进公开日志**。这三件事出错都是
 * 静默的(发错镜像 / 漏发渠道 / 客户名进了公开 Actions 日志),而且它们在
 * GitHub Actions 里才真正运行 —— 本地没有门禁就只能靠发版时踩。
 *
 * 覆盖:
 *   1. tag → 渠道集策略(正式 tag 全发、beta tag 只发 beta、非 tag 只发 official)
 *   2. 渠道枚举的掩码与定序(official 置顶)、不合规目录被跳过且**不打印名字**
 *   3. 缺 token / 渠道仓结构不符 / 缺 channel.json → fail-loud
 *   4. 逐渠道打包:官方保留完整日志、渠道输出被抑制、失败只报中性信息
 *   5. 产物归集到 client-assets/<channel>/,没产出即失败
 *
 * 用法:node scripts/verify-ci-scripts.mjs
 * 退出码:0 全部通过;1 有断言失败。
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const channelsScript = join(root, 'scripts', 'ci-channels.sh')
const packageScript = join(root, 'scripts', 'ci-package-clients.sh')
const failures = []
const scratch = []

function fail(message) {
  failures.push(message)
  process.stderr.write(`verify-ci-scripts: ${message}\n`)
}

function check(condition, message) {
  if (!condition) fail(message)
  return condition
}

/** 造一个临时目录(进程退出时清理)。 */
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

/** 造一个假的私有渠道仓:`<root>/channels/<id>/channel.json`。 */
function fakeChannelRepo(ids, options = {}) {
  const dir = tempDir('ci-channels-repo-')
  for (const id of ids) {
    mkdirSync(join(dir, 'channels', id), { recursive: true })
    writeFileSync(join(dir, 'channels', id, 'channel.json'), JSON.stringify({ schema: 1, channel_id: id }))
  }
  for (const extra of options.extraDirectories ?? []) {
    mkdirSync(join(dir, 'channels', extra), { recursive: true })
  }
  return dir
}

/** 跑 ci-channels.sh。 */
function runChannels({ source, refName = '', dest, list, env = {} }) {
  const cwd = tempDir('ci-channels-run-')
  const result = spawnSync('bash', [channelsScript, '--dest', dest, '--list', join(cwd, list)], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      ...(source === undefined ? {} : { CI_CHANNELS_SOURCE: source }),
      GITHUB_REF_NAME: refName,
      ...env,
    },
  })
  const listPath = join(cwd, list)
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    selected: existsSync(listPath)
      ? readFileSync(listPath, 'utf8').split('\n').filter(line => line !== '')
      : [],
    listPath,
  }
}

// ---- 1. tag → 渠道集策略 ----
{
  const source = fakeChannelRepo(['official', 'beta', 'acme-corp', 'zeta'])
  const repoTag = runChannels({ source, refName: 'v2.7.0', dest: 'channels', list: 'a.list' })
  check(repoTag.status === 0, '正式 tag 应成功')
  check(
    JSON.stringify(repoTag.selected) === JSON.stringify(['official', 'acme-corp', 'beta', 'zeta']),
    `正式 tag 应发全部渠道且 official 置顶,实际 ${JSON.stringify(repoTag.selected)}`,
  )

  const betaTag = runChannels({ source, refName: 'v2.7.0-beta.3', dest: 'channels', list: 'b.list' })
  check(
    JSON.stringify(betaTag.selected) === JSON.stringify(['beta']),
    `beta tag 应只发 beta,实际 ${JSON.stringify(betaTag.selected)}`,
  )

  const branch = runChannels({ source, refName: '', dest: 'channels', list: 'c.list' })
  check(
    JSON.stringify(branch.selected) === JSON.stringify(['official']),
    `非 tag 应只发 official,实际 ${JSON.stringify(branch.selected)}`,
  )
}

// ---- 2. 掩码 / 跳过不合规目录 / 不回显名字 ----
{
  const source = fakeChannelRepo(['official', 'acme-corp'], { extraDirectories: ['README', 'Bad_Name'] })
  const result = runChannels({ source, refName: 'v2.7.0', dest: 'channels', list: 'd.list' })
  check(result.status === 0, '含不合规目录时仍应成功(跳过而非失败)')
  check(result.stdout.includes('::add-mask::acme-corp'), '每个渠道 id 都必须 add-mask')
  check(result.stdout.includes('::add-mask::official'), 'official 也必须 add-mask')
  check(!result.stdout.includes('README'), '被跳过的目录名不得出现在输出里')
  check(!result.stdout.includes('Bad_Name'), '不合规目录名不得出现在输出里')
  check(result.stderr.includes('已跳过'), '跳过不合规目录时应给出计数告警')
  check(
    JSON.stringify(result.selected) === JSON.stringify(['official', 'acme-corp']),
    `不合规目录不得进入构建列表,实际 ${JSON.stringify(result.selected)}`,
  )
}

// ---- 3. fail-loud 分支 ----
{
  const noToken = runChannels({ source: undefined, refName: 'v2.7.0', dest: 'channels', list: 'e.list' })
  check(noToken.status !== 0, '没有渠道仓令牌时必须失败(不得静默按官方发)')
  check(noToken.stderr.includes('CHANNELS_REPO_TOKEN'), '失败信息应指明缺失的 secret')

  const wrongStructure = tempDir('ci-channels-bad-')
  mkdirSync(join(wrongStructure, 'not-channels'), { recursive: true })
  const bad = runChannels({ source: wrongStructure, refName: 'v2.7.0', dest: 'channels', list: 'f.list' })
  check(bad.status !== 0, '渠道仓结构不符时必须失败')

  // 正式 tag 选中的渠道在仓里缺 channel.json → 必须失败(不是"跳过")
  const missingConfig = tempDir('ci-channels-missing-')
  mkdirSync(join(missingConfig, 'channels', 'official'), { recursive: true })
  writeFileSync(join(missingConfig, 'channels', 'official', 'channel.json'), '{"schema":1,"channel_id":"official"}')
  mkdirSync(join(missingConfig, 'channels', 'beta'), { recursive: true }) // 无 channel.json
  const missing = runChannels({ source: missingConfig, refName: 'v2.7.0', dest: 'channels', list: 'g.list' })
  check(missing.status !== 0, '选中渠道缺 channel.json 时必须失败')
}

// ---- 4/5. 逐渠道打包:日志抑制、失败中性、产物归集 ----
{
  const runDir = tempDir('ci-package-run-')
  const stage = join(runDir, 'stage')
  const list = join(runDir, 'ch.list')
  writeFileSync(list, 'official\nacme-corp\n')

  // 假打包器:回显渠道名并产出两种文件;渠道名出现在**输出**里,
  // 真实 CI 中会被 ::add-mask:: 抹掉,这里只断言"渠道构建不输出"这一层。
  const stub = join(runDir, 'stub.sh')
  writeFileSync(stub, `#!/usr/bin/env bash
echo "building for \${DSH_BUILD_CHANNEL}"
mkdir -p "${root}/packages/host/desktop/dist"
echo x > "${root}/packages/host/desktop/dist/App-\${DSH_BUILD_CHANNEL}.AppImage"
echo y > "${root}/packages/host/desktop/dist/App-\${DSH_BUILD_CHANNEL}.deb"
`)
  execFileSync('chmod', ['+x', stub])

  const ok = spawnSync('bash', [
    packageScript, '--list', list, '--stage-dir', stage, '--patterns', '*.AppImage *.deb', '--', stub,
  ], { cwd: root, encoding: 'utf8' })
  check(ok.status === 0, `逐渠道打包应成功,实际退出 ${String(ok.status)}`)
  check((ok.stdout ?? '').includes('building for official'), '官方渠道必须保留完整日志(排障基准)')
  check(!(ok.stdout ?? '').includes('building for acme-corp'), '渠道构建的输出不得出现在日志里')
  check(existsSync(join(stage, 'official', 'App-official.AppImage')), '官方产物应归集到 client-assets/<channel>/')
  check(existsSync(join(stage, 'acme-corp', 'App-acme-corp.deb')), '渠道产物应归集到自己的目录')

  // 渠道构建失败 → 只报中性信息,不回显渠道名与命令输出
  // 秘密标记只在**渠道**那一轮打印:官方轮是允许输出日志的。
  const failStub = join(runDir, 'fail.sh')
  writeFileSync(failStub, `#!/usr/bin/env bash
if [ "\${DSH_BUILD_CHANNEL}" != "official" ]; then
  echo "SECRET-CHANNEL-DETAIL"
  echo "\${DSH_BUILD_CHANNEL}" >&2
  exit 3
fi
mkdir -p "${root}/packages/host/desktop/dist"
echo x > "${root}/packages/host/desktop/dist/App.AppImage"
`)
  execFileSync('chmod', ['+x', failStub])
  const stage2 = join(runDir, 'stage2')
  const failed = spawnSync('bash', [
    packageScript, '--list', list, '--stage-dir', stage2, '--patterns', '*.AppImage', '--', failStub,
  ], { cwd: root, encoding: 'utf8' })
  check(failed.status !== 0, '渠道打包失败必须让步骤失败')
  // `::add-mask::<id>` 这一行本身含渠道 id —— 那是掩码指令(GitHub 不会把它
  // 回显进公开日志),比对时先剔除,只看真正的输出行。
  const failureLines = `${failed.stdout ?? ''}${failed.stderr ?? ''}`
    .split('\n')
    .filter(line => !line.startsWith('::add-mask::'))
    .join('\n')
  check(!failureLines.includes('SECRET-CHANNEL-DETAIL'), '失败时不得回显渠道构建的输出')
  check(!failureLines.includes('acme-corp'), '失败信息里不得出现渠道名')
  check(failureLines.includes('官方构建'), '失败信息应指引去看官方构建的日志')
}

// ---- 6. 所有 CI shell 脚本必须能通过 bash -n ----
// 2026-09-10 的教训:两处未闭合引号让整个 release job 跑不起来,而 YAML 本身
// 完全合法 —— 只有 bash 解析整段脚本时才会发现。这里把 scripts/ 下的 shell
// 脚本全部过一遍,避免同类错误再次静默进入发布链。
{
  const scriptDir = join(root, 'scripts')
  const shells = readdirSync(scriptDir).filter(name => name.endsWith('.sh'))
  check(shells.length > 0, 'scripts/ 下应有 CI shell 脚本')
  for (const name of shells) {
    const result = spawnSync('bash', ['-n', join(scriptDir, name)], { encoding: 'utf8' })
    check(result.status === 0, `scripts/${name} 未通过 bash -n: ${(result.stderr ?? '').trim()}`)
  }
}

for (const dir of scratch) rmSync(dir, { recursive: true, force: true })

if (failures.length > 0) {
  process.stderr.write(`\nverify-ci-scripts: ${failures.length} 项断言失败\n`)
  process.exit(1)
}
process.stdout.write('verify-ci-scripts: OK — 渠道发现/掩码/策略/日志抑制/产物归集全部符合预期\n')
