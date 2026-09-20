/**
 * 补丁守卫：`@deepseek-ai/dsh-sandbox-windows-acl` 的 **DACL 写入被拒时必须给出
 * 可行动的原因**（见 `patches/dsh-sandbox-windows-acl@0.1.5-rc.2.patch`）。
 *
 * 背景（2026-09-17，用户提供的 Windows 自检报告，客户端 2.7.5-beta.4，工作区
 * `D:\project\urlfy`）：默认「工作区内修改」权限下连 `pwsh` 跑 `hello` 都起不来，
 * 报错原文只有一行
 *
 *   `Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\project\urlfy)`
 *
 * 而这条路径是 **fail-closed** 的：工作区根目录拿不到 write ACE，沙箱就跑不起来，
 * 每条命令都只能靠 danger-full-access 提权（用户实测"两次调用均同"）。Win32 5
 * 是 ERROR_ACCESS_DENIED —— 写 DACL 需要调用者**拥有该目录**（或持有 WRITE_DAC），
 * 于是映射网络驱动器 / junction / 云同步占位文件 / 非 NTFS 卷 / 别的账户建的目录 /
 * 安全软件保护的 DACL 都会走到这里。上游原文对用户与模型都没有任何可行动信息，
 * 补丁只加"这是什么 + 两条出路"，**不改 fail-closed 语义**（静默降级成"不限制写"
 * 是安全回归，不是修复）。
 *
 * 这个 spec 钉三件事，防止下次升级上游时补丁被静默丢掉：
 *  1. 真实行为：`setNamedSecurityInfoW` 返回 5 时，抛出的错误里带出路提示，
 *     且仍保留上游的 API 名 / Win32 码 / `grantWrite(<path>)` 现场；
 *  2. 提示只认 5：别的 Win32 错误码不能被误诊成"工作区不可授权"；
 *  3. 产物与补丁登记：装出来的包里两处共存，`resolutions` 的 exact + `^` 键都指向
 *     同一个补丁文件（上游重切补丁时这里先红）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import koffi from 'koffi'
import { AclWriteGrant } from '@deepseek-ai/dsh-sandbox-windows-acl'

const require_ = createRequire(import.meta.url)
const pkgDir = dirname(require_.resolve('@deepseek-ai/dsh-sandbox-windows-acl/package.json'))
/**
 * 补丁目标是一个**哈希命名的构建产物**（`lib/types-<hash>.js`）。历史版本把
 * `types-DuU3lSVe.js` 写死在这里，于是每次升级上游都要手改一行，改漏就是
 * 一整片守卫静默失效。改为按内容定位：谁含 `SetNamedSecurityInfoW` 谁就是目标。
 */
const bundlePath = (() => {
  const libDir = join(pkgDir, 'lib')
  const candidates = readdirSync(libDir).filter(name => name.endsWith('.js'))
  const found = candidates.find(name => readFileSync(join(libDir, name), 'utf8').includes('SetNamedSecurityInfoW'))
  if (found === undefined) {
    throw new Error(`dsh-sandbox-windows-acl: lib/ 下找不到含 SetNamedSecurityInfoW 的产物（实际 ${JSON.stringify(candidates)}）`)
  }
  return join(libDir, found)
})()
/** 上游 pin 的唯一真源；本 spec 不再硬编码补丁版本。 */
const UPSTREAM = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../upstream.json', import.meta.url)), 'utf8'),
) as { runtimePackageVersion: string }
const PVOID = koffi.pointer('void')

/**
 * 纯桩 binding 表：只跑通 withPathLock → readCurrentDacl → mergeAndApply 这条路径
 * 需要的调用，`setNamedSecurityInfoW` 的返回值由用例决定。指针一律用真实分配地址
 * 编码（`koffi.address`），不 dereference —— 与本包上游的 failure-path 测试同形。
 */
function aclApi(applyResult: () => number): Record<string, unknown> {
  const sid = koffi.alloc('uint8', 8)
  const merged = koffi.alloc('uint8', 64)
  return {
    convertStringSidToSidW: vi.fn((_sid: string, slot: unknown) => {
      koffi.encode(slot as never, PVOID, koffi.address(sid))
      return 1
    }),
    getTempPathW: vi.fn((_length: number, buffer: Buffer) => {
      const temp = tmpdir().replace(/[\\/]$/u, '')
      buffer.write(temp, 'utf16le')
      return temp.length
    }),
    createFileW: vi.fn(() => 7n),
    lockFileEx: vi.fn(() => 1),
    unlockFileEx: vi.fn(() => 1),
    closeHandle: vi.fn(() => 1),
    getNamedSecurityInfoW: vi.fn((
      _path: unknown, _type: unknown, _info: unknown, _owner: unknown, _group: unknown,
      dacl: unknown, _sacl: unknown, descriptor: unknown,
    ) => {
      koffi.encode(dacl as never, PVOID, 0n) // 无显式 DACL ⇒ 走 merge 路径
      koffi.encode(descriptor as never, PVOID, 0n)
      return 0
    }),
    setEntriesInAclW: vi.fn((_count: unknown, _entries: unknown, _old: unknown, newAcl: unknown) => {
      koffi.encode(newAcl as never, PVOID, koffi.address(merged))
      return 0
    }),
    setNamedSecurityInfoW: vi.fn(applyResult),
    localFree: vi.fn(() => 0n),
    getLastError: vi.fn(() => 5),
    formatMessageW: vi.fn(() => 0),
  }
}

const WORKSPACE = 'D:\\project\\urlfy'

/** Run one grant whose DACL write fails with `code`, returning the thrown error. */
function grantFailure(code: number): Error {
  const api = aclApi(() => code) as never
  const grant = AclWriteGrant.create('S-1-4-1-2-3', api)
  try {
    grant.add(WORKSPACE, true)
  } catch (error) {
    return error as Error
  }
  throw new Error('前置条件失败：grantWrite 本应抛出')
}

describe('Windows ACL 授权失败的可行动原因（补丁守卫）', () => {
  it('Win32 5（拒绝访问）时保留现场并给出出路', () => {
    const error = grantFailure(5)
    // 上游原文形状不变：API 名 + Win32 码 + 调用者的 label(path)。
    expect(error.message).toContain('SetNamedSecurityInfoW failed (Win32 5)')
    expect(error.message).toContain(`grantWrite(${WORKSPACE})`)
    // 新增：这条错误意味着什么、以及两条出路。
    expect(error.message).toMatch(/requires owning the directory/u)
    expect(error.message).toMatch(/mapped network drive/u)
    expect(error.message).toMatch(/local NTFS directory/u)
    expect(error.message).toMatch(/fully permissive permission preset/u)
  })

  it('别的 Win32 错误码不被误诊成"工作区不可授权"', () => {
    const error = grantFailure(87) // ERROR_INVALID_PARAMETER：真正的 API 调用缺陷
    expect(error.message).toContain('SetNamedSecurityInfoW failed (Win32 87)')
    expect(error.message).not.toMatch(/requires owning the directory/u)
  })

  it('装出来的包里补丁两处共存，且 resolutions 的 exact + ^ 键指向同一份补丁', () => {
    const bundle = readFileSync(bundlePath, 'utf8')
    expect(bundle).toContain('const ERROR_ACCESS_DENIED = 5;')
    expect(bundle).toContain('${applyResult === ERROR_ACCESS_DENIED ? DACL_WRITE_DENIED_HINT : ""}')
    // 上游失败点仍在（升级把这一行改掉时，这里先红而不是补丁静默消失）。
    expect(bundle).toContain('throwWin32(api, "SetNamedSecurityInfoW", applyResult,')

    const root = fileURLToPath(new URL('../../../..', import.meta.url))
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      resolutions: Record<string, string>
    }
    // 版本取自 upstream.json 而不是字面量：补丁文件名与 resolutions 键都跟着 pin 走，
    // 写死会让每次升级都手改这里（2026-09-20 升级审计 P1-8）。
    const version = UPSTREAM.runtimePackageVersion
    const patch = `./patches/dsh-sandbox-windows-acl@${version}.patch`
    expect(manifest.resolutions[`@deepseek-ai/dsh-sandbox-windows-acl@npm:${version}`])
      .toBe(`patch:@deepseek-ai/dsh-sandbox-windows-acl@npm%3A${version}#${patch}`)
    expect(manifest.resolutions[`@deepseek-ai/dsh-sandbox-windows-acl@npm:^${version}`])
      .toBe(`patch:@deepseek-ai/dsh-sandbox-windows-acl@npm%3A${version}#${patch}`)
  })
})
