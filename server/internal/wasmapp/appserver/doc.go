// Package appserver 实现 WASM 应用平台的**客户端专属请求管线**（设计总纲 §8.1）：
// 从"桌面客户端的协议 handler 把应用请求包成信封送进来"到"wasm 实例吐回响应"的全部环节。
//
// 设计依据：`docs/planning/2026-09-19-wasm-client-only-design.md`（本文注释里的 §x.y 均指该文档）。
//
// # 管线顺序（顺序本身就是语义，不要调整）
//
//	① 应用反查      §8.1①  app_id（来自路由参数）→ apps(kind=wasm_app)；查不到/软删/冻结 ⇒ 404
//	② 生效版本      §6.1   LatestApprovedWasmReleaseMeta（**不含制品字节**，P0-3）；无生效版本 ⇒ 404（可读页面）
//	③ 身份          §7.1   帧内 user 的唯一来源：由客户端注入 + 宿主投影（应用伪造不了）
//	④ 准入          §4.4   一律要求登录（历史公开档位在读取侧即 login）；无身份 ⇒ 401
//	⑤ 跨源写防护    §8.1⑦ 非幂等方法必须 Origin == `<app scheme>://<app_id>`（自定义协议下 Origin 由 handler 合成）
//	⑥ 请求体上限    §4.6   limits.AppRequestBodyMaxBytes；超限 ⇒ 413 + 可读 JSON
//	⑦ 静态资源      §4.2   宿主直出（缓存键 app_id + version + path）；命中"资源确实存在"才直出
//	⑧ wasm 执行     §6.1⑤  排队 → 组装帧 → 编译模块缓存 → runtime.Serve → 写回（失败绝不 200）
//
// # 与其他模块的边界
//
//   - 身份与请求形状由**客户端**决定（协议 handler 合成 URL/Origin/头），本包只做
//     信封校验与投影；平台上没有"按主机名分流"这回事；
//   - 帧协议 / 沙箱 / 计时 / 失败映射在 `runtime`（模块 C）：本包只负责**装配**与
//     HTTP 侧语义（状态码、安全头、信封、缓存），不重复实现任何一条运行时闸门；
//   - 持有性证明（app-proof）在 `appproof` + `api`：本包拿到的已经是"通过准入的身份"；
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
