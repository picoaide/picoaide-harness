package serverstore

// R14-K · D-01 的**机械守卫**：`server/**` 里不允许"已开事务、再向池里要连接"
// （hold-and-wait —— 池上限 = 并发数时自锁且不可恢复）。
//
// 为什么需要它（而不只是三处已经修好的调用点 + 三条真 PG 回归用例）：
// 这一族的形态在本仓被记录过七次"以为只有一处、实际还有第二/第三处"（本轮就是：
// lane D 的两轮扫描只报了 `updateUsageTokensAtCached`，独立复扫又找出
// `DeleteDepartment` 与 `llmgateway.setGatewayConfig` 两处）。回归用例只能钉住
// **已知**的三个入口，"下一次新增一个在事务里顺手 `db.QueryRow` 的 helper"不会被
// 任何判据发现 —— 而它的后果是**整个池不可恢复**。
//
// 判据（源码级，扫整个 `server/` 的非测试 Go 源）：
//
//	对每个函数体：找**第一个**"开事务"调用 → 该处之后的第一个**非 defer** 的
//	`tx.Commit()` / `tx.Rollback()` 之前，不允许出现"以池句柄为实参调用某个
//	首参是 `*sql.DB` 的函数"（也不允许直接对池句柄发语句）。
//
// 已知的判据边界（如实登记）：
//
//	① "区域"用**文本顺序**推断：如果事务在某个分支里提前 rollback，之后又在同一函数体
//	   里继续持有事务（极少数形态），该区域会被判成"已关闭"⇒ 漏检（假阴性）。
//	   真正的兜底仍然是三条真 PG 回归用例 + 代码评审；
//	② 只认"实参形如池句柄"（`db` / `a.DB` / `s.db` / `store.db` / `d.db` / `pool`）——
//	   把池句柄赋给别的变量名后再传（`h := db; foo(h)`）会漏检（本仓无此写法，且它本身
//	   就是可读性倒退）；
//	③ 不判"事务里调用了一个**间接**再去开事务的 helper"（helper 链超过一层时只认
//	   第一层签名）—— 第一层已覆盖本仓全部已知形态。
//
// 第二条规则（**句柄首参**形态）：函数的**首参是事务/语句句柄**（`*sql.Tx` / `rowQuerier` /
// `usageQuerier` / `usageExecer`）时，它**不允许再碰池** —— 这类函数被调用时必然已经有人
// 持有事务，碰池就是 hold-and-wait。只靠第一条规则（局部 tx-open 的区域）看不见它们：
// `auditSetSettingTx(tx, db, …)` 里的 `GetSetting(db, …)` 曾经就是这样漏掉的（变异 G3
// 实测：只有第二条规则能咬住）。
//
// 变异验证（实跑）：
//   - `usage.go` 的 `loadModelPriceInputsQ(tx, …)` 改回 `loadModelPriceInputs(db, …)` ⇒ 红（规则一）；
//   - `departments.go` 的 `groupByIDQ(tx, id)` 改回 `GroupByID(db, id)` ⇒ 红（规则一）；
//   - `llmgateway/admin.go` 的 `GetSettingTx(tx, db, …)` 改回 `GetSetting(db, …)` ⇒ 红（规则二）。

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// r14kTxOpenRe 是"开事务"的调用形态（唯一实现的入口集合）。
var r14kTxOpenRe = regexp.MustCompile(
	`(?:newUsageReadConn(?:Context)?|usageWriteTx|UsageWriteTx|NewUsageReadConn|` +
		`withUsageSearchPath(?:Read)?|WithUsageSearchPath(?:Read)?)\s*\(|\b(?:db|a\.DB|s\.db|store\.db|d\.db|pool)\.Begin(?:Tx)?\s*\(`)

// r14kTxCloseRe 是"结束事务"的形态。`defer tx.Rollback()` **不算**（它在函数返回时才跑，
// 区域仍然开着）—— 这一点是判据精准度的关键：本仓的既有写法就是
// `tx, _ := …; defer tx.Rollback(); …业务…; tx.Commit()`。
var r14kTxCloseRe = regexp.MustCompile(`\btx\.(?:Commit|Rollback)\s*\(`)

// r14kPoolDirectStmtRe 是"直接对池句柄发语句"。
var r14kPoolDirectStmtRe = regexp.MustCompile(
	`\b(?:db|a\.DB|s\.db|store\.db|d\.db|pool)\.(?:Query|QueryRow|Exec|Prepare|ExecContext|QueryContext|QueryRowContext)\s*\(`)

// r14kPoolArgCallRe 是"以池句柄为实参调用函数"的通用形态（被调方是否首参 `*sql.DB`
// 由函数签名表判定，见 r14kFuncsWithDBFirstParam）。
var r14kPoolArgCallRe = regexp.MustCompile(`\b([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*(?:db|a\.DB|s\.db|store\.db|d\.db|pool)\b`)

// r14kPoolWaitAck 是**显式认账**（键 `<包>.<函数>`）—— 只允许放"判据边界造成的假阳性"，
// 每条都要写清为什么不是 hold-and-wait。当前为空：本仓不存在需要认账的形态。
var r14kPoolWaitAck = map[string]string{}

// r14kFuncsWithDBFirstParam 扫出"首参是 `*sql.DB`"的函数名（= 每次调用都可能向池要一条连接）。
func r14kFuncsWithDBFirstParam(t *testing.T) map[string]bool {
	t.Helper()
	root := searchPathServerRoot(t)
	out := map[string]bool{}
	sigRe := regexp.MustCompile(`(?m)^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)`)
	handleFirst := map[string]bool{}
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
		for _, m := range sigRe.FindAllStringSubmatch(string(raw), -1) {
			if strings.Contains(m[2], "*sql.DB") {
				out[m[1]] = true
			}
			// 规则二的对象：首参是事务/语句句柄（而不是池句柄）。
			//
			// ⚠️ `rowQuerier` / `usageExecer` 是**多态句柄**（`*sql.DB` 与 `*sql.Tx` 都满足）：
			// 形如 `rebuildUsageLedgerRowsFrom(db usageExecer, …)` 的函数拿到什么就用什么，
			// **不存在第二次取连接**。所以句柄参数名本身若是池名（`db` / `pool`），规则二跳过。
			params := m[2]
			if hm := r14kFirstParamNameRe.FindStringSubmatch(params); hm != nil && !r14kPoolHandleRe.MatchString(hm[1]) {
				// 首参名不是池名（`db`/`pool`）⇒ 它若是事务/语句句柄，本函数不得再碰池。
				if r14kHandleParamRe.MatchString(params[len(hm[0]):]) {
					handleFirst[m[1]] = true
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("遍历 server/ 失败: %v", err)
	}
	if len(out) < 100 {
		t.Fatalf("只扫到 %d 个首参 `*sql.DB` 的函数（下限 100）—— 判据面失效", len(out))
	}
	// 句柄首参的函数表通过返回值带出（见 r14kFuncsWithDBFirstParam 的调用点）。
	r14kHandleFirstFuncs = handleFirst
	return out
}

// r14kHandleFirstFuncs 由 r14kFuncsWithDBFirstParam 填充（同一次扫描的副产品，避免第二遍 IO）。
var r14kHandleFirstFuncs = map[string]bool{}

// r14kHandleParamRe 判"参数表里有一个事务/语句句柄参数"。
var r14kHandleParamRe = regexp.MustCompile(`\*sql\.Tx\b|\browQuerier\b|\busageQuerier\b|\busageExecer\b|\bfunc\(query string`)

// r14kFirstParamNameRe 取首参的**名字**（`tx *sql.Tx` → tx；`db usageExecer` → db）。
var r14kFirstParamNameRe = regexp.MustCompile(`^\s*([A-Za-z_][A-Za-z0-9_]*)\s+`)

// r14kPoolHandleRe 是"池句柄标识符"的形态（`db` / `a.DB` / `s.db` / `store.db` / `d.db` / `pool`）。
var r14kPoolHandleRe = regexp.MustCompile(`(?i)^(?:[a-z_][a-z0-9_]*\.)?(?:db|pool)$`)

// TestAuditR14KNoPoolAcquisitionUnderTx 是 hold-and-wait 的机械判据。
func TestAuditR14KNoPoolAcquisitionUnderTx(t *testing.T) {
	root := searchPathServerRoot(t)
	dbFirst := r14kFuncsWithDBFirstParam(t)
	fnRe := regexp.MustCompile(`(?m)^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(`)
	var hits []string
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
			key := pkg + "." + fn
			if _, ok := r14kPoolWaitAck[key]; ok {
				continue
			}
			// 规则二：句柄首参的函数，整个函数体都算"已持有事务"的区域。
			scanLines := func(body string, baseLine int) {
				for i, line := range strings.Split(body, "\n") {
					st := strings.TrimSpace(line)
					if r14kPoolDirectStmtRe.MatchString(line) {
						hits = append(hits, key+" (句柄首参却直接对池发语句) @"+rel+":"+itoa(baseLine+i)+" → "+st)
						continue
					}
					for _, cm := range r14kPoolArgCallRe.FindAllStringSubmatch(line, -1) {
						if dbFirst[cm[1]] {
							hits = append(hits, key+" (句柄首参却调 "+cm[1]+"(池,…)) @"+rel+":"+itoa(baseLine+i)+" → "+st)
							break
						}
					}
				}
			}
			if r14kHandleFirstFuncs[fn] {
				braceH := strings.Index(src[start:end], "{")
				if braceH >= 0 {
					headH := src[start : start+braceH]
					scanLines(src[start+braceH+1:end], strings.Count(src[:start], "\n")+1+strings.Count(headH, "\n"))
				}
			}
			body := src[start:end]
			// 只扫**函数体**（不含签名）：否则 `func WithUsageSearchPath(db *sql.DB, …)` 这行
			// 的**自身函数名**会被 tx-open 尺子命中，凭空开出一个区域（实测的假阳性来源）。
			brace := strings.Index(body, "{")
			if brace < 0 {
				continue
			}
			head, body := body[:brace], body[brace+1:]
			baseLine := strings.Count(src[:start], "\n") + 1 + strings.Count(head, "\n")
			lines := strings.Split(body, "\n")
			depths := r14kBraceDepths(body) // depths[i] = 第 i 行结束时的花括号深度
			open, openDepth := -1, 0
			for ln, line := range lines {
				st := strings.TrimSpace(line)
				if open < 0 {
					if r14kTxOpenRe.MatchString(line) {
						open, openDepth = ln, depths[ln]
					}
					continue
				}
				// 区域结束：① 第一个**非 defer** 的 Commit/Rollback；② 开事务那一层
				// 代码块闭合（闭包形态 `withUsageSearchPath(db, func(tx){…})` 就靠这条收口
				// —— 闭包返回后事务已经结束，之后的池调用不是 hold-and-wait）。
				if r14kTxCloseRe.MatchString(st) && !strings.HasPrefix(st, "defer ") {
					open = -1
					continue
				}
				if depths[ln] < openDepth {
					open = -1
					// 本行可能同时是新块的开始：不 continue，按"区域外"继续判定
				}
				if open < 0 {
					continue
				}
				// 区域内的两次"向池要连接"检查。
				if r14kPoolDirectStmtRe.MatchString(line) {
					hits = append(hits, key+" (直接对池发语句) @"+rel+":"+itoa(baseLine+ln)+" → "+st)
					continue
				}
				for _, cm := range r14kPoolArgCallRe.FindAllStringSubmatch(line, -1) {
					if dbFirst[cm[1]] {
						hits = append(hits, key+" ("+cm[1]+"(池,…)) @"+rel+":"+itoa(baseLine+ln)+" → "+st)
						break
					}
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("遍历 server/ 失败: %v", err)
	}
	if scanned < 200 {
		t.Fatalf("只扫了 %d 个非测试源文件（下限 200）—— 判据面失效", scanned)
	}
	if len(hits) > 0 {
		sort.Strings(hits)
		t.Errorf("这些位置在**已开事务**的情况下又向连接池要了一条连接（hold-and-wait）：\n  %s\n"+
			"⇒ 池上限 = 并发数时两边互等，而 `BeginTx(context.Background())` 没有 deadline、"+
			"`SetConnMaxLifetime` 对在用连接无效 ⇒ **池不可恢复**（db.go:158 记录过同形态的真实事故）。"+
			"修法：把池上入口换成同族的 `*Q` / `*Tx` 形态（`loadModelPriceInputsQ` / `getSettingQ` / "+
			"`GetSettingTx` / `groupByIDQ` / `SetSettingTx` / `settleUsageCostTx` …），或先提交事务再取连接。"+
			"确属判据边界的假阳性请登记到 r14kPoolWaitAck 并写明理由。", strings.Join(hits, "\n  "))
	}
	t.Logf("hold-and-wait：扫过 %d 个非测试源文件，0 处「已开事务再向池要连接」（首参 *sql.DB 的函数 %d 个）",
		scanned, len(dbFirst))
}

// r14kBraceDepths 返回每一行结束时的花括号深度（用于判断"开事务的那一层代码块何时闭合"）。
//
// 必须**跳过字符串与字符字面量**：本仓的 SQL 大量写在多行反引号里，其中可能出现
// 不成对的 `{` / `}`（JSON 片段、`jsonb` 字面量），按裸字符计数会把深度算错。
func r14kBraceDepths(body string) []int {
	depth := 0
	var out []int
	inDouble, inRaw, inRune := false, false, false
	for i := 0; i < len(body); i++ {
		c := body[i]
		switch {
		case inRaw:
			if c == '`' {
				inRaw = false
			}
		case inDouble:
			if c == '\\' {
				i++
			} else if c == '"' {
				inDouble = false
			}
		case inRune:
			if c == '\\' {
				i++
			} else if c == '\'' {
				inRune = false
			}
		case c == '`':
			inRaw = true
		case c == '"':
			inDouble = true
		case c == '\'':
			inRune = true
		case c == '{':
			depth++
		case c == '}':
			depth--
		case c == '\n':
			out = append(out, depth)
		}
	}
	out = append(out, depth)
	return out
}

// itoa 是 strconv.Itoa 的本地别名（本文件只用到一处，避免为一个整数引入 import 噪音）。
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
