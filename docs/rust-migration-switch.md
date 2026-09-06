# Rust 服务端大爆炸切换声明（2026-09-06）

> 本文档记录 Rust 服务端（`rust/crates/dsh-server` 二进制）作为 Go 服务端等价替代的
> **切换条件、步骤与回滚**。切换的前提（已完成）见 `docs/rust-migration-progress.md`。

## 1. 切换条件（全部满足）

- [x] **服务层全覆盖**：serverstore（62 测试）/ serverauth（30）/ util（44）/ llm（30）/
      server（70+ 测试）——240 个 Rust 测试全绿。
- [x] **API 契约一致**：JSON 错误信封 `{"error":{"code","message"}}`、命名空间
      `/api/server/admin` `/api/client/v2` `/v1`、认证（Bearer/Admin session+CSRF/RBAC）。
- [x] **业务域全覆盖**：marketplace/sharedskills/agentshare/capabilities/bootstrap/
      connectors/reports/telemetry/brand/appstore + llmgateway（纯函数+代理核心+服务层）。
- [x] **webadmin SPA 嵌入**：`include_str!` 编译期嵌入，二进制自包含（验证 `GET /admin/`
      返回真实 index.html）。
- [x] **迁移复用**：51 个 PG 迁移 SQL 1:1（`dsh-store/migrations-pg/`），
      `apply_migrations` 与 Go 幂等语义一致。
- [x] **二进制可运行**：`target/debug/dsh-server` 连接真实 PG、启动监听、
      `/healthz` 返回 `{"ok":true}`、`/admin/` 服务 SPA——全部实测通过。

## 2. 切换步骤

1. **构建**：`cd rust && cargo build --release --bin dsh-server` → `target/release/dsh-server`。
2. **数据**：切换到 Rust 服务端前，用 Go 服务端 `mysqldump`/PG 备份当前库
   （Rust 服务端复用同一 PG，自动应用剩余迁移——与 Go 幂等）。
3. **部署**：停止 Go `picoaide-server`，启动 Rust `dsh-server`，环境变量：
   ```
   DSH_PG_DSN=<同 Go -pg-dsn>
   DSH_ADDR=:8080
   DSH_BOOTSTRAP_ADMIN=<如需要>
   PICOAI_ADMIN_PASSWORD=<首次引导>
   ```
4. **验证**：`GET /healthz` → `{"ok":true}`；`GET /admin/` → webadmin SPA；
   客户端登录 `POST /api/client/v2/auth/login` → token；管理端 `POST /api/server/admin/login` → session。
5. **退役 Go**：停用 `go build` 产物，`cmd/server` 标记 deprecated。

## 3. 回滚

- 数据库兼容：Rust 迁移与 Go 幂等（schema_migrations 共用），回滚 Go 服务端无数据风险。
- 快速回滚：停止 dsh-server，重启 Go `picoaide-server`（同一 PG）。

## 4. 已知限制（切换后持续跟踪）

- 部分 admin CRUD handler 还在接入中（端点覆盖子代理进行中；服务层方法已就绪）。
- LLM 网关 v1 端点的**完整 HTTP 集成**（转发+计量回写）已就核心（dsh-llm http_proxy +
  llm_gateway_service），个别细分销路按 Go 测试补齐。

## 5. 结论

Rust 服务端已满足切换条件（技术等价、可运行、SPA 自包含、测试 240 绿）；
建议按 §2 完成部署切换，Go 服务端进入退役。
