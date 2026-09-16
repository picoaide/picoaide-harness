# dsh-memory-evolve vendored 说明

本目录是桌面产品的**本地插件**：`packages/host/desktop/package.json` 以 workspace 依赖
（`"dsh-memory-evolve": "workspace:*"`）引用本包，随三平台安装包一起分发，运行期不从
GitHub 拉取。上游是第三方仓库，本地按「上游变更 → 三方合并 → 本地加固保留」的方式维护。

## 来源与当前基线

- 上游仓库：https://github.com/csyangwen/dsh-memory-evolve
- **当前基线：`c337dc1a`（tag `v26091501`，2026-09-15）**；2026-09-16 从 `b4994fa`
  （tag `v26090901`，2026-09-09）升级。上一版基线说明见本文件历史（提交 `8c20bc0c0b`）。
- 上游把 `lib/` 作为发布产物提交：**node 侧 JS 直接写在 `lib/`**（我们的改动也落在这里），
  浏览器 bundle `lib/client.js` 由 `scripts/build.mjs` 从 `src/client/**` 用 esbuild 生成。
  **不要在本目录跑 `scripts/build.mjs`**：它会用 `src/client/**` 重建 `lib/client.js`，把本地
  补丁（mermaid subgraph 标题去重）覆盖掉；改了 client 侧就必须手动同步 `src/` 与 `lib/client.js`。
- 上游 remote 也配置在本仓库（`git remote -v` 里的 `dsh-memory-evolve`），但**合并按下面的
  三方流程做**，不要在桌面包分支上直接 `git merge` 上游历史（会把上游的 `lib/` 覆盖本地加固）。

## 升级流程（后续按上游代码变更合并）

```bash
# 0. 选目标 tag：git ls-remote --tags https://github.com/csyangwen/dsh-memory-evolve
git clone --quiet https://github.com/csyangwen/dsh-memory-evolve.git /tmp/me-merge
cd /tmp/me-merge

# 1. base = 本文件记录的旧基线 commit；ours = 本目录现状
git checkout --detach <旧基线 commit>
find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -a <repo>/packages/vendor/memory-evolve/. .
rm -f VENDORED.md
git add -A && git commit -m "local: vendored state"

# 2. 合并上游新版本；冲突逐个收口（判据：上游语义 + 本地断言都要留）
git merge <新 tag 的 commit>

# 3. 落回本目录（保留 VENDORED.md 这份说明）
cd <repo>/packages/vendor/memory-evolve
find . -mindepth 1 -maxdepth 1 ! -name VENDORED.md -exec rm -rf {} +
cp -a /tmp/me-merge/. . && rm -rf .git

# 4. 验证
HOME=<可写目录且有 init.defaultBranch=main> node --test 'tests/*.test.js'
node <repo>/scripts/verify-inventories.mjs && node <repo>/scripts/verify-layout.mjs \
  && node <repo>/scripts/check-theme-tokens.mjs
```

合并后的自查口径（本轮实测有效）：对上游改过的每个文件，`git diff <ours> <merge> -- <file>`
的增删行应当**恰好等于** `git diff <旧基线> <新 tag> -- <file>`；不等就说明本地改动被吞了
（本轮 `--theirs` 整文件取上游时吞掉过 `lib/advisor/index.js` 的 FIX-27，靠这条查出来）。

## 本地差异（升级后必须逐项核对）

### A. 兼容 / 环境补丁（2026-09-11 那批）

1. **`package.json`**：`dsh.client.inject` 改为 `@deepseek-ai/dsh-client-store`
   （桌面宿主 DSH 导出名与上游 `dsh-client-runtime` 不同，提交 `346fdfb017`）。
2. **`lib/skills-manager.js`**：`/skills-manager` 路由加本地信任栅栏（F6 审计：此前没有
   任何本地信任边界）。除 loopback socket+Host+Origin 外，支持 `webRuntime.trustedHosts`
   中已声明的局域网权威（`dsh web --host 0.0.0.0` 模式），伪造 loopback Host 仍拒绝。
3. **`lib/skills.js`**：技能采纳的 Windows `EBUSY/EPERM/EACCES/ENOTEMPTY` 降级为
   复制+删除，且**合并语义**（不覆盖目标目录既有用户数据），提交 `b81b62d174`/`a26191b9b7`。
4. **`lib/api.js`**：pending-skills approve 路由把文件系统错误包装为友好提示（不抛原始堆栈）。
5. **`src/client/mermaid-render.ts` + `lib/client.js`**：subgraph 标题正则去重（提交 `f8fd905d49`）。
6. **`lib/sync/{repo,identity,index,worker}.js`**：git 子进程统一 `LC_ALL=C LANG=C`。中文
   locale 下 git 输出「无法找到远程引用」会让 worker 的英文正则 `couldn't find remote ref`
   失配，把「远端分支不存在 / 首次推送」误报为致命拉取错误（本环境实测复现并修复）。
7. **`tests/search-docs.test.js`**：平台断言自适应（`/Volumes`、`mdfind` 优先序、provider 链）
   在非 darwin 环境跳过/放宽，不让测试套件依赖 mac 物理机。
8. **`tests/advisor-api.test.js`**：把「等 drain」的固定 `setTimeout(20)` 改为按 records 落盘
   条件的轮询（`waitForAdvisor`），全量并发跑时不再 flaky。
9. **`tests/skills.test.js` / `tests/skills-fault.test.js` / `tests/fixtures/`**：Windows 修复的回归。

### B. 安全加固（2026-09-12 ~ 09-14，R1–R6 审计批次；**最大的一块，44 个 `lib/` 文件**）

- **HTTP 同源守卫唯一实现**：新增 `lib/http-guard.js`；`lib/api.js`、`lib/coi/*`、
  `lib/advisor/api.js`、`lib/memory-tab.js`、`lib/notify-web.js`、`lib/coi/broadcast-api.js`、
  `lib/skills-manager.js` 等全部本地 HTTP 面挂上「只读放行、写操作要求同源 + JSON 体」的前置
  守卫（加固前 28+ 端点无同源校验）。
- **写落点断言（符号链接写穿 / TOCTOU）**：`lib/sync/filesets.js` 的自锚定原子写原语
  （临时落点断言 + `O_EXCL` 按 fd 写 + rename 前后复检 + 受管仓库根基准）；同步写回（含
  runSync 三路合并路径）、归档/备份/状态文件/advisor records/固定名侧车文件全部改走它。
- **读侧断言**：归档 `entriesOf`、memory-tab 读取、迁移路径遇到符号链接/越界时 fail-loud。
- **其余**：归档锁域一致性、EPERM 抢活锁、同步冲突路径逃逸、深链严格模式等。
- 主仓提交：`910b1adbd3`、`a2bb757e9f`、`62c9c0793e`、`dca9bdd96e`、`31dc7c55a7`、
  `ed7898cd1c`、`9d03d757dd`、`470692e230`；报告见 `docs/AUDIT-*.md`。

### C. 本地独有回归测试（17 个文件 + `tests/fixtures/`）

`advisor-records-landing-symlink`、`advisor-shared-guard-parity`、`api-same-origin-guard`、
`api-sibling-guards`、`archive-lock-symlink-writeback`、`backup-bak-timestamp-landing-symlink`、
`coi-skill-landing-unasserted-write`、`memory-tab-read-symlink`、`migration-symlink-outside-fence`、
`skills-fault`、`state-file-symlink-landing-policy`、`store-lock-invariants`、
`sync-conflict-pathescape`、`sync-provenance-tmp-landing-symlink`、`sync-symlink-writeback`、
`tmp-landing-sweep-symlink-fence`、`write-target-symlink-toctou`（均 `.test.js`）。

## 本次升级（`b4994fa` → `c337dc1a`）拿到了什么

| 上游提交 | 内容 | 落地文件 |
|---|---|---|
| `c337dc1` | **记忆正文被同步链路损坏成 U+FFFD 的根因**：`runGit()` 用裸 `String(chunk)` 逐块解码，跨 32 KiB 管道边界的汉字被切成 `�` 并逐轮累积（格式预检还照过）；同款问题另有 worker stdout、文档检索、COI 任务日志三处 | `lib/sync/repo.js`、`lib/sync/index.js`、`lib/search-docs.js`、`lib/coi/scheduler.js`（统一改 `setEncoding('utf8')` 流式解码） |
| `db51fb8` | issue #53：记忆正文里的字面量 `{{...}}` 让宿主提示词渲染器 throw、会话每轮起不来 → 整段快照统一净化（记忆轨只降级不展开）；issue #49：advisor 适配 `Session.ownEvents` | `lib/index.js`、`lib/prompts.js`、`lib/advisor/index.js` |
| `d23bae6` + `8cdcfac` | 收尾规则改两步式（本条消息只发写入工具调用 → 下一条输出完整回复），配合 compact 视图高亮 | `lib/prompts.js`、`lib/i18n.js` |
| `ba5ddee` + `147f776` | 新内置技能 `memory-consolidate`（记忆合并梳理，带零依赖只读预扫脚本） | `skills/memory-consolidate/{SKILL.md,scripts/scan_memory.mjs}` |
| `d459730` | 文案 / CHANGELOG | `docs/*`、`README-详细说明.md` |
| 上游测试 | `tests/sync-utf8-stream.test.js`（14 例，注入假 spawn 覆盖每个分块切点）、`tests/skill-memory-consolidate.test.js` | 随包 |

**合流记录（两处冲突，判据＝两边语义都留）**

1. `lib/coi/skills-sync.js`：上游把技能同步从「只写 `SKILL.md`」改成**整目录覆盖**（辅助文件随
   技能一起走，`memory-consolidate/scripts/` 就靠它），本地 NF-1 要求落点断言。合流后：目标目录
   先清空再重铺（上游语义），但 ①目标不是真实目录、②目录内任何符号链接条目、③逐文件自锚定原子写
   （TOCTOU 复检）三条断言一律 fail-loud 并记 `refused` —— **预置链接是拒收而不是静默删除**
   （上游的 `rm -rf` 会把链接「顺带删掉」，等于把拒收变成静默成功，本地回归
   `tests/coi-skill-landing-unasserted-write.test.js` 钉住这条）。
2. `lib/advisor/index.js`：上游的 issue #49 三档兜底 `ownEvents?.() ?? events ?? []` 覆盖了本地
   先行修复（本地缺 `?? []`）→ 取上游实现，同时保留本地 `FIX-27` 原子写加固。

## 验证

- 插件自带测试：**931 pass / 0 fail**（`HOME=<可写目录> node --test 'tests/*.test.js'`）。
  - 两个环境坑（本轮都踩到）：① `HOME` 必须可写，否则插件往 `$HOME/.dsh` 写状态 → `EROFS` 假红；
    ② 覆盖 `HOME` 后 git 读不到全局配置，`init.defaultBranch=main` 丢失 → `tests/update.test.js`
    的 `git push origin main` 全失败（81 例假红）。工作区内可复现姿势：`temp/me-home/`（含
    `.gitconfig` 与 `.config/`）。
- 根守卫：`verify-inventories`、`verify-layout`、`check-theme-tokens` 全绿（本次未动 CSS，幻影
  token 映射表不受影响）。
- 桌面侧：`packages/host/desktop` 的 `tests/legacy-theme-tokens.spec.ts` 3/3 通过（唯一引用本包
  CSS 的宿主测试）。
