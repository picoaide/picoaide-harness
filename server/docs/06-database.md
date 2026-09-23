# 数据库

## 1. 服务端(PostgreSQL,PG-only 2026-08)

> 2026-08 起 SQLite 已全面下线:服务端数据库为 PostgreSQL(内置容器或外部实例)。
> 迁移在 `internal/serverstore/migrations-pg/`(0001–0081;0007 已废弃;0028 下线
> 知识库/MCP 表并独立审计表 audit_logs;0039 usage 按月原生分区 + 日/月账本;
> 0040/0041 归档直存 DB;0042 connectors;0043/0044 provider protocol;
> 0045 glitchtip 下架;0046 rbac 角色;0047 brand 快照;0048 审计哈希链;
> 0049 按模型并发峰值 model_concurrency_stats;0050-0052 能力中心/用量中心与
> 报表订阅;**0053-0055 统一应用模型(`apps`/`app_releases`/`app_grants` 建表 → 回填 → DROP 掉
> `skills`/`shared_skills`/`agent_presets` 与三张旧授权表,见下「apps」一节)**;
> 0056 报表订阅;0057 密码改密字段 + 管理员 MFA(admin_mfa_challenges);
> 0058 模型输入模态 `models.input_modalities`;0059 能力中心「官方」`apps.official`;
> 0060 LDAP 目录同步标记 ldap_synced_users(OIDC 用户不再被 LDAP 对账误停);
> 0061/0062 员工账户余额与账本(`users.balance_money`/`balance_ledger`,唯一计费
> 闸门);0063 `usage.estimated`;0064 TOTP 防重放(`users.last_totp_step`);
> 0065 `usage.provider_id`;0066 管理会话只存哈希(`admin_sessions.secret_hash`);
> 0067 外部身份绑定(`users.external_id`/`external_source`);0068 客户端错误上报状态;
> 0069-0072 WASM 应用平台与员工会话(应用登记/员工会话/访问级别/调用事件证据);
> **0073 删除应用会话与员工会话表(`app_sessions`/`employee_sessions`)、0074 把存量
> `access='public'` 改写为 `login`、0075 应用打开计数(`wasm_app_opens` 明细 +
> `wasm_app_opens_daily` 日汇总)、0076 `usage.app_id`(应用维度归因)、
> 0077 网关 Files API 归属台账 `gateway_files`、0078 台账容量字段与清理索引、
> 0079 回收标记 `gateway_files.reaping_at`(2026-09-22)、0080 模型目录缺失标记
> `models.catalog_missing`、0081 回收世代号 `gateway_files.reap_gen`(2026-09-23,fencing token)** —— 前三条(0073-0076)随
> 2026-09-19「WASM 应用客户端专属」改造落地(应用子域/换票/匿名面/服务端 `ai.chat`
> 同批删除,见 03-api-reference.md §11b),0077-0079 随 2026-09-22 网关文件直通、归属隔离与「按员工看占用 + 清理」落地
> (见下 `gateway_files`),0081 随第四轮审计 R4-C-1 的回收器 fencing 落地
> ——以 `migrations-pg/` 目录实际文件为准)。

### 迁移框架的已知边界:`schema_migrations` 没有校验和(认账,2026-09-23)

- **事实**:`schema_migrations` 只有 `(version, applied_at)` 两列(`internal/serverstore/migrate.go` 的
  `CREATE TABLE IF NOT EXISTS`)。runner 逐条查"版本号是否已应用",已应用的直接跳过 ⇒
  **已应用迁移文件的原地修改不会被任何机制发现**(文件内容从不参与判定)。
- **取舍**:加校验和要动迁移框架本身(建表语句 + 存量行回填口径 + 与"迁移需可重复执行"的现有
  约定交互),收益只是"能发现有人改了历史文件",成本落在每次启动的迁移路径上。
  **2026-09-23 定案:本轮不改框架**——用纪律(下一条)+ 新迁移内的 fail-loud 自检覆盖同类风险。
- **缓解纪律**:**已应用的迁移文件永不原地修改**。要改形状就新开一条迁移,并在**同一条迁移的
  同一个事务内**做"形状检测 → 就地转换 → 数据搬运 → 序列复位 → 列集校验",任一步失败整条回滚。
  范例 = `0039_usage_partition_ledger.sql` 的 §0(普通表 `usage` → 分区表:改名让位索引/序列、
  按北京月建分区、`INSERT … SELECT` 搬运、`setval` 复位、多列 fail-loud 自检)。
- **代价已被真实事故验证**:`0004_usage.sql` 曾在加入 0039 的同一个提交里被原地改写成
  `PARTITION BY RANGE` 版本 ⇒ "由旧 `0004` 建库"的存量库在升级时 `CREATE TABLE IF NOT EXISTS`
  静默跳过(表已存在)、紧随的 `PARTITION OF usage` 报 `"usage" is not partitioned`,
  每次启动重跑同一条迁移、主进程 `log.Fatalf` ⇒ **崩溃循环且重试永不自愈**(2026-09-23 由
  0039 的 §0 修掉)。这条事故能潜伏这么久,正是因为"没有校验和"与"文档区间一致"都看不出来。
- **未来触发条件(满足任一条就实现校验和)**:① 再出现一次"已应用迁移被原地修改"的事故
  (无论是否造成停机);② 贡献者/并行分支继续增长到 review 覆盖不住历史文件(判据 = 出现过一次
  review 未发现的文件改动);③ 需要"只在预期库形态上跑"的前置校验。实现口径:`schema_migrations`
  加 `checksum` 列,存量行以**升级时读到的文件内容**回填(不回溯校验历史),此后启动逐文件比对,
  不一致 fail-loud 点名文件(与 `scripts/check-migration-range.mjs` 对文档区间的作用互补:
  它管"文档说的上限对不对",校验和才管"文件内容被没被动过")。

### users(0001, 0046 起 role 取代 is_admin)
| 列 | 说明 |
|----|------|
| id | PK 自增 |
| username | 唯一,登录名 |
| display_name / email | 显示名/邮箱 |
| password_hash | argon2id 哈希(local 模式) |
| source | `local` \| `ldap` \| `oidc`,默认 local |
| is_admin | 0/1(兼容列;0046 起不再写入新值,历史 dump 兼容) |
| role | 0046 新增:`super_admin` \| `auditor` \| `user`(默认,用户创建时写入;回填 is_admin=1→super_admin) |
| status | 1=启用 |
| quota_tokens | 0021 新增,月流量配额三态:NULL=跟随全局默认(`usage.monthly_quota`),0=不限,>0=按月限额;admin 一律豁免(网关强制) |
| password_changed_at | 0057:上次改密时间(创建时 NULL = 从未改密;展示/审计用) |
| password_must_change | 0057:1=下次登录强制改密(管理员重置密码置位,改密成功清除;期间业务 API 403 `PASSWORD_CHANGE_REQUIRED`) |
| totp_secret | 0057:管理员 TOTP 密钥 AES-GCM 密文(master key;'' = 未配置;绝不返回明文) |
| totp_enabled | 0057:1=管理员双因素认证已启用(verify 成功才置位) |
| quota_money | 0022 新增,月金额配额三态:NULL=跟随全局默认(`usage.monthly_quota_money`),0=不限,>0=按月金额上限(元);admin 一律豁免(网关强制) |
| created_at / updated_at | timestamptz |

### groups + user_groups(0001, 0017 起为部门实体)
`groups(id, name 唯一, parent_id(0=顶层), leader_id, description, budget_money)`;`user_groups(user_id, group_id, PK 复合)`。组用于技能/共享内容授权与部门预算(本地账号无组映射,以用户级授权兜底)。
- 0017 部门树:parent_id 任意层级、leader_id 主管;员工部门归属(`users/:id/department`,2026-09 起支持多部门:`group_ids` 数组);权限继承 = 归属部门+祖先链 + 主管部门子树 + 隐式「全员」组。
- 0024 新增 `budget_money REAL`(部门月度金额预算,元):约束该部门树(含全部子部门)成员当月费用合计;员工生效预算 = 归属部门 + 祖先链(链上全部预算都约束,父部门 = 子树封顶);任一超限网关 429。费用聚合 `DeptMonthlyCost`/`DeptMonthlyCostBatch`(部门树 SUM(cost))。

### settings(0001)
`settings(key PK, value)`。键: `auth.mode` / `ldap.*` / `oidc.*` / `openid.*` / `auth.enabled` / `gateway.default_model` / `gateway.rate_limit` / `gateway.max_file_refs`(单请求 file_id 引用上限,缺省 600=官方单请求最多 600 张图) / `gateway.body_parse_budget_mb`(在飞请求体字节预算 MiB,缺省 128) / `gateway.file_expiry_days`(网关强制执行的文件保留上限天数,缺省 7,范围 1~30) / `usage.monthly_quota`(员工默认月 token 配额,0=不限)/ `usage.monthly_quota_money`(员工默认月金额配额,元,0=不限)/ `usage.peak_windows`(高峰时段 JSON,北京时间,空=无峰谷价)/ `usage.retention_months`(明细保留月数,默认 6)/ `web.default_thinking_level` / `web.error_reporting_*` / `web.glitchtip_*` / `server.base_url` / `audit.retention_days`(默认 180)等(见 04-auth.md、03-api-reference.md)。

### api_tokens(0002)
`id, user_id→users, token_hash(唯一), name(默认 'desktop'), created_at, expires_at(NOT NULL), last_used_at, revoked(0/1)`;索引 `idx_tokens_user`。明文 token 不落库,只存哈希;90 天过期。

### gateway_providers + models(0003)
- `gateway_providers(id, name 唯一, base_url, api_key_enc, models JSON '[]', enabled 0/1, protocol('openai'|'anthropic'|'both',0043/0044))`——`api_key_enc` 为 AES-GCM 密文(`enc:v1:`)。
- `models(id, name 唯一, provider_id→providers, display_name, default_params JSON '{}')`。
- 0022 新增 `input_price_per_1m REAL` / `output_price_per_1m REAL`(元/百万 token):NULL/0 = 未定价,费用按 0 计(页面标注「未定价」);embedding 复用 input 价。
- 0023 新增 `offpeak_discount REAL`(低谷折扣率):0<d<1 = 高峰窗口外费用 × d;nil/1 = 无峰谷价。
- 0029 新增 `cache_input_price_per_1m`(缓存命中输入价):nil = 回退 input 价。
- 0030 usage 新增 `cache_prompt_tokens`(缓存命中输入 token 计数,按 0029 价计费)。

### usage(0004, 0039 起按月原生分区)

`usage` 主表 `PARTITION BY RANGE (created_at)`(PK 含 created_at),按月份分区
`usage_YYYYMM`(ensureUsagePartition 幂等创建);主表索引 PG16 自动传播。
列: `id, user_id, model, prompt_tokens(BIGINT), completion_tokens(BIGINT),
cache_prompt_tokens(BIGINT), kind, cost(DOUBLE), created_at`;索引
`idx_usage_user_time / idx_usage_time / idx_usage_model_time / idx_usage_kind /
idx_usage_user_cost`。写路径 `RecordUsage*` 先 ensure 当月分区。

**保留策略**: settings `usage.retention_months`(默认 6,0=永久,1~120)。
**执行者 = `internal/usageretention` 周期调度器**(启动先跑一轮 → 每 6 小时一次 → 随 ctx 退出;
`PUT /api/server/admin/gateway` 保存保留期时额外立即触发一次)—— 不要再写成「启动时清理一次」,
那正是 2026-09-23 审计 R5-A-11 的缺陷形态(稳态运行的实例里保留期不生效、明细随月份单调增长);
同一形态在审计侧已由 `internal/auditretention` 修好(R4-D-4)。
`CleanupUsageRetention` 逐个处理早于 cutoff 的月分区:**先补账再 `DETACH PARTITION + DROP TABLE`**
秒删过期明细。两条写实口径(2026-09-23 审计 R5-A-9 / R5-A-10):
① 补账**不要求该月分区形态就绪** —— 形态异常(错界 / 边界读不懂 / 二级分区)只影响"该月能否接收新写入",
   不得让整轮清理中止(旧实现因此永久停摆,只能人工 DROP);异常分区仍**点名**到日志,并按其**实际边界**
   扩大补账窗口后再 DROP(错界分区可能持有相邻北京月的行)。
② **只为"该月确实有明细"的月份建明细分区** —— 否则"保留期调小(旧月分区被 DROP)后调大 + 重启补算"
   会为这些月建出空分区,而聚合按"分区在 ⇒ 读明细"判据读到空表,永久账本里的金额被静默隐藏
   (真 PG 实测 聚合 0.0000 / 账本直读 3.0000);聚合侧另有纵深防御:分区为空且账本该月有行时回落账本。
网关每次调用计量写入;`CleanupPendingUsage` 清理挂起记录(全零待定行)。月度聚合:`UserMonthlyUsage`(当月 SUM,走索引)/ `UserMonthlyUsageBatch`(管理页批量附用量)。**2026-09-11**:员工 token 配额判定(`EffectiveQuota`)已下线,网关唯一闸门是账户余额(`BalanceBlocked` → 429 `BALANCE_EXHAUSTED`)。
- 0022 新增 `cost REAL DEFAULT 0`:记录时按模型定价折算的金额(元),后续改价/删模型不重写历史;统计与余额扣减统一读 `cost`。月度费用聚合:`UserMonthlyCost`/`UserMonthlyCostBatch`;**2026-09-11**:金额配额判定(`EffectiveMoneyQuota`)已下线,消费改为在写 usage 的同一事务里结算到账户余额(`settleUsageCostTx` → `balance_ledger`)。
- 0023 新增 `models.offpeak_discount REAL`(低谷折扣率):结合 settings `usage.peak_windows`(高峰时段 JSON,北京时间,如 `[{"start":"09:00","end":"12:00"},{"start":"14:00","end":"18:00"}]`)——高峰窗口外(空闲时段)费用 × 折扣率;DeepSeek 官方当前政策(2026-08-16 生效)高峰 = 北京 09:00-12:00、14:00-18:00,空闲价 = 高峰价 × 50%(含缓存命中价)。历史 16:30-00:30 错峰政策已废弃,可在网关页自行配置。

### apps(0053) + app_releases(0053) + app_grants(0053)——统一应用模型

技能与智能体自 2026-09-01 起是**一套模型**：App（长期身份）+ Release（不可变版本）+ Grant（授权）。
0054 把三张旧表（市场 `skills`、组织 `shared_skills`、组织 `agent_presets` 及其三张授权表）完整回填
进来，**0055 把那六张旧表 DROP 掉** —— 它们**已经不存在**：照旧文档写
`SELECT … FROM skills` / `FROM shared_skill_grants` / `FROM agent_preset_grants` 只会拿到
`relation "…" does not exist`，授权语义现在**只**落在 `app_grants`。

- `apps(kind, app_id, title, description, owner, channel, enabled, official, created_at, updated_at,
  purpose, data_sensitivity, config_json, current_release_id, frozen_at, deleted_at)`，
  `PRIMARY KEY (kind, app_id)`；`kind ∈ {skill, agent, wasm_app}`、`channel ∈ {market, org, wasm}`
  （0069 放开 CHECK 并给 WASM 应用平台复用本表：`config_json` 存 `picoaide.app.json`、
  `frozen_at`/`deleted_at` 承载冻结与软删；0071 删掉 `visible` 列 —— 访问模式只存
  `config_json.access`）。`owner` = **首个成功发布者**（0053 的 `COALESCE(NULLIF(owner,''),…)`
  语义：一经写入不被后续发布改写）；0059 起官方内容 `official=1` 且 `owner=''`。
- `app_releases(id, kind, app_id, version, title, description, changelog, category, tags, author,
  publisher, checksum, size, archive BYTEA, status, reason, quality, downloads, calls, config_json,
  assets_dir, deleted_at, created_at, updated_at)`，`UNIQUE (kind, app_id, version)`，
  外键 → `apps(kind, app_id)` ON DELETE CASCADE。`status ∈ {pending, approved, rejected}`
  （市场渠道由管理员发布 ⇒ 直接 approved；组织渠道进 pending）；`quality ∈ {'', 'featured'}`
  （0059 起 `'official'` 退役，官方语义移到 `apps.official`）；`deleted_at` = **软删**
  （版本号永久占用、不可复用）；`archive` 直存归档字节（上传是唯一入口）；`downloads`/`calls` 计数。
- `app_grants(kind, app_id, grantee_type, grantee)`，
  `PRIMARY KEY (kind, app_id, grantee_type, grantee)`，`grantee_type ∈ {user, group}` ——
  组织内容**唯一**的授权表（授权后可见可装，admin 恒全量不落表）。0055 之前的
  `skill_grants` / `shared_skill_grants` / `agent_preset_grants` 三张表已随 0055 删除。
- 状态机（组织渠道）：上传 → pending；admin approve → approved；reject（必填 reason）→ 仅作者可见可重提；
  同名不同版本独立审核。pre-0040/0041 的老行归档走磁盘只读回退（`data/skills-cache/`、
  `data/shared-skills-cache/`、`data/agent-presets-cache/`，`cmd/server/main.go` 仍会创建这三个目录）。

### admin_sessions(0009)
`id(PK, 随机), user_id, csrf_key, expires_at, last_used_at(0046:12h 硬上限 + 60min 空闲滑动到期)`。管理端 12h 会话 + CSRF 校验(见 04-auth.md §4)。

### audit_logs(0028, 0048 哈希链)
`id, username, action, detail, created_at, prev_hash, hash`(0048:hash = sha256(prev|username|action|detail|created_at) 链式防篡改)——用户/部门/技能/令牌等敏感操作审计(默认保留 180 天,settings `audit.retention_days` 可配;清理的**执行者**=`internal/auditretention` 调度器:启动先跑一轮、之后每 6 小时一次,管理员保存该设置时另立即触发一次)。由 0008 的 `kb_audit_logs` 迁入数据后清除旧表。

### brand_snapshots(0047)
`id, created_at, data`——每次 brand_update 保存前一版配置 JSON(保留最近 10 份),供「恢复上一版本」。

### connectors(0042)
`id, name, description, auth_mode(oauth|device|token|server-side), definition JSON, enabled, updated_at, created_at`——连接器唯一目录源,经 bootstrap `connectors[]` 下发;种子 example-org/sales-easy(glitchtip 0045 下架,不再下发)。

### gateway_files(0077 + 0078,网关 Files API 归属台账与容量视图)
`file_id(PK), user_id→users(ON DELETE CASCADE), created_at, expires_at, size_bytes(0078), reaping_at(0079), reap_gen(0081)`;索引按 `(user_id, created_at DESC)`、`(user_id, expires_at)`、`(expires_at)`、`(expires_at, created_at)`。
- 0078 的 `size_bytes` 只用于**容量统计与排序**（OpenAI 形状 `bytes` / Anthropic 形状 `size_bytes`；取不到记 0，升级前的老行同为 0 = 未知），不参与归属判定。

网关 `/v1/files`(`/files` 同)是官方 Files API 的直通面(上传/列出/下载/删除),而上游按 **API key** 隔离文件——公司内所有员工共用同一把 key,所以「谁能读哪个 file_id」这件事上游不知道。此表是平台侧的归属账本:上传成功即 `RecordGatewayFileSize` 记 `(file_id, user_id, expires_at, size_bytes)`,归属规则见下一条(**存活行不转手、过期行可被重新占用、永久行永不转手**)——早期版本这里写的"首次写入者胜"只对存活行成立,已按实现更正。

- 聊天体里出现 `file_id` 引用时,批量 `GatewayFilesOwnedBy` 一次问清:非本人(含行已过期)一律 404 `file_id not found or expired`(不泄露存在性),防止员工 A 拿着员工 B 上传后的 id 直接把对方文件读进自己的对话。
- `expires_at` = min(上游返回的过期时间, 上传时刻 + `gateway.file_expiry_days`);上游那侧也由网关**重写上传体**收敛到同一上限(见 03-api-reference §5);过期行视为**不存在**——既不再授权读取,也**允许他人重新占用同名 id**(`RecordGatewayFile` 的 `ON CONFLICT … WHERE (user_id = EXCLUDED.user_id OR expires_at <= now()) AND (reaping_at IS NULL OR reaping_at < now() - 租约)`:存活行不转手防"重传抢归属",过期行可转手防"上游按内容去重时第二个上传者引用自己的文件 404";永久文件永不转手)。**0081 起多一道判据**:认领标记仍在租约内的行**拒绝转手**并返回 `serverstore.ErrGatewayFileReapClaimed`(`/v1/files` 上传路径据此回 503,客户端回落 base64 内联)—— 那份上游对象正在被回收器删除,把行转给新上传者会让"新上传者的对象被删掉、台账却说他有效"(审计 2026-09-23 R4-C-1)。租约过期后的转手照旧允许,但会推进下面说的世代号。
- 容量与回收:官方限制是**每 key 25 GiB / 10000 个文件**(公司级共享,非按人)。过期行有两条收敛路径:①`PurgeExpiredGatewayFiles`(同一事务内 `SELECT … FOR UPDATE SKIP LOCKED` → `DELETE`)只清台账;②网关的**文件回收器**(`internal/llmgateway/files_reaper.go`,启动先跑一轮、之后每 5 分钟)先 `ClaimExpiredGatewayFile`(事务内 `FOR UPDATE` + 复检仍过期)再删上游对象,失败按快照写回台账行留待下轮。`ListGatewayFileIDs` 供列表过滤用途(上限 20000 行)。
- 管理面另有 `size_bytes` 汇总与清理索引(0078):按员工看占用、按员工/状态过滤与按过期时间排序都走这些索引。
- **回收标记 `reaping_at`(0079)**:认领 = 事务内锁行 + 复检仍过期 + 打标记（**不删行**）⇒ 删上游对象 ⇒ 带标记删行收尾。之所以不"认领即删行":认领与删上游之间进程中断时,删掉的行会让上游对象**再无凭据**（共享配额静默泄漏）;保留行 + 标记则可重入（下一轮重新认领、重删 404=成功、再收尾）。标记有 10 分钟租约(`serverstore.ReapClaimLease`):租约内不进候选列表、不被重复认领,过期后可重新认领（崩溃自愈）;并发重新登记（上传转手过期行）会清空标记 ⇒ 回收器放弃删上游对象。后台 `PurgeExpiredGatewayFiles` 跳过**任何**带标记的行（比另两处更严，因为它不删上游对象、删行会让那份对象失去凭据）；回收候选列表与管理端清理只跳过**租约内**的标记行（租约过期的可重新认领/由管理员显式删除）。- **回收世代号 `reap_gen`(0081,fencing token)**:行世代号,认领时 +1、重新登记(转手/续期)时也 +1。回收器认领后持有自己那一代,并在**发上游 DELETE 之前**与**收尾删行之前**各校验一次"世代未变 + 标记仍在租约内"(`GatewayFileReapClaimHeld` / `FinishReapedGatewayFile` 的谓词):任何一次发现世代变了就放弃(行留给新一代,日志点名 `file_id` + 世代)。这样"删除权"不会被转手给新一代夺取 —— 修复前"复检 claim → 上游 DELETE 返回"之间被重新登记时,回收器会把**新上传者的上游对象**删掉而台账仍标记它有效(审计 2026-09-23 R4-C-1 确定性复现)。同族:`ClaimExpiredGatewayFile` 的世代号在同一句 `UPDATE … RETURNING` 里 +1 并回读,避免"先读后写"的竞态。
**认账残留**：④`PurgeExpiredGatewayFiles` 只清台账行、不删上游对象 —— 新上传的对象由上游按 `expires_after` 自行到期，所以不长期泄漏；但改造前的"永久"老行若被本函数先一步清掉行，那份上游对象就再无凭据（靠回收器的 `NormalizeLegacyPermanentGatewayFiles` + 认领流程尽量先处理，属已认账的窗口）。

### model_concurrency_stats(0049,按模型并发峰值)
`model, day(UTC), max_concurrency, peak_at`——`PRIMARY KEY(model, day)`。网关内存 in-flight 计数每 15s 采样落库;`max_concurrency` 用 `GREATEST` 累计(永不回退),`peak_at` 记录首次触发峰值时刻。供管理后台「服务器信息 → 模型并发」展示(当前/90 天峰值/目标),是向模型上游申请扩容的量化依据。目标值配置在 `models.default_params` 的 `concurrency_target`(如 flash 2500 / pro 500),不在此表。

## 2. 客户端(历史说明:早期自研 Electron 客户端的 SQLite 存储)

> 早期(2026-08 前)自研 Electron 客户端(desktop/)使用本地 SQLite(4 张业务表 + schema_migrations),该客户端已下线,存储随之下线;当前桌面客户端(shop 桌面客户端)的会话/设置由官方 DSH 与本地 profile 管理,不再自建业务表。以下为历史表结构存档:

| 表 | 列 | 说明 |
|----|----|------|
| conversations | id, title(默认 ''), mode(默认 'ask'), status(默认 'done'), model(默认 ''), workspace(默认 ''), created_at, updated_at | 会话;status 为中断恢复标记 |
| messages | id, conversation_id(CASCADE), role, content, reasoning(默认 ''), tool_calls JSON '[]', tool_call_id, tool_name, is_error(0/1), created_at | 消息;工具调用链与错误标记;索引 idx_messages_conv |
| artifacts | id, conversation_id(CASCADE), path, type(默认 'file'), size, created_at | 产物登记(磁盘产物路径) |
| settings | key PK, value | 可访问目录/建议安装管理等 |
| admin_mfa_challenges | 0057:两步行登录/开启 MFA 的一次性挑战(id PK, user_id, kind, secret, attempts, expires_at, used_at;5 分钟/60 秒有效,失败 ≥5 作废) |
| schema_migrations | version PK, applied_at | 迁移记录 |

### usage_daily / usage_monthly(0039,永久账本)

- **usage_daily 日账**: `PARTITION BY RANGE (day)` 按年分区(`usage_daily_YYYY`),
  `UNIQUE(user_id, model, day)`;列 `prompt_tokens/completion_tokens/cache_prompt_tokens/requests/cost`。
  **永久保留**(不随明细删)。
- **usage_monthly 月账**: 普通表 `UNIQUE(user_id, model, month)`(月初日期),
  聚合日账生成,**永久保留**(最终兜底,10 年 + 不删)。
- **生成**: `RebuildUsageLedger(from,to)` 从 usage 明细 UPSERT 日账/月账
  (幂等,可重算);启动时补算最近 N 个月(自愈),每日任务亦可调用。
- **查询路由**: 保留窗口内(近 N 月)查 usage 明细(分区裁剪);窗口外历史
  查 usage_daily/usage_monthly;用户全历史累计查 usage_monthly。
- **部门归因**: 账本仅存 user_id(无部门快照),按当前部门树
  (user_groups + groups.parent_id)现场计算。
