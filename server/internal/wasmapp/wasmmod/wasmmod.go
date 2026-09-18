// Package wasmmod 是 WASM 应用平台的**静态模块校验器**：在编译之前就能判定的上传期判据
// 全部在这里（设计基线 §4.2 validate 行 / §7.4 失败语义 / §10.2 沙箱逃逸）。
//
// 职责边界：
//   - 本包**只解析字节**，零第三方依赖（不依赖 wazero）：自解析段表才能给出"哪一段、哪个偏移、
//     为什么"的结构化错误，而不是把 wazero 的裸错误当唯一出口（§4.2）；
//   - "一次真实编译 + 合成帧干跑"不在这里（同进程、同配额，由运行时模块负责，§4.2）。
//
// 两个入口：
//
//	Parse(data)                结构和格式（魔数 / 版本 / 层 / 段表 / 导入 / 导出）
//	Validate(data)             Parse + 全部策略判据（体积 / 自定义段总量 / 导出面 / 导入面白名单）
//	ExtractCustomSections(data) 发布期静态资源抽取（返回复制过的内容）
//
// 失败语义（§7.4，HTTP 状态由 apperr.StatusOf 给出）：
//
//	SECTION_MALFORMED              段表/头部结构非法（422）
//	COMPONENT_MODEL_UNSUPPORTED    层字段 != 0，即组件模型产物（422，§10.2 第 19 项）
//	SECTION_OVERRIDE_OVERSIZE      自定义段总量 > limits.SectionTotalMaxBytes（422，§7.4 用名）
//	VALIDATE_FAILED                导出面不满足应用契约（缺 _start / memory 未导出）
//	WASM_TOO_LARGE                 模块体积 > limits.WasmMaxBytes
//	IMPORT_NOT_ALLOWED             导入模块名或符号不在白名单（422，§10.2 第 17 项）
//	IMPORT_SIGNATURE_MISMATCH      符号在名单内但类型不符（422，§10.2 第 18 项）
//
// 导入面白名单是**生成产物**（imports_gen.go），由 cmd/picoaide-wasm-imports-gen 真编译
// 全部来源程序后 dump 导入集、取**并集**得到——手写清单即门禁测试红（§5.5）。
// 覆盖性另有一条**独立于生成来源**的门禁（imports_coverage_test.go）：它真编译
// testdata/stdrender（html/template 渲染 + (*os.File).ReadAt/WriteAt 的最小程序），
// 断言其导入集是白名单子集 —— 来源程序退化时白名单会跟着变小，这条会立刻红（审计 P0-1）。
// 注意：宿主能力调用走 stdin/stdout 上的 JSON-RPC（§7.2），**不是 wasm 导入**，
// 所以白名单实际就是 Go wasip1 运行时的 WASI 导入集。
//
// # 白名单的语义：Go 可发出的 WASI 面（保守超集），不是"参考实现恰好用到的那些"
//
// 判据是"**Go wasip1 运行时可能发出的全部 `wasi_snapshot_preview1` 导入**"。
// 为什么不能只按最小样例生成（模块 C 实测的功能缺陷）：参考实现 refapp 只做帧协议 + 内存分配，
// 导入面恰好 16 个符号；而任何一行 `os.Stat` 都会再引入 `path_filestat_get`、`os.ReadDir` 会引入
// `fd_readdir`……只按 refapp 生成，等于把"用了 os 包文件 API 的合法 Go 应用"直接判
// IMPORT_NOT_ALLOWED，而 Go 是 Tier 1 官方支持语言（§9.1）。这是功能缺陷，不是安全取舍。
//
// 允许导入 `path_open` / `fd_readdir` / `path_unlink_file` 为什么**不**破坏红线：
//
//   - 红线 5（应用不能读宿主文件系统）由**运行时零 preopen** 保证，不由白名单保证
//     （§4.3「文件系统：⚠️ 零 preopen」/ §15.1 第 1 条）：WASI preview1 的文件系统语义是
//     "没有 preopen 的路径就不存在"，guest 拿不到任何可用 fd（temp/wasm-probe 已实测全 DENIED）。
//     ⚠️ 措辞更正（审计实测，2026-09-18）：errno **不是** `ENOSYS`——零 preopen 下
//     Go 的 `os.Open/Stat/ReadDir` 拿到 `EBADF(8)`（Go 的 syscall 层先查 `fd_prestat_get`）、
//     原生 `path_open(fd, "/abs")` 拿到 `EPERM(63)`（wazero 先否决前导 `/`）、相对路径 `EBADF(8)`、
//     stdio fd 上 `ENOTDIR(54)`；`ENOSYS(52)` / `ENOTCAPABLE(76)` 一次都没出现。
//     旧注释写 ENOSYS 是错的（会让后来者写出永远无法通过的门禁断言）；
//   - 红线 4（应用不能出站）由"**没有任何途径得到一个 socket fd**"保证（§10.2 第 16 项）：
//     preview1 **有** `sock_accept` / `sock_recv` / `sock_send` / `sock_shutdown`，但
//     **没有** `sock_open` / `sock_bind` / `sock_listen` / `sock_connect` ⇒ 造不出 socket fd
//     （实测 `sock_accept(0..10)` / `sock_shutdown(3)` 全 `EBADF(8)`；`syscall.Socket` 在 wasip1 上
//     是 "Not implemented on wasip1"）。而 Go 运行时自己就会发出 `sock_accept` / `sock_shutdown`
//     （经 `text/template` 的 **Execute** 可达，审计 P0-1 实测）⇒ 白名单**必须**放行这两条，
//     否则"用 html/template 渲染页面"的合法应用会被 `IMPORT_NOT_ALLOWED` 拒。所以本包在这里的
//     职责是两条：**只放行不造 fd 的那两个 socket 符号** + **拒绝任何非 `wasi_snapshot_preview1`
//     的模块**（env.* / js.* / wasi_unstable / preview2），imports_gen_test.go 的
//     TestWhitelistSecurityBoundary 与 imports_coverage_test.go 是它们的正反断言。
//
// 推论：真正要守住的是"零 preopen"（运行时配置，不属于本包）与"白名单里只有 preview1 符号、
// 且 socket 面恰好是那两条"（本包 + 门禁）。白名单**宽**是刻意的；白名单**窄**才是缺陷
// （审计 P0-1："缺 4 条 ⇒ 渲染页面的合法应用根本发不出去"）。
package wasmmod
