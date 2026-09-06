-- 0042: 连接器目录服务端化——连接器定义从客户端硬编码改为服务端下发。
-- 背景(2026-08):此前连接器(ConnectorDef:认证方式/字段/MCP 端点)硬编码在
--   客户端 connectors 包,新增/修改连接器必须重新打包发版;本迁移建立
--   connectors 表作为唯一目录源,webadmin 图形化管理,客户端经
--   GET /api/config/bootstrap 下发(connectors[]) 获取。
--
-- 字段:
--   connectors.id           稳定标识(如 moka/glitchtip),客户端按 id 匹配凭证
--   connectors.name         展示名(webadmin/客户端连接器中心)
--   connectors.description  展示描述
--   connectors.auth_mode    oauth|device|token|server-side
--   connectors.definition   JSON:认证配置 + token 字段 + MCP 服务器(与客户端
--                           ConnectorDef 对齐,服务端校验必填项)
--   connectors.enabled      下架开关(0=bootstrap 不下发,客户端隐藏)
--   connectors.updated_at   变更时间(审计对照)
--
-- 种子数据:迁入现有两个内置连接器(moka/glitchtip)的等价定义,
--   保证升级后行为不变;后续增删改全部经 webadmin。

CREATE TABLE IF NOT EXISTS connectors (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    auth_mode   TEXT NOT NULL CHECK (auth_mode IN ('oauth', 'device', 'token', 'server-side')),
    definition  TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 种子:moka(OAuth + streamable-http)+ glitchtip(token + stdio)+
-- sales-easy(销售易 NeoCRM,OAuth + streamable-http)。
-- 覆盖客户端此前全部硬编码连接器(0042 核查 2026-08-28:sales-easy 曾随
-- dedupeById 注册但未入表,现补齐)。
-- glitchtip 的 DEFAULT 字段值由服务端设置页(web.glitchtip_base_url/
-- web.glitchtip_organization)在 bootstrap 时合成注入,数据库存定义不含
-- 部署地址(源码/DB 均不含自部署主机名,见客户端旧 glitchtip.ts 约束)。
INSERT INTO connectors (id, name, description, auth_mode, definition) VALUES
('moka', 'Moka HR 智能体',
 '招聘和人事一体的 AI 同事,把查询与执行收进一个对话。人才推荐、招聘动态、考勤绩效、审批待办,一句话问清;智能寻聘、面试分析与面试官评估,一句话发起。',
 'oauth',
 '{"auth":{"discoveryUrl":"https://mcp.mokahr.com/mcp","clientId":"","authorizeUrl":"","tokenUrl":"","redirectUri":"http://127.0.0.1/callback","pkce":true,"publicClient":true,"scopes":"offline_access"},"mcp":[{"serverName":"moka","transport":"streamable-http","url":"https://mcp.mokahr.com/mcp"}]}'),
('glitchtip', 'GlitchTip',
 'GlitchTip(Sentry 兼容错误追踪):查询 issue 与最新事件堆栈,用于错误排查与监控告警',
 'token',
 '{"tokenFields":[{"key":"GLITCHTIP_BASE_URL","label":"服务地址(必填,如自部署地址或 app.glitchtip.com)","type":"text","required":true},{"key":"GLITCHTIP_TOKEN","label":"API Token(Auth Tokens 页创建,需 org:read / project:read / event:read)","type":"password","required":true},{"key":"GLITCHTIP_ORGANIZATION","label":"组织 slug(如 picoaide)","type":"text","required":true}],"examples":["查询当前未解决的错误 issue","查看最近一次异常的堆栈详情","列出错误追踪中的高优先级问题"],"mcp":[{"serverName":"glitchtip","transport":"stdio","command":"npx","args":["-y","glitchtip-mcp"],"env":{}}]}'),
('sales-easy', '销售易',
 '销售易 NeoCRM 官方 MCP:查询客户、线索、商机、联系人,执行 XOQL 查询与元数据操作',
 'oauth',
 '{"auth":{"authorizeUrl":"https://mcp.xiaoshouyi.com/oauth/authorize","tokenUrl":"https://mcp.xiaoshouyi.com/oauth/token","registrationEndpoint":"https://mcp.xiaoshouyi.com/oauth/register","clientId":"","redirectUri":"","scopes":"offline_access","pkce":true,"publicClient":true},"examples":["查询最近赢单的 10 个商机","统计各行业客户数量","帮我找一下联系人张三"],"mcp":[{"serverName":"neo-crm","transport":"streamable-http","url":"https://mcp.xiaoshouyi.com/mcp"}]}')
ON CONFLICT (id) DO NOTHING;
