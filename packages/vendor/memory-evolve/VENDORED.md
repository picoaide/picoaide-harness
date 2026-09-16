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
  **改了 client 侧（`src/client/**`）必须重建 `lib/client.js`，两者一起提交**：运行期加载的是
  `lib/client.js`，只改 `src/` 不会生效。重建需要 esbuild —— 上游脚本从 DSH checkout 解析
  （`$DSH_SOURCE`，缺省 `~/.dsh/source/current`，见 `scripts/build.mjs:53-65`）。本机可复现姿势：
  任何带 esbuild 的 node_modules 都能喂给它，例如
  `DSH_SOURCE=<临时目录> node scripts/build.mjs`（临时目录下 `node_modules/esbuild` 软链到一份真实安装）。
  实测 esbuild 0.28.1 重建产物 = 上游入库产物 **+ 唯一的 mermaid 去重改动**（逐字节可复现，
  无重排噪声）；版本不同可能触发 `text loader` 的引号格式切换（约 2150 行重排，见脚本 77-84 行注释）。
  历史上这里踩过一次：`f8fd905d49`（2026-08-31 的去重补丁）**只改了 `src/`、没重建 bundle**，
  于是入库的 `lib/client.js` 与上游逐字节相同、补丁从未生效（语义等价所以无人发现）——2026-09-16
  重建后才真正落地。
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
5. **`src/client/mermaid-render.ts` + `lib/client.js`**：subgraph 标题字符类去重
   （提交 `f8fd905d49`）。**勘误（2026-09-16）**：该提交当时只改了 `src/`，`lib/client.js`
   与上游逐字节相同 ⇒ 补丁从未进入运行期产物（字符类去重语义等价，所以没有可观察影响）。
   2026-09-16 重建 bundle 后两边一致；此后改 client 侧必须重建（见上文"来源与当前基线"）。
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

### C. 本地独有回归测试（22 个文件 + `tests/fixtures/`）

`advisor-records-landing-symlink`、`advisor-shared-guard-parity`、`api-same-origin-guard`、
`api-sibling-guards`、`archive-lock-symlink-writeback`、`backup-bak-timestamp-landing-symlink`、
`coi-skill-landing-unasserted-write`、`memory-tab-read-symlink`、`migration-symlink-outside-fence`、
`skills-fault`、`state-file-symlink-landing-policy`、`store-lock-invariants`、
`sync-conflict-pathescape`、`sync-provenance-tmp-landing-symlink`、`sync-symlink-writeback`、
`tmp-landing-sweep-symlink-fence`、`write-target-symlink-toctou`（均 `.test.js`）；
2026-09-16 新增 5 个：`state-corruption-failsoft`、`advisor-lazy-dirs`、`tool-param-contract`、
`client-locale-follow`、`advisor-prompt-locale`、`i18n-dictionary-integrity`
（**注**：§A.9 的 `skills-fault` 与本清单重复登记，历史上造成了"17 vs 18"的口径差）。

### D. 2026-09-16 本地修复批（P1 启动级 + 参数契约 + i18n，全部带回归）

| # | 修复 | 落地 | 回归 |
|---|---|---|---|
| D1 | **`plugin-state.json` 损坏 = 整个桌面应用起不来**（启动级）：`loadState` 原只容忍 ENOENT，JSON 坏/0 字节/`EISDIR` 一律 rethrow → cordis `plugin tree failed to load` → 宿主退出。改为 fail-soft：损坏文件**改名留档** `.corrupt-<ts>.bak` 后按空状态装载，连留档失败也不抛 | `lib/index.js`（`loadState`/`quarantineState`） | `tests/state-corruption-failsoft.test.js`（8 例；回退修复必红，已验） |
| D2 | **记忆目录不可写同样起不来**：`installAdvisor` 在 `advisorEnabled` 默认关时仍急切 `mkdirSync` 三个子目录（只读 home/磁盘满 → 装载失败）。改为**惰性建目录**（首次写入时建），写入失败只影响 advisor 自身持久化 | `lib/advisor/index.js`（`ensureDir`/`lazyDir` + 6 个写路径包装） | `tests/advisor-lazy-dirs.test.js`（6 例；回退修复 5/6 必红，已验） |
| D3 | **expand 提示与 schema 不一致**：快照写「`action=expand+id`」，schema 是 `required:['action','target']`、expand 只认 `target=key` ⇒ 模型照做撞上"缺少 target（…用 add + entries）"的误导文案。提示改为 `action=expand target=key id=…`，报错按 action 分派（新增 `msg.expandNeedsTarget`） | `lib/i18n.js`、`lib/index.js` | `tests/tool-param-contract.test.js`（P3-A 三条）+ `tests/progressive-disclosure.test.js` 断言收紧 |
| D4 | **`list target=key` 不套分支作用域**：快照注入与 expand 都按当前分支过滤，只有 list 要显式传 `branch` ⇒ 返回仅限其它分支的条目（看得见用不上）。改为缺省按会话 cwd 的当前分支过滤（非 git 仓库仍不过滤）；`keyBranchFilter` 同时**加进 RUNTIME_KEYS**，面板「key 轨分支过滤」开关可关（此前只有 cordis 行 config 能改，桌面分发里用户够不到） | `lib/index.js` | `tests/tool-param-contract.test.js`（P3-B 两条） |
| D5 | **私有字典看操作系统语言、且加载期冻结**（S4）：7 处 `const LANG = navigator.language…` / 5 份 `isEn()`（CoIView / PromptView / BroadcastView / AdvisorPanel / MemoryQueueView / TodoView / SyncView）在用户切界面语言时不跟随。改为统一走 `clientLang()`（调用期解析），client 入口注册 resolver（读 locale 快照）；`STATUS_META` 这类**含语言的模块级表**改为函数 | `lib/i18n.js`（`setClientLocaleResolver`/`clientLang`）、`src/client/*`（7 文件）、`lib/client.js`（重建） | `tests/client-locale-follow.test.js`（7 例：解析契约 + 源码级"不得再有 `navigator.language` 判定/模块级 `LANG`"） |
| D6 | **advisor 提示词只有中文、且硬编码「用中文输出」**：note 是以用户指令形式注入主 Agent 会话的 ⇒ 英文界面下中文指令直接进主对话。三段（默认系统提示词/角色前缀/问答追加段）按 locale 分派；**中文原文一字未改**；导出从模块级常量改为同名函数（防加载期冻结） | `lib/advisor/prompt.js`、`lib/advisor/{index,runtime}.js`、`tests/advisor-api.test.js` | `tests/advisor-prompt-locale.test.js`（7 例：zh 逐字一致 / en 无中文散文（剥离输入协议标记后断言）/ 可切换 / 非法 locale 回落 / 不再导出旧常量名） |
| D7 | **字典健康度无门禁**：21 张 `[zh, en]` 字典此前只有手工检查。新增结构性不变量测试（二元组/非空/英文列无 CJK/占位符两侧一致/键不重复） | `tests/i18n-dictionary-integrity.test.js` | 23 例（直接 import 真实字典对象，不做正则扫源码——字典混用两种引号，正则会漏条目造成假绿） |

### E. 2026-09-16 对抗复核（对 D 批的独立审查，发现 6 条，全部收口）

审查者按"找真 bug"的角度独立复核 D 批（含用 esbuild 重跑重建验证 bundle 逐字节相同），
结论"未发现真回归"，但点出 6 条真实缺陷，均已修：

| # | 缺陷 | 修法 |
|---|---|---|
| A1 | 留档只在 `console.warn` + 一个 `.bak`：桌面壳里用户**看不出"设置被重置了"**（`loadState` 调用点没传宿主 logger，虽然 `ctx.logger` 在作用域内可达）；反复损坏时 `.bak` 无限堆积 | 留档写 `<stateFile>.quarantined.json` 标记 + **注入系统提示词一次**（模型据此转告用户"设置被重置、备份在哪"）后删除；告警改走 `ctx.logger('memory-evolve')`；留档最多保留 3 份 |
| A2 | `keyBranchFilter` 逃生口**在桌面端不可达**（不在 `RUNTIME_KEYS`、不在设置面板，只有 cordis 行 config 能改），而三处文档都建议"设 false" | 加进 `RUNTIME_KEYS` + 校验分支 + 面板开关 + 中英字典两条；文档口径同步更正 |
| A3 | `clientLang()` 的 resolver 用**严格匹配** `active==='zh'|'en'`，与 D10 的"上游允许地区子标签"口径不一致；且 resolver 无 try/catch（上游改名会从"语言不对"升级成"渲染抛错"） | 见下文"取舍"：今天 `active` 必然是裸 id（`LOCALE_IDS=['zh','en']`，本 profile 无语言包插件）⇒ 两种口径落到同一结果；保留严格匹配 + 补注释说明，不做无收益的语义变更 |
| A4 | `keyBranchFilter=false` 的回归用例**在非 git 目录上跑**（非 git 本来不过滤）⇒ 删掉被修逻辑照样绿（假绿） | 改为真 git 仓库 + 构造"仅其它分支可见的条目"，断言开关关掉时它**确实出现** |
| A5 | "跟随界面语言"的**承重接线零覆盖**：删掉 `src/client/index.ts` 的 `setClientLocaleResolver(...)` 那行，987 例曾全绿 | 新增断言：入口必须注册（且 effect 清理里注销）＋ `lib/client.js` 必须已重建（含 resolver 与快照读取） |
| A6 | `console.warn(message, meta)` 的第二参不会被插值，实测打成 `[object Object]`、诊断信息全丢 | meta 统一内联进首参（与 `session-orch.js` 同风格） |

**取舍说明（A3）**：D10 的"上游 locale id 允许带地区子标签"成立（`LOCALE_ID_PATTERN` 允许
`zh-CN`，语言包插件也按这个 id 注册），但**内置 locale 只有 `zh`/`en`**、且本 profile 不装
语言包插件 ⇒ `LocaleSnapshot.active` 今天必然是裸 id。两处归一化因此等价，不改。

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

- 插件自带测试：**987 pass / 0 fail**（`corepack yarn workspace dsh-memory-evolve test`，
  或直接 `node scripts/run-tests.mjs`）。**本套测试自 2026-09-16 起进了根门禁**
  （`scripts/check-workspaces.mjs` 的 `dsh-memory-evolve` 任务，`firstWave` 与 desktop
  check 并发）；此前它在 `verify-inventories.mjs` 挂着 `CHECK_CHAIN_EXEMPTIONS` 豁免，
  950 个用例（含全部本地安全加固回归）**不在任何门禁链里**。
  - 测试运行器 `scripts/run-tests.mjs` 负责建一次性 `HOME`：① `HOME` 必须可写，否则插件往
    `$HOME/.dsh` 写状态 → `EROFS` 假红；② 覆盖 `HOME` 后 git 读不到全局配置，
    `init.defaultBranch=main` 丢失 → `tests/update.test.js` 的 `git push origin main`
    全失败（81 例假红）。运行器写入最小 `.gitconfig`（`init.defaultBranch=main` +
    user/safe.directory）并设 `LC_ALL=C`（git 的中文输出会让英文 stderr 断言失配），
    `--keep-home` 可保留现场。
- 根守卫：`verify-inventories`、`verify-layout`、`check-theme-tokens` 全绿；包表 ↔ 磁盘
  workspace 包 ↔ prebuild 清单互相对拍（9 个包）。
- 桌面侧：`packages/host/desktop` 的 `tests/legacy-theme-tokens.spec.ts` 3/3 通过（唯一引用本包
  CSS 的宿主测试），`tests/desktop-locale.spec.ts` 9/9（locale id → 桌面语言，含与托盘解析的
  一致性对拍）。
