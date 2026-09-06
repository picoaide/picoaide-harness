-- 0045: 下架 GlitchTip 连接器(错误监控已是独立自动集成)。
-- 背景(2026-08-29):GlitchTip 有两个独立角色——
--   1) 错误监控(Sentry DSN):客户端登录后自动上报异常,经 error-reporting
--      插件直接调 GlitchTip,不经连接器(正常工作,保留)。
--   2) 连接器 MCP(token 模式):AI 查询 issue/堆栈,需用户手动填 API Token
--      并点击"连接"——企业内仅用于收集错误上报,无需 AI 查询,故下架。
-- enabled=0:连接器目录(bootstrap connectors[])不再下发,客户端连接器中心
--   不显示 GlitchTip;错误监控不受影响(独立于连接器目录)。
UPDATE connectors SET enabled = 0 WHERE id = 'glitchtip';
