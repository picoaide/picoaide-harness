/**
 * 网关客户端的**同名 re-export**。
 *
 * 实现已收敛到叶子包 `@picoaide/dsh-gateway-client/auth`（2026-10-13，P0-b）：
 * 功能模块包（能力中心 / WASM 应用宿主）的本机路由也要调网关，而它们指向
 * `@picoaide/dsh-enterprise` 会闭合出
 * `desktop → wasm-apps-host → enterprise → desktop` 这个构建环。本文件只保留
 * 同名子路径与导出面 —— `@picoaide/dsh-enterprise/server-connector/auth` 仍是
 * `packages/client/account-card` 在消费的外部契约，改导出面要连它一起改。
 *
 * **改判定请只改叶子包那份。**
 */
export * from '@picoaide/dsh-gateway-client/auth'
