package api

// 本文件是**作者数据面分页上限的跨文件同值判据**（2026-09-23，R3 审计 A 项）。
//
// 现场（为什么需要这条判据）：`rowsMaxLimit = 200` 是真平台限制，却既不在 limits 表里、
// 也没有任何判据把 `docs/wasm-app-authoring.md` 里那句「一页最多 200 行」绑回代码。
// 它能通过 `TestSkillDiscipline` 的数值纪律纯属**撞上** `diagnostics_max_limit = 200`
// （另一个接口的条数上限）—— 实测：把文档那句改成「256 行」（256 同样只是表里某个无关
// count 值）之后，`TestSkillDiscipline` 与 `TestRowsLimitsMatchAuthorFacingDocs`
// **全绿**。也就是说"这个数字被守住了"在那条载体上从来不是真的。
//
// 现在判据链是三处同值，任一漂移即红：
//
//	limits.RowsPageMax（真源；进生成物 references/limits.md）
//	  ↔ rowsMaxLimit（本包实现；TestRowsPageMaxIsBoundToLimitsTruthSource）
//	  ↔ docs/wasm-app-authoring.md 的那句话（TestAuthorDocLimitsAnchorsMatchTable，
//	    **键锚定**：先把文档里的数字抠出来，再与**指定键**的值比，不是"某个 200 存在即可"）
//
// SKILL 侧的两处散文（`references/publishing.md` 与 `references/diagnostics.md` 的
// "缺省 50、最多 200"）由既有的 `rows_test.go` 的 `TestRowsLimitsMatchAuthorFacingDocs`
// 绑到 `rowsMaxLimit`，跨语言侧由客户端
// `packages/client/wasm-apps/src/client/rows-paging-contract.spec.ts` 绑住 50/200。
//
// ---- 变异验证（2026-09-23 实跑，命令与输出见交付报告）----
//   - `rows.go` 的 `rowsMaxLimit` 改成 300（文档不动）⇒ 本文件第一条用例红；
//   - `limits.go` 的 `RowsPageMax` 改成 300 并重跑生成器（文档不动）⇒ 第二条用例红
//     （作者文档仍写 200），且此时生成链 `-check`、`TestSkillDiscipline` 仍绿
//     —— 红**只**来自这条跨文件判据；
//   - `docs/wasm-app-authoring.md` 的那句改成 256（代码不动，256 是表里已存在的值）
//     ⇒ 第二条用例红（修复前同样的变异是全绿的）。
//
// ---- 边界（认账，别把本文件读成"整份文档都被守住了"）----
//   - 锚点是**逐句**登记的：句子被改写 ⇒ 用例报"锚点没命中"并要求同步更新锚点表
//     （不会静默通过，但改文案的人必须记得改这张表）；
//   - 只覆盖 `authorDocLimitAnchors` 登记的句子，不是"文档里每个数字都对"；
//   - `rowsDefaultLimit`（50）仍未进 limits 表：它已被两条跨文件判据钉住（本包随包散文
//     对拍 + 客户端跨语言对拍），是否入表留给主控拍板。

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// authorDocLimitAnchors 是「作者文档里点了名的某个上限」→「limits 表的键」的登记表。
//
// re 必须恰好有一个捕获组（文档里写的那个数字）。**找不到匹配即判红**：句子被改写 /
// 文档被搬走时，宁可让判据显式要求维护锚点表，也不要静默退化成空转。
var authorDocLimitAnchors = []struct {
	// key 是 limits 表的键（用键而不是值：值相同不代表同一件事）。
	key string
	// rel 是仓库根相对路径。
	rel string
	// re 抽取文档里写的数字。
	re *regexp.Regexp
	// why 说明这个锚点守的是什么。
	why string
}{
	{
		key: "rows_page_max",
		rel: "docs/wasm-app-authoring.md",
		re:  regexp.MustCompile(`一页最多\s*(\d+)\s*行`),
		why: "§6.2「三条边界」第 3 条：作者与 AI 据此设计分页（行浏览不是导出接口）",
	},
}

// TestRowsPageMaxIsBoundToLimitsTruthSource 断言实现常量与 limits 真源同值。
//
// 变异方式：把 `rowsMaxLimit` 改成 300 ⇒ 红（改回即绿）。
func TestRowsPageMaxIsBoundToLimitsTruthSource(t *testing.T) {
	if rowsMaxLimit != limits.RowsPageMax {
		t.Errorf("rows.go 的 rowsMaxLimit = %d，而 limits.RowsPageMax = %d —— "+
			"这个上限的真源是 limits 表（会进生成物 references/limits.md），两处必须同值。\n"+
			"  改上限的正确顺序：①改 limits.go 的 RowsPageMax；②跑 `go generate ./internal/wasmapp/limits`；"+
			"③同步 rows.go 与作者文档（本条与 TestAuthorDocLimitsAnchorsMatchTable 会逐条判红）。",
			rowsMaxLimit, limits.RowsPageMax)
	}
	// 上限必须严格大于缺省：否则"能要更多"是假的（客户端面板按缺省页大小翻页）。
	if rowsMaxLimit <= rowsDefaultLimit {
		t.Errorf("rowsMaxLimit(%d) 必须 > rowsDefaultLimit(%d)", rowsMaxLimit, rowsDefaultLimit)
	}
}

// TestAuthorDocLimitsAnchorsMatchTable 断言「作者文档里点了名的上限」与 limits 表**指定键**同值。
//
// 与 `checkNumbersComeFromLimits`（值存在性）的分工：那条只要求"文档里的数字在表里
// 存在**某个**同量纲同值的条目"，因此 `diagnostics_max_limit = 200` 会让"一页最多 200 行"
// 假绿；本条把它锚到**键** `rows_page_max` 上，值相同但键不同不再能蒙混。
//
// 变异方式：把作者文档那句改成 256（256 是表里已存在的 count 值）⇒ 红；把锚点键从表里
// 删掉 ⇒ 红（不是静默跳过）。
func TestAuthorDocLimitsAnchorsMatchTable(t *testing.T) {
	byKey := map[string]string{}
	for _, e := range limits.Table() {
		byKey[e.Key] = e.Value
	}
	for _, a := range authorDocLimitAnchors {
		want, ok := byKey[a.key]
		if !ok {
			t.Errorf("锚点表引用的 limits 键 %q 不在 Table() 里（键被改名/删除）—— "+
				"本判据必须红而不是静默失效；请同步 `limitsspec.go` 的键名与本表。（%s）", a.key, a.why)
			continue
		}
		raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", filepath.FromSlash(a.rel)))
		if err != nil {
			t.Errorf("读作者文档 %s: %v（文档被搬走/改名 ⇒ 本判据必须红）", a.rel, err)
			continue
		}
		m := a.re.FindStringSubmatch(string(raw))
		if m == nil {
			t.Errorf("%s 里找不到锚点 %s（%s）—— 文档被改写了？\n"+
				"  处置：把这句话写回来，或同步本文件的 authorDocLimitAnchors（**不要删掉这条判据**："+
				"删掉等于把这个数字的守卫一起删掉）。", a.rel, a.re.String(), a.why)
			continue
		}
		if m[1] == want {
			continue
		}
		// 数字形态先校验一次，避免"锚点抓到了别的东西"（如把版本号抓进来）。
		if _, err := strconv.Atoi(m[1]); err != nil {
			t.Errorf("%s 的锚点命中了非数字 %q（锚点正则写歪了？）", a.rel, m[1])
			continue
		}
		t.Errorf("%s 写的是 %s，而 limits 表 %s = %s —— 作者文档与真源不一致。\n"+
			"  %s。\n"+
			"  注意：这条判据是**跨文件同值**（键锚定）；`checkNumbersComeFromLimits` 的"+
			"「值存在性」判据对它是无效的 —— 别的表项凑巧同值时它照样绿。", a.rel, m[1], a.key, want, a.why)
	}
}
