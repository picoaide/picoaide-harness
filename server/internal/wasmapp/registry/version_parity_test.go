package registry

import (
	"testing"

	"github.com/picoaide/picoaide/internal/util"
)

// A-10（2026-09-23 R3-A 审计，P2）的对拍门禁：**同一个版本对，两个调用点必须给出同一个
// 结论**。
//
// 现场：`util.CompareSemVer("1.0.0-1","1.0.0") = +1`（把预发布判成更新）而发布闸门用的
// `registry.CompareVersions` = -1 ⇒ 能力中心把 `1.0.0-1` 当"当前版本"展示，而线上交付的
// 生效版本是 `1.0.0`。修复方式是把 registry 的实现**收编**到 util（唯一实现），本用例用
// 一张**期望表**（不是"两边相等"这种自证式断言）钉住语义：任一侧被重新实现成别的规则，
// 表里的期望值都会红。
func TestVersionComparatorsAgreeOnCorpus(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		// A-10 的原始现场：预发布 < 同名发布版。
		{"1.0.0-1", "1.0.0", -1},
		{"1.0.0", "1.0.0-1", 1},
		// 发布闸门的主路径（严格递增）。
		{"1.0.0", "1.1.0", -1},
		{"1.1.0", "1.1.0", 0},
		{"2.0.0", "10.0.0", -1},
		// 预发布自身的顺序：同 core、beta.7 < beta.8（跨预发的升级要能发出去）。
		{"2.7.2-beta.7", "2.7.2-beta.8", -1},
		{"1.0.0-alpha", "1.0.0-alpha.1", -1},
		{"1.0.0-1", "1.0.0-alpha", -1},
		// 能力中心的排序/挑当前版本要用的形态。
		{"1.0.0-rc.1", "1.0.0", -1},
		{"1.9.0", "1.10.0", -1},
	}
	for _, c := range cases {
		if got := CompareVersions(c.a, c.b); got != c.want {
			t.Errorf("registry.CompareVersions(%q,%q)=%d want %d", c.a, c.b, got, c.want)
		}
		if got := util.CompareSemVer(c.a, c.b); got != c.want {
			t.Errorf("util.CompareSemVer(%q,%q)=%d want %d（两个调用点必须一致）", c.a, c.b, got, c.want)
		}
		if a, b := CompareVersions(c.a, c.b), util.CompareSemVer(c.a, c.b); a != b {
			t.Errorf("两个调用点结论不一致：registry=%d util=%d（%q vs %q）", a, b, c.a, c.b)
		}
	}
}
