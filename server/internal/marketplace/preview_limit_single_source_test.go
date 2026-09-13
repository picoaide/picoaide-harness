package marketplace

import (
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/skillmanifest"
)

// previewLimitDecl 匹配常量声明行:既覆盖 `const maxFilePreviewBytes = ...`,
// 也覆盖 const 块内的 `MaxSkillMDBytes = ...`。
var previewLimitDecl = regexp.MustCompile(`(?m)^\s*(?:const\s+)?(maxFilePreviewBytes|MaxSkillMDBytes)\s*=\s*([^\n]+)$`)

// TestPreviewLimitSingleSource(P2-5,审计 2026-09-13):审核预览上限只有一个
// 真源(skillmanifest.MaxSkillMDBytes = 128 KB)。marketplace 曾自带第 4 份
// 1 MB 拷贝,与 sharedskills / agentshare / skillmanifest 三处漂移——同一
// 不变式多份拷贝正是漂移的温床,这里把四处一起钉住。
//
// agentshare / sharedskills 的常量是包私有的,跨包无法引用,所以用源码
// 对拍;对拍失败即"声明点变了",必须同步更新本用例(而不是放宽断言)。
func TestPreviewLimitSingleSource(t *testing.T) {
	want := int64(skillmanifest.MaxSkillMDBytes)
	if want != 128<<10 {
		t.Fatalf("skillmanifest.MaxSkillMDBytes = %d, want 128 KB(审核预览上限的契约值)", want)
	}
	if int64(maxFilePreviewBytes) != want {
		t.Fatalf("marketplace.maxFilePreviewBytes = %d, want %d(skillmanifest.MaxSkillMDBytes)",
			maxFilePreviewBytes, want)
	}
	for _, f := range []struct{ path, name string }{
		{"admin.go", "maxFilePreviewBytes"},
		{"../sharedskills/routes.go", "maxFilePreviewBytes"},
		{"../agentshare/archive.go", "maxFilePreviewBytes"},
		{"../skillmanifest/manifest.go", "MaxSkillMDBytes"},
	} {
		src, err := os.ReadFile(f.path)
		if err != nil {
			t.Fatalf("read %s: %v", f.path, err)
		}
		got, ok := previewLimitValue(src, f.name)
		if !ok {
			t.Fatalf("%s 里找不到 %s 的常量声明(锁定失效,请更新本用例的对拍清单)", f.path, f.name)
		}
		if got != want {
			t.Fatalf("%s: %s = %d, want %d(四处必须同值)", f.path, f.name, got, want)
		}
	}
}

// previewLimitValue 从源码文本取出某个常量声明的值(取首个匹配)。
func previewLimitValue(src []byte, name string) (int64, bool) {
	for _, m := range previewLimitDecl.FindAllStringSubmatch(string(src), -1) {
		if m[1] == name {
			return evalPreviewLimit(m[2]), true
		}
	}
	return 0, false
}

// evalPreviewLimit 只支持本项目实际使用的整数常量形态:`128 << 10`、
// `1 << 20`、对真源的引用 `skillmanifest.MaxSkillMDBytes`。
func evalPreviewLimit(expr string) int64 {
	expr = strings.TrimSpace(expr)
	if i := strings.Index(expr, "//"); i >= 0 {
		expr = strings.TrimSpace(expr[:i])
	}
	if expr == "skillmanifest.MaxSkillMDBytes" {
		return int64(skillmanifest.MaxSkillMDBytes)
	}
	if parts := strings.SplitN(expr, "<<", 2); len(parts) == 2 {
		a, _ := strconv.ParseInt(strings.TrimSpace(parts[0]), 0, 64)
		b, _ := strconv.ParseInt(strings.TrimSpace(parts[1]), 0, 64)
		return a << b
	}
	v, _ := strconv.ParseInt(expr, 0, 64)
	return v
}
