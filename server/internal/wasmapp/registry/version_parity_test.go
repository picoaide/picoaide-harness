package registry

import (
	"encoding/json"
	"os"
	"path/filepath"
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

// R4-D-1（2026-09-23 第四轮审计，P1）的跨端语料判据 —— 本包是发布闸门（`MustBeNewer`）
// 所在包，也是"能力中心目录投影 vs 发布闸门"这对口径里更硬的那一侧。
//
// 与上面 A-10 那张表的分工：那张表是**手写期望值**（钉住闸门自己的形态），本用例读
// **仓内共享语料** `internal/util/testdata/semver-corpus.json` —— 与 util、updatecheck、
// skillmanifest、TS 侧两份实现读的是同一份文件。语料里的必备对（两对分叉 + §11 规范链
// + build metadata）写死在这里，从语料里删条目本用例即红。
func TestVersionComparatorsAgreeOnSharedCorpus(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "util", "testdata", "semver-corpus.json"))
	if err != nil {
		t.Fatalf("读共享语料失败（internal/util/testdata/semver-corpus.json 是 R4-D-1 的语义真源）：%v", err)
	}
	var doc struct {
		Schema string `json:"schema"`
		Cases  []struct {
			ID    string `json:"id"`
			Left  string `json:"left"`
			Right string `json:"right"`
			Want  int    `json:"want"`
			Note  string `json:"note"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("共享语料不是合法 JSON：%v", err)
	}
	if doc.Schema != "picoaide-semver-corpus/1" {
		t.Fatalf("共享语料 schema=%q，want picoaide-semver-corpus/1", doc.Schema)
	}
	if len(doc.Cases) < 20 {
		t.Fatalf("共享语料只有 %d 对，至少 20 对（R4-D-1）", len(doc.Cases))
	}

	// 必备对（写死在这里，与语料文件解耦）：删语料即红。
	required := [][2]string{
		{"1.0.0-rc10", "1.0.0-rc2"},
		{"1.0.0-rc1", "1.0.0-rc.1"},
		{"1.0.0+build.1", "1.0.0"},
		{"1.0.0-alpha", "1.0.0-alpha.1"},
		{"1.0.0-alpha.1", "1.0.0-alpha.beta"},
		{"1.0.0-alpha.beta", "1.0.0-beta"},
		{"1.0.0-beta", "1.0.0-beta.2"},
		{"1.0.0-beta.2", "1.0.0-beta.11"},
		{"1.0.0-beta.11", "1.0.0-rc.1"},
		{"1.0.0-rc.1", "1.0.0"},
	}
	have := make(map[[2]string]bool, len(doc.Cases))
	for _, c := range doc.Cases {
		have[[2]string{c.Left, c.Right}] = true
	}
	for _, pair := range required {
		if !have[pair] {
			t.Errorf("共享语料缺少必备对 %q vs %q（R4-D-1 的语义真源不允许被裁剪）", pair[0], pair[1])
		}
	}

	sign := func(v int) int {
		switch {
		case v < 0:
			return -1
		case v > 0:
			return 1
		default:
			return 0
		}
	}
	for _, c := range doc.Cases {
		want := sign(c.Want)
		gotRegistry := sign(CompareVersions(c.Left, c.Right))
		gotUtil := sign(util.CompareSemVer(c.Left, c.Right))
		if gotRegistry != want {
			t.Errorf("[%s] registry.CompareVersions(%q,%q)=%d want %d（%s）", c.ID, c.Left, c.Right, gotRegistry, want, c.Note)
		}
		if gotRegistry != gotUtil {
			t.Errorf("[%s] 发布闸门与 util 分叉：registry=%d util=%d（%q vs %q）", c.ID, gotRegistry, gotUtil, c.Left, c.Right)
		}
		if reverse := sign(CompareVersions(c.Right, c.Left)); reverse != -want {
			t.Errorf("[%s] 反对称失败：CompareVersions(%q,%q)=%d want %d", c.ID, c.Right, c.Left, reverse, -want)
		}
	}
}
