-- 0044: 上游协议支持 both——同一 key 同时服务 chat(OpenAI)与 search(Anthropic)。
-- 背景(2026-08):DeepSeek 官方同一 API key 同时支持 OpenAI 兼容端点
--   (api.deepseek.com/v1/chat/completions)与 Anthropic 兼容端点
--   (api.deepseek.com/anthropic/v1/messages);此前 0043 要求 webadmin 为
--   搜索单独配一个 anthropic 协议上游(公用 key 配两边,运维负担)。
--   both 让一个 provider 同时匹配两条路由,零额外配置。
--
-- 语义:
--   gateway_providers.protocol = openai|anthropic|both(默认 openai)
--   both 的路由匹配:chat/embeddings 与 messages 都命中该 provider;
--   base_url 是 OpenAI 端点(不含 /anthropic),anthropic 端点自动推导:
--     base_url + /anthropic/v1 + /messages(DeepSeek 官方布局);
--   若管理员显式填了含 /anthropic/v1 的 base_url,推导尊重已填路径。
--
-- 存量行不自动升级(不是所有 openai 上游都支持 Anthropic 端点);
-- DeepSeek 官方上游在 webadmin 把 protocol 改为 both 即可(零额外 key)。

ALTER TABLE gateway_providers DROP CONSTRAINT gateway_providers_protocol_check;
ALTER TABLE gateway_providers ADD CONSTRAINT gateway_providers_protocol_check
    CHECK (protocol IN ('openai', 'anthropic', 'both'));
