/**
 * 随包语音模型**下载/校验实现**的报错面判据（2026-10-04，C1-01）。
 *
 * ## 这条判据要钉住的形态
 *
 * `scripts/fetch-speech-model.mjs` 的 mismatch 分支曾经是
 * `bytes !== asset.bytes || digest.digest('hex') !== asset.sha256`，而下一句又调了一次
 * `digest.digest('hex')` 拼文案。`Hash#digest()` 是**终结**操作：第二次调用抛
 * `ERR_CRYPTO_HASH_FINALIZED`（"Digest already called"）。`||` 的短路决定了它**只在
 * "大小相同、哈希不同"时**发生 —— 也就是最需要期望/实得哈希的形态（镜像站给了同名
 * 不同版本的权重、传输位翻转）。结果是两条源都试过之后，运维只看到两遍
 * `Digest already called`，而"哪个源给了什么字节"这条唯一证据丢了。这一步还是**发版
 * 前置**（拉不到权重会让打包直接失败）。
 *
 * 所以判据不能是"它抛了错"（旧实现也抛），而必须是**错误文案里同时含期望与实得
 * 哈希**，且不含 `Digest already called`。这是一条行为级判据：真起一个 HTTP 服务，
 * 对**同一份**下载/校验实现喂"字节数正确、内容不同"的响应。
 *
 * ## 为什么用 `manifestPath` 接缝
 *
 * 真清单（`…-sensevoice/runtime/assets.json`）声明的是 239MiB 权重 —— 为了钉一条报错
 * 文案去搬这份字节既慢又不可靠。接缝只换清单来源：下载、写入、摘要、文案全部是生产
 * 代码同一份实现（`materializeSpeechModel` 不带 `manifestPath` 即生产路径）。
 */
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { materializeSpeechModel, SPEECH_MODEL_LAYOUT } from '../scripts/fetch-speech-model.mjs'

/** 三类载荷的字节数（相对布局是生产的，大小是测试自己的）。 */
const SIZES = new Map<string, number>([
  [SPEECH_MODEL_LAYOUT.model, 2_048],
  [SPEECH_MODEL_LAYOUT.tokens, 512],
  [SPEECH_MODEL_LAYOUT.vad, 1_024],
])

/** 钉死的期望载荷：每条都用可区分的填充字节。 */
function pinnedBodies(): Map<string, Buffer> {
  return new Map([...SIZES].map(([relative, bytes], index) => [relative, Buffer.alloc(bytes, 7 + index)]))
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

/** 与上游 `runtime/assets.json` 同形的清单（只留实现真正读的四个键）。 */
function manifestFor(origin: string, bodies: ReadonlyMap<string, Buffer>): string {
  const entry = (relative: string): Record<string, unknown> => {
    const body = bodies.get(relative) ?? Buffer.alloc(0)
    return {
      name: relative.slice(relative.lastIndexOf('/') + 1),
      url: `${origin}/${relative}`,
      bytes: body.length,
      sha256: sha256(body),
    }
  }
  return `${JSON.stringify({
    models: {
      int8: entry(SPEECH_MODEL_LAYOUT.model),
      // fp32 不在随包布局里（int8 才是），但真清单有这一条 —— 保持同形。
      fp32: { ...entry(SPEECH_MODEL_LAYOUT.model), name: 'model.onnx' },
    },
    tokens: entry(SPEECH_MODEL_LAYOUT.tokens),
    vad: entry(SPEECH_MODEL_LAYOUT.vad),
  }, null, 2)}\n`
}

let server: Server | undefined
const roots: string[] = []

afterEach(async () => {
  const listening = server
  server = undefined
  if (listening !== undefined) await new Promise<void>(resolve => { listening.close(() => { resolve() }) })
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 起一个只回固定字节的本地源（未登记的路径回 404）。 */
async function serve(bodies: ReadonlyMap<string, Buffer>): Promise<string> {
  const listening = createServer((request, response) => {
    const body = bodies.get(new URL(request.url ?? '/', 'http://127.0.0.1').pathname.slice(1))
    if (body === undefined) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(body)
  })
  await new Promise<void>(resolve => { listening.listen(0, '127.0.0.1', resolve) })
  server = listening
  const address = listening.address()
  if (address === null || typeof address === 'string') throw new Error('test server has no TCP address')
  return `http://127.0.0.1:${String(address.port)}`
}

/** 一次性夹具：临时根、假清单与载荷目录。 */
function fixture(): { root: string, manifestPath: string, out: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-speech-fetch-'))
  roots.push(root)
  return { root, manifestPath: join(root, 'assets.json'), out: join(root, 'out') }
}

/** 跑一次真实下载并把它抛出的错误取回来（不抛 = undefined）。 */
async function failingMaterialize(
  input: { out: string, manifestPath: string, origin: string },
): Promise<Error | undefined> {
  return await materializeSpeechModel({
    out: input.out,
    origins: [input.origin],
    manifestPath: input.manifestPath,
  }).then(() => undefined, (error: unknown) => error as Error)
}

describe('随包语音模型下载器：校验不符的报错面（C1-01）', () => {
  it('大小相同、哈希不同时，报错同时含期望与实得哈希（不是 Digest already called）', async () => {
    const pinned = pinnedBodies()
    // 服务端回**同样长度**、内容不同的字节 —— 正是旧实现踩中二次 digest 的形态。
    const tampered = Buffer.alloc(SIZES.get(SPEECH_MODEL_LAYOUT.model) ?? 0, 200)
    const origin = await serve(new Map([...pinned].map(([relative, body]) => [
      relative,
      relative === SPEECH_MODEL_LAYOUT.model ? tampered : body,
    ])))
    const { manifestPath, out } = fixture()
    writeFileSync(manifestPath, manifestFor(origin, pinned))

    const failure = await failingMaterialize({ out, manifestPath, origin })

    expect(failure, '校验不符必须拒绝载荷（fail-loud，绝不带坏权重出厂）').toBeInstanceOf(Error)
    const message = failure?.message ?? ''
    const expected = pinned.get(SPEECH_MODEL_LAYOUT.model) ?? Buffer.alloc(0)
    // 期望：大小相同 ⇒ 这一条只能靠哈希发现；实得：区分"哪个源给了什么字节"的唯一证据。
    expect(message).toContain(`期望 ${String(expected.length)}/${sha256(expected)}`)
    expect(message).toContain(`实得 ${String(tampered.length)}/${sha256(tampered)}`)
    expect(message, '二次 digest 的报错不得再出现在文案里').not.toContain('Digest already called')
    expect(message, '报错必须点名是哪一条载荷').toContain('model.int8.onnx')
    // 被拒的载荷不得留下任何产物（`.part` 与最终文件都不留）。
    expect(existsSync(join(out, SPEECH_MODEL_LAYOUT.model))).toBe(false)
    expect(existsSync(`${join(out, SPEECH_MODEL_LAYOUT.model)}.${String(process.pid)}.part`)).toBe(false)
  })

  it('大小不同的那条短路分支给出同口径的期望/实得（两条分支对齐）', async () => {
    const pinned = pinnedBodies()
    const declared = pinned.get(SPEECH_MODEL_LAYOUT.model) ?? Buffer.alloc(0)
    const truncated = declared.subarray(0, 100)
    const origin = await serve(new Map([[SPEECH_MODEL_LAYOUT.model, truncated]]))
    const { manifestPath, out } = fixture()
    writeFileSync(manifestPath, manifestFor(origin, pinned))

    const failure = await failingMaterialize({ out, manifestPath, origin })

    const message = failure?.message ?? ''
    expect(message).toContain(`期望 ${String(declared.length)}/${sha256(declared)}`)
    expect(message).toContain(`实得 100/${sha256(truncated)}`)
    expect(message).not.toContain('Digest already called')
  })

  it('字节与哈希都对时正常就位（防"恒抛错"的正控）', async () => {
    const pinned = pinnedBodies()
    const origin = await serve(pinned)
    const { manifestPath, out } = fixture()
    writeFileSync(manifestPath, manifestFor(origin, pinned))

    const result = await materializeSpeechModel({ out, origins: [origin], manifestPath })

    expect(result.status.map(entry => entry.state)).toEqual(['downloaded', 'downloaded', 'downloaded'])
    const written = readFileSync(join(out, SPEECH_MODEL_LAYOUT.model))
    expect(sha256(written)).toBe(sha256(pinned.get(SPEECH_MODEL_LAYOUT.model) ?? Buffer.alloc(0)))
    expect(existsSync(join(out, 'manifest.json')), '清单最后写：它存在即代表三条都校验过').toBe(true)
  })
})
