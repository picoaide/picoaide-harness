package serverstore

// R13-GH3 · H1（`search_path` 同族「第三条路径」）：**判据面必须是整个 `server/`，不是一个包**。
//
// 被审形态（V13-B 独立验证）：
//
//	$ grep search_path server/internal/llmgateway/*.go      → 零命中
//	$ grep -rn --include=*.go -E "\b(FROM|JOIN|INTO|UPDATE|DELETE FROM|TABLE)\s+…" server/ \
//	    | grep -v '^server/internal/serverstore/'
//	  internal/llmgateway/models.go:30   FROM models m JOIN gateway_providers p …
//	  internal/llmgateway/admin.go:645   FROM models WHERE provider_id = ?
//	  internal/llmgateway/upstream.go:100 SELECT id, name, base_url, api_key_enc … FROM gateway_providers …
//	  internal/llmgateway/upstream.go:146 SELECT name FROM models …
//
// 而 `audit_r12_n2_searchpath_test.go` 的文件面是 `filepath.Glob("*.go")` —— **只看本包**。
// 于是同一族关系的第三条路径（上游路由与密钥、模型目录、provider 配置快照）既没 pin、
// 也不在任何机械判据里；真 PG + 敌对 search_path 下 `llmgateway.ListModels` 读到 shadow
// 的诱饵模型（V13-B 探针实跑红）。同族还有一个"SQL 在 A、裸池在 B"的形态：
// `sync.go` 把裸 `*sql.DB` 传给 `syncedModelNames`（SQL 在 upstream.go）—— 只扫 SQL
// 文本的判据看不见它，所以本守卫同时用**类型**兜底（见下）。
//
// 本文件是"面"的守卫，与包内的 `audit_r12_n2_searchpath_test.go`（"深度"守卫）分工：
//
//	深度守卫：包内 89 个族内 SQL 函数逐个登记 pin 模式（`r13geSearchPathInventory`）；
//	面守卫（本文件）：① 文件面 = 整个 `server/`（非测试 Go 源，排除 Go 工具链语义上的
//	  `testdata/` 与 gitignore 的 scratch 目录）；② **包登记表** —— `server/` 下每个含非测试
//	  Go 源的目录都必须显式登记，新增包不登记即红；③ **关系登记表** —— 族内关系集合是显式
//	  数据（尺子由它派生，见 `r13geFamilyRelRe`），且 `migrations-pg/*.sql` 建出来的**每一张**
//	  表都必须登记（族内 / 显式已知不覆盖 / 非族内带理由）⇒ 新增关系不登记即红；
//	  ④ 包外族内函数的 pin 模式登记 + 包外**禁裸事务**；⑤ fail-loud 下限与自检（尺子坏掉
//	  不能静默通过）。
//
// 判据共用同一把尺子：正则/注释剥离/pin 记号全部复用 `audit_r12_n2_searchpath_test.go`
// 里的实现（`r13geFamilyRelRe` / `r13geCatalogRelRe` / `r13geStripComments` /
// `r13geHasPinMarker` / `r13geToRegclassRe`），不存在"第二把尺子"。

import (
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// ① 关系登记表（族内关系集合的唯一真源）
// ---------------------------------------------------------------------------

// searchPathRelationClass 是"这张表与 search_path 收口的关系"的**封闭取值**。
type searchPathRelationClass string

const (
	// searchPathRelFamily：族内关系 —— 触碰它的函数必须按登记的 pin 模式收口
	// （`r13geSearchPathInventory` / `searchPathCrossPackageInventory`），
	// 且尺子（`r13geFamilyRelRe`）会盯住它。
	searchPathRelFamily searchPathRelationClass = "family"
	// searchPathRelPartition：族内关系的物理分区（DDL 按 for 值动态构造，
	// SQL 文本里不出现字面名）—— 与父表同面，随父表收口。
	searchPathRelPartition searchPathRelationClass = "partition-of-family"
	// searchPathRelNonFamily：**显式**判定不进族内集合，理由写在 why 里
	// （判据是"遮蔽读的后果**不静默**"）。
	searchPathRelNonFamily searchPathRelationClass = "non-family"
	// searchPathRelKnownUncovered：**认账** —— 存在静默后果，但本轮未纳入族内集合。
	// 这一档只允许出现在**关系**登记表里（关系级的"这张表不在面内"是一个可评审的
	// 边界决定）；函数级清单**没有**这一档：一张表一旦进族内集合，触碰它的函数就必须
	// 真的钉住（见 r13geSearchPathInventory 的注释）。
	searchPathRelKnownUncovered searchPathRelationClass = "known-uncovered"
)

type searchPathRelation struct {
	class searchPathRelationClass
	// why 必须能独立读懂：要么说明"遮蔽读为什么不静默"，要么说明"认账的后果是什么"。
	why string
}

// searchPathRelations 是 `migrations-pg/*.sql` 建出来的**每一张**表的登记。
//
// 与 schema 锚点双向对拍（TestAuditR13GH3RelationRegistryMatchesSchema）：
// 库里建了却没登记 ⇒ 红；登记了却（迁移里）不存在 ⇒ 红。新增迁移建新表时，
// 作者必须在这里回答一次"它进不进族内集合"——这是"新增关系必须进登记表"的落地。
var searchPathRelations = map[string]searchPathRelation{
	// —— 族内关系（9 张：金额/价目/计量/余额流水/回收台账/峰谷与保留期配置 +
	//    审计链）。共同后果：读错或写错对象 ⇒ **静默的错数字或静默丢账**，
	//    而所有健康出口报绿。——
	"usage":               {searchPathRelFamily, "计量明细：计费与报表的唯一来源"},
	"usage_daily":         {searchPathRelFamily, "日汇总账本（保留期清理/重建的读源）"},
	"usage_monthly":       {searchPathRelFamily, "月汇总账本（停摆与清理判据的读源）"},
	"models":              {searchPathRelFamily, "模型目录：价目、模态、缺失标记 ⇒ 直接影响结算金额"},
	"gateway_providers":   {searchPathRelFamily, "上游路由与密钥（base_url/api_key_enc）⇒ 静默改路由"},
	"gateway_files":       {searchPathRelFamily, "上游文件归属台账与回收标记"},
	"balance_ledger":      {searchPathRelFamily, "余额流水（users.balance_money 的不变量对账源）"},
	"balance_grants":      {searchPathRelFamily, "月度发放台账（发放幂等与补发判据的读源）"},
	"balance_grant_items": {searchPathRelFamily, "逐人·月发放锚 + 发放金额 ⇒ 静默错金额"},
	"settings":            {searchPathRelFamily, "峰谷窗口/保留期/闸门等配置键"},
	// R13-GH3 新增（V13-B 的登记缺口观察）：审计表原先不在族内集合里，shadow 同名表
	// 会让**审计静默落到 shadow**（public 链一行不动，而 VerifyAuditChain 与管理端
	// 列表读的也是 shadow ⇒ 两侧自洽，"审计 0 条"看不出是读错了对象）。
	"audit_logs": {searchPathRelFamily, "审计哈希链：静默落到 shadow = 审计事实整体丢失且不可自证"},

	// —— 族内关系的物理分区（同面，随父表收口）——
	"usage_202608":     {searchPathRelPartition, "usage 的首月分区（后续月分区由 DDL 动态构造）"},
	"usage_daily_2026": {searchPathRelPartition, "usage_daily 的 2026 年度分区"},

	// —— 非族内：遮蔽读的后果**不静默**（可见的登录/列表/鉴权/审批失败，
	//    或与金额链无关的独立计数）——
	// R14-K（D-03）勘误：原理由（"遮蔽读 ⇒ 可见地失败，不静默错数字"）只对**点查**
	// 成立。`users` 上有一条**金额聚合读**（GetBalanceSummary 的人数/余额合计与欠款）
	// —— 它与 shadow 的同名表完全同形，`err=nil`、数字是错的（真 PG 实测 public
	// 2 人/150.00 vs 敌对池 3 人/6166.00）。该读已单独 pin 到 public（不得再退回裸池）；
	// 其余 `users` 读仍是点查，non-family 的分类对它们继续成立。
	"users":                         {searchPathRelNonFamily, "点查（按 id/username）遮蔽读 ⇒ 登录/余额查询可见地失败；**金额聚合读**（GetBalanceSummary 的 COUNT/SUM/欠款）已单独 pin（R14-K · D-03），余额正确性另有 balance_ledger 族内面保证"},
	"groups":                        {searchPathRelNonFamily, "部门树：遮蔽读 ⇒ 列表/授权可见地报空或失败"},
	"user_groups":                   {searchPathRelNonFamily, "部门归属：同上"},
	"api_tokens":                    {searchPathRelNonFamily, "遮蔽读 ⇒ 鉴权可见地失败（401）"},
	"admin_sessions":                {searchPathRelNonFamily, "管理会话：遮蔽读 ⇒ 管理端可见地登出"},
	"admin_mfa_challenges":          {searchPathRelNonFamily, "MFA 票据：遮蔽读 ⇒ 第二因子校验可见地失败（拒绝登录，不静默放行）"},
	"ldap_synced_users":             {searchPathRelNonFamily, "LDAP 同步台账：遮蔽读 ⇒ 同步差异计数偏移，不参与金额"},
	"connectors":                    {searchPathRelNonFamily, "连接器配置：遮蔽读 ⇒ 面板可见地空/失败"},
	"client_error_reporting_status": {searchPathRelNonFamily, "客户端错误上报开关状态：遮蔽读 ⇒ 探针读数可见地异常"},
	"apps":                          {searchPathRelNonFamily, "应用主表（能力中心）：遮蔽读 ⇒ 目录可见地空/404"},
	"app_releases":                  {searchPathRelNonFamily, "应用版本：同上"},
	"app_grants":                    {searchPathRelNonFamily, "应用授权：遮蔽读 ⇒ 授权判定失败（拒绝访问，不静默放行）"},
	"agent_presets":                 {searchPathRelNonFamily, "共享 Agent 预设：遮蔽读 ⇒ 目录可见地空"},
	"agent_preset_grants":           {searchPathRelNonFamily, "预设授权：同 app_grants"},
	"shared_skills":                 {searchPathRelNonFamily, "共享技能：遮蔽读 ⇒ 目录可见地空"},
	"shared_skill_grants":           {searchPathRelNonFamily, "共享技能授权：同 app_grants"},
	"skill_grants":                  {searchPathRelNonFamily, "技能商城授权：同 app_grants"},
	"skills":                        {searchPathRelNonFamily, "技能商城目录：遮蔽读 ⇒ 目录可见地空"},
	"capability_locks":              {searchPathRelNonFamily, "能力名占位锁：遮蔽读 ⇒ 占位失效（后续写入撞唯一键，可见失败）"},
	"wasm_app_opens":                {searchPathRelNonFamily, "应用打开明细：独立计数面，不与金额/审计同链"},
	"wasm_app_opens_daily":          {searchPathRelNonFamily, "应用打开日汇总：同上"},
	"wasm_call_events":              {searchPathRelNonFamily, "应用调用事件：独立计数面"},
	"brand_snapshots":               {searchPathRelNonFamily, "品牌快照表（0047 建、品牌模块已下线）：全仓无 Go 读面"},

	// —— 迁移期临时表 / 已被后续迁移 DROP ——
	"agent_presets_new": {searchPathRelNonFamily, "0035 建后立即 RENAME 成 agent_presets（迁移期临时名）"},
	"app_sessions":      {searchPathRelNonFamily, "0073 已 DROP（WASM 客户端专属改造的删除波次）"},
	"employee_sessions": {searchPathRelNonFamily, "0073 已 DROP"},

	// —— 认账：存在静默后果，本轮未纳入族内集合（属新增面，需独立评审）——
	"report_subscriptions":    {searchPathRelKnownUncovered, "报表订阅（webhook 目标）：shadow 同名表存在时，订阅的增删改会静默落到 shadow ⇒ 报表静默停发。本轮未纳入：它不在金额/审计链上，纳入需要重排 reports 包的读写面"},
	"model_concurrency_stats": {searchPathRelKnownUncovered, "模型并发峰值台账（15s 采样）：shadow 同名表存在时峰值统计静默错数字。本轮未纳入：纯观测数据，不参与计费/路由"},
	"kb_audit_logs":           {searchPathRelKnownUncovered, "0028 建的 KB 审计表（KB 模块已下线）：全仓无 Go 读写面，但表仍在库里 ⇒ shadow 同名表可吞下未来的写入。本轮未纳入：无调用点，登记备查"},
}

// searchPathFamilyAlternation 由登记表派生**族内关系**的正则分支（尺子与登记表同源）。
// 按长度降序：`usage_daily` 必须先于 `usage` 尝试（虽然 `\b` 已经能区分，
// 但不依赖这一点更稳）。
func searchPathFamilyAlternation() string {
	var names []string
	for name, rel := range searchPathRelations {
		if rel.class == searchPathRelFamily {
			names = append(names, regexp.QuoteMeta(name))
		}
	}
	sort.Slice(names, func(i, j int) bool {
		if len(names[i]) != len(names[j]) {
			return len(names[i]) > len(names[j])
		}
		return names[i] < names[j]
	})
	if len(names) == 0 {
		panic("searchPathRelations 里没有任何族内关系：尺子会退化成空正则")
	}
	return strings.Join(names, "|")
}

// ---------------------------------------------------------------------------
// ② 包登记表（"哪些包在面内"）
// ---------------------------------------------------------------------------

type searchPathPkgClass string

const (
	// searchPathPkgFamilyBearing：包内有族内关系 SQL。本包（serverstore）用深度守卫的
	// 清单；**包外**这个类别的包还受"禁裸事务"约束（见 TestAuditR13GH3NoBareTxOutsideStore）。
	searchPathPkgFamilyBearing searchPathPkgClass = "family-bearing"
	// searchPathPkgNoFamilySQL：包内没有族内关系 SQL（双向对拍：一旦出现就变红，
	// 必须把登记改成 family-bearing 并逐函数登记 pin 模式）。
	searchPathPkgNoFamilySQL searchPathPkgClass = "no-family-sql"
)

// searchPathGuardPackages 是 `server/` 下**每一个**含非测试 Go 源的目录的登记。
//
// 为什么逐个登记而不是"动态枚举就完了"：动态枚举只能保证"扫描当前存在的包"，
// 保证不了"新包也在判据面内"—— 新增包不登记即红，这条才是"面"的守卫。
var searchPathGuardPackages = map[string]searchPathPkgClass{
	"internal/serverstore":          searchPathPkgFamilyBearing,
	"internal/llmgateway":           searchPathPkgFamilyBearing,
	"cmd/picoaide-app-compile":      searchPathPkgNoFamilySQL,
	"cmd/picoaide-limits-gen":       searchPathPkgNoFamilySQL,
	"cmd/picoaide-wasm-imports-gen": searchPathPkgNoFamilySQL,
	"cmd/server":                    searchPathPkgNoFamilySQL,
	"cmd/wasm-app-headers-gen":      searchPathPkgNoFamilySQL,
	"demoapps/board":                searchPathPkgNoFamilySQL,
	"demoapps/forum":                searchPathPkgNoFamilySQL,
	"demoapps/internal/demoapp":     searchPathPkgNoFamilySQL,
	"demoapps/showcase":             searchPathPkgNoFamilySQL,
	"internal/agentshare":           searchPathPkgNoFamilySQL,
	"internal/appstore":             searchPathPkgNoFamilySQL,
	"internal/archiveutil":          searchPathPkgNoFamilySQL,
	"internal/auditretention":       searchPathPkgNoFamilySQL,
	"internal/balance":              searchPathPkgNoFamilySQL,
	"internal/bootstrap":            searchPathPkgNoFamilySQL,
	"internal/capabilities":         searchPathPkgNoFamilySQL,
	"internal/channel":              searchPathPkgNoFamilySQL,
	"internal/clientrelease":        searchPathPkgNoFamilySQL,
	"internal/connectors":           searchPathPkgNoFamilySQL,
	"internal/llmgateway/channels":  searchPathPkgNoFamilySQL,
	"internal/marketplace":          searchPathPkgNoFamilySQL,
	"internal/portal":               searchPathPkgNoFamilySQL,
	"internal/reports":              searchPathPkgNoFamilySQL,
	"internal/router":               searchPathPkgNoFamilySQL,
	// R14-K（D-02）：`collectDBStats` 的表名/语句已改成字面量（原先是
	// `SELECT COUNT(*) FROM " + t` 的动态形态，既逃逸 SQL 尺子又读自 shadow），
	// ⇒ 本包从 no-family-sql 升为 family-bearing，函数逐条登记在下方 §③。
	"internal/serverauth":               searchPathPkgFamilyBearing,
	"internal/sharedskills":             searchPathPkgNoFamilySQL,
	"internal/skillmanifest":            searchPathPkgNoFamilySQL,
	"internal/telemetry":                searchPathPkgNoFamilySQL,
	"internal/updatecheck":              searchPathPkgNoFamilySQL,
	"internal/usageretention":           searchPathPkgNoFamilySQL,
	"internal/util":                     searchPathPkgNoFamilySQL,
	"internal/wasmapp/abi":              searchPathPkgNoFamilySQL,
	"internal/wasmapp/api":              searchPathPkgNoFamilySQL,
	"internal/wasmapp/appcfg":           searchPathPkgNoFamilySQL,
	"internal/wasmapp/appdb":            searchPathPkgNoFamilySQL,
	"internal/wasmapp/apperr":           searchPathPkgNoFamilySQL,
	"internal/wasmapp/applimits":        searchPathPkgNoFamilySQL,
	"internal/wasmapp/appproof":         searchPathPkgNoFamilySQL,
	"internal/wasmapp/appseed":          searchPathPkgNoFamilySQL,
	"internal/wasmapp/appserver":        searchPathPkgNoFamilySQL,
	"internal/wasmapp/assets":           searchPathPkgNoFamilySQL,
	"internal/wasmapp/cachetrust":       searchPathPkgNoFamilySQL,
	"internal/wasmapp/capapi":           searchPathPkgNoFamilySQL,
	"internal/wasmapp/compile":          searchPathPkgNoFamilySQL,
	"internal/wasmapp/diag":             searchPathPkgNoFamilySQL,
	"internal/wasmapp/edge":             searchPathPkgNoFamilySQL,
	"internal/wasmapp/events":           searchPathPkgNoFamilySQL,
	"internal/wasmapp/hostcap":          searchPathPkgNoFamilySQL,
	"internal/wasmapp/limits":           searchPathPkgNoFamilySQL,
	"internal/wasmapp/logbuf":           searchPathPkgNoFamilySQL,
	"internal/wasmapp/memprofile":       searchPathPkgNoFamilySQL,
	"internal/wasmapp/opens":            searchPathPkgNoFamilySQL,
	"internal/wasmapp/queue":            searchPathPkgNoFamilySQL,
	"internal/wasmapp/readyz":           searchPathPkgNoFamilySQL,
	"internal/wasmapp/refapp":           searchPathPkgNoFamilySQL,
	"internal/wasmapp/refapp/sockprobe": searchPathPkgNoFamilySQL,
	"internal/wasmapp/refapp/stdprobe":  searchPathPkgNoFamilySQL,
	"internal/wasmapp/refapp/wasiprobe": searchPathPkgNoFamilySQL,
	"internal/wasmapp/registry":         searchPathPkgNoFamilySQL,
	"internal/wasmapp/runtime":          searchPathPkgNoFamilySQL,
	"internal/wasmapp/skillseed":        searchPathPkgNoFamilySQL,
	"internal/wasmapp/upload":           searchPathPkgNoFamilySQL,
	"internal/wasmapp/wasmmod":          searchPathPkgNoFamilySQL,
	"scripts":                           searchPathPkgNoFamilySQL,
	"skills/app-builder/examples/go":    searchPathPkgNoFamilySQL,
	"webadmin":                          searchPathPkgNoFamilySQL,
}

// searchPathGuardSkippedDirs 是"文件面里被显式排除的目录名"（每个都要有理由）。
// 之所以只按**目录名**登记：Go 工具链语义上的 `testdata/` 与 gitignore 的 scratch
// 目录都不构成本仓的服务端包，扫它们只会把夹具里的 SQLite DDL 当成产品 SQL。
var searchPathGuardSkippedDirs = map[string]string{
	"testdata":     "Go 工具链语义：testdata 不参与构建（内部是 WASM guest/编译夹具，不是服务端包）",
	"temp":         "gitignore 的 scratch 目录（server/temp/*，不是服务端包）",
	"data":         "运行时数据目录（gitignored，无 Go 源）",
	"node_modules": "依赖缓存",
	".git":         "版本库元数据",
	"bin":          "构建产物",
	"dist":         "构建产物",
}

// ---------------------------------------------------------------------------
// ③ 包外函数登记表（pin 模式）
// ---------------------------------------------------------------------------

// searchPathCrossPackageInventory 是**包外**（非 internal/serverstore）触碰族内关系
// SQL 的每个函数的登记。键是 `<包目录>.<函数名>`（不能用裸函数名：跨包同名函数会
// 静默合并成一条）。
var searchPathCrossPackageInventory = map[string]r13gePinMode{
	"internal/llmgateway.ListModels":                  r13gePinned,
	"internal/llmgateway.loadUpstreamsDB":             r13gePinned,
	"internal/llmgateway.syncedModelNames":            r13geViaCaller,
	"internal/llmgateway.providerModelConfigSnapshot": r13geViaCaller,
	// R14-K（D-02）：管理端「服务器信息」页的族内关系行数统计（settings /
	// gateway_providers / models / usage / audit_logs）。语句是字面量，每条读经
	// serverstore.NewUsageReadConn（唯一 pin 实现）各自开一个已钉只读事务。
	"internal/serverauth.collectDBStats": r13gePinned,
}

// searchPathCrossPackageOwners 给包外每一个 via-caller 登记"谁钉的"。
var searchPathCrossPackageOwners = map[string]string{
	"internal/llmgateway.syncedModelNames":            "loadUpstreamsDB（serverstore.WithUsageSearchPathRead 的已钉只读事务）与 sync.go 的同步基线读（同源已钉事务）",
	"internal/llmgateway.providerModelConfigSnapshot": "llmgateway admin 的 provider 创建/更新事务（serverstore.UsageWriteTx 开出的已钉事务，见 admin.go 的 R13-GH3 注释）",
}

// ---------------------------------------------------------------------------
// ④ 扫描器
// ---------------------------------------------------------------------------

// searchPathServerRoot 由本文件的编译期路径推导（`<server>/internal/serverstore/xxx_test.go`
// → `<server>`）。用 runtime.Caller 而不是 `../..`：判据不依赖测试进程的 cwd。
func searchPathServerRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller 失败：无法定位 server 根")
	}
	root := filepath.Dir(filepath.Dir(filepath.Dir(file)))
	if _, err := os.Stat(filepath.Join(root, "go.mod")); err != nil {
		t.Fatalf("推导出的 server 根 %s 没有 go.mod：%v", root, err)
	}
	return root
}

// searchPathScanHit 是一个"函数触碰了族内关系 SQL"的命中。
type searchPathScanHit struct {
	pkg      string // 相对 server 根的包目录
	file     string // 相对 server 根的文件路径
	fn       string // 函数名
	body     string // 去注释后的函数体（含签名）
	hasSQL   bool   // 命中了族内关系**动作**
	catalog  bool   // 只命中 pg_catalog 判据
	hasDBArg bool   // 签名里有 *sql.DB（能自己开事务）
}

// searchPathScanServerFace 走完整个 `server/`：返回 ① 每个包的命中共 ② 每个包的文件数。
func searchPathScanServerFace(t *testing.T) (map[string][]searchPathScanHit, map[string]int) {
	t.Helper()
	root := searchPathServerRoot(t)
	hits := map[string][]searchPathScanHit{}
	files := map[string]int{}
	fnRe := regexp.MustCompile(`(?m)^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(`)
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if _, skip := searchPathGuardSkippedDirs[d.Name()]; skip {
				return filepath.SkipDir
			}
			if strings.HasPrefix(d.Name(), ".") && d.Name() != "." {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(d.Name(), ".go") || strings.HasSuffix(d.Name(), "_test.go") {
			return nil
		}
		rel, rerr := filepath.Rel(root, path)
		if rerr != nil {
			return rerr
		}
		pkg := filepath.ToSlash(filepath.Dir(rel))
		raw, rerr := os.ReadFile(path)
		if rerr != nil {
			return rerr
		}
		files[pkg]++
		src := string(raw)
		locs := fnRe.FindAllStringSubmatchIndex(src, -1)
		for i, m := range locs {
			start := m[0]
			end := len(src)
			if i+1 < len(locs) {
				end = locs[i+1][0]
			}
			clean := r13geStripComments(src[start:end])
			fam := r13geFamilyRelRe.MatchString(clean)
			cat := r13geCatalogRelRe.MatchString(clean)
			if !fam && !cat {
				continue
			}
			sig := clean
			if idx := strings.Index(clean, "{"); idx >= 0 {
				sig = clean[:idx]
			}
			hits[pkg] = append(hits[pkg], searchPathScanHit{
				pkg: pkg, file: filepath.ToSlash(rel), fn: src[m[2]:m[3]],
				body: clean, hasSQL: fam, catalog: cat,
				hasDBArg: strings.Contains(sig, "*sql.DB"),
			})
		}
		return nil
	})
	if err != nil {
		t.Fatalf("遍历 server/ 失败: %v", err)
	}
	return hits, files
}

// searchPathSchemaTables 从 `migrations-pg/*.sql` 抽出"建出来的表名"（去注释后匹配
// `CREATE TABLE [IF NOT EXISTS] [schema.]name`）。
func searchPathSchemaTables(t *testing.T) []string {
	t.Helper()
	dir := filepath.Join(searchPathServerRoot(t), "internal", "serverstore", "migrations-pg")
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("读迁移目录 %s: %v", dir, err)
	}
	re := regexp.MustCompile(`(?is)CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[a-z_][a-z0-9_]*\.)?([a-z_][a-z0-9_]*)`)
	seen := map[string]bool{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		raw, rerr := os.ReadFile(filepath.Join(dir, e.Name()))
		if rerr != nil {
			t.Fatalf("读 %s: %v", e.Name(), rerr)
		}
		src := string(raw)
		src = regexp.MustCompile(`(?s)/\*.*?\*/`).ReplaceAllString(src, "")
		src = regexp.MustCompile(`--[^\n]*`).ReplaceAllString(src, "")
		for _, m := range re.FindAllStringSubmatch(src, -1) {
			seen[strings.ToLower(m[1])] = true
		}
	}
	var out []string
	for name := range seen {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// ---------------------------------------------------------------------------
// ⑤ 判据
// ---------------------------------------------------------------------------

// TestAuditR13GH3GuardRulerSelfCheck 是尺子的自检：登记表里的每个族内关系都必须被
// 派生出来的正则命中（加关系时打错名字/正则被改坏 ⇒ 红，而不是静默漏掉）。
func TestAuditR13GH3GuardRulerSelfCheck(t *testing.T) {
	n := 0
	for name, rel := range searchPathRelations {
		if rel.class != searchPathRelFamily {
			continue
		}
		n++
		probe := "SELECT 1 FROM " + name + " WHERE id = 1"
		if !r13geFamilyRelRe.MatchString(probe) {
			t.Errorf("族内关系 %q 没被 r13geFamilyRelRe 命中（probe=%q）—— 尺子与登记表分叉了", name, probe)
		}
	}
	if n < 9 {
		t.Fatalf("族内关系只登记了 %d 个（下限 9）：R13-GH3 的收口面被悄悄缩小了", n)
	}
	// 反向：非族内的表名不得被尺子命中（否则"没登记"会被误报成族内 SQL）。
	for name, rel := range searchPathRelations {
		if rel.class == searchPathRelFamily {
			continue
		}
		if r13geFamilyRelRe.MatchString("SELECT 1 FROM " + name) {
			t.Errorf("非族内关系 %q 被 r13geFamilyRelRe 命中了：尺子比登记表宽", name)
		}
	}
	// 未登记的表名不得被命中（"用法/设置"这类普通词不在登记表里，必须不误伤）。
	for _, name := range []string{"users", "groups", "apps", "showcase_runs"} {
		if r13geFamilyRelRe.MatchString("SELECT 1 FROM " + name) {
			t.Errorf("未登记关系 %q 被尺子命中：会把非族内 SQL 误判成族内动作", name)
		}
	}
	t.Logf("尺子自检：族内关系 %d 个全部命中，非族内/未登记关系均不误伤", n)
}

// TestAuditR13GH3PackageRegistryCoversWholeServer 是"面"的判据：`server/` 下每个含
// 非测试 Go 源的目录都必须登记，且登记的分类必须与实测一致（双向）。
func TestAuditR13GH3PackageRegistryCoversWholeServer(t *testing.T) {
	hits, files := searchPathScanServerFace(t)
	if len(files) < 40 {
		t.Fatalf("只枚举到 %d 个包（下限 40）—— 文件面失效，不能静默通过", len(files))
	}
	total := 0
	for _, n := range files {
		total += n
	}
	if total < 200 {
		t.Fatalf("只枚举到 %d 个非测试源文件（下限 200）—— 文件面失效，不能静默通过", total)
	}

	// ① 覆盖：未登记的包 ⇒ 红
	var missing []string
	for pkg := range files {
		if _, ok := searchPathGuardPackages[pkg]; !ok {
			missing = append(missing, pkg)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Errorf("这些包在 server/ 下却有族内关系 SQL 的判据面没有任何登记：%v\n"+
			"⇒ 新增一个包不会被任何人发现（R13-GH3 的第三条路径就是这么漏掉的）。"+
			"请在 searchPathGuardPackages 登记它，并声明 family-bearing / no-family-sql。", missing)
	}
	// ② 反向：登记了却不存在的包 ⇒ 红（清单陈旧）
	var stale []string
	for pkg := range searchPathGuardPackages {
		if files[pkg] == 0 {
			stale = append(stale, pkg)
		}
	}
	sort.Strings(stale)
	if len(stale) > 0 {
		t.Errorf("searchPathGuardPackages 登记了但 server/ 下找不到非测试 Go 源的包：%v（清单陈旧）", stale)
	}
	// ③ 分类双向对拍：实测有族内 SQL ⇔ 登记为 family-bearing
	for pkg, hs := range hits {
		fam := false
		for _, h := range hs {
			if h.hasSQL {
				fam = true
				break
			}
		}
		want, ok := searchPathGuardPackages[pkg]
		if !ok {
			continue // ①已报
		}
		if fam && want != searchPathPkgFamilyBearing {
			t.Errorf("包 %s 实测有族内关系 SQL（如 %s），但登记为 %s —— 登记与实测不符", pkg, hs[0].fn, want)
		}
		if !fam && want == searchPathPkgFamilyBearing {
			t.Errorf("包 %s 登记为 family-bearing，但实测没有任何族内关系 SQL —— 清单陈旧或收口面被搬走了", pkg)
		}
	}
	t.Logf("包面：%d 个包 / %d 个非测试源文件；族内 SQL 见于 %d 个包", len(files), total, len(hits))
}

// TestAuditR13GH3CrossPackageFamilySQLIsInventoried 是**第三条路径**的直接判据：
// 包外每一个触碰族内关系 SQL 的函数都必须登记 pin 模式，且登记必须与实现一致
// （pinned ⇒ 函数体里有 pin 记号；via-caller ⇒ 签名开不出自己的事务 + 有点名的
// 所有者；catalog-only ⇒ 函数体里没有族内动作）。
func TestAuditR13GH3CrossPackageFamilySQLIsInventoried(t *testing.T) {
	hits, _ := searchPathScanServerFace(t)
	found := map[string]searchPathScanHit{}
	for pkg, hs := range hits {
		if pkg == "internal/serverstore" {
			continue // 本包交给深度守卫（r13geSearchPathInventory）
		}
		for _, h := range hs {
			found[pkg+"."+h.fn] = h
		}
	}
	if len(found) < 4 {
		t.Fatalf("包外只找到 %d 个族内 SQL 函数（下限 4：llmgateway 的模型目录/上游目录/同步模型名/配置快照）"+
			"—— 扫描器失效或收口面被搬走，不能静默通过", len(found))
	}
	var missing []string
	for key := range found {
		if _, ok := searchPathCrossPackageInventory[key]; !ok {
			missing = append(missing, key)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Errorf("这些**包外**函数触碰了族内关系 SQL 但没有登记 pin 模式：%v\n"+
			"⇒ 与 R13-GH3 的第三条路径同形（llmgateway 的 4 处既没 pin 也不在守卫文件面内）。"+
			"请登记它并声明 pinned / via-caller / catalog-only；包外 pinned 只允许用 serverstore 的"+
			"跨包接缝（UsageWriteTx / WithUsageSearchPath[Read] / NewUsageReadConn）。", missing)
	}
	for key, hit := range found {
		mode, ok := searchPathCrossPackageInventory[key]
		if !ok {
			continue
		}
		switch mode {
		case r13gePinned:
			if !r13geHasPinMarker(hit.body) {
				t.Errorf("%s 登记为 pinned，但函数体里没有任何 pin 记号（%v）：包外只允许经 serverstore 的跨包接缝钉", key, r13gePinMarkers)
			}
			if !hit.hasSQL {
				t.Errorf("%s 登记为 pinned，但函数体里只有 catalog 判据、没有族内关系动作", key)
			}
		case r13geViaCaller:
			if hit.hasDBArg {
				t.Errorf("%s 登记为 via-caller，但签名里有 `*sql.DB`（能自己开事务）—— "+
					"必须改成接收已钉事务（`*sql.Tx`），或自己钉住", key)
			}
			if _, ok := searchPathCrossPackageOwners[key]; !ok {
				t.Errorf("%s 登记为 via-caller，但没有在 searchPathCrossPackageOwners 里点名谁钉了它", key)
			}
		case r13geCatalogOnly:
			if hit.hasSQL {
				t.Errorf("%s 登记为 catalog-only，但函数体里有对族内关系的**动作**", key)
			}
		default:
			t.Errorf("%s 的 pin 模式 %q 不在封闭集合 {pinned, via-caller, catalog-only} 里", key, mode)
		}
	}
	// 反向：登记了却不存在 ⇒ 清单陈旧
	for key := range searchPathCrossPackageInventory {
		if _, ok := found[key]; !ok {
			t.Errorf("searchPathCrossPackageInventory 登记了 %q，但扫描器在包外找不到这个族内 SQL 函数（清单陈旧）", key)
		}
	}
	t.Logf("包外族内 SQL 函数 %d 个，全部已登记（pinned=%d via-caller=%d）",
		len(found), countCrossPkgMode(r13gePinned), countCrossPkgMode(r13geViaCaller))
}

func countCrossPkgMode(m r13gePinMode) int {
	n := 0
	for _, v := range searchPathCrossPackageInventory {
		if v == m {
			n++
		}
	}
	return n
}

// TestAuditR13GH3NoBareTxOutsideStore 是"裸 `*sql.DB`"那一半尺子的机械判据：
// 包外的族内面**不允许自己 `db.Begin()`** —— 包外没有 `SET LOCAL` 的唯一实现，
// 自己开事务就是又一条未钉路径（llmgateway 的 5 处 `db.Begin()` 正是这样漏了
// provider 创建/更新、模型创建/删除与网关配置事务里的读与写）。
func TestAuditR13GH3NoBareTxOutsideStore(t *testing.T) {
	root := searchPathServerRoot(t)
	bareTxRe := regexp.MustCompile(`\.Begin(?:Tx)?\(`)
	checked := 0
	for pkg, class := range searchPathGuardPackages {
		if class != searchPathPkgFamilyBearing || pkg == "internal/serverstore" {
			continue
		}
		entries, err := os.ReadDir(filepath.Join(root, filepath.FromSlash(pkg)))
		if err != nil {
			t.Fatalf("读包 %s: %v", pkg, err)
		}
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".go") || strings.HasSuffix(e.Name(), "_test.go") {
				continue
			}
			raw, rerr := os.ReadFile(filepath.Join(root, filepath.FromSlash(pkg), e.Name()))
			if rerr != nil {
				t.Fatalf("读 %s/%s: %v", pkg, e.Name(), rerr)
			}
			checked++
			clean := r13geStripComments(string(raw))
			for i, line := range strings.Split(clean, "\n") {
				if bareTxRe.MatchString(line) {
					t.Errorf("%s/%s:%d 在族内面上自己开了事务：%s\n"+
						"⇒ 包外只允许 `serverstore.UsageWriteTx(db)`（同一个 BEGIN + `SET LOCAL search_path = public`）；"+
						"自己 `db.Begin()` 的事务里读/写族内关系会静默落到 shadow（真 PG + 敌对 search_path 实测）。",
						pkg, e.Name(), i+1, strings.TrimSpace(line))
				}
			}
		}
	}
	if checked < 20 {
		t.Fatalf("只检查了 %d 个包外文件（下限 20）—— 判据面失效", checked)
	}
	t.Logf("包外族内面裸事务检查：%d 个文件，0 处 db.Begin()/db.BeginTx()", checked)
}

// TestAuditR13GH3RelationRegistryMatchesSchema 是"关系"那一半的登记判据：
// `migrations-pg/*.sql` 建出来的每一张表都必须在 searchPathRelations 里，
// 且反向（登记了却没有建表语句）也要红。
func TestAuditR13GH3RelationRegistryMatchesSchema(t *testing.T) {
	tables := searchPathSchemaTables(t)
	if len(tables) < 35 {
		t.Fatalf("迁移里只抽到 %d 张表（下限 35）—— schema 锚点失效，不能静默通过", len(tables))
	}
	var missing []string
	for _, name := range tables {
		if _, ok := searchPathRelations[name]; !ok {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		t.Errorf("这些表由迁移建立但**没有登记**在 searchPathRelations 里：%v\n"+
			"⇒ 新增关系不会被任何人发现（audit_logs 就是这么漏掉的：shadow 同名表让审计静默落到 shadow）。"+
			"请登记它并回答一次：进族内集合（family，触碰它的函数必须 pin）/ 非族内（non-family，写清"+
			"为什么遮蔽读不静默）/ 认账（known-uncovered，写清后果与本轮为什么不做）。", missing)
	}
	var stale []string
	for name := range searchPathRelations {
		if !containsString(tables, name) {
			stale = append(stale, name)
		}
	}
	sort.Strings(stale)
	if len(stale) > 0 {
		t.Errorf("searchPathRelations 登记了迁移里并不存在的表：%v（清单陈旧）", stale)
	}
	// 每一档都必须有 why（认账档尤其不允许空理由）
	for name, rel := range searchPathRelations {
		if strings.TrimSpace(rel.why) == "" {
			t.Errorf("关系 %q 的登记没有 why —— 登记表是**可评审的边界决定**，理由不能省", name)
		}
		switch rel.class {
		case searchPathRelFamily, searchPathRelPartition, searchPathRelNonFamily, searchPathRelKnownUncovered:
		default:
			t.Errorf("关系 %q 的分类 %q 不在封闭集合 {family, partition-of-family, non-family, known-uncovered} 里", name, rel.class)
		}
	}
	t.Logf("关系登记表：schema 建表 %d 张，登记 %d 张（family=%d partition=%d non-family=%d known-uncovered=%d）",
		len(tables), len(searchPathRelations),
		countRelationClass(searchPathRelFamily), countRelationClass(searchPathRelPartition),
		countRelationClass(searchPathRelNonFamily), countRelationClass(searchPathRelKnownUncovered))
}

// TestAuditR13GH3StorePackageDelegatesToDeepGuard 保证"面"的守卫与"深度"的守卫
// **拼得上**：本包（serverstore）被扫出来的族内 SQL 函数必须全部在深度守卫的清单里
// （深度守卫自己也会断言反向，这里只保证面守卫不会漏掉整包）。
func TestAuditR13GH3StorePackageDelegatesToDeepGuard(t *testing.T) {
	hits, _ := searchPathScanServerFace(t)
	hs, ok := hits["internal/serverstore"]
	if !ok {
		t.Fatal("面守卫没有在 internal/serverstore 里找到任何族内 SQL 函数：扫描器失效")
	}
	var missing []string
	for _, h := range hs {
		if !h.hasSQL {
			continue
		}
		if _, ok := r13geSearchPathInventory[h.fn]; !ok {
			missing = append(missing, h.fn)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Errorf("这些 serverstore 函数被面守卫扫出族内 SQL，但不在深度守卫的 r13geSearchPathInventory 里：%v", missing)
	}
	t.Logf("serverstore：面守卫扫出 %d 个族内 SQL 函数（含 catalog），全部由深度清单覆盖", len(hs))
}

// TestAuditR13GH3ToRegclassOnServerFace 把深度守卫的第二个机械判据（`to_regclass`
// 必须 `public.` 限定）也扩到整个 `server/`：未限定的 `to_regclass(<name>)` 按
// search_path 解析，比裸 `FROM <name>` 更隐蔽（看起来只是"查一个 catalog 事实"）。
func TestAuditR13GH3ToRegclassOnServerFace(t *testing.T) {
	root := searchPathServerRoot(t)
	scanned := 0
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if _, skip := searchPathGuardSkippedDirs[d.Name()]; skip {
				return filepath.SkipDir
			}
			if strings.HasPrefix(d.Name(), ".") && d.Name() != "." {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(d.Name(), ".go") || strings.HasSuffix(d.Name(), "_test.go") {
			return nil
		}
		raw, rerr := os.ReadFile(path)
		if rerr != nil {
			return rerr
		}
		scanned++
		clean := r13geStripComments(string(raw))
		for _, m := range r13geToRegclassRe.FindAllStringSubmatch(clean, -1) {
			arg := strings.TrimSpace(m[1])
			if !strings.Contains(arg, "public.") {
				rel, _ := filepath.Rel(root, path)
				t.Errorf("%s：to_regclass(%s) 没有硬钉 public. 前缀 —— shadow schema 在场时它会解析到别的库，"+
					"而调用点看起来只是「查一个 catalog 事实」", filepath.ToSlash(rel), arg)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("遍历失败: %v", err)
	}
	if scanned < 200 {
		t.Fatalf("只扫了 %d 个文件（下限 200）—— 判据面失效", scanned)
	}
	t.Logf("to_regclass 全仓面：%d 个非测试源文件，无未限定实参", scanned)
}

func containsString(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

func countRelationClass(c searchPathRelationClass) int {
	n := 0
	for _, rel := range searchPathRelations {
		if rel.class == c {
			n++
		}
	}
	return n
}
