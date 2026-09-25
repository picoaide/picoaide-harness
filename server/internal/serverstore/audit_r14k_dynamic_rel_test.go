package serverstore

// R14-K · D-02 的守卫尺子：**"表名来自变量 / 拼接"的动态关系名形态必须登记**。
//
// 被审形态（lane D 的 D-02，第十三轮"读面收口"的第四条路径）：
//
//	// server/internal/serverauth/sysinfo.go（旧实现）
//	var statTables = []string{"users", …, "usage", …, "audit_logs", …}
//	…
//	if err := db.QueryRow("SELECT COUNT(*) FROM " + t).Scan(&n); err != nil { continue }
//
// 族内关系（`settings` / `gateway_providers` / `models` / `usage` / `audit_logs`）的
// 行数**读自 shadow**（运行期实测：旁路池 `usage=3 / audit_logs=5`，public 是 `1 / 1`），
// 而现有的 SQL 尺子（`r13geFamilyRelRe`：SQL 关键字后**紧跟字面表名**）对这条**零命中**
// —— 正/负对照：同样的语句写成字面量立刻打红，写成拼接则完全看不见。于是"读面收口"
// 的文件面声明（整个 `server/`）在这条路径上不成立。
//
// 本文件补的就是那条判据：
//
//	① **尺子**（`r14kDynamicRelPatterns`）：字面量里出现 SQL 动词、且关系关键字
//	   **后面紧跟变量/格式实参**（`"… FROM " + t` / `"… FROM %s"` / `fmt.Sprintf("… FROM %s", …)`）；
//	② **登记表**（`r14kDynamicRelationCallers`）：每个命中的 `<包>.<函数>` 必须登记
//	   并写明**值域从哪来**（为什么这条动态名不会指向 shadow）；
//	③ **豁免表**（`r14kDynamicRelExemptPackages`）：SQL 作用在**应用自有 SQLite 库**
//	   （没有 schema / search_path / shadow 语义）上的包整包豁免，逐包写理由；
//	④ **双向**：命中未登记 ⇒ 红；登记/豁免了却扫不到 ⇒ 红（清单陈旧）；
//	⑤ **下限自检**：判据面内命中小于 10 ⇒ 红（尺子或文件面被改坏不能静默通过）；
//	⑥ **尺子自检**：真形态必须命中、字面量形态与 `… FOR UPDATE` 这类误伤必须不命中。
//
// **尺子的覆盖边界（如实登记，不要读成"所有动态形态都被覆盖"）**：
//
//	命中 —— 关系名在字面量**末尾**的拼接（`"SELECT … FROM " + t`）、关系名在格式串
//	        末尾的 `Sprintf`（`` `… FROM %s` ``）、以及 `fmt.Sprintf` 里关系关键字后
//	        紧跟格式动词的形态（`fmt.Sprintf("ALTER TABLE %s …", rel)`）；
//	不命中 —— 关系名插在语句**中间**、且不是 `fmt.Sprintf` 直接实参的形态
//	        （例如先 `q := "UPDATE " + t` 再拼后续语句）。这类形态要么被 `r13geFamilyRelRe`
//	        以字面量形态看见，要么就是本条尺子的盲区 —— **盲区是盲区，不假装覆盖**；
//	        新增动态读时请按本条判据的取向改写成"字面量 + 已钉事务"。
//
// **盲区的登记（R14-O · VC-F3）**：复审泳道 V14-C 用一把更宽的自制尺子做差集，找到了
// 4 个"构造动态关系名但本尺子看不见"的函数（其中 `createRangePartition` **两把尺子都
// 看不见**）。它们已如实登记在 `r14kDynamicRelKnownUncovered`（值域来源 + 为什么无行为
// 风险 + 形态标记），由 `TestAuditR14KDynamicRelationKnownUncoveredRegistry` 做双向核对。
// 结论：动态形态是开放集 ⇒ 本判据的取向是"登记/改写"，不是"用正则穷举"。
//
// 为什么"登记/豁免"而不是"一律禁止"：动态关系名有合法用法（分区 DDL 的关系名来自
// `pg_inherits` 的 catalog 事实、授权表名来自编译期常量表、WASM 应用的表名属于应用自己的
// SQLite 库）。禁掉等于让人绕道写更晦涩的形态；登记 + 写清值域，才能让"下一次新增动态读"
// 必须经过一次显式回答（这正是 D-02 逃逸的原因：没有人被要求回答过）。
//
// 变异验证（实跑）：
//   - 把 `collectDBStats` 改回 `db.QueryRow("SELECT COUNT(*) FROM " + t)` ⇒ 本用例红
//     （未登记的动态关系名读，且那正是 D-02）；
//   - 删掉登记表/豁免表任一条目 ⇒ "命中未登记"红；把条目改成扫不到的函数名 ⇒ "清单陈旧"红；
//   - 把尺子的 `(?:%[sdvq])?` 去掉 ⇒ `usage_ledger` 的几处 `FROM %s` 漏检 ⇒ 下限/覆盖对拍红。

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// r14kSQLVerb 是"这段字面量确实是一条 SQL"的最小证据。
const r14kSQLVerb = `(?:SELECT|INSERT|UPDATE|DELETE|LOCK|ALTER|CREATE|TRUNCATE|WITH)`

// r14kDynamicRelPatterns 是尺子本体（**RE2 兼容**：Go 的 regexp 不支持 lookahead/lookbehind，
// 所以"关键字后面不能是 FOR/DO"这类收窄改由"引号后必须紧跟 `+` / `,` / `)`"达成 ——
// `"… FOR UPDATE"` 后面跟的是引号 + `,`/`)` 时**确实会被误判**，这一条由下面的 self-check
// 用例钉住（`FOR UPDATE` 的完整语句不会被命中是因为关键字后面还有别的 SQL 文本）。
var r14kDynamicRelPatterns = []*regexp.Regexp{
	// A：关系名在字面量末尾，被拼上变量 —— `"SELECT COUNT(*) FROM " + t`、`"LOCK TABLE " + rel`。
	regexp.MustCompile("[`\"][^`\"\n]*?" + r14kSQLVerb +
		"[^`\"\n]*?\\b(?:FROM|JOIN|INTO|TABLE)\\s*(?:%[sdvq])?\\s*[`\"]\\s*(?:\\+|,|\\))"),
	// C：`fmt.Sprintf` 里关系关键字后紧跟格式动词 —— `fmt.Sprintf("ALTER TABLE %s …", rel)`、
	//    `fmt.Sprintf("SELECT 1 FROM %s WHERE …", rel)`（关系名在语句中间，A 看不见）。
	regexp.MustCompile("fmt\\.Sprintf\\(\\s*[`\"][^`\"\n]*?\\b(?:FROM|JOIN|INTO|TABLE|UPDATE)\\s+%[sdvq]"),
}

// r14kDynamicRelationCallers 是"动态关系名"的**函数级登记表**（键 `<包目录>.<函数名>`）。
// 每条都必须写明**值域来源**：为什么这条动态名不可能指向 shadow schema 或用户输入。
var r14kDynamicRelationCallers = map[string]string{
	// —— 分区 DDL / 回收：关系名来自 catalog 事实（pg_inherits / pg_class），
	//    且经 quoteRelationIdent **引号化**（DDL / LOCK 的实参是标识符，不再走 search_path 解析）。
	"internal/serverstore.adoptDetachedMonthPartition":     "分区 DDL：`ALTER TABLE <分区>` 的关系名来自 catalog（pg_inherits 的子女）+ quoteRelationIdent 引号化",
	"internal/serverstore.usageReclaimTargetLock":          "回收取锁：`LOCK TABLE <关系>` 的关系名来自回收请求（已过 catalog 形状校验）并引号化",
	"internal/serverstore.reclaimUsagePartitionAtomically": "同 usageReclaimTargetLock（同族关系名来源）",
	"internal/serverstore.detachedWindowBounds":            "已钉事务内按分区名读窗口：关系名同族（catalog 事实 + 引号化）",
	"internal/serverstore.usageReclaimWindowUnderLock":     "同 detachedWindowBounds（持锁段内读同一分区）",
	"internal/serverstore.detailMonthsOutside":             "同族：格式动词是 usage_daily / usage_monthly 的**常量表名二选一**（随分区形态传入）",
	"internal/serverstore.moveRowsIntoUsage":               "同族：搬行目标 = 分区名（catalog 事实 + 引号化）",
	"internal/serverstore.usageSubtreeHoldsRetainedRows":   "同族：子树存在性判据，关系名来自 catalog 遍历结果 + 引号化",
	// —— 共享资源授权：表名/列名来自**编译期常量表**（sharedResourceTables），值域封闭在源码里。
	"internal/serverstore.GrantSharedResource":        "授权表名来自编译期常量表 sharedResourceTables（值域封闭，与请求输入无关）",
	"internal/serverstore.RevokeSharedResource":       "同上（sharedResourceTables）",
	"internal/serverstore.ListSharedResourceGrants":   "同上（sharedResourceTables）",
	"internal/serverstore.DeleteSharedResourceGrants": "同上（sharedResourceTables）",
	"internal/serverstore.ReplaceSharedGroups":        "同上（sharedResourceTables）",
}

// r14kDynamicRelExemptPackages 是**整包豁免**（键 = `server/` 下的包目录）：
// 这些包的 SQL 作用在**应用自有 SQLite 库**上 —— 没有 schema / search_path / shadow
// 语义，因此不在"族内关系读面收口"的判据面内（与 `searchPathGuardPackages` 里
// 它们登记为 no-family-sql 的理由同源）。
var r14kDynamicRelExemptPackages = map[string]string{
	"demoapps/board":         "演示应用（WASM guest）：SQL 打在应用自有 SQLite 库（hostcap 的 appdb），无 search_path 语义",
	"demoapps/forum":         "同上（演示应用自有 SQLite 库）",
	"internal/wasmapp/api":   "WASM 应用平台的 HTTP 面：SQL 打在应用自有 SQLite 库（appdb 有独立 SQL 门）",
	"internal/wasmapp/appdb": "应用自有 SQLite 库的实现本身（db.define 建表）",
}

// r14kDynamicRelHit 是一条命中。
type r14kDynamicRelHit struct {
	key  string // `<包>.<函数>`
	file string
	lit  string
}

// r14kDynamicRelHits 扫描整个 `server/` 的非测试 Go 源（跳过与面守卫同一份豁免目录表）。
func r14kDynamicRelHits(t *testing.T) []r14kDynamicRelHit {
	t.Helper()
	root := searchPathServerRoot(t)
	var hits []r14kDynamicRelHit
	fnRe := regexp.MustCompile(`(?m)^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(`)
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
		rel, _ := filepath.Rel(root, path)
		rel = filepath.ToSlash(rel)
		pkg := filepath.ToSlash(filepath.Dir(rel))
		src := r13geStripComments(string(raw))
		locs := fnRe.FindAllStringSubmatchIndex(src, -1)
		for i, m := range locs {
			start := m[0]
			end := len(src)
			if i+1 < len(locs) {
				end = locs[i+1][0]
			}
			fn := src[m[2]:m[3]]
			for _, pat := range r14kDynamicRelPatterns {
				for _, lit := range pat.FindAllString(src[start:end], -1) {
					hits = append(hits, r14kDynamicRelHit{key: pkg + "." + fn, file: rel, lit: lit})
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("遍历 server/ 失败: %v", err)
	}
	if scanned < 200 {
		t.Fatalf("只扫了 %d 个非测试源文件（下限 200）—— 判据面失效，不能静默通过", scanned)
	}
	return hits
}

// TestAuditR14KDynamicRelationNamesAreRegistered 是判据主体（双向 + 下限自检）。
func TestAuditR14KDynamicRelationNamesAreRegistered(t *testing.T) {
	hits := r14kDynamicRelHits(t)
	inScope := map[string]string{} // key → 一条示例字面量
	exemptSeen := map[string]bool{}
	for _, h := range hits {
		pkg := h.key[:strings.LastIndex(h.key, ".")]
		if _, ok := r14kDynamicRelExemptPackages[pkg]; ok {
			exemptSeen[pkg] = true
			continue
		}
		if _, ok := inScope[h.key]; !ok {
			inScope[h.key] = h.lit
		}
	}
	if len(inScope) < 10 {
		t.Fatalf("判据面内只扫出 %d 个「动态关系名」函数（下限 10：分区/回收 8 + 授权表 5 的粗粒度）"+
			"—— 尺子或文件面被改坏，不能静默通过。命中=%v", len(inScope), inScope)
	}
	// ① 命中未登记 ⇒ 红（D-02 就是这条：动态表名读没人登记、也没人问过它的值域）
	var missing []string
	for key := range inScope {
		if _, ok := r14kDynamicRelationCallers[key]; !ok {
			missing = append(missing, key)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Errorf("这些函数用**变量/拼接**构造关系名，但没有登记在 r14kDynamicRelationCallers 里：%v\n"+
			"⇒ 与 D-02 同形：SQL 尺子（要求关键字后紧跟**字面**表名）看不见它，"+
			"于是「这条读面是否收口、是否指向 shadow」没有任何判据。请登记并写明**值域从哪来**；"+
			"若值域不封闭，就改成字面量 SQL 并让读走已钉事务。示例命中=%v", missing, inScope)
	}
	// ② 登记了却扫不到 ⇒ 红（清单陈旧：函数改名 / 已改成字面量）
	var stale []string
	for key := range r14kDynamicRelationCallers {
		if _, ok := inScope[key]; !ok {
			stale = append(stale, key)
		}
	}
	sort.Strings(stale)
	if len(stale) > 0 {
		t.Errorf("r14kDynamicRelationCallers 登记了但判据面内扫不到：%v（清单陈旧 —— "+
			"该处已改成字面量或函数被改名，请同步删/改登记）", stale)
	}
	// ③ 豁免表双向：豁免了却没有任何命中 ⇒ 红（豁免不该长期挂着一个不再需要的口子）
	var staleExempt []string
	for pkg := range r14kDynamicRelExemptPackages {
		if !exemptSeen[pkg] {
			staleExempt = append(staleExempt, pkg)
		}
	}
	sort.Strings(staleExempt)
	if len(staleExempt) > 0 {
		t.Errorf("r14kDynamicRelExemptPackages 豁免了但扫不到任何动态关系名：%v（口子该收回了）", staleExempt)
	}
	t.Logf("动态关系名：判据面内 %d 个函数（全部已登记），整包豁免 %d 个（全部有命中）",
		len(inScope), len(exemptSeen))
}

// TestAuditR14KDynamicRelationRulerSelfCheck 是尺子的自检：真形态必须命中，
// 字面量形态与常见误伤必须不命中，登记/豁免表必须非空且带理由。
//
// 没有这条，"尺子被改宽/改窄"（例如删掉 `(?:%[sdvq])?`、把完整语句误判成动态名）
// 不会有人发现 —— 那是本项目登记过的"判据感知度不足"。
func TestAuditR14KDynamicRelationRulerSelfCheck(t *testing.T) {
	hit := func(src string) bool {
		for _, pat := range r14kDynamicRelPatterns {
			if pat.MatchString(src) {
				return true
			}
		}
		return false
	}
	mustHit := []string{
		`"SELECT COUNT(*) FROM " + t`,                                         // D-02 的原形态
		"`SELECT COUNT(*) FROM `+quoteIdent(table)",                           // 反引号 + 拼接
		`"INSERT INTO " + table.Table + " (kind, "`,                           // INSERT INTO 拼接
		`"LOCK TABLE " + quoteRelationIdent(rel) + " "`,                       // LOCK TABLE 拼接
		"fmt.Sprintf(`SELECT min(created_at), max(created_at) FROM %s`, rel)", // 格式串末尾的 Sprintf 形态
		`fmt.Sprintf("ALTER TABLE %s SET SCHEMA public", rel)`,                // 关系名在语句中间的 Sprintf 形态
		`fmt.Sprintf("SELECT 1 FROM %s WHERE id = ?", rel)`,                   // 同上
	}
	for _, src := range mustHit {
		if !hit(src) {
			t.Errorf("尺子漏掉了动态关系名形态：%s", src)
		}
	}
	mustMiss := []string{
		`"SELECT COUNT(*) FROM usage"`,                                 // 字面量（由族内关系尺子看）
		"`SELECT COUNT(*) FROM audit_logs WHERE id > ?`",               // 字面量 + 参数
		`"SELECT id FROM usage WHERE id = ? FOR UPDATE"`,               // 以关键字**词**结尾的完整语句
		`"INSERT INTO usage (a) VALUES (?) ON CONFLICT (a) DO UPDATE"`, // 同上（DO UPDATE）
		`"SELECT 1 FROM pg_class"`,                                     // catalog 判据
		`"…请在保存后 UPDATE 该行"`,                                           // 文案里的关键字词
		`fmt.Sprintf("SELECT * FROM usage WHERE id = %d", id)`,         // 字面量关系名 + 值参数
	}
	for _, src := range mustMiss {
		if hit(src) {
			t.Errorf("尺子误伤了非动态形态：%s", src)
		}
	}
	// 双向自证：登记/豁免表非空且都带理由（空理由 = 没回答问题）。
	if len(r14kDynamicRelationCallers) == 0 || len(r14kDynamicRelExemptPackages) == 0 {
		t.Fatal("登记表或豁免表为空 —— 本判据会退化成恒真断言")
	}
	for key, why := range r14kDynamicRelationCallers {
		if len(strings.TrimSpace(why)) < 10 {
			t.Errorf("登记项 %q 的理由过短（%q）：必须写清**值域从哪来**", key, why)
		}
	}
	for pkg, why := range r14kDynamicRelExemptPackages {
		if len(strings.TrimSpace(why)) < 10 {
			t.Errorf("豁免项 %q 的理由过短（%q）：必须写清为什么它不在判据面内", pkg, why)
		}
		if _, ok := searchPathGuardPackages[pkg]; !ok {
			t.Errorf("豁免项 %q 不是 server/ 下已登记的包（拼写错误或包已搬家）", pkg)
		}
	}
}

// ---------------------------------------------------------------------------
// R14-O · VC-F3：尺子**看不见**的动态关系名构造点（known-uncovered 登记）
// ---------------------------------------------------------------------------
//
// 复审泳道 V14-C 用一把更宽的自制尺子（拼接 + Sprintf，不限"同一字面量里必须有 SQL
// 动词"、不限不能跨行）做差集，发现本判据面内还有 4 个函数构造动态关系名而**两把尺子
// 都看不见或看不见其中一部分**。它们的值域各自封闭、事务都钉住 ⇒ 无行为风险，
// 但它们证明了一件事：**动态关系名的形态是开放集，"再加一条正则"不闭合**。
//
// 登记口径（与 `r14kDynamicRelationCallers` 的区别）：
//
//	`r14kDynamicRelationCallers` —— 尺子**看得见**、必须回答"值域从哪来"；
//	本表 —— 尺子**看不见**，如实登记"为什么值域封闭/为什么当前无行为风险"，
//	         并用 `markers` 钉住「形态没被改写」（函数被删/改名/改成字面量 ⇒ 红，
//	         逼人回来更新或收回这条登记）。
//
// 诚实边界：本表只做"函数仍在 + 形态标记仍在 + 理由够长"三项机械核对，
// **不校验值域**（那需要读代码判断，是评审动作，不是判据）。
var r14kDynamicRelKnownUncovered = map[string]struct {
	why     string
	markers []string
}{
	"internal/serverstore.AccessibleSharedResourceNames": {
		why: "关系名/列名来自**编译期常量表** sharedResourceTables（Table 恒为 app_grants，Col 是该表结构体的字面量字段），与请求输入无关。" +
			"尺子看不见它：关系名所在的那几个字面量里**没有 SQL 动词**（`\" FROM \" + table.Table`），而 pattern A 要求同一字面量里先有动词。",
		markers: []string{`" FROM " + table.Table`},
	},
	"internal/serverstore.ledgerDetailSource": {
		why: "关系名来自回收路径的 **catalog 事实**（孤儿分区表名），且经 quoteRelationIdent **引号化**（标识符不再走 search_path 解析）。" +
			"尺子看不见它：关系名插在语句中间、不是 fmt.Sprintf 的直接实参（`\"SELECT \" + cols + \" FROM \" + quoteRelationIdent(rel)`）。",
		markers: []string{`" FROM "+quoteRelationIdent(rel)`},
	},
	"internal/serverstore.rebuildUsageLedgerRowsFrom": {
		why: "关系名同上（ledgerDetailSource 的返回值），且 4 个调用点全部传 `tx`（清理路径的**已钉事务**）。" +
			"尺子看不见它：关系名在**多行 raw string 中间**（`FROM `+source+``），而 pattern A 的字符类排除了换行。",
		markers: []string{"FROM `+source+`"},
	},
	"internal/serverstore.createRangePartition": {
		why: "关系名 = spec.relation() = parent + \"_\" + key，而 partitionSpec 的生产构造点只有两处（usage_ledger.go:79/99），parent 恒为 usage/usage_daily、key 由时间派生 ⇒ 值域封闭；" +
			"DDL 经 runPartitionDDL →（withUsageLockBudget | runPartitionDDLAttempt → withUsageSearchPath）执行，两条路径**都已钉 search_path**。" +
			"**lane K 的尺子与本表对应的宽尺子都看不见它**（`CREATE TABLE IF NOT EXISTS %s PARTITION OF %s`：%s 前面分别是 EXISTS/OF/(，不是关系关键字）—— 这条是「开放集」结论的实证。",
		markers: []string{"PARTITION OF %s"},
	},
}

// TestAuditR14KDynamicRelationKnownUncoveredRegistry 是登记表的机械核对：
// 双向（登记的函数必须还在，且形态标记还在）+ 理由长度下限。
func TestAuditR14KDynamicRelationKnownUncoveredRegistry(t *testing.T) {
	if len(r14kDynamicRelKnownUncovered) < 4 {
		t.Fatalf("known-uncovered 登记表只剩 %d 条（下限 4：V14-C 差集给出的 4 个函数）—— 判据面被改坏",
			len(r14kDynamicRelKnownUncovered))
	}
	units := r14kLoadServerUnits(t)
	ix := r14kBuildIndex(t, units)
	bodies := map[string]string{}
	for _, u := range units {
		for _, fd := range collectDecls(u.file) {
			d := ix.declFor(u, fd)
			if d == nil {
				continue
			}
			if _, want := r14kDynamicRelKnownUncovered[d.key]; !want {
				continue
			}
			start := u.fset.Position(fd.Body.Pos()).Offset
			end := u.fset.Position(fd.Body.End()).Offset
			if start >= 0 && end <= len(u.raw) && start < end {
				bodies[d.key] = string(u.raw[start:end])
			}
		}
	}
	for key, reg := range r14kDynamicRelKnownUncovered {
		body, ok := bodies[key]
		if !ok {
			t.Errorf("known-uncovered 登记项 %q 在 server/ 里已不存在（函数被删/改名）—— "+
				"该处要么已被改写成字面量（收回登记），要么换了名字（同步登记）", key)
			continue
		}
		for _, m := range reg.markers {
			if !strings.Contains(body, m) {
				t.Errorf("known-uncovered 登记项 %q 的形态标记 %q 已不在函数体里 —— "+
					"该处可能已被改写成字面量 SQL（那是好事：请收回这条登记），"+
					"或形态变了（请更新标记与理由）", key, m)
			}
		}
		if len(strings.TrimSpace(reg.why)) < 40 {
			t.Errorf("known-uncovered 登记项 %q 的理由过短（%q）：必须写清值域来源与为什么无行为风险", key, reg.why)
		}
	}
	t.Logf("known-uncovered 登记：%d 条，全部仍在位且形态标记未变（这把尺子看不见它们，见 r14kDynamicRelKnownUncovered 的说明）",
		len(r14kDynamicRelKnownUncovered))
}
