// Package util provides shared helpers for the picoaide server.
package util

import (
	"strconv"
	"strings"
)

// CompareSemVer compares two version strings with numeric-aware semantics.
// The accepted syntax mirrors the shared store's versionRe
// (^[0-9a-zA-Z.-]{1,64}$). The comparison tokenizes each version into
// alternating alphabetic/numeric runs (separators . - _ ignored), then
// compares numerically where both runs are numeric, lexically otherwise:
//   - "1.9.0" < "1.10.0" (numeric, not lexicographic — 审计 2026-08-25 D-1)
//   - "v2"    < "v10"
//   - "1.0.0-rc1" < "1.0.0" (a trailing alphabetic run is a prerelease)
//
// Returns -1/0/1; when either input is empty or contains characters outside
// [0-9a-zA-Z._-], falls back to plain byte order (never panics, total order).
func CompareSemVer(left, right string) int {
	if left == right {
		return 0
	}
	if left == "" || right == "" {
		return strings.Compare(left, right)
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
