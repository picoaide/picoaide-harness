package util

import "testing"

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
		{"1.0.0-rc10", "1.0.0-rc2", 1}, // numeric inside suffix: 10 > 2
	}
	for _, c := range cases {
		got := CompareSemVer(c.l, c.r)
		sign := func(x int) int {
			if x < 0 {
				return -1
			}
			if x > 0 {
				return 1
			}
			return 0
		}
		if sign(got) != sign(c.want) {
			t.Errorf("CompareSemVer(%q,%q)=%d want %d", c.l, c.r, got, c.want)
		}
	}
}
