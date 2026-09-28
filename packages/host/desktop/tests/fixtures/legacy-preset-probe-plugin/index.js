/**
 * 真实插件，用来证明「旧目录式预设声明的行**真的挂上了**」。
 *
 * 这是**能力判据**而不是结构判据：`apply()` 把标记文件写出来这件事只有在
 * "声明行被 import 且被激活、且 `config` 逐字传到了插件"时才会发生。只断言
 * "roster 里有这个 id" 或 "Loader 里有这一行" 都咬不到"plugins 被掏空"这类破坏。
 */

import { appendFileSync } from 'node:fs'

export const name = 'legacy-preset-probe-plugin'

/**
 * 落一个文件系统副作用。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {{ marker: string, label: string }} config - 由预设声明行逐字传下来的配置。
 */
export function apply(ctx, config) {
  appendFileSync(config.marker, `${config.label}\n`)
}
