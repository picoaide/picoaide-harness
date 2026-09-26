/**
 * tests/bootstrap-mcp-not-delivered.spec.ts — R21-F-05 的仓内回归判据。
 *
 * ## 缺陷原形态
 *
 * `BootstrapConfig.mcp` 是**必填**字段，而服务端
 * （`server/internal/bootstrap/bootstrap.go` 的 `Response`）**从来没有**这个字段，
 * 全仓也零消费方 —— 一个从不存在的"MCP 目录"在类型层面被写成"一定有"，读它的人会
 * 以为拿到的是空数组而不是 undefined。
 *
 * ## 处置（**改承诺**，与 `TestServerVersionIsInformationalOnly` 同一先例）
 *
 * 标成可选（`mcp?`）并在注释里写明"服务端当前不下发"，同时**立判据**：
 *
 *  1. 服务端 `Response` 结构体里没有 `json:"mcp"`（**读对方源码**，读不到即红）；
 *  2. 客户端 `BootstrapConfig` 里 `mcp` 是可选，且注释点名"服务端当前不下发"；
 *  3. `packages/host/enterprise/src` 里没有 `.mcp` 读取点（"零消费方"这句话本身
 *     也要有判据：谁真的开始消费它，必须先补齐服务端下发与这条用例）。
 *
 * 为什么不删字段：`bootstrap.ts` 的 `EMPTY` 与一批既有夹具按必填形状构造它，
 * 删字段要连带改那些文件（不在本泳道所有权内）；"标可选 + 立判据"已经把假承诺消灭。
 *
 * ## 变异验证
 *
 *  - 把 `mcp?:` 改回 `mcp:` ⇒ 第 2 组红；
 *  - 在 Go 的 `Response` 里加回 `MCP []McpItem \`json:"mcp"\`` ⇒ 第 1 组红（逼两端同步）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** 仓库根：从本文件（`packages/host/enterprise/tests/`）往上走四级。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const GO_BOOTSTRAP = 'server/internal/bootstrap/bootstrap.go'
const TS_CONFIG = 'packages/host/enterprise/src/server-connector/config.ts'
const ENTERPRISE_SRC = 'packages/host/enterprise/src'

/** 读真源：读不到即 throw（判据失去输入必须红，不许静默跳过）。 */
function readSource(relative: string): string {
  try {
    return readFileSync(join(REPO_ROOT, relative), 'utf8')
  } catch (cause) {
    throw new Error(`跨端对拍的真源读不到：${relative}（${cause instanceof Error ? cause.message : String(cause)}）—— 这条用例不允许 skip`)
  }
}

/** 递归收集目录下的 .ts/.tsx 源文件（跳过测试与生成物）。 */
function sourceFiles(relativeDir: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
      const next = `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'lib') continue
        walk(next)
      } else if (/\.tsx?$/u.test(entry.name)) {
        out.push(next)
      }
    }
  }
  walk(relativeDir)
  return out
}

describe('R21-F-05 BootstrapConfig.mcp：服务端从不下发 ⇒ 类型必须如实标记（改承诺 + 立判据）', () => {
  it('服务端 bootstrap 的 Response 结构体里**没有** mcp 字段（兄弟字段仍在，证明读的是对的结构体）', () => {
    const go = readSource(GO_BOOTSTRAP)
    const start = go.indexOf('type Response struct')
    if (start < 0) throw new Error(`服务端真源里找不到 type Response struct（${GO_BOOTSTRAP}）：契约改名/重构了，请重新对拍`)
    const end = go.indexOf('\n}', start)
    const body = go.slice(start, end < 0 ? undefined : end)
    expect(body, '服务端若开始下发 mcp，客户端类型与这条用例必须同步改').not.toMatch(/json:"mcp"/u)
    // 反向锚：确认切出来的确实是那份契约结构体（不是别的同名结构）。
    expect(body).toContain('json:"connectors"')
    expect(body).toContain('json:"skills"')
    expect(body).toContain('json:"models"')
  })

  it('客户端 BootstrapConfig.mcp 是可选的，且注释写明"服务端当前不下发"', () => {
    const ts = readSource(TS_CONFIG)
    expect(ts, 'mcp 必须是可选字段（必填 = 假承诺"一定有"）').toMatch(/^\s*mcp\?:\s*\{/mu)
    expect(ts, '注释必须如实描述服务端行为').toContain('服务端当前不下发')
  })

  it('企业包里没有 `.mcp` 消费方（"零消费方"这句话本身有判据）', () => {
    const offenders = sourceFiles(ENTERPRISE_SRC)
      .filter(file => /\.mcp\b/u.test(readFileSync(join(REPO_ROOT, file), 'utf8')))
    expect(offenders, `这些文件开始消费 BootstrapConfig.mcp：${offenders.join(', ')}（先补服务端下发与本用例的口径）`).toEqual([])
  })
})
