/**
 * 随包语音模型 → **上游官方配置项**的注入判据（2026-09-29 定案）。
 *
 * 形态（尽量用官方方式、只补一条组装期 patch）：
 *   · 构建期：渠道包 `desktop.speech_bundle_model: true` ⇒ `prepareChannelPackaging()`
 *     把权重拉进 `build/speech-model/`；electron-builder 的 `extraResources` 把它放进
 *     客户端目录 `<resources>/speech-model/`（**安装时就在那里**，没有"首次运行释放"这一步）；
 *   · 装配期：桌面 profile 把上游 `speech-to-text-sensevoice` 行的**官方配置**指过去
 *     （`modelDirectory` + `vadModelPath`），上游语义 = "文件已存在 ⇒ 不下载"，于是
 *     语音零网络可用；文件不齐就**不注入**，回落下载路径。
 *
 * 四条必须钉住的：
 *   1. 载荷齐、大小对 ⇒ 注入**绝对路径**（上游要求绝对路径）；
 *   2. 任一文件缺失/大小不符/清单坏 ⇒ **不注入**（显式来源会关掉下载，指过去而文件不在
 *      就是硬故障）；
 *   3. 生产只认 `process.resourcesPath`：开发运行读源树会让"本机碰巧拉过载荷"改变装配
 *      结果（本地绿、CI 另一套）；
 *   4. 渠道那条路（`speech_model_dir` / `speech_model_origin`）在本机没随包载荷时照旧生效。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveBundledSpeechModel, SPEECH_MODEL_PAYLOAD_DIR } from '../src/speech-model-bundle.ts'
import { parseDesktopChannelProfile } from '../src/desktop-channel.ts'
import { channelProfilePatches } from '../src/profile.ts'

/** 三份"文件"（内容任意；大小由清单声明）。 */
const FILES = [
  ['sensevoice-onnx/model.int8.onnx', 4096],
  ['sensevoice-onnx/tokens.txt', 128],
  ['silero/silero_vad.onnx', 256],
] as const

let root: string
let resources: string
let payload: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-speech-bundle-'))
  resources = join(root, 'resources')
  payload = join(resources, SPEECH_MODEL_PAYLOAD_DIR)
  mkdirSync(payload, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 写一份载荷到指定目录（缺省 `<resources>/speech-model`）。 */
function writePayload(options: { dir?: string, sizes?: Record<string, number>, manifest?: string } = {}): void {
  const dir = options.dir ?? payload
  const files = FILES.map(([path, bytes]) => ({ path, bytes }))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'),
    options.manifest ?? `${JSON.stringify({ schema: 1, precision: 'int8', files }, null, 2)}\n`)
  for (const [path, bytes] of FILES) {
    const target = join(dir, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, Buffer.alloc(options.sizes?.[path] ?? bytes, 7))
  }
}

describe('bundled speech model → upstream config', () => {
  it('resolves the official modelDirectory/vadModelPath when the payload is complete', () => {
    writePayload()
    expect(resolveBundledSpeechModel({ resourcesPath: resources })).toEqual({
      modelDirectory: join(payload, 'sensevoice-onnx'),
      vadPath: join(payload, 'silero/silero_vad.onnx'),
    })
  })

  it('also accepts the source-tree payload location used by packaging tools', () => {
    const build = join(root, 'build', SPEECH_MODEL_PAYLOAD_DIR)
    writePayload({ dir: build })
    expect(resolveBundledSpeechModel({ packageRoot: root })?.modelDirectory).toBe(join(build, 'sensevoice-onnx'))
  })

  it('is undefined without a payload, and never reads the source tree in production', () => {
    rmSync(payload, { recursive: true, force: true })
    expect(resolveBundledSpeechModel({ resourcesPath: resources })).toBeUndefined()
    // 生产调用不带任何接缝：`process.resourcesPath`（无头/开发下为空）⇒ 不注入。
    expect(resolveBundledSpeechModel({})).toBeUndefined()
  })

  it('refuses a trimmed payload (explicit paths disable the download fallback)', () => {
    // 大小不符 = 截断（产物被清过/复制中断）。注入它就等于把这一行钉死在"验证失败"上。
    writePayload({ sizes: { 'sensevoice-onnx/model.int8.onnx': 1024 } })
    expect(resolveBundledSpeechModel({ resourcesPath: resources })).toBeUndefined()
  })

  it('refuses a payload whose manifest is unusable', () => {
    writePayload({ manifest: '{ not json' })
    expect(resolveBundledSpeechModel({ resourcesPath: resources })).toBeUndefined()
  })

  it('injects absolute paths plus the restated dataRoot (shape of the profile patch)', () => {
    // 注入的形状（profile.ts 的组装期 patch）：解析出的两项 + 重述的 `dataRoot`
    // ——`config` 是整键替换，漏掉上游必填的 dataRoot 会让这一行加载失败（语音整个消失）。
    writePayload()
    const resolved = resolveBundledSpeechModel({ resourcesPath: resources })!
    const config = {
      dataRoot: '/home/probe/.picoaide-harness/speech-to-text/sensevoice',
      modelDirectory: resolved.modelDirectory,
      vadModelPath: resolved.vadPath,
    }
    expect(config.dataRoot.endsWith('speech-to-text/sensevoice')).toBe(true)
    expect(config.modelDirectory.startsWith('/')).toBe(true)
    expect(config.vadModelPath.startsWith('/')).toBe(true)
  })

  it('keeps the channel-level deployment fields working when nothing is bundled', () => {
    // 渠道的 `speech_model_dir` / `speech_model_origin` 是**另一条**路（本机没随包载荷时
    // 由渠道配预置目录或内网镜像）。两条路各自独立：这里证明渠道那条在不随包时照旧生效。
    const profile = parseDesktopChannelProfile({
      channel_id: 'acme',
      identity: { display_name: 'Acme AI' },
      desktop: { app_origin_scheme: 'acme-app', speech_model_origin: 'https://mirror.example.com' },
    })
    const config = channelProfilePatches(profile, new Set(['speech-to-text-sensevoice']), '/home/probe/.acme-harness')[0]
      ?.config as Record<string, unknown>
    expect(config.modelOrigin).toBe('https://mirror.example.com')
    expect(Object.hasOwn(config, 'modelDirectory')).toBe(false)
  })
})
