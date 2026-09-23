package skillmanifest

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/picoaide/picoaide/internal/util"
)

// R4-D-1（2026-09-23 第四轮审计，P1）的跨端语料判据 —— 本包是那"五处 Go 调用点"之一。
//
// 本包曾经自带第三套比较实现（`strconv.Atoi` + 丢错误 + 预发布按位数比），与
// util/updatecheck/客户端三套并行。现在 `CompareVersions` **委托** `util.CompareSemVer`，
// 由共享语料 `../util/testdata/semver-corpus.json` 逐条钉住语义。
//
// 语料里有两条**专门为本包的旧实现**准备的判别对（旧实现必红）：
//   - `long-numeric-prerelease`（20 位 vs 21 位数字标识符）：旧实现 Atoi 溢出后丢错误
//     ⇒ 两边都当 0 ⇒ 判成相等（want -1）；
//   - `tolerance-leading-zero`（`rc.01` vs `rc.1`）：旧实现按「位数 + 字典序」⇒ +1（want 0）。
//
// 另有包内既有判据（`manifest_test.go` 的 TestCompareVersions）继续钉 `1.2.0-rc.10 > 1.2.0-rc.2`
// 这类真实发布形态；两者互补：一个钉共享语义，一个钉本包调用面。
func TestCompareVersionsSharedCorpus(t *testing.T) {
	cases := loadSkillmanifestSemverCorpus(t)
	if len(cases) < 20 {
		t.Fatalf("共享语料只有 %d 对，至少 20 对（R4-D-1）", len(cases))
	}
	// 必备对：写死在这里（与语料文件解耦）—— 从语料里删掉那两对分叉，本用例即红。
	have := make(map[[2]string]bool, len(cases))
	for _, c := range cases {
		have[[2]string{c.Left, c.Right}] = true
	}
	for _, pair := range requiredSkillmanifestCorpusPairs {
		if !have[pair] {
			t.Errorf("共享语料缺少必备对 %q vs %q（R4-D-1 的语义真源不允许被裁剪）", pair[0], pair[1])
		}
	}
	for _, c := range cases {
		got := signSkillmanifest(CompareVersions(c.Left, c.Right))
		if got != c.Want {
			t.Errorf("[%s] skillmanifest.CompareVersions(%q,%q)=%d want %d（%s）", c.ID, c.Left, c.Right, got, c.Want, c.Note)
		}
		if reverse := signSkillmanifest(CompareVersions(c.Right, c.Left)); reverse != -c.Want {
			t.Errorf("[%s] 反对称失败：CompareVersions(%q,%q)=%d want %d", c.ID, c.Right, c.Left, reverse, -c.Want)
		}
		if utilSign := signSkillmanifest(util.CompareSemVer(c.Left, c.Right)); utilSign != got {
			t.Errorf("[%s] 本包与 util 分叉：skillmanifest=%d util=%d（%q vs %q）", c.ID, got, utilSign, c.Left, c.Right)
		}
	}
}

// requiredSkillmanifestCorpusPairs 是判据**自己**的必备清单（与语料文件解耦）。
//
// 语料是数据，判据不能只信数据：一个只"遍历语料"的用例在语料被裁剪后反而全绿。
// 这份清单是"语料被裁剪"的探针，两端（Go/TS）各持一份。
var requiredSkillmanifestCorpusPairs = [][2]string{
	{"1.0.0-rc10", "1.0.0-rc2"}, // R4-D-1 分叉对①
	{"1.0.0-rc1", "1.0.0-rc.1"}, // R4-D-1 分叉对②
	{"1.0.0+build.1", "1.0.0"},  // §10 build metadata 忽略
	{"1.0.0-alpha", "1.0.0-alpha.1"},
	{"1.0.0-beta.11", "1.0.0-rc.1"},
	{"1.0.0-rc.1", "1.0.0"},
	{"1.0.0-rc.01", "1.0.0-rc.1"},                                 // 前导零（旧实现按位数 ⇒ +1）
	{"1.2.0-99999999999999999999", "1.2.0-123456789012345678901"}, // 超 int64 不许溢出
}

// skillmanifestSemverCase 与 util 侧读同一份 JSON（字段名即契约）。
type skillmanifestSemverCase struct {
	ID    string `json:"id"`
	Left  string `json:"left"`
	Right string `json:"right"`
	Want  int    `json:"want"`
	Note  string `json:"note"`
}

// loadSkillmanifestSemverCorpus 读 util 包 testdata 下的共享语料（cwd 恒为包目录）。
// 语料缺席即 Fail（不 skip）——它是跨端语义的唯一真源。
func loadSkillmanifestSemverCorpus(t *testing.T) []skillmanifestSemverCase {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "util", "testdata", "semver-corpus.json"))
	if err != nil {
		t.Fatalf("读共享语料失败（../util/testdata/semver-corpus.json 是 R4-D-1 的语义真源）：%v", err)
	}
	var doc struct {
		Schema string                    `json:"schema"`
		Cases  []skillmanifestSemverCase `json:"cases"`
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

func signSkillmanifest(v int) int {
	switch {
	case v < 0:
		return -1
	case v > 0:
		return 1
	default:
		return 0
	}
}
