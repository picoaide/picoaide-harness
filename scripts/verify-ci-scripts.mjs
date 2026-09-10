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
 *   6. 更新服务器(R2)发布:每渠道独立目录、清单内容、保留最近 3 版、
 *      缓存头(资产 immutable / 清单 no-cache)、清单最后写、缺 secrets 跳过、
 *      产物不全 fail-loud —— 这些出错都是静默的,只能在发版时才发现
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
const publishScript = join(root, 'scripts', 'ci-publish-update-server.sh')
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
    // 品牌字段是**必需**的(ci-channels.sh 里 fail-loud):客户端在登录之前就要
    // 显示品牌,包里没写就回落中性占位。夹具默认带上,另有用例专测缺失时的中止。
    writeFileSync(join(dir, 'channels', id, 'channel.json'), JSON.stringify({
      schema: 1,
      channel_id: id,
      identity: { display_name: `${id} AI`, short_name: id },
    }))
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
  writeFileSync(join(missingConfig, 'channels', 'official', 'channel.json'),
    '{"schema":1,"channel_id":"official","identity":{"display_name":"Official","short_name":"Official"}}')
  mkdirSync(join(missingConfig, 'channels', 'beta'), { recursive: true }) // 无 channel.json
  const missing = runChannels({ source: missingConfig, refName: 'v2.7.0', dest: 'channels', list: 'g.list' })
  check(missing.status !== 0, '选中渠道缺 channel.json 时必须失败')

  // 渠道包缺品牌字段 → 必须**中止构建**:客户端登录页/侧边栏在服务端不可达时
  // 回落中性占位,交付出去就是观感事故,而这类事故只能在构建期拦。
  const branded = tempDir('ci-channels-brand-')
  mkdirSync(join(branded, 'channels', 'official'), { recursive: true })
  writeFileSync(join(branded, 'channels', 'official', 'channel.json'),
    '{"schema":1,"channel_id":"official","identity":{"display_name":"Official","short_name":"Official"}}')
  mkdirSync(join(branded, 'channels', 'acme-corp'), { recursive: true })
  writeFileSync(join(branded, 'channels', 'acme-corp', 'channel.json'), '{"schema":1,"channel_id":"acme-corp"}')
  const noBrand = runChannels({ source: branded, refName: 'v2.7.0', dest: 'channels', list: 'h.list' })
  check(noBrand.status !== 0, '渠道包缺品牌字段时必须失败')
  check(noBrand.stderr.includes('品牌字段'), '失败信息应指明缺的是品牌字段')
  check(noBrand.stderr.includes('identity.display_name'), '失败信息应列出缺失的具体字段')
  check(!noBrand.stderr.includes('acme-corp'), '品牌缺失的报错不得回显渠道名')

  // 只有 display_name、没有 short_name 也要中止(登录页名字的直接来源)
  const halfBranded = tempDir('ci-channels-brand-half-')
  mkdirSync(join(halfBranded, 'channels', 'official'), { recursive: true })
  writeFileSync(join(halfBranded, 'channels', 'official', 'channel.json'),
    '{"schema":1,"channel_id":"official","identity":{"display_name":"Official"}}')
  const half = runChannels({ source: halfBranded, refName: 'v2.7.0', dest: 'channels', list: 'i.list' })
  check(half.status !== 0, '只配 display_name 也必须失败')
  check(half.stderr.includes('identity.short_name'), '失败信息应点明缺 short_name')

  // 空白字符串不算配置(与客户端 nonEmpty 口径一致)
  const blank = tempDir('ci-channels-brand-blank-')
  mkdirSync(join(blank, 'channels', 'official'), { recursive: true })
  writeFileSync(join(blank, 'channels', 'official', 'channel.json'),
    '{"schema":1,"channel_id":"official","identity":{"display_name":"   ","short_name":"Official"}}')
  const blankRun = runChannels({ source: blank, refName: 'v2.7.0', dest: 'channels', list: 'j.list' })
  check(blankRun.status !== 0, '空白品牌名必须视为缺失')
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

// ---- 6. 更新服务器(R2)发布:布局 / 清单 / 保留策略 / 缓存头 ----
{
  const work = tempDir('ci-publish-')
  const bundle = join(work, 'release-bundle')
  const list = join(work, 'channels.list')
  const store = join(work, 'store')
  writeFileSync(list, 'official\nbeta\nacme-corp\n')

  // 假 aws:把 s3 cp/ls/rm 变成对本地目录的操作,并把参数记进日志,便于断言。
  const log = join(work, 'aws.log')
  writeFileSync(log, '')
  const fakeAws = join(work, 'aws')
  writeFileSync(fakeAws, `#!/usr/bin/env bash
set -euo pipefail
log="${log}"
store="${store}"
record() { printf '%s\\n' "$*" >> "$log"; }
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --endpoint-url) shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
cmd="\${args[0]:-} \${args[1]:-}"
case "$cmd" in
  "s3 cp")
    src="\${args[2]}"; dst="\${args[3]}"
    extra=("\${args[@]:4}")
    record "cp $src $dst \${extra[*]:-}"
    key="\${dst#s3://*/}"
    if [[ "$dst" == */ ]]; then
      # 目录目标:对象键 = 前缀 + 源文件名(与 aws s3 cp 语义一致)
      dest="$store/\${key}$(basename "$src")"
    else
      dest="$store/\${key}"
    fi
    mkdir -p "$(dirname "$dest")"
    cp "$src" "$dest"
    ;;
  "s3 ls")
    prefix="\${args[2]}"
    key="\${prefix#s3://*/}"
    record "ls $prefix"
    if [ -d "$store/$key" ]; then ls -d "$store/$key"*/ 2>/dev/null | while read -r d; do echo "PRE $(basename "$d")/"; done; fi
    ;;
  "s3 rm")
    target="\${args[2]}"
    key="\${target#s3://*/}"
    record "rm $target"
    rm -rf "$store/$key"
    ;;
  *) record "other $*" ;;
esac
`)
  execFileSync('chmod', ['+x', fakeAws])

  // 每个渠道造一份"已构建"的镜像包。
  for (const channel of ['official', 'beta', 'acme-corp']) {
    mkdirSync(join(bundle, channel), { recursive: true })
    writeFileSync(join(bundle, channel, 'picoaide-server-2.7.0-amd64.zip'), `zip-${channel}`)
    writeFileSync(join(bundle, channel, 'SHA256SUMS'), `sum-${channel}`)
  }
  // 早于保留窗口的旧版本(应被清掉)与较新版本(应保留)。
  mkdirSync(join(store, 'official', 'releases', '2.5.0'), { recursive: true })
  mkdirSync(join(store, 'official', 'releases', '2.6.0'), { recursive: true })
  mkdirSync(join(store, 'official', 'releases', '2.6.1'), { recursive: true })

  const run = spawnSync('bash', [publishScript, '--list', list, '--bundle', bundle], {
    cwd: work,
    encoding: 'utf8',
    env: {
      PATH: `${work}:${process.env.PATH ?? ''}`,
      HOME: process.env.HOME ?? '',
      R2_ACCOUNT_ID: 'test-account',
      R2_BUCKET: 'test-bucket',
      VERSION: 'v2.7.0',
    },
  })
  check(run.status === 0, `R2 发布应成功,实际退出 ${String(run.status)}: ${run.stderr ?? ''}`)
  check(run.stdout.includes('::add-mask::acme-corp'), '发布步骤必须自己再掩码渠道 id')
  // 掩码行本身必然含渠道名(GitHub 从这一刻起把它抹成 ***);除此之外不得出现。
  const visible = run.stdout.split('\n').filter(line => !line.startsWith('::add-mask::')).join('\n')
  check(!visible.includes('acme-corp'), '渠道名不得出现在发布日志里(掩码行除外)')

  // 每个渠道一套独立目录 + 版本化资产 + 清单。
  for (const channel of ['official', 'beta', 'acme-corp']) {
    const dir = join(store, channel)
    check(existsSync(join(dir, 'releases', '2.7.0', 'picoaide-server-2.7.0-amd64.zip')), `${channel}: 应上传 zip`)
    check(existsSync(join(dir, 'releases', '2.7.0', 'SHA256SUMS')), `${channel}: 应上传 SHA256SUMS`)
    const manifestPath = join(dir, 'latest.json')
    check(existsSync(manifestPath), `${channel}: 应写 latest.json`)
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    check(manifest.channel_id === channel, `${channel}: 清单 channel_id 必须指向自己(渠道独立)`)
    check(manifest.server.version === '2.7.0' && manifest.server.image_tag === 'v2.7.0', `${channel}: 清单版本应为 2.7.0`)
    check(
      manifest.server.image_asset === `https://release.picoaide.com/${channel}/releases/2.7.0/picoaide-server-2.7.0-amd64.zip`,
      `${channel}: 清单里的下载地址必须指向**本渠道**目录,实际 ${manifest.server.image_asset}`,
    )
    check(typeof manifest.published_at === 'string' && manifest.published_at.endsWith('Z'), `${channel}: 清单需要 UTC 发布时间`)
  }

  // 保留策略:最近 3 个版本(2.6.0/2.6.1/2.7.0),最旧的 2.5.0 被清掉。
  check(!existsSync(join(store, 'official', 'releases', '2.5.0')), '超出保留窗口的旧版本应被清理')
  check(existsSync(join(store, 'official', 'releases', '2.6.0')), '保留窗口内的版本不得误删')
  check(existsSync(join(store, 'official', 'releases', '2.6.1')), '保留窗口内的版本不得误删')

  // 缓存头:资产不可变长缓存、指针 no-cache(否则新版本不生效)。
  const awsLog = readFileSync(log, 'utf8')
  if (process.env.DEBUG_PUBLISH === '1') process.stderr.write(`--- aws.log ---\n${awsLog}\n--- store ---\n${execFileSync('find', [store, '-type', 'f']).toString()}\n`)
  check(awsLog.includes('max-age=31536000, immutable'), '版本化资产必须带 immutable 长缓存')
  check(/latest\.json.*no-cache/.test(awsLog), 'latest.json 必须 no-cache(否则客户端拿不到新版本)')
  const lines = awsLog.split('\n').filter(line => line !== '')
  const firstAsset = lines.findIndex(line => line.includes('official/SHA256SUMS'))
  const firstManifest = lines.findIndex(line => line.includes('latest.json'))
  check(firstAsset !== -1 && firstManifest > firstAsset, '清单应在资产之后写入(避免指向空目录)')

  // 缺 R2 secrets → 跳过而不是失败(GitHub Release 仍要可用)。
  const skipped = spawnSync('bash', [publishScript, '--list', list, '--bundle', bundle], {
    cwd: work,
    encoding: 'utf8',
    env: { PATH: `${work}:${process.env.PATH ?? ''}`, HOME: process.env.HOME ?? '', VERSION: 'v2.7.0' },
  })
  check(skipped.status === 0, 'R2 secrets 未配置时应跳过而非失败')
  check(`${skipped.stdout ?? ''}${skipped.stderr ?? ''}`.includes('跳过'), '跳过时应给出告警')

  // 产物缺失 → fail-loud(绝不发布不完整版本)。
  rmSync(join(bundle, 'beta', 'SHA256SUMS'))
  const incomplete = spawnSync('bash', [publishScript, '--list', list, '--bundle', bundle], {
    cwd: work,
    encoding: 'utf8',
    env: {
      PATH: `${work}:${process.env.PATH ?? ''}`,
      HOME: process.env.HOME ?? '',
      R2_ACCOUNT_ID: 'test-account',
      R2_BUCKET: 'test-bucket',
      VERSION: 'v2.7.0',
    },
  })
  check(incomplete.status !== 0, '缺 SHA256SUMS 时必须失败')
  check((incomplete.stderr ?? '').includes('缺失'), '失败信息应说明缺什么')

  // 缺 VERSION → fail-loud。
  const noVersion = spawnSync('bash', [publishScript, '--list', list, '--bundle', bundle], {
    cwd: work,
    encoding: 'utf8',
    env: { PATH: `${work}:${process.env.PATH ?? ''}`, HOME: process.env.HOME ?? '', R2_ACCOUNT_ID: 'a', R2_BUCKET: 'b' },
  })
  check(noVersion.status !== 0, '缺 VERSION 时必须失败')
}

for (const dir of scratch) rmSync(dir, { recursive: true, force: true })

if (failures.length > 0) {
  process.stderr.write(`\nverify-ci-scripts: ${failures.length} 项断言失败\n`)
  process.exit(1)
}
process.stdout.write('verify-ci-scripts: OK — 渠道发现/掩码/策略/品牌必填/日志抑制/产物归集/R2 发布全部符合预期\n')
