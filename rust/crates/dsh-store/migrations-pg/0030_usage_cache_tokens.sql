-- 0030: usage 增加缓存命中输入 token 数(DeepSeek 缓存计费)。
-- prompt_cache_hit_tokens = 上游返回的缓存命中输入 token;未配置时按 0 计,
-- 命中部分按 models.cache_input_price_per_1m(0029)计费,未配置则回退输入价。
ALTER TABLE usage ADD COLUMN cache_prompt_tokens BIGINT NOT NULL DEFAULT 0;
