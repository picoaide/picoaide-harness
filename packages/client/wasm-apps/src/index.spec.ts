/**
 * 插件契约测试（宿主半边 + 装配声明）。
 *
 * 覆盖三件"装配错了就静默失效"的事：
 *  1. 行契约：`name` / `inject` / `apply` 的形状符合 loader 的期望（apply 不抛）；
 *  2. **客户端 bundle 声明**：`package.json` 的 `dsh.client` 必须是 `platform: web`
 *     且 inject 了 `locale` / `slots` —— 少了这条，client-modules 不会扫描本包，
 *     应用中心在 UI 里根本不存在（组件测试全绿也照样看不到）；
 *  3. **装配行**：`cordis.patch.yml` 必须把本包插进 profile 层（打包/桌面组装读它）。
 *
 * 客户端半边自身的行为（注册哪个槽位、字典、跟随语言）在
 * `client/index.spec.ts` 里断言。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, inject, name } from '../src/index.ts'

const packageRoot = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8')) as {
  name: string
  exports: Record<string, unknown>
  dsh: { bundle: { patch: string }, client: { inject: string[], platform: string } }
  files: string[]
}
const patch = readFileSync(new URL('cordis.patch.yml', packageRoot), 'utf8')

describe('宿主半边：行契约', () => {
  it('声明稳定的插件名与（空的）依赖面', () => {
    expect(name).toBe('dsh-wasm-apps')
    // 本地 API 面（/api/pico/apps/wasm/*）由 @picoaide/dsh-enterprise 注册，
    // 这里不注入任何宿主服务 —— 空 inject 是有意的，不是漏写。
    expect(inject).toEqual([])
  })

  it('apply 是幂等 no-op（不注册路由、不读环境）', () => {
    const ctx = { webServer: { register: () => { throw new Error('must not register') } } } as unknown as Context
    expect(() => { apply(ctx) }).not.toThrow()
  })
})

describe('装配声明：客户端 bundle + profile 行', () => {
  it('dsh.client 声明 web 平台且注入 locale/slots', () => {
    expect(manifest.name).toBe('@picoaide/dsh-wasm-apps')
    expect(manifest.dsh.client.platform).toBe('web')
    expect(manifest.dsh.client.inject).toContain('@deepseek-ai/dsh-client-locale')
    expect(manifest.dsh.client.inject).toContain('@deepseek-ai/dsh-client-ui-slots')
  })

  it('声明 ./client 入口与随包清单（client.js 在 files 里）', () => {
    expect(Object.keys(manifest.exports)).toContain('./client')
    expect(manifest.exports['./client']).toBeDefined()
    expect(manifest.files).toContain('cordis.patch.yml')
    expect(manifest.files.some(pattern => pattern.includes('lib/**/*.js'))).toBe(true)
  })

  it('cordis.patch.yml 把本包插进 profile（id 稳定，name 与包名一致）', () => {
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(patch).toContain('- id: picoaide-wasm-apps')
    expect(patch).toContain("name: '@picoaide/dsh-wasm-apps'")
  })
})
