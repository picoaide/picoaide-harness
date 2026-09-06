-- 0048: 审计日志防篡改哈希链(合规审计建议, 设计 v3b)。
-- 每条日志记录 prev_hash(前一条的 hash)与自身 hash(sha256(prev|username|
-- action|detail|created_at)), 形成链; 篡改中间条目会破坏后续所有校验。
-- 旧行迁移后 hash=''(仅首条 chain 起点), 新写入自动带链。
ALTER TABLE audit_logs ADD COLUMN prev_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE audit_logs ADD COLUMN hash TEXT NOT NULL DEFAULT '';
