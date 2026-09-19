// Package appserver 实现 WASM 应用平台的**应用子域请求管线**（设计基线 §6.1 的 ④⑤）：
// 从"员工浏览器带着一次性票回到 `<app_id>.<基域>`"到"wasm 实例吐回响应"的全部环节。
//
// 设计基线：docs/planning/2026-09-17-wasm-app-platform.md。本文注释里的 §x.y 均指该文档。
//
// # 管线顺序（顺序本身就是语义，不要调整）
//
//	① 应用反查      §4.8   Host 标签 → apps(kind=wasm_app)；查不到/软删/冻结 ⇒ 404，绝不回落主站
//	② 生效版本      §6.1   LatestApprovedWasmReleaseMeta（**不含制品字节**，P0-3）；无生效版本 ⇒ 404（可读页面）
//	③ 换票兑换      §6.1④  ?ticket= ⇒ 一次性 code 换 host-only + HttpOnly + Secure + SameSite=Strict Cookie
//	④ 身份          §7.1   帧内 user 的唯一来源（宿主构造，应用伪造不了）
//	⑤ 准入          R24/R25 应用配置的 access 决定是否要求登录；平台**不做**名单校验（名单在应用里）
//	⑥ 匿名限流      R35     仅匿名请求走全局 + 每 IP 令牌桶；拒 ⇒ 429 + Retry-After
//	⑦ 跨应用写防护  §4.8   非幂等方法必须 Origin == 自身源（同 eTLD+1 下 SameSite 挡不住跨源写）
//	⑧ 请求体上限    §4.6   limits.AppRequestBodyMaxBytes；超限 ⇒ 413 + 可读 JSON
//	⑨ 静态资源      §4.2   宿主直出（缓存键 app_id + version + path）；命中"资源确实存在"才直出
//	⑩ wasm 执行     §6.1⑤  排队 → 组装帧 → 编译模块缓存 → runtime.Serve → 写回（失败绝不 200）
//
// # 与其他模块的边界
//
//   - 主机名门控（`HostGate`）在更外层：进到 ServeApp 时 appLabel **已经过形态校验**，
//     且保证"应用子域只挂应用路由树"（主站路由在子域结构上不可达，§4.8）；
//   - 帧协议 / 沙箱 / 计时 / 失败映射在 `runtime`（模块 C）：本包只负责**装配**与
//     HTTP 侧语义（状态码、安全头、信封、缓存），不重复实现任何一条运行时闸门；
//   - 换票与会话在 `session`（模块 G）：本包只调用，不自己实现票务；
//   - SQL 闸门在 `appdb`（模块 B）：本包只按 §4.5「一应用一 driver 实例 + 一应用一连接、
//     跨应用不复用」的语义**按应用持有**句柄（池、淘汰与污染回收见 dbpool.go）；
//   - 静态资源的抽取与读取在 `assets`（模块 D）：本包只做**路由判定**与 HTTP 缓存语义。
//
// # 三条硬规则（违反即红线）
//
//  1. **绝不把失败报成 200**（§7.4 硬断言）：`Result.KillReason != nil` 一律按
//     `KillReason.Status()` 与错误信封返回，连"应用自己写了 200 的响应帧但宿主判它失败"也是失败；
//  2. **Cookie / Authorization 绝不进帧**（红线 3）：帧会进 guest 线性内存，可能被应用写进
//     自己的数据库或日志 ⇒ 应用既读不到凭证，也不该在帧里看到凭证；
//  3. **宿主独占安全头**（§4.8：CSP / nosniff / Referrer-Policy / X-Frame-Options），
//     应用自带的同名头一律剥离，含 4xx/5xx 响应。
package appserver
