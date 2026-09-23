package util

import "testing"

// 本文件是 util.CompareSemVer 的语义表 —— 2026-09-23 R3-A 审计 A-10（P2）后它同时是
// **两个调用点**（能力中心目录投影 + wasm 发布闸门 registry.CompareVersions）的唯一语义。
//
// 变异（实跑见交付报告）：把 CompareSemVer 改回"多出来的数字 run 即更高"的旧逻辑 ⇒
// `{"1.0.0-1","1.0.0",-1}` 与 `{"1.0.0","1.0.0-1",1}` 两条红；把 prerelease 段
// 整段忽略 ⇒ `{"1.2.3-beta.1","1.2.3-beta.2",-1}` 红。
func TestCompareSemVer(t *testing.T) {
	cases := []struct {
		l, r string
		want int
	}{
		{"1.0.0", "1.0.0", 0},
		{"1.0.0", "1.0.1", -1},
		{"1.9.0", "1.10.0", -1}, // numeric, not lexicographic (审计 2026-08-25 D-1)
		{"2.0.0", "10.0.0", -1},
		{"1.0.0-rc1", "1.0.0", -1}, // prerelease ranks below release
		{"1.0.0", "1.0.0-rc1", 1},
		{"1.0", "1.0.1", -1},
		{"v2", "v10", -1},
		{"1.2.3-beta.1", "1.2.3-beta.2", -1},
		{"", "1.0.0", -1},
		{"1.0.0", "", 1},
		{"a.b", "a.c", -1},

		// ===== A-10（2026-09-23）：预发布段必须按 SemVer §11 参与比较 =====
		// 审计现场：旧实现把 "-1" 里多出来的数字 run 当成"更高的补丁" ⇒ 判成 +1，
		// 于是能力中心把 `1.0.0-1` 显示为"当前版本"，而线上交付的是 `1.0.0`。
		{"1.0.0-1", "1.0.0", -1},
		{"1.0.0", "1.0.0-1", 1},
		{"2.7.2-beta.7", "2.7.2-beta.8", -1},
		// §11.4.3 数字标识符 < 字母数字标识符。
		{"1.0.0-1", "1.0.0-alpha", -1},
		{"1.0.0-alpha", "1.0.0-1", 1},
		// §11.4.2 数字标识符按数值（不是字典序）。
		{"1.0.0-2", "1.0.0-10", -1},
		// §11.4.3 字母数字标识符按 ASCII 字典序 —— `rc10 < rc2`（'1' < '2'）。
		// ⚠️ 本条**修正**了旧实现的期望值：旧 tokenizer 把 "rc10"/"rc2" 当数字 run
		// 比数值（给出 +1），但那不是 SemVer 语义（规范原文：ASCII sort order）。
		// 发布闸门 registry.CompareVersions 一直是 -1，两条路径由此对齐。
		{"1.0.0-rc10", "1.0.0-rc2", -1},
		// §11.4.4 前缀相同 ⇒ 标识符多者更大。
		{"1.0.0-alpha", "1.0.0-alpha.1", -1},
		{"1.0.0-alpha.1", "1.0.0-alpha.beta", -1},
		// SemVer §11 的规范样例链：alpha < alpha.1 < alpha.beta < beta < beta.2 < beta.11 < rc.1 < 发布版。
		{"1.0.0-alpha", "1.0.0-beta", -1},
		{"1.0.0-beta.11", "1.0.0-rc.1", -1},
		{"1.0.0-rc.1", "1.0.0", -1},
	}
	sign := func(x int) int {
		if x < 0 {
			return -1
		}
		if x > 0 {
			return 1
		}
		return 0
	}
	for _, c := range cases {
		got := CompareSemVer(c.l, c.r)
		if sign(got) != sign(c.want) {
			t.Errorf("CompareSemVer(%q,%q)=%d want %d", c.l, c.r, got, c.want)
		}
	}
}

// TestCompareSemVerIsAntisymmetric 钉住偏序的基本性质（排序与"挑当前版本"都靠它）。
func TestCompareSemVerIsAntisymmetric(t *testing.T) {
	corpus := []string{
		"1.0.0", "1.0.0-1", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-beta.11", "1.0.0-rc.1",
		"1.0", "1.0.1", "1.10.0", "1.9.0", "2.7.2-beta.7", "2.7.2-beta.8", "v2", "v10",
	}
	for _, a := range corpus {
		if got := CompareSemVer(a, a); got != 0 {
			t.Fatalf("CompareSemVer(%q,%q)=%d want 0", a, a, got)
		}
		for _, b := range corpus {
			ab, ba := CompareSemVer(a, b), CompareSemVer(b, a)
			if ab != -ba {
				t.Fatalf("非反对称：(%q,%q)=%d 而 (%q,%q)=%d", a, b, ab, b, a, ba)
			}
		}
	}
}
