/** Mock gateway used by the client E2E tool (fixed port 34567). */
import { createServer } from 'node:http'
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:34567')
  process.stderr.write(`[gw] ${req.method} ${url.pathname}\n`)
  res.setHeader('Content-Type', 'application/json')
  if (url.pathname === '/api/auth/login') {
    res.end(JSON.stringify({ token: 'mock-token-123', user: { username: 'admin' } }))
    return
  }
  // 2026-09 客户端登录页方法选择器: 返回启用的认证方式(local 恒启用)。
  if (url.pathname === '/api/admin/auth/methods') {
    res.end(JSON.stringify({ methods: [{ name: 'local', configured: true }] }))
    return
  }
  if (url.pathname === '/api/auth/me' || url.pathname === '/api/auth/session' || url.pathname === '/api/auth/usage') {
    res.end(JSON.stringify({
      username: 'admin', id: 1, department: 'dev', token: 'mock-token-123',
      // Usage envelope expected by the account card (`/api/pico/account/usage`
      // passes it through): data.remaining_money/monthly_cost/today_cost must
      // be numbers or formatMoney crashes and the sidebar slot fails.
      data: {
        quota_tokens: null, quota_money: null,
        remaining_tokens: null, remaining_money: 100,
        today_cost: 0.5, monthly_cost: 12.3, total_cost: 25.6,
      },
    }))
    return
  }
  if (url.pathname === '/api/config/bootstrap') {
    res.end(JSON.stringify({
      models: [
        { id: 'deepseek-v4', name: 'DeepSeek V4', provider: 'deepseek' },
        { id: 'pico-v4-pro', name: 'Pico AI V4 Pro', provider: 'picoai' },
      ],
      user: { username: 'admin', id: 1, department: 'dev' },
      usage: { balance: 100, quota: 1000 },
      serverTime: Date.now(),
      // 错误监控 DSN(联调 2026-08-27):GlitchTip 项目 picoaide-web。
      // @sentry/node 要求 DSN 格式 https://<public_key>@host/<project_id>(无尾斜杠),
      // SDK 内部自动拼 /api/<id>/envelope/
      web: { allow_private: false, search_endpoint: '', error_reporting_dsn: 'https://cc825c63d6494f9f8bb9cff238c1bdae@glitchtip.kq0575.cn/1' },
    }))
    return
  }
  if (url.pathname.includes('skill')) {
    res.end(JSON.stringify([
      { id: 'skill-1', name: '代码审计', description: 'CodeQL 审计', installed: true, version: '1.0.0' },
      { id: 'skill-2', name: '钉钉集成', description: 'DingTalk 办公', installed: false, version: '0.1.0' },
    ]))
    return
  }
  if (url.pathname === '/api/models' || url.pathname === '/api/config/models') {
    res.end(JSON.stringify({ models: [
      { id: 'deepseek-v4', name: 'DeepSeek V4', provider: 'deepseek' },
      { id: 'pico-v4-pro', name: 'Pico AI V4 Pro', provider: 'picoai' },
    ] }))
    return
  }
  if (url.pathname === '/api/workspaces' || url.pathname === '/api/workspace' || url.pathname === '/api/pico/workspaces') {
    res.end(JSON.stringify({ workspaces: [
      { id: 'ws-1', name: '测试工作区', path: '/tmp/ws1', cwd: '/tmp/ws1' },
      { id: 'ws-2', name: '生产工作区', path: '/tmp/ws2', cwd: '/tmp/ws2' },
    ], current: 'ws-1' }))
    return
  }
  if (url.pathname.startsWith('/api/sessions') || url.pathname === '/api/conversations') {
    res.end(JSON.stringify({ sessions: [], session: null, conversations: [] }))
    return
  }
  if (url.pathname === '/api/cron' || url.pathname.startsWith('/api/cron/') || url.pathname === '/api/jobs' || url.pathname.startsWith('/api/jobs/')) {
    res.end(JSON.stringify({ jobs: [], items: [] }))
    return
  }
  if (url.pathname === '/api/agent-presets' || url.pathname.startsWith('/api/agent-presets/')) {
    res.end(JSON.stringify({
      presets: [
        { name: 'shared-demo', display_name: '共享演示', description: '演示预设', version: '1.0.0', author: 'admin', status: 'approved', reason: '', created_at: '2026-08-01T10:00:00+08:00' },
      ],
      installed: [],
      local: {},
    }))
    return
  }
  if (url.pathname === '/api/shared-skills' || url.pathname.startsWith('/api/shared-skills/')) {
    res.end(JSON.stringify({
      skills: [
        { name: 'codeql-demo', display_name: '代码审计演示', version: '1.0.0', description: '演示技能', author: 'admin', status: 'approved', reason: '', created_at: '2026-08-01T10:00:00+08:00' },
      ],
      installed: [],
      local: [],
    }))
    return
  }
  if (url.pathname.startsWith('/api/admin') || url.pathname.startsWith('/api/pico')) {
    res.end(JSON.stringify({ ok: true, items: [] }))
    return
  }
  if (url.pathname.startsWith('/api/')) {
    res.end(JSON.stringify({ ok: true }))
    return
  }
  res.statusCode = 404
  res.end(JSON.stringify({ error: 'not found', path: url.pathname }))
})
server.listen(34567, '127.0.0.1', () => console.log('e2e mock gateway on 34567'))
