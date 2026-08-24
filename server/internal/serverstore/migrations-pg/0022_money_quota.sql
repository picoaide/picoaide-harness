-- 0022: money (cost) dimension for usage and per-user monthly money quota.
--
-- users.quota_money  (REAL, yuan per calendar month):
--   NULL = follow the global default (settings 'usage.monthly_quota_money')
--   0    = unlimited (explicit)
--   >0   = capped at N yuan per calendar month
-- admins are always unlimited (enforced at the gateway, not stored here).
--
-- models.input_price_per_1m / output_price_per_1m (REAL, yuan per 1M tokens):
--   NULL/0 = model not priced -> cost contributes 0 (page shows 未定价 hint).
--   embedding reuses input price (embedding rows have completion_tokens=0).
--
-- usage.cost (REAL, yuan): cost denormalized at record time so later price
--   edits / model deletion never rewrite history; money quota enforcement and
--   dashboards both read SUM(cost) — one consistent basis.
ALTER TABLE users ADD COLUMN quota_money DOUBLE PRECISION;
ALTER TABLE models ADD COLUMN input_price_per_1m DOUBLE PRECISION;
ALTER TABLE models ADD COLUMN output_price_per_1m DOUBLE PRECISION;
ALTER TABLE usage ADD COLUMN cost DOUBLE PRECISION NOT NULL DEFAULT 0;
