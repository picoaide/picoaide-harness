package capabilities

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

// FIX-15(审计 2026-09-12,P1):`?type=` 手写逐字符累加是 O(n²)。
//
// 缺陷形态:原实现用 `part += string(ch)` 逐**字符**拼接。Go 字符串不可变,
// 每次 `+=` 都要分配并拷贝整个已累积前缀 ⇒ 整体二次复杂度。入口
// `GET /api/client/v2/capabilities` 只有 BearerAuth 且无限流,所以任意已认证
// 员工发一个大 `?type=` 就能烧掉几百 CPU·秒。审计实测(真实 parseTypeFilter):
//
//	16 KB → 114 ms ; 64 KB → 795 ms ; 128 KB → 3.71 s ; 256 KB → 14.96 s
//
// 修法:strings.Split + map(单遍线性)+ main.go 设 MaxHeaderBytes: 16<<10
// (纵深:超长请求行根本进不到业务代码)。
//
// 本测试的判据是**时间预算**:256 KB 在修复前需要 ~15 s,修复后应在毫秒级。
// 用 2 s 作为闸门(比修复后的实测值宽两个数量级,又比修复前的 15 s 严一个
// 数量级),既不会在慢 CI 上抖成假红,也不可能被二次实现通过。

func typeFilterReq(t *testing.T, query string) typeFilter {
	t.Helper()
	gin.SetMode(gin.TestMode)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("GET", "/api/client/v2/capabilities?type="+query, nil)
	return parseTypeFilter(c)
}

func TestParseTypeFilterSemantics(t *testing.T) {
	cases := []struct {
		query        string
		wantS, wantA bool
	}{
		{"", true, true},
		{"all", true, true},
		{"skill", true, false},
		{"agent", false, true},
		{"skill,agent", true, true},
		{"agent,skill", true, true},
		{"skill,", true, false},      // 尾随逗号
		{",skill", true, false},      // 前导逗号
		{"skill,,agent", true, true}, // 空片段
		{"other", false, false},      // 未知值 → 两者都不选(与修复前一致)
		{"skill,other", true, false},
	}
	for _, tc := range cases {
		got := typeFilterReq(t, tc.query)
		if got.skills != tc.wantS || got.agents != tc.wantA {
			t.Errorf("parseTypeFilter(%q) = {skills:%v agents:%v}, want {skills:%v agents:%v}",
				tc.query, got.skills, got.agents, tc.wantS, tc.wantA)
		}
	}
}

// TestParseTypeFilterLargeInputIsLinear 锁复杂度:256 KB 输入必须远快于
// 二次实现。修复前 14.96 s,修复后毫秒级。
func TestParseTypeFilterLargeInputIsLinear(t *testing.T) {
	// ⚠️ 载荷必须让**单个片段**长到 256 KB —— 这才是二次实现的痛点。
	// 用 "skill,skill,..." 这种带逗号的载荷是错的:`part` 每 6 个字符就被
	// flush 重置,永远不会增长,二次项根本不出现(实测修复前也只有 34 ms,
	// 测试会假绿)。审计的载荷是刻意构造的**无逗号长串**。
	const target = 256 << 10 // 262144
	query := strings.Repeat("a", target)
	if len(query) < target {
		t.Fatalf("fixture too small: %d < %d", len(query), target)
	}

	start := time.Now()
	got := typeFilterReq(t, query)
	elapsed := time.Since(start)

	// 单个未知片段("aaa…")在两种实现下都应两者都不选。
	if got.skills || got.agents {
		t.Fatalf("256KB 未知片段 = {skills:%v agents:%v}, want {false false}", got.skills, got.agents)
	}
	// 修复前 ~15 s;给足两个数量级余量,仍能挡住任何二次实现。
	if elapsed > 2*time.Second {
		t.Fatalf("256 KB `?type=` 耗时 %v, 预算 2s —— 仍是超线性实现(修复前 ~15s)", elapsed)
	}
	t.Logf("256 KB parseTypeFilter 耗时 %v", elapsed)
}

// TestParseTypeFilterScalingIsLinear 用**规模比值**判复杂度,避免依赖
// 机器速度的绝对阈值。
//
// 二次实现:规模 ×4 ⇒ 时间 ×16;线性实现:×4 ⇒ ×4 上下。
//
// 2026-09-12 二次修复(主控复验发现):本用例最初写成"纯时间比值"判据,在
// `go test -p 4 ./...` 的并发负载下会抖成**假红** —— 实测首次跑到 ratio=9.77
// (32 KB=228µs / 128 KB=2.23ms),而单独重跑三次是 3.52 / 4.20 / 3.81。
// 根因:被测量本身只有几百微秒,而并发调度抖动可达毫秒级;更根本的是
// `typeFilterReq` 每次都重建 `httptest.NewRequest`,把**与被测函数无关**的
// URL 解析/拷贝成本也算进了比值(实测 NewRequest 与 parseTypeFilter 各占约
// 一半,且两者都是线性 —— 比值本该稳定,是"极小基数 + 调度噪声"造成的波动)。
//
// 因此判据改为**确定性**的:
//  1. 语义等价:线性实现与"参考实现"的输出必须逐一致(不依赖计时);
//  2. 规模闸门:128 KB 输入的**绝对耗时**必须远低于二次实现的量级
//     (修复前 128 KB ≈ 3.7 s;这里给 1 s,比修复后实测的 ~1.4 ms 宽约 700×,
//     比修复前严约 3.7×,在并发负载下也不会抖红);
//  3. 比值判据保留为**诊断输出**(t.Logf),不再作为失败条件。
func TestParseTypeFilterScalingIsLinear(t *testing.T) {
	measure := func(n int) time.Duration {
		// 同上:无逗号长串,逼出二次项。
		q := strings.Repeat("a", n)
		// 预热一次,避免首次调用的调度抖动污染比值。
		_ = typeFilterReq(t, q)
		best := time.Hour
		// 3 次取最小值:进一步压掉并发负载下的调度抖动。
		for i := 0; i < 3; i++ {
			st := time.Now()
			_ = typeFilterReq(t, q)
			if d := time.Since(st); d < best {
				best = d
			}
		}
		return best
	}
	small := measure(32 << 10)
	large := measure(128 << 10) // ×4 规模
	if small <= 0 || large <= 0 {
		t.Skip("计时精度不足")
	}
	ratio := float64(large) / float64(small)
	// 诊断:比值只打印,不作判据(见函数头注释)。
	t.Logf("scale ×4: 32KB=%v 128KB=%v ratio=%.2f (线性≈4, 二次≈16;仅诊断)", small, large, ratio)

	// 判据(确定性):128 KB 的绝对耗时必须远低于二次实现的量级。
	// 修复前 128 KB ≈ 3.71 s;修复后实测 ≈ 0.3–2.7 ms。1 s 的闸门比修复后宽
	// 约 700×、比修复前严约 3.7×,并发负载抖不动它。
	const budget = time.Second
	if large > budget {
		t.Fatalf("128 KB 输入耗时 %v,超过预算 %v —— 疑似退化为二次实现", large, budget)
	}
}

// TestParseTypeFilterMatchesReference 用**参考实现**逐字节对拍,给出不依赖
// 计时的复杂度证据:如果 parseTypeFilter 是二次的,它仍会通过本用例,但
// 上面的绝对预算会拦住;反之若实现被改错(如未处理尾随逗号),本用例拦住。
func TestParseTypeFilterMatchesReference(t *testing.T) {
	// 参考实现:先复刻 switch 的具名分支("" 与 "all" 返回全量,在 default 之前),
	// 再对 default 分支做直观的 split(语义:空片段忽略,不 trim)。
	reference := func(raw string) typeFilter {
		switch raw {
		case "skill":
			return typeFilter{skills: true}
		case "agent":
			return typeFilter{agents: true}
		case "", "all":
			return typeFilter{skills: true, agents: true}
		}
		seen := map[string]bool{}
		for _, part := range strings.Split(raw, ",") {
			if part != "" {
				seen[part] = true
			}
		}
		return typeFilter{skills: seen["skill"], agents: seen["agent"]}
	}
	for _, raw := range []string{
		"", "all", "skill", "agent", "skill,agent", "agent,skill",
		"skill,", ",skill", ",,skill,,", "SKILL", "skill,agent,other",
		strings.Repeat("a", 4096), strings.Repeat("a,", 2048) + "skill",
	} {
		got := typeFilterReq(t, raw)
		want := reference(raw)
		if got != want {
			t.Fatalf("parseTypeFilter(%q) = %+v, 参考实现 = %+v", raw, got, want)
		}
	}
}
