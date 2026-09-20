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
//	本包**不**引入任何自创的签名/加密方案（自己发明的方案通常是"看起来安全"，
//	且会把一个待拍板的设计问题伪装成已解决的问题）。
//
// # 缓存可信度的落地口径（2026-09-21 审计修复）
//
// 原设计把"接受风险 vs 加校验"列为未拍板项，只留了一个恒返回 nil 的钩子
// （`VerifyCacheEntry`）。审计指出这条的失败形态是"看起来有校验、其实没有"，
// 因此改为**可执行的两件事**：
//
//  1. **形状校验（已实现）**：`cachetrust.Verify(dir)` 逐项校验缓存目录树 ——
//     根与各级子目录必须是真实目录（不是符号链接）、权限不含 group/other 写位且属主可读；
//     条目必须是**普通文件**（不是符号链接/设备/FIFO）、非空、权限不含 group/other 写位。
//     编译侧 `Compiler` 在构造时 `cachetrust.Ensure`（先确认根是真实目录，再 MkdirAll +
//     Chmod，最后校验），违规在 `IsolationRequire` 下**拒绝启动**、其余档位告警并进运维日志。
//     **执行侧不再"同一条校验的另一种策略"，而是降级**（2026-09-21 独立审计 P1-①）：
//     `runtime.NewCompilationCache` 拿不到可用缓存时返回 (nil, nil)，由 `runtime.New`
//     回落到进程内缓存并告警 —— 缓存是性能优化、不是执行前提，只读挂载 / `--user`
//     非属主 / k8s `runAsUser` 下 Chmod 必然失败，让服务端因此起不来是错误取舍
//     （执行侧的"不可用"与"不可信"都不该升级成整站不可用）。
//  2. **认账（写进本注释，不再藏在 TODO 里）**：**缓存条目没有内容签名**，
//     与宿主同 uid 的进程仍可投毒。要真正闭合需要"宿主持有产物清单 + HMAC"或
//     独立 uid / 只读挂载（部署面）。这条缺口在 docs/decisions 里有对应认账，
//     不假装已解决。
//
// 为什么 lint 级步骤 1 值得做：它能挡住**权限漂移**（旧版本/人工 chmod 留下的
// group-writable 目录）与**符号链接重定向**这两类真实且低成本的投毒形态，
// 并且把"能不能信"变成一个可复跑的函数，而不是读代码才知道的事实。
package compile

// verifyCacheEntryResidual 说明本包对缓存条目的**剩余**信任假设（供运维面/文档引用）。
//
// 保留一个具名常量而不是散在注释里：值本身是给人和测试一个稳定锚点，
// 断言"我们没有偷偷把残余风险说成已解决"。
const verifyCacheEntryResidual = "缓存条目无内容签名：与宿主同 uid 的写者仍可投毒（需独立 uid / 只读挂载 / HMAC 清单才能闭合）"

// CacheTrustResidual 返回缓存可信度的残余风险说明（运维面/文档引用）。
func CacheTrustResidual() string { return verifyCacheEntryResidual }
