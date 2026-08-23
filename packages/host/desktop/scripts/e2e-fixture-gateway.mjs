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
  if (url.pathname === '/api/auth/me' || url.pathname === '/api/auth/session' || url.pathname === '/api/auth/usage') {
    res.end(JSON.stringify({ username: 'admin', id: 1, department: 'dev', token: 'mock-token-123' }))
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
  if (url.pathname === '/api/tasks' || url.pathname.startsWith('/api/tasks/')) {
    res.end(JSON.stringify({ tasks: [] }))
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
