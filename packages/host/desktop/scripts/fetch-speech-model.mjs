/**
 * 拉取并校验**随客户端的语音识别模型**（SenseVoice int8 + Silero VAD）。
 *
 * 为什么有这一步（2026-09-29 产品决策）：默认形态是"模型首次使用时从公网下载"，
 * 而企业网常常"只有认证代理能出公网"（客户端默认禁代理）。与其在客户网里想办法，
 * 不如**把权重随客户端分发**：打包前把三个文件放进 `build/speech-model/`，
 * electron-builder 用 `extraResources` 带进产物，客户端首次运行释放到数据根。
 *
 * **钉死的真源是随包的上游清单**（`…-speech-to-text-sensevoice/runtime/assets.json`
 * 的 `bytes` + `sha256`），本脚本不另抄一份：上游换模型时这里跟着变，而客户端
 * 释放端与 afterPack 门禁都校验同一份大小/哈希。
 *
 * 用法：
 *   node scripts/fetch-speech-model.mjs [--out <dir>] [--check] [--origin <url>]
 *     --out     目标目录，缺省 `packages/host/desktop/build/speech-model`
 *     --check   只校验（缺失/大小/哈希不符即 exit 1），不下载 —— 门禁用
 *     --origin  下载源（HuggingFace 兼容，只换 scheme+host）；缺省依次试
 *               `https://huggingface.co`、`https://hf-mirror.com`，
 *               环境变量 `SPEECH_MODEL_ORIGIN` 可覆盖（CI 内网镜像用）
 * 退出码：0 = 目录已就绪；1 = 失败（缺文件/校验不符/下载失败）；2 = 用法错误。
 *
 * 幂等：已通过大小+哈希校验的文件不重新下载（重复打包几乎零成本）。
 *
 * @module dsh-plugin-desktop/scripts/fetch-speech-model
 */

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDirectInvocation } from './direct-invocation.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..')
/** 上游模型清单（大小 + 哈希的唯一真源）。 */
const UPSTREAM_MANIFEST = join(
  PACKAGE_ROOT,
  'node_modules/@deepseek-ai/dsh-experimental-speech-to-text-sensevoice/runtime/assets.json',
)
/** 缺省目标目录（electron-builder 的 buildResources 下，随包分发）。 */
const DEFAULT_OUT = join(PACKAGE_ROOT, 'build', 'speech-model')
/** 缺省下载源（与上游缺省同序：官方源优先，镜像兜底）。 */
const DEFAULT_ORIGINS = ['https://huggingface.co', 'https://hf-mirror.com']

/** 随包载荷的清单文件名（客户端释放端与 afterPack 门禁都读它）。 */
export const SPEECH_MODEL_MANIFEST_FILE = 'manifest.json'
/** 载荷内的相对布局（与上游运行期的缺省路径同形，释放端只做整目录复制）。 */
export const SPEECH_MODEL_LAYOUT = {
  model: 'sensevoice-onnx/model.int8.onnx',
  tokens: 'sensevoice-onnx/tokens.txt',
  vad: 'silero/silero_vad.onnx',
}

/**
 * 读上游钉死的三个文件（int8 模型 / tokens / VAD）。
 * @param manifestPath - 上游 `runtime/assets.json` 路径。
 * @returns 文件名、字节数、sha256 与上游 URL。
 */
export function readPinnedAssets(manifestPath = UPSTREAM_MANIFEST) {
  const lock = JSON.parse(readFileSync(manifestPath, 'utf8'))
  return [
    { key: 'model', relative: SPEECH_MODEL_LAYOUT.model, ...lock.models.int8 },
    { key: 'tokens', relative: SPEECH_MODEL_LAYOUT.tokens, ...lock.tokens },
    { key: 'vad', relative: SPEECH_MODEL_LAYOUT.vad, ...lock.vad },
  ]
}

/** 文件是否已经等于钉死的资产（大小 + sha256；缺失即 false）。 */
async function matchesAsset(path, asset) {
  try {
    if (statSync(path).size !== asset.bytes) return false
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(path)) digest.update(chunk)
    return digest.digest('hex') === asset.sha256
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return false
  }
}

/**
 * 下载一个资产到目标路径（`.part` → 校验 → 原子 rename）；已就绪则跳过。
 * @param asset - 钉死的资产。
 * @param destination - 目标文件路径。
 * @param origins - 依次尝试的源（HuggingFace 兼容；路径用上游钉死的那条）。
 * @returns 是否下载了（false = 已存在且校验通过）。
 */
async function fetchAsset(asset, destination, origins) {
  if (await matchesAsset(destination, asset)) return false
  mkdirSync(dirname(destination), { recursive: true })
  const partial = `${destination}.${process.pid}.part`
  const path = new URL(asset.url).pathname
  const failures = []
  try {
    for (const origin of origins) {
      const url = new URL(path, origin).href
      try {
        const response = await fetch(url, { redirect: 'follow' })
        if (!response.ok || response.body === null) {
          await response.body?.cancel()
          failures.push(`${origin} → HTTP ${response.status}`)
          continue
        }
        const digest = createHash('sha256')
        let bytes = 0
        const handle = await open(partial, 'wx', 0o600)
        try {
          for await (const chunk of response.body) {
            bytes += chunk.length
            if (bytes > asset.bytes) throw new Error(`${origin} 返回的字节数超过钉死大小`)
            digest.update(chunk)
            await handle.write(chunk)
          }
        } finally {
          await handle.close()
        }
        // 摘要**只算一次**：`Hash#digest()` 是终结操作，第二次调用抛
        // `ERR_CRYPTO_HASH_FINALIZED`（"Digest already called"）。而上面 `||` 的短路
        // 恰好只在"大小相同、哈希不同"时才走到这里 —— 那正是最需要期望/实得哈希的
        // 形态（镜像站给了同名不同版本的权重、传输位翻转），旧写法会把诊断换成一句
        // 与现场无关的 `Digest already called`，两条源都试过之后运维只看到两遍这句话。
        // 口径与 `src/update-download.ts` 的 `const digest = digestStream.digest('hex')`
        // 一致：先落局部量，再参与比较与文案。
        const actual = digest.digest('hex')
        if (bytes !== asset.bytes || actual !== asset.sha256) {
          failures.push(`${origin} → 大小或 sha256 与上游清单不符（期望 ${asset.bytes}/${asset.sha256}，实得 ${bytes}/${actual}）`)
          continue
        }
        renameSync(partial, destination)
        return true
      } catch (error) {
        failures.push(`${origin} → ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        rmSync(partial, { force: true })
      }
    }
    throw new Error(`下载失败：${asset.name}\n  ${failures.join('\n  ')}`)
  } finally {
    rmSync(partial, { force: true })
  }
}

/**
 * 就位随包载荷（下载缺失文件、写清单）。
 *
 * `manifestPath` 是**测试接缝**（缺省即唯一真源 = 上游 `runtime/assets.json`）：真清单
 * 声明的是 239MiB 权重，单测不可能为了钉住一条报错文案去搬这份字节；
 * `tests/speech-model-fetch.spec.ts` 用它配一份几十字节的等价清单，对**同一个**下载/
 * 校验实现跑真实 HTTP。
 * @param options - 目标目录、源列表、清单路径与是否只校验。
 * @returns 每个文件的最终状态（`ready` / `downloaded`）。
 */
export async function materializeSpeechModel({ out = DEFAULT_OUT, origins = DEFAULT_ORIGINS, check = false, manifestPath = UPSTREAM_MANIFEST } = {}) {
  const assets = readPinnedAssets(manifestPath)
  // 载荷清单（写到目标目录里的那一份），与上面 `manifestPath` 指的上游清单是两份东西。
  const payloadManifestPath = join(out, SPEECH_MODEL_MANIFEST_FILE)
  const status = []
  for (const asset of assets) {
    const destination = join(out, asset.relative)
    const matches = await matchesAsset(destination, asset)
    if (check) {
      if (!matches) throw new Error(`随包语音模型不可用：${asset.relative} 缺失或与上游清单不符（先跑一次不带 --check 的本脚本）`)
      status.push({ relative: asset.relative, state: 'ready' })
      continue
    }
    const downloaded = await fetchAsset(asset, destination, origins)
    status.push({ relative: asset.relative, state: downloaded ? 'downloaded' : 'ready' })
  }
  if (!check) {
    // 清单最后写：它存在即代表三个文件都已经校验过（客户端释放端据此判断载荷完整性）。
    const manifest = {
      schema: 1,
      precision: 'int8',
      files: assets.map(asset => ({ path: asset.relative, bytes: asset.bytes, sha256: asset.sha256 })),
    }
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`
    if (!existsSync(payloadManifestPath) || readFileSync(payloadManifestPath, 'utf8') !== serialized) {
      const partial = `${payloadManifestPath}.${process.pid}.part`
      writeFileSync(partial, serialized)
      renameSync(partial, payloadManifestPath)
    }
  }
  return { out, status }
}

/** 清掉载荷目录（渠道未开启随包模型时必须调用：残留比"没生效"更糟）。 */
export function removeSpeechModel(out = DEFAULT_OUT) {
  rmSync(out, { recursive: true, force: true })
}

async function main(argv) {
  let out = DEFAULT_OUT
  let check = false
  const origins = process.env.SPEECH_MODEL_ORIGIN === undefined
    ? DEFAULT_ORIGINS
    : [process.env.SPEECH_MODEL_ORIGIN]
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--check') { check = true; continue }
    if (flag === '--out' || flag === '--origin') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        console.error(`fetch-speech-model: ${flag} 需要取值`)
        return 2
      }
      index += 1
      if (flag === '--out') out = resolve(value)
      else origins.splice(0, origins.length, value)
      continue
    }
    console.error(`fetch-speech-model: 未知参数 ${flag}`)
    return 2
  }
  const { status } = await materializeSpeechModel({ out, origins, check })
  const summary = status.map(entry => `${entry.relative}=${entry.state}`).join(' ')
  console.log(`fetch-speech-model: ${check ? '校验通过' : '就位'} → ${out}\n  ${summary}`)
  return 0
}

// 直接执行判据走共享实现（`direct-invocation.mjs`）：自己写 `resolve(argv[1]) ===
// fileURLToPath(import.meta.url)` 会在**经符号链接目录调用**时静默 exit 0（本项目的
// 静态接线守卫专门禁止旧形态，见 tests/direct-invocation.spec.ts）。
if (isDirectInvocation(import.meta)) {
  main(process.argv.slice(2)).then(code => process.exit(code), (error) => {
    console.error(`fetch-speech-model: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
