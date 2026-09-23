package util

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// 本文件是 R4-D-1（2026-09-23 第四轮审计，P1）的**跨端语料判据**（Go 侧参考实现）。
//
// 现场：同一个版本对在服务端与客户端得出相反结论 —— `1.0.0-rc10` vs `1.0.0-rc2`
// Go=-1 / 客户端=+1（把降级当升级），`1.0.0-rc1` vs `1.0.0-rc.1` Go=+1 / 客户端=0
// （判成相等 ⇒ 漏更新）。修法不是"再写一遍同样的算法"，而是把语义抽成**仓内共享语料**
// `testdata/semver-corpus.json`，五处 Go 调用点 + 两处 TS 调用点各自读同一份逐条断言。
//
// 判据有三层，缺任一层都会被"看起来改好了"骗过：
//  1. 逐条：符号必须等于语料里的 `want`（**不是**"两边相等"这种自证式断言），
//     并顺带断言反对称（reverse 必须给出相反符号）；
//  2. 完整性：`requiredSemverCorpusPairs` 是写死在这里的**独立清单** —— 从语料文件里
//     删掉那两对分叉（或 §11 规范链的任一步、build metadata 那条）本用例立刻红；
//  3. 规模下限：`len(cases) >= 20`（删条目同时改这里才会绿，属于"要动手改判据"的显式动作）。
//
// 变异验证（实跑见交付报告 temp/round4-2026-09-23/fix-r4d-version-compare.md）：
// 把 CompareSemVer 的 build metadata 剥离去掉（`+` 回落字节序）⇒ build metadata 三条红；
// 把预发布段比较换成"整串字典序"⇒ §11 链与 rc10/rc2 红；把语料里的两对分叉删掉 ⇒ 第 2 层红。
func TestCompareSemVerSharedCorpus(t *testing.T) {
	cases := loadSemverCorpus(t)

	// 第 3 层：规模下限。
	if len(cases) < 20 {
		t.Fatalf("共享语料只有 %d 对，至少 20 对（R4-D-1 的修法要求语料覆盖分叉对 + §11 边界 + build metadata）", len(cases))
	}

	// 第 2 层：独立写死的必备清单（不读语料文件，删语料即红）。
	have := make(map[[2]string]bool, len(cases))
	for _, c := range cases {
		have[[2]string{c.Left, c.Right}] = true
	}
	for _, pair := range requiredSemverCorpusPairs {
		if !have[pair] {
			t.Errorf("共享语料缺少必备对 %q vs %q（R4-D-1 的语义真源不允许被裁剪）", pair[0], pair[1])
		}
	}

	// 第 1 层：逐条符号 + 反对称。
	for _, c := range cases {
		if got := sign(CompareSemVer(c.Left, c.Right)); got != c.Want {
			t.Errorf("[%s] CompareSemVer(%q,%q)=%d want %d（%s）", c.ID, c.Left, c.Right, got, c.Want, c.Note)
		}
		if got := sign(CompareSemVer(c.Right, c.Left)); got != -c.Want {
			t.Errorf("[%s] 反对称失败：CompareSemVer(%q,%q)=%d want %d", c.ID, c.Right, c.Left, got, -c.Want)
		}
	}
}

// requiredSemverCorpusPairs 是判据**自己**的必备清单（与语料文件解耦，见文件头第 2 层）。
//
// 为什么要写死：语料是数据，判据不能只信数据 —— 把两对分叉悄悄删掉，一个"逐条遍历语料"
// 的用例反而会全绿（遍历空集也是全绿）。这份清单就是"语料被裁剪"的探针。
var requiredSemverCorpusPairs = [][2]string{
	{"1.0.0-rc10", "1.0.0-rc2"},           // R4-D-1 分叉对①（ASCII 序，不是数字 run）
	{"1.0.0-rc1", "1.0.0-rc.1"},           // R4-D-1 分叉对②（预发布按 '.' 分段）
	{"1.0.0+build.1", "1.0.0"},            // §10 build metadata 忽略
	{"1.0.0-alpha", "1.0.0-alpha.1"},      // §11 规范样例链（§11.4.4 段数）
	{"1.0.0-alpha.1", "1.0.0-alpha.beta"}, // §11.4.3 数字 < 字母数字
	{"1.0.0-alpha.beta", "1.0.0-beta"},    // §11.4.2 ASCII 序
	{"1.0.0-beta", "1.0.0-beta.2"},
	{"1.0.0-beta.2", "1.0.0-beta.11"}, // §11.4.2 数字标识符按数值
	{"1.0.0-beta.11", "1.0.0-rc.1"},
	{"1.0.0-rc.1", "1.0.0"}, // §11.3 预发布 < 同名发布版
	{"2.7.2-beta.7", "2.7.2-beta.8"},
	{"1.0.0-rc.01", "1.0.0-rc.1"},                                 // 容错对：前导零数字标识符按数值比较（旧实现按位数 ⇒ +1）
	{"1.2.0-99999999999999999999", "1.2.0-123456789012345678901"}, // §11.4.2 任意精度（超 int64 不许溢出）
	{"99999999999999999999.0.0", "123456789012345678901.0.0"},     // 同上，核心段
}

// semverCorpusCase 是共享语料的一条（字段名即 JSON 契约，TS 侧读同一份文件）。
type semverCorpusCase struct {
	ID    string `json:"id"`
	Left  string `json:"left"`
	Right string `json:"right"`
	Want  int    `json:"want"`
	Note  string `json:"note"`
}

// loadSemverCorpus 读 `testdata/semver-corpus.json`。
//
// 文件缺席 / schema 不符 / 条目字段缺失一律 **t.Fatal（不 skip）**：语料是跨端语义的
// 唯一真源，"文件不在"本身就是回归（本仓已有先例：appcfg-contract 的对拍同样以缺席即红）。
func loadSemverCorpus(t *testing.T) []semverCorpusCase {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "semver-corpus.json"))
	if err != nil {
		t.Fatalf("读共享语料失败（跨端语义真源必须随仓存在）：%v", err)
	}
	var doc struct {
		Schema string             `json:"schema"`
		Cases  []semverCorpusCase `json:"cases"`
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
	for _, c := range doc.Cases {
		if c.ID == "" || c.Left == "" || c.Right == "" {
			t.Fatalf("共享语料条目字段缺失：%+v", c)
		}
		if c.Want != -1 && c.Want != 0 && c.Want != 1 {
			t.Fatalf("共享语料 [%s] 的 want=%d 不是 -1/0/1", c.ID, c.Want)
		}
	}
	return doc.Cases
}

// sign 把任意整数压成 -1/0/1（比较器只承诺符号，不承诺量值）。
func sign(v int) int {
	switch {
	case v < 0:
		return -1
	case v > 0:
		return 1
	default:
		return 0
	}
}
