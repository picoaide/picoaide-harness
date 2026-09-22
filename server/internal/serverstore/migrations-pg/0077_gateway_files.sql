-- 0077: LLM 网关 Files API 直通的文件归属台账（2026-09-22）。
--
-- 背景：网关新增 DeepSeek Files API 直通（internal/llmgateway/files.go）后，客户端
--   把图片先上传一次、后续请求只引用 `file_id`。上游按 **API key** 划分文件命名空间，
--   而本平台**全组织共用同一个上游 key** ⇒ 文件天然落在同一账号下。没有本地归属判定
--   就会变成"任一登录员工都能列出/删除全公司的文件"（审计员已探针复现），而且上游官方
--   客户端在配额不足时会删**最旧的 dsh- 文件**（不分上传者）—— 正常使用也会误删他人
--   仍在引用的图片。
--
-- 本表是**网关侧的归属台账**，不是上游状态的镜像：
--   * 上传成功（2xx 且响应含 `id`）后立刻写入 `(file_id, user_id, expires_at)`；
--   * `GET|DELETE /files/{file_id}` 先查归属：不是自己的按 **404** 处理（与"不存在"同形，
--     不泄露存在性）；是自己的在执行后删本行；
--   * `GET /files`（列表）只回自己的 `file_id`（上游返回的全量列表在网关侧过滤）；
--   * 上游删了/自然过期而本行还在 ⇒ 两个兜底：上游对 `/files/{id}` 返回 404 时顺手删行；
--     以及按 `expires_at` 的过期清理（不依赖上游回调）。
--
-- 为什么必须有 `expires_at`：官方上传时 `expires_after` 可选（1 小时~30 天；两个字段
--   都不给 = 永久）。没有它就无法判断"上游其实已经删了"，行会永久堆积；有它就能定期
--   清掉过期行（上游对过期文件同样返回 404，客户端行为不变）。
CREATE TABLE IF NOT EXISTS gateway_files (
    file_id    TEXT PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_gateway_files_user_created ON gateway_files (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gateway_files_expires ON gateway_files (expires_at) WHERE expires_at IS NOT NULL;
