package appdb

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// 本文件是 R1-e2e-5 的门禁：**作者文档不得把「没参数化」列为 `DB_DENIED` 的原因**。
//
// 证据（temp/wasm-review-r1/e2e-live.md 的 R1-e2e-5）：sqlgate.go 全文只有语句种类 /
// 单语句 / 保留标识符 / DDL·PRAGMA·ATTACH·VACUUM 检查，**没有任何 args/字面量分支**；
// 实测 `SELECT * FROM notes WHERE author='emp1'` 与 `DELETE FROM notes WHERE body='x'`
// 都通过。而 docs/wasm-app-authoring.md 的 `DB_DENIED` 行曾写"没参数化" —— 作者/AI 读到
// 会以为"平台替我兜住 SQL 注入"，也可能被安全评审当成已实现的控制项。
//
// 修法（2026-09-19）：文档改成如实口径（平台**不检查**参数化 + 明确警告注入要靠自己），
// 本文件把这句话的两面钉住：
//
//	A 作者可见文档里每一行 `DB_DENIED` 都不得把"缺少参数化"写成平台的拒绝原因；
//	B 作者可见文档必须**正面写明**平台不检查参数化（删掉警告即红，防"把整行删掉"式假修）；
//	C 行为锚：字面量 SQL 必须**仍然通过**闸门 —— A/B 说"平台不检查"，实现就得真的不检查；
//	  将来有人加参数化检查，这条会红，逼他同时改文档与评估破坏面（我们自己的演示应用
//	  就用字面量 SQL）。
//
// 变异验证（交付时实跑过）：
//   - 把 `docs/wasm-app-authoring.md` 的 `DB_DENIED` 行改回"…/ 没参数化；…" ⇒ A 红；
//   - 删掉那两处"平台不检查你是否参数化"的警告（只留"值放 args"） ⇒ B 红；
//   - 在 `checkStatement` 里加一条"没有 args 即拒" ⇒ C 红（同时会红掉 appdb 自己的用例）。

const (
	// authorDocRelPath 是仓库级作者指南（appdb → wasmapp → internal → server → 仓库根）。
	authorDocRelPath = "../../../../docs/wasm-app-authoring.md"
	// skillRefsRelPath 是随技能分发的参考文档目录（客户可见交付物；技能在 server/ 下）。
	skillRefsRelPath = "../../../skills/app-builder/references"
	// skillABIRelPath 是 ABI 参考（assets/db 章节的作者主入口）。
	skillABIRelPath = skillRefsRelPath + "/abi.md"
)

var (
	// paramAbsenceRe 是"缺少参数化 = 会被拒"的说法。
	paramAbsenceRe = regexp.MustCompile(`(?:没|没有|未|缺少|缺)[^。；\n]{0,2}参数化`)
	// paramEnforcementRe 是"平台要求/检查参数化"的说法（同样是错的归因）。
	paramEnforcementRe = regexp.MustCompile(`必须参数化|要求参数化|会检查参数化|不参数化检查|检查是否参数化|检查你是否参数化`)
	// paramDisclaimerRe 是"平台不检查参数化"的正面声明（多种写法都接受，避免脆弱）。
	paramDisclaimerRe = regexp.MustCompile(`(?:不检查|不会检查|不替你检查|不阻止|不拦)[^。；\n]{0,12}参数化|参数化[^。；\n]{0,6}(?:平台)?(?:不检查|不拦|不阻止)`)
)

// TestAuthorDocsDoNotClaimParameterizationIsEnforced 是判据 A+B。
func TestAuthorDocsDoNotClaimParameterizationIsEnforced(t *testing.T) {
	docs := authorFacingDocs(t)
	if len(docs) < 3 {
		t.Fatalf("只找到 %d 份作者可见文档（预期至少有作者指南 + 技能参考若干）: %v", len(docs), docPaths(docs))
	}

	// —— A：DB_DENIED 行不得把责任推给平台 ——
	for _, doc := range docs {
		for i, line := range strings.Split(doc.text, "\n") {
			if !strings.Contains(line, "DB_DENIED") {
				continue
			}
			// 已经写明"平台不检查"的行是**如实口径**，不是在把责任推给平台。
			if paramDisclaimerRe.MatchString(line) {
				continue
			}
			if paramAbsenceRe.MatchString(line) {
				t.Errorf("%s:%d 把「缺少参数化」写成 DB_DENIED 的原因，但平台没有参数化检查"+
					"（sqlgate.go 只查语句种类/单语句/保留标识符/DDL·PRAGMA·ATTACH·VACUUM）：\n  %s\n"+
					"  改正：删掉这个原因，并在同一处写明「平台不检查你是否参数化，注入要靠 args 占位自己挡」"+
					"（R1-e2e-5）", doc.rel, i+1, clip(line))
			}
			if paramEnforcementRe.MatchString(line) {
				t.Errorf("%s:%d 把「参数化」写成平台的检查项，但平台不检查参数化：\n  %s\n"+
					"  改正：这行只列真实拒绝原因；参数化写成「你自己必须做，平台不替你检查」",
					doc.rel, i+1, clip(line))
			}
		}
	}

	// —— B：如实口径必须真的写在文档里（否则"删掉警告"也能全绿）——
	for _, rel := range []string{authorDocRelPath, skillABIRelPath} {
		text := readRepoText(t, rel)
		// 换行会切开句子（文档是手写折行的），先把换行折叠成空格再匹配。
		flat := strings.ReplaceAll(text, "\n", " ")
		if !paramDisclaimerRe.MatchString(flat) {
			t.Errorf("%s 没有写明「平台不检查你是否参数化」——作者读到 DB_DENIED 表会以为"+
				"平台替他兜住 SQL 注入（R1-e2e-5）。请保留一句明确警告：平台不检查参数化，"+
				"字面量拼接不拦，注入只能靠 db.query/db.exec 的 args 占位自己挡。", rel)
		}
	}
}

// TestLiteralSQLStillPassesTheGate 是判据 C：行为锚（与 A/B 是同一句话的两面）。
//
// 为什么必须钉行为而不是只钉文档：文档说"平台不检查参数化"，实现就必须真的不检查 ——
// 反过来，若将来有人加了参数化检查，合法用法（我们自己的演示应用、以及大量既有应用）
// 会突然 DB_DENIED，而"文档已经改了"不会有人发现。
func TestLiteralSQLStillPassesTheGate(t *testing.T) {
	// 用生产同一条闸门：stmt.go 的 Query = checkStatement(sql, kindSelect)、
	// Exec = checkStatement(sql, kindInsert, kindUpdate, kindDelete)。
	literals := []struct {
		name  string
		sql   string
		kinds []sqlKind
	}{
		{"报告的实测反例：查询里带字面量值", "SELECT * FROM notes WHERE author='emp1'", []sqlKind{kindSelect}},
		{"报告的实测反例：删除里带字面量值", "DELETE FROM notes WHERE body='x'", []sqlKind{kindInsert, kindUpdate, kindDelete}},
		{"插入里带字面量值", "INSERT INTO notes(author, body) VALUES ('emp1', 'x')", []sqlKind{kindInsert, kindUpdate, kindDelete}},
	}
	for _, tc := range literals {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := checkStatement(tc.sql, tc.kinds...); err != nil {
				t.Errorf("字面量 SQL 被拒了：%v\n  SQL: %s\n"+
					"  若这是**故意**新增的参数化检查，请同时：①改文档（本文件的判据 A/B）"+
					"②评估破坏面（演示应用与既有应用都用字面量）③说明为什么不做成平台闸门", err, tc.sql)
			}
		})
	}

	// 反空转前置断言：闸门不是"永远放行"（否则上面的用例毫无意义）。
	for _, sql := range []string{"SELECT 1; SELECT 2", "CREATE TABLE t(a text)", "PRAGMA table_info(notes)"} {
		if _, err := checkStatement(sql, kindSelect); err == nil {
			t.Fatalf("闸门对 %q 放行了 —— 判据 C 已空转（闸门退化成永远放行）", sql)
		}
	}
}

// docText 是一份作者可见文档（rel 用于报错定位）。
type docText struct {
	rel  string
	text string
}

// authorFacingDocs 返回作者可见文档：仓库级作者指南 + 技能 references 下的全部 markdown。
//
// 范围与 limits_gen_test.go 的 TestSkillDiscipline 同口径（作者会照着写代码的那些载体）；
// **不扫** docs/planning/**（设计基线是历史叙述，不是给作者的现行口径）。
func authorFacingDocs(t *testing.T) []docText {
	t.Helper()
	out := []docText{{rel: authorDocRelPath, text: readRepoText(t, authorDocRelPath)}}
	entries, err := os.ReadDir(skillRefsRelPath)
	if err != nil {
		t.Fatalf("读技能参考目录 %s: %v", skillRefsRelPath, err)
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		rel := skillRefsRelPath + "/" + e.Name()
		out = append(out, docText{rel: rel, text: readRepoText(t, rel)})
	}
	return out
}

func docPaths(docs []docText) []string {
	out := make([]string, 0, len(docs))
	for _, d := range docs {
		out = append(out, filepath.ToSlash(d.rel))
	}
	return out
}

func readRepoText(t *testing.T, rel string) string {
	t.Helper()
	b, err := os.ReadFile(rel)
	if err != nil {
		t.Fatalf("读 %s: %v（文档被移位时同步本文件的路径常量）", rel, err)
	}
	return string(b)
}

func clip(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 200 {
		return s[:200] + "…"
	}
	return s
}
