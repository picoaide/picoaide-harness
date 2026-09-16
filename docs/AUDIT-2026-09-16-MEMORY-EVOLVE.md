# 上游记忆系统本地化验证与修复（2026-09-16）

**对象**：随桌面包分发的 vendored 第三方插件 `packages/vendor/memory-evolve`
（上游 `github.com/csyangwen/dsh-memory-evolve`，基线 `c337dc1a` / tag `v26091501`）
**性质**：独立验证 + 修复，改动已提交（分支 `chore/release-v2.7.5-beta.1`）
**方法**：三方合并保真核对（树对树 git diff）+ 真实文件系统/真实 profile 引导的端到端探针
+ 真机打包产物（app.asar）核对；所有修复带"回退修复必红"的回归测试

---

## 0. 结论摘要

**核心记忆系统本身可用、本地化接线正确**：五轨记忆闭环（含 key 轨"需用户确认"闸门）、
系统提示词注入与渐进式披露、`{{...}}` 净化、>64KiB 中文往返、真实 git 双设备同步，
全部实测通过；上游 `c337dc1a` 的 4 项关键修复逐字落地；**三方合并未丢任何本地加固**
（MERGE_FIDELITY = INTACT）。

**但发现并修复了 7 类缺陷**，其中 2 类是**启动级**：坏一个状态文件、或记忆目录不可写，
**整个桌面应用起不来**（不是记忆功能降级）。

---

## 1. 验证通过项（实据）

| 项 | 结论 | 证据 |
|---|---|---|
| 上游基线是否最新 | 是 | 基线 `c337dc1a` == 上游 `main` 最新提交 |
| 三方合并保真 | INTACT | 44 个 `lib/` 文件的服务端-本地差异逐段归因；上游**无任何文件/语义段**在本地树中消失 |
| 上游 4 项关键修复 | 逐字落地 | `setEncoding('utf8')`（4 文件，无裸 `String(chunk)` 残留）、`{{...}}` 净化、`memory-consolidate` 技能、`ownEvents` 三档兜底 |
| 五轨闭环 | PASS | 落点 `$DSH_HOME/memories/{MEMORY.md,USER.md,daily/YYYY-MM-DD.md,projects/<sha1(cwd)[:12]>/{MEMORY.md,KEY.md}}`；key 轨确认前只进 `SUGGESTIONS.jsonl` |
| 提示词注入 | PASS | memory/user/key 注入；daily/project **设计上不注入**（保护前缀缓存）；`expand` 能取全文 |
| `{{...}}` 净化 | PASS | 用**真实宿主渲染器** `renderContextSnapshot` 验证：不抛错、`{{foo}}`→`{foo}`、`{{date}}` 不被展开 |
| UTF-8 大文本 | PASS | 71.7KB 中文 0 个 U+FFFD；真实 git 双向同步 + 三方合并 328KB 逐字节一致 |
| 沙箱风险 | **不存在** | 插件全用裸 `node:fs`、在宿主进程内执行（`grep ctx.fs lib/` = 0），"工作区内修改"下写记忆不会被拦也不弹审批 |
| 打包产物（dev 构建） | PASS | `afterPack` 过、`app.asar` 内 13 条 `skills/` 条目（5 个内置技能含 `memory-consolidate` + 预扫脚本） |

---

## 2. 修复清单（全部带回归，且已验证"回退修复必红"）

| # | 级别 | 缺陷 | 修复 | 回归 |
|---|---|---|---|---|
| D1 | **P1 启动级** | `plugin-state.json` 损坏（截断 JSON / 0 字节 / 目录占位）⇒ `loadState` rethrow ⇒ cordis `plugin tree failed to load` ⇒ 宿主 `shutdown.request(1)`：**应用静默退出**，用户只能手删文件自救。同族损坏在其它 4 个 sidecar 上都被优雅吸收，只有这一处致命 | fail-soft：损坏文件改名留档 `.corrupt-<ts>.bak`（不静默丢用户覆盖项）后按空状态装载；连留档失败也不抛 | `tests/state-corruption-failsoft.test.js` 8 例；回退修复 **4 例必红**（已实测） |
| D2 | **P1 启动级** | `installAdvisor` 在 `apply()` 里**无条件**调用，且装载期急切 `mkdirSync` 三个子目录（`advisorEnabled` 默认关也照建）⇒ 只读 home / 磁盘满 / 目录被文件占位 ⇒ 同样整个应用起不来 | 惰性建目录（首次写入时建），写路径各自确保父目录；写入失败只影响 advisor 自身持久化 | `tests/advisor-lazy-dirs.test.js` 6 例；回退修复 **5 例必红**（已实测） |
| D3 | P3 | 快照提示写「`action=expand+id`」，而 schema 是 `required:['action','target']`、expand 只认 `target=key` ⇒ 模型照提示做会撞上"缺少 target（…请用 add + entries 数组）"这条与当前动作无关的文案 | 提示改为 `action=expand target=key id=…`（zh/en 两列 + 工具描述同步）；报错按 action 分派（新增 `msg.expandNeedsTarget`） | `tests/tool-param-contract.test.js` P3-A 3 例 + `progressive-disclosure.test.js` 断言收紧 |
| D4 | P3 | `list target=key` 只有显式传 `branch` 才过滤，而快照注入与 `expand` 都按当前分支过滤 ⇒ 返回仅限其它分支的条目（既不会注入、也 expand 不出来） | 缺省按会话 cwd 的当前分支过滤；`keyBranchFilter=false` / 非 git 仓库仍不过滤（与注入侧同样保守） | `tests/tool-param-contract.test.js` P3-B 2 例 |
| D5 | P2 | **7 处私有字典看操作系统语言且加载期冻结**（CoIView / PromptView / BroadcastView / AdvisorPanel / MemoryQueueView / TodoView / SyncView）：用户在设置里切界面语言，这些界面**不跟随**且零报错；含 `STATUS_META` 这类"含语言的模块级表" | 统一走 `clientLang()`（**调用期**解析）；client 入口注册 resolver（读 locale 快照的 active）；含语言的模块级表改函数 | `tests/client-locale-follow.test.js` 7 例（解析契约 + 源码级"不得再有 `navigator.language` 判定 / 模块级 `LANG`"）+ `lib/client.js` 重建 |
| D6 | P2 | advisor 三段提示词只有中文，正文硬编码「建议用中文输出」「直接以中文回答用户的问题」——而 note 是**以用户指令形式注入主 Agent 会话**的 ⇒ 英文界面下中文指令直接进主对话 | 三段（默认系统提示词/角色前缀/问答追加段）按 locale 分派；**中文原文一字未改**；导出从模块级常量改为同名函数（防加载期冻结语言） | `tests/advisor-prompt-locale.test.js` 7 例（zh 逐字一致 / en 无中文散文（剥离输入协议标记后断言）/ 可切换 / 非法 locale 回落 / 不再导出旧常量名） |
| D7 | P2（门禁） | 950 个插件用例**不在任何门禁链**（`verify-inventories` 的 `CHECK_CHAIN_EXEMPTIONS` 显式豁免）⇒ 升级上游时的静默回归可直接进产物 | 新增 `scripts/run-tests.mjs`（一次性 HOME + 最小 `.gitconfig` + `LC_ALL=C`，消除 EROFS 与 `init.defaultBranch` 两类假红），接入 `check-workspaces.mjs`（`firstWave`，与 desktop check 并发），移除豁免 | `yarn check` 现含该任务；`verify-inventories` 包表 ↔ 磁盘互拍 |
| D8 | P2（门禁） | 21 张 `[zh, en]` 字典只有手工检查 | 新增结构性不变量测试：二元组 / 非空 / 英文列无 CJK / 占位符两侧一致 / 键不重复（**直接 import 真实字典对象**，不做正则扫源码——字典混用两种引号，正则会漏条目造成假绿） | `tests/i18n-dictionary-integrity.test.js` 23 例 |
| D9 | P2（文档） | `VENDORED.md` 三处与代码不符：①声称 mermaid 去重补丁落在 `lib/client.js`，实测入库 bundle 与上游**逐字节相同**（补丁从未生效，语义等价故无影响）②"41 个幻影 token"实为 **49**（1265 处引用）③未记录 `lib/i18n.js` 的本地新增键 | 修正三处 + 补 §D 修复批；并**给出可复现的 bundle 重建姿势**（`DSH_SOURCE=<带 esbuild 的目录> node scripts/build.mjs`，实测 0.28.1 重建 = 上游产物 + 唯一 mermaid 改动，逐字节可复现） | `check-theme-tokens`（49 个名字与适配层逐一对账）、桌面 `legacy-theme-tokens.spec.ts` 3/3 |
| D10 | P2（i18n 基础设施） | 桌面原生面（托盘/通知）只认裸 `zh`/`en`，而上游 locale id 允许 `zh-CN`（客户端确实会写）⇒ 中文界面 + 英文托盘 | 新增 `desktop-locale.ts`（唯一实现）并让托盘的语言标签解析**共用同一份**前缀规则；`auto`/未设置仍交给系统语言 | `tests/desktop-locale.spec.ts` 9 例（含与托盘解析的一致性对拍） |

### 交付形态的连带修复（D5/D9）

`lib/client.js` 是**运行期真正加载**的产物，而它自 2026-09-09 起就与 `src/client/**` 脱节
（历史补丁只改了 `src/`）。本次用 esbuild 0.28.1 重建：产物 = 上游入库产物 + mermaid 去重
（唯一差异，79 行），D5 的 resolver 与全部 7 处私有字典改动因此真正生效。

---

## 3. 用户可感知的行为变化（写发布说明时抄这节）

| 变化 | 谁受影响 | 说明 |
|---|---|---|
| `memory action=list target=key` 缺省按**当前分支**过滤 | 用 git 分支记忆作用域的用户 | 此前能列出仅限其它分支的条目（那些条目既不会注入、也 `expand` 不出来）；现在与注入/expand 一致。要跨分支查看就显式传 `branch`，或把 `keyBranchFilter` 设 false |
| 剪贴板/提示词里的 `expand` 调用形态改为 `action=expand target=key id=…` | 模型（工具提示） | 旧提示 `action=expand+id` 与 schema 不符，模型照做会拿到误导性报错 |
| 界面语言切到英文后，**CoI / 提示词 / 广播 / Advisor / 记忆队列 / 待办 / 同步** 面板随语言变化 | 英文界面用户 | 此前这些面板看操作系统语言且加载期冻结，切语言不跟随（零报错）；现在跟随，但**面板文案本身仍是中文**（见 §4 未解决项） |
| 英文界面下 advisor 的评审建议与问答回答改英文 | 英文界面用户 | 此前提示词硬编码「建议用中文输出」；而 note 是以用户指令形式注入主对话的，中英混排直接进会话 |
| 中文界面下 advisor 行为**逐字不变** | 中文界面用户 | 中文提示词原文一字未改；默认语言仍是 `zh` |
| 损坏的 `plugin-state.json` 会被改名留档为 `plugin-state.json.corrupt-<ts>.bak` 并按默认配置启动 | 遇到该损坏的用户 | 此前是**整个应用起不来**；留档是刻意的（不静默丢弃你的覆盖项），副作用是 home 里会多一个 `.bak` |
| 托盘/通知的语言跟随设置里的 `zh-CN` / `en-US` 这类带地区的 id | 显式选了带地区语言的用户 | 此前只认裸 `zh`/`en`，于是中文界面配英文托盘 |

**尚未发布**：以上改动在分支 `chore/release-v2.7.5-beta.1` 的 `9974a92ac9` / `ecf8ecf2da`
两个提交里；已发布的 tag `v2.7.5-beta.1`（= `44de10c519`）**不含**这些修复，也不含随包内置技能
与 macOS 中文资源（那两处在 `2be1209304` 与 `afaea04346`，同样未进 tag）。下一个 tag 才带上。

## 4. 仍未解决（明确留给独立批次，不夹带进本批提交）

1. **文案覆盖**（不是错，是缺）：画板弹窗（58 条）/ CoIView（~181）/ PromptView（~119）/
   AdvisorPanel（~131）在英文界面下仍显示中文。D5 修的是"切语言不跟随"这个**行为缺陷**；
   把这些文案搬进字典是 ~580 键的翻译工程量（审计估约 1 周，含人工双语复核）。
2. **架构待拍板**：`skillDir` 默认 `~/.agents/skills` 在 DSH_HOME **之外** ⇒ 记忆随渠道隔离、
   技能不隔离。改它会迁移既有用户的技能库，属产品决策。
3. **`DICTIONARY_PACKAGES` 仍不含 enterprise**：补进去会红在既有的 79 个死键上
   （`docs/AUDIT-2026-09-08-FULL.md:193` 已记录、修复计划未完成）。清理与补守卫应同批做。

---

## 5. 复现与验证姿势

```bash
# 插件测试（一次性 HOME，无需手工准备）
corepack yarn workspace dsh-memory-evolve test

# 单文件复现 + 保留现场
node packages/vendor/memory-evolve/scripts/run-tests.mjs tests/state-corruption-failsoft.test.js --keep-home

# client bundle 重建（改 src/client/** 后必须做）
DSH_SOURCE=<含 node_modules/esbuild 的目录> node packages/vendor/memory-evolve/scripts/build.mjs

# 全量门禁（含新接入的 987 例插件测试）
corepack yarn check
```

端到端探针留痕在 `temp/me-probe/`（`RESULTS.md` + `run-all.sh`，gitignored）：
真实 home 布局 + 真实 desktop profile 引导（42 工具）下驱动五轨写入/注入/净化/大文本/同步。
