# 能力中心「官方」机制与 IA 重构设计（2026-09-04 定案）

需求拍板（用户 2026-09-04）：

> **IA 定案（补充，用户强调技能/智能体是两个东西）**：能力中心 = **技能 | 智能体 | 审批** 三个一级 Tab——
> 技能市场与智能体市场是**两个完全独立的页面组件**（各自卡片/端点/归属/锁定/蓝标，
> 文案与徽章一律带 kind 语义：「官方技能」「官方智能体」；「能力」仅作菜单伞名）；
> 审批是唯一交叉点（统一队列，按类型筛选 全部/技能/智能体）。
> 客户端市场同样拆「技能/智能体」子 Tab，与 webadmin 对齐。
>
> **市场排序规则（客户端定案，webadmin 同步同序）**：官方(top) → 精选(quality=featured) →
> 其余内容；层内按 **综合评分 score 降序**（名称升序兜底）。
> **score = 调用量 × 3 + 下载量**（调用权重 > 下载权重，3:1；比例如需调整改服务端一处公式即可）。
> score 由**服务端聚合面计算并随 `CapabilityItem.score` 下发**；客户端排序直接读 `score` 字段，
> 不在本地二次计算（与服务端顺序双保险一致）。
- **官方 = 归属官方**（App 级官方属性，独立于 quality 标记）；蓝标 = 官方；「归属官方」后普通员工不能上传新版，仅管理员可上传。
- 「组织共享」来源概念 UI 归一：技能市场页/智能体市场页各自展示「管理员官方」与「员工上传(审批后)」两类内容（来源小徽章区分）；底层 channel=market/org 与授权记录**不动**。
- 员工上传内容审批通过后**保持双门**（仍需管理员授权才可见）。
- **精选 featured 保留**为独立徽章（可叠加官方蓝标）；quality 的 official 语义**退役**。
- 存量 `quality=official` 行**自动转官方**；锁定管理**移到市场页**；官方↔个人转移**双向允许**；客户端（员工视角）市场卡片**展示官方蓝标**。

---

## 一、数据模型（迁移 0059）

```sql
-- apps 表新增 App 级官方属性(唯一事实源)
ALTER TABLE apps ADD COLUMN official SMALLINT NOT NULL DEFAULT 0;
-- 官方属性的 owner 语义: official=1 时 owner=''(无个人归属, 展示「官方」)
-- 一致性约束在服务端维护(owner='' 且 official=0 视为历史悬挂, 展示「未指定」)

-- 存量质量标记迁移:
--   1) quality='official' 的(当前展示版本)行 → 所属 App 置官方, owner 清空
UPDATE apps a SET official = 1, owner = ''
 WHERE EXISTS (SELECT 1 FROM app_releases r
               WHERE r.kind = a.kind AND r.app_id = a.app_id
                 AND r.status = 'approved' AND r.deleted_at IS NULL
                 AND r.quality = 'official');
--   2) quality 字段 official 值退役(只留 '' | featured)
UPDATE app_releases SET quality = '' WHERE quality = 'official';
```

> 说明：`app_releases.author/publisher`（包内署名/发布账号）不动——历史留痕在版本快照里，官方只影响 App 级归属与权限。

## 二、服务端

### 2.1 发布检查（`appstore.Publish`，唯一权限检查点）
| 场景 | 现状 | 新增 |
|---|---|---|
| 员工发布 official=1 App | （不适用） | **403 `OFFICIAL_LOCKED`「官方内容仅管理员可上传」** |
| 管理员发布 official=1 App | AdminPublish 全通过 | 不变（管理员上传新版时 owner 保持 `''`） |
| 员工发布他人 App | 404 名称不可用 | 不变 |
| 管理员「归属官方」/「转回用户」 | — | 见 2.2 |

### 2.2 归属转移端点（`PUT /api/server/admin/apps/:kind/:app_id/owner`）
- body 二选一（互斥，非法组合 400）：
  - `{"owner": "<username>"}` → `official=0, owner=<username>`（现有语义，目标用户存在校验保留）；
  - `{"official": true}` → `official=1, owner=''`（归属官方）。
- 审计沿用 `app_owner_transfer`，detail：`归属 旧 → 官方` / `归属 旧 → <username>`。
- 转移后旧负责人撤销续传权（现状一致）；官方→个人 恢复个人续传权。

### 2.3 质量端点（`PUT /api/server/admin/{shared-skills,agent-presets}/:name/:version/quality`）
- 合法值由 `''|official|featured` 收窄为 `''|featured`（官方语义移交 official 列）；`request` 校验同步（旧 official 值 400）。

### 2.4 聚合面（`/api/client/v2/capabilities`，客户端蓝标数据源）
- `CapabilityItem` 新增 `official: bool`、`downloads: int64`、`calls: int64`、`score: int64`：
  - `score = calls*3 + downloads`（聚合面统一计算，客户端排序直接读）；
  - market 行：App.official + release.Downloads/Calls（列表填充技能/智能体行）；
  - org 行：`official` 取同一 App（AppOfficialMap），downloads/calls 取自身行。
- **聚合面统一排序**（市场分区，折叠后）：`official` 降序 → `quality=='featured'` 降序 →
  `score` 降序 → `display_name` 升序兜底；「我的」分区不排序（保持原有）。
- `score` 在聚合面计算后**随行下发**（市场分区仅计算上架/已授权行，防泄漏未授权内容评分）。
  - market 行：App.official（官方行 `display_name` 仍展示，author 显示「官方」为空时不误渲染）；
  - org 行：同一 App 的 official（一次 `AppOfficialMap(db, kind)` 查询，与现有 owner map 同型）。
- `versions[]` 折叠逻辑不变（官方跨版本一致）。

### 2.5 零散面
- `listSkillsAdmin/listAgentsAdmin`（webadmin 市场列表）输出 `official` 字段（webadmin 蓝标数据源）。
- `apps` DAO：`SetAppOfficial(db, kind, appID, official, owner)`（事务内 owner 联动，防拆半）。

## 三、webadmin

| 页面 | 改动 |
|---|---|
| 能力中心 | 三个一级 Tab：**技能**（技能市场）/ **智能体**（智能体市场）/ **审批**（原「组织共享」更名）；技能页与智能体页完全独立组件，无混合容器 |
| 技能市场页 / 智能体市场页（各自组件 Marketplace.tsx 与 Agents.tsx，无混合容器） | ①卡片蓝标：`official=1` → 蓝色「官方」Badge（与「精选」灰色/金色徽章可叠加）；②**锁定管理面板**迁入（原 Capabilities LockPanel 提取为公共组件，市场页顶部「锁定管理」入口，可锁 skill/agent）；③归属按钮支持「转官方」（共用 2.2 弹窗） |
| 审批页（原 Capabilities） | 更名「审批」；**移除锁定管理面板**；质量 Select 只留「无/精选」；保留 approve/reject/delete/授权/预览/下载/归属（归属弹窗同 2.2） |
| 归属转移弹窗 | 「转给用户(搜索) / 归属官方」二选一；选官方→蓝色确认文案「官方内容仅管理员可上传新版」 |
| 用户入口校验 | 归属官方与「用户名为空/悬挂」显示「官方」而非「未指定」（列表/审计页） |

> **「我的」分区定案（客户端）**：`我的` = **已安装 + 本地制作** 全部与我相关的内容（不再只显示自制）；
> 每条按来源徽章区分（可叠加，官方蓝标叠加于商店/共享内容之上）：
> **官方（蓝）** / **市场（灰，公司商店渠道）** / **共享（绿，组织共享渠道）** / **自制（紫，本地创作）** /
> **其他安装（橙，非商店渠道安装：本地导入/手动放入）**。
> 判定：`installed && !isLocal` → 商店渠道徽章（`originChannel`=market/org；空 → 其他安装）；
> `isLocal` → 自制徽章 + 上传状态；`official=true` → 叠加官方蓝标。
> 排序：已安装组内按 `score` 降序（官方→精选→其余分层），自制组按名称升序（组内）。
> 「官方商店」= 公司整个内容市场（含普通员工内容），徽章用「市场/共享」区分渠道，官方蓝标单独叠加。

---

## 四、客户端（员工视角，scope 含客户端）

- `CapabilityCenterPanel` 市场分区拆「技能 / 智能体」子 Tab（与 webadmin IA 对齐）；
- 市场列表**按 `score` 降序排序渲染**（分层：官方→精选→其余；客户端直接用服务端下发的 `score` 字段排序，不做本地求和）；
- **「我的」分区重构**：已安装 + 自制（见上方拍板）；来源徽章 + 官方蓝标叠加；技能/智能体独立成组；技能卡片与智能体卡片各自渲染 `official=true` → 蓝色「官方」Badge（locales 新增 `capability.official`）；
- 已装官方内容的操作区：**更新按钮禁用**（tooltip「官方内容仅管理员可更新」）——服务端 403 兜底，客户端预检免除一次往返；
- 上传/预检：员工上传端点不变（org 源），官方 App 的上传在服务端被拒时展示 `OFFICIAL_LOCKED` 文案（ApiError 透传已具备）。

## 五、测试与验证

1. **服务端**：
   - `TestPublishOfficialLocked`（员工发布 official App → 403；管理员 → 通过）；
   - `TestTransferOwnerOfficial`（转官方 → official=1/owner=''；转回用户 → official=0/owner=username；`official:true`+`owner` 同时传 → 400）；
   - `TestOfficialMigration`（0059：quality=official 行 → App.official=1 + quality 清空；featured 保留）；
   - `TestQualityOfficialRetired`（PUT quality=official → 400）；
   - `TestCapabilitiesOfficial`（聚合面 official 字段：market/org 行）；
   - `TestSetAppOfficial`（DAO 事务一致性）。
2. **webadmin**：CapabilityCenter 双 Tab 断言、市场蓝标、锁定面板迁入、转移弹窗官方选项、审批去锁定、质量 Select 收窄；
3. **客户端**：CapabilityCenterPanel 蓝标渲染 + 官方内容更新禁用 + OFFICIAL_LOCKED 文案；
4. **全量门禁**：`make check` + `corepack yarn check` + PG 全包测试；管理端 UI 冒烟（CDP）与客户端组件测试。

## 六、实施步骤（每步独立提交）

1. `0059` 迁移 + serverstore `SetAppOfficial`/`AppOfficialMap` + `appstore.Publish` 官方检查（服务端核心）；
2. 归属转移端点官方语义 + 质量端点收窄 + 审计 detail；
3. 聚合面 `official` 字段 + market 列表输出；
4. webadmin：审批页改造 + 锁定面板抽出迁入市场 + 蓝标 + 转移弹窗官方选项；
5. 客户端：蓝标 + 更新禁用 + 文案；
6. 全量测试与门禁 + 双环境冒烟。
