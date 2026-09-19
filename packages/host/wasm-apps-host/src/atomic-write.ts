/**
 * 私有文件的原子落盘（**唯一实现**；接缝 J-atomic，主控 2026-09-19 裁决）。
 *
 * 为什么有这一层：`windows.ts`（窗口几何记忆）与 `app-proof.ts`（安装密钥）都要写
 * "半写就等于损坏"的文件 —— 半写的密钥文件比没有密钥更糟（启动自检会把它当损坏），
 * 半写的状态文件会让下一次打开读到畸形 JSON。**两处各写一份 temp+rename 就等于两份
 * 实现**（本仓已被同类漂移咬过），所以只留这一个助手。
 *
 * **偏离声明（主控已回写总纲 §16.1）**：设计总纲原定用上游
 * `@deepseek-ai/dsh-atomic-write`，但该依赖当前**不在**本包 node_modules（只在
 * `packages/host/desktop`）。多泳道并行期间改依赖图（`yarn install` + lockfile）风险
 * 高于收益，故本版用等价的本地实现；**W6/W7（全部泳道静默后）切换**到上游包，
 * 届时本文件只剩一行转发。
 *
 * 语义（与上游包一致的子集）：
 *  1. 同目录临时文件（`<name>.<随机>.tmp`，0600）→ `rename`（同文件系统内原子）；
 *  2. 目标目录按需创建为 **0700**（密钥/状态都在用户私有区）；
 *  3. 任何一步失败 ⇒ 删除临时文件并把错误抛给调用方（**不留半个文件**）。
 *
 * @module @picoaide-wasm-apps-host/atomic-write
 */

import { randomBytes } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 目录权限：只有本用户可进入（安装密钥/窗口记忆都在这里）。 */
export const PRIVATE_DIR_MODE = 0o700

/** 文件权限：只有本用户可读写。 */
export const PRIVATE_FILE_MODE = 0o600

/**
 * 确保目录存在且是 0700（已存在的目录不改权限 —— 那是别人的目录布局）。
 * @param dir - 目标目录。
 */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE })
}

/**
 * 原子写入一个私有文件（临时文件 + rename；失败不留半个文件）。
 *
 * @param path - 目标文件绝对路径。
 * @param data - 内容（字符串或字节）。
 * @param options - 权限与临时文件名随机源（测试用）。
 * @returns 写入完成（rename 已生效）。
 * @throws 目录创建/写入/rename 任一失败（临时文件已尽力清理）。
 */
export async function atomicWriteFile(
  path: string,
  data: string | Uint8Array,
  options: {
    mode?: number | undefined
    randomSuffix?: (() => string) | undefined
  } = {},
): Promise<void> {
  const mode = options.mode ?? PRIVATE_FILE_MODE
  const suffix = options.randomSuffix?.() ?? randomBytes(6).toString('hex')
  await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE })
  const temporary = `${path}.${suffix}.tmp`
  try {
    await writeFile(temporary, data, { mode })
    await rename(temporary, path)
  } catch (cause) {
    // 尽力清理：清理失败不能掩盖原始错误（否则症状是"写失败了但报的是 ENOENT"）。
    await rm(temporary, { force: true }).catch(() => undefined)
    throw cause
  }
}
