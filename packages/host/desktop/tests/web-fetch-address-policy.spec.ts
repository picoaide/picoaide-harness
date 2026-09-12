/**
 * 补丁守卫：`@deepseek-ai/dsh-web-fetch-http` 的**地址策略放行**
 * （见 `patches/dsh-web-fetch-http@0.1.5-rc.2.patch`）。
 *
 * 背景（2026-09-12，真机故障）：Windows 测试机上 `web_fetch` 对**任何**网址都失败，
 * 报 `URL hostname "…" resolves to a non-public IP address`（`WEB_BLOCKED_URL`）。
 * 实测 github.com → 198.18.0.22、baidu.com → 198.18.0.26、api.deepseek.com → 198.18.0.5：
 * 用户开着 Clash 的 **fake-IP** 模式，本地 DNS 把所有域名解析到 `198.18.0.0/15`
 * （RFC 2544 benchmarking 段）。
 *
 * 根因：上游 `isPublicIpAddress()` 用 `ipaddr.js` 的 `range() === "unicast"` 做 SSRF 守卫，
 * 而该段被 ipaddr.js 归类为 `reserved`（旧版为 `benchmarking`）→ 一律拒绝。这是"防 DNS rebinding 的地址钉死"
 * 与"本地代理 fake-IP"两个设计之间的正面冲突：钉死到 198.18.x.x 在 fake-IP 下本就无意义
 * （真正出网的是本机代理，域名由代理侧解析），而代价是该环境下工具完全不可用。
 *
 * 产品决策（2026-09-12，用户拍板）：客户端 `web_fetch` **不做地址拦截**，全部放行；
 * 代理路由与地址钉死机制本身保持原样（见补丁注释）。
 *
 * 本 spec 直接对**行为**断言（补丁把 `isPublicIpAddress` 一并导出，正是为了能这样测）：
 * 上游会拒绝的地址必须全部放行，且插件的真实出口不能被补丁改坏。
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)
const pkgDir = dirname(require_.resolve('@deepseek-ai/dsh-web-fetch-http/package.json'))

async function loadProvider(): Promise<Record<string, any>> {
  return await import(pathToFileURL(join(pkgDir, 'lib', 'index.js')).href) as Record<string, any>
}

/** 上游守卫会拒绝、放行后必须通过的地址（含真机报告里的 fake-IP 与常见内网目标）。 */
const MUST_BE_ALLOWED = [
  // Clash / Surge fake-IP（真机报告：github.com / baidu.com / api.deepseek.com）
  '198.18.0.5',
  '198.18.0.22',
  '198.18.0.26',
  '198.19.255.254',
  // loopback / 内网 / link-local（云元数据）/ CGNAT
  '127.0.0.1',
  '10.0.0.1',
  '192.168.1.1',
  '172.16.0.1',
  '169.254.169.254',
  '100.64.0.1',
  // IPv6：loopback / ULA / IPv4-mapped / NAT64 嵌入内网
  '::1',
  'fc00::1',
  '::ffff:127.0.0.1',
  '64:ff9b::7f00:1',
  // 正常公网地址（放行策略下当然也要通过）
  '1.1.1.1',
  '2606:4700:4700::1111',
]

describe('web_fetch 地址策略（补丁守卫）', () => {
  it('对上游会拒绝的地址一律放行', async () => {
    const { isPublicIpAddress } = await loadProvider()
    expect(typeof isPublicIpAddress, '补丁未应用：isPublicIpAddress 未导出').toBe('function')
    const blocked = MUST_BE_ALLOWED.filter((address) => isPublicIpAddress(address) !== true)
    expect(blocked, `这些地址仍被拦截，web_fetch 在 fake-IP / 内网环境下会失败：${blocked.join(', ')}`).toEqual([])
  })

  it('不再因地址分类抛错（畸形输入也只是放行，不抛异常）', async () => {
    const { isPublicIpAddress } = await loadProvider()
    for (const input of ['', 'not-an-address', '[::1]', '198.18.0.22']) {
      expect(() => isPublicIpAddress(input), `输入 ${JSON.stringify(input)} 抛异常`).not.toThrow()
      expect(isPublicIpAddress(input)).toBe(true)
    }
  })

  it('插件的真实出口保持完好（补丁只放行地址，不阉割能力）', async () => {
    const mod = await loadProvider()
    expect(typeof mod.HttpFetchProvider).toBe('function')
    expect(typeof mod.apply).toBe('function')
    expect(mod.name).toBeTruthy()
  })
})
