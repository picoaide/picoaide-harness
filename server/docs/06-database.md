# 数据库

## 1. 服务端(PostgreSQL,PG-only 2026-08)

> 2026-08 起 SQLite 已全面下线:服务端数据库为 PostgreSQL(内置容器或外部实例)。
> 迁移在 `internal/serverstore/migrations-pg/`(0001–0082;0007 已废弃;0028 下线
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

### 迁移框架的已知边界:`schema_migrations` 没有校验和 + 已发布迁移被就地改写(认账,2026-09-23;事实补记与门禁判据 2026-09-26)

- **事实**:`schema_migrations` 只有 `(version, applied_at)` 两列(`internal/serverstore/migrate.go` 的
  `CREATE TABLE IF NOT EXISTS`)。runner 逐条查"版本号是否已应用",已应用的直接跳过 ⇒
  **已应用迁移文件的原地修改不会被任何机制发现**(文件内容从不参与判定)。
- **取舍**:加校验和要动迁移框架本身(建表语句 + 存量行回填口径 + 与"迁移需可重复执行"的现有
  约定交互),收益只是"能发现有人改了历史文件",成本落在每次启动的迁移路径上。
  **2026-09-23 定案:本轮不改框架**——用纪律(下一条)+ 新迁移内的 fail-loud 自检覆盖同类风险
  (2026-09-26 起另加**门禁侧**的内容指纹判据:登记表 + 守卫,见下"新增判据"一节;
  注意它是**构建期**判据,不改变"运行期仍无校验和"这个事实)。
- **缓解纪律**:**已应用的迁移文件永不原地修改**。要改形状就新开一条迁移,并在**同一条迁移的
  同一个事务内**做"形状检测 → 就地转换 → 数据搬运 → 序列复位 → 列集校验",任一步失败整条回滚。
  范例 = `0039_usage_partition_ledger.sql` 的 §0(普通表 `usage` → 分区表:改名让位索引/序列、
  按北京月建分区、`INSERT … SELECT` 搬运、`setval` 复位、多列 fail-loud 自检)。
- **代价已被真实事故验证**:`0004_usage.sql` 曾在加入 0039 的同一个提交里被原地改写成
  `PARTITION BY RANGE` 版本 ⇒ "由旧 `0004` 建库"的存量库在升级时 `CREATE TABLE IF NOT EXISTS`
  静默跳过(表已存在)、紧随的 `PARTITION OF usage` 报 `"usage" is not partitioned`,
  每次启动重跑同一条迁移、主进程 `log.Fatalf` ⇒ **崩溃循环且重试永不自愈**(2026-09-23 由
  0039 的 §0 修掉)。这条事故能潜伏这么久,正是因为"没有校验和"与"文档区间一致"都看不出来。
#### 已发生的事故清单(逐版本事实表,2026-09-26 复核补记)

复核方法与逐条命令见 `temp/r21/fix-3/notes-4.md`(441 行,含逐版本 blob 对比与
`REWRITE-OF-RELEASED` 判据:存在一个 creatordate 早于该次修改、树里已有该文件、
且 blob 不同的 tag)。**下表事实取自该复核,不要凭记忆改**:

**口径(2026-09-26 第二十二轮复核更正,"首发正式 tag"这一列的判据)**:
判定"某个 tag 有没有发过某个迁移文件"**只能读 git 树证据** ——
`git ls-tree --name-only <tag>:server/internal/serverstore/migrations-pg`(该 tag 的树里有没有它)
与 `git rev-parse <tag>:…/<文件>`(同一份 blob 吗)。**不要**用
`git tag --contains <改写前的 commit>`:2026-09-21 的历史改写让旧 commit hash 不再被任何
tag 包含,那个口径会把首发 tag 判晚(下表 `0039`/`0042` 两行原来就是这么写错的),
`0004` 行更因此把"唯一"写成了 `v2.4.0`。

| 迁移 | 首发正式 tag | 就地改写 | 改动性质 | 哪些部署会漏 |
|---|---|---|---|---|
| `0004_usage.sql` | **v2.2.0**(2026-08-25);v2.2.0 / v2.2.1 / v2.3.0 / v2.4.0 四个正式 tag 发的是**同一份**普通表正文(blob `4631669ecb4f`) | 2026-08-27(`34ddf8f8b4`、`8f8d09fe31`) | 正文改写成 `PARTITION BY RANGE` 版;v2.4.1(2026-08-27)起发的就是分区版 | **由 v2.2.0–v2.4.0 建库的实例**都拿不到分区版正文(它就是下一段那个崩溃循环的根因;不只是 v2.4.0 一家);**修复可达** —— 见"已部署库的现状与出路" |
| `0039_usage_partition_ledger.sql` | **v2.4.1**(2026-08-27;该 tag 的树里首次出现,同期 MAX 从 0037 变 0040) | 2026-09-24(`e1e3b0155b`,随 tag v2.8.2-beta.1) | 新增 §0 同事务"存量普通表 → 分区表"就地转换 + §4 三条 fail-loud 自检(+203/−2) | **不会漏**:需要 §0 的库恰好是"39 未记录"的库(升级时崩溃循环、版本不落库);已记录 39 的库其 `usage` 必然已是分区表 |
| `0042_connectors.sql` | **v2.4.2**(2026-08-28;该 tag 的树里首次出现,同期 MAX 从 0040 变 0042) | 2026-09-20(`235870948d`)、2026-09-21(`83ccbd4b6f`) | 种子行的端点/`id`/名称/描述改为公开仓占位符(+4/−1、+9/−8) | 已记录 42 的库保留升级当时的种子值;只影响**新建库**的种子行,管理员可在连接器页改回,**无数据损失** |
| `0054_apps_backfill.sql` | v2.5.9(2026-09-01) | 2026-09-24(`e1e3b0155b`) | 组织 Release 与三条授权的 `INSERT` 加"归属通道"谓词(`a.channel='org'`/`'market'`)+ 跨源同名 WARNING(+49/−3) | **从 v2.5.9 起升过级的所有实例都漏**:54 已记录 ⇒ 文件永不再被读;且它裸读的六张旧表已被 `0055` DROP ⇒ 连"重放这条迁移"都做不到(`42P01`) |
| `0055_drop_legacy_capability_tables.sql` | v2.5.9(2026-09-01) | 2026-09-24(`e1e3b0155b`) | `DROP` 六张旧表**之前**新增逐表逐行的回填完整性 fail-loud 自检(+213/−0) | 同上:旧 `0055` 无条件 DROP 过源表 ⇒ 这批库**既没有自检、也没有源表**,`0054` 里"旧表原样保留、可恢复"的承诺对它们**不成立** |
| `0063_usage_estimated.sql` | v2.7.2-beta.8(2026-09-13) | 2026-09-16(`918b835cbf`) | **仅注释**(写入方名单随死代码清理更新,+4/−3;DDL 与数据一字未动) | 已记录 63 的库读到的是旧注释;**无语义后果** |

同一判据另命中两次(未单列):`0021_user_quota.sql`、`0030_usage_cache_tokens.sql` 在
`34ddf8f8b4`(2026-08-27)各被改 1 行(同样早于它们所在 tag v2.5.0 的发布)。**未命中者**
(改动时还没有任何 tag 含它):`0062`(2026-09-12 新增、当日改,v2.7.2 于 2026-09-13 才发)、
`0082`(2026-09-25 新增、2026-09-26 改)、`0042` 的 2026-08-28 那次(v2.5.0 于 2026-08-31 才发)。

这条纪律 **2026-09-23 写下,次日 `e1e3b0155b` 就违反了它**:那一批改动**随 tag v2.8.2-beta.1
一起发布**,而该版本的发布说明对此**一字未提**。上面"代价已被真实事故验证"此前只记了 `0004`
那一次 —— 09-24 的三起与 `0042`/`0063` 是 2026-09-26 这次复核才补上的。

#### 已部署库的现状与出路(如实说明:**这部分不可自动恢复**)

- **`0054`/`0055` 的修复对已升级库不可达,且不可自动恢复**。任何从 v2.5.9 起升过级的实例,
  `schema_migrations` 里已经有 54/55 ⇒ `ApplyMigrations` 的 `if applied[…]{ continue }` 让它
  永远不再读这两个文件;旧 `0055` 又把源表 DROP 了,所以"把新正文补上去"这件事既没有触发点、
  也没有可比对的原始数据。**运维必须按下面的检测 SQL 自己评估影响面**,不要指望重启或升级自愈。
- `0039` 与 `0004` 的修复**可达**:需要 `0039` §0 的库恰好是"39 未记录"的库(版本不落库),
  升级到含新正文的版本时它会照常执行;`39` 已记录的库其 `usage` 必然已是分区表,不需要 §0。
- **仓库里没有任何重放/修复通道**:CLI 只有 `-addr`/`-data`/`-db-driver`/`-pg-dsn`/
  `-bootstrap-admin`/`-reset-mfa`/`-opens-rollup-repair-plan`/`-version`
  (`-opens-rollup-repair-plan` 是**聚合表**历史坏行的离线修复计划,与迁移无关);
  `internal/router` 零迁移端点。
- **不要试图把 `0054` 当"一次性修复脚本"重放**:它裸读 `skills`/`shared_skills`/`agent_presets`
  与三张旧授权表,而这些表在已迁移库上已被 `0055` DROP ⇒ 重放只会得到 `42P01`
  (事务回滚、不丢数据,但会挡住启动)。

##### 只读检测 SQL(在只读副本或从库上跑;逐条写明它判什么)

**① 暴露面判定(确定性;这条决定要不要往下看)**

```sql
-- 判什么:54/55 有没有被记录、记录时间是否早于那批修复。
--   两行都有且 applied_before_fix 为真 ⇒ 该库跑的是旧 0054/0055 正文,
--   那批修复对它**永不生效**(不是"以后再补",是"没有触发点")。
--   39 有记录 ⇒ 不需要 0039 的 §0(其 usage 必然已是分区表);39 无记录 ⇒ 升级即自动修复。
-- 边界时刻取 `e1e3b0155b` 的提交时间(2026-09-24T03:55:48+08:00),即那批新正文诞生的时刻;
-- 时区按部署会话时区自行折算。
SELECT version,
       applied_at,
       applied_at < TIMESTAMPTZ '2026-09-24 03:55:48+08' AS applied_before_fix
  FROM schema_migrations
 WHERE version IN (39, 54, 55)
 ORDER BY version;
```

**② `schema_migrations` 的列集合(判"运行期没有内容指纹"在该库成立)**

```sql
-- 判什么:列集合仍是 (version, applied_at) ⇒ 该库上"迁移文件被改"在运行期完全不可见
--   (这正是本节的认账事实;门禁侧的内容指纹判据见下一小节)。
SELECT ordinal_position, column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'schema_migrations'
 ORDER BY ordinal_position;
```

**③ 六张旧表是否还在(判 `0055` 的自检对这批库还有没有机会生效)**

```sql
-- 判什么:全部 present=false ⇒ 旧 0055(无自检)已经无条件 DROP 过源表,"旧表原样保留、
--   可恢复"对这批库不成立,回填完整性再也无法与源数据比对。
--   只要还有一张在 ⇒ 该库卡在 0055 之前:升级到含新 0055 的版本时,自检会 fail-loud
--   中止升级并点名冲突清单(旧表原样保留),按提示人工处置即可。
SELECT t.relname, (c.oid IS NOT NULL) AS present
  FROM (VALUES ('skills'), ('shared_skills'), ('agent_presets'),
               ('skill_grants'), ('shared_skill_grants'), ('agent_preset_grants')) AS t(relname)
  LEFT JOIN pg_class c
         ON c.relname = t.relname AND c.relnamespace = 'public'::regnamespace
 ORDER BY t.relname;
```

**④ `usage` 的形状(实证"39 已记录的库不需要 §0")**

```sql
-- 判什么:relkind='p' 且有分区 ⇒ usage 已是分区表(0039 的 §0 对它无事可做);
--   relkind='r' ⇒ 该库还没跑过 0039 —— 这正是需要 §0 的形态,升级到含新 0039 的
--   版本时会自动做同事务就地转换。
SELECT c.relname, c.relkind,
       (SELECT count(*) FROM pg_inherits i WHERE i.inhparent = c.oid) AS partitions
  FROM pg_class c
 WHERE c.relname = 'usage' AND c.relnamespace = 'public'::regnamespace;
```

**⑤ 归属错配的可观察指纹(启发式,只作排查入口,不作结论)**

```sql
-- 判什么:修好的 0054 里,channel='market' 的 App 身份只由市场表建立、其 Release 的
--   status 恒为 'approved'(市场由管理员上架);组织 Release 的 status 才原样保留。
--   所以"市场通道 App 上挂着非 approved 的 Release"是**组织版本被挂到市场 App 上**的
--   指纹(旧 0054 缺少 a.channel='org' 谓词时的形态)。
--   **已知假阳性**:升级到新发布内核之后,管理员在市场 App 上重新发布/审核也会产生
--   pending/rejected 行 ⇒ 命中只说明"值得人工看一眼",不能当结论。
SELECT a.kind, a.app_id, a.channel, r.version, r.status, r.author, r.created_at
  FROM apps a
  JOIN app_releases r ON r.kind = a.kind AND r.app_id = a.app_id
 WHERE a.channel = 'market' AND r.status <> 'approved'
 ORDER BY a.kind, a.app_id, r.version;
```

**⑥ 唯一确定性的枚举:与升级前备份对拍**

```sql
-- 在**离线副本**(把升级前备份恢复出来的那个库)上跑:列出旧 0054 会挂错、
-- 新 0054 会拒绝挂载的"跨源同名"名单(市场表与组织表同名 ⇒ 市场行占名,组织行不该并入)。
-- 判什么:名单非空 ⇒ 这些名字的组织 Release/授权在旧 0054 下被挂到了市场 App 上。
--   把名单带回本库核对是否真的错配(有行且 channel='market' ⇒ 错配成立):
--     SELECT a.kind, a.app_id, a.channel, count(*) AS releases
--       FROM app_releases r JOIN apps a ON a.kind = r.kind AND a.app_id = r.app_id
--      WHERE a.app_id IN (<上面那份名单>)
--      GROUP BY 1, 2, 3 ORDER BY 1, 2;
SELECT s.name AS app_id, 'skill' AS kind, count(*) AS org_rows
  FROM shared_skills s
 WHERE EXISTS (SELECT 1 FROM skills m WHERE m.name = s.name)
 GROUP BY s.name
 ORDER BY s.name;
```

##### 发现受影响之后怎么做(不承诺自动修复)

1. **停写并备份**:先 `pg_dump -Fc` 整库留档(与部署机既有 `deploy-backup/` 口径一致),
   确认备份可恢复;评估期间不要让新旧二进制交替服务同一根。
2. **用升级前备份在离线副本上枚举**:第 ⑥ 条只有在"源表还在"的库里才有分母 ——
   升级前备份(或另一台尚未升级的实例)是唯一能给出确定性名单的地方。把名单带回本库核对。
3. **修数据只能走新迁移**:把结论写成一条**新的**迁移(幂等 + 可重放),并在**同一条迁移的
   同一个事务内**做"形状检测 → 就地转换 → 数据搬运 → 序列复位 → 列集校验",任一步失败整条回滚
   (`0039` §0 就是范例)。**不要**改历史迁移文件,也不要手工 `UPDATE` 完就结束。
4. **审计留痕**:受影响行的判定依据、判定时间、修数据的新迁移号与执行结果,写进部署留痕与
   对应版本的发布说明;`audit_logs` 的哈希链不受本节影响,但运维动作本身要有可检索的记录。
5. **明确写上结论**:若评估后决定不修(影响面为零、或数据已无业务意义),在留痕里写清
   "评估过、结论是不需要修",而不是留白 —— 留白在下次审计里无法与"漏了"区分。

#### 新增判据(2026-09-26):迁移内容指纹登记表 + 守卫

上面那条纪律此前**只有文字、没有判据**,所以写下次日就被违反。现在有两件东西:

- **登记表** = `server/internal/serverstore/migrations-checksums.json`(**进 diff、可评审**):
  逐条登记 `migrations-pg/` 下**每一个** `.sql` 的版本号、字节数与 sha256;表头写明谁生成、
  怎么更新、为什么(它是迁移文件字节的冻结值)。
- **守卫** = `scripts/check-migration-range.mjs`(已在 `yarn check` 的根守卫
  `check:migration-range` 内,与"文档区间"判据**同一进程、同一退出码语义**:1 = 有漂移,
  2 = 扫描面/前置缺失)。判据六条:
  ① 已登记文件被就地修改 ⇒ 红(点名版本号 + 期望/实际 sha256);
  ② 新增迁移未登记 ⇒ 红(点名文件并给出登记命令 —— "新增迁移"这一步必须进 diff 被评审);
  ③ 登记表里的死条目(登记了但文件不存在)⇒ 红(删/改名同样是改写历史);
  ④ 登记表缺失 / 解析不出 / 缺表头字段 / 条目字段不合规 / **是空表** ⇒ 红(fail-closed,
     绝不静默当成空表 —— 双向:既不放过改写,也不因"表是空的"而静默通过);
  ⑤ 只做 sha256 与字节比较,**不做换行归一**(迁移正文是逐字节契约);
  ⑥ 真 git 工作树上再加一层:**登记值必须等于 HEAD 里那个文件的字节** —— 于是
     "改文件 + 顺手把登记值也改掉"这条绕过在提交之前也红(取不到 git 时只如实降级,不假装对上了)。
- **新增迁移的合法流程**(三步,缺第二步就红):
  ① 写 `migrations-pg/00NN_名字.sql` →
  ② `node scripts/check-migration-range.mjs --print-checksums > server/internal/serverstore/migrations-checksums.json`
  → ③ 文档里的迁移区间上限跟着改到新 MAX(守卫会点名每一处)。
  **永不**为了让守卫变绿去改已有条目的 sha256 —— 那正是这条判据要拦的事;要改数据请加新迁移。
- **作用域与降级(不许把"没判"说成"通过")**:内容判据只在**仓库形态的根**(有 `package.json`)
  或带登记表的根上成立;合成夹具根(`verify-check-workspaces.mjs` 的 `--root <tree>`)上守卫
  打印 `[CONTENT-SKIP]`、通过行同步写明"该判据未参与"。
- **平台差异**:根 `.gitattributes` 是 `* text=auto eol=lf`,`.sql` 被判定为文本 ⇒ 每个平台的
  checkout 都是 LF 字节(`git check-attr -a` 对迁移文件回报 `eol: lf`),所以正常检出不会误红;
  真的出现"只差 CRLF"的形态时守卫**照红**并额外提示先怀疑检出/属性被改(不把字节契约降级成
  "差不多就行")。
- **这条判据拦不住什么(认账)**:登记表本身在 diff 里 —— 若有人改了迁移文件**并且**在同一
  提交里改掉登记值,提交之后两侧自洽、门禁是绿的。那时唯一的防线是**评审**:任何对登记表
  **已有条目** `sha256` 的改动都必须按"改写历史迁移"处理(第 ⑥ 条只能挡到提交之前)。
  登记表的 `howToUpdate` 字段把"只在新增迁移时更新"写成硬纪律,就是为了让这条评审口径有出处。

#### 未来触发条件

- ① **已满足**(2026-09-24 的 `e1e3b0155b` 一批)。本次落地的是**门禁侧**冻结(上面那两件:
  登记表 + 守卫);**运行期**的 `schema_migrations` 校验和**仍未实现**(2026-09-23 的
  "不改框架"取舍没有变),所以"某个库到底跑过哪一版正文"依然只能靠 `applied_at` 与发布
  时间对照推断,不能靠库自查。
- ② 贡献者/并行分支继续增长到 review 覆盖不住历史文件(判据 = 出现过一次 review 未发现的
  文件改动);③ 需要"只在预期库形态上跑"的前置校验。实现口径:`schema_migrations`
  加 `checksum` 列,存量行以**升级时读到的文件内容**回填(不回溯校验历史),此后启动逐文件比对,
  不一致 fail-loud 点名文件(与 `scripts/check-migration-range.mjs` 对文档区间的作用互补:
  它管"文档说的上限对不对",内容指纹判据才管"文件内容被没被动过")。

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
- **回收标记 `reaping_at`(0079)**:认领 = 事务内锁行 + 复检仍过期 + 打标记（**不删行**）⇒ 删上游对象 ⇒ 带标记删行收尾。之所以不"认领即删行":认领与删上游之间进程中断时,删掉的行会让上游对象**再无凭据**（共享配额静默泄漏）;保留行 + 标记则可重入（下一轮重新认领、重删 404=成功、再收尾）。标记有 10 分钟租约(`serverstore.ReapClaimLease`):租约内不进候选列表、不被重复认领,过期后可重新认领（崩溃自愈）;并发重新登记（上传转手过期行）会清空标记 ⇒ 回收器放弃删上游对象。后台 `PurgeExpiredGatewayFiles` 跳过**任何**带标记的行（比另两处更严，因为它不删上游对象、删行会让那份对象失去凭据）；回收候选列表与管理端清理只跳过**租约内**的标记行（租约过期的可重新认领/由管理员显式删除）。**管理端删除同样要先取得认领**（2026-09-25 起，R18C-02）：与回收器共用同一条认领协议，租约内被别人持有 ⇒ `409 FILE_BUSY`（对象与行都原样保留，刷新后重试），窗口内被重新登记 ⇒ 上游对象已删但行归新一代 ⇒ `409 FILE_RECLAIMED`；**批量清理**（`POST …/files/purge`）的快照额外带**世代号**（R19A-S1-05）：清理循环是"取快照 → 逐条串行上游 DELETE"，快照之后被主人合法**续期/转手**的行世代 +1 ⇒ 该条的删除权自动作废、整条跳过（计入响应里的 `skipped`，不删上游对象也不删行）。修前快照只带 `file_id` 且认领对任意世代都成立 ⇒ 被续期的**有效文件**会被连上游对象一起删掉，而 `skipped` 计数看不见它。- **回收世代号 `reap_gen`(0081,fencing token)**:行世代号,认领时 +1、重新登记(转手/续期)时也 +1。回收器认领后持有自己那一代,并在**发上游 DELETE 之前**与**收尾删行之前**各校验一次"世代未变 + 标记仍在租约内"(`GatewayFileReapClaimHeld` / `FinishReapedGatewayFile` 的谓词):任何一次发现世代变了就放弃(行留给新一代,日志点名 `file_id` + 世代)。这样"删除权"不会被转手给新一代夺取 —— 修复前"复检 claim → 上游 DELETE 返回"之间被重新登记时,回收器会把**新上传者的上游对象**删掉而台账仍标记它有效(审计 2026-09-23 R4-C-1 确定性复现)。同族:`ClaimExpiredGatewayFile` 的世代号在同一句 `UPDATE … RETURNING` 里 +1 并回读,避免"先读后写"的竞态。
**认账残留**：④`PurgeExpiredGatewayFiles` 只清台账行、不删上游对象 —— 新上传的对象由上游按 `expires_after` 自行到期，所以不长期泄漏；但改造前的"永久"老行若被本函数先一步清掉行，那份上游对象就再无凭据（靠回收器的 `NormalizeLegacyPermanentGatewayFiles` + 认领流程尽量先处理，属已认账的窗口）。

### report_subscriptions(0056;0082 加待补期号与重试退避)

月度用量报表订阅:`{id, name, enabled, hook_url, last_run_at, last_error, created_at, updated_at}`。
`last_run_at` = **最近一次成功**投递的时刻(失败不推进它 —— 否则失败的那一期在本月内永不重投,R18C-03)。

**0082 起三列**(R19A-S1-06/S1-07,审计 2026-09-25):
- `pending_period TEXT`(`YYYY-MM`,北京月):"最早未成功投递的那一期"。失败时**首次写入、之后不覆盖** ⇒ 失败跨过月界时下一轮仍补投**那一期**,
  不会静默跳期(修前只能从 `last_run_at` 反推"上一月",跨月即丢期);补投成功且期号相符时清空。
- `fail_streak INTEGER`:连续失败次数(成功清零)。
- `next_attempt_at TIMESTAMPTZ`:退避窗口的"最早可再试时刻";调度器的候选判据是
  `pending_period 非空 ⇒ 补那一期`,否则"本月未成功 + 已过退避窗口"才投当前期的上一期。
  退避形态 = **首次 1 小时、之后 24 小时**(永久坏的 webhook 收敛到 1 次/天/实例,修前 = 每 tick 一次 = 24 次/天)。
- 投递前按订阅 id 取 PG **advisory lock** 认领(`pg_advisory_lock(int4,int4)`,classid 见 `internal/reports/delivery_policy.go`);
  取不到 = 另一个实例正在投它 ⇒ 本轮跳过(所以**多实例部署不会重复投递**同一期),不是失败。

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
