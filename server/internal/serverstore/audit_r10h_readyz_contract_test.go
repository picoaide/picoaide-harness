package serverstore

// R10-H3 泳道 · **W3-5（P3）+ 新字段的文档/契约对拍**。
//
// W3-5 的形态：`cmd/server/usage_retention_readyz.go` 的运维注释写"想知道**停摆发生过
// 几次**"（读作事件计数），而字段实际数的是**轮数**（同一次停摆持续 N 轮即计 N）——
// 运维按"次数"做趋势会得到系统性偏大的读数。
//
// 本文件的判据是**跨端对拍**（不是"各钉自己的字面量"）：
//
//	① 文档里提到的每一个 `usage_retention` 字段名，都必须在
//	   `UsageRetentionStatus`（/readyz 里那个对象的**唯一**真源）的 JSON 键里存在
//	   —— 文档不得引用不存在的字段；
//	② 反向：本泳道新增的四个可观测面（W3-2 的其它月份、W3-3 的单调最早未回收月、
//	   W3-4 的调度轮次语义）必须在文档里有可消费口径；
//	③ W3-5 的错误措辞不得回来（"停摆发生过几次"），且必须说明它是**轮数**。
//
// 复跑：
//
//	PG_DSN_TEST=postgres://postgres:postgres@127.0.0.1:5432/r10h3 \
//	  go test ./internal/serverstore/ -run 'TestR10HW5' -count=1 -v

import (
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"
)

// r10hReadyzDocPath 是 `/readyz` 的保留期契约文档（运维消费口径的唯一落点）。
const r10hReadyzDocPath = "../../cmd/server/usage_retention_readyz.go"

// r10hReadyzDoc 读取契约文档（读不到就 fail-loud：判据不能因为文件改名而静默失效）。
func r10hReadyzDoc(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Clean(r10hReadyzDocPath))
	if err != nil {
		t.Fatalf("读 /readyz 契约文档 %s: %v", r10hReadyzDocPath, err)
	}
	return string(raw)
}

// r10hStatusJSONKeys 返回 UsageRetentionStatus 的 JSON 键集合（含嵌套对象）。
//
// 取的是**结构体定义**（reflect 读 json tag），不是某一份 marshal 结果 —— 后者受
// `omitempty` 影响，零值字段会"看起来不存在"，判据就会假绿（第一版踩过：
// `deferred_*` 全被判成"文档提到但不存在的键"）。
func r10hStatusJSONKeys(t *testing.T) map[string]bool {
	t.Helper()
	keys := map[string]bool{}
	var walk func(rt reflect.Type, depth int)
	walk = func(rt reflect.Type, depth int) {
		if depth > 2 {
			return
		}
		for i := 0; i < rt.NumField(); i++ {
			f := rt.Field(i)
			if f.PkgPath != "" { // 未导出字段不进 JSON
				continue
			}
			name := strings.Split(f.Tag.Get("json"), ",")[0]
			if name != "" && name != "-" {
				keys[name] = true
			}
			ft := f.Type
			for ft.Kind() == reflect.Pointer || ft.Kind() == reflect.Slice {
				ft = ft.Elem()
			}
			if ft.Kind() == reflect.Struct && ft != reflect.TypeOf(time.Time{}) {
				walk(ft, depth+1)
			}
		}
	}
	walk(reflect.TypeOf(UsageRetentionStatus{}), 0)
	return keys
}

// TestR10HW5ReadyzDocMatchesStatusContract 是 W3-5 的判据。
func TestR10HW5ReadyzDocMatchesStatusContract(t *testing.T) {
	doc := r10hReadyzDoc(t)
	keys := r10hStatusJSONKeys(t)

	// ① 文档里出现的 `usage_retention.<字段>` 与裸字段名，必须都是真实 JSON 键。
	//    只扫"看上去像本域字段"的标识符（下划线风格且带域前缀），避免把普通英文单词
	//    当字段名。
	fieldRe := regexp.MustCompile(`\b(?:deferred|stalled|oldest_unreclaimed|write_blocked|write_error|failed_rounds|last_error|last_round_at|configured_months|cutoff_month|cleared_partitions|cleared_detached|skipped_by_reason|unreclaimed|skipped|failed_relations|relations|failures|rounds)_?[a-z_]*\b`)
	seen := map[string]bool{}
	for _, m := range fieldRe.FindAllString(doc, -1) {
		seen[m] = true
	}
	// 只对"成套字段名"做断言：文档里可能写 `write_blocked_*` 这类通配前缀。
	var checked []string
	for name := range seen {
		if strings.HasSuffix(name, "_") {
			continue
		}
		checked = append(checked, name)
	}
	sort.Strings(checked)
	for _, name := range checked {
		if name == "rounds" || name == "failures" || name == "skipped" || name == "relations" ||
			name == "failed_rounds" || name == "last_error" || name == "last_round_at" ||
			name == "configured_months" || name == "cutoff_month" || name == "cleared_partitions" ||
			name == "cleared_detached" || name == "skipped_by_reason" || name == "unreclaimed" ||
			name == "failed_relations" {
			continue // 裸词（可能是普通英文用法），只查带域前缀的那些
		}
		if !keys[name] {
			t.Errorf("文档提到 %q，但 UsageRetentionStatus 里没有这个 JSON 键（文档与真源漂移）", name)
		}
	}

	// ② 本泳道新增的三个可观测面必须在文档里有消费口径。
	for _, want := range []string{
		"write_blocked_other_months", // W3-2
		"oldest_unreclaimed_month",   // W3-3
		"oldest_unreclaimed_since",   // W3-3
		"oldest_unreclaimed_rounds",  // W3-3
		"oldest_unreclaimed_reason",  // W3-3
		"deferred_stalled_rounds",    // W3-5（轮数语义）
		"write_error_other_months",   // 同因的瞬时面
	} {
		if !strings.Contains(doc, want) {
			t.Errorf("/readyz 契约文档必须给出 %q 的消费口径（本泳道新增的可观测面）", want)
		}
	}

	// ③ W3-5：错误措辞（读作"次数/发生过几次"）不得回来；必须写明是轮数。
	if strings.Contains(doc, "停摆发生过几次") {
		t.Errorf("W3-5 回归：`deferred_stalled_rounds` 数的是**轮数**，文档不得再写「停摆发生过几次」")
	}
	if !strings.Contains(doc, "轮数") {
		t.Errorf("文档必须写明 `deferred_stalled_rounds` 是**轮数**（同一次停摆持续 N 轮即计 N）")
	}
	// ④ W3-4：文档必须说明"调度轮次"语义（管理端即时轮次不计入 streak）。
	if !strings.Contains(doc, "调度轮次") {
		t.Errorf("文档必须说明 streak 只计**调度轮次**（管理端保存触发的即时轮次不计入；W3-4）")
	}
}
