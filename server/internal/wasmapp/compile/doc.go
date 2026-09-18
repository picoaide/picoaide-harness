// Package compile 是 WASM 应用平台的**编译侧门面**（R19 / R31）：
//
//   - 父侧：单进程串行（并发 1）+ 有界队列（满则 429）+ 磁盘编译缓存回收
//   - 上传频率闸门 + OS 级隔离启动器（bwrap）；
//   - 子侧：cmd/picoaide-app-compile（另一个二进制），只读一个模块文件、只写缓存目录，
//     不继承宿主 env，被父侧用 bwrap 隔离。
//
// 依赖方向（capapi.go 的包注释）：本包只依赖 limits/apperr/wasmmod 与 wazero，
// **不 import internal/wasmapp/runtime**（两侧 RuntimeConfig 的一致性是结构性问题，
// 用测试对拍而不是用 import 绑定，见 NewCompilerRuntimeConfig 的注释与 consistency_test.go）。
//
// 静态校验**委托 wasmmod**（模块 A 的权威实现，导入白名单由参考实现构建期生成）：
// 本包只做类型适配（Report），不再自带第二份段解析器——两份实现必然漂移，
// 而漂移的后果是"预检说能过、编译子进程说不能过"这类不可复现的行为差异。
// 编译子进程与父侧预检用**同一个** NewValidator()，见 staticvalidate.go。
//
// # 认账：编译缓存目录是信任边界（§4.3.1-d / §11 第 24 项）
//
// **风险（设计文档已列，这里逐条认账）**：
//
//	wazero 原话（cache.go:55）："The embedder must safeguard this directory from
//	external changes"。缓存条目只带**同文件内**的 CRC32 —— 它能发现**损坏**，
//	不能发现**篡改**。而执行进程（internal/wasmapp/runtime）会把这些条目
//	**mmap 成机器码直接执行**。因此：
//
//	  1. 编译进程一旦被攻破（它读的正是攻击者提交的字节，§15.1 第 14 条正是
//	     假设它**可能**被攻破），缓存目录就是一条**提权到 server 进程的持久通道**：
//	     写入/改写条目 → 下次 server 启动或下个请求命中 → 在 server 进程里执行；
//	  2. 该通道**跨重启持久**（这正是磁盘缓存的收益来源）；
//	  3. CRC32 不构成防线：攻击者当然会同时算对 CRC。
//
// **当前缓解（本包已实现的部分）**：
//
//   - 目录权限 0700（limits.DataDirMode）：只有属主能读写 ⇒ "谁来写"被压到
//     "跑编译进程的那个用户"（见 cache.go 的 cacheDirIsTrustBoundary，测试断言）；
//   - **只有编译进程写**：执行进程只读；回收（唯一会删条目的代码）在父侧，
//     子进程只调 wazero 的 put/get（§10.3 第 35 项的分工）；
//   - env 白名单（CompileProcessEnv）：被攻破的编译进程拿不到 PG DSN / master key；
//     ⚠️ 口径说明：env 白名单堵的是**环境变量通道**，**文件通道**由上面的读白名单堵。
//     两者缺一不可（只做 env 白名单时，同 uid 的编译进程仍能直接 cat master.key ——
//     本模块的第一版就是这样，已修）；
//   - OS 级隔离（bwrap --unshare-all + **读白名单**）：编译进程只能看到
//     系统目录白名单 + 模块目录 + 自己二进制所在目录（全部只读）+ 缓存目录
//     （唯一的**宿主**可写面）
//   - 沙箱内另有**私有 `/tmp` tmpfs** 可写（随命名空间释放、宿主看不到）：
//     所以"唯一可写面"的口径是宿主可写面（审计 P2-11 的措辞澄清）
//   - 宿主的数据根（master key、各应用 SQLite 库、.env）与家目录
//     **整体不可见**，网络是独立 netns（isolate_linux.go / bwrapReadOnlySystemDirs）。
//     这一点由 TestBwrapCannotReadOutsideWhitelist 用"数据根下造 0600 假 master key
//     并断言沙箱内读不到（加进白名单后又能读到）"守着。
//     ⚠️ 实测边界（本机，2026-09-18，审计 P2-9 已认账）：嵌套容器里 `--proc /proc`
//     挂新 procfs 会被 "Operation not permitted" 拒掉，此时回落到
//     `--ro-bind-try /proc /proc`（宿主 /proc **只读**绑定）。代价说清楚：
//     回落时编译进程**能读到宿主的进程列表**（`/proc/<pid>` 的 cmdline/environ 中
//     宿主的可读部分），能据此枚举宿主进程与环境线索；**不放宽写面**（沙箱内的 `/`
//     仍是空 tmpfs，宿主文件系统不可见）、也不能给宿主进程发信号（只读绑定）。
//     回落信息进 plan.describe()/启动日志，不静默；风险登记见实施报告 §12。
//   - 进程级资源上限：RLIMIT_AS（默认 2 GiB）与 RLIMIT_CPU（默认 90 s），
//     由子进程自己设（§4.3「编译进程超限被杀 ⇒ COMPILE_OOM」的进程内落地）。
//     **seccomp 与 cgroup 限额未做**（见交付说明的未做项），部署面应叠加 cgroup。
//   - 与执行进程**共用同一数据根**但权限分离：目录属主=编译进程，
//     执行进程以只读方式打开（部署面保证；本机可断言的是目录权限）。
//
// **明确不做的事（不发明加密方案）**：
//
//	设计文档把"接受风险 vs 加校验/隔离方案"列为**未拍板项**（§11 第 24 项）。
//	在拍板之前，本包**不**引入任何自创的签名/加密方案（自己发明的方案通常是
//	"看起来安全"，且会把一个待拍板的设计问题伪装成已解决的问题）。
//	钩子位置见下方 VerifyCacheEntry。
//
// # 缓存条目校验钩子（未拍板项的落点）
//
// VerifyCacheEntry 是"如果将来给缓存条目加校验"的**唯一接入点**：
//
//   - 现在：空实现（恒返回 nil），语义是"不校验，接受 §12 的认账"；
//   - 将来若拍板加校验：在这里实现（例如"宿主持有编译产物清单 + HMAC"或
//     "缓存条目与模块字节的绑定校验"），**调用时机已经预留**（见函数注释）。
//
// 为什么保留一个空实现而不是干脆不写：一个"想加校验时要改三处调用点"的设计
// 会让这件事永远不做；留一个**名字明确、调用点已接好**的钩子，是把决策成本
// 降到"只改这一个函数"。
package compile

import "github.com/picoaide/picoaide/internal/wasmapp/apperr"

// VerifyCacheEntry 校验一条缓存条目是否可信（**当前为空实现**）。
//
// TODO(§11 第 24 项，未拍板)：设计文档把"编译缓存目录的属主与信任边界"
// 列为待拍板项——接受风险（写进 §12 认账）还是加校验/隔离方案。
// 本函数就是"加校验"这条路的落点，**在拍板前不实现**（不发明方案）。
//
// 接口语义（为将来的实现固定下来，避免届时改签名）：
//   - moduleSHA256：被编译模块的 sha256（内容寻址的稳定键；wazero 的条目名
//     与之相关但不相同，见 §4.3.1 的键构成）；
//   - 返回 nil 表示"可接受"；返回 *apperr.Error 表示"不可信，应视为缓存未命中"；
//   - **绝不**返回"部分可信"的中间态：调用方要么用这条缓存，要么重新编译。
//
// 调用时机（已预留）：执行进程命中缓存**之前**（internal/wasmapp/runtime 侧），
// 以及父侧回收/排障路径上。当前未接线的理由是：没有校验实现时接一个恒 nil 的
// 调用只是多一次函数调用，反而会让"这条路径存在校验"变成错觉。
func (c *Compiler) VerifyCacheEntry(moduleSHA256 string) error {
	// 空实现：接受风险（§12 认账）。见包注释"明确不做的事"。
	_ = moduleSHA256
	var _ *apperr.Error // 保留 apperr 的 import 语义：将来实现必须返回平台错误码
	return nil
}

// VerifyCacheEntryEnabled 报告当前是否真的在做缓存条目校验（/readyz 与运维面用）。
//
// 存在的意义：让"我们目前不校验缓存条目"成为一个**可查询的事实**，
// 而不是只能靠读代码才知道的事。将来 VerifyCacheEntry 落地实现时这里同步返回 true。
func (c *Compiler) VerifyCacheEntryEnabled() bool { return false }
