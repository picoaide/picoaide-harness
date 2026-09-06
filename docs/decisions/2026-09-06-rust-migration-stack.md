# Rust 迁移技术栈选型（2026-09-06）

> 前置盘点：本决策基于对仓库全栈的实测盘点（代码量、依赖耦合、生态调研）。
> 决策前提（用户明确）：**放弃上游 pin**（deepseek-harness 子模块退出跟随），在本仓库内 Rust 重写 DSH 全部 55 个上游包、产品插件包（packages/ 下 9 个包）、Go 服务端（server/）与 Electron 桌面壳；**大爆炸一次性切换**（Rust 等价实现全部就绪前，现有 TS/Go 栈保留运行）。

---

## 1. 目标

把 DSH 的**底层全部切换为 Rust**：
1. 上游核心 55 包（agent-loop / llm / mcp / session / sandbox / fs / terminal / lsp / web / skill / goal / workflow / subagent / hooks / context / compaction / schedule / jobs / credentials / storage / util / api / client / core 等）→ Rust crates
2. 产品插件包 9 个（desktop / enterprise / better-sidebar / connectors / cron / browser / branding / account-card / community-fabric）→ Rust
3. Go 服务端（server/ 24k 行 + webadmin 13k 行 TSX）→ Rust（axum + Leptos wasm）
4. Electron 桌面壳 → Tauri

**约束**：webadmin 前端 SPA 保持 React 不动（用户明确不换前端）；API 契约（JSON 信封 / `/api/server/admin/*` / `/api/client/v2/*`）保持不变，前端零改动可感知。

## 2. 关键事实（实测盘点）

### 2.1 代码量

| 层 | 位置 | 行数 |
|---|---|---|
| 上游 TS 包 | `deepseek-harness/packages/`（55 包） | 234,145（含测试 1058 文件） |
| 上游 apps | `deepseek-harness/apps/`（cli+web） | 34,786 |
| 产品插件 | `packages/`（9 包） | 93,275 |
| Go 服务端 | `server/`（不含测试） | 24,339 |
| 服务端测试 | `server/**/*_test.go` | 21,794 |
| webadmin | `server/webadmin/src` | 13,173 |

### 2.2 上游包规模排名（Top 15）

client(84k) / experimental(59k) / core(42k) / api(36k) / subagent(33k) / llm(31k) / session(24k) / extensions(21k) / test-support(15k) / typert(15k) / session-query(14k) / fs(13.5k) / context(12k) / shell(12k) / compaction(8k)。

### 2.3 外部系统耦合（决定 crate 选型）

| Go / Node 依赖 | 职责 | 实测使用强度 |
|---|---|---|
| node:path / node:os / node:fs | 文件系统路径 | 352 + 230 + 204 处引用 |
| node:child_process / node:stream | 子进程/流 | 50 + 32 |
| node:http / node:net / websocket | 网络 | 52 + 15 |
| node:crypto / node:worker_threads | 加密/线程 | 73 + 21 |
| go-ldap (serverauth) | LDAP 同步 | 120 调用点 |
| go-oidc (serverauth) | OIDC | 28 调用点 |
| pgx (serverstore) | PostgreSQL | 6682 行 DAO 裸 SQL |
| go-git | 商城 git 拉取 | agentshare / marketplace |
| go-yaml | 配置解析 | util |

## 3. 技术栈决策

### D1. 服务端：axum + sqlx + tokio（替代 gin + pgx）

- **axum 0.8**：tower 中间件组合，与 gin 的 middleware 语义对齐（超时/限流/Recovery 都有等价）。
- **sqlx 0.8**：编译期 SQL 检查（DATABASE_URL），替代裸 SQL DAO；`sqlx::migrate!` 直接执行现有 51 个 PG 迁移文件（SQL 不变，无数据迁移）。
- **tokio 1.x**：异步运行时；**rayon**（CPU 密集：压缩/哈希）。
- **argon2 crate**：替代 x/crypto/argon2；**aes-gcm crate**：替代 AEAD；**totp-rs**：TOTP。
- **ldap3 crate**：替代 go-ldap/v3（bind/search 语义接近；同步组/子树继承需重写）。
- **openidconnect crate**：替代 go-oidc/v3（discovery/JWKS/验证 token）。
- **serde + serde_json**：JSON 信封（`{"error":{"code","message"}}`）结构等价。
- **git2 / gix**：替代 go-git（商城 skill/sheet 拉取）。

### D2. 前端 webadmin：React SPA **保持不动**

- 用户明确不换前端；仅需 Rust 侧以 axum `serve_dir`（或 `include_bytes!` 静态嵌入）挂载 `webadmin/dist`。
- 验证点：`GET /admin/*` 返回 SPA（非 JSON），`/api/server/admin/*` 与 `/api/client/v2/brand` 契约（app + error envelope）双端一致。

### D3. 桌面壳：Tauri 2（替代 Electron 43）

- 窗口/tray/自动更新/签名打包（nsis/dmg/appimage）Tauri 均覆盖。
- Node 运行时以 sidecar/嵌入式运行时保留 —— **上游 234k 行 TS 的 agent-loop 等核心在 ASAR 内运行时不可行**，但 Tauri 壳 + node 运行时作为引擎混合可行（见 §5）。
- CDP/asar 文件系统/Electron API 依赖面（`packages/host/desktop/src` 约 40–60% 是 Electron 面）需逐项移植；`asar-file-system.ts` 在 Tauri 下换为资源目录方案。

### D4. 核心 Agent 运行时：自研 crate（上游无等价 Rust 平台）

- **不依赖第三方 agent 框架**：DSH 的 agent-loop（目标管理/子代理/计划/审批门控/沙箱）是平台核心资产，重写时以 crate 形态自研（`dsh-runtime` / `dsh-agent-loop` / `dsh-llm` / `dsh-mcp` / `dsh-session` / `dsh-sandbox`）。
- **LLM 网关**：手写 `dsh-llm`（OpenAI / Anthropic / Responses / SSE 流式 / 工具调用 / 缓存计费），参考 [async-openai](https://lib.rs/crates/async-openai) 但自实现协议面。
- **MCP**：使用官方 [modelcontextprotocol/rust-sdk](https://github.com/modelcontextprotocol/rust-sdk)（官方 SDK，rmcp 已稳定）或 [rmcp-rust-sdk](https://github.com/UserGeneratedLLC/rmcp-rust-sdk) 作为客户端/服务器基础。
- **沙箱**：Linux 用 **landlock**（crate：landlock / landlock-sys）；macOS 用 sandbox profile；Windows 用 AppContainer（后续）。
- **LSP**：lsp-types + tower-lsp（编译器级服务：typert/compaction 重写为 Rust 时依赖）。
- **前端 web（上游 apps/web）**：Leptos（若需要）——优先保持 React/Vite 不动以降低范围。

### D5. Workspace 拓扑（cargo workspace）

```
rust/
├── Cargo.toml            # 根 workspace
├── crates/
│   ├── dsh-core/         # 事件总线/上下文/生命周期（替换 core）
│   ├── dsh-runtime/      # 运行时引导（替换 boot/host）
│   ├── dsh-agent-loop/   # agent-loop（替换 subagent/plan/goal）
│   ├── dsh-llm/          # LLM 网关协议（替换 llm）
│   ├── dsh-mcp/          # MCP 客户端/服务器（替换 mcp）
│   ├── dsh-session/      # 会话状态（替换 session/session-query）
│   ├── dsh-sandbox/      # 沙箱（替换 sandbox）
│   ├── dsh-fs/           # 文件系统抽象（替换 fs/storage）
│   ├── dsh-terminal/     # 终端/子进程（替换 terminal/subprocess/shell）
│   ├── dsh-lsp/          # LSP（替换 lsp）
│   ├── dsh-skill/        # 技能（替换 skill）
│   ├── dsh-web/          # Web 服务（替换 web）
│   ├── dsh-util/         # 工具（替换 util）
│   └── dsh-server/       # 服务端（替换 server/: axum+sqlx+58 迁移）
└── apps/
    ├── dsh-cli/          # CLI（替换 apps/cli）
    └── dsh-desktop/      # Tauri 桌面壳（替换 packages/host/desktop）
```

## 4. 行为等价验证协议

1. **单元级**：每 crate 对照上游同模块测试（1058 个测试文件），以 Rust 测试重写行为断言语义（`#[test]` / `tokio::test`）；服务端对照 80 个 `_test.go`。
2. **集成级**：`integration-tests/`（dex/openldap/electron-shots）+ `server` 的 JWT/LDAP/OIDC 集成测试复跑。
3. **E2E 级**：DSH E2E（`test:e2e`）+ `e2e:client`（桌面）在 Rust 实现上复跑 13 断言。
4. **契约级**：API 快照比对（Go 与 Rust 服务端对同一请求返回逐字段 diff；webadmin SPA 端不改）。
5. **发布**：每 crate 绿色后可 commit（`git commit -m "feat(rust): ..."`），大爆炸切换前全部 crate 绿 + 集成测试绿。

## 5. 里程碑与风险

| 里程碑 | 内容 | 预计 |
|---|---|---|
| M1 | 技术栈文档（本文件） | ✅ 完成 |
| M2 | cargo workspace 拓扑 + CI（rust-toolchain/cargo test）接入 | 1-2 周 |
| M3 | dsh-core/llm/mcp/session/sandbox 首批 crate（行为等价） | 3-6 月 |
| M4 | 服务端 axum+sqlx（登录/LDAP/OIDC/全部 58 迁移 + webadmin 挂载） | 3-5 月 |
| M5 | Tauri 壳（窗口/tray/CDP/asar 迁移） | 2-3 月 |
| M6 | 上游 55 包全部覆盖 + 大爆炸切换（移除子模块 + TS 栈） | 3-6 月 |
| 总 | 单人全量 | **12-18 月（乐观）** |

**风险与缓解**：
- 上游 234k 行 TS 与 1058 测试的等价重写：以测试为行为契约，先重写小包（util/storage/feedback）再大包（client/experimental）。
- 丧失上游同步：fork 官方后**不**跟随 pin；官方修复需人工移植（价值高时）。
- 插件生态（Cordis 市场）归零：Rust 化后插件市场需重建（HTTP 插件还是动态库待定）。
- webadmin 前端技术债（Tailwind/Radix）保持现状，不因迁移而新增。

## 6. 决策记录

- 2026-09-06 由用户决策：放弃 pin + 本仓库内重写 + 大爆炸一次性切换 + 技术栈由调研后定。
- 本文件记录选型：axum / sqlx / tokio / Tauri 2 / 自研 dsh-* crates / Leptos（可选）/ 官方 MCP Rust SDK / landlock。
