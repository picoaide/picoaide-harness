# 决策：WASM 应用平台设计文档的审计修正（2026-09-17）

> ⚠️ **部分作废（2026-09-19）**：本文中**涉及「匿名限流 / 应用子域 host 门控」的采纳项与断言**
> 已随「客户端专属」改造整体删除（`anonlimit`、HostGate/子域门控，见总纲 §8.4）。
> 与访问模型无关的 wazero / 沙箱 / 内存结论继续有效。
> **权威文档**：`docs/planning/2026-09-19-wasm-client-only-design.md`。

## 背景

一份**第三方可行性分析报告**（在另一环境，依据 `2026-09-17-wasm-app-platform.md` 的第 751 行定稿 + 一个更旧的仓库快照）
对设计做了独立复现与代码引用核对，给出 2 条 P0、3 条建议修正。我们收到后没有直接采信，而是
**用 wazero v1.12.0 源码 + 3 个自建探针 + 两个只读子代理**逐条复核。结论：报告的核心复现可信、
有三处真问题，但 **2 条 P0 里 1 条机制错、1 条事实错，4 条细节修正里 2 条是 revision 漂移、1 条完全反了**，
且它漏掉了一个比自身所有发现更重的设计缺口（编译缓存的信任边界）。

本决策记录**修正设计文档、补齐不变量、把关键探针入库**；不采纳报告的错误结论。

## 逐条判定

| 报告条目 | 判定 | 依据（本轮复核） |
|---|---|---|
| P0-1 编译/执行 `RuntimeConfig` 不一致 ⇒ 磁盘缓存永不命中 | 🟡 **保留结论，重写机制** | 真凶只有 `WithCloseOnContextDone`：`runtime.go:261` → `wasm.Module.AssignModuleID(binary, listeners, ensureTermination)` → 键 `sha256(moduleID‖magic‖CPU features)`。探针实测：只改 `WithMemoryLimitPages` **仍命中同一键**（`429b279e…`）；只改 `WithCloseOnContextDone` **换键**（`68689fd7…`，条目 10.06→10.51 MiB）。影响也应改写：validate 的 2 s 干跑本来就必须开这个 flag，代价是"发布期编译暖不到执行进程 + 同模块两份条目"，不是"R31 收益全丢" |
| P0-2 §14/§15.2 的 5 个探针目录全部不存在 | 🔴 **事实错误**（但"未入库"成立） | 5 个目录在工作区都在、文件名与文档一致（`parse-wasm.py` 等）；真问题是 `temp/` 被 `.gitignore:84` 忽略 ⇒ 对任何 clone 不可见 |
| P1-1 默认随机源不是"全零"，是固定种子 42 的伪随机 | 🟢 **采纳** | `internal/platform/crypto.go:12/15-17`；探针实测三个独立 Runtime 的 guest 首读完全相同（`dfd79b4d76429b61`）、假时钟 2022-01-01。比"全零"更隐蔽 |
| P1-2 §4.8 禁命中清单漏 `/admin/*` 与 `/healthz` | 🟢 **采纳（改 allow-list）** | 全仓 Go 代码零 host 判断（`Request.Host` 仅 `clientrelease.go:200`）；`/`、`/portal`、`/admin/*` 都在 NoRoute 分支、`/healthz` 在根引擎上 ⇒ 清单式禁命中必然漏 |
| P2-1 kind 影响面 108 处算错，实测 104 | 🔴 **revision 漂移** | 同一 `AppKind` 口径：HEAD（含 `82222c02d9`）= **108 行/110 次/13 文件**（文档数字正确）；文档提交 `25de9e7c55`/master = 104 行/106 次。报告把它当成"文档算错" |
| P2-2 `auth-gate.ts` 实际 1883/2079 | 🔴 **报告反了** | 文档引的 1936/2132 在当前分支**精确命中** `timeoutMs: 30000`；1883/2079 是 `handler: async (…)`，且只对 09-16 旧快照 `39692cac6e` 成立；"1936/2132 是 `if (content === null)`"在任何 revision 都不成立 |
| P2-3 `status` CHECK 已含三态 | 🟢 **采纳** | `0053_apps.sql:45`；§11 第 3 项由"迁移两件"改"迁移一件" |
| P2-4 软删版本永久占号 ≠ R18 | 🟢 **采纳（补一句）** | `0053:50/:53`；原文档只写了"失败不占号" |
| §6.1 非枚举 kind 会 500 | 🟡 结果对、因果错 | 第一道闸是 Go 白名单 `serverstore/apps.go:127-128`（不是 DB CHECK），且今天 4 个生产调用点全传常量 ⇒ HTTP 不可达 |
| §6.2 遗留 1 MiB 会击穿 24 MiB 白名单 | 🔴 假警报 | 生产走 `router.go:72-73` + `:101-106` 白名单（工作正常），文档 `:116/:691` 已要求新上传路由登记 |
| §6.3 `kindLabelOf` 是第二个回落点 | 🟢 采纳 | `publish.go:369-374`；已补进 §11 第 4 项 |
| ~~§6.5 compose 默认注入可信代理，干扰"未配置则拒启"~~ | ~~🟢 采纳~~ **已废弃（2026-09-19，对象随 W4 删除）**：`anonlimit` 与匿名面的启动自检均随总纲 §8.4 删除；`PICOAI_TRUSTED_PROXIES` 仍保留但只用于客户端 IP 归属（总纲 §12） | ~~`docker-compose.yml:98` = `172.28.0.2`；已补进 §4.8 匿名限流行~~ |
| §6.4 / 6.6 / 6.7 / 6.8 | 🟢 成立（无需改动设计） | Caddy 单值 site + `header_up Host`、无全局安全头中间件、usage 月分区 + 永久账本、wasip1 `_start` 自动退出（引文行区间应为 `config.go:525-527`） |
| §七 内存实账与建议 | 🔴 不采纳 | 报告把 `runtime.MemStats.Sys` 当 RSS（wazero 机器码走 `x/sys/unix` mmap，**不进 `Sys`**）；"关实例不归还 OS""`/readyz` 按 RSS 判水位会误报"缺证据；"实测均摊×系数"会削弱 fail-closed 的启动自检 |

## 落地的改动

1. **设计文档纠错**（`docs/planning/2026-09-17-wasm-app-platform.md`）
   - §4.3 随机源：改为"固定种子 42 的确定性伪随机 + 跨实例一致"，并标注是 **ModuleConfig（每请求设）**；判据保持 §10.2 第 21 项（"两次独立实例序列不同"）。
   - §4.5 / §15.1 第 5 条：`VACUUM INTO` **不是**"独立于 ATTACH 的文件写原语"——它与 ATTACH 同受 `SQLITE_LIMIT_ATTACHED` 约束（探针实测 =0 时二者一起被拒、目标文件不生成，v1.55.0/v1.59.0 一致）⇒ 唯一闸门是"每条连接重设 `LIMIT_ATTACHED=0`"，语句白名单禁它是纵深。
   - §11 第 3 项：`app_releases.status` **无需迁移**（CHECK 已含三态）。
   - §4.1 版本号：补"**已落行的版本永久占号**（被拒/软删同样占号）"，与 R18 分开表述。
   - §4.2 客户端超时：不再写死 `auth-gate.ts` 行号，改符号引用（行号会随提交漂移）。
2. **新增 §4.3.1「编译缓存：唯一构造函数与信任边界」**——四条不变量：
   (a) 编译/执行两侧共用一份 `newRuntimeConfig()`（`WithCloseOnContextDone`/`CoreFeatures`/engine 必须相同，内存上限可不同）+ 测试断言；
   (b) 键的可复用前提 = 同 wazero 版本 + 同 CPU features + 同 flag（影响缓存容量与回收口径）；
   (c) 每次实例化新建 ModuleConfig（随机源/时钟/stdio 都是 ModuleConfig，不得跨请求复用）；
   (d) **缓存目录是信任边界**：wazero 明写 *"The embedder must safeguard this directory from external changes"*（`cache.go:55`），条目只有同文件 CRC32（防损坏不防篡改），而执行进程把这些字节 mmap 成机器码 ⇒ 编译进程一旦被攻破，缓存即提权通道（列 §11 第 24 项待拍板）。
3. ~~**§4.8 host 门控改成 allow-list**（主站路由在子域一律不注册），并在 §10.1 增加 13a–13d 四条断言~~ —— **已废弃（2026-09-19，对象随 W4 删除）**：应用子域与 HostGate 主机门控已整体删除（总纲 §8.4）；替代判据 = 总纲 §13 I1「公网无应用 origin ⇒ 404 且不返回应用内容」。
4. **证据入库**：新增 `docs/evidence/2026-09-17-wasm-app-platform/`——`cache-key/`（缓存键敏感性、HIT/MISS 矩阵）、`random-get/`（默认随机源端到端）、`vacuum-into/`（`LIMIT_ATTACHED` 与 `VACUUM INTO`），各带命令与实测输出；其余本地探针的收敛入库列为 §11 第 23 项。
5. **引用纪律**（§15.2 尾注）：`file:line` 引用会随提交漂移（同一文档在 master 与分支上已有三处不一致），**以符号/命令为准**，新数字标注测量基线 commit。

## 影响

- §11 开工清单变化：第 3 项"迁移两件"→"迁移一件"；新增第 23 项（探针入库）与第 24 项（缓存目录属主/信任边界，需拍板）。
- 不采纳报告的 P0-2 措辞、P2-1/P2-2 结论、§6.1/§6.2 因果链、§七 的内存建议。
- 本决策**只改文档与证据探针，不改产品代码**；纯 `docs/` 改动按 `docs/decisions/2026-09-17-docs-only-ci-skip.md` 跳过全量 CI。
