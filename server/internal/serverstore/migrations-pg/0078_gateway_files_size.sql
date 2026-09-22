-- 0078: 网关文件台账的**容量与清理**支撑（2026-09-22）。
--
-- 背景（需求）：上游 Files 配额是**每 API key**（全组织共享 25 GiB / 10000 个文件），
--   而本平台全组织共用一把上游 key ⇒ 单个员工理论上能占满公司共享配额。管理端需要
--   一个"按员工看占用量、能搜索能排序能清理"的工具，服务端也需要一条自动回收路径。
--
-- 本次新增：
--   1. `size_bytes` —— 上传响应里的文件字节数（OpenAI 形状 `bytes`、Anthropic 形状
--      `size_bytes`）。只用于**容量统计与排序**，不参与归属判定；取不到时记 0
--      （老行同 0：升级前的上传没有这份数据，管理端按"未知"展示 0）。
--   2. `idx_gateway_files_user_expires` —— 管理端"按员工 + 状态（有效/过期）"过滤与
--      按过期时间排序走这条索引；0077 已有的 `(user_id, created_at DESC)` 只够按
--      上传时间翻页。
--   3. `idx_gateway_files_expires_created` —— 自动回收扫描（`expires_at <= now()`
--      按过期时间升序取批量）走它；0077 的 `idx_gateway_files_expires` 是部分索引
--      （`WHERE expires_at IS NOT NULL`），两者互补，保留不动。
ALTER TABLE gateway_files ADD COLUMN IF NOT EXISTS size_bytes BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_gateway_files_user_expires
    ON gateway_files (user_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_gateway_files_expires_created
    ON gateway_files (expires_at, created_at);
