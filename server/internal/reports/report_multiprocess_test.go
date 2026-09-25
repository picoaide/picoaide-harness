package reports

// R20A-S-04（审计 2026-09-25，**P1**）的判据：**两个真进程**各跑一次生产入口
// `DispatchAll`，共用同一个 PG 与同一个 webhook 接收器，只差一个启动偏移 δ
// （= 两个副本各自的 tick 时刻）—— 同一期月报只允许被投递**一次**。
//
// ## 为什么必须是"真两个进程"
//
// 缺陷本体是**跨实例**的：判定（`ListReportSubscriptions` + `SubscriptionDuePeriod`）
// 用的是**旧快照**，生成（秒级）插在判定与认领之间 ⇒ 两个进程各自读列表时对方还没落账，
// 等各自生成完再去认领时对方早已 release ⇒ 两边都认领成功、都推一次。
// 单进程内的交错（goroutine / 注入延迟）构造不出这个形态：锁在同一进程里是**同一把**，
// 而 bug 恰恰是"锁覆盖不到快照到认领之间的那段"。审计方实测（修前）同库同接收器、
// δ=150ms：同一期被投 95~101 次，认领**从未被拒**。
//
// ## 判据（三条，缺一条都不算闭合）
//
//	① **投递次数守恒**：跨进程账本里每个订阅恰好一笔（两个进程的 ok 之和 == 订阅数）。
//	   修前 ⇒ 2N（两边都投了全部订阅）。
//	② **两个进程的"调用前快照"都必须认为全部订阅欠投**（worker 在调 DispatchAll
//	   **之前**按同一份生产策略读一次；这是 teeth：只要两边都拿着"还欠投"的旧视图，
//	   修前的代码必然两边都推 ⇒ ① 会红。少了这条，δ 一旦偏大（第二个进程醒来时
//	   第一个已经落账）判据就会静默失去牙齿）。
//	③ **账本笔数 == ok 之和**（量具自洽：账本记的是接收器真实收到的请求）。
//
// ## 自校准（δ 的选择）
//
// δ 必须落在"两个进程的快照→落账窗口重叠"的区间里：δ < G（生成月报耗时）。
// G 取决于数据量 ⇒ 本用例先自己量一次（真跑 `GenerateMonthlyReportForPeriod`），
// 再取 δ = G/2（夹到 [10ms, 800ms]）—— 判据**复刻自己的动作**来校准，而不是假定
// 机器有多快（CI runner 比开发机慢几倍，写死 δ 会变成假绿/假红）。
// 数据量（seed 的 usage 行数）同样按"让 G 达到可测的量级"来定。

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

const (
	// mpRoleEnv 非空 = 本进程是**被拉起的 worker**（不是驱动用例）。
	mpRoleEnv = "PICOAI_TEST_R20MP_ROLE"
	// mpDSNEnv 是驱动进程传给 worker 的**具体库** DSN（不是模板 DSN）：
	// 两个进程必须落在同一个库上，用 serverstore.NewTestDB 各建一个库就测不到跨实例。
	mpDSNEnv = "PICOAI_TEST_R20MP_DSN"
	// mpHookEnv 是驱动进程的 webhook 接收器地址（两个 worker 投到同一处）。
	mpHookEnv = "PICOAI_TEST_R20MP_HOOK"
	// mpStartEnv 是"什么时候调用 DispatchAll"的绝对时刻（Unix 毫秒）——
	// 用绝对时刻而不是 sleep 错开：两个真进程的启动开销（动态库加载、连接建立）
	// 不确定，用信号 + sleep 会把 δ 搅成随机量。
	mpStartEnv = "PICOAI_TEST_R20MP_START_MS"
	// mpMonthEnv 是 DispatchAll 的 month 参数（RFC3339，北京时区）。
	mpMonthEnv = "PICOAI_TEST_R20MP_MONTH"
	// mpResultPrefix 是 worker 打到 stdout 的结果行（驱动的机器可读出口）。
	mpResultPrefix = "R20MP_RESULT "
)

var mpResultPattern = regexp.MustCompile(`R20MP_RESULT role=(\w+) ok=(\d+) failed=(\d+) due_before=(\d+)`)

// mpTestMonth 是判据用的 month 参数：北京 2026-09 ⇒ 期号 2026-08。
func mpTestMonth() time.Time { return bjAt(2026, 9, 15, 10) }

// TestMonthlyDispatchIsOnceAcrossProcesses 是驱动：建库 → 起接收器 → 种订阅与用量 →
// 拉起两个 worker（相隔 δ）→ 断言"每个订阅只被投一次"。
func TestMonthlyDispatchIsOnceAcrossProcesses(t *testing.T) {
	if os.Getenv(mpRoleEnv) != "" {
		t.Skip("worker 进程由驱动用例拉起；本用例只做驱动")
	}
	allowLocalWebhooks(t)
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	ctx := context.Background()

	// —— 账本：接收器每收到一次投递写一行（跨进程可见的**唯一**事实源）。
	if _, err := db.Exec(`CREATE TABLE r20mp_deliveries (
		id bigserial PRIMARY KEY, period text NOT NULL, hit_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		t.Fatalf("建账本: %v", err)
	}
	hook := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Period string `json:"period"`
		}
		// 解析失败也记账（period 记空串）——判据要的是"收到过几次"，
		// 不因为一处 JSON 形状问题而漏记。
		_ = json.NewDecoder(r.Body).Decode(&payload)
		if _, err := db.Exec(`INSERT INTO r20mp_deliveries (period) VALUES ($1)`, payload.Period); err != nil {
			t.Errorf("账本写入失败: %v", err)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer hook.Close()

	// —— 用量数据：让"生成月报"真的花时间（δ 必须能落进两个进程的快照→落账窗口里）。
	userID, err := serverstore.CreateUser(db, &serverstore.User{Username: "r20mp", Source: "local", Status: 1})
	if err != nil {
		t.Fatalf("建用户: %v", err)
	}
	periodStart := bjAt(2026, 8, 1, 0)
	const seedRows = 4000
	if _, err := db.Exec(`INSERT INTO usage (user_id, model, prompt_tokens, completion_tokens,
			cache_prompt_tokens, kind, cost, created_at)
		SELECT $1, 'model-' || (g % 37), 100 + (g % 900), 10 + (g % 90), 0, 'chat', 0.01,
		       $2::timestamptz + (g || ' minutes')::interval
		  FROM generate_series(1, $3) AS g`, userID, periodStart, seedRows); err != nil {
		t.Fatalf("种用量: %v", err)
	}

	// —— 订阅：同一期、同一个接收器。
	const subs = 3
	for i := 0; i < subs; i++ {
		if _, err := serverstore.CreateReportSubscription(db, fmt.Sprintf("r20mp-%d", i), hook.URL, true); err != nil {
			t.Fatalf("建订阅 %d: %v", i, err)
		}
	}

	// —— 自校准：量一次"生成月报"的耗时 G，δ = G/2。
	period := CurrentPeriod(mpTestMonth())
	genStart := time.Now()
	if _, err := GenerateMonthlyReportForPeriod(db, period); err != nil {
		t.Fatalf("校准生成月报: %v", err)
	}
	gen := time.Since(genStart)
	delta := gen / 2
	if delta < 10*time.Millisecond {
		delta = 10 * time.Millisecond
	}
	if delta > 800*time.Millisecond {
		delta = 800 * time.Millisecond
	}
	t.Logf("自校准：生成月报 G=%v ⇒ δ=%v（订阅 %d 条，期号 %s，用量 %d 行）", gen, delta, subs, period, seedRows)

	// —— 拉起两个真进程（同一测试二进制；只跑 worker 用例）。
	startAt := time.Now().Add(700 * time.Millisecond)
	type child struct {
		role string
		cmd  *exec.Cmd
		out  *strings.Builder
	}
	dsn := testDSNFor(t, db)
	children := make([]*child, 0, 2)
	for i, role := range []string{"A", "B"} {
		c := &child{role: role, out: &strings.Builder{}}
		c.cmd = exec.Command(os.Args[0], "-test.run=^TestMonthlyDispatchWorkerProcess$", "-test.v", "-test.count=1")
		at := startAt.Add(time.Duration(i) * delta)
		c.cmd.Env = append(os.Environ(),
			mpRoleEnv+"="+role,
			mpDSNEnv+"="+dsn,
			mpHookEnv+"="+hook.URL,
			mpMonthEnv+"="+mpTestMonth().Format(time.RFC3339),
			mpStartEnv+"="+strconv.FormatInt(at.UnixMilli(), 10),
		)
		c.cmd.Stdout = c.out
		c.cmd.Stderr = c.out
		if err := c.cmd.Start(); err != nil {
			t.Fatalf("拉起 worker %s: %v", role, err)
		}
		children = append(children, c)
	}
	results := map[string]int{}
	snapshots := map[string]int{}
	for _, c := range children {
		waitErr := c.cmd.Wait()
		out := c.out.String()
		m := mpResultPattern.FindStringSubmatch(out)
		if m == nil {
			t.Fatalf("worker %s 没有给出结果行（exit=%v）：\n%s", c.role, waitErr, out)
		}
		ok, _ := strconv.Atoi(m[2])
		failed, _ := strconv.Atoi(m[3])
		dueBefore, _ := strconv.Atoi(m[4])
		if waitErr != nil {
			t.Fatalf("worker %s 退出码非 0（%v），ok=%d failed=%d：\n%s", c.role, waitErr, ok, failed, out)
		}
		if failed != 0 {
			t.Fatalf("worker %s 有 %d 个订阅投递失败（判据前提不成立）：\n%s", c.role, failed, out)
		}
		results[c.role] = ok
		snapshots[c.role] = dueBefore
		t.Logf("worker %s: ok=%d failed=%d；调用前快照认为欠投 %d 条", c.role, ok, failed, dueBefore)
	}

	// —— 判据①：投递次数守恒（每个订阅恰好一笔）。
	var ledger int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM r20mp_deliveries`).Scan(&ledger); err != nil {
		t.Fatalf("读账本: %v", err)
	}
	var badPeriods int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM (
			SELECT period FROM r20mp_deliveries GROUP BY period HAVING count(*) <> $1) x`, subs).Scan(&badPeriods); err != nil {
		t.Fatalf("读账本分组: %v", err)
	}
	sum := results["A"] + results["B"]
	t.Logf("跨进程账本：%d 笔（A=%d + B=%d = %d，订阅 %d 条）", ledger, results["A"], results["B"], sum, subs)

	// 判据②（teeth）：两个进程在**调用前**都拿到"全部欠投"的旧视图 —— 修前的实现
	// 正是靠这份旧视图各自生成、各自认领 ⇒ 两边都会投。若这里不成立（δ 偏大 /
	// 第一个进程已经落账），本用例对"跨实例重复投递"就没有牙齿，必须红。
	if snapshots["A"] != subs || snapshots["B"] != subs {
		t.Fatalf("判据前提不成立：调用前快照认为欠投的条数 A=%d B=%d, want 各 %d —— "+
			"两个副本没有形成「各自拿着旧快照」的形态，本用例测不到跨实例重复投递",
			snapshots["A"], snapshots["B"], subs)
	}
	if sum != subs {
		t.Fatalf("投递次数不守恒：两个进程的 ok 之和 = %d, want %d（A=%d B=%d）—— "+
			"同一期被两个实例各投了一遍（判定/生成/认领不在同一临界区，"+
			"锁只罩住投递那一瞬）", sum, subs, results["A"], results["B"])
	}
	// 判据③：账本（接收器真实收到）与投递计数一致，且每个期号恰好 subs 笔。
	if ledger != sum {
		t.Fatalf("量具不自洽：接收器账本 %d 笔 ≠ 投递计数之和 %d（A=%d B=%d）",
			ledger, sum, results["A"], results["B"])
	}
	if ledger != subs || badPeriods != 0 {
		t.Fatalf("跨实例重复投递：账本 %d 笔 / 订阅 %d 条 / 期号分组异常 %d 组 —— "+
			"同一期月报被投了多次", ledger, subs, badPeriods)
	}
}

// TestMonthlyDispatchWorkerProcess 是 worker：睡到约定时刻，调用**生产入口**
// `DispatchAll` 一次，把 ok/failed 打到 stdout（驱动据此判定）。
//
// 它不是判据本身（`go test` 直接跑会 Skip）：`DispatchAll` 的投递路径零注入 ——
// worker 里除了"什么时候调用"之外没有任何测试专用分支。
func TestMonthlyDispatchWorkerProcess(t *testing.T) {
	role := os.Getenv(mpRoleEnv)
	if role == "" {
		t.Skip("非 worker 调用（驱动用例会带 " + mpRoleEnv + " 重新执行本二进制）")
	}
	dsn := os.Getenv(mpDSNEnv)
	if dsn == "" {
		t.Fatalf("缺少 %s", mpDSNEnv)
	}
	// 必须走**生产连接工厂** `serverstore.Open`：`?` → `$N` 的占位符重写层在那里，
	// 裸 `sql.Open("pgx", dsn)` 会让每条带 `?` 的语句变成 42601 假失败
	// （`dbtest.go` 的 OpenShadowSearchPathPool 记过同一条坑；本用例实测踩过一次）。
	db, err := serverstore.Open(serverstore.DBConfig{Driver: serverstore.DriverPG, DSN: dsn})
	if err != nil {
		t.Fatalf("worker 连库: %v", err)
	}
	defer db.Close()
	ctx := context.Background()
	if err := db.PingContext(ctx); err != nil {
		t.Fatalf("worker ping: %v", err)
	}
	// 接收器在 127.0.0.1 上（httptest）⇒ 复核 SSRF 闸门必须放行回环，
	// 与生产语义无关（生产里 allowPrivateHookHosts 恒 false）。
	allowLocalWebhooks(t)

	month, perr := time.Parse(time.RFC3339, os.Getenv(mpMonthEnv))
	if perr != nil {
		t.Fatalf("解析 %s: %v", mpMonthEnv, perr)
	}
	startMS, perr := strconv.ParseInt(os.Getenv(mpStartEnv), 10, 64)
	if perr != nil {
		t.Fatalf("解析 %s: %v", mpStartEnv, perr)
	}
	if wait := time.Until(time.UnixMilli(startMS)); wait > 0 {
		time.Sleep(wait)
	}
	// 调用**前**的快照（与 DispatchAll 的粗筛同一个策略实现）：它是本判据的 teeth ——
	// 两边都拿着"还欠投"的旧视图时，修前的代码必然两边都推。
	pre, lerr := serverstore.ListReportSubscriptions(db)
	if lerr != nil {
		t.Fatalf("读调用前快照: %v", lerr)
	}
	dueBefore := 0
	for _, sub := range pre {
		if _, due := SubscriptionDuePeriod(month, sub); due {
			dueBefore++
		}
	}
	ok, failed, derr := DispatchAll(ctx, db, month)
	if derr != nil {
		t.Fatalf("worker %s DispatchAll: %v", role, derr)
	}
	fmt.Printf("%srole=%s ok=%d failed=%d due_before=%d\n", mpResultPrefix, role, ok, failed, dueBefore)
}

// testDSNFor 从连接本身取"具体库名"，拼出指向同一个库的 DSN。
//
// 为什么要绕这一下：`serverstore.NewTestDB` 每个用例建一个**独立**临时库，
// 而"跨实例"判据要求两个 worker 落在**同一个**库上（各建一个库就什么都测不到）。
// 库名问 `current_database()`、其余参数沿用 `PgTestDSN()`（宿主/账号/密码的唯一真源）。
func testDSNFor(t *testing.T, db *sql.DB) string {
	t.Helper()
	var name string
	if err := db.QueryRow(`SELECT current_database()`).Scan(&name); err != nil {
		t.Fatalf("取当前库名: %v", err)
	}
	u, err := url.Parse(serverstore.PgTestDSN())
	if err != nil {
		t.Fatalf("解析测试 DSN: %v", err)
	}
	u.Path = "/" + name
	return u.String()
}
