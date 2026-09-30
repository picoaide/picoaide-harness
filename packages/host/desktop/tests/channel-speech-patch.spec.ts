/**
 * 渠道包的**语音模型部署面** → `speech-to-text-sensevoice` 行 config（2026-09-29）。
 *
 * 为什么单独钉这一层：语音模型是运行期按需下载的 228MB 权重，走宿主 Node **直连**
 * （客户端默认禁代理），而企业网常常"只有认证代理能出公网"。渠道包给两个出口 ——
 * 预置文件（零下载）与内网镜像（`modelOrigin`）—— 两者都只在**组装期**注入这一行
 * 的 config 才能生效（插件不读随包 channel.json）。
 *
 * 三条必须钉住的事实：
 *   1. **`config` 是整键替换**：注入时必须重述上游 bundle 自己给的 `dataRoot`，
 *      否则那一行会因为 `dataRoot` 必填而加载失败（语音整个消失）。第三组用例
 *      直接读上游 bundle 的 `cordis.patch.yml` 做**超集**对拍：上游给该行新增
 *      config 键时这里会红。
 *   2. 键**只在配了才出现**：没配的字段不能写 `undefined` 进 config（上游
 *      `z.union([z.string().min(1), z.const(undefined)])` 收 `undefined`，但
 *      `modelOrigins` 之类的缺省逻辑会跟着变，少写一个键比写一个空值安全）。
 *   3. **行不存在时不注入**：web 组装没有 voice bundle，注入不存在的行会被 loader 拒绝。
 */

import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { composeEntries, loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'
import { parseDesktopChannelProfile } from '../src/desktop-channel.ts'
import { channelProfilePatches } from '../src/profile.ts'

/** 本次启动的 DSH 数据根（渠道化安装里是渠道自己的目录）。 */
const HOME = '/home/probe/.acme-harness'

/** 上游 voice bundle 插入的四行（渠道注入只关心 sensevoice 那一行）。 */
const VOICE_ROWS = new Set(['speech-to-text', 'speech-to-text-sensevoice', 'api-speech-to-text', 'ui-voice-input'])

const bundleRoot = new URL('../node_modules/@deepseek-ai/dsh-experimental-voice-input-bundle/', import.meta.url)

/** 一份渠道包；`desktop` 段由调用方补充（其余字段用最小合法值）。 */
function profileWith(desktop: Record<string, unknown>): ReturnType<typeof parseDesktopChannelProfile> {
  return parseDesktopChannelProfile({
    schema: 1,
    channel_id: 'acme',
    identity: { display_name: 'Acme AI', short_name: 'Acme' },
    desktop: { app_origin_scheme: 'acme-app', ...desktop },
  })
}

/** 取 sensevoice 行的 config（不存在则失败）。 */
function speechConfig(desktop: Record<string, unknown>, rows: ReadonlySet<string> = VOICE_ROWS): Record<string, unknown> {
  const patches = channelProfilePatches(profileWith(desktop), rows, HOME)
  const patch = patches.find(candidate => candidate.id === 'speech-to-text-sensevoice')
  expect(patch, 'sensevoice 行的 patch 必须存在').toBeDefined()
  return patch!.config as Record<string, unknown>
}

/**
 * 上游 bundle 给 sensevoice 行声明的 config 键（真源 = 随包 `cordis.patch.yml`）。
 *
 * 用上游自己的 `loadOptionalPatches` 读，**不**自己 `parseYAML`：那份 patch 里的
 * `dataRoot: !!js dshHomePath(...)` 是 Loader 的 YAML 方言，裸 `yaml` 解析会对
 * `!!js` 标签发 `TAG_RESOLVE_FAILED` 警告（本仓已因"两套方言漂移"踩过坑）。
 */
function upstreamSpeechConfigKeys(): string[] {
  const patches = loadOptionalPatches('channel-speech-patch.spec', fileURLToPath(new URL('cordis.patch.yml', bundleRoot)))
  const row = (patches ?? [])
    .flatMap(entry => (entry as { insert?: Array<{ id?: string, config?: Record<string, unknown> }> }).insert ?? [])
    .find(candidate => candidate.id === 'speech-to-text-sensevoice')
  expect(row, 'voice bundle 里必须有 speech-to-text-sensevoice 行').toBeDefined()
  return Object.keys(row!.config ?? {})
}

describe('channel speech deployment → sensevoice row', () => {
  it('injects nothing when the channel declares no speech deployment', () => {
    const patches = channelProfilePatches(profileWith({}), VOICE_ROWS, HOME)
    expect(patches.filter(p => p.id === 'speech-to-text-sensevoice')).toHaveLength(0)
  })

  it('skips the row when the profile has no voice bundle (web assembly)', () => {
    const patches = channelProfilePatches(
      profileWith({ speech_model_origin: 'https://mirror.example.com' }),
      new Set(['pico-connectors']),
      HOME,
    )
    // 只注入确实存在的行：web 组装没有 voice bundle，注入那行会被 loader 拒绝。
    expect(patches.map(p => p.id)).toEqual(['pico-connectors'])
  })

  it('restates every config key the upstream row declares (whole-key replacement)', () => {
    // `config` 是整键替换：上游声明的每个键都必须在我们的 patch 里出现，否则
    // 那一行会带着残缺 config 加载（`dataRoot` 必填 ⇒ 语音整个消失）。
    const upstream = upstreamSpeechConfigKeys()
    const config = speechConfig({ speech_model_origin: 'https://mirror.example.com' })
    for (const key of upstream) {
      expect(Object.keys(config), `上游声明的 ${key} 必须被重述`).toContain(key)
    }
    // dataRoot 按**本次启动的 home** 算成字面量（上游那个值是 `dshHomePath(...)`）。
    expect(config.dataRoot).toBe(`${HOME}/speech-to-text/sensevoice`)
  })

  it('carries a pre-placed model directory and VAD file as absolute paths', () => {
    const config = speechConfig({
      speech_model_dir: '/opt/picoaide/speech/sensevoice',
      speech_vad_path: '/opt/picoaide/speech/silero_vad.onnx',
    })
    expect(config.modelDirectory).toBe('/opt/picoaide/speech/sensevoice')
    expect(config.vadModelPath).toBe('/opt/picoaide/speech/silero_vad.onnx')
    // 没配的字段不出现（不是 undefined 值）。
    expect(config).not.toHaveProperty('modelOrigin')
  })

  it('accepts a per-platform map and picks this platform, then default', () => {
    const config = speechConfig({
      speech_model_dir: {
        default: '/opt/picoaide/speech/sensevoice',
        win32: 'C:\\ProgramData\\PicoAide\\speech\\sensevoice',
        linux: '/srv/picoaide/speech/sensevoice',
      },
    })
    const expected = process.platform === 'win32'
      ? 'C:\\ProgramData\\PicoAide\\speech\\sensevoice'
      : process.platform === 'linux' ? '/srv/picoaide/speech/sensevoice' : '/opt/picoaide/speech/sensevoice'
    expect(config.modelDirectory).toBe(expected)
  })

  it('ignores relative paths and malformed origins (falls back to the download path)', () => {
    // 渠道包写错一个**可选**字段不该让语音整个不可用：形状不符即不注入，回落下载。
    const patches = channelProfilePatches(profileWith({
      speech_model_dir: 'speech/sensevoice',
      speech_vad_path: './silero_vad.onnx',
      speech_model_origin: 'https://mirror.example.com/hf',
    }), VOICE_ROWS, HOME)
    expect(patches.filter(p => p.id === 'speech-to-text-sensevoice')).toHaveLength(0)
    // 镜像只收 scheme+host（路径由上游钉死）；带路径的写法连 profile 解析都过不去。
    expect(profileWith({ speech_model_origin: 'https://mirror.example.com/hf' })?.speech.modelOrigin).toBeUndefined()
    expect(profileWith({ speech_model_origin: 'https://mirror.example.com/' })?.speech.modelOrigin)
      .toBe('https://mirror.example.com/')
  })

  it('composes onto the bundle row without losing its own config (real compose)', () => {
    // 单测 patch 内容还不够：真正决定成败的是**组合顺序**（bundle 层先插行、渠道
    // patch 后覆盖它）。这里用上游组合器跑一遍真实的合并，断言结果行既有上游的
    // dataRoot、也有渠道的 modelDirectory —— 组合器换成"整行替换"或顺序反过来都会红。
    const bundlePatches = loadOptionalPatches(
      'channel-speech-patch.spec',
      fileURLToPath(new URL('cordis.patch.yml', bundleRoot)),
    ) ?? []
    const channelPatches = channelProfilePatches(
      profileWith({ speech_model_dir: '/opt/picoaide/speech/sensevoice' }),
      VOICE_ROWS,
      HOME,
    )
    const rows = composeEntries([[bundlePatches, channelPatches].flat()]) as Array<{ id?: string, config?: Record<string, unknown> }>
    const sensevoice = rows.find(row => row.id === 'speech-to-text-sensevoice')
    expect(sensevoice?.config?.dataRoot).toBe(`${HOME}/speech-to-text/sensevoice`)
    expect(sensevoice?.config?.modelDirectory).toBe('/opt/picoaide/speech/sensevoice')
  })

  it('keeps the vendor brand out of the injected config', () => {
    // 渠道 config 里不得出现厂商名（公开仓纪律 + 白标要求）。
    expect(JSON.stringify(speechConfig({ speech_model_dir: '/opt/picoaide/speech/sensevoice' })))
      .not.toContain('PicoAide')
  })
})
