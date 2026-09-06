-- 0043: 上游协议标识——Anthropic 兼容代理路由。
-- 背景(2026-08):web_search 工具此前直连 DeepSeek 官方 Anthropic 兼容端点
--   (https://api.deepseek.com/anthropic/v1/messages),官方 key 随客户端下发,
--   抓包即可泄露并无限使用。本次让搜索也走服务端网关:网关新增 Anthropic
--   兼容 /v1/messages 路由,provider 表以 protocol 区分上游方言——
--   openai(默认,现有行为不变)/anthropic(/v1/messages 专用)。
--
-- 字段:
--   gateway_providers.protocol  openai|anthropic,默认 openai(存量行不变)
--   models 表不新增列:模型路由按 (models.name, provider.protocol) 匹配,
--   同一模型名可同时挂 openai 与 anthropic 两个 provider(两协议两端点)。

ALTER TABLE gateway_providers ADD COLUMN protocol TEXT NOT NULL DEFAULT 'openai'
    CHECK (protocol IN ('openai', 'anthropic'));
