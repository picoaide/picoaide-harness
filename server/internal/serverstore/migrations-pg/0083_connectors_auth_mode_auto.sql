-- 0083: 连接器认证模式新增 `auto`（"该鉴权鉴权"，2026-10-08）。
--
-- 为什么需要它：连接器目录要接受**标准 MCP 配置**（各家官方文档 / Claude Desktop /
-- Cursor 给的那一份 `{"mcpServers": {"name": {"type": "...", "url": "..."}}}`）。
-- 那份配置里没有任何认证字段 —— 它本来就靠端点自述：探测 2xx 即公开端点、401 带
-- `WWW-Authenticate: resource_metadata=…` 就走 MCP 授权规范（RFC 9728 → RFC 8414 →
-- 动态客户端注册 → PKCE → 回环回调）。归一化（`connector_mcp_servers.go`）对这类
-- 定义默认填 `auto`，客户端在连接那一刻再决定公开 / OAuth / 凭据表单。
--
-- 0042 建表时的行内 CHECK 只认四种模式（oauth|device|token|server-side），
-- 于是"服务端校验通过、归一化也通过，落库被约束拒绝"——判据形态是
-- `ERROR: new row for relation "connectors" violates check constraint
-- "connectors_auth_mode_check"`。约束名是 PostgreSQL 为行内 CHECK 生成的既有名字，
-- 这里按名替换（`DROP … IF EXISTS` + `ADD …` 幂等，存量行全部是旧四值 ⇒ 校验通过）。
--
-- 回滚口径（与 0082 同款，两步，缺一不可）：
--   ① 删掉版本行（DDL 与约束都留着；旧二进制不写 `auto`，放宽后的约束对它无影响）：
--        DELETE FROM schema_migrations WHERE version = 83;
--   ② 换回旧镜像（`SERVER_IMAGE` + `docker compose up -d server`）。
-- 只换镜像不删版本行会**起不来**：`ApplyMigrations` 见到 `schema_migrations` 里有
-- 本二进制没有的版本即抛 `SchemaMismatchError`，`cmd/server` 直接 `log.Fatalf`。
-- 确认不再需要 `auto` 时，再把约束收回旧四值即可回到 0042 的形状
-- （前提：库里已无 `auth_mode='auto'` 的行，否则放回约束会失败）。
ALTER TABLE connectors DROP CONSTRAINT IF EXISTS connectors_auth_mode_check;
ALTER TABLE connectors ADD CONSTRAINT connectors_auth_mode_check
  CHECK (auth_mode IN ('oauth', 'device', 'token', 'server-side', 'auto'));
