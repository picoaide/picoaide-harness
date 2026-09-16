#!/usr/bin/env node
/**
 * Vendored 插件测试的运行器（2026-09-16）。
 *
 * 为什么不能直接写 `node --test 'tests/*.test.js'`：这套测试里有若干用例会
 * 建真实 git 仓库（`git init -b main` / `git push origin main`），而
 * `node --test` 不做 glob 展开的兜底、git 又要求全局 `init.defaultBranch`
 * 或显式 `-b`。更关键的是**不能污染也不能依赖开发机/CI runner 的真实 $HOME**：
 *
 *  - 插件把状态写在 `$HOME`（`~/.dsh` / `~/.agents/skills`）；
 *  - 本沙箱的 `/root` 只读，直接跑会拿到 EROFS 假红；
 *  - 反过来若沿用真实 `$HOME`，测试会读到开发者的 `.gitconfig`，
 *    在缺 `init.defaultBranch=main` 的机器上出现 81 例"假红"（历史上踩过）。
 *
 * 所以这里建一个**一次性 HOME**：写入最小 `.gitconfig`
 * （`init.defaultBranch=main` + user.name/email + `safe.directory=*`），
 * 用它跑完 `node --test`，最后删掉。退出码原样透传。
 *
 * 用法：`node scripts/run-tests.mjs [--keep-home]`
 *   `node scripts/run-tests.mjs tests/plugin.test.js`（额外参数透传给 node --test）
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 最小 .gitconfig：测试里的 `git init -b main` / `git push origin main` 依赖它。 */
const GITCONFIG = `[init]
\tdefaultBranch = main
[user]
\tname = memory-evolve tests
\temail = tests@example.invalid
[safe]
\tdirectory = *
`

/**
 * Create the throwaway HOME and run the suite in it.
 * @returns {Promise<number>} child exit code.
 */
async function main() {
  const argv = process.argv.slice(2)
  const keepHomeIndex = argv.indexOf('--keep-home')
  const keepHome = keepHomeIndex !== -1
  if (keepHome) argv.splice(keepHomeIndex, 1)

  const home = mkdtempSync(join(tmpdir(), 'dsh-memory-evolve-home-'))
  mkdirSync(join(home, '.config'), { recursive: true })
  writeFileSync(join(home, '.gitconfig'), GITCONFIG)

  // 默认跑全套；带额外参数时按参数跑（便于单文件复现）。
  const testArgs = argv.length > 0 ? argv : ['tests/*.test.js']
  const child = spawn(
    process.execPath,
    ['--test', ...testArgs],
    {
      cwd: PACKAGE_ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        HOME: home,
        // 别让测试把状态写到调用者的真实 home
        DSH_HOME: join(home, '.dsh'),
        XDG_CONFIG_HOME: join(home, '.config'),
        // 中文 locale 会让 git 输出本地化，测试断言的是英文 stderr
        LC_ALL: 'C',
        LANG: 'C',
      },
    },
  )

  const code = await new Promise((resolve) => {
    child.on('error', (error) => {
      console.error(`run-tests: 无法启动 node --test：${String(error)}`)
      resolve(1)
    })
    child.on('close', (exitCode) => resolve(exitCode ?? 1))
  })

  if (keepHome) console.log(`run-tests: HOME 保留在 ${home}`)
  else rmSync(home, { recursive: true, force: true })
  return code
}

process.exitCode = await main()
