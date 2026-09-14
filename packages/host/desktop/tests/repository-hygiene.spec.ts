import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** 仓库根：<root>/packages/host/desktop/tests → 上溯四级。 */
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

/**
 * 只读地问 git：这个路径是否被忽略。
 *
 * `git check-ignore` 的退出码语义固定：0 = 已忽略、1 = 未忽略、128 = 出错
 * （不在工作树里 / git 不可用）。测试不执行任何 `git add`。
 * @param path - 仓库根下的相对路径。
 * @returns 已忽略 / 未忽略 / 无法判定（源码工作树之外）。
 */
function ignoreVerdict(path: string): 'ignored' | 'tracked-candidate' | 'unavailable' {
  const result = spawnSync('git', ['check-ignore', '-v', '--', path], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  })
  if (result.error !== undefined || result.status === 128 || result.status === null) return 'unavailable'
  return result.status === 0 ? 'ignored' : 'tracked-candidate'
}

describe('repository hygiene (public repository stays free of third-party CLI binaries)', () => {
  it('keeps the retired build/cli prefetch directory out of `git add -A`', () => {
    // 目录在干净检出里并不存在,而 .gitignore 的规则是目录专属
    // (`build/cli/`,尾斜杠)。`git check-ignore` 只能靠**尾斜杠**或磁盘上的
    // 真实目录判断"这是个目录",所以必须带尾斜杠问——否则本地有该目录时通过、
    // 干净 CI 检出上误报未忽略。
    const verdict = ignoreVerdict('packages/host/desktop/build/cli/')
    // 解包产物/无 git 的环境跳过:这条守卫只在源码工作树里有意义。
    if (verdict === 'unavailable') return
    // 96 MB 的第三方厂商 CLI 二进制(旧 prefetch-cli.mjs 的产物,脚本已于
    // 90463530be 移除)不该被 `git add -A` 吸进公开仓:再分发许可风险 +
    // 不可逆的公开历史。
    expect(verdict, 'packages/host/desktop/build/cli must stay git-ignored').toBe('ignored')
  })

  it('ignores the individual CLI binaries that `git add -A` would stage', () => {
    // 断言"目录被忽略"是从父规则推出来的;这里直接问 `git add -A` 真正会
    // 触碰的那些条目,即使它们此刻不在磁盘上。
    const entries = [
      'packages/host/desktop/build/cli/mcp-server.exe',
      'packages/host/desktop/build/cli/vendor/helper',
    ]
    for (const entry of entries) {
      const verdict = ignoreVerdict(entry)
      if (verdict === 'unavailable') return
      expect(verdict, `${entry} must stay git-ignored`).toBe('ignored')
    }
  })

  it('does not over-ignore the rest of the desktop build directory', () => {
    // 反向对照:规则收紧到 build/cli/ 就够,不能把邻居(图标/渠道配置的
    // 生成目标)也一起吃掉——那会让打包产物缺文件。
    const verdict = ignoreVerdict('packages/host/desktop/build/cli-not-ignored-probe')
    if (verdict === 'unavailable') return
    expect(verdict, 'sibling paths must remain trackable').toBe('tracked-candidate')
  })
})
