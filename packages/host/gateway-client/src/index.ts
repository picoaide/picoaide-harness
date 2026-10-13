/**
 * `@picoaide/dsh-gateway-client` —— 宿主侧**网关客户端**的共享叶子包。
 *
 * 三个子路径，各有明确职责（也是 enterprise 保留的同名 re-export 面）：
 *   - `./auth`：网关 HTTP 调用（`gatewayFetch` / `fetchJSON`）、鉴权错误分类
 *     （`AuthError` / `ApiError` / `isPasswordChangeRequired`）、登录与改密；
 *   - `./config`：持久化会话形状（`Session`）与 bootstrap 载荷形状；
 *   - `./electron`：Electron 模块惰性加载（main 进程专用）。
 *
 * 为什么是一个**叶子包**而不是 `@picoaide/dsh-enterprise` 的一部分：功能模块包
 * （`@picoaide/dsh-capability-center` / `@picoaide/dsh-wasm-apps-host`）的本机路由
 * 必须真的调网关，而它们指向 enterprise 会闭合出
 * `desktop → wasm-apps-host → enterprise → desktop` 这个构建环。见
 * `tsdown.config.ts` 的长注释与 `scripts/check-workspaces.mjs` 的 `PACKAGES` 表。
 *
 * @module @picoaide/dsh-gateway-client
 */
export * from './auth.ts'
export * from './config.ts'
export * from './electron.ts'
