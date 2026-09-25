/**
 * R13-GC B-P2-3：系统路径闸门的**表驱动**判据。
 *
 * 背景：`isSafeDshHome`（数据根闸门，审计 2026-08-25 P2-3）与
 * `isSystemWorkingDirectory`（打包应用 cwd 闸门，P2-34）是同族两条路径，但此前各写
 * 一份实现 —— cwd 那份有 Windows 形态、大小写归一与系统根表，数据根那份只有一张
 * POSIX 前缀表 + 逐字 `startsWith`。R13-B 探针 C 实测三条绕过：
 *
 *   ① 符号链接一跳：`isSafeDshHome(link -> /etc) === true`，而端到端写入走 realpath
 *      （技能库真的落到 `/etc/skills`）；
 *   ② Windows 盘符形态：`isSafeDshHome('C:\Windows') === true`（Linux 上还会被
 *      `resolve()` 变成 cwd 下的相对目录 ⇒ 数据根随启动目录漂移）；
 *   ③ 大小写变体：`isSafeDshHome('/ETC') === true`（macOS/Windows 默认大小写不敏感）。
 *
 * 本文件用**同一张表**同时喂两条闸门：表里的 system 行要求两者都给"系统路径"结论
 * （`isSafeDshHome === false` 且 `isSystemWorkingDirectory === true`），safe 行要求
 * 两者都给"普通路径"结论。表是最小公倍数 —— 只要有人把两条路径拆回两份实现，这里
 * 必然有一侧先红（见 §变异验证）。
 *
 * 反向对照（§legacy）：旧谓词逐字复制在此，证明用例里的取值**确实是**旧实现的绕过
 * 形态，而不是恒真断言。
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isSafeDshHome, isSystemWorkingDirectory } from '../src/index.ts'

/** 一行判据：`target` + 显式 `env`（**不依赖本机环境**，缺省空映射）。 */
interface GateRow {
  readonly target: string
  readonly why: string
  readonly env?: Record<string, string | undefined>
}

/** 必须被判成"系统路径"的取值。 */
const SYSTEM_ROWS: readonly GateRow[] = [
  { target: '/', why: 'POSIX 根' },
  { target: '/etc', why: '系统目录' },
  { target: '/usr/local', why: '系统目录子路径' },
  { target: '/dev/shm', why: '设备目录' },
  { target: '/proc/self', why: 'proc' },
  { target: '/bin/sh', why: '系统目录（与 cwd 闸门同表）' },
  { target: '/etc/', why: '尾随分隔符' },
  { target: '/etc\\', why: '尾随反斜杠' },
  { target: '/etc/../etc/x', why: '.. 段折回被禁前缀' },
  { target: '/tmp/../etc/x', why: '.. 段从 /tmp 折回 /etc' },
  { target: '/tmp/../../etc/x', why: '多段 .. 折回 /etc' },
  { target: '/ETC', why: '大小写变体（macOS/Windows 不敏感 ⇒ 就是 /etc）' },
  { target: '/Etc/Shadow', why: '大小写变体 + 子路径' },
  { target: '/Usr/Local', why: '大小写变体' },
  { target: '/ETC/definitely-missing/x', why: 'realpath 失败时回落拼写路径（宁严不宽）' },
  { target: '/private/etc', why: 'macOS 上 /etc 的真实路径（别名形态）' },
  { target: '/private/etc/passwd', why: 'macOS 别名形态的子路径' },
  { target: '/private/var/lib/picoaide', why: 'macOS 上 /var 的真实路径' },
  { target: 'C:\\Windows', why: 'Windows 系统根（Linux 上 resolve 会漂成 cwd 相对目录）' },
  { target: 'C:\\Windows\\System32', why: 'Windows 系统根子路径' },
  { target: 'C:/Windows', why: 'Windows 系统根的正斜杠形态' },
  { target: 'c:\\windows', why: '小写盘符' },
  { target: 'C:\\Windows\\', why: '尾随分隔符' },
  { target: 'C:\\Program Files\\PicoAide', why: '内置默认 Program Files' },
  { target: 'C:\\ProgramData\\x', why: '内置默认 ProgramData' },
  { target: 'C:\\', why: '盘符根' },
  { target: 'C:/', why: '盘符根（正斜杠形态）' },
  { target: 'C:', why: '盘符相对（裸盘符）' },
  { target: 'C:foo', why: '盘符相对' },
  { target: '\\\\server\\share', why: 'UNC 根' },
  { target: '\\\\server\\share\\dir', why: 'UNC 子路径' },
  { target: '//server/share/x', why: 'UNC 的正斜杠写法' },
  { target: '\\\\?\\C:\\Windows', why: '扩展长度设备路径' },
  { target: '\\\\.\\C:', why: '设备命名空间' },
  { target: 'D:\\Win\\System32', why: 'env 声明的 SystemRoot（跨平台 seam）', env: { SystemRoot: 'D:\\Win' } },
  { target: 'D:\\Win\\System32\\drivers', why: 'env 声明的 windir 子路径', env: { windir: 'D:/Win' } },
  { target: 'E:\\Apps\\picoaide', why: 'env 声明的 ProgramFiles', env: { ProgramFiles: 'E:\\Apps' } },
  { target: 'F:\\Apps32\\x', why: 'env 声明的 ProgramFiles(x86)', env: { 'ProgramFiles(x86)': 'F:\\Apps32' } },
  { target: '/srv/data/app', why: 'env 声明的根（POSIX 形态也进同一张表）', env: { ProgramData: '/srv/data' } },
]

/** 必须被判成"普通路径"的取值。 */
const SAFE_ROWS: readonly GateRow[] = [
  { target: '/home/user/.picoaide-harness', why: '产品默认数据根' },
  { target: '/tmp', why: '/tmp 本身（e2e/沙箱用）' },
  { target: '/tmp/x', why: '/tmp 子目录' },
  { target: '/tmp/dsh-desktop-profile-abc', why: 'e2e 用的 /tmp 数据根' },
  { target: '/var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/dsh-desktop-profile-5e84bS', why: 'macOS 临时目录例外' },
  { target: '/private/var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/dsh-desktop-profile-5e84bS', why: 'macOS 临时目录的真实路径形态' },
  { target: '/tmp/a/../b', why: '.. 段仍落在 /tmp 内' },
  { target: '/home/user/projects/app', why: '普通项目目录' },
  { target: 'relative/project', why: '相对路径' },
  { target: 'C:\\Users\\me\\.picoaide-harness', why: 'Windows 用户目录' },
  { target: 'D:\\projects\\app', why: '非系统盘上的项目目录（env 只声明 C 盘系统根）', env: { SystemRoot: 'C:\\Windows' } },
]

const envOf = (row: GateRow): Record<string, string | undefined> => row.env ?? {}

describe.each(SYSTEM_ROWS)('系统路径（两条闸门都必须拒绝）：$why', ({ target, env }) => {
  it(`isSafeDshHome(${JSON.stringify(target)}) === false 且 isSystemWorkingDirectory(...) === true`, () => {
    expect(isSafeDshHome(target, env ?? {})).toBe(false)
    expect(isSystemWorkingDirectory(target, env ?? {})).toBe(true)
  })
})

describe.each(SAFE_ROWS)('普通路径（两条闸门都必须放行）：$why', ({ target, env }) => {
  it(`isSafeDshHome(${JSON.stringify(target)}) === true 且 isSystemWorkingDirectory(...) === false`, () => {
    expect(isSafeDshHome(target, env ?? {})).toBe(true)
    expect(isSystemWorkingDirectory(target, env ?? {})).toBe(false)
  })
})

describe('符号链接（realpath 归一：跳数不限）', () => {
  it('一跳：链接 → /etc 时两条闸门都判系统路径', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'r13gc-esc-'))
    try {
      const link = join(scratch, 'home-to-etc')
      await symlink('/etc', link)
      // 反向对照（非恒真）：链接的真实落点确实是被禁前缀 —— 形态真的构造出来了。
      expect(realpathSync.native(link)).toBe('/etc')
      expect(isSafeDshHome(link, {})).toBe(false)
      expect(isSystemWorkingDirectory(link, {})).toBe(true)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('多跳：链接 → 链接 → /etc 同样拒绝（跳数不限）', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'r13gc-esc-multi-'))
    try {
      const second = join(scratch, 'hop-2')
      const first = join(scratch, 'hop-1')
      await symlink('/etc', second)
      await symlink(second, first)
      expect(realpathSync.native(first)).toBe('/etc')
      expect(realpathSync.native(second)).toBe('/etc')
      expect(isSafeDshHome(first, {})).toBe(false)
      expect(isSystemWorkingDirectory(first, {})).toBe(true)
      // 尚不存在的尾段也要跟着走：`<link>/skills/<name>`（技能库的真实落点形态）
      const deep = join(first, 'skills', 'some-skill')
      expect(realpathSync.native(second)).toBe('/etc')
      expect(isSafeDshHome(deep, {})).toBe(false)
      expect(isSystemWorkingDirectory(deep, {})).toBe(true)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('链接指向可写临时目录时放行（不是"一律拒绝链接形态"）', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'r13gc-ok-'))
    const real = await mkdtemp(join(tmpdir(), 'r13gc-real-'))
    try {
      const link = join(scratch, 'home-spelled')
      await symlink(real, link)
      // 反向对照：链接确实解析到了临时目录（不是没建成的空链接）
      expect(realpathSync.native(link)).toBe(realpathSync.native(real))
      expect(isSafeDshHome(link, {})).toBe(true)
      expect(isSystemWorkingDirectory(link, {})).toBe(false)
    } finally {
      await rm(scratch, { recursive: true, force: true })
      await rm(real, { recursive: true, force: true })
    }
  })
})

describe('同一份表：两条闸门的系统根判定一致', () => {
  it('/ETC、C:\\Windows、符号链接一跳同时喂给两条闸门，两者都给"系统路径"结论', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'r13gc-parity-'))
    try {
      const link = join(scratch, 'home-to-etc')
      await symlink('/etc', link)
      for (const target of ['/ETC', 'C:\\Windows', link]) {
        expect(isSafeDshHome(target, {}), `${target} 必须是系统路径（数据根闸门）`).toBe(false)
        expect(isSystemWorkingDirectory(target, {}), `${target} 必须是系统路径（cwd 闸门）`).toBe(true)
      }
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('全表逐行对拍：system 行与 safe 行两侧结论都一致', () => {
    for (const row of SYSTEM_ROWS) {
      const env = envOf(row)
      expect([row.target, isSafeDshHome(row.target, env), isSystemWorkingDirectory(row.target, env)])
        .toEqual([row.target, false, true])
    }
    for (const row of SAFE_ROWS) {
      const env = envOf(row)
      expect([row.target, isSafeDshHome(row.target, env), isSystemWorkingDirectory(row.target, env)])
        .toEqual([row.target, true, false])
    }
  })
})

/**
 * 修复前的旧谓词（审计 2026-08-25 P2-3 引入，2026-09-25 之前逐字如此）：把
 * `resolve()` 后的**拼写路径**与一张 POSIX 前缀表逐字比较 —— 没有 realpath、没有
 * 大小写归一、没有 Windows 形态。逐字复制在这里只做一件事：**反向对照**，证明下面
 * 三个取值确实是旧实现的绕过形态（否则"修复有效"无从谈起）。
 */
const LEGACY_FORBIDDEN_PREFIXES = ['/', '/proc', '/sys', '/etc', '/usr', '/var', '/boot', '/dev', '/opt']
function legacyIsSafeDshHome(resolved: string): boolean {
  const normalized = resolve(resolved)
  if (normalized === '/') return false
  for (const prefix of LEGACY_FORBIDDEN_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`) || normalized.startsWith(`${prefix}\\`)) {
      if (prefix === '/var' && normalized.startsWith('/var/folders/') && normalized.includes('/T/')) continue
      return false
    }
  }
  return true
}

describe('反向对照：旧谓词放行、新谓词拒绝（R13-B 探针 C 的三条形态）', () => {
  it('三条绕过形态在旧谓词下确实放行', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'r13gc-legacy-'))
    try {
      const link = join(scratch, 'home-to-etc')
      await symlink('/etc', link)
      // R13-B 探针 C 原始输出（temp/r13/B/logs/probe-c.log）：
      //   [①] isSafeDshHome("/etc") = false   isSafeDshHome(link->/etc) = true   realpath(link) = /etc
      //   [③] isSafeDshHome("/etc") = false   isSafeDshHome("/ETC") = true
      //   [②对照] isSystemWorkingDirectory("C:\\Windows") = true   isSafeDshHome("C:\\Windows") = true
      expect(legacyIsSafeDshHome('/etc')).toBe(false) // 对照组：拼写就是被禁前缀 ⇒ 旧谓词也拒绝
      expect(legacyIsSafeDshHome(link)).toBe(true) // ① 符号链接一跳
      expect(legacyIsSafeDshHome('/ETC')).toBe(true) // ③ 大小写变体
      expect(legacyIsSafeDshHome('C:\\Windows')).toBe(true) // ② Windows 盘符形态
      // 修复后：同三个取值全部拒绝
      expect(isSafeDshHome(link, {})).toBe(false)
      expect(isSafeDshHome('/ETC', {})).toBe(false)
      expect(isSafeDshHome('C:\\Windows', {})).toBe(false)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
})

describe('向后兼容（签名与既有行为）', () => {
  it('isSafeDshHome(resolved) 单参调用仍然可用（新参数可选）', () => {
    expect(isSafeDshHome('/tmp/dsh-home')).toBe(true)
    expect(isSafeDshHome('/etc')).toBe(false)
    expect(isSafeDshHome('/')).toBe(false)
    expect(isSafeDshHome('/var/folders/df/x/T/y')).toBe(true)
  })

  it('isSystemWorkingDirectory(cwd) 单参调用与空串语义不变', () => {
    expect(isSystemWorkingDirectory('/usr/bin')).toBe(true)
    expect(isSystemWorkingDirectory('/tmp/workspace')).toBe(false)
    expect(isSystemWorkingDirectory('')).toBe(true)
    expect(isSystemWorkingDirectory('   ')).toBe(true)
  })
})
