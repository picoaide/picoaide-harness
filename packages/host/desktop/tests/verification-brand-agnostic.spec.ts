import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { packagedProductName } from '../scripts/channel-build.ts'

/**
 * 验证门禁不得把**厂商品牌**锁进发布链。
 *
 * 2026-09-10 审计:多处验证脚本断言 `document.title.includes('PicoAide')`
 * 或只读 `package.json build.productName` 去拼 `<productName>.app`。渠道构建下
 * 窗口标题与应用名是**客户的名字**,这些"门禁"于是要么让渠道矩阵永远红,
 * 要么更糟 —— 逼着人把渠道构建改成厂商名。断言应当对齐"本次构建声明了什么"
 * (`packagedProductName()`),而不是某个具体品牌。
 *
 * 这条测试是**静态门禁**:新增验证脚本时若又硬编码品牌,这里先红。
 */

const scriptsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts')

/** 会被"打包产物验证"用到的脚本(打包后跑,可能在渠道构建下执行)。 */
function verificationScripts(): string[] {
  return readdirSync(scriptsDir)
    .filter(name => name.endsWith('.mjs') || name.endsWith('.ts'))
    .filter(name => /^(verify-|e2e-|real-env-|release-|package-|channel-)/u.test(name))
}

/**
 * 其中**只做验证**的那些(打包脚本是产品名的产出方,读 package.json 定义官方
 * 默认值是它的本职;验证脚本才是"拿着别的构建的产物做断言"的那一侧)。
 */
function consumersOfPackagedBuild(): string[] {
  return verificationScripts().filter(name => /^(verify-|e2e-|real-env-)/u.test(name))
}

describe('verification gates are brand-agnostic', () => {
  it('finds the verification scripts it is meant to guard', () => {
    // 正则改了/目录挪了都会让这条测试变成"永远绿"的空门禁。
    expect(verificationScripts().length).toBeGreaterThanOrEqual(8)
  })

  it('never hardcodes a brand in a title check nor reads package.json for the name', () => {
    const offenders: string[] = []
    for (const name of consumersOfPackagedBuild()) {
      const source = readFileSync(join(scriptsDir, name), 'utf8')
      source.split('\n').forEach((line, index) => {
        // 两种形态:
        //   1) 把品牌字面量写进标题断言 —— 渠道构建下标题是客户名,断言永远红;
        //   2) 从 package.json 取产品名去拼应用名/断言 —— 渠道构建的产品名不在
        //      package.json 里(在随包 channel.json),取到的是厂商名。
        // 官方默认值表(channel-build.ts 的 OFFICIAL_BUILD_DEFAULTS)不在此列:
        // 那是"没有渠道包时"的兜底,不是断言。
        const isTitleAssertion = /title\.includes\(\s*['"]/u.test(line)
        const usesManifestProductName = /build\??\.productName/u.test(line)
        if (isTitleAssertion || usesManifestProductName) {
          offenders.push(`${name}:${String(index + 1)} ${line.trim()}`)
        }
      })
    }
    expect(offenders, '验证脚本不得硬编码厂商品牌、也不得用 package.json 的产品名,'
      + '请改用 packagedProductName()').toEqual([])
  })

  it('reads the product name the build actually declares', () => {
    // 官方/本地(没有渠道包):官方默认值 —— 与改造前一致。
    expect(packagedProductName()).toBe('PicoAide Harness')
  })

  it('lets a channel build declare its own product name', () => {
    // 渠道包就位后(打包脚本写的那个文件)读到的必须是渠道名。
    // 这里直接用 tmp 目录模拟 build/,不碰真实构建产物。
    const dir = mkdtempChannelBuildDir({ channel_id: 'acme', identity: { display_name: 'Acme AI' } })
    expect(packagedProductName(dir)).toBe('Acme AI')
  })

  it('prefers desktop.product_name over identity.display_name', () => {
    const dir = mkdtempChannelBuildDir({
      channel_id: 'acme',
      identity: { display_name: 'Acme AI' },
      desktop: { product_name: 'Acme Assistant' },
    })
    expect(packagedProductName(dir)).toBe('Acme Assistant')
  })

  it('falls back to the official name when the staged package has no name', () => {
    const dir = mkdtempChannelBuildDir({ channel_id: 'acme' })
    expect(packagedProductName(dir)).toBe('PicoAide Harness')
  })

  it('refuses a malformed staged package instead of guessing', () => {
    // 验证期宁可 fail-loud:猜一个产品名去比对,等于给白标事故盖章。
    const dir = mkdtempChannelBuildDir('{ not json')
    expect(() => packagedProductName(dir)).toThrow(/不是合法 JSON/u)
  })
})

/** 造一个"已就位的渠道包"目录(build/channel.json)。 */
function mkdtempChannelBuildDir(manifest: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'packaged-brand-'))
  writeFileSync(join(dir, 'channel.json'),
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
  return dir
}
