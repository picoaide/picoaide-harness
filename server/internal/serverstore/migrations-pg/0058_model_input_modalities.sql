-- 0058: 模型输入模态(图片支持配置)。
-- 需求: 客户端模型清单需要「是否支持图片输入」的权威配置, bootstrap 统一下发
-- (客户端 llm-deepseek 目录 inputModalities; 缺失时默认仅 text, 视觉模型会被
-- 误判为不支持图片)。
--
-- models 新增列:
--   * input_modalities: JSON 文本数组, 取值 'text'/'image'(如 '["text"]' /
--     '["text","image"]'); 默认仅 text(与客户端 schema 缺省一致)。
--     渠道同步模型不覆盖该列(管理员配置在重同步时保留, 见 SyncProviderModel)。
ALTER TABLE models ADD COLUMN input_modalities TEXT NOT NULL DEFAULT '["text"]';
