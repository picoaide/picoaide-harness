// Package util provides shared helpers for the picoaide server.
package util

import (
	"strings"
)

// CompareSemVer compares two version strings with SemVer 2.0.0 precedence
// (§11), tolerant of the legacy shapes this repo stores (missing patch field,
// `v` prefix, underscores).
//
// 语义（**唯一实现**，2026-09-23 R3-A 审计 A-10 收编）：
//   - 核心段按数值感知比较："1.9.0" < "1.10.0"（审计 2026-08-25 D-1）、"v2" < "v10"；
//   - 第一个 `-` 之后是**预发布段**（§9）：核心相同时**有预发布的一方更低**
//     ⇒ `CompareSemVer("1.0.0-1","1.0.0") == -1`（审计 A-10 的现场：旧实现把多出来的
//     数字 run 当"更高的补丁"，于是把 `1.0.0-1` 判成比 `1.0.0` 更新）；
//   - 两侧都有预发布段时按 §11.4 逐段比：纯数字段按数值、字母数字段按 ASCII、
//     数字段 < 字母数字段、前缀相同时**段数多者更大**；
//   - 核心相同且都没有预发布 ⇒ 0；
//   - **build metadata 忽略**（§10，2026-09-23 R4-D-1）：第一个 `+` 之后不参与比较
//     ⇒ `CompareSemVer("1.0.0+build.1","1.0.0") == 0`。修复前 '+' 不在字符白名单里
//     ⇒ 回落字节序 ⇒ 判成 +1（与规范相反）。
//
// Returns -1/0/1; when either input is empty or contains characters outside
// [0-9a-zA-Z._-], falls back to plain byte order (never panics, total order).
//
// ⚠️ 这条"预发布更低"的规则**必须与发布闸门（`wasmapp/registry.MustBeNewer`）同源**：
// 两处给出相反结论时，能力中心会把 `1.0.0-1` 当"当前版本"展示，而线上交付的是 `1.0.0`
// （A-10 的原始症状）。registry 现在直接委托本函数，并由
// `wasmapp/registry/version_parity_test.go` 的对拍用例钉住"两个调用点结论一致"。
//
// ⚠️ 跨端唯一的语义真源是**共享语料** `testdata/semver-corpus.json`（R4-D-1）：
// 本包（`semver_corpus_test.go`）、`internal/updatecheck`、`internal/skillmanifest`、
// `internal/wasmapp/registry`、TS 侧 `packages/host/enterprise/src/client/version-compare.ts`
// 与 `packages/host/desktop/src/updates.ts` 各自读同一份并逐条断言。改语义 = 改语料
// + 六处一起改，任何一侧单独"顺手实现一套"都会被语料打红。
func CompareSemVer(left, right string) int {
	if left == right {
		return 0
	}
	if left == "" || right == "" {
		return strings.Compare(left, right)
	}
	// §10：先剥 build metadata 再比（畸形 build 不剥，仍走下面的字节序兜底）。
	left, right = stripBuildMetadata(left), stripBuildMetadata(right)
	if left == right {
		return 0
	}
	if versionTokens(left) == nil || versionTokens(right) == nil {
		return strings.Compare(left, right)
	}
	// §9：第一个 '-' 之后是预发布段（build metadata 已在上面按 §10 剥掉）。
	lCore, lPre := splitPrerelease(left)
	rCore, rPre := splitPrerelease(right)
	if c := compareTokenRuns(lCore, rCore); c != 0 {
		return c
	}
	switch {
	case lPre == "" && rPre == "":
		return 0
	case lPre == "":
		// §11.3：无预发布 > 有预发布。
		return 1
	case rPre == "":
		return -1
	}
	return comparePrereleaseRuns(lPre, rPre)
}

// splitPrerelease 把版本切成核心段与预发布段（无 '-' ⇒ 预发布为空串）。
func splitPrerelease(v string) (core, pre string) {
	if i := strings.IndexByte(v, '-'); i >= 0 {
		return v[:i], v[i+1:]
	}
	return v, ""
}

// stripBuildMetadata 丢弃 §10 的 build metadata（第一个 '+' 及其后内容）。
//
// build metadata **不参与优先级**（§10 原文：Build metadata MUST be ignored when
// determining version precedence），所以它必须在这里被剥掉，而不是留给下面的字符白名单
// 判成非法 —— 后者会让 `1.0.0+build.1` 与 `1.0.0` 走字节序（+1），与本仓"挑最高版本"
// 的调用方语义相反。
//
// 只有非空且字符集合法的 build 段才剥（`[0-9A-Za-z.-]`，即 §9 允许的标识符字符）；
// `"1.0.0+"` 这类畸形输入不属于 SemVer，保持原样交给字节序兜底（不静默当成 1.0.0）。
func stripBuildMetadata(v string) string {
	i := strings.IndexByte(v, '+')
	if i < 0 {
		return v
	}
	build := v[i+1:]
	if build == "" {
		return v
	}
	for i := 0; i < len(build); i++ {
		ch := build[i]
		switch {
		case ch >= '0' && ch <= '9', ch >= 'a' && ch <= 'z', ch >= 'A' && ch <= 'Z', ch == '.', ch == '-':
		default:
			return v
		}
	}
	return v[:i]
}

// compareTokenRuns 是核心段的数值感知比较（两侧都必须已通过 versionTokens 校验）。
func compareTokenRuns(left, right string) int {
	if left == right {
		return 0
	}
	lTok := versionTokens(left)
	rTok := versionTokens(right)
	if lTok == nil || rTok == nil {
		return strings.Compare(left, right)
	}
	n := len(lTok)
	if len(rTok) > n {
		n = len(rTok)
	}
	for i := 0; i < n; i++ {
		var l, r versionToken
		haveL, haveR := false, false
		if i < len(lTok) {
			l, haveL = lTok[i], true
		}
		if i < len(rTok) {
			r, haveR = rTok[i], true
		}
		if haveL && haveR {
			if l.numeric == r.numeric && l.text == r.text {
				continue
			}
			if l.numeric && r.numeric {
				// 与预发布段同一条规则：先规范化（去前导零）再按位数/字典序比数值，
				// 两个路径不许各有一套（"01.0.0" 与 "1.0.0" 必须相等）。
				ln, _ := numericIdentifier(l.text)
				rn, _ := numericIdentifier(r.text)
				if c := compareDigitRuns(ln, rn); c != 0 {
					return c
				}
				continue
			}
			if l.numeric != r.numeric {
				// Numeric runs rank below alphabetic runs within a position
				// ("2" < "rc"), which only matters for odd inputs like "1.2"
				// vs "1.rc"; acceptable total order.
				if l.numeric {
					return -1
				}
				return 1
			}
			return strings.Compare(l.text, r.text)
		}
		// One side ran out. Who is longer decides, EXCEPT when the extra run
		// is alphabetic: that side is a prerelease and ranks LOWER than the
		// release ("1.0.0-rc1" < "1.0.0"). A numeric extra run is a higher
		// patch ("1.0" < "1.0.1").
		//
		// ⚠️ 这里只处理**核心段内部**的"多一段"（如 "1.0" vs "1.0.1"）——真正的
		// 预发布段已由 CompareSemVer 按 '-' 切走，不会走到本函数里（A-10）。
		if haveL != haveR {
			extra := l
			if haveR {
				extra = r
			}
			if extra.numeric {
				if haveL {
					return 1
				}
				return -1
			}
			if haveL {
				return -1
			}
			return 1
		}
		// Both exhausted simultaneously — equal.
		return 0
	}
	return 0
}

// comparePrereleaseRuns 按 §11.4 比较两段预发布标识符（点分段）。
func comparePrereleaseRuns(a, b string) int {
	as, bs := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(as) && i < len(bs); i++ {
		x, y := as[i], bs[i]
		xn, xOK := numericIdentifier(x)
		yn, yOK := numericIdentifier(y)
		switch {
		case xOK && yOK:
			// §11.4.2：纯数字标识符按**数值**比较（R4-D-1：比较走任意精度数字串，
			// 不能用 strconv.ParseInt —— 超长数字会溢出，两个都解析失败就退化成
			// "相等"或字典序，与规范相反，而 versionRe/limits.VersionPattern 都允许
			// 任意长度的段）。
			if c := compareDigitRuns(xn, yn); c != 0 {
				return c
			}
		case xOK:
			// §11.4.3：纯数字标识符优先级**低于**字母数字标识符。
			return -1
		case yOK:
			return 1
		default:
			if c := strings.Compare(x, y); c != 0 {
				return c
			}
		}
	}
	// §11.4.4：前缀相同 ⇒ 标识符多者更大。
	switch {
	case len(as) < len(bs):
		return -1
	case len(as) > len(bs):
		return 1
	}
	return 0
}

// numericIdentifier 报告标识符是否为纯数字（并返回**去掉前导零**的数字串）。
//
// 返回规范化数字串（"01" → "1"）而不是 int64：§11.4.2 要求按数值比较，而版本号
// 段长不受限（`versionRe` / `limits.VersionPattern` 都是 `\d+`）—— 用 ParseInt 会在
// 20 位以上溢出（旧实现即 `1.2.0-99999999999999999999` 与 `1.2.0-123456789012345678901`
// 判成相等/字典序）。去掉前导零后，"位数优先、再字典序"就是无溢出的数值比较。
// 前导零本身是 §9 禁止的形态，这里按数值语义处理（`rc.01` == `rc.1`），由共享语料
// 的 `tolerance-leading-zero` 钉住。
func numericIdentifier(s string) (string, bool) {
	if s == "" {
		return "", false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return "", false
		}
	}
	trimmed := strings.TrimLeft(s, "0")
	if trimmed == "" {
		return "0", true
	}
	return trimmed, true
}

// compareDigitRuns 比较两个纯数字串的数值大小（任意长度，无溢出）。
//
// 入参应当已去掉前导零（numericIdentifier 的返回值）；即便如此 0 串也按 "0" 处理，
// 所以直接传原始数字串也不会出错 —— 只是 `"01"` 与 `"1"` 比较时长度不同会给出
// 非 0 结果，因此调用点必须先规范化。
func compareDigitRuns(a, b string) int {
	if len(a) != len(b) {
		if len(a) < len(b) {
			return -1
		}
		return 1
	}
	return strings.Compare(a, b)
}

// versionToken is one alternating alphabetic or numeric run.
type versionToken struct {
	text    string
	numeric bool
}

// versionTokens splits a version into alternating alphabetic/numeric runs.
// Returns nil when the version contains characters outside the accepted set.
func versionTokens(v string) []versionToken {
	var out []versionToken
	var run strings.Builder
	runNumeric := false
	haveRun := false
	flush := func() {
		if haveRun {
			out = append(out, versionToken{text: run.String(), numeric: runNumeric})
			run.Reset()
			haveRun = false
		}
	}
	for _, ch := range v {
		switch {
		case ch == '.' || ch == '-' || ch == '_':
			flush()
		case ch >= '0' && ch <= '9':
			if haveRun && !runNumeric {
				flush()
			}
			run.WriteRune(ch)
			runNumeric = true
			haveRun = true
		case ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z':
			if haveRun && runNumeric {
				flush()
			}
			run.WriteRune(ch)
			runNumeric = false
			haveRun = true
		default:
			return nil
		}
	}
	flush()
	if len(out) == 0 {
		return nil
	}
	return out
}
