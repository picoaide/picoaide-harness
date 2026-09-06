# Rust 迁移进度（PicoAide Harness 服务端）

> 目标：把 Go 服务端（`server/`）的 API 层重构为 Rust（axum + sqlx），
> 保持 webadmin React SPA 前端不动、API 契约不变（JSON 信封 /api/server/admin/* /api/client/v2/*），
> 大爆炸切换：等价实现全部就绪后一次性替换 Go。
> 上游 234k 行 TS 核心（deepseek-harness 子模块）保留不动。

## 技术栈

- Rust 1.98.1（本机工具链：`/tmp/rust-toolchain/sysroot/bin`，`PATH` 需含它；`RUSTUP_HOME=/tmp/rustup CARGO_HOME=/tmp/cargo`）
- axum 0.8 / sqlx 0.8（postgres + migrate + chrono）/ tokio 1
- argon2 / aes-gcm / sha2 / hmac / hex / base64 / rand / thiserror / anyhow / serde / serde_json / chrono / uuid

## Workspace 布局（rust/）

```
rust/
├── Cargo.toml          # workspace（4 crates，resolver=2，edition=2024）
├── crates/
│   ├── dsh-util/       # Go internal/util 等价：crypto(AES-GCM)/password(argon2id)/semver
│   ├── dsh-store/      # Go internal/serverstore 等价：迁移器/用户/部门/组/有效组/
│   │                   #   tokens/settings/audit/grants/connectors/gateway/apps/skills/…
│   │                   #   + testutil(临时 PG 库测试基座，migrations-pg/ 拷贝)
│   ├── dsh-auth/       # Go internal/serverauth 等价：local/token/rbac/config/
│   │                   #   admin_session(CSRF)/ratelimit/mfa/bootstrap_admin/…
│   └── dsh-server/     # Go cmd/server + router 等价：JSON 错误信封/命名空间常量
└── target/
```

## 测试基础

- PG 测试库：本机 `picoaide-test-pg` 容器（127.0.0.1:5432，postgres/postgres），
  默认 DSN `postgres://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable`
- `dsh-store::testutil::new_test_db()`：每次建独立临时库 `picoaide_test_<rand>` + 应用 51 个迁移 + 建分区（等价 Go `NewTestDB`）
- 迁移文件：`rust/crates/dsh-store/migrations-pg/`（编译期拷贝自 `server/internal/serverstore/migrations-pg/`）

## 进度表

| 里程碑 | 状态 |
|---|---|
| M1 盘点（19 包/549 测试/24k Go 行） | ✅ 2026-09-06 |
| M2 workspace 拓扑 | ✅ |
| util（crypto/password/semver） | ✅ 12 测试 |
| store 迁移器+测试基座 | ✅ 2 测试 |
| store 用户/部门/组/有效组 | ✅ 5 测试 |
| store tokens/settings/audit | ✅ 4 测试 |
| store grants | ✅ 1 测试 |
| store connectors | ✅ 4 测试（子代理） |
| store gateway / apps / skills / usage / budget / 小域集市 | 🔄 子代理并行中 |
| auth local/token/rbac/config | ✅ 8 测试 |
| auth admin_session/ratelimit/mfa/bootstrap_admin | ✅ 6 测试 |
| auth LDAP/OIDC | 🔄 子代理中 |
| server 错误信封+命名空间 | ✅ 2 测试 |
| llmgateway / marketplace / sharedskills / capabilities / 其他业务域 | 待做 |
| webadmin 静态挂载 + cmd/server 入口 | 待做 |
| 大爆炸切换 | 待做 |

## 测试命令

```bash
export PATH=/tmp/rust-toolchain/sysroot/bin:$PATH RUSTUP_HOME=/tmp/rustup CARGO_HOME=/tmp/cargo
cd rust && cargo test --workspace   # 全量（需 PG 已起）
```

## 关键踩坑（已解决）

- PG 类型映射：`BIGSERIAL→i64`、`INTEGER→i32`、`SMALLINT→i16`、`DOUBLE PRECISION→f64`、`TIMESTAMPTZ→chrono::DateTime<Utc>`；`user_groups.user_id` 是 INTEGER 但 `users.id` 是 BIGSERIAL（绑定需 as i32）
- sqlx 多语句迁移用 `sqlx::raw_sql`（`query()` 是 prepared statement 限制）
- `count(*)` 返回 INT8，`schema_migrations.version` 是 INT4
- aes-gcm 0.10 无 Aes192Gcm 别名，用 `AesGcm<Aes192, U12>` 泛型
- `map_db_error` 兜底已从 NotFound 改为 `Database(String)`（可诊断）
- 迁移目录用 `CARGO_MANIFEST_DIR` 定位（cargo test 从任意 cwd 运行）
