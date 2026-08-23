# 项目体系 + 自动标题 + 技能/MCP 入口 + ChatBox 增强 + Portable 模式 实施计划

> **2026-08-19 注记**:自研 Electron 客户端(desktop/)与浏览器插件已下线删除,仓库仅保留服务端接口与 webadmin 管理端。本文档为历史设计与计划,服务端相关部分仍有效,客户端相关部分不再适用。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 客户端新增项目体系(项目=工作目录+会话分组,引擎工具操作项目目录)、LLM 自动标题、Settings 页入口、ChatBox 增强(/命令、@提及、自动增高、历史找回),并将客户端改为 Portable 模式(data 目录随程序目录)。

**Architecture:** 数据层扩展客户端 SQLite(迁移 0010 新增 projects 表 + conversations.project_id),workspace 由 `<exe 同目录或系统目录>/data/workspaces` 演进为「项目内会话 = <项目目录>/<conv-id>/」;引擎工具注册表按会话 workspace 动态构建;标题生成走服务端网关(后台 fire-and-forget)。Portable 判定(仅 Windows/Linux)= 程序根目录存在 `portable.txt`,data 目录 = exe 同目录/data,不可写时回退系统目录。**macOS 不做 portable**:dmg 拖入 Applications 即用,数据按 macOS 规范存 `~/Library/Application Support/picoaide`,随应用分发的是纯程序;并补 macOS HIG 适配(原生菜单 Cmd+Q/+,N、跟随系统深色模式)。

**Tech Stack:** better-sqlite3 迁移、Electron IPC、Vercel AI SDK(引擎不动)、zustand(renderer)、Vitest(TDD)。

**Spec:** `docs/superpowers/specs/2026-08-03-projects-titles-marketplace-ui-chatbox-design.md`

---

## Phase 0: Portable 模式

### Task 0.1: paths.ts Portable 检测与 data 目录

**Files:**
- Modify: `desktop/src/main/paths.ts`
- Test: `desktop/src/main/paths.test.ts`(新建)

- [ ] **Step 1: 写失败测试**

```ts
// desktop/src/main/paths.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dataDir, isPortable, setDataDirOverride } from './paths'

let tmp: string
let origExecPath: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'paths-test-'))
  origExecPath = process.execPath
  setDataDirOverride(null)
})

afterEach(() => {
  Object.defineProperty(process, 'execPath', { value: origExecPath, configurable: true })
})

function setExecPath(p: string): void {
  Object.defineProperty(process, 'execPath', { value: p, configurable: true })
}

// macOS 一律走标准数据目录(Application Support),不做 portable
describe('portable mode', () => {
  it('无 portable.txt 时不启用 portable', () => {
    setExecPath(join(tmp, 'picoaide', 'picoaide'))
    expect(isPortable()).toBe(false)
  })

  it('exe 同目录存在 portable.txt 时启用 portable,data 目录 = exe 同目录/data(linux)', () => {
    mkdirSync(join(tmp, 'app'), { recursive: true })
    writeFileSync(join(tmp, 'app', 'portable.txt'), '')
    setExecPath(join(tmp, 'app', 'picoaide'))
    expect(isPortable()).toBe(true)
    expect(dataDir()).toBe(join(tmp, 'app', 'data'))
  })

  it('macOS 即使有 portable.txt 也不启用 portable,data 走 Application Support', () => {
    const app = join(tmp, 'app.app')
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(join(app, 'portable.txt'), '')
    setExecPath(join(app, 'Contents', 'MacOS', 'picoaide'))
    vi.stubGlobal('process', { ...process, platform: 'darwin' })
    try {
      expect(isPortable()).toBe(false)
      process.env.HOME = join(tmp, 'home')
      expect(dataDir()).toBe(join(tmp, 'home', 'Library', 'Application Support', 'picoaide'))
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('portable 目录不可写时回退系统目录', () => {
    // data 目录是文件而非目录 → mkdir 失败 → 回退
    mkdirSync(join(tmp, 'ro'), { recursive: true })
    writeFileSync(join(tmp, 'ro', 'portable.txt'), '')
    writeFileSync(join(tmp, 'ro', 'data'), 'blocked')
    setExecPath(join(tmp, 'ro', 'picoaide'))
    process.env.HOME = join(tmp, 'home')
    expect(dataDir()).toBe(join(tmp, 'home', '.local', 'share', 'picoaide'))
  })

  it('dataDirOverride 优先于 portable', () => {
    mkdirSync(join(tmp, 'app'), { recursive: true })
    writeFileSync(join(tmp, 'app', 'portable.txt'), '')
    setExecPath(join(tmp, 'app', 'picoaide'))
    setDataDirOverride(join(tmp, 'override'))
    expect(dataDir()).toBe(join(tmp, 'override'))
  })
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `cd desktop && npm test -- paths.test.ts`
Expected: FAIL(`Cannot find module './paths.test.ts'` 之前,先看 `paths.test.ts` 报错——文件不存在即红)

- [ ] **Step 3: 实现**

```ts
// desktop/src/main/paths.ts(整体重写)
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

let dataDirOverride: string | null = null

export function setDataDirOverride(dir: string | null): void {
  dataDirOverride = dir
}

// Portable 模式(仅 Windows/Linux):exe 同目录存在 portable.txt(打包脚本生成)→ data 目录 = exe 同目录/data
// macOS 按平台规范走 Application Support,不做 portable(dmg 拖入 Applications 即用,数据不随 .app)
export function isPortable(): boolean {
  if (process.platform === 'darwin') return false
  return existsSync(join(dirname(process.execPath), 'portable.txt'))
}

export function portableDataDir(): string {
  return join(dirname(process.execPath), 'data')
}

function defaultDataDir(): string {
  const home = process.env.HOME
  if (process.platform === 'darwin') {
    return join(home ?? '', 'Library', 'Application Support', 'picoaide')
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? home ?? '', 'picoaide')
  }
  return join(home ?? '', '.local', 'share', 'picoaide')
}

export function dataDir(): string {
  if (dataDirOverride) return dataDirOverride
  if (isPortable()) {
    try {
      // 幂等 mkdir;目录只读/被文件占用时抛错 → 回退系统目录
      mkdirSync(portableDataDir(), { recursive: true })
      return portableDataDir()
    } catch {
      // fall through
    }
  }
  return defaultDataDir()
}

export function dbPath(): string {
  return join(dataDir(), 'picoaide.db')
}

export function workspaceDir(): string {
  return join(dataDir(), 'workspaces')
}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `cd desktop && npm test -- paths.test.ts`
Expected: PASS(5 tests)

- [ ] **Step 5: 全量客户端测试确认无回归**

Run: `cd desktop && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add desktop/src/main/paths.ts desktop/src/main/paths.test.ts
git commit -m "feat: portable mode (win/linux) - data dir follows exe when portable.txt present"
```

### Task 0.2: 打包脚本生成 portable.txt(仅 Windows/Linux)+ dmg 验证

**Files:**
- Modify: `scripts/pkg-linux.sh`
- Modify: `scripts/pkg-windows.sh`
- Modify: `scripts/pkg-macos.sh`(dmg 产物确认,不加 portable.txt)

- [ ] **Step 1: pkg-linux.sh 在产物后生成 portable 标记 + zip**

`scripts/pkg-linux.sh` 改为:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../desktop"

npm run build
npx electron-builder --linux --dir
# Portable 标记:exe 同目录存在 portable.txt → 客户端数据落在运行目录/data
touch dist/linux-unpacked/portable.txt
cd dist
rm -f picoaide-linux-portable.zip
zip -qr picoaide-linux-portable.zip linux-unpacked

echo
echo "== Linux packages =="
echo "deb:      $(ls picoaide_*_amd64.deb 2>/dev/null || ls *.deb 2>/dev/null || echo 'not found (full build only)')"
echo "AppImage: $(ls *.AppImage 2>/dev/null || echo 'not found (full build only)')"
echo "Portable: $(ls picoaide-linux-portable.zip 2>/dev/null || echo 'not found')"
```

- [ ] **Step 2: pkg-windows.sh 尾部追加**

```bash
touch dist/win-unpacked/portable.txt
cd dist
rm -f picoaide-windows-portable.zip
zip -qr picoaide-windows-portable.zip win-unpacked
echo "Portable: $(ls picoaide-windows-portable.zip)"
```

- [ ] **Step 3: pkg-macos.sh 确认 dmg 标准产物(数据走 Application Support,无 portable.txt)**

`scripts/pkg-macos.sh` 保持 electron-builder --mac dmg(拖入 Applications 即用);追加说明注释:

```bash
# macOS 规范:标准 dmg,拖入 Applications 即用;数据存 ~/Library/Application Support/picoaide(非 portable)
```

- [ ] **Step 4: 验证脚本语法**

Run: `bash -n scripts/pkg-linux.sh && bash -n scripts/pkg-windows.sh && bash -n scripts/pkg-macos.sh`
Expected: 无输出(语法正确)

- [ ] **Step 5: Commit**

```bash
git add scripts/pkg-linux.sh scripts/pkg-windows.sh scripts/pkg-macos.sh
git commit -m "feat: package portable zip (win/linux); mac stays standard dmg"
```

### Task 0.3: macOS HIG 适配(原生菜单 / 深色模式 / 窗口)

**Files:**
- Modify: `desktop/src/main/index.ts`
- Modify: `desktop/src/preload/index.ts`
- Modify: `desktop/src/renderer/src/App.tsx`
- Modify: `desktop/src/renderer/src/index.css`(.dark 变量)
- Modify: `desktop/src/renderer/src/main.tsx`(主题初始化)
- Test: 无(纯平台代码,依赖 typecheck + macOS 手动验证)

- [ ] **Step 1: 主进程原生应用菜单(仅 macOS)**

`desktop/src/main/index.ts` 顶部 import 增加:

```ts
import { app, BrowserWindow, dialog, Menu, nativeTheme, shell } from 'electron'
```

`createWindow` 前加菜单构建(darwin 时):

```ts
function buildMenu(): void {
  if (process.platform !== 'darwin') return
  const send = (command: string): void => {
    mainWindow?.webContents.send('menu:command', command)
  }
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: '设置…', accelerator: 'Cmd+,', click: () => send('settings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: '文件',
      submenu: [
        { label: '新建会话', accelerator: 'Cmd+N', click: () => send('new-chat') },
        { label: '新建项目', accelerator: 'Cmd+Shift+N', click: () => send('new-project') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
```

`app.whenReady()` 内 `createWindow()` 之前调用 `buildMenu()`。

- [ ] **Step 2: 主题跟随系统(深色模式)**

`desktop/src/main/index.ts` 加 IPC handler(放在 buildHandlers 或合适位置):

```ts
  'theme:get': (): 'dark' | 'light' => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'),
  'theme:changed': (): void => {
    // renderer 订阅 channel 名,主进程仅转发 nativeTheme 事件
    void 0
  },
```

`app.whenReady()` 内:

```ts
  nativeTheme.on('updated', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('theme:changed', nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
    }
  })
```

`desktop/src/preload/index.ts` 加:

```ts
  getTheme: (): Promise<'dark' | 'light'> => ipcRenderer.invoke('theme:get'),
  onThemeChanged: (cb: (t: 'dark' | 'light') => void): Unsub => subscribe('theme:changed', cb),
```

`desktop/src/renderer/src/App.tsx` 加主题同步 useEffect(现有 useEffect 旁):

```tsx
  useEffect(() => {
    const apply = (t: 'dark' | 'light'): void => {
      document.documentElement.classList.toggle('dark', t === 'dark')
    }
    void window.picoaide.getTheme().then(apply)
    const off = window.picoaide.onThemeChanged(apply)
    return () => off()
  }, [])
```

- [ ] **Step 3: renderer 菜单命令事件(App.tsx)**

```tsx
  useEffect(() => {
    const off = window.picoaide.onMenuCommand((cmd) => {
      if (cmd === 'settings') setView('settings')
      else if (cmd === 'new-chat') void useChatStore.getState().newConversation()
    })
    return () => off()
  }, [])
```

`desktop/src/preload/index.ts` 加:

```ts
  onMenuCommand: (cb: (cmd: 'settings' | 'new-chat' | 'new-project') => void): Unsub =>
    subscribe('menu:command', cb),
```

- [ ] **Step 4: index.css 补 .dark 变量集(shadcn 深色)**

`desktop/src/renderer/src/index.css` 追加:

```css
.dark {
  --background: 222.2 84% 4.9%;
  --foreground: 210 40% 98%;
  --card: 222.2 84% 4.9%;
  --card-foreground: 210 40% 98%;
  --popover: 222.2 84% 4.9%;
  --popover-foreground: 210 40% 98%;
  --primary: 210 40% 98%;
  --primary-foreground: 222.2 47.4% 11.2%;
  --secondary: 217.2 32.6% 17.5%;
  --secondary-foreground: 210 40% 98%;
  --muted: 217.2 32.6% 17.5%;
  --muted-foreground: 215 20.2% 65.1%;
  --accent: 217.2 32.6% 17.5%;
  --accent-foreground: 210 40% 98%;
  --destructive: 0 62.8% 30.6%;
  --destructive-foreground: 210 40% 98%;
  --border: 217.2 32.6% 17.5%;
  --input: 217.2 32.6% 17.5%;
  --ring: 212.7 26.8% 83.9%;
}
```

- [ ] **Step 5: 窗口最小尺寸(HIG)**

`createWindow` 的 BrowserWindow 参数追加:

```ts
    minWidth: 900,
    minHeight: 600,
```

- [ ] **Step 6: 验证**

Run: `cd desktop && npm test && npm run typecheck`
Expected: 全绿(typecheck 覆盖 preload/renderer/main 类型)

macOS 手动验证(有 mac 环境时):菜单含 PicoAide/文件/编辑/窗口,Cmd+, 打开设置,Cmd+N 新建会话;切换系统深色模式 UI 跟随;dmg 拖入 Applications 启动正常,数据落在 `~/Library/Application Support/picoaide`。

- [ ] **Step 7: Commit**

```bash
git add desktop/src/main/index.ts desktop/src/preload/index.ts desktop/src/renderer/src/App.tsx desktop/src/renderer/src/index.css
git commit -m "feat: macOS HIG - native menu, system dark mode, min window size"
```

---

## Phase 1: 项目数据层 + IPC + 引擎注入

### Task 1.1: 迁移 0010 - projects 表 + project_id 列

**Files:**
- Modify: `desktop/src/main/store/migrations.ts`
- Modify: `desktop/src/main/store/db.test.ts`

- [ ] **Step 1: 写失败测试(追加到 db.test.ts)**

```ts
// 追加:迁移 0010 后 projects 表与 conversations.project_id 存在
it('migration 0010 adds projects table and conversations.project_id', () => {
  const db = openInMemory()
  migrate(db)
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name)
  expect(tables).toContain('projects')
  const cols = (db.prepare('PRAGMA table_info(conversations)').all() as { name: string }[]).map((c) => c.name)
  expect(cols).toContain('project_id')
})
```

(先看 db.test.ts 现有 `openInMemory` 助手名与导入,保持一致;若无此助手则写 `const db = new Database(':memory:')` 并在用例内 `migrate(db)`。)

- [ ] **Step 2: 跑测试确认红**

Run: `cd desktop && npm test -- db.test.ts`
Expected: FAIL(`table projects has no column` / `column project_id not found`)

- [ ] **Step 3: 实现(migrations.ts 数组追加第 10 条)**

```ts
  `CREATE TABLE projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now','localtime'))
  );
  ALTER TABLE conversations ADD COLUMN project_id INTEGER;`,
```

- [ ] **Step 4: 跑测试确认绿**

Run: `cd desktop && npm test -- db.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/store/migrations.ts desktop/src/main/store/db.test.ts
git commit -m "feat: migration 0010 projects table and conversations.project_id"
```

### Task 1.2: store/projects.ts - 项目 CRUD + workspace 解析

**Files:**
- Create: `desktop/src/main/store/projects.ts`
- Test: `desktop/src/main/store/projects.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// desktop/src/main/store/projects.test.ts
import { describe, expect, it, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from './migrations'
import { createProject, deleteProject, listProjects, setConversationProject, workspaceFor } from './projects'
import { createConversation } from './conversations'

function openDb(): Database.Database {
  const db = new Database(':memory:')
  migrate(db)
  return db
}

describe('projects store', () => {
  let db: Database.Database
  beforeEach(() => { db = openDb() })

  it('create + list', () => {
    const id = createProject(db, { name: '文档项目', path: '/tmp/doc' })
    expect(listProjects(db)).toHaveLength(1)
    expect(listProjects(db)[0]).toMatchObject({ id, name: '文档项目', path: '/tmp/doc' })
  })

  it('重复 path 抛错', () => {
    createProject(db, { name: 'a', path: '/tmp/doc' })
    expect(() => createProject(db, { name: 'b', path: '/tmp/doc' })).toThrow()
  })

  it('delete 解除会话关联(project_id 置 NULL,会话保留)', () => {
    const pid = createProject(db, { name: 'a', path: '/tmp/doc' })
    const cid = createConversation(db, { projectId: pid })
    deleteProject(db, pid)
    expect(listProjects(db)).toHaveLength(0)
    const conv = db.prepare('SELECT project_id FROM conversations WHERE id = ?').get(cid) as { project_id: number | null }
    expect(conv.project_id).toBeNull()
  })

  it('setConversationProject 移动会话', () => {
    const pid = createProject(db, { name: 'a', path: '/tmp/a' })
    const cid = createConversation(db, {})
    setConversationProject(db, cid, pid)
    const row = db.prepare('SELECT project_id FROM conversations WHERE id = ?').get(cid) as { project_id: number | null }
    expect(row.project_id).toBe(pid)
    setConversationProject(db, cid, null)
    const row2 = db.prepare('SELECT project_id FROM conversations WHERE id = ?').get(cid) as { project_id: number | null }
    expect(row2.project_id).toBeNull()
  })

  it('workspaceFor = 项目路径/会话id', () => {
    expect(workspaceFor('/tmp/proj', 42)).toBe('/tmp/proj/42')
  })
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `cd desktop && npm test -- projects.test.ts`
Expected: FAIL(`Cannot find module './projects'`)

- [ ] **Step 3: 实现**

```ts
// desktop/src/main/store/projects.ts
import { join } from 'node:path'
import type Database from 'better-sqlite3'

export interface ProjectRow {
  id: number
  name: string
  path: string
  created_at: string
}

export function createProject(db: Database.Database, input: { name: string; path: string }): number {
  return db.prepare('INSERT INTO projects (name, path) VALUES (?, ?)').run(input.name, input.path).lastInsertRowid as number
}

export function listProjects(db: Database.Database): ProjectRow[] {
  return db.prepare('SELECT * FROM projects ORDER BY created_at DESC, id DESC').all() as ProjectRow[]
}

export function getProject(db: Database.Database, id: number): ProjectRow | null {
  return (db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined) ?? null
}

// 删除项目:仅解除会话关联,不删任何文件
export function deleteProject(db: Database.Database, id: number): void {
  db.transaction(() => {
    db.prepare('UPDATE conversations SET project_id = NULL WHERE project_id = ?').run(id)
    db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  })()
}

export function setConversationProject(db: Database.Database, conversationId: number, projectId: number | null): void {
  db.prepare('UPDATE conversations SET project_id = ? WHERE id = ?').run(projectId, conversationId)
}

// 项目内会话 workspace = <项目目录>/<会话id>
export function workspaceFor(projectPath: string, conversationId: number): string {
  return join(projectPath, String(conversationId))
}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `cd desktop && npm test -- projects.test.ts`
Expected: PASS(5 tests)

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/store/projects.ts desktop/src/main/store/projects.test.ts
git commit -m "feat: projects store CRUD and workspace resolution"
```

### Task 1.3: createConversation 支持 projectId + chat:new 建 workspace 目录

**Files:**
- Modify: `desktop/src/main/store/conversations.ts`
- Modify: `desktop/src/main/store/conversations.test.ts`
- Modify: `desktop/src/main/ipc.ts`(`chat:new` handler + StoreLike 扩展)
- Modify: `desktop/src/main/index.ts`(store 组装处补项目方法)

- [ ] **Step 1: 写失败测试(conversations.test.ts 追加)**

```ts
it('createConversation 支持 projectId', () => {
  const db = openDb()
  migrate(db)
  const id = createConversation(db, { projectId: 7 })
  const row = db.prepare('SELECT project_id FROM conversations WHERE id = ?').get(id) as { project_id: number | null }
  expect(row.project_id).toBe(7)
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `cd desktop && npm test -- conversations.test.ts`
Expected: FAIL(现有 `INSERT INTO conversations (title, mode, model, workspace)` 无 project_id 列)

- [ ] **Step 3: 实现**

`desktop/src/main/store/conversations.ts` 修改 `createConversation`:

```ts
export function createConversation(db: Database.Database, input?: { title?: string; mode?: string; projectId?: number | null }): number {
  const r = db
    .prepare('INSERT INTO conversations (title, mode, model, workspace, project_id) VALUES (?, ?, ?, ?, ?)')
    .run(input?.title ?? '', input?.mode ?? 'ask', input?.model ?? '', input?.workspace ?? '', input?.projectId ?? null)
  return r.lastInsertRowid as number
}
```

(若 conversations.ts 的 `createConversation` 无 `input` 参数则按此签名对齐;看现有文件确认。)

`desktop/src/main/ipc.ts`:

1. `StoreLike` 接口新增:

```ts
  createProject(input: { name: string; path: string }): number
  listProjects(): { id: number; name: string; path: string; created_at: string }[]
  getProject(id: number): { id: number; name: string; path: string; created_at: string } | null
  deleteProject(id: number): void
  setConversationProject(conversationId: number, projectId: number | null): void
  setConversationWorkspace(id: number, workspace: string): void
```

2. `IpcHandlers` 新增:

```ts
  'project:list': () => { id: number; name: string; path: string; created_at: string }[]
  'project:create': (input: { name: string; path: string }) => number
  'project:delete': (input: { id: number }) => void
  'conversation:moveProject': (input: { conversationId: number; projectId: number | null }) => void
  'workspace:listFiles': (input: { roots: string[] }) => string[]
```

3. `buildAgentHandlers` 返回对象新增 handler + 改 `chat:new`:

```ts
    'chat:new': (input) => {
      const projectId = input?.projectId ?? null
      const id = deps.store.createConversation({ mode: input?.mode, projectId })
      if (projectId !== null) {
        const project = deps.store.getProject(projectId)
        if (project) {
          const ws = workspaceFor(project.path, id)
          mkdirSync(ws, { recursive: true })
          deps.store.setConversationWorkspace(id, ws)
        }
      }
      return id
    },
    'project:list': () => deps.store.listProjects(),
    'project:create': ({ name, path }) => deps.store.createProject({ name, path }),
    'project:delete': ({ id }) => deps.store.deleteProject(id),
    'conversation:moveProject': ({ conversationId, projectId }) => deps.store.setConversationProject(conversationId, projectId),
    'workspace:listFiles': ({ roots }) => listFilesRecursive(roots),
```

(顶部 import:`import { mkdirSync } from 'node:fs'`、`import { workspaceFor } from './store/projects'`、`import { listFilesRecursive } from './store/projects'` 或独立 `./files'`——见 Step 4。)

4. 新增 `desktop/src/main/store/files.ts`(枚举工具,供 @ 文件选择器):

```ts
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_DEPTH = 3
const SKIP = new Set(['node_modules', '.git', 'dist', 'out', '.picoaide-data'])

// 递归枚举文件(深度 ≤3,排除噪音目录);roots 需经调用方校验在可访问目录内
export function listFilesRecursive(roots: string[]): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (SKIP.has(name)) continue
      const full = join(dir, name)
      try {
        const st = statSync(full)
        if (st.isDirectory()) walk(full, depth + 1)
        else out.push(full)
      } catch {
        // ignore unreadable
      }
    }
  }
  for (const root of roots) walk(root, 0)
  return out.sort()
}
```

`desktop/src/main/index.ts` 组装 store 时补方法(现有 store 变量由 conversations/messages/settings/artifacts 函数组合而成,找到 `const store` 组装处,添加):

```ts
      createProject: (input) => createProject(db, input),
      listProjects: () => listProjects(db),
      getProject: (id) => getProject(db, id),
      deleteProject: (id) => deleteProject(db, id),
      setConversationProject: (cid, pid) => setConversationProject(db, cid, pid),
      setConversationWorkspace: (id, ws) => setConversationWorkspace(db, id, ws),
```

`store/conversations.ts` 新增 `setConversationWorkspace`:

```ts
export function setConversationWorkspace(db: Database.Database, id: number, workspace: string): void {
  db.prepare('UPDATE conversations SET workspace = ? WHERE id = ?').run(workspace, id)
}
```

- [ ] **Step 4: 实现 files.ts 独立测试**

```ts
// desktop/src/main/store/files.test.ts
import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listFilesRecursive } from './files'

it('递归枚举文件,跳过 node_modules/.git,限深度', () => {
  const root = join(tmpdir(), 'files-test-' + Date.now())
  mkdirSync(join(root, 'a', 'b'), { recursive: true })
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  writeFileSync(join(root, 'x.txt'), 'x')
  writeFileSync(join(root, 'a', 'y.md'), 'y')
  writeFileSync(join(root, 'a', 'b', 'z.log'), 'z')
  writeFileSync(join(root, 'node_modules', 'skip.txt'), 's')
  const files = listFilesRecursive([root])
  expect(files).toContain(join(root, 'x.txt'))
  expect(files).toContain(join(root, 'a', 'y.md'))
  expect(files).toContain(join(root, 'a', 'b', 'z.log'))
  expect(files.some((f) => f.includes('node_modules'))).toBe(false)
})
```

- [ ] **Step 5: 跑测试确认绿**

Run: `cd desktop && npm test && npm run typecheck`
Expected: 全绿(新用例 + 现有不回归;typecheck 通过)

- [ ] **Step 6: Commit**

```bash
git add desktop/src/main/store/conversations.ts desktop/src/main/store/conversations.test.ts desktop/src/main/store/projects.ts desktop/src/main/store/files.ts desktop/src/main/store/files.test.ts desktop/src/main/ipc.ts desktop/src/main/index.ts
git commit -m "feat: project-aware chat:new creates workspace dir; file listing IPC"
```

### Task 1.4: 引擎工具按会话 workspace 注入

**Files:**
- Modify: `desktop/src/main/index.ts`(`buildToolsRegistry` + `getTools` 签名)
- Modify: `desktop/src/main/ipc.ts`(`AgentIpcDeps.getTools` + 三处调用点)
- Modify: `desktop/src/main/ipc.test.ts`

- [ ] **Step 1: 写失败测试(ipc.test.ts 追加)**

(先看 ipc.test.ts 现有 fake deps 结构,追加)

```ts
it('chat:continue 向 getTools 传入会话 workspace', async () => {
  const workspace = '/proj/5'
  const getTools = vi.fn(async () => ({ tools: {}, highRiskTools: new Set<string>() }))
  const deps = makeDeps({ getTools, conversation: { ...baseConversation, id: 5, mode: 'craft', workspace } })
  const handlers = buildAgentHandlers(deps)
  await handlers['chat:continue']({ conversationId: 5 })
  expect(getTools).toHaveBeenCalledWith(workspace)
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `cd desktop && npm test -- ipc.test.ts`
Expected: FAIL(`toHaveBeenCalledWith` 收到 undefined)

- [ ] **Step 3: 实现**

`desktop/src/main/ipc.ts`:

```ts
  getTools: (workspace?: string) => Promise<{ tools: Record<string, GatedTool>; highRiskTools: Set<string> }>
```

三处调用点改为:

```ts
      if (mode === 'craft') {
        const { tools, highRiskTools } = await deps.getTools(deps.store.getConversation(conversationId)?.workspace)
        await (await getEngine()).craft({ conversationId, content, tools, highRiskTools })
      }
```

```ts
      } else {
        const { tools, highRiskTools } = await deps.getTools(deps.store.getConversation(conversationId)?.workspace)
        await (await getEngine()).continueConversation({ conversationId, tools, highRiskTools })
      }
```

```ts
      if (ok) {
        const { tools, highRiskTools } = await deps.getTools(deps.store.getConversation(conversationId)?.workspace)
        await (await getEngine()).approvePlan({ conversationId, ok, tools, highRiskTools })
      }
```

`desktop/src/main/index.ts`:

```ts
async function buildToolsRegistry(db: ..., workspace?: string): Promise<...> {
  const base = workspace ?? workspaceDir()
  const allowedDirs = resolveAllowedDirs(base, getAllowedDirsFromSettings((k) => getSetting(db, k)))
  const cwd = base
  // ...其余不变
}
```

`getTools: (workspace?: string) => buildToolsRegistry(db, workspace)`(AgentIpcDeps 的 getTools 同步函数改异步?保持 `getTools: (workspace?: string) => buildToolsRegistry(db, workspace)` 即可,类型是 Promise 返回。)

- [ ] **Step 4: 跑测试确认绿**

Run: `cd desktop && npm test && npm run typecheck`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/index.ts desktop/src/main/ipc.ts desktop/src/main/ipc.test.ts
git commit -m "feat: engine tools bind to conversation workspace"
```

### Task 1.5: renderer API + chat store 项目状态

**Files:**
- Modify: `desktop/src/preload/index.ts`
- Modify: `desktop/src/renderer/src/stores/chat.ts`
- Modify: `desktop/src/renderer/src/stores/chat.test.ts`

- [ ] **Step 1: 写失败测试(chat.test.ts 追加,仿现有 fake 模式)**

```ts
// FakePicoaide 增加:
  projectList: ReturnType<typeof vi.fn>
  projectCreate: ReturnType<typeof vi.fn>
  projectDelete: ReturnType<typeof vi.fn>
  moveConversation: ReturnType<typeof vi.fn>

// makeFake 内:
    projectList: vi.fn(async () => projects.map((p) => ({ ...p }))),
    projectCreate: vi.fn(async (input: { name: string; path: string }) => {
      const id = nextId++
      projects.push({ id, name: input.name, path: input.path, created_at: '' })
      return id
    }),
    projectDelete: vi.fn(async () => undefined),
    moveConversation: vi.fn(async () => undefined),

// 测试:
it('createProject 加入列表并返回 id', async () => {
  const { api } = makeFake()
  useChatStore.setState({ projects: [] })
  const id = await useChatStore.getState().createProject({ name: 'P1', path: '/p1' })
  expect(id).toBeGreaterThan(0)
  expect(useChatStore.getState().projects).toHaveLength(1)
})

it('newConversation 透传 projectId 到 chatNew', async () => {
  const { api } = makeFake()
  useChatStore.setState({ projects: [{ id: 2, name: 'P2', path: '/p2', created_at: '' }], activeProjectId: 2 })
  await useChatStore.getState().newConversation()
  expect(api.chatNew).toHaveBeenCalledWith({ mode: 'ask', projectId: 2 })
})

it('deleteProject 移除项目并清 activeProjectId', async () => {
  const { api } = makeFake()
  useChatStore.setState({ projects: [{ id: 1, name: 'P', path: '/p', created_at: '' }], activeProjectId: 1 })
  await useChatStore.getState().deleteProject(1)
  expect(useChatStore.getState().projects).toHaveLength(0)
  expect(useChatStore.getState().activeProjectId).toBeNull()
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `cd desktop && npm test -- chat.test.ts`
Expected: FAIL(store 无 createProject/deleteProject、chatNew 无 projectId 参数)

- [ ] **Step 3: 实现**

`desktop/src/preload/index.ts`:

```ts
  chatNew: (input?: { title?: string; mode?: string; projectId?: number | null }): Promise<number> =>
    ipcRenderer.invoke('chat:new', input),
  projectList: (): Promise<ProjectRow[]> => ipcRenderer.invoke('project:list'),
  projectCreate: (input: { name: string; path: string }): Promise<number> =>
    ipcRenderer.invoke('project:create', input),
  projectDelete: (id: number): Promise<void> => ipcRenderer.invoke('project:delete', { id }),
  moveConversation: (conversationId: number, projectId: number | null): Promise<void> =>
    ipcRenderer.invoke('conversation:moveProject', { conversationId, projectId }),
  workspaceListFiles: (roots: string[]): Promise<string[]> => ipcRenderer.invoke('workspace:listFiles', { roots }),
```

(顶部 `import type { ProjectRow } from '../main/ipc'`;ipc.ts 导出 ProjectRow 类型。)

`desktop/src/renderer/src/stores/chat.ts`:

```ts
export interface ProjectView {
  id: number
  name: string
  path: string
  created_at: string
}

// state 增加:
  projects: ProjectView[]
  activeProjectId: number | null
  collapsedProjects: number[]

// actions 增加:
  loadProjects: () => Promise<void>
  createProject: (input: { name: string; path: string }) => Promise<number>
  deleteProject: (id: number) => Promise<void>
  moveConversation: (conversationId: number, projectId: number | null) => Promise<void>
  setActiveProject: (id: number | null) => void
  toggleProjectCollapsed: (id: number) => void

// 初始值:
  projects: [],
  activeProjectId: null,
  collapsedProjects: [],

// 实现:
  loadProjects: async () => set({ projects: await picoaide().projectList() }),
  createProject: async (input) => {
    const id = await picoaide().projectCreate(input)
    await get().loadProjects()
    return id
  },
  deleteProject: async (id) => {
    await picoaide().projectDelete(id)
    set((s) => ({ activeProjectId: s.activeProjectId === id ? null : s.activeProjectId }))
    await get().loadProjects()
  },
  moveConversation: async (conversationId, projectId) => {
    await picoaide().moveConversation(conversationId, projectId)
    await Promise.all([get().loadConversations(), get().loadProjects()])
  },
  setActiveProject: (id) => set({ activeProjectId: id }),
  toggleProjectCollapsed: (id) =>
    set((s) => ({
      collapsedProjects: s.collapsedProjects.includes(id)
        ? s.collapsedProjects.filter((x) => x !== id)
        : [...s.collapsedProjects, id],
    })),
```

`newConversation` 改为:

```ts
  newConversation: async () => {
    const id = await picoaide().chatNew({ mode: get().mode, projectId: get().activeProjectId })
    const [conversations, projects] = await Promise.all([picoaide().chatList(), picoaide().projectList()])
    set({ conversations, projects, activeId: id, messages: [], artifacts: [], streaming: false, streamingText: '', toolCalls: [], localError: null, hasMoreMessages: false, loadedTotal: 0 })
    return id
  },
```

(chat.test.ts 的 FakePicoaide 若按接口实现会缺方法编译报错——fake 是 `ReturnType<typeof vi.fn>` 的对象字面量,不强制实现全接口,现有测试能过。但 `chatNew` 断言 `toHaveBeenCalledWith({ mode: 'ask' })` 的现有用例需改为 `{ mode: 'ask', projectId: null }`,在 Step 3 同步更新。)

- [ ] **Step 4: 跑测试确认绿**

Run: `cd desktop && npm test && npm run typecheck`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add desktop/src/preload/index.ts desktop/src/renderer/src/stores/chat.ts desktop/src/renderer/src/stores/chat.test.ts
git commit -m "feat: renderer project state and APIs"
```

---

## Phase 2: 自动标题

### Task 2.1: agent/title.ts - LLM 标题生成 + 兜底

**Files:**
- Create: `desktop/src/main/agent/title.ts`
- Test: `desktop/src/main/agent/title.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// desktop/src/main/agent/title.test.ts
import { describe, expect, it } from 'vitest'
import { fallbackTitle, generateTitle } from './title'

const session = { serverURL: 'https://gw.example.com', token: 'tok', username: 'u' } as never

describe('generateTitle', () => {
  it('解析网关返回的标题并截断 20 字', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '这是一段很长的标题用来测试截断行为是否正常生效' } }] }), { status: 200 }),
    )
    const t = await generateTitle(session, 'm1', '帮我写周报', fetchFn as typeof fetch)
    expect(t).toHaveLength(20)
    expect(fetchFn).toHaveBeenCalledWith(
      'https://gw.example.com/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('网关失败时抛错(由调用方兜底)', async () => {
    const fetchFn = vi.fn(async () => new Response('err', { status: 500 }))
    await expect(generateTitle(session, 'm1', 'x', fetchFn as typeof fetch)).rejects.toThrow()
  })

  it('超时(15s)抛错', async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      await new Promise((r) => setTimeout(r, 1000))
      throw new DOMException('Aborted', 'AbortError')
    })
    await expect(generateTitle(session, 'm1', 'x', fetchFn as typeof fetch, 50)).rejects.toThrow()
  })

  it('空内容/纯空白返回空串', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '  ' } }] }), { status: 200 }))
    expect(await generateTitle(session, 'm1', 'x', fetchFn as typeof fetch)).toBe('')
  })
})

describe('fallbackTitle', () => {
  it('截取前 20 字符', () => {
    expect(fallbackTitle('  帮我整理一下这个月的报销单据并生成表格  ')).toBe('帮我整理一下这个月的报销单据并生成表格')
  })
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `cd desktop && npm test -- title.test.ts`
Expected: FAIL(`Cannot find module './title'`)

- [ ] **Step 3: 实现**

```ts
// desktop/src/main/agent/title.ts
const MAX_TITLE_LEN = 20

export function fallbackTitle(text: string): string {
  return text.trim().slice(0, MAX_TITLE_LEN)
}

export interface TitleSession {
  serverURL: string
  token: string
}

// 调网关默认模型生成 ≤20 字标题;失败抛错由调用方兜底。fetchFn 默认注入以便测试
export async function generateTitle(
  session: TitleSession,
  modelId: string,
  firstUserText: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 15000,
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchFn(`${session.serverURL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 40,
        temperature: 0,
        messages: [
          { role: 'system', content: `为下面的用户消息生成一个不超过${MAX_TITLE_LEN}字的会话标题,只输出标题本身,不要引号。` },
          { role: 'user', content: firstUserText.slice(0, 500) },
        ],
      }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`title generation failed: ${res.status}`)
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    const content = data.choices?.[0]?.message?.content?.trim() ?? ''
    return content.slice(0, MAX_TITLE_LEN)
  } finally {
    clearTimeout(timer)
  }
}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `cd desktop && npm test -- title.test.ts`
Expected: PASS(4 tests;超时用例依赖第 5 参数 50ms)

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/agent/title.ts desktop/src/main/agent/title.test.ts
git commit -m "feat: LLM title generation with fallback"
```

### Task 2.2: chat:ask 完成后台触发标题

**Files:**
- Modify: `desktop/src/main/ipc.ts`(deps.autoTitle + chat:ask 挂接)
- Modify: `desktop/src/main/index.ts`(autoTitle 实现)
- Modify: `desktop/src/main/ipc.test.ts`

- [ ] **Step 1: 写失败测试(ipc.test.ts 追加)**

```ts
it('chat:ask 完成后后台触发 autoTitle(不阻塞)', async () => {
  const autoTitle = vi.fn(async () => undefined)
  const deps = makeDeps({ autoTitle, conversation: { ...baseConversation, id: 1, mode: 'ask' } })
  const handlers = buildAgentHandlers(deps)
  await handlers['chat:ask']({ conversationId: 1, content: 'hi' })
  expect(autoTitle).toHaveBeenCalledWith({ conversationId: 1 })
})

it('chat:ask 引擎报错时不触发 autoTitle', async () => {
  const autoTitle = vi.fn(async () => undefined)
  const deps = makeDeps({ autoTitle })
  const handlers = buildAgentHandlers(deps)
  deps.engineCraft = vi.fn(async () => { throw new Error('boom') })
  await expect(handlers['chat:ask']({ conversationId: 1, content: 'hi' })).rejects.toThrow('boom')
  expect(autoTitle).not.toHaveBeenCalled()
})
```

(根据 ipc.test.ts 现有 fake 的 engine 注入方式调整 `engineCraft` 名;若 fake engine 是 `{ craft: vi.fn() }` 直接 mock 该对象。)

- [ ] **Step 2: 跑测试确认红**

Run: `cd desktop && npm test -- ipc.test.ts`
Expected: FAIL(无 autoTitle 调用)

- [ ] **Step 3: 实现**

`desktop/src/main/ipc.ts`:

```ts
  // 自动标题(后台 fire-and-forget):chat:ask 引擎完成且会话标题为空时生成
  autoTitle?: (input: { conversationId: number }) => Promise<void>
```

`chat:ask` handler 改为:

```ts
    'chat:ask': async ({ conversationId, content }) => {
      const mode = deps.store.getConversation(conversationId)?.mode ?? 'ask'
      if (mode === 'craft') {
        const { tools, highRiskTools } = await deps.getTools(deps.store.getConversation(conversationId)?.workspace)
        await (await getEngine()).craft({ conversationId, content, tools, highRiskTools })
      } else if (mode === 'plan') {
        await (await getEngine()).plan({ conversationId, content })
      } else {
        await (await getEngine()).ask({ conversationId, content })
      }
      // 自动标题:后台生成,不阻塞对话完成;内部处理兜底与去重
      if (deps.autoTitle) void deps.autoTitle({ conversationId })
    },
```

`desktop/src/main/index.ts`(buildAgentHandlers 的 deps 追加):

```ts
      autoTitle: async ({ conversationId }) => {
        const conv = store.getConversation(conversationId)
        if (!conv || conv.title !== '') return
        const msgs = store.listMessages(conversationId)
        const firstUser = msgs.find((m) => m.role === 'user')
        if (!firstUser || !firstUser.content) return
        const session = getCurrentSession()
        const bootstrap = getBootstrapCache()
        if (!session) return
        const model = bootstrap.models.find((m) => m.id === bootstrap.default_model) ?? bootstrap.models[0]
        if (!model) return
        try {
          const title = await generateTitle(
            { serverURL: session.serverURL, token: session.token },
            model.id,
            firstUser.content,
            gatewayFetch,
          )
          if (title) store.setConversationTitle(conversationId, title)
        } catch {
          // 网关失败兜底:截取首条用户消息
          store.setConversationTitle(conversationId, fallbackTitle(firstUser.content))
        }
        // renderer 侧由下一次 loadConversations 刷新
      },
```

(index.ts 顶部 import `generateTitle, fallbackTitle` from './agent/title'。)

- [ ] **Step 4: 跑测试确认绿**

Run: `cd desktop && npm test && npm run typecheck`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/ipc.ts desktop/src/main/index.ts desktop/src/main/ipc.test.ts
git commit -m "feat: auto title after first turn (background, fallback to snippet)"
```

---

## Phase 3: renderer UI

### Task 3.1: 侧边栏项目体系 + Settings 入口 + 路由

**Files:**
- Modify: `desktop/src/renderer/src/App.tsx`
- Modify: `desktop/src/renderer/src/pages/Main.tsx`
- Modify: `desktop/src/renderer/src/pages/Settings.tsx`(加返回按钮)
- Test: 无新单测(store 逻辑已在 Task 1.5 覆盖;UI 依赖 typecheck + 手动验证)

- [ ] **Step 1: App.tsx 加 view 切换**

```tsx
import { useEffect, useState } from 'react'
import Login from './pages/Login'
import Main from './pages/Main'
import Settings from './pages/Settings'
// ...其余 import 不变

export default function App() {
  const authStatus = useAuthStore((s) => s.status)
  const [view, setView] = useState<'main' | 'settings'>('main')
  // ...useEffect 不变
  if (authStatus === 'unknown') { ... }
  if (authStatus !== 'loggedIn') return <Login />
  return view === 'settings' ? <Settings onBack={() => setView('main')} /> : <Main onOpenSettings={() => setView('settings')} />
}
```

- [ ] **Step 2: Settings.tsx 接受 onBack(改动签名与返回按钮)**

```tsx
export default function Settings({ onBack }: { onBack: () => void }) {
```

在页面顶部加:

```tsx
  <div className="flex items-center gap-2 border-b px-4 py-2">
    <Button variant="ghost" size="sm" onClick={onBack}>← 返回</Button>
    <span className="text-sm font-medium">设置</span>
  </div>
```

(先看 Settings.tsx 现有 JSX 根结构,把按钮插入最外层 div 顶部。)

- [ ] **Step 3: Main.tsx 侧边栏重构(完整替换)**

```tsx
import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, FolderPlus, LogOut, Plus, Settings as SettingsIcon, Trash2 } from 'lucide-react'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu'
import ArtifactsPanel from '../components/ArtifactsPanel'
import ChatInput from '../components/ChatInput'
import Messages from '../components/Messages'
import ConfirmModal from '../components/ConfirmModal'
import { useAuthStore } from '../stores/auth'
import { useChatStore, type ProjectView } from '../stores/chat'
import { useConnectionStore } from '../stores/connection'
import { cn } from '../lib/utils'

export default function Main({ onOpenSettings }: { onOpenSettings: () => void }) {
  const bootstrap = useAuthStore((s) => s.bootstrap)
  const logout = useAuthStore((s) => s.logout)
  const conversations = useChatStore((s) => s.conversations)
  const projects = useChatStore((s) => s.projects)
  const activeId = useChatStore((s) => s.activeId)
  const activeProjectId = useChatStore((s) => s.activeProjectId)
  const collapsedProjects = useChatStore((s) => s.collapsedProjects)
  const [showNewProject, setShowNewProject] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [projectPath, setProjectPath] = useState('')
  // ...其余现有 state/引用不变(messages/artifacts/interrupted/streaming 等)
  const { newConversation, loadConversations, selectConversation, deleteConversation, loadProjects, createProject, deleteProject, moveConversation, setActiveProject, toggleProjectCollapsed } = useChatStore.getState()

  useEffect(() => {
    void loadConversations()
    void loadProjects()
    void useChatStore.getState().checkInterrupted()
    const off = window.picoaide.onInterrupted((list) => useChatStore.getState().onInterrupted(list))
    return () => off()
  }, [loadConversations, loadProjects])

  const pickProjectDir = async () => {
    const dirs = await window.picoaide.pickDirectory()
    if (dirs && dirs.length > 0) setProjectPath(dirs[0])
  }

  const handleCreateProject = async () => {
    if (!projectName.trim() || !projectPath.trim()) return
    const id = await createProject({ name: projectName.trim(), path: projectPath.trim() })
    setActiveProject(id)
    setShowNewProject(false)
    setProjectName('')
    setProjectPath('')
  }

  const handleDeleteProject = async (id: number) => {
    await deleteProject(id)
    await loadProjects()
  }

  const conversationsOf = (projectId: number | null) =>
    conversations.filter((c) => (projectId === null ? c.project_id == null : c.project_id === projectId))

  const renderConversationRow = (c: { id: number; title: string }) => (
    <div
      key={c.id}
      className={cn(
        'group ml-4 mb-1 flex cursor-pointer items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-accent',
        c.id === activeId && 'bg-accent'
      )}
      onClick={() => void selectConversation(c.id)}
    >
      <span className="truncate">{c.title || '新会话'}</span>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-6 w-6" title="移动到项目">
              <FolderPlus className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => void moveConversation(c.id, null)}>未分类</DropdownMenuItem>
            {projects.map((p) => (
              <DropdownMenuItem key={p.id} onClick={() => void moveConversation(c.id, p.id)}>
                {p.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          title="删除会话"
          onClick={(e) => {
            e.stopPropagation()
            void deleteConversation(c.id)
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )

  const renderProjectGroup = (p: ProjectView) => {
    const collapsed = collapsedProjects.includes(p.id)
    const items = conversationsOf(p.id)
    return (
      <div key={p.id} className="mb-1">
        <div
          className={cn(
            'group flex cursor-pointer items-center justify-between rounded-md px-3 py-2 text-sm font-medium hover:bg-accent',
            activeProjectId === p.id && 'bg-accent'
          )}
          onClick={() => {
            setActiveProject(p.id)
            toggleProjectCollapsed(p.id)
          }}
        >
          <span className="flex min-w-0 items-center gap-1">
            {collapsed ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
            <span className="truncate">{p.name}</span>
          </span>
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              title="删除项目(会话移入未分类,不删文件)"
              onClick={(e) => {
                e.stopPropagation()
                void handleDeleteProject(p.id)
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        {!collapsed && items.map(renderConversationRow)}
      </div>
    )
  }

  // JSX:aside 顶部按钮区、项目分组区、未分类区、底部设置/退出按钮
  return (
    <div className="flex h-screen flex-col">
      {connStatus === 'offline' && (...同现有)}
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-60 flex-col border-r bg-muted/20">
          <div className="flex gap-2 p-3">
            <Button className="flex-1" onClick={() => void newConversation()}>
              <Plus className="h-4 w-4" /> 新建会话
            </Button>
            <Button variant="outline" className="flex-1" onClick={() => setShowNewProject(true)}>
              <FolderPlus className="h-4 w-4" /> 新建项目
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto px-2 pb-2">
            {projects.map(renderProjectGroup)}
            <div className="mb-1 mt-2 px-3 py-1 text-xs text-muted-foreground">未分类</div>
            {conversationsOf(null).map(renderConversationRow)}
          </div>
          <div className="border-t p-3">
            <Button variant="ghost" className="w-full justify-start text-muted-foreground" onClick={onOpenSettings}>
              <SettingsIcon className="h-4 w-4" /> 设置
            </Button>
            <Button variant="ghost" className="mt-1 w-full justify-start text-muted-foreground" onClick={() => void logout()}>
              <LogOut className="h-4 w-4" /> 退出登录
            </Button>
          </div>
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">(同现有,header 显示 activeProject 名 + modelName)</main>
      </div>
      {interrupted.length > 0 && (...同现有)}
      <Dialog open={showNewProject} onOpenChange={setShowNewProject}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建项目</DialogTitle>
            <DialogDescription>项目 = 命名的工作目录,其下会话的文件操作都发生在该目录中</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>项目名称</Label>
              <Input value={projectName} placeholder="如:月度报表" onChange={(e) => setProjectName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>工作目录</Label>
              <div className="flex gap-2">
                <Input value={projectPath} readOnly placeholder="请选择项目目录" />
                <Button variant="outline" onClick={() => void pickProjectDir()}>浏览…</Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNewProject(false)}>取消</Button>
            <Button disabled={!projectName.trim() || !projectPath.trim()} onClick={() => void handleCreateProject()}>
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmModal />
    </div>
  )
}
```

注意:Main.tsx 需要新 IPC `pickDirectory`(主进程 `dialog.showOpenDialog`)。Step 4 补。

- [ ] **Step 4: preload/index.ts + ipc.ts 加 pickDirectory**

`desktop/src/main/ipc.ts`(AuthHandlers 或独立)+ `preload`:

```ts
  'dialog:pickDirectory': () => Promise<string[]>
```

ipc.ts 实现(在 buildHandlers 或 buildAgentHandlers 均可;放 `buildAgentHandlers` 返回):

```ts
    'dialog:pickDirectory': async () => {
      const win = deps.getWindow()
      if (!win) return []
      const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
      return result.canceled ? [] : result.filePaths
    },
```

(顶部 `import { dialog } from 'electron'`。)

preload:

```ts
  pickDirectory: (): Promise<string[]> => ipcRenderer.invoke('dialog:pickDirectory'),
```

ConversationRow 需加 `project_id` 字段(ipc.ts 顶部接口 + preload 类型随动):

```ts
export interface ConversationRow {
  id: number
  ...
  workspace: string
  project_id: number | null
  ...
}
```

store/conversations.ts 的 `listConversations`/`getConversation` 返回行自带 project_id(SELECT * 已含),renderer `ChatMessage`/分组判断用 `c.project_id`。

- [ ] **Step 5: 验证**

Run: `cd desktop && npm test && npm run typecheck`
Expected: 全绿(renderer 无组件测试,依赖 typecheck + 手动运行 `npm run dev` 验证:新建项目→选目录→建会话→文件落在项目目录;设置入口可达)

- [ ] **Step 6: Commit**

```bash
git add desktop/src/renderer/src/App.tsx desktop/src/renderer/src/pages/Main.tsx desktop/src/renderer/src/pages/Settings.tsx desktop/src/main/ipc.ts desktop/src/preload/index.ts desktop/src/main/store/conversations.ts
git commit -m "feat: project sidebar groups, settings entry, directory picker"
```

### Task 3.2: ChatInput - / 命令、@ 提及、自动增高、历史找回

**Files:**
- Modify: `desktop/src/renderer/src/components/ChatInput.tsx`
- Create: `desktop/src/renderer/src/lib/chatbox.ts`(纯逻辑,可测)
- Test: `desktop/src/renderer/src/lib/chatbox.test.ts`

- [ ] **Step 1: 写失败测试(纯函数)**

```ts
// desktop/src/renderer/src/lib/chatbox.test.ts
import { describe, expect, it } from 'vitest'
import { parseCommandLine, parseMentionLine } from './chatbox'

describe('parseCommandLine', () => {
  it('首字符 / 且有内容时返回命令行状态', () => {
    expect(parseCommandLine('使用', ['技能A', '技能B'])).toBeNull()
    expect(parseCommandLine('/', ['技能A', '技能B'])).toEqual({ kind: 'command', query: '', items: ['技能A', '技能B'] })
    expect(parseCommandLine('/技', ['技能A', '技能B'])).toEqual({ kind: 'command', query: '技', items: ['技能A'] })
    expect(parseCommandLine('/技能A 之后', ['技能A'])).toBeNull() // 命中后继续输入 → 关闭
  })
})

describe('parseMentionLine', () => {
  const files = ['/p/a.md', '/p/b.txt']
  const skills = ['s1', 's2']
  it('行尾 @ 或 @查询 时返回提及候选', () => {
    expect(parseMentionLine('帮我读', files, skills)).toBeNull()
    expect(parseMentionLine('帮我读 @', files, skills)).toEqual({
      kind: 'mention', query: '', files: ['/p/a.md', '/p/b.txt'], skills: ['s1', 's2'],
    })
    expect(parseMentionLine('帮我读 @a', files, skills)).toEqual({
      kind: 'mention', query: 'a', files: ['/p/a.md'], skills: ['s1', 's2'],
    })
    expect(parseMentionLine('帮我读 @s1 吧', files, skills)).toBeNull() // @ 不在行尾
  })
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `cd desktop && npm test -- chatbox.test.ts`
Expected: FAIL(`Cannot find module './chatbox'`)

- [ ] **Step 3: 实现 lib/chatbox.ts**

```ts
export interface CommandLine {
  kind: 'command'
  query: string
  items: string[]
}

export interface MentionLine {
  kind: 'mention'
  query: string
  files: string[]
  skills: string[]
}

export type ChatboxLine = CommandLine | MentionLine | null

// 输入行含未完成的 /命令(仅当斜杠命中项且光标在末尾时算“进行中”)
export function parseCommandLine(value: string, items: string[]): ChatboxLine {
  if (!value.startsWith('/')) return null
  const trimmed = value.trim()
  if (trimmed.length === 1) return { kind: 'command', query: '', items }
  const query = trimmed.slice(1)
  const matched = items.filter((i) => i.toLowerCase().includes(query.toLowerCase()))
  if (matched.length === 0) return null
  return { kind: 'command', query, items: matched }
}

// 行尾 @ 或 @查询 时返回提及候选(查询同时匹配文件名与技能名)
export function parseMentionLine(value: string, files: string[], skills: string[]): ChatboxLine {
  const m = /@([^\s]*)$/.exec(value)
  if (!m) return null
  const query = m[1].toLowerCase()
  return {
    kind: 'mention',
    query,
    files: files.filter((f) => f.toLowerCase().includes(query)),
    skills: skills.filter((s) => s.toLowerCase().includes(query)),
  }
}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `cd desktop && npm test -- chatbox.test.ts`
Expected: PASS(3 tests)

- [ ] **Step 5: ChatInput.tsx 改造**

```tsx
import { useEffect, useRef, useState } from 'react'
import { FileText, Square, Send, Sparkles } from 'lucide-react'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { cn } from '../lib/utils'
import { useChatStore, type Mode } from '../stores/chat'
import { useAuthStore } from '../stores/auth'
import { parseCommandLine, parseMentionLine, type ChatboxLine } from '../lib/chatbox'

const MODES: { id: Mode; label: string; available: boolean }[] = [
  { id: 'ask', label: 'Ask', available: true },
  { id: 'plan', label: 'Plan', available: true },
  { id: 'craft', label: 'Craft', available: true },
]

const MAX_ROWS = 8

export default function ChatInput() {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<string[]>([])
  const [historyIdx, setHistoryIdx] = useState(-1)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const streaming = useChatStore((s) => s.streaming)
  const mode = useChatStore((s) => s.mode)
  const setMode = useChatStore((s) => s.setMode)
  const sendMessage = useChatStore((s) => s.sendMessage)
  const cancel = useChatStore((s) => s.cancel)
  const approvePlan = useChatStore((s) => s.approvePlan)
  const loadConversations = useChatStore((s) => s.loadConversations)
  const activeId = useChatStore((s) => s.activeId)
  const activeProjectId = useChatStore((s) => s.activeProjectId)
  const conversations = useChatStore((s) => s.conversations)
  const bootstrap = useAuthStore((s) => s.bootstrap)
  const [files, setFiles] = useState<string[]>([])
  // 已装技能(从设置页清单服务读取;渲染期一次)
  const [installedSkills, setInstalledSkills] = useState<string[]>([])
  const activeStatus = activeId === null ? null : (conversations.find((c) => c.id === activeId)?.status ?? null)
  const planning = activeStatus === 'planning' && !streaming

  // @ 文件候选:活动项目 workspace 文件(懒加载一次)
  useEffect(() => {
    if (activeProjectId === null) return
    void window.picoaide.workspaceListFiles([]).then(setFiles).catch(() => setFiles([]))
  }, [activeProjectId])

  // 已装技能列表(plugin 清单,含 installed 映射)
  useEffect(() => {
    void window.picoaide.skillsList().then((r) => setInstalledSkills(Object.keys(r.installed))).catch(() => setInstalledSkills([]))
  }, [])

  const commandItems = (bootstrap?.skills ?? []).map((s) => s.name)
  const line = value.trim() === '' ? null : parseCommandLine(value, commandItems) ?? parseMentionLine(value, files, installedSkills)

  const applySuggestion = (l: ChatboxLine, text: string) => {
    if (!l) return
    if (l.kind === 'command') {
      setValue(`使用技能 ${text}:`)
    } else {
      // 替换行尾 @查询
      const base = value.replace(/@[^\s]*$/, '')
      setValue(`${base}@${text} `)
    }
    textareaRef.current?.focus()
  }

  const send = () => {
    const text = value.trim()
    if (!text) return
    setHistory((h) => [...h, text].slice(-20))
    setHistoryIdx(-1)
    setValue('')
    void sendMessage(text)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (line && line.kind === 'command' && line.items[0]) {
        applySuggestion(line, line.items[0])
        return
      }
      send()
      return
    }
    if (e.key === 'ArrowUp' && !e.shiftKey && value === '' && history.length > 0) {
      e.preventDefault()
      const idx = historyIdx === -1 ? history.length - 1 : Math.max(0, historyIdx - 1)
      setHistoryIdx(idx)
      setValue(history[idx])
      return
    }
    if (e.key === 'ArrowDown' && historyIdx !== -1) {
      e.preventDefault()
      if (historyIdx === history.length - 1) {
        setHistoryIdx(-1)
        setValue('')
      } else {
        setHistoryIdx(historyIdx + 1)
        setValue(history[historyIdx + 1])
      }
    }
  }

  const autoResize = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, MAX_ROWS * 24) + 'px'
  }

  const suggestions = line
    ? line.kind === 'command'
      ? line.items.map((i) => ({ id: `cmd-${i}`, text: i, icon: <Sparkles className="h-3.5 w-3.5" /> }))
      : [
          ...line.files.map((f) => ({ id: `f-${f}`, text: f, icon: <FileText className="h-3.5 w-3.5" /> })),
          ...line.skills.map((s) => ({ id: `s-${s}`, text: s, icon: <Sparkles className="h-3.5 w-3.5" /> })),
        ]
    : []

  return (
    <div className="border-t bg-background px-4 py-3">
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        <div className="flex items-center gap-1">
          {MODES.map((m) => (
            <Button
              key={m.id}
              type="button"
              size="sm"
              variant={mode === m.id ? 'default' : 'ghost'}
              disabled={!m.available}
              title={m.available ? undefined : '即将推出'}
              onClick={() => setMode(m.id)}
            >
              {m.label}
            </Button>
          ))}
        </div>
        {planning ? (
          <div className="flex items-center justify-center gap-3 rounded-md border bg-muted/30 px-3 py-3">
            <span className="text-sm text-muted-foreground">计划已生成,确认后开始执行</span>
            <Button size="sm" disabled={busy} onClick={() => void onApprove(true)}>执行计划</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void onApprove(false)}>取消</Button>
          </div>
        ) : (
          <div className="relative">
            {line && suggestions.length > 0 && (
              <div className="absolute bottom-full left-0 z-10 mb-1 max-h-48 w-full overflow-y-auto rounded-md border bg-background shadow-md">
                {suggestions.map((s) => (
                  <button
                    key={s.id}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
                    onClick={() => applySuggestion(line, s.text)}
                  >
                    {s.icon}
                    <span className="truncate">{s.text}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2">
              <Textarea
                ref={textareaRef}
                value={value}
                rows={2}
                placeholder="输入消息,Enter 发送,Shift+Enter 换行;/ 使用技能,@ 提及文件或技能"
                className="resize-none overflow-hidden"
                onChange={(e) => {
                  setValue(e.target.value)
                  autoResize(e.target)
                }}
                onKeyDown={onKeyDown}
              />
              {streaming ? (
                <Button type="button" variant="outline" size="icon" title="停止" onClick={() => void cancel()}>
                  <Square className="h-4 w-4" />
                </Button>
              ) : (
                <Button type="button" size="icon" disabled={!value.trim()} onClick={send} title="发送">
                  <Send className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
```

注意:
- `window.picoaide.skillsList` 与 `workspaceListFiles` 需在 preload 暴露(plugin_ipc 已有 `pluginSkillsList` 于 `pluginApi()`;检查 preload 的 plugin 命名空间——若 plugin 方法挂在 `window.picoaide.pluginSkillsList` 则 ChatInput 直接调用,不需新 IPC;`workspaceListFiles` 走 `roots: []` 时主进程枚举 allowedDirs + 活动项目目录,见 Step 6)。
- onApprove 保留现有实现。

- [ ] **Step 6: workspace:listFiles 空 roots 语义 + preload plugin 暴露**

`desktop/src/main/ipc.ts` 的 `workspace:listFiles` 改为(roots 为空 → 枚举全部可访问目录 + 活动项目 workspace):

```ts
    'workspace:listFiles': ({ roots }) => {
      const dirs = roots.length > 0 ? roots : deps.listAllowedDirs?.() ?? []
      // 安全边界:只枚举可访问目录内的路径
      const ok = dirs.filter((d) => isAllowed(d, deps.listAllowedDirs?.() ?? []))
      return listFilesRecursive(ok.length > 0 ? ok : deps.listAllowedDirs?.() ?? [])
    },
```

`AgentIpcDeps` 加 `listAllowedDirs?: () => string[]`;index.ts 提供:

```ts
      listAllowedDirs: () => resolveAllowedDirs(workspaceDir(), getAllowedDirsFromSettings((k) => getSetting(db, k))),
```

`AgentIpcDeps` 加 `activeWorkspace?: () => string | null`(ChatInput 传 activeProjectId 对应 project path 更精确,但为最小改动:renderer 侧 `window.picoaide.workspaceListFiles([])` 即枚举所有可访问目录,涵盖项目目录——项目路径在可访问目录内吗?项目目录是用户选的任意目录,不在 allowedDirs 内!所以空 roots 枚举可访问目录**不含项目目录**。修正:ChatInput 需要项目 path → renderer 的 chat store 已有 `projects`(含 path),取 `projects.find(p => p.id === activeProjectId)?.path` 传入 roots:

```ts
    void window.picoaide
      .workspaceListFiles(activeProject ? [activeProject.path] : [])
      .then(setFiles)
      .catch(() => setFiles([]))
```

但 `workspace:listFiles` 主进程校验 `isAllowed` 会拒绝项目目录!改为:roots 非空时校验**只读校验**(允许任意用户指定目录?不安全)。折衷:roots 传项目路径时,校验改为「roots 内目录或其父级已在 allowedDirs」?不行。
务实方案:`workspace:listFiles` 由主进程计算:roots = [项目 workspace(若会话属于项目)] ∪ allowedDirs,不做任意路径。renderer 不传 roots(空),主进程自行组装:`deps.listAllowedDirs()` + `deps.activeProjectPath?.()`。ChatInput 只调 `workspaceListFiles([])`,返回 项目文件 + 可访问目录文件。安全边界:主进程只枚举自己组装的目录,renderer 不能任意指定。

`desktop/src/main/index.ts` 加:

```ts
      activeProjectPath: () => {
        const session = getCurrentSession()
        void session
        // 从 store 取不到“活动项目”(活动状态在 renderer);改为:枚举全部项目目录
        return null
      },
```

更简单:**枚举所有项目 path**(列表本身小):

```ts
      listProjectPaths: () => listProjects(db).map((p) => p.path),
```

`workspace:listFiles` 实现:

```ts
    'workspace:listFiles': () => {
      const allowed = deps.listAllowedDirs?.() ?? []
      const projectDirs = deps.listProjectPaths?.() ?? []
      const dirs = [...projectDirs, ...allowed]
      return listFilesRecursive(dirs)
    },
```

(目录不存在时 listFilesRecursive 的 readdirSync catch 静默跳过,天然安全。)preload:

```ts
  workspaceListFiles: (): Promise<string[]> => ipcRenderer.invoke('workspace:listFiles'),
```

ChatInput 调用 `window.picoaide.workspaceListFiles()`(无参)。

`skillsList`:检查 preload 是否已暴露 plugin 方法。若无,preload 加:

```ts
  skillsList: (): Promise<{ suggestions: SkillsListResult['suggestions']; installed: Record<string, { version: string }> }> =>
    ipcRenderer.invoke('plugin:skills:list'),
```

(检查 plugin_ipc.ts 的实际 channel 名,保持一致;若 `pluginApi()` 在 preload 的 plugin 命名空间,则 `window.picoaide.pluginSkillsList()` 直接用。)

- [ ] **Step 7: 验证 + Commit**

Run: `cd desktop && npm test && npm run typecheck`
Expected: 全绿

```bash
git add desktop/src/renderer/src/components/ChatInput.tsx desktop/src/renderer/src/lib/chatbox.ts desktop/src/renderer/src/lib/chatbox.test.ts desktop/src/main/ipc.ts desktop/src/main/index.ts desktop/src/preload/index.ts
git commit -m "feat: chatbox slash commands, mentions, autoresize, history"
```

---

## Phase 4: 收尾

### Task 4.1: 文档同步(AGENTS.md + 架构设计 + 本计划勾选)

**Files:**
- Modify: `AGENTS.md`(§7 契约:客户端 5 表、新增 IPC、Portable 模式说明)
- Modify: `docs/superpowers/specs/2026-08-01-picoaide-next-architecture-design.md`(§DB 模型补 projects 表,Portable 数据目录)

- [ ] **Step 1: AGENTS.md §7 更新**

客户端 DB:4 表 → 5 表(conversations/messages/artifacts/settings/projects);新增契约:项目 workspace 语义、`portable.txt` 标记、自动标题(LLM 后台生成,≤20 字,失败截取兜底)。

- [ ] **Step 2: 架构设计文档补 §DB 模型**

projects 表 DDL 与 project_id 列;数据目录章节补 Portable 分支。

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md docs/superpowers/specs/2026-08-01-picoaide-next-architecture-design.md
git commit -m "docs: projects/portable/autotitle contracts"
```

### Task 4.2: 全量验证

- [ ] **Step 1: 服务端测试**

Run: `make test`
Expected: 全绿(客户端改动不涉及服务端,确认无意外影响)

- [ ] **Step 2: 客户端测试 + 类型检查**

Run: `cd desktop && npm test && npm run typecheck`
Expected: 全绿

- [ ] **Step 3: 生产构建**

Run: `make build-client`
Expected: electron-vite 构建成功,`desktop/out/` 生成

- [ ] **Step 4: 手动冒烟(dev 模式)**

Run: `cd desktop && npm run dev`
手工验证:
1. 侧边栏:新建项目 → 浏览选目录 → 项目出现;项目下新建会话
2. 项目内会话发送 craft 消息,工具产物落在 `<项目目录>/<会话id>/`
3. 首轮对话完成 ~15s 内标题自动更新(网关在线)
4. 会话 hover → 移动到其他项目/未分类
5. 设置入口可达,技能/MCP 清单展示与安装
6. ChatInput:`/` 弹出技能列表、`@` 弹出文件/技能、textarea 自动增高、↑ 找回历史
7. Portable(Windows/Linux):解压打包产物,exe 同目录生成 data 文件夹(首次运行),picoaide.db 与 workspaces 在其中
8. macOS(有环境时):dmg 拖入 Applications 启动正常,数据落 `~/Library/Application Support/picoaide`;Cmd+,/Cmd+N 生效;深色模式跟随系统

- [ ] **Step 5: Commit(若有冒烟修复)**

```bash
git add -A
git commit -m "fix: smoke test adjustments"
```

---

## 自审记录

- **Spec 覆盖**:spec 每节 → 任务映射:数据模型 §3 → Task 1.1/1.2;IPC §4.2 → Task 1.3/1.4;引擎注入 §4.3 → Task 1.4;自动标题 §4.4 → Task 2.1/2.2;路由 §5.1 → Task 3.1;侧边栏 §5.2 → Task 3.1;chat store §5.3 → Task 1.5;ChatInput §5.4 → Task 3.2;Portable(用户新增需求)→ Task 0.1/0.2;文档 §8 → Task 4.1。边界约束(文档走服务端 MCP、不本地同步)→ 无新代码,设计文档已声明,无任务(现状即满足)。
- **占位符扫描**:无 TBD/TODO;每步含代码。
- **类型一致性**:`ProjectRow`(store)→ `{id,name,path,created_at}`(ipc/preload 对齐);`workspaceFor(projectPath, conversationId)`;`getTools(workspace?: string)`;`autoTitle({conversationId})`;preload `workspaceListFiles()` 无参(主进程自组装目录)。
