/// <reference types="vite/client" />

/**
 * 构建期注入的变体开关（`define`，真源 = `server/webadmin/features.mjs`）。
 *
 * **为什么声明而不是 import**：`define` 是文本替换，不是模块导出 —— 写成
 * `import { __FEATURE_SKILLS__ }` 会被当成真的模块去解析而失败。声明放在这里让 `tsc`
 * 认这个标识符，运行期由打包器替换成布尔**字面量**（折叠分支的前提）。
 *
 * 缺省（不设 `FEATURES`）= 三个模块全开（既有行为逐字节不变）。
 */
declare const __FEATURES__: string
declare const __FEATURE_SKILLS__: boolean
declare const __FEATURE_APPS__: boolean
declare const __FEATURE_CONNECTORS__: boolean
