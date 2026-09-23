package updatecheck

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/picoaide/picoaide/internal/util"
)

// R4-D-1（2026-09-23 第四轮审计，P1）的跨端语料判据 —— 本包是那"五处 Go 调用点"之一。
//
// 本包曾经自带第二套比较实现（core 按位数比 + 预发布按 §11），与 util/客户端三套并行；
// 审计实测出跨端分叉（`1.0.0-rc1` vs `1.0.0-rc.1`：旧 updatecheck = -1、客户端 = 0、
// util = +1）。现在 `CompareSemVer` **委托** `util.CompareSemVer`，本文件把两件事分开钉：
//
//  1. 合法域内**只有一份语义**：共享语料 `../util/testdata/semver-corpus.json` 的每一对，
//     本包与 util 必须同时等于语料里的 `want`（任一被改回旧实现都会红 —— 语料的
//     `1.0.0-rc1` vs `1.0.0-rc.1` 对旧 updatecheck 是 -1，而 want 是 +1）；
//  2. **故意保留的差异**：非法输入 ⇒ 0（不提示升级/降级），而 util 回落字节序。
//     这条差异是安全方向且 `Check` 生产路径上不可达（两侧都先过 NormalizeVersion），
//     所以它必须被显式钉住 —— 否则将来有人"顺手统一"成 util 的字节序兜底，
//     本地 dev 构建会变成"永远有更新"。
func TestCompareSemVerSharedCorpus(t *testing.T) {
	cases := loadUpdatecheckSemverCorpus(t)
	if len(cases) < 20 {
		t.Fatalf("共享语料只有 %d 对，至少 20 对（R4-D-1）", len(cases))
	}
	// 必备对：写死在这里（与语料文件解耦）—— 从语料里删掉那两对分叉，本用例即红。
	have := make(map[[2]string]bool, len(cases))
	for _, c := range cases {
		have[[2]string{c.Left, c.Right}] = true
	}
	for _, pair := range requiredUpdatecheckCorpusPairs {
		if !have[pair] {
			t.Errorf("共享语料缺少必备对 %q vs %q（R4-D-1 的语义真源不允许被裁剪）", pair[0], pair[1])
		}
	}
	for _, c := range cases {
		want := signOf(c.Want)
		got := signOf(CompareSemVer(c.Left, c.Right))
		if got != want {
			t.Errorf("[%s] updatecheck.CompareSemVer(%q,%q)=%d want %d（%s）", c.ID, c.Left, c.Right, got, want, c.Note)
		}
		if reverse := signOf(CompareSemVer(c.Right, c.Left)); reverse != -want {
			t.Errorf("[%s] 反对称失败：CompareSemVer(%q,%q)=%d want %d", c.ID, c.Right, c.Left, reverse, -want)
		}
		// 与唯一实现逐条对拍：合法域内不存在第二种语义。
		if utilSign := signOf(util.CompareSemVer(c.Left, c.Right)); utilSign != got {
			t.Errorf("[%s] 本包与 util 分叉：updatecheck=%d util=%d（%q vs %q）", c.ID, got, utilSign, c.Left, c.Right)
		}
	}
}

// requiredUpdatecheckCorpusPairs 是判据**自己**的必备清单（与语料文件解耦）。
//
// 语料是数据，判据不能只信数据：一个只"遍历语料"的用例在语料被裁剪后反而全绿
// （遍历子集也是全绿）。这份清单是"语料被裁剪"的探针，两端（Go/TS）各持一份。
var requiredUpdatecheckCorpusPairs = [][2]string{
	{"1.0.0-rc10", "1.0.0-rc2"}, // R4-D-1 分叉对①
	{"1.0.0-rc1", "1.0.0-rc.1"}, // R4-D-1 分叉对②
	{"1.0.0+build.1", "1.0.0"},  // §10 build metadata 忽略
	{"1.0.0-alpha", "1.0.0-alpha.1"},
	{"1.0.0-beta.11", "1.0.0-rc.1"},
	{"1.0.0-rc.1", "1.0.0"},
	{"1.0.0-rc.01", "1.0.0-rc.1"},                                 // 前导零（旧实现按位数 ⇒ +1）
	{"1.2.0-99999999999999999999", "1.2.0-123456789012345678901"}, // 超 int64 不许溢出
}

// TestCompareSemVerInvalidStaysZero 是"故意保留的差异"的判据（见文件头第 2 条）。
//
// 变异验证：把兜底换成 `return util.CompareSemVer(left, right)` ⇒ 前三条红
// （`dev` 会被判成比 `2.8.1` 更大 ⇒ 本地构建永远提示更新）。
func TestCompareSemVerInvalidStaysZero(t *testing.T) {
	cases := []struct{ left, right string }{
		{"dev", "2.8.1"},
		{"2.5.1", "not-a-version"},
		{"2.5", "2.5.0"},  // 缺段：不可比 ⇒ 0（util 会给出 -1）
		{"", "2.8.1"},     // 空串：不可比 ⇒ 0（util 会给出 -1）
		{"2.8.1", ""},     // 同上，反向
		{"v2.5", "2.5.1"}, // v 前缀 + 缺段：不可比 ⇒ 0（util 会给出 +1）
	}
	for _, c := range cases {
		if got := CompareSemVer(c.left, c.right); got != 0 {
			t.Errorf("CompareSemVer(%q,%q)=%d want 0（非法输入必须「不提示」，这是本包与 util 的既定差异）", c.left, c.right, got)
		}
	}
}

// updatecheckSemverCase 与 util 侧读同一份 JSON（字段名即契约）。
type updatecheckSemverCase struct {
	ID    string `json:"id"`
	Left  string `json:"left"`
	Right string `json:"right"`
	Want  int    `json:"want"`
	Note  string `json:"note"`
}

// loadUpdatecheckSemverCorpus 读 util 包 testdata 下的共享语料。
//
// 路径相对本包目录（Go 测试的 cwd 恒为包目录）。语料缺席即 Fail（不 skip）：
// 它是跨端语义的唯一真源，缺了就等于判据消失。
func loadUpdatecheckSemverCorpus(t *testing.T) []updatecheckSemverCase {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "util", "testdata", "semver-corpus.json"))
	if err != nil {
		t.Fatalf("读共享语料失败（../util/testdata/semver-corpus.json 是 R4-D-1 的语义真源）：%v", err)
	}
	var doc struct {
		Schema string                  `json:"schema"`
		Cases  []updatecheckSemverCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("共享语料不是合法 JSON：%v", err)
	}
	if doc.Schema != "picoaide-semver-corpus/1" {
		t.Fatalf("共享语料 schema=%q，want picoaide-semver-corpus/1", doc.Schema)
	}
	if len(doc.Cases) == 0 {
		t.Fatal("共享语料没有任何用例")
	}
	return doc.Cases
}

func signOf(v int) int {
	switch {
	case v < 0:
		return -1
	case v > 0:
		return 1
	default:
		return 0
	}
}
