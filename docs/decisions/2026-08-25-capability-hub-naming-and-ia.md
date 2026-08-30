# 决策：能力中心（Capability Hub）命名与信息架构——技能商城 / 共享技能 / 共享 Agent 的归一

日期：2026-08-25　分支：master　状态：**已实施（Phase 1-3）**——Phase 4 远期

## 目标

把客户端当前三个平行的内容入口——「技能商城」「共享技能库」「共享 Agent」——归并为**一个入口 + 两个维度（类型 × 来源）**的信息架构，消除「商城 / 共享」命名造成的同类歧义，并为市场端「分级智能体」预留语义空间。

## 一、现状（以 2026-08-25 代码为准）

### 客户端（packages/host/enterprise/src/client/）

| 入口 | 文件 | 注入点 | 内容 |
|---|---|---|---|
| 技能中心（`skill.title`='技能中心'） | `SkillCenterPanel.tsx`(684 行) | `sidebar.footer.action` id=`skill-center` order=-1 | 三分区：我的本地(local) → 共享技能库(shared) → 技能商城(market)，单屏按分区标题堆叠 |
| 共享 Agent（`agent.title`='共享 Agent'） | `AgentSharePanel.tsx`(486 行) | `sidebar.footer.action` id=`agent-share` order=0 | 独立面板：本地创造预设 + 已共享 presets |

两个面板是**两个独立 modal**，靠 `dsh-panel-activate` 事件互斥（`SkillCenterTrigger.tsx` / `AgentShareTrigger.tsx` 各发各的 `PANEL_NAME`）。

### 服务端（server/internal/）

三个独立域、三套路由前缀：

| 域 | 员工 Bearer | 管理端 Admin | 数据表（+授权表） |
|---|---|---|---|
| 商城 skills | `/api/client/v2/marketplace/skills` | `/api/server/admin/skills` | `skills`(0005) + `skill_grants`(0016) |
| 共享技能 | `/api/client/v2/shared-skills` | `/api/server/admin/shared-skills` | `shared_skills`(0034, name+version 复合唯一) + `shared_skill_grants`(0036) |
| 共享智能体 | `/api/client/v2/agent-presets` | `/api/server/admin/agent-presets` | `agent_presets`(0032/0033/0035 多版本) + `agent_preset_grants`(0036) |

**共享库现状模型（0036 起）**：上传→ `pending` → admin `approve`/`reject`（reject 必填 reason）；**approved 后仍需授权（grants：用户 / 部门组）才可见可装**，admin 恒全量不落授权表；同名多版本独立审核、共享一个授权；作者可看自己的全部状态（他人 pending/rejected 视同 404）。

### webadmin（server/webadmin/src/）

`App.tsx` 侧边栏两个独立菜单：`/shared-skills`「共享技能」、`/agent-presets`「共享Agent」；`Marketplace.tsx` 管理商城（菜单「商城」）。审核页 `SharedSkills.tsx` / `AgentPresets.tsx` 结构几乎同构（列表/预览/approve/reject/delete/授权弹窗 grant-dialog.tsx）。

## 二、病根（为什么现在乱）

命名把**内容类型**与**分发来源**混进了同一个词：

- 「技能商城」「共享技能库」「共享 Agent」表面是三个平行通道，用户会以为「商城技能」与「共享技能」是同类的两种卖法；
- 实际真正正交的是：**要什么内容**（技能 / 智能体）× **从哪里拿**（市场=授权付费制 / 组织=内部审核+授权制 / 本地=自己写的）。

名字只应承载「类型」语义；「来源」用分区和徽章表达。

## 三、命名定案

| 层 | 定案 | 备选（弃用理由） |
|---|---|---|
| 伞名 | **能力中心**（Capability Center；英文界面 Capability Hub） | 应用中心（与桌面应用撞词）；技能广场/智能体市场（只装得下一种类型） |
| 来源级 A | **市场**（原「技能商城」） | — |
| 来源级 B | **组织**（原「共享技能库」/「共享 Agent」） | 社区库/内网市场（本产品现阶段面向企业内部；未来开放公共社区时在来源维度加「社区」，结构不动） |
| 等级词 | 「专业」系词**只留在市场端做分级**：免费版 / 专业版（`price.tier: free|pro`） | 不做共享通道名——避免「等级」与「来源」两个维度再次混叠 |
| 组织库质量标记 | **官方** / **精选**（管理员审核/事后可标记；互斥，`quality: ''|'official'|'featured'`） | 不用「专业」词做质量标记；「专业」一词全产品只作市场分级语义，保证词表唯一 |

明确结论：**「专业智能体」不采用为共享库通道名**；它作为市场端智能体分级（免费/专业）的语义。组织库内质量标记用「官方/精选」，与市场的「免费/专业」分级形成两套互不重叠的词表。

## 四、目标信息架构

```
能力中心 Capability Center（侧边栏单入口，替代 skill-center + agent-share 两个 foot action）
│
├── 我的          本地创作区：上传管理（本地技能 / 创造模式 Agent），展示共享状态
│     ├── 技能        本地磁盘技能 + 上传/重提/审核状态
│     └── 智能体      创造模式本地预设 + 上传/重提/审核状态
│
├── 市场          外部商店：上架即授权制（bootstrap 建议清单）
│     ├── 技能        ← 原「技能商城」
│     └── 智能体      ← 本期仅空态占位（「暂无市场智能体，敬请期待」）；分级 Phase 4
│
└── 组织          内部共享：上传→审核(approve/reject)→授权(grants) 双门制
      ├── 技能        ← 原「共享技能库」（shared_skills）
      └── 智能体      ← 原「共享 Agent」（agent_presets）
```

- 顶部**来源 tab**：我的 / 市场 / 组织；下方**类型筛选**：全部 / 技能 / 智能体。
- 每张卡片至多四个徽章：**类型徽章**（技能/智能体）、**来源徽章**（市场/组织/官方/精选 合并为质量行）、**状态徽章**（审核中/已驳回/已安装/可更新到 vX）。
- **复合键**：卡片 key 与跨类型操作一律用 `{kind}:{name}`（技能名与 preset id 允许同名，如 `codeql`，当前两个面板各自命名空间不会撞，合并后必须复合键）。
- **卡片唯一位置**：已安装条目只在其来源分区（市场/组织）渲染一张卡，本地创作只在「我的」；**不在两处重复渲染**（避免复合键冲突与行为分叉）。已安装的卸载/更新动作在来源分区卡上，本地创作卡只管上传。
- **多版本归并**：同名（kind+name）归并为一张卡，展示**最高 approved 版本**；卡片元数据显示「vX · N 个版本」，点击版本号展开历史版本列表（各行可安装，用作降级/指定版本）；不再按版本逐行铺开（现状两个面板都是逐版本展示，列表冗长）。
- 后续可加「发现」聚合页（推荐/热门/最新），搜索统一跨来源。v1 不做。

## 五、本期实施（Phase 1-3）细目

### Phase 1 客户端归一（单入口 + 三分区面板）

1. `locales.ts`：新增 `capability.*` 双语键（能力中心/我的/市场/组织/技能/智能体/`officialBadge`/`featuredBadge`/`viewVersions`…）；**旧 `skill.*`/`agent.*` 键保守保留**（AgentSharePanel 复用了 `skill.installedBadge`/`skill.cancel`，且 account 会话等键共用），待全部引用清除后再删。
2. 单入口：新增 `CapabilityCenterTrigger`，`sidebar.footer.action` 注册 id=`capability-center`（order=-1）；移除 `skill-center`、`agent-share` 两个注册；`dsh-panel-activate` 改用 `capability-center`。删除 `SkillCenterTrigger.tsx` / `AgentShareTrigger.tsx`。
3. `CapabilityCenterPanel` 以 `SkillCenterPanel` 卡片网格为骨架，插入 Agent 卡片类目；渲染逻辑收敛为统一 `CapabilityItem[]`（见 §六），`latestApprovedVersion` 泛化为按 `(kind, name)` 计算。
4. **补齐能力不对称（现有缺陷）**：共享技能 host 代理已有 `POST /api/pico/shared-skills/:name/:version/uninstall`（auth-gate.ts:761），但 `SkillCenterPanel` 无卸载入口——合并时对齐 Agent 的卸载/确认卸载（走现有 confirm 条交互）。
5. **修复 hasUpdate 误报（现有缺陷）**：`SkillCenterPanel.hasUpdate` 现只要存在 approved 行即提示更新（不比较版本大小，已装 2.0.0 会误导「更新到 v1.0.0」）；统一为「approved 最高版本 > 已装版本」才提示（复用项目内既有 semver 比较，无则抽 `compareVersions` 公共函数 + 单测）。
6. **轮询与无障碍取更完善实现**：AgentSharePanel 的 30s 静默轮询（pending→approved/rejected 刷新）+ Tab focus trap 统一到新面板（SkillCenterPanel 两者皆无）。
7. **同名校验与确认**：并发加载三个端点（`/api/pico/skills` + `/api/pico/shared-skills` + `/api/pico/agent-presets`，Promise.all 并行）时，安装前检测目标名冲突：磁盘/installed 已有同名 → 弹「将覆盖本地同名目录/已安装内容」确认；确认后携带 `?force=1` 重发（见 §六 409/CONFLICT 契约）。
8. **分区独立错误态**：一个端点失败仅该分区显示「加载失败+重试」，其他分区照常渲染（现状是整个面板 error+整体重试）。
9. **文案同步**：`desktop/scripts/e2e-client.mjs:237/243` 硬断言「技能中心」与截图 marker `04-skills` 改为「能力中心」/新 marker；`skill-center-panel.spec.ts`、`agent-share-panel.spec.ts` 更新/合并为 `capability-center-panel.spec.ts`（含 `splitCatalog`/`latestApproved*`/`avatarColor`/`hasUpdate` 用例）。
10. **设置页排查项**：07-marketplace.md 提到「设置页可管理建议安装」；该入口若在上游客户端则**不改**（上游只读约束，仅备注）；若在 enterprise 侧则跟随改名。

### Phase 2 服务端聚合面（facade，不动表结构 + 新增质量标记迁移）

1. 员工侧：新增 `GET /api/client/v2/capabilities`（Bearer），聚合 `listVisible` 语义：`source=market` 走 marketplace 已授权清单、`source=org` 走 shared-skills + agent-presets 的已授权+自己的全部状态；响应统一 `CapabilityItem[]`；`installed`/`hasUpdate` 由 host 代理层（`/api/pico/capabilities`）合并本地状态（沿 `/api/pico/shared-skills` 现模式）。
2. **组织库质量标记（新迁移 0037）**：`shared_skills` 与 `agent_presets` 各加 `quality TEXT NOT NULL DEFAULT ''`（`''`/`official`/`featured`，互斥）；授权表不动。管理端审核页在 approve 时可勾选「官方/精选」，并支持事后修改（新增 `PUT .../quality` 或并入现有编辑端点），审计动作 `shared_skill_qualify`/`agent_preset_qualify`（沿用 audit 90 天契约）。**注意 0037 必须同时落地 sqlite（migrations/）与 pg（migrations-pg/）两套迁移**。
3. **安装冲突契约**：host 代理安装端点检测目标目录已存在且非同源 → 409 `{"error":{"code":"CONFLICT"}}`；客户端确认后带 `?force=1` 重试（服务端/host 放行，仍做归档安全校验）。市场与组织同名、与本地手工同名统一走此路径。
4. 管理端：新增 `GET /api/server/admin/approvals?type=skill|agent|all&status=` 统一审批队列（内部复用两个域的 listAll + decide，**不复制审核逻辑**）；单资源 approve/reject/delete/grants 仍走各自原路由，避免破坏性重命名。
5. **不动表**：`shared_skills` / `agent_presets` / `skills` 及 grants 表全部保留（多版本+授权已各自闭环）；聚合面只是读侧 facade（+0037 两列）。
6. 审计动作名不变（`shared_skill_approve`/`agent_preset_approve` 等），新动作仅 `*_qualify`。

### Phase 3 webadmin

1. `App.tsx` 菜单：`/shared-skills`、`/agent-presets` 两项收敛为「能力中心」分组（`/capabilities` 双 tab）或保留双页但标题改「组织 · 技能 / 组织 · 智能体」；菜单「商城」改「市场 · 技能」。**本期不动**：市场端无智能体管理页面（Phase 4）。
2. 新增统一审批页（`/capabilities/approvals`，随菜单分组）：一个列表混排 pending 队列，类型徽章区分，行内操作复用现有 approve/reject/delete/授权逻辑（组件下沉共享，避免复制粘贴——工程原则 §3.2）；approve 时带「官方/精选」勾选。
3. `SharedSkills.tsx` / `AgentPresets.tsx` 保留原路由（第三方/API 兼容），仅标题与菜单文案更新。

### Phase 4 远期（本期不做，仅预留语义）

- 市场端「智能体」分类与 `price.tier` 分级（免费版/专业版；「专业」词只在这里用）。
- 若未来公共社区开放：来源列 +「社区」，IA 不动。
- 数据层收敛为单一 `catalog_items(id, kind, source, ...)`（届时评估；现聚合面已隔离客户端，迁移不影响 UI）。

## 六、统一 API 契约（草案，Phase 2 落地时细化）

```ts
interface CapabilityItem {
  kind: 'skill' | 'agent'
  source: 'market' | 'org' | 'local'
  name: string                 // 技能名 / preset id
  display_name: string
  version: string
  description: string
  author: string
  status?: 'pending' | 'approved' | 'rejected'   // org 仅作者可见自己的非 approved
  reason?: string              // reject 原因（作者侧展示）
  quality?: 'official' | 'featured'      // 仅 org（0037）
  installed: boolean
  installedVersion?: string     // 已装版本（hasUpdate 判断依据）
  hasUpdate?: boolean          // 已安装且最高 approved 版本 > 已装版本
  versions?: string[]          // 该名全部 approved 版本（历史版本展开）
  price?: { tier: 'free' | 'pro' }   // 仅 market·agent 未来启用
}
```

- `GET /api/client/v2/capabilities?source=&type=&q=`（员工 Bearer）；`GET /api/server/admin/approvals?type=&status=pending`（Admin）。
- 后端只返回当前用户可见/已授权条目（坚持「默认拒绝」，不泄露存在性）；`installed/installedVersion/hasUpdate` 由 host 代理补齐。
- 安装冲突：`POST .../install`（无 force）→ 409 `CONFLICT`；`?force=1` 放行。
- 后端实现建议：**同包聚合，不跨域 import**——`/api/client/v2/capabilities` 放在新包 `server/internal/capabilities/`，内部复用 `serverstore` 函数（`ListVisibleSharedSkills`/`AccessibleSharedResourceNames`/marketplace 的可见性函数），不复制审核与归档安全逻辑。

## 七、术语对照（界面旧 → 新）

| 旧（界面/菜单） | 新 |
|---|---|
| 技能中心 | 能力中心 |
| 技能商城 | 市场 · 技能 |
| 共享技能库 | 组织 · 技能 |
| 共享 Agent / 共享智能体 | 组织 · 智能体 |
| （新增） | 组织库质量徽章：官方 / 精选 |
| （新增，placeholder） | 市场 · 智能体（免费版/专业版，Phase 4） |

保留不变：数据库表名（`shared_skills`/`agent_presets`）、API 路由前缀（`/api/client/v2/shared-skills`、`/api/client/v2/agent-presets`）、存量审计动作名、上传/安装/审批状态机。

## 八、验收

1. **Phase 1**：客户端侧边栏仅一个「能力中心」入口；面板三分区（我的/市场/组织）× 类型筛选（全部/技能/智能体）；同名技能与智能体不串卡（复合键）；共享技能可卸载、卸载走确认条；hasUpdate 只在「approved 最高版本 > 已装」时出现；30s 轮询与 Tab focus trap 生效；分区独立错误态；同名安装先确认后 `?force=1`；多版本归并一张卡且历史版本可展开安装；`capability-center-panel.spec.ts` 与 `e2e-client.mjs`（新 marker）全绿；`yarn check` 全绿。
2. **Phase 2**：`/api/client/v2/capabilities` 对非授权用户不泄露 pending/rejected 存在性；聚合层单测覆盖同名 `kind` 冲突、多版本 hasUpdate（semver）、409 CONFLICT→force 流程、0037 quality 迁移（sqlite+pg 双跑）；`make test` / `make check` 全绿。
3. **Phase 3**：webadmin 新导航生效（能力中心分组/市场·技能）；统一审批页仅使用下沉共享组件；approve 可勾选官方/精选且落 `*_qualify` 审计；`make webadmin` 通过。
4. 各 Phase 独立 commit（`feat:|refactor:|chore:` 单行 ≤72 字符），不混入行为无关改动。

## 九、遗漏细节与决策记录（2026-08-25 补充）

| # | 细节 | 核查结果 | 处置 |
|---|---|---|---|
| 1 | 共享技能无卸载入口 | host 代理已有 uninstall 端点（auth-gate.ts:761），面板没按钮 | Phase 1 补齐（对齐 Agent） |
| 2 | hasUpdate 误报（不比较版本） | SkillCenterPanel `hasUpdate` 只测 approved 行存在 | Phase 1 修复为 semver 比较 |
| 3 | 轮询 / focus trap 不对称 | AgentSharePanel 有 30s 轮询+Tab trap；SkillCenterPanel 无 | Phase 1 取更完善实现 |
| 4 | 「已安装」语义混乱 | 技能面板 installed=市场∪共享∪本地磁盘天然存在 | 卡片唯一位置渲染（§四），本地手工技能不冒充「已安装」 |
| 5 | e2e/单测锁死文案 | e2e-client.mjs:237/243 断言「技能中心」、marker 04-skills；两个 panel spec | Phase 1 同步更新 |
| 6 | 旧文案键引用 | `skill.*`/`agent.*` 跨面板复用（installedBadge/cancel） | 保守保留，清除引用后再删 |
| 7 | 设置页入口 | 07-marketplace.md 提及「设置页可管理建议安装」，位置待排查 | 上游则不动（只读约束） |
| 8 | 分区加载失败 | 现状整面板 error+重试 | 每分区独立错误态 |
| 9 | 同名冲突（市场 vs 组织 vs 本地手工） | 无任何冲突检测，直接覆盖磁盘目录 | 客户端弹确认框（**不做服务端 409/force**，见下） |
| 10 | 多版本铺开冗长 | 两面板均逐版本渲染 | 归并一张卡+历史版本展开 |
| 11 | 组织库质量标记 | 无此概念；「专业」词被抢注 | 0037 quality 列 + 官方/精选（互斥） |
| 12 | 市场·智能体分级 | 无任何市场智能体概念 | 本期空态占位；Phase 4 再分级 |

### 实施记录（2026-08-25 完成 Phase 1-3）

- **服务端**：0037 迁移（双后端 sqlite+pg）`shared_skills`/`agent_presets` 加 `quality`；serverstore 增加 `SetSharedSkillQuality`/`SetAgentPresetQuality`、`ValidSharedQuality`/`ValidAgentQuality`，approve 保留 quality、reject/pending 清空；两域 JSON 输出 quality；新增 `PUT /api/server/admin/{shared-skills,agent-presets}/:name/:version/quality`（qualify 审计）；新增 `server/internal/capabilities` 包（`/api/client/v2/capabilities` 员工聚合面 + `/api/server/admin/capabilities/approvals` 统一审批队列，`marketplace.API.AccessibleSkills` 导出复用）。
- **host 代理**：`/api/pico/capabilities`（GET ?source=market|org|local）合并已安装/本地创作状态；保留原共享技能/Agent 安装/卸载端点。
- **客户端**：`CapabilityCenterPanel`（三分区 my/market/org × 类型筛选 × 徽章（类型/来源/质量/状态）× 多版本归并·历史展开 × hasUpdate semver 修复 × 30s 轮询 × Tab focus trap × 分区独立错误态 × 同名确认框）；`CapabilityCenterTrigger` 单入口替换两个旧 trigger；删除 4 个旧面板/触发器文件+2 个旧单测；新增 `capability-center-panel.spec.ts`（compareVersions/hasUpdateFor/mergeItems/latestApprovedVersionByName/avatarColor）；e2e-client.mjs 更新「能力中心」。
- **webadmin**：菜单「市场 · 技能」+「能力中心」（统一审批页 `Capabilities.tsx`，类型/状态筛选、官方/精选质量标记、approve/reject/delete 走原域端点、授权弹窗）；**2026-09 归一**：`Capabilities.tsx` 恢复承载共享技能+共享 Agent 统一审核（含类型/状态筛选、名称冲突列、下载/调用统计、按 kind 预览 SKILL.md/agent.cordis.yml），独立页 `SharedSkills.tsx`/`AgentPresets.tsx` 与其测试删除，`/shared-skills`、`/agent-presets` 路由与导航同步移除（原域 API 端点保留，供队列 base_path 引用）；服务端 `/api/server/admin/capabilities/approvals` 支持 `?status=all|pending|approved|rejected`（显式 status=all 才全量，缺省仅 pending）与 `?type=`，base_path/preview_path 修复为 `/api/server/admin` 前缀；新增 `Capabilities.test.tsx`。

### 实现偏离（决策修订，2026-08-25）

1. **409/force 契约不落地**（原 §五.3）：两安装器语义相反（技能备份后覆盖更新、Agent 同名拒绝），客户端弹「同名将覆盖」确认框已达成提示并确认目标；服务端不新增 409 CONFLICT/`?force=1` 假设接口，避免破坏现有安全替换设计。仅保留客户端侧确认（`capability.conflictConfirm`）。
2. **Agent 同名**：host 侧 `installedPresets.has(name)` 已覆盖本地同名 → org 卡显示「已安装+卸载」，不提供覆盖安装入口（贴合后端「不覆盖」语义）。
3. **质量标记追加**：webadmin 通过 `<Select>`（官方/精选/无）设置 `quality`，仅 approved 行可选。

## 十、风险与决策依据

- **合并面板是纯 UI 重构**：两面板都已是「卡片网格 + 分区标题」同构骨架，合并成本低；退出点：若合并后信息密度不达标，可退化为「能力中心」容器内两个 tab（技能 / 智能体），IA 不变。
- **保留旧路由而非重命名**：`/api/client/v2/shared-skills` 等内容语义仍准确（「共享」描述的是组织内分发机制），重命名收益低、破坏 host 代理与第三方接入方；新词只落在界面与聚合面上。
- **「专业」的词性**：词表内把它固定为「等级」语义（市场定价层），全产品内不复用为别的含义，避免再次单维度化命名；组织库质量标记另起「官方/精选」词表。
- **强制 force 的边界**：`?force=1` 只豁免「同名目录已存在」这一项检查；归档安全校验、大小上限、拒绝符号链接等**永远不会**因 force 豁免。
- **0037 双后端**：本项目 sqlite 与 pg 迁移目录并存（`migrations/` 与 `migrations-pg/`），任何表结构改动必须双落地，否则 pg 部署失步。
