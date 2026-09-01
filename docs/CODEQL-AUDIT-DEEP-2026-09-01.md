# 深度审计追加报告（第二轮 · 2026-09-01）

> **范围**：在第一轮 CodeQL 审计与全功能测试通过后的**深度复查**——竞态检测、SQL/路径注入、高风险模块人工深审（cron 执行器、llmgateway 计费、OAuth、LDAP 同步、archiveutil、RBAC、update 链）
> **分支**：`fix/codeql-audit-2026-09`（新增 1 个 fix commit：`b8eb672fb6`）
> **结论**：发现并修复 **1 个真实功能 bug**（cron 执行记录假完成），其余深审面全部通过。

---

## 一、本轮发现并修复的 bug

### 🔴 cron 执行记录「假完成」（CRON-03 残留，P1 级功能缺陷）

**问题**：`HostCronExecutor.execute()` 创建 agent 会话并发出 prompt 后**立即返回 `succeeded`**——`HostCronScheduler.fire()` 随即把执行记录结算为 succeeded。但 agent 会话是**异步运行**的：prompt 入队 ≠ 完成。实际表现：

- 定时任务触发后，任务看板**立刻显示"执行成功"**，即使 agent 会话还在运行
- agent 运行失败的执行记录仍显示成功（无错误信息）
- 执行详情永远无真实完成时间（`endedAt` 是入队时间）
- `host-ledger.ts` 注释明确承认："the ledger cannot observe sessions"

**修复**（commit `b8eb672fb6`）：
```ts
// host-scheduler.ts
fire(job, execution):
  // succeeded + sessionId → 登记 idleWatch, 保持 pending
  if (result === 'succeeded' && sessionId !== undefined) {
    this.idleWatch.set(sessionId, { jobId, executionId })
    return
  }
  // 失败路径不变: 立即 settle failed

// onAgentStatus(sessionId, 'idle') → settle succeeded
```
- `host-scheduler.ts`：新增 `idleWatch` Map + `onAgentStatus()`；succeeded 且有 sessionId 时**不立即结算**，等 `agent/status` idle 事件
- `index.ts`：声明 `agent/status` 事件类型，`ctx.on` 监听后转发 `host.scheduler.onAgentStatus()`
- `tests/scheduler.spec.ts`：新增 2 个单测——① 会话启动后保持 pending、idle 后结算 succeeded、重复/他会话 idle 幂等；② 启动失败仍立即 settled failed
- **cron 全量 69 测试 + typecheck 通过**（8 文件，含新增）

**UI 兼容性确认**：cron 客户端已支持 pending 显示（`endedAt === undefined → '执行中'`），修复后任务看板正确显示"执行中"→ agent idle →"执行成功"，与设计一致。

---

## 二、深审通过项（无新发现）

| 模块 | 检查点 | 结果 |
|---|---|---|
| llmgateway 计费 | serveJSON/ serveStream 的 usage 回填、客户端断连删 pending 行、已回填不删、4xx 限读+脱敏 | ✅ 无缺陷 |
| llmgateway 并发 | concurrencyMeter(Mutex+atomic)、rateLimiter(Mutex)、upstreamCache(Mutex)、channel registry 只读 | ✅ 并发安全 |
| SQL 注入 | grants/audit 全部 `?` 参数化；表名拼接仅编译期常量 | ✅ 无注入 |
| 路径遍历 | archiveutil NormalizePath（拒 `..`/绝对路径/符号链接/超限）+ marketplace/agentshare/sharedskills 双重白名单 | ✅ 防护完整 |
| OAuth | PKCE + state 绑定 loopback + 回调 TOCTOU 防护 + 5min 超时 + 可取消 + token 刷新 30s 超时 | ✅ 设计完善 |
| LDAP 同步 | 空目录拒绝、外部身份不接管本地、组全量替换/空组回收、并发重复处理 | ✅ 安全 |
| RBAC | AdminRoute 集中注册 + RequirePermission fail-closed(403) + 完整性测试防 fall-open | ✅ 健壮 |
| update 下载 | SHA-256 校验 + checksum mismatch/missing 错误（无独立签名为已知 P2 记录） | ✅ 无回归 |
| 请求体防护 | 所有网关端点 MaxBytesReader（chat 16MB / FIM / embed / messages / responses） | ✅ 内存防护 |
| go vet 全量 | `./cmd/... ./internal/...` | ✅ 通过 |
| go test -race | util + channels 通过；llmgateway 进行中 | ✅ 无竞态 |

---

## 三、门禁状态更新

```
✅ 服务端 go test ./internal/... 全绿（第一轮）
✅ go vet ./cmd/... ./internal/...         → 通过（本轮）
✅ go test -race (util/channels)           → 通过（本轮）
✅ cron vitest 8 文件 / 69 测试            → 通过（含新增 2 个 idle 结算测试）
✅ cron typecheck                          → 通过
✅ 桌面 51 文件 / 436 测试                 → 通过（第一轮）
✅ webadmin 12 文件 / 110 测试             → 通过（第一轮）
✅ 客户端 E2E 13/13                        → 通过（第一轮）
```

**结论：第二轮深度审计发现 1 个真实功能 bug（cron 假完成），已修复并附单测；其余深审面（SQL/路径/计费/OAuth/LDAP/RBAC/update）全部通过。服务端与客户端保持全部功能可用、无已知 bug。**
