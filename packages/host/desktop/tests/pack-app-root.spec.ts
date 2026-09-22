/**
 * 打包输入暂存层（`scripts/pack-app-root.mjs`）的门禁。
 *
 * 为什么这些用例必须存在（2026-09-22 泄漏事故）：
 * 11 个已发布的正式/预发包都夹带了桌面包自身的 `src/tests/scripts`、各
 * `@picoaide/dsh-*` 的源码目录、33 个内嵌原始 TypeScript 的 sourcemap、
 * 以及 263 MiB 的 `temp/`（含两个 156/119 MiB 的 squashfs 试验件）。根因是
 * **electron-builder 26 不把 `build.files` 用在应用根目录内容上**，所以
 * `files` 里那些排除规则全是声明而非证据。修复改成"进包前先把应用根暂存成
 * 白名单副本"，这里钉住三件事：
 *   1. 暂存内容**只有**运行期白名单（多一个都要红）；
 *   2. sourcemap 在进包前就被丢掉（不是靠打包后删）；
 *   3. 四个打包脚本都真的接了这个机制（源码级接线守卫）。
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  assertStageRootIsRealDirectory,
  listStageEntries,
  PACK_APP_ROOT_ENTRIES,
  stagePackAppRoot,
  withStagedPackAppRoot,
} from '../scripts/pack-app-root.mjs'

const desktopRoot = fileURLToPath(new URL('../', import.meta.url))

/** 造一个最小但结构正确的假包根，避免用例依赖真实构建产物。 */
function fakePackageRoot(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pack-root-'))
  mkdirSync(join(root, 'lib', 'preload'), { recursive: true })
  mkdirSync(join(root, 'build'), { recursive: true })
  writeFileSync(join(root, 'lib', 'main.js'), 'export {}\n')
  writeFileSync(join(root, 'lib', 'main.js.map'), '{"sourcesContent":["SECRET"]}\n')
  writeFileSync(join(root, 'lib', 'preload', 'renderer-error.cjs'), '// p\n')
  writeFileSync(join(root, 'build', 'app-icon.png'), 'png\n')
  writeFileSync(join(root, 'cordis.patch.yml'), 'rows: []\n')
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({
    name: 'dsh-plugin-desktop',
    version: '1.2.3',
    main: 'lib/main.js',
    build: { files: ['lib/**'] },
    devDependencies: { vitest: '4.1.8' },
    scripts: { test: 'vitest' },
    peerDependencies: { electron: '44.4.3' },
    resolutions: { x: 'y' },
    files: ['lib/**/*.js'],
  }, null, 2)}\n`)
  // 开发期条目：任何一个被暂存都算回归。
  mkdirSync(join(root, 'src', 'client'), { recursive: true })
  writeFileSync(join(root, 'src', 'client', 'AdvancedFrame.tsx'), 'export const x = 1\n')
  mkdirSync(join(root, 'tests'), { recursive: true })
  writeFileSync(join(root, 'tests', 'package.spec.ts'), 'it("x", () => {})\n')
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'scripts', 'notarize-mac.ts'), 'export {}\n')
  mkdirSync(join(root, 'temp'), { recursive: true })
  writeFileSync(join(root, 'temp', 'squash-xz.squashfs'), 'BIG\n')
  mkdirSync(join(root, '.e2e-shots'), { recursive: true })
  writeFileSync(join(root, '.e2e-shots', 'shot.png'), 'img\n')
  mkdirSync(join(root, '.real-env-shots'), { recursive: true })
  writeFileSync(join(root, '.real-env-shots', 'shot.png'), 'img\n')
  writeFileSync(join(root, 'tsdown.config.ts'), 'export default {}\n')
  writeFileSync(join(root, 'COVERAGE-MATRIX.md'), '# m\n')
  for (const [rel, content] of Object.entries(extra) as Array<[string, string]>) {
    writeFileSync(join(root, rel), content)
  }
  return root
}

describe('打包输入暂存层（应用根白名单）', () => {
  it('暂存的直接子项恰好等于运行期白名单', () => {
    const root = fakePackageRoot()
    const staged = stagePackAppRoot(root, 'dist')
    try {
      // 正向：白名单条目必须在。
      expect(listStageEntries(staged.stageRoot).sort()).toEqual([...PACK_APP_ROOT_ENTRIES].sort())
      // 反例：每个开发期条目都不得出现（逐条判，不靠"至少没全在"）。
      for (const forbidden of [
        'src', 'tests', 'scripts', 'temp', '.e2e-shots', '.real-env-shots',
        'tsdown.config.ts', 'COVERAGE-MATRIX.md',
      ]) {
        expect(existsSync(join(staged.stageRoot, forbidden)), forbidden).toBe(false)
      }
    } finally {
      staged.cleanup()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('sourcemap 在进包前就丢掉（sourcesContent 内嵌原始 TS，删晚了等于已泄露）', () => {
    const root = fakePackageRoot()
    const staged = stagePackAppRoot(root, 'dist')
    try {
      // 前置断言：源目录里确实有 map，否则判据空转。
      expect(existsSync(join(root, 'lib', 'main.js.map'))).toBe(true)
      expect(existsSync(join(staged.stageRoot, 'lib', 'main.js.map'))).toBe(false)
      expect(existsSync(join(staged.stageRoot, 'lib', 'main.js'))).toBe(true)
      expect(existsSync(join(staged.stageRoot, 'lib', 'preload', 'renderer-error.cjs'))).toBe(true)
    } finally {
      staged.cleanup()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('暂存的 package.json 去掉 build/开发专用键，保留运行期解析要用的字段', () => {
    const root = fakePackageRoot()
    const staged = stagePackAppRoot(root, 'dist')
    try {
      const manifest = JSON.parse(readFileSync(join(staged.stageRoot, 'package.json'), 'utf8'))
      // electron-builder 3.0 起禁止应用包声明构建配置（会直接拒包）。
      for (const key of ['build', 'devDependencies', 'scripts', 'peerDependencies', 'resolutions', 'files']) {
        expect(manifest, key).not.toHaveProperty(key)
      }
      // 运行期与打包元数据必须原样保留。
      expect(manifest.name).toBe('dsh-plugin-desktop')
      expect(manifest.main).toBe('lib/main.js')
      expect(manifest.version).toBe('1.2.3')
    } finally {
      staged.cleanup()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('缺运行期条目时 fail-loud（不能"少一个也照打"）', () => {
    const root = fakePackageRoot()
    rmSync(join(root, 'cordis.patch.yml'))
    expect(() => stagePackAppRoot(root, 'dist')).toThrow(/运行期条目缺失/u)
    rmSync(root, { recursive: true, force: true })
  })

  it('暂存根必须是真实目录（符号链接会被 electron-builder 展开成真实内容）', () => {
    const root = fakePackageRoot()
    const staged = stagePackAppRoot(root, 'dist')
    try {
      expect(assertStageRootIsRealDirectory(staged.stageRoot)).toBe(true)
    } finally {
      staged.cleanup()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('withStagedPackAppRoot 产出 directions.app 参数且可清理', () => {
    const root = fakePackageRoot()
    const staged = withStagedPackAppRoot(root, 'dist')
    try {
      expect(staged.args).toEqual([`--config.directories.app=${staged.stageRoot}`])
      expect(staged.stageRoot).toContain(join('dist', '.pack-root'))
      staged.cleanup()
      expect(existsSync(staged.stageRoot)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('同时最多只有一个暂存根：重跑先清旧的（否则旧内容被当输入收编）', () => {
    const root = fakePackageRoot()
    const first = stagePackAppRoot(root, 'dist')
    // 手工塞一个"上次残留"的文件进暂存根。
    writeFileSync(join(first.stageRoot, 'leftover-from-previous-run.js'), 'x\n')
    const second = stagePackAppRoot(root, 'dist')
    try {
      expect(existsSync(join(second.stageRoot, 'leftover-from-previous-run.js'))).toBe(false)
      expect(listStageEntries(second.stageRoot).sort()).toEqual([...PACK_APP_ROOT_ENTRIES].sort())
    } finally {
      second.cleanup()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('打包脚本必须真的接上暂存层（源码级接线守卫）', () => {
  // 只测辅助模块本身会漏掉"没被调用"——本轮变异验证实测过这个缺口：
  // 把接线那一行删掉，辅助模块的用例全绿而产物照旧泄漏。
  const scripts = [
    'scripts/package-dir.mjs',
    'scripts/package-linux.mjs',
    'scripts/package-mac.ts',
    'scripts/package-win.ts',
    'scripts/release-mac.ts',
  ]

  it.each(scripts)('%s 调用暂存层并把 args 传给 electron-builder', (relative) => {
    const source = readFileSync(join(desktopRoot, relative), 'utf8')
    // 允许可注入形式（`options.stagePackAppRoot ?? withStagedPackAppRoot`）：
    // 打包脚本的用例用假路径驱动命令边界，必须能替掉真实现；生产调用一律缺省真实现。
    expect(source).toMatch(/withStagedPackAppRoot/u)
    expect(source).toMatch(/\.\.\.staged\.args/u)
  })

  it.each(scripts)('%s 用 finally 保证暂存目录被清掉', (relative) => {
    const source = readFileSync(join(desktopRoot, relative), 'utf8')
    // 暂存目录留在 dist/ 里 = 下一次打包把它当输入收编（报告里 3514.6 MB 产物的场景）。
    expect(source).toMatch(/\} finally \{[\s\S]{0,200}?staged\.cleanup\(\)/u)
  })
})
