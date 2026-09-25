package serverstore

// R14-K · D-01（P0）：**"持有一条连接、再向池里要第二条"（hold-and-wait）必须为零**。
//
// 被审形态（第十三轮"读面收口"引入的回归，lane D 探针真 PG 复现）：
//
//	updateUsageTokensAtCached:
//	  tx, _ := db.Begin()                    // ← 取走池里的连接 A
//	  …
//	  pi := loadModelPriceInputs(db, …)      // → newUsageReadConn → db.BeginTx(…)
//	                                         //   ← 持有 A 的同时向池里要连接 B
//
// 为什么它是 P0（而不是"偶发饥饿"）：
//   - **无条件**：池上入口 `loadModelPriceInputs` 先 `newUsageReadConn`（无条件
//     BEGIN），**后**才查 TTL 缓存 ⇒ 即使价目/缓存价/峰谷窗口全部命中缓存（稳态），
//     每次流式回填仍恒定多占一条连接；
//   - **不可恢复**：`BeginTx(context.Background(), nil)` 没有 deadline、
//     `SetConnMaxLifetime` 对**在用**连接无效 ⇒ 池上限 = 并发数时所有连接都被
//     "持一条、等一条"的 goroutine 握死，登录/健康/管理面随后一起阻塞；
//   - 触发面是每次流式请求的结算回填（`UpdateUsageTokensCachedEstimatedOverdraft`
//     还带 3 次重试）。db.go:158 记录过同形态的真实事故（池 200 时流式回填风暴
//     → 1490 goroutine 卡 waitForConn）。
//
// 判据（本文件）：把池上限压到**与并发数相等**，并发跑同一条生产入口 ——
//   - 旧实现：所有 goroutine 永久阻塞（不是报错、不是超时）；
//   - 修好后：全部完成，且**金额是真实价目算出来的**（证明缓存是冷的、价目真的
//     是在那条已持有的连接上读到的，而不是"取不到价 ⇒ 记 0 元"蒙混过关）。
//
// 预算：修复后实测 10~40ms（lane D 探针 17ms / 变异 21ms）；判据给 30s ⇒ ~1000×
// 余量，不构成对机器负载敏感的 flake。失败路径（变异体）是**永久挂起**，与"慢"在
// 数量级上不可混淆。
//
// 同族第二处、第三处（R14-K 独立复扫发现，lane D 的两次扫描漏掉）：
//   - `DeleteDepartment`：保留名判定原先在已开事务里调池上入口 `GroupByID(db,…)`；
//   - `llmgateway.setGatewayConfig`：事务内读设置旧值原先走池上入口 `GetSetting(db,…)`
//     （判据在 llmgateway 包：`audit_r14k_poolwait_test.go`）。

import (
	"database/sql"
	"errors"
	"fmt"
	"testing"
	"time"
)

// r14kPoolWaitBudget 是并发判据的等待上界。取值理由见文件头：修复后 ~10–40ms，
// 这里给 ~1000× 余量；变异体是永久挂起（不是慢），所以这个上界不会误判。
const r14kPoolWaitBudget = 30 * time.Second

// r14kWaitAll 并发跑 n 次 run，**全部完成**才算通过；到点未完成即返回错误
// （不是 panic、不是无限等）—— 这样调用方能把"自锁"与"任务自身报错"分开判。
//
// 池上发生 hold-and-wait 时每个 goroutine 都会停在 `database/sql` 的
// `db.conn()` 上，简单的 `wg.Wait()` 会把一次用例级失败变成整包超时（
// 900s 后才由 go test 兜底报"包级 FAIL、零用例级明细"——本项目登记过的
// 伪装成回归的形态）。
func r14kWaitAll(n int, budget time.Duration, run func(i int) error) (time.Duration, error) {
	done := make(chan error, n)
	start := time.Now()
	for i := 0; i < n; i++ {
		go func(i int) { done <- run(i) }(i)
	}
	for got := 0; got < n; got++ {
		select {
		case err := <-done:
			if err != nil {
				return time.Since(start), err
			}
		case <-time.After(budget):
			return time.Since(start), fmt.Errorf(
				"池上限 = 并发数(%d) 时出现永久阻塞：%d/%d 个任务在 %s 内未完成 —— "+
					"这是「持有一条连接、再向池里要第二条」的自锁（池不可恢复）",
				n, got, n, budget)
		}
	}
	return time.Since(start), nil
}

// r14kConcurrent 是 r14kWaitAll 的用例形态（判定失败即 Fatal）。
func r14kConcurrent(t *testing.T, n int, run func(i int) error) time.Duration {
	t.Helper()
	elapsed, err := r14kWaitAll(n, r14kPoolWaitBudget, run)
	if err != nil {
		t.Fatalf("%v", err)
	}
	return elapsed
}

// r14kSeedBackfillRows 播"生产形态"的 pending usage 行：**带 provider 维度**的
// 零 token 行（llmgateway 在调用上游成功后 SetUsageProvider，回填时才读得到
// provider_id > 0；providerID=0 的历史行会绕开 provider 维度缓存，不忠实）。
func r14kSeedBackfillRows(t *testing.T, db *sql.DB, rows int) (providerID int64, ids []int64) {
	t.Helper()
	uid := mustUserID(t, db)
	name := fmt.Sprintf("r14k-priced-%d", time.Now().UnixNano())
	var provID int64
	if err := db.QueryRow(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models)
		VALUES ($1, 'https://upstream.example.com', 'x', '[]') RETURNING id`, "r14k-prov-"+name).Scan(&provID); err != nil {
		t.Fatalf("造 provider: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec(`DELETE FROM gateway_providers WHERE id = $1`, provID) })
	// 输入价 1.0/1M token、输出价 2.0/1M、缓存价 0.5/1M、低谷折扣 1.0（不折扣），
	// 这样金额只由"价目是否真的读到"决定。
	if _, err := db.Exec(`INSERT INTO models (name, provider_id, display_name, default_params,
		input_price_per_1m, output_price_per_1m, cache_input_price_per_1m, offpeak_discount)
		VALUES ($1,$2,$1,'{}',1.0,2.0,0.5,1.0)`, name, provID); err != nil {
		t.Fatalf("播 models: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec(`DELETE FROM models WHERE name = $1`, name) })
	// 开通余额账户：否则结算走"未开通 = 不扣不记"的分支，金额面验不到。
	if _, err := AdjustUserBalance(db, uid, 100, "R14-K 池自锁判据开通余额", "test"); err != nil {
		t.Fatalf("开通余额: %v", err)
	}
	for i := 0; i < rows; i++ {
		id, err := RecordUsageKindCachedEstimatedForProvider(db, uid, provID, name, 0, 0, 0, "chat", true)
		if err != nil {
			t.Fatalf("播 pending usage: %v", err)
		}
		ids = append(ids, id)
	}
	// 关键：把上面播种路径写进 TTL 缓存的三处计价输入**全部失效** —— 判据要验的是
	// "缓存未命中时也不多占连接"（lane D 的探针预热缓存，只能证明缓存命中那一半；
	// 冷缓存才是这条 P0 的真正形态：无条件 BEGIN 在前、查缓存在后）。
	InvalidateModelConfig()
	InvalidateSettings()
	return provID, ids
}

// TestAuditR14KStreamBackfillNeedsNoSecondPoolConn 是 D-01 的判据（真 PG）。
//
// 池上限 = 并发数 = 2；冷缓存；并发跑流式结算回填的唯一生产出口。
func TestAuditR14KStreamBackfillNeedsNoSecondPoolConn(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)
	_, ids := r14kSeedBackfillRows(t, db, 2)

	db.SetMaxOpenConns(len(ids))
	db.SetMaxIdleConns(len(ids))

	// 1e6 prompt token × 1.0/1M = 1.0；若取价失败（= 零值输入）则是 0.0。
	const promptTokens = 1_000_000
	elapsed := r14kConcurrent(t, len(ids), func(i int) error {
		return UpdateUsageTokensCachedEstimatedOverdraft(db, ids[i], promptTokens, 0, 0, false)
	})
	t.Logf("池上限 %d / 并发 %d：全部完成，elapsed=%s", len(ids), len(ids), elapsed.Round(time.Millisecond))

	for _, id := range ids {
		var cost float64
		var pt, ct int64
		if err := db.QueryRow(`SELECT cost, prompt_tokens, completion_tokens FROM usage WHERE id = ?`, id).
			Scan(&cost, &pt, &ct); err != nil {
			t.Fatal(err)
		}
		if pt != promptTokens {
			t.Errorf("usage %d prompt_tokens=%d，want %d —— 回填没有真的完成", id, pt, promptTokens)
		}
		if cost < 0.999 || cost > 1.001 {
			t.Errorf("usage %d cost=%.6f，want 1.0 —— 取价必须真的读到 public 价目"+
				"（0 = 取价失败回落零值输入，说明连接没拿到）", id, cost)
		}
	}
	// 连接需求的自证：修复后每个 goroutine 全程只用**一条**连接（那条已钉事务），
	// 池上限 = 并发数时不会出现"等连接"。这里只记录不硬断言（后台活动可能引入无关
	// 等待），真正的判据是上面的"全部完成"。
	st := db.Stats()
	t.Logf("db.Stats: maxOpen=%d inUse=%d waitCount=%d waitDuration=%s",
		st.MaxOpenConnections, st.InUse, st.WaitCount, st.WaitDuration)
}

// TestAuditR14KDepartmentDeleteNeedsNoSecondPoolConn 是同族第二处的判据：
// `DeleteDepartment` 的保留名判定（groups 表）原先在**已开事务**里走池上入口
// `GroupByID(db,…)` ⇒ 同一个 hold-and-wait（且它是**无条件**的：每次删除都要第二条
// 连接，没有缓存可命中）。
func TestAuditR14KDepartmentDeleteNeedsNoSecondPoolConn(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)

	ids := make([]int64, 0, 2)
	for i := 0; i < 2; i++ {
		id, err := CreateDepartment(db, fmt.Sprintf("r14k-dept-%d-%d", time.Now().UnixNano(), i), 0, 0, "")
		if err != nil {
			t.Fatalf("造部门: %v", err)
		}
		ids = append(ids, id)
	}
	db.SetMaxOpenConns(len(ids))
	db.SetMaxIdleConns(len(ids))

	elapsed := r14kConcurrent(t, len(ids), func(i int) error {
		return DeleteDepartment(db, ids[i])
	})
	t.Logf("池上限 %d / 并发 %d：部门删除全部完成，elapsed=%s", len(ids), len(ids), elapsed.Round(time.Millisecond))

	var left int64
	for _, id := range ids {
		var n int64
		if err := db.QueryRow(`SELECT COUNT(*) FROM groups WHERE id = ?`, id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		left += n
	}
	if left != 0 {
		t.Errorf("仍有 %d 个部门未删除 —— 判定与删除必须真的落在同一个对象上", left)
	}
}

// TestAuditR14KPoolWaitJudgeItselfIsAbleToFail 是上面这套判据的**自检**（防假绿）。
//
// 为什么必须有：这套判据的核心是"到点未完成 ⇒ 失败"。若这段逻辑被改坏（删掉
// timeout 分支、给 done 换成无缓冲、或在到点时静默返回 nil），**真 PG 的两条判据
// 在变异体上照样变绿** —— 那是本项目登记过的"判据感知度不足"。这里用**确定性**
// 的两个假任务（一个立即完成、一个永久阻塞）验证"通"与"红"两侧都真的生效，
// 不碰真 PG、成本 <1s。
func TestAuditR14KPoolWaitJudgeItselfIsAbleToFail(t *testing.T) {
	// ① 全部完成 ⇒ nil（判据不能在正常路径上误报）。
	elapsed, err := r14kWaitAll(2, 5*time.Second, func(i int) error { return nil })
	if err != nil {
		t.Fatalf("正常路径被误判为失败: %v", err)
	}
	if elapsed > time.Second {
		t.Fatalf("正常路径耗时异常: %s", elapsed)
	}
	// ② 任务自身报错 ⇒ 原样透出（不能被当成"自锁"，也不能被吞掉）。
	sentinel := errors.New("r14k sentinel")
	if _, err := r14kWaitAll(1, 5*time.Second, func(i int) error { return sentinel }); !errors.Is(err, sentinel) {
		t.Fatalf("任务错误未被透出: %v", err)
	}
	// ③ 有一个任务永久阻塞 ⇒ 必须在预算内判红（"自锁"两侧都咬得到）。
	//
	// 这里**不能**直接 `_, err := r14kWaitAll(…)`：若判据的"到点"分支被改坏（正是变异③
	// 要模拟的形态），直接调用会把"判据失效"表现成**整包挂起**（900s 后由 go test 兜底
	// 报"包级 FAIL、零用例级明细"——本项目登记过的、伪装成回归的形态）。所以自检自己
	// 也带看门狗：判据不返回 ⇒ 本用例在 10s 内红，并说清是哪一半坏了。
	blocked := make(chan struct{})
	defer close(blocked)
	verdict := make(chan error, 1)
	start := time.Now()
	go func() {
		_, werr := r14kWaitAll(1, 300*time.Millisecond, func(i int) error { <-blocked; return nil })
		verdict <- werr
	}()
	select {
	case werr := <-verdict:
		if werr == nil {
			t.Fatal("确定性自锁没有被判红 —— 判据本身失效（假绿）")
		}
		if d := time.Since(start); d > 5*time.Second {
			t.Fatalf("判红耗时 %s，远超预算（预算没有真的生效）", d)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("r14kWaitAll 在确定性自锁下没有返回 —— 判据的「到点即失败」分支失效：" +
			"变异体不再表现为「红」，而是表现为整包挂起（包级 FAIL、零用例级明细）")
	}
}
