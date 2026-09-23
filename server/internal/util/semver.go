// Package util provides shared helpers for the picoaide server.
package util

import (
	"strconv"
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
//   - 核心相同且都没有预发布 ⇒ 0。
//
// Returns -1/0/1; when either input is empty or contains characters outside
// [0-9a-zA-Z._-], falls back to plain byte order (never panics, total order).
//
// ⚠️ 这条"预发布更低"的规则**必须与发布闸门（`wasmapp/registry.MustBeNewer`）同源**：
// 两处给出相反结论时，能力中心会把 `1.0.0-1` 当"当前版本"展示，而线上交付的是 `1.0.0`
// （A-10 的原始症状）。registry 现在直接委托本函数，并由
// `wasmapp/registry/version_parity_test.go` 的对拍用例钉住"两个调用点结论一致"。
func CompareSemVer(left, right string) int {
	if left == right {
		return 0
	}
	if left == "" || right == "" {
		return strings.Compare(left, right)
	}
	if versionTokens(left) == nil || versionTokens(right) == nil {
		return strings.Compare(left, right)
	}
	// §9：第一个 '-' 之后是预发布段（本仓不接受 build metadata，未做 `+` 处理）。
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
				ln, _ := strconv.ParseInt(l.text, 10, 64)
				rn, _ := strconv.ParseInt(r.text, 10, 64)
				if ln < rn {
					return -1
				}
				if ln > rn {
					return 1
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
			if xn != yn {
				if xn < yn {
					return -1
				}
				return 1
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

// numericIdentifier 报告标识符是否为纯数字（并返回其数值）。
func numericIdentifier(s string) (int64, bool) {
	if s == "" {
		return 0, false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0, false
		}
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		// 超长数字串：按字典序回落到非数字分支会让结论不稳定，这里退化为"相等"，
		// 由上层（版本号长度上限 64）保证不会真的出现。
		return 0, false
	}
	return n, true
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
