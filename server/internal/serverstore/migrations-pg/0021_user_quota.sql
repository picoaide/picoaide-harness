-- per-user monthly traffic quota in tokens:
--   NULL = follow the global default (settings 'usage.monthly_quota')
--   0    = unlimited (explicit)
--   >0   = capped at N tokens per calendar month
-- admins are always unlimited (enforced at the gateway, not stored here).
ALTER TABLE users ADD COLUMN quota_tokens BIGINT;
