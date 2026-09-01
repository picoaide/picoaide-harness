# 决策：技能资产按 App 模式管理——不可变版本快照 / 统一发布契约 / 应用锁定 / 客户端归属识别

日期：2026-09-01　分支：master　状态：**设计已定稿，待实施**

## 目标

把技能（及智能体预设）从「一个名字 + 一份可被随时覆盖的内容」升级为 **App Store 心智**：

- **应用（App）** 是长期存在的身份，有归属、有授权、有上下架、有锁定策略；
- **版本（Release）** 是一次性写入的**不可变快照**，任何人（含管理员）都不能改写已发布版本的内容；
- **发布（Publish）** 是唯一的内容入口，客户端与管理后台走**同一套契约、同一套校验**；
- **安装物（Installed Copy）** 自带溯源标记，客户端能准确回答「这份技能是市场上的哪个 App 的哪个版本、有没有被本地改过」。

## 一、拍板决策（2026-09-01，用户确认）

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 市场域版本模型 | **改造为多版本快照**，与组织库同构；旧单行迁移为 1 个版本 |
| D2 | 技能身份载体 | **frontmatter `name` 强制 = App ID（kebab）**，中文展示名迁移到 `title` 字段 |
| D3 | 被拒版本能否复用版本号 | **不允许**，必须升版本号；rejected 版本永久占位、保留可追溯 |
| D4 | 后台管控语义 | **锁定应用**：被锁定的 App **只能由管理员发布**，员工上传命中即明确拒绝并回显理由 |
| D5 | 发布契约 | 客户端与管理后台**字段与校验完全一致**，仅「谁能发」不同（派生自用户要求） |
| D6 | 客户端归属识别 | 包内写**溯源块**，客户端据此识别 App 归属与本地改动（派生自用户要求） |

## 二、现状与病根（2026-09-01 实测，非推断）

### 2.1 版本根本没有被当作快照

| 域 | 现状 | 后果 |
|---|---|---|
| 市场 `skills` | `name UNIQUE` 单行；`ReplaceSkillArchive` 原地 `UPDATE version+archive+checksum` | **无版本历史、无法回滚**；同一版本号在不同时间指向不同内容 |
| 组织 `shared_skills` | `UNIQUE(name, version)` 多版本 | 结构正确，但 **rejected 行允许作者用同版本号覆盖归档**（`UpdateSharedSkillResubmitWithArchive`）→ 快照被打破 |
| 智能体 `agent_presets` | 同组织库 | 同上 |

### 2.2 「本地版本 == 线上版本就拒绝」目前无从谈起

- 客户端上传只发 `{ name }`，**从不发版本号**（`CapabilityCenterPanel.tsx` 的 `upload()`）；
- host 代理把版本**硬编码兜底为 `'1.0.0'`**（`auth-gate.ts` `/api/pico/shared-skills/upload`）；
- `packSkill()` 只从 frontmatter 取 displayName/description，**version 取入参**，本地 `SKILL.md` 的 `version:` 从未参与上传；
- 于是员工第二次上传同一技能必然撞上 `1.0.0` → 409「该技能版本已被占用」，只能等被拒后覆盖重提。

**结论：不是判断逻辑写错了，是版本这一维度在上传链路上根本不存在。**

### 2.3 身份错位导致「装了用不了」（已实测量化）

上游以 `SKILL.md` frontmatter `name` 作为运行时唯一身份，且强制 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`。把线上 30 个市场技能全部真实安装后跑发现流程：

```
运行时实际发现: ["dws", "excel-sheet-summary", "skill-publish-helper"]     # 3 / 30
```

| 失效模式 | 数量 | 例 |
|---|---|---|
| A. frontmatter `name` 非 kebab（中文/空格/大写）→ 整条忽略 | 25 | `team-knowledge-wiki` → `name: 团队知识库助手` |
| B. SKILL.md 带 UTF-8 BOM → frontmatter 解析失败 | 2 | `lark-cli`、`wecom-cli`（剥 BOM 后立刻可用，证明 BOM 是唯一原因） |
| C. 可加载但运行时名 ≠ 目录名 ≠ 卡片名 | 1 | `workspace-cli` → 实际注册为 `dws` |
| D. 完全正常 | 2 | `excel-sheet-summary`、`skill-publish-helper` |

三道关卡全部放行：服务端 `ValidateSkillArchive` 只查「有 SKILL.md + 路径安全」，客户端安装器明确「已有 frontmatter 一律不动」，UI 照常显示「已安装」。**用户得到的是静默失败。**

### 2.4 元数据在两条链路上不对等

| 字段 | 市场域 | 组织域 |
|---|---|---|
| display_name | **无该列**（`0005_skills.sql`），聚合面只能 `DisplayName = s.Name` | 有，来自 frontmatter |
| tags / category / changelog | 无 | 无 |
| 上下架 enabled | 有 | **无** |
| 授权 grants | 有 | 有 |

这就是「市场卡片显示目录名、装完显示中文名」的直接原因。

### 2.5 管控能力缺口

全仓无任何「保留名 / 锁定 / 仅管理员可发布」机制；员工可以抢占任意未被占用的 App 名（包括 `org-*` 这类官方命名）。

## 三、目标模型：App / Release

```
App（应用，长期身份）
 ├─ app_id          kebab，全局唯一命名空间（市场与组织共用，杜绝跨源同名歧义）
 ├─ kind            skill | agent
 ├─ title           展示名（可中文），列表与卡片显示它
 ├─ owner           归属人（首次发布者或管理员指定）
 ├─ channel         market | org（分发渠道，不再是两套数据模型）
 ├─ publish_policy  open | admin_only        ← D4 锁定
 ├─ lock_reason     锁定理由（员工上传被拒时原样回显）
 ├─ quality         '' | official | featured
 ├─ enabled         上下架（下架保留数据，员工侧不可见不可装）
 └─ grants          用户 / 部门授权（沿用现有 grants 语义）

Release（版本快照，一次性写入）
 ├─ (app_id, version)  唯一；semver；必须严格大于该 App 现有最大版本
 ├─ archive + checksum 服务端计算 checksum，不信任客户端
 ├─ manifest 元数据    title / description / changelog / category / tags / author
 ├─ status            pending | approved | rejected（+ reason）
 ├─ deleted_at        软删（误传/敏感内容用）；**版本号永久占用，不可复用**
 └─ 不可变约束        内容字段一经写入不再 UPDATE；仅 status/quality/deleted_at 可变
```

**可见即可装的判定**（员工侧）：`app.enabled` ∧ `app` 已授权 ∧ `release.status = approved` ∧ `release.deleted_at IS NULL`。

智能体预设（`kind = agent`）纳入同一模型——能力中心已经把两者归一，数据层不应再分家。

## 四、不可变性规则（D1 + D3）

| 场景 | 结果 |
|---|---|
| 上传 `(app_id, version)` 已存在，状态 pending/approved | 拒绝 `VERSION_EXISTS` |
| 上传 `(app_id, version)` 已存在，状态 **rejected** | 拒绝 `VERSION_EXISTS`（D3：被拒也占位） |
| 上传 `(app_id, version)` 已存在但被软删 | 拒绝 `VERSION_EXISTS`（墓碑仍占位） |
| 新版本号 ≤ 该 App 现有最大版本 | 拒绝 `VERSION_NOT_INCREASING` |
| 本地内容与线上同版本 checksum 完全一致 | 拒绝 `CONTENT_UNCHANGED`（「内容与线上 vX 一致，无需上传」） |
| 管理员想改已发布版本的内容 | **无此接口**；`ReplaceSkillArchive` 原地覆盖语义删除，改为发新版本 |
| 误传/敏感内容需要撤下 | `DELETE` 软删 + 审计留痕；版本号不可复用 |

审核动作（approve/reject/质量标记/上下架/锁定）只改状态位，不触碰内容 —— 这是「快照」与「审核」能共存的关键。

## 五、统一发布契约与严格校验（D5）

一个 `publish()` 内核，两个入口复用；差异只有鉴权与默认 channel。

### 5.0 总原则：包内即真相（Package is the source of truth）

上传 API **不再接受任何元数据参数**。请求体只有 `archive` + 目标 `channel`；名称、版本、标题、描述、作者、分类、标签**全部由服务端从包内 `SKILL.md` frontmatter 解析**。理由：

- 表单值与包内容不一致时，装到用户机器上的是包内容、界面显示的却是表单值——这正是今天「市场卡片显示目录名、装完显示中文名」的同款错位；
- 客户端传入的元数据一概不可信（`author` 尤其）；
- 作者只维护一份真相（SKILL.md），发布退化为纯搬运，不存在"忘了同步表单"。

管理后台表单从此只用于：选择渠道、授权范围、质量标记、锁定开关——**不再手填名称/版本/描述/作者**。兼容期内 API 若仍显式带 `app_id`/`version`，必须与包内解析结果完全一致，否则 `MANIFEST_MISMATCH` 拒绝。

### 5.1 必填字段（缺一即拒，全部必须写在 SKILL.md frontmatter 内）

| 字段 | 规则 | 拒绝码 | 存量缺口（30 个市场技能实测） |
|---|---|---|---|
| `name` | **必须等于 app_id**；严格 kebab `^[a-z0-9]+(?:-[a-z0-9]+)*$`；2–64 字符 | `MISSING_FIELD` / `INVALID_APP_ID` / `IDENTITY_MISMATCH` | 30/30 存在，但 **27 个值非法** |
| `version` | 严格 semver `^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$`；必须 **>** 该 App 线上最高版本 | `MISSING_FIELD` / `INVALID_VERSION` / `VERSION_NOT_INCREASING` | 8 个缺失；其余 22 个恰好全合法 |
| `title` | 非空，1–100 字；**展示名（中文名放这里）** | `MISSING_FIELD` / `FIELD_TOO_LONG` | **30 个全缺**（中文名现全挤在 `name` 里，由规范化工具迁移） |
| `description` | 非空，10–2000 字（下限防占位；**上限按真实数据放宽**：它是模型侧触发文本，线上最长 958 字） | `MISSING_FIELD` / `FIELD_TOO_LONG` | 30/30 存在 |
| `author` | 非空，1–64 字；技能**署名** | `MISSING_FIELD` | 3 个缺失（三个外部 CLI 包） |
| `category` | 非空单值字符串，1–32 字（商城分类浏览依赖它） | `MISSING_FIELD` / `INVALID_TYPE` | 3 个缺失 |

> `author` 是署名，与服务端记录的 `publisher`（发布账号，取自登录态，不可伪造）**分开存两列**。二者不一致是正常的（管理员代发官方技能）。

存量补齐成本很低：`title` 由规范化工具从旧 `name` 自动迁移，`version` 缺失的 8 个补 `1.0.0`，`author`/`category` 缺失的只有 3 个。

### 5.2 条件必填与可选

| 字段 | 规则 |
|---|---|
| `changelog` | **非首个版本必填**：frontmatter `changelog` 或包内 `CHANGELOG.md` 顶部段落；≤500 字 |
| `tags` | 可选；字符串数组，≤30 个，单个 ≤32 字（线上最多 15 个） |

### 5.3 结构性校验（包本身必须满足）

1. 归档顶层存在 `SKILL.md`；
2. UTF-8 编码且 **无 BOM**（`BOM_DETECTED`）；
3. frontmatter 存在、合法 YAML、且为映射（`FRONTMATTER_INVALID`）；
4. 正文（去除 frontmatter 后）≥ 50 字符（`BODY_EMPTY`）——拒绝空壳技能；
5. invocation 策略字段若存在必须合法（`INVOCATION_INVALID`）——上游解析失败会**静默忽略整个技能**；
6. 归档安全：无越界路径、无符号/硬链接、≤16MB、解包后不超上限（沿用 `assertArchiveSafe`）；
7. **禁止包内自带溯源**：出现 `metadata.picoaide` 段或 `.picoaide/` 目录即拒（`PROVENANCE_FORBIDDEN`）——溯源块只能由安装器写入，否则归属可被伪造。

### 5.4 现行校验的口子（实测，必须收紧）

| 位置 | 现行正则 | 比运行时宽在哪 | 后果 |
|---|---|---|---|
| `marketplace/admin.go` | `^[A-Za-z0-9._-]+$` | 允许**大写**、`.`、`_` | `My-Skill` 能上架，运行时拒绝加载 |
| `sharedskills/routes.go` | `^[a-z0-9][a-z0-9._-]{0,63}$` | 允许 `.`、`_`、连续横线、尾部横线 | `my.skill` / `my_skill` 同上 |
| 两域 `versionRe` | `^[0-9a-zA-Z.-]{1,64}$` | **根本不是 semver** | `v1` / `abc` 均可入库，版本无法比较，"递增"校验失效 |

实测五个命名 `My-Skill` / `my.skill` / `my_skill` / `my--skill` / `my-skill-`：现行上传校验放行 4–5 个，**运行时 5 个全部拒绝加载**。这就是"上传成功但技能不存在"的制度性来源。

### 5.5 校验执行顺序（先便宜后昂贵，只报第一条错）

```
1 体积/编码 → 2 归档安全扫描 → 3 定位 SKILL.md → 4 BOM 与 frontmatter 解析
→ 5 必填字段与格式 → 6 身份一致性(name == app_id) → 7 溯源禁止项
→ 8 App 锁定 → 9 版本存在性与递增 → 10 内容 checksum 比对 → 11 待审配额
```

第 1–7 步是**纯包内校验、不查库**，因此可原样下沉为客户端预检：打包后立即本地跑同一套规则，在用户点「上传」之前就把问题指出来。规则一份、两处执行，服务端始终是权威。

### 5.6 错误码表（客户端原样展示 message，报文须含字段名与修复指引）

| code | HTTP | 含义 |
|---|---|---|
| `MISSING_FIELD` | 422 | 缺少必填字段 `<field>`，请在 SKILL.md frontmatter 中补充 |
| `INVALID_APP_ID` | 422 | 名称必须是小写 kebab-case（不允许大写/点/下划线/连续或尾部横线） |
| `INVALID_VERSION` | 422 | 版本号必须是 semver（如 1.2.0） |
| `FIELD_TOO_LONG` | 422 | 字段 `<field>` 超长（上限 N 字） |
| `IDENTITY_MISMATCH` | 422 | SKILL.md 的 `name` 必须等于应用 ID；中文名请放 `title` |
| `BOM_DETECTED` | 422 | SKILL.md 含 BOM，请存为 UTF-8 无 BOM |
| `FRONTMATTER_INVALID` | 422 | frontmatter 缺失或非法 YAML |
| `BODY_EMPTY` | 422 | 技能正文为空 |
| `INVOCATION_INVALID` | 422 | 调用策略字段非法，会导致技能被运行时忽略 |
| `PROVENANCE_FORBIDDEN` | 422 | 包内不得自带溯源标记（`metadata.picoaide` / `.picoaide/`） |
| `MANIFEST_MISMATCH` | 422 | 请求参数与包内元数据不一致 |
| `ARCHIVE_INVALID` | 422 | 归档结构非法或不安全 |
| `VERSION_EXISTS` | 409 | 该版本已存在（含被拒/已删），请升版本号 |
| `VERSION_NOT_INCREASING` | 409 | 版本号必须大于当前最高版本 vX |
| `CONTENT_UNCHANGED` | 409 | 内容与线上 vX 完全一致，无需上传 |
| `NAME_TAKEN` | 409 | 应用 ID 已被他人占用 |
| `APP_LOCKED` | 403 | 该应用已锁定，仅管理员可发布：`<lock_reason>` |
| `PENDING_LIMIT` | 429 | 待审数量已达上限 |

### 5.7 SKILL.md 规范模板（作者按此写即必然通过校验）

```yaml
---
name: team-knowledge-wiki          # 必填｜= 应用 ID｜小写 kebab-case｜运行时身份
title: 团队知识库助手      # 必填｜展示名，中文放这里
version: 1.2.0                    # 必填｜semver，每次发布必须递增
description: 员工手册、SSC 人事服务、报销与办公支持的知识库索引与读取规则。  # 必填｜10–500 字
author: zhangsan                       # 必填｜署名
category: 通用                     # 必填｜单值字符串
tags: [HR, 员工手册, 报销]          # 可选｜≤10 个
changelog: 补充生育报销与居转户章节。 # 非首版必填
---

# 正文（≥50 字符，不可为空壳）
```

**文件本身要求**：UTF-8 **无 BOM**、LF 行尾、`SKILL.md` 位于归档顶层。
**禁止**：`metadata.picoaide` 段与 `.picoaide/` 目录（安装器专用，包内自带即拒）。

### 5.8 路由

```
员工面   POST   /api/client/v2/apps/:app_id/releases
        GET    /api/client/v2/apps                     # 可见应用（含最新 approved 版本 + 版本列表）
        GET    /api/client/v2/apps/:app_id/releases/:version/archive
管理面   POST   /api/server/admin/apps/:app_id/releases  # 同一 body，同一校验
        PUT    /api/server/admin/apps/:app_id/lock       # { locked, reason }
        PUT    /api/server/admin/apps/:app_id/enabled    # 上下架
        POST   /api/server/admin/apps/:app_id/releases/:version/{approve,reject}
        DELETE /api/server/admin/apps/:app_id/releases/:version   # 软删
```

旧前缀（`/shared-skills`、`/marketplace/skills`、`/agent-presets`）在兼容期内保留，内部转发到新内核，客户端灰度完成后按 `internal/router` 的命名空间唯一真源约定统一下线。

## 六、应用锁定（D4）

- `apps.publish_policy = admin_only` 即锁定；员工发布命中 → `403 APP_LOCKED` + `lock_reason` 原样回显（不做本地化改写，管理员写什么员工看什么）。
- **支持预锁定**：可创建一个没有任何 release 的 App 占名（如提前锁定 `org-*` 系列官方技能名），防止员工抢占。
- 锁定与授权、上下架、质量标记**正交**：锁定只约束「谁能写」，不影响「谁能看/装」。
- 管理员发布不受锁定限制；锁定/解锁写审计 `app_lock` / `app_unlock`（含理由）。
- webadmin：能力中心列表增加「锁定」开关 + 理由输入框，列表显示锁形图标。
- RBAC：复用 `capability:write`（锁定属于能力中心管控动作）。

> 说明：本轮不引入前缀通配（如 `org-*` 批量保留）。预锁定已能覆盖「保护官方命名」的诉求，通配规则会让「谁能发」的判定变得难以预测，列为未来可选项。

## 七、客户端归属识别与本地改动检测（D6）

### 7.1 包内溯源块（双写，互为冗余）

**(a) `SKILL.md` frontmatter 的 `metadata` 段**（已实测：上游原样保留嵌套对象，且不影响技能发现）：

```yaml
metadata:
  picoaide:
    app_id: team-knowledge-wiki
    version: 1.2.0
    channel: market
    server: harness.example.com
    release_checksum: sha256:…
```

**(b) `<skill_dir>/.picoaide/release.json`**（机器可读权威源，0600，安装器写入）：包含上述字段 + `installed_at` + `archive_checksum`。它取代现有的 `.install-version` 标记文件。

### 7.2 匹配优先级

```
.picoaide/release.json 的 app_id
  → frontmatter metadata.picoaide.app_id
  → 目录名
  → frontmatter name
```

即使用户重命名了目录，客户端依然能认出归属；两处都缺失则判定为「本地原创」。

### 7.3 本地改动检测（dirty）

安装后重算技能目录的内容 checksum（排除 `.picoaide/`），与 `release_checksum` 比对：

| 状态 | 能力中心展示 | 上传按钮行为 |
|---|---|---|
| 一致 | 「来自市场 · v1.2.0」 | 置灰，提示 `CONTENT_UNCHANGED` 语义 |
| 不一致 | 「来自市场 · v1.2.0 · 已本地修改」 | 可上传，**要求先在 SKILL.md 里升 version** |
| 无溯源 | 「本地原创」 | 可发布为新 App |

**这套机制才让 D1「本地与线上一致时不允许上传」真正落地**：判据不是版本号相等，而是「版本号相等 ∨ 内容 checksum 相等」两条都拦。

### 7.4 客户端发布流程改造

- 上传前读取本地 frontmatter `version`（不再由 host 兜底 `1.0.0`）；
- 版本号未升 → 前端直接提示，不发请求（服务端仍是权威第二道）；
- 弹窗收集 `changelog`；
- 面板卡片副标题显示**运行时技能名**，避免出现 `workspace-cli` 卡片对应 `dws` 这类只有装完才知道的错位。

## 八、数据模型与迁移

| 迁移 | 内容 |
|---|---|
| `0050_apps.sql` | 建 `apps`（app_id UNIQUE、kind、title、owner、channel、publish_policy、lock_reason、quality、enabled）+ `app_grants` |
| `0051_app_releases.sql` | 建 `app_releases`（UNIQUE(app_id, version)、archive BYTEA、checksum、status、reason、changelog、category、tags、size、deleted_at） |
| `0052_apps_backfill.sql` | `skills` → 1 个 release；`shared_skills` / `agent_presets` → 多 release；三套 grants 合并进 `app_grants`；`enabled`/`quality` 平移 |
| `0053_apps_cutover.sql` | 兼容期结束后清理旧表（独立提交，不与行为变更混在一起） |

存量 30 个市场技能中 27 个不合规。**不改写历史 release**（否则自打不可变的脸），而是：

1. 迁移时把原始归档原样存为历史版本，并标记 `deprecated`；
2. 规范化工具生成 **+1 patch 的新版本**（`1.0.0` → `1.0.1`）：剥 BOM、`name` 改为 app_id、原中文名写入 `title`、补溯源块，作为新 release 正常入库；
3. 客户端对已装的老副本提示「有规范版本可更新」。

验收用第二节的实测脚本复跑：规范化后运行时发现数应为 **30/30**。

## 九、分阶段实施

| 阶段 | 范围 | 独立可上线 |
|---|---|---|
| P0 | 发布期校验（BOM / frontmatter / `name == app_id`）接入现有两条上传链路 + 错误码 | ✅ **已实施** |
| P1 | 客户端传真实版本号 + `CONTENT_UNCHANGED` + rejected 不再可覆盖（D1/D3 语义先落地） | ✅ **已实施** |
| P2 | `apps` / `app_releases` 建表 + 回填 + 统一 publish 内核 + 三域存储切换 | ✅ **已实施** |
| P3 | 应用锁定 + webadmin 管控 UI + 审计 | ✅ **已实施** |
| P4 | 溯源块 + dirty 检测 + 存量规范化 | ✅ **已实施** |
| P5 | 旧表下线 | ✅ **已实施**（迁移 0055） |

### P0 实施记录（2026-09-01）

- 新增 `server/internal/skillmanifest`：包内清单解析 + 严格校验内核（BOM、frontmatter、必填六字段、kebab 文法、semver、正文长度、invocation 合法性、溯源禁止项），导出 `IsAppID` / `IsVersion` / `CompareVersions` / `StatusFor` 与全部错误码常量；20 条单测覆盖必填矩阵与文法边界。
- 接入 `sharedskills.upload`（员工端）与 `marketplace.uploadSkillArchiveAdmin`（管理端），两端共用同一内核与同一错误码。
- `agentshare` 上传的版本号收紧为严格 semver。
- **两端的版本处理差异（有意为之）**：员工端旧客户端硬编码 `version=1.0.0`，属历史包袱而非用户意图，服务端直接以包内版本为准并忽略该字段；管理端表单的版本是显式意图，与包内不一致时报 `MANIFEST_MISMATCH`。P1 客户端改为读本地 frontmatter 后，两端统一为「以包内为准」。
- **读路径正则保持宽松**：`skillNameRe` / `versionRe` 仍用于下载/预览/审批等**读**路径，收紧它们会让存量非 kebab 命名、非 semver 版本的历史行直接 404。严格文法只作用于**写**路径。
- 测试夹具同步升级为合规包（`skillMd(name, version)` 助手），并新增管理端四类拒绝用例（中文 name / BOM / 缺 title / 版本不一致）。
- 门禁：`gofmt` + `go vet` + 18 个 Go 包测试全绿。
- **真实包回归验证**：把线上 30 个市场技能包逐个喂给新校验器，全部被拦下且原因精确——`INVALID_APP_ID` 25 个、`BOM_DETECTED` 2 个、`MISSING_FIELD(version)` 3 个，与 §2.3 的运行时实测分类逐一吻合（运行时能加载的那 3 个，同样因缺 `version`/`title` 不满足新契约，走存量规范化流程补齐）。

### P1/P3/P4 实施记录（2026-09-01）

**P1 版本即快照**
- `serverstore.ListSharedSkillVersions` 提供同名全部版本的（版本/校验和/状态/作者）摘要；
- 员工上传：同版本号存在（**含 rejected**）→ `409 VERSION_EXISTS`；与本人已提交版本内容相同 → `409 CONTENT_UNCHANGED`；版本号不大于现有最高版 → `409 VERSION_NOT_INCREASING`；**删除了 rejected 覆盖重提分支**（`UpdateSharedSkillResubmitWithArchive` 不再被调用）；跨作者防劫持 404 仍优先于版本提示，不泄露他人未公开行；
- 市场端（单行模型）先落地 `CONTENT_UNCHANGED` + `VERSION_NOT_INCREASING`；
- 客户端 `packSkill` 改为**读包内 frontmatter `version`**（缺失即报错），host 代理不再兜底 `1.0.0`。

**② 审计与预览**
- 新增市场技能后台预览：`GET /api/server/admin/skills/:name/preview`（文件清单 + SKILL.md）与 `/file?path=`（逐文件查看，越界路径拒绝），契约与共享技能一致，webadmin 复用同一个 `ArchivePreviewDialog`；
- 审计明细统一为 `name@version 「展示名」 sha256:前8位`（`sharedskills.UploadAuditDetail`，有 Go 测试锁定格式）；审计页据此正则还原预览入口，**上传类条目可当场打开归档预览**。

**P3 应用锁定（D4）**
- 迁移 `0050_capability_locks.sql`：`capability_locks(kind, name, reason, locked_by)`，**不设外键**以支持对尚不存在的名字预锁定（占名）；
- 员工上传命中 → `403 APP_LOCKED` + 原样回显管理员理由；管理员发布不受限；
- 管理端 `/api/server/admin/capability-locks`（GET/PUT/DELETE），审计 `capability_lock`/`capability_unlock`；webadmin 能力中心页新增「锁定管理」面板。

**P4 溯源与规范化**
- 安装器写 `.picoaide/release.json`（appId/version/channel/server/内容哈希/安装时间），取代 `.install-version` 的单值语义；`packSkill` **排除 `.picoaide/`**，否则重新上传会被自己的 `PROVENANCE_FORBIDDEN` 拦下；
- `computeSkillContentHash` 重算内容哈希做 dirty 判定；能力中心卡片显示「市场 vX」与「已本地修改」徽章；
- `skillmanifest.NormalizeSkillMD` + `POST /api/server/admin/skills/:name/normalize`：把存量不合规包改写为合规内容并作为 **patch+1 新版本**入库（中文 name → title、剥 BOM、补 version/author/category、剥离自带溯源块）；**拒绝编造 description**（缺失即报错要人工补写）；入库前用与上传同一套 `Parse` 自检。

### P2 实施记录（2026-09-01）

- **迁移 0053/0054**：`apps`(kind, app_id) + `app_releases`(kind, app_id, version 唯一) + `app_grants`；三张旧表与三张旧授权表一次性回填，旧表兼容期内只读保留（P5 下线）。
- **统一发布内核 `internal/appstore`**：锁定检查、版本语义（不可复用/必须递增/内容未变更）、跨渠道同名互斥、归属保护、待审配额只实现一次，三条上传路径共用。
- **落地方式是「适配层」而非重写 handler**：`serverstore` 里 `shared_skills.go` / `agent_presets.go` / `skills.go` 保留原有函数签名，内部改读写统一表。这样 4 个业务包、上百个调用点无需改动即可切换存储，行为由既有测试套件逐条保证——比逐个改 handler 风险低一个数量级。
- **授权表合并**：`SharedGrantableTable` 增加 `Kind` 维度后统一指向 `app_grants`，用户删除与部门改名的级联从「三表循环」收敛为一条语句。
- **市场因此获得多版本快照**：`ReplaceSkillArchive` 由「原地覆盖」改为「新增 Release」，市场终于有版本历史与回滚基础。
- **两处语义澄清**（迁移中暴露）：① 旧 DTO 的 `Author` 是**上传者**（全部归属判断依赖它），对应统一模型的 `Publisher`，包内署名单独存 `Release.Author`；② 版本号随内容产生——只登记元数据的 App 没有版本，避免「创建时填版本 → 首次上传同版本被自己的唯一约束挡死」。
- **跨渠道同名冲突已结构性消失**：一个 `(kind, app_id)` 只能属于一个渠道，旧的「conflict 标记 + approve 时 409 阻断」不再有产生条件（字段保留兼容）。
- 门禁：`gofmt` + `go vet` + 全部 Go 包测试 + 110 webadmin 测试全绿。

### 遗留项收口（2026-09-01 第二轮）

上一轮盘点出的缺口全部处理完毕：

- **智能体域对齐技能标准**：`agent-presets` 上传接入统一发布内核，因此获得锁定/内容未变更/版本递增/归属保护/待审配额（此前**管理员锁定对智能体完全不生效**，是真实功能缺口）；新增 `ParseAgent` 契约——展示元数据必须写在包内 `preset.yml`。注意与技能的两点差异：智能体的运行时身份是**目录名**，且上游约定 `preset.yml.name` 就是**展示名**，因此不套用技能的「name 必须是 ID」规则。
- **市场管理端上传也接入统一内核**（`AdminPublish=true`：跳过锁定与配额、发布即 approved），至此三条上传路径真正共用一份实现。
- **changelog 非首版必填**：规则依赖「是否已有历史版本」，因此落在发布内核而非清单解析。
- **客户端预检**（`packages/host/enterprise/src/manifest-precheck.ts`）：与服务端同一套规则的前 7 步、**错误码逐字一致**，打包后立即本地报错，不必等一次网络往返；8 条单测覆盖必填矩阵与文法边界。
- **智能体溯源**：安装写 `.picoaide/release.json`、打包排除该目录、能力中心显示来源与「已本地修改」，与技能同构。
- **卡片显示运行时调用名**：运行时名与应用 ID 不同时显式提示（如 `workspace-cli` → 调用名 `dws`），此前只能装完才发现。
- **webadmin 表单精简**：不再手填版本/作者/描述（包内即真相），编辑态隐藏版本字段（元数据 PUT 改版本服务端已拒绝）。
- **`conflict` 兼容残留**：改为恒 false 并注明原因（P2 后跨渠道同名结构上不可能）。

两项**经核实无需修改**：① 历史审计的 Go log-injection ×3 早已用 `safeModelForLog` 修复，其余日志只输出错误值；② `uri.ts:71` 的 ReDoS 位于 `deepseek-harness/` 只读上游子模块内，仓库规则禁止改动，属上游议题。

### 明确决定不实现的两项（附理由）

原计划里的这两项经复核判定为**投机性工作**，实现它们只会增加无人使用的维护面，故明确不做——不是遗漏：

1. **`/api/client/v2/apps/*` 新路由**：它的价值本是「给统一模型一个统一的公开面」，但统一读面**已经存在**——`/api/client/v2/capabilities` 就是跨类型跨渠道的聚合面；写入面虽仍按域分三个 URL，却已共用同一个发布内核。再加一套平行 URL 不带来任何新能力，只会让两套端点长期并存、契约与测试翻倍。**存储统一的目标已达成，URL 统一没有对应的问题要解决。**
2. **智能体的规范化端点**：规范化的存在意义是修复**契约生效之前**入库的存量数据（市场 30 个技能就是这种情况）。智能体在生产上存量为 **0**，且发布期校验已经拦住任何不合规的包——也就是说这个端点永远不会有输入。等真出现需要批量修复的历史预设时再实现，届时才知道该修什么。

**CONTENT_UNCHANGED 的可达性说明**：版本号移入包内后，「改版本必然改字节、同内容必然同版本」，因此任何重复内容都会先命中 `VERSION_EXISTS`，`CONTENT_UNCHANGED` 在现有三条路径上已不可达。保留它作为纵深防御（万一将来出现版本号由带外参数决定的发布方式），但端到端用例已按真实语义断言 `VERSION_EXISTS`。

## 十、验收标准

1. 同 `(app_id, version)` 二次上传 **100% 拒绝**，含 rejected 与已软删；
2. 版本号不递增、内容未变更两类请求各自返回专属错误码；
3. 锁定 App 的员工上传返回 403 且原样回显管理员理由；管理员发布不受限；
4. 含 BOM / 中文 `name` / `name ≠ app_id` 的归档**无法进库**（三类各一条测试）；
5. **必填字段矩阵测试**：`name`/`version`/`title`/`description`/`author`/`category` 逐个缺失各一条用例，均返回 `MISSING_FIELD` 并指明字段名；
6. **命名/版本文法测试**：`My-Skill`、`my.skill`、`my_skill`、`my--skill`、`my-skill-` 五种命名与 `v1`、`abc`、`1.0` 三种版本号全部被拒（当前实现会放行其中大多数）；
7. 包内自带 `metadata.picoaide` 或 `.picoaide/` 的归档被拒（`PROVENANCE_FORBIDDEN`）；
8. 客户端预检与服务端校验对同一个非法包给出**同一个错误码**（规则一份、两处执行）；
9. 客户端对每个本地技能能给出「归属 App + 版本 + 是否本地修改」三态；
10. 存量规范化后，30 个市场技能真机发现数 = 30（复跑 `temp/skillprobe/probe.mjs`）；
11. 门禁：`corepack yarn check` 与 `make check` 全绿。

## 十一、风险与未决

- **兼容期双写**：P2 期间新旧表并存，需保证审批动作只写一处（以新表为准，旧表只读转发），否则状态会分叉。
- **强制 `name == app_id` 是破坏性约定**：会拒绝掉 内部技能中心 现行的发布规范（`skill-publish-helper` 技能明文要求 `name` 写中文名）。**需要同步修订该技能与 GitLab 仓库的发布规范文档**，否则上游持续产出不合规包。
- **本地改动检测的边界**：技能运行时可能在自己目录里写缓存文件，会误判 dirty。落地时需要一份排除清单（`.picoaide/`、`node_modules/`、`__pycache__/` 等），或只对 `SKILL.md` + `references/` 计算 checksum。
- 智能体预设的版本号目前也由客户端兜底 `1.0.0`，与技能同病，P1 一并修。

### P5 实施记录（2026-09-01）

迁移 `0055_drop_legacy_capability_tables.sql` 下线六张旧表（`skills` / `shared_skills` / `agent_presets` + 三张旧授权表）。执行前核实三件事：0053/0054 回填完整（生产 30/30/30）、生产代码对旧表**零引用**、目标机保留下线前 `pg_dump` 备份。

下线过程中查出并修掉一处**三表合并时的漏改**：`departments.go` 的部门删除守卫仍在统计 `agent_preset_grants`——它数了三次授权，其中两次已指向 `app_grants`、第三次还落在旧表上。若直接 DROP 而不修，删除部门会在守卫查询处报表不存在。现已收敛为一次 `app_grants` 统计。同时 `sysinfo.go` 的行数统计表清单由 `skills/skill_grants` 改为 `apps/app_releases/app_grants`。
