-- 0029: models 增加缓存命中输入价(元/百万 token)。
-- DeepSeek 等上游对命中缓存的输入 token 按更低单价计费;该列为定价参考字段,
-- nil = 未配置缓存价(计费仍按 input_price_per_1m),>0 = 缓存命中输入 token 单价。
ALTER TABLE models ADD COLUMN cache_input_price_per_1m DOUBLE PRECISION;
