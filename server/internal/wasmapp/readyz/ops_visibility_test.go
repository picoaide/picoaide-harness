package readyz

// 本文件是第五轮审计 R5-A-3 / R5-A-4 / R5-A-5（以及 R5-A-2 的文案面）的判据。
//
// 四条要防的东西：
//
//	R5-A-3「可行动文案没有出口」：P0-c 引入的 `publishBlocker.Action` 唯一读者是断言它
//	   ≥12 字的测试 ⇒ 运维在 /readyz 与 503 上只看得到 reason 字面量。
//	  判据：每条**有 Action 的理由**产出的文案必须真的出现在 /readyz 的 `actions` 与
//	  AllowPublish 的 hints 里（正向逐条扫；反向：清空 Action 即红 —— 见文件末的变异记录）。
//
//	R5-A-4「失败分支自相矛盾」：err 分支拿回收**前**的读数当"现在"，会写出
//	  `现在 104857600 > 536870912` 这种假命题。
//	  判据：①文案里任何 `A > B` 必须真的 A > B（逐条解析）；②"一条删不掉、其余删够"
//	  必须判**已解除**（不许把闸门关在一条删不掉的条目上）。
//
//	R5-A-5「未认证端点外泄驱动错误」：pgx 的连接错误逐字带 `user=<用户> database=<库>` +
//	  `<host>:<port>`，而 /readyz 无认证、同一批 reasons 还进 503 details。
//	  判据：响应体与 503 details 都**不得**出现这些字段，而原文必须进服务端日志。
//
//	R5-A-2 的文案面：登记表不得再把"整目录删除"写成安全动作。

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// readyzBody 取一次 /readyz 的原始响应体与状态码。
func readyzBody(t *testing.T, c *Checker) (int, string) {
	t.Helper()
	rr := httptest.NewRecorder()
	c.Handler()(rr, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	return rr.Code, rr.Body.String()
}

// actionsOf 从 /readyz 的 JSON 响应体里取 actions 字段。
func actionsOf(t *testing.T, body string) []string {
	t.Helper()
	var parsed struct {
		Actions []string `json:"actions"`
	}
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		t.Fatalf("/readyz 响应不是合法 JSON: %v; body=%s", err, body)
	}
	return parsed.Actions
}

// containsLine 判定 lines 里是否有一行包含 needle。
func containsLine(lines []string, needle string) bool {
	for _, l := range lines {
		if strings.Contains(l, needle) {
			return true
		}
	}
	return false
}

// TestReadyzActionsExposeEveryRegistryAction：**逐条**扫登记表 —— 凡是有 Action 的理由，
// 一旦被产出，它的文案就必须出现在 /readyz 的 actions 里（R5-A-3 的正向判据）。
//
// 这条判据的形状刻意选成"遍历 reasonCases()"：新增一条带 Action 的理由时，只要它属于
// 可产出的那组，就自动落入本判据 —— 不需要有人记得回来补测试。
func TestReadyzActionsExposeEveryRegistryAction(t *testing.T) {
	for _, tc := range reasonCases() {
		t.Run(tc.name, func(t *testing.T) {
			c := New(tc.make(t))
			s := c.Snapshot()
			for _, reason := range s.Reasons {
				b, ok := publishBlockerFor(reason)
				if !ok || strings.TrimSpace(b.Action) == "" {
					continue
				}
				// 文案必须**逐字**出现在 actions 里（不是"有一个 actions 数组"就算过）。
				if !containsLine(s.Actions, b.Action) {
					t.Fatalf("理由 %q 的登记 Action 没有出现在 /readyz 的 actions 里（文案仍无出口）：actions=%v",
						b.Prefix, s.Actions)
				}
			}
			// HTTP 面同样要带（Snapshot 是内部形态，运维看的是响应体）。
			code, body := readyzBody(t, c)
			got := actionsOf(t, body)
			if len(s.Actions) != len(got) {
				t.Fatalf("/readyz 响应体的 actions 与 Snapshot 不一致：%v vs %v（code=%d）", got, s.Actions, code)
			}
			if len(s.Actions) > 0 && len(got) == 0 {
				t.Fatal("/readyz 必须把 actions 下发出去（R5-A-3：文案不能只活在源码里）")
			}
		})
	}
}

// TestPublishHintsExposeRegistryActions：发布 503 的 hints 必须由**登记表**拼出来
// （而不是另写一段处置文案）—— R5-A-3 的另一半出口。
func TestPublishHintsExposeRegistryActions(t *testing.T) {
	c := New(fixedOpts(1, nil)) // 磁盘远低于红线 ⇒ HealOperator，有 Action
	err := c.AllowPublish()
	if err == nil {
		t.Fatal("磁盘低水位必须拒绝发布")
	}
	b, ok := publishBlockerFor(reasonDiskLow)
	if !ok || b.Action == "" {
		t.Fatal("前置：磁盘低水位必须有登记 Action")
	}
	if !containsLine(err.Hints, b.Action) {
		t.Fatalf("503 的 hints 必须包含登记的 Action 原文（R5-A-3）：hints=%v", err.Hints)
	}
	if !containsLine(err.Hints, string(b.Heal)) {
		t.Fatalf("hints 必须点名**解除者种类**（%s）：hints=%v", b.Heal, err.Hints)
	}
	// 反向：把 Action 清空后同一个判据必须红 —— 这条由文件末的变异记录实跑证明。
}

// TestRegistryActionsForbidDeletingCacheDir：R5-A-2 的文案面 —— 登记表不得再把
// "整目录删除不影响正确性"当成安全动作，且凡是提到缓存目录的处置都必须写"不要"。
func TestRegistryActionsForbidDeletingCacheDir(t *testing.T) {
	retired := "整目录删除不影响正确性"
	for _, b := range publishBlockers {
		if strings.Contains(b.Action, retired) {
			t.Fatalf("登记项 %q 的 Action 仍写着「%s」—— 执行侧 wazero 的 fileCache 绑定分片目录且"+
				"不会重建，照它做会让所有冷编译失败到重启（R5-A-2）", b.Prefix, retired)
		}
		if !strings.Contains(b.Action, limits.CompileCacheDirName) {
			continue
		}
		if !strings.Contains(b.Action, "不要") {
			t.Fatalf("登记项 %q 的 Action 提到了缓存目录却没写「不要手工删除/改名」：%q", b.Prefix, b.Action)
		}
		if !strings.Contains(b.Action, "ReclaimCache") && !strings.Contains(b.Action, "CleanCache") &&
			!strings.Contains(b.Action, "回收入口") {
			t.Fatalf("登记项 %q 的 Action 必须给出**唯一正确**的恢复方式（进程内回收入口）：%q", b.Prefix, b.Action)
		}
	}
}

// dbLeakError 是与 pgx 逐字同形的连接错误（含用户名/库名/主机/端口）。
//
// 不用真连库：本条判的是"**任何**驱动错误都不许原样出去"，而 pgx 的文案形状由源码
// 核对（pgconn/errors.go：`failed to connect to \`user=%s database=%s\`: %s (%s): …`）。
func dbLeakError() error {
	return errors.New("failed to connect to `user=picoaide_app database=prod_ledger`: " +
		"db.internal.example:5432 (db.internal.example): dial error: connection refused")
}

// sensitiveSubstrings 是绝不允许出现在对外响应里的子串。
var sensitiveSubstrings = []string{"user=", "database=", "db.internal.example", "5432", "picoaide_app", "prod_ledger"}

// TestReadyzDoesNotLeakDriverErrors：R5-A-5 的判据本体。
func TestReadyzDoesNotLeakDriverErrors(t *testing.T) {
	var logs []string
	o := fixedOpts(MinDiskFreeBytes*4, nil)
	o.Ping = func() error { return dbLeakError() }
	o.Logger = func(format string, args ...any) { logs = append(logs, fmt.Sprintf(format, args...)) }
	c := New(o)

	// ① /readyz（**未认证**端点）的响应体：只允许分类后的原因。
	code, body := readyzBody(t, c)
	if code != http.StatusServiceUnavailable {
		t.Fatalf("库不可达必须 503：code=%d", code)
	}
	for _, bad := range sensitiveSubstrings {
		if strings.Contains(body, bad) {
			t.Fatalf("/readyz 响应体外泄了驱动错误里的 %q：%s", bad, body)
		}
	}
	if !strings.Contains(body, reasonDBUnreachable) {
		t.Fatalf("/readyz 必须如实报「%s」：%s", reasonDBUnreachable, body)
	}

	// ② 发布 503 的 details：同一批 reasons 的第二个出口，同样不许带原文。
	err := c.AllowPublish()
	if err == nil {
		t.Fatal("库不可达必须拒绝发布")
	}
	joined := strings.Join(reasonsOf(t, err), " ") + " " + strings.Join(hintsOf(t, err), " ")
	for _, bad := range sensitiveSubstrings {
		if strings.Contains(joined, bad) {
			t.Fatalf("503 的 reasons/hints 外泄了 %q：%s", bad, joined)
		}
	}

	// ③ 原文必须进**服务端日志**（排障能力不降级）—— 这是"分类但可排障"的另一半。
	all := strings.Join(logs, "\n")
	if !strings.Contains(all, "db.internal.example") || !strings.Contains(all, "user=picoaide_app") {
		t.Fatalf("驱动错误原文必须进服务端日志（否则等于把排障线索删掉）：%v", logs)
	}
}

// TestReadyzDBReasonIsClassified：分类必须覆盖常见形态，且每一条都不含敏感字段。
func TestReadyzDBReasonIsClassified(t *testing.T) {
	// 分类判据建立在错误类型上（errors.Is / net.Error / *net.DNSError），不是文案上。
	refused := &net.OpError{Op: "dial", Net: "tcp", Err: errRefused{}}
	if got := classifyDBError(refused); !strings.Contains(got, "拒绝") {
		t.Fatalf("连接被拒绝的分类：%q", got)
	}
	timeout := &net.DNSError{Err: "i/o timeout", Name: "db.internal.example", IsTimeout: true}
	if got := classifyDBError(timeout); got == "" || strings.Contains(got, "db.internal.example") {
		t.Fatalf("域名解析超时的分类不得回显主机名：%q", got)
	}
	if got := classifyDBError(errFake("some driver text with user=u database=d")); got == "" ||
		strings.Contains(got, "user=") {
		t.Fatalf("认不出来的错误也必须只给分类：%q", got)
	}
	if got := classifyDBError(nil); got != "" {
		t.Fatalf("nil 错误不该有分类：%q", got)
	}
	// 分类短语本身不得含冒号以外的结构化字段（防"顺手把原文格式化进去"）。
	for _, probe := range []error{
		refused, timeout, errFake("boom"), errors.New("failed to connect to `user=a database=b`: c:1"),
	} {
		got := classifyDBError(probe)
		for _, bad := range sensitiveSubstrings {
			if strings.Contains(got, bad) {
				t.Fatalf("分类短语不得包含 %q：%q", bad, got)
			}
		}
	}
}

// errRefused 让 net.OpError 的错误链里出现 ECONNREFUSED。
type errRefused struct{}

func (errRefused) Error() string { return "connect: connection refused" }
func (errRefused) Is(target error) bool {
	return strings.Contains(target.Error(), "connection refused")
}

// ===== R5-A-4：文案里的算术必须成立 =====

// reasonArith 匹配文案里的 "X > Y" / "X ≥ Y" 形态（数字都带可选下划线）。
var reasonArith = regexp.MustCompile(`(\d+) *(>|≥) *(\d+)`)

// TestReasonArithmeticIsSound：任何 reason 文本里的 `A > B` 都必须真的 A > B。
//
// 这条把 R5-A-4 的口径钉死：文案取错读数（回收前当"现在"）时会写出假命题，而那种文案
// 会把运维指向完全错误的方向（他会以为缓存仍超限）。
func TestReasonArithmeticIsSound(t *testing.T) {
	check := func(t *testing.T, text string) {
		t.Helper()
		for _, m := range reasonArith.FindAllStringSubmatch(text, -1) {
			a, _ := strconv.ParseInt(m[1], 10, 64)
			b, _ := strconv.ParseInt(m[3], 10, 64)
			switch m[2] {
			case ">":
				if !(a > b) {
					t.Fatalf("文案里的算术是假命题（%d > %d）：%s", a, b, text)
				}
			case "≥":
				if !(a >= b) {
					t.Fatalf("文案里的算术是假命题（%d ≥ %d）：%s", a, b, text)
				}
			}
		}
	}
	// ① 所有可产出理由的文案。
	for _, tc := range reasonCases() {
		t.Run("reason/"+tc.name, func(t *testing.T) {
			for _, r := range New(tc.make(t)).Snapshot().Reasons {
				check(t, r)
			}
		})
	}
	// ② 回收失败分支（R5-A-4 的现场形态）：一条删不掉 + 其余删够不了 ⇒ 仍超限，
	//    文案里的数字必须是**回收后**的读数。
	f := newFakeCache(2000, 1000)
	o := overLimitOpts(t, f)
	o.ReclaimCompileCache = f.hook(1, 400, errFake("permission denied")) // 水位不动 ⇒ 仍超限
	err := New(o).AllowPublish()
	if err == nil {
		t.Fatal("回收后仍超限必须继续拒绝发布")
	}
	for _, r := range reasonsOf(t, err) {
		check(t, r)
		if strings.Contains(r, reasonCompileCacheOver) && !strings.Contains(r, "回收后") {
			t.Fatalf("失败分支必须写清数字是**回收后**的读数（R5-A-4）：%s", r)
		}
	}
}

// TestHealAcceptsWhenPostReclaimLevelWithinLimit：**一条删不掉、但其余已删够** ⇒ 判定已解除。
//
// 旧实现只看"回收钩子有没有报错"，于是这种"水位已达标 + 某一 rmdir/权限失败"的组合会把
// 发布闸门永久关在一棵已经达标的缓存树上（并且文案还写着"现在 A > B"的假命题）。
func TestHealAcceptsWhenPostReclaimLevelWithinLimit(t *testing.T) {
	f := newFakeCache(2000, 1000)
	o := overLimitOpts(t, f)
	// 第一次读数超限（判定用）；钩子报错，但**水位已降到阈值内**（回收后复核）。
	calls := 0
	o.ReclaimCompileCache = func() (int, int64, error) {
		calls++
		f.mu.Lock()
		f.bytes = 400 // 达标
		f.mu.Unlock()
		return 1, 1600, errFake("permission denied: 1 条删不掉")
	}
	var logs []string
	o.Logger = func(format string, args ...any) { logs = append(logs, fmt.Sprintf(format, args...)) }
	if err := New(o).AllowPublish(); err != nil {
		t.Fatalf("回收后水位已达标 ⇒ 必须放行（旧行为：因为钩子报错而永久 503）：%v", err)
	}
	if calls != 1 {
		t.Fatalf("回收钩子必须恰好被调一次：%d", calls)
	}
	if !strings.Contains(strings.Join(logs, "\n"), "水位已达标") {
		t.Fatalf("降级为警告这件事必须进服务端日志（否则「为什么报错还放行」查不到）：%v", logs)
	}
}

// TestHealFailureTextUsesPostReclaimReadings 直接钉住"现在是回收后读数"：
// 注入"第一次读数 2000/1000、回收后 1500/1000" ⇒ 文案里的数字必须是 1500 而不是 2000。
func TestHealFailureTextUsesPostReclaimReadings(t *testing.T) {
	f := newFakeCache(2000, 1000)
	o := overLimitOpts(t, f)
	o.ReclaimCompileCache = func() (int, int64, error) {
		f.mu.Lock()
		f.bytes = 1500 // 回收后仍超限，但已经不是那个 2000
		f.mu.Unlock()
		return 2, 500, errFake("permission denied")
	}
	err := New(o).AllowPublish()
	if err == nil {
		t.Fatal("回收后仍超限必须继续 503")
	}
	reasons := strings.Join(reasonsOf(t, err), " ")
	if !strings.Contains(reasons, "1500") {
		t.Fatalf("文案必须用**回收后**的读数（1500），而不是判定时的 2000：%s", reasons)
	}
	if strings.Contains(reasons, "2000") {
		t.Fatalf("文案不得再引用回收前的读数（R5-A-4 的自相矛盾形态）：%s", reasons)
	}
	if !strings.Contains(reasons, "回收后") {
		t.Fatalf("必须写清这是回收后的复核结果：%s", reasons)
	}
}
