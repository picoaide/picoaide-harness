package serverstore

// 保留清理轮**不得**删掉"当月写不进去"这条观测的回归判据。
//
// `/readyz` 的 `usage_retention.write_blocked*` 是"当月每一次计量写入都在失败"
// （用户面 = 该月每一次对话 503 METERING_FAILED）唯一的健康面（R9-D R9D-00）。
// 而 `clearResolvedUsageWriteState` 按"本轮 catalog 枚举到的月关系是否还在"收敛
// 这张表 —— 当月键恰好可以**不在**那份枚举里：
//
//	· kind=overlap（partitions.go 的 overlappingPartitionErr）：`usage_<当月>` 这个
//	  关系**不存在**（同名关系不存在才走到 CREATE，然后吃 42P17 边界重叠）；
//	· kind=default-partition-holds-window：DEFAULT 分区持有当月行。
//
// 于是"当月全站不可用"被这一轮清掉、所有健康面报绿；只要那个形态还在就**不可自愈**
// （每次写入都失败、每轮清理都把观测删掉）。当月条目在一张表里与别的月共存
// （`evictOldestWriteState` 的 `k == current` 分支、`usageWriteBlockForReadyz` 按当月键
// 读同一张表都证明这一点），所以"关系不在就删"必须给当月开豁免。
//
// 判据（都走生产入口，断言取值/后果而不是源码字符串）：
//
//	T1 有证据轮（`ExistingMonths` 非空且不含当月）⇒ 当月条目仍在（`write_blocked`
//	   仍为 true、month 仍是当月、累计次数不回退）；同一轮里"关系已不在"的
//	   非当月条目仍必须被收敛（R11A-04 的棘轮修复不得回归）。
//	T2 `ExistingMonths` 为空的分支（旧实现走 clearAllUsageWriteState）同样保住当月。
//	T3 真 PG 端到端：造一个与当月窗口**部分重叠**的异名分区 ⇒ 生产写路径失败并把
//	   当月记进写入面 ⇒ 跑一次真实的 CleanupUsageRetention ⇒ 读数仍为 true 且仍
//	   点名当月；再写一笔仍然失败（健康面与事实一致）。两个子例分别覆盖
//	   `ExistingMonths` 非空/为空两条分支。
//
// 复跑（真 PG）：
//
//	PG_DSN_TEST=postgres://postgres:postgres@127.0.0.1:5432/<db> \
//	  go test ./internal/serverstore/ -run 'TestUsageWriteState' -count=1 -v

import (
	"database/sql"
	"errors"
	"testing"
	"time"
)

// auditWriteStateFixtureOverlapErr 造一个**生产形态**的 overlap 失败：窗口是当月，
// 占名/重叠的是既有分区 —— 与写路径 ensureUsagePartition 报错同一构造点。
func auditWriteStateFixtureOverlapErr(month time.Time) error {
	return overlappingPartitionErr(usageMonthPartitionSpec(month), "usage_overlap_probe",
		errors.New(`ERROR: partition "usage_202601" would overlap partition "usage_overlap_probe" (SQLSTATE 42P17)`))
}

// auditWriteStateOtherMonth 在"其它月份"读数里找某个月。
func auditWriteStateOtherMonth(list []UsageWriteBlockOtherMonth, month string) *UsageWriteBlockOtherMonth {
	for i := range list {
		if list[i].Month == month {
			return &list[i]
		}
	}
	return nil
}

// TestUsageWriteStateCurrentMonthSurvivesRetentionRound 是 T1：一轮**有证据**的
// 清理（catalog 枚举到的关系里没有当月）不得把当月条目清掉。
func TestUsageWriteStateCurrentMonthSurvivesRetentionRound(t *testing.T) {
	resetUsageRetentionStatusForTest()
	now := time.Now()
	cur := monthKey(BeijingMonth(now))

	// 生产写路径的记账点：当月写入被"部分重叠的既有分区"挡住。
	noteUsagePartitionWriteFailure(now, auditWriteStateFixtureOverlapErr(now))
	// 对照组 A：关系仍在的到期月 —— 那正是"现在还有个月写不进去"的真实读数，必须留。
	storeUsageWriteError(&usageWriteBlockVal, "200001", usagePartitionKindOrphanNameCollision, "孤儿撞名")
	// 对照组 B：关系已不在的到期月 —— 棘轮修复要收敛的对象，必须删。
	storeUsageWriteError(&usageWriteBlockVal, "200002", usagePartitionKindOverlap, "关系已被回收")

	before := CurrentUsageRetentionStatus()
	if !before.WriteBlocked || before.WriteBlockedMonth != cur {
		t.Fatalf("夹具失效：当月 %s 未进写入面（write_blocked=%v month=%q）",
			cur, before.WriteBlocked, before.WriteBlockedMonth)
	}
	if before.WriteBlockedKind != usagePartitionKindOverlap {
		t.Fatalf("夹具失效：当月条目的 kind = %q，want %q", before.WriteBlockedKind, usagePartitionKindOverlap)
	}
	// 同一个函数也被 write_error 面调用（清理轮的调用点对两个槽位各来一次）：
	// 当月的一次**瞬时**写失败（未分类 kind=other）同样必须活过这一轮。
	noteUsagePartitionWriteFailure(now, errors.New("connection reset by peer"))
	if we := CurrentUsageRetentionStatus(); !we.WriteError || we.WriteErrorMonth != cur {
		t.Fatalf("夹具失效：当月的瞬时写失败未进 write_error 面（%v/%q）", we.WriteError, we.WriteErrorMonth)
	}

	recordUsageRetentionRound(usageRetentionRound{
		EndedAt:               now,
		ConfiguredMonths:      6,
		ConfiguredMonthsKnown: true,
		CutoffMonth:           monthKey(BeijingMonth(now).AddDate(0, -6, 0)),
		Scanned:               true,
		ExistingMonths:        []string{"200001"}, // 关系仍在的只有对照组 A；当月不在其中
	}, nil)

	after := CurrentUsageRetentionStatus()
	t.Logf("轮前 write_blocked=%v/%q count=%d；轮后 write_blocked=%v/%q count=%d other=%+v total=%d",
		before.WriteBlocked, before.WriteBlockedMonth, before.WriteBlockedCount,
		after.WriteBlocked, after.WriteBlockedMonth, after.WriteBlockedCount,
		after.WriteBlockedOtherMonths, after.WriteBlockedOtherCount)

	if !after.WriteBlocked || after.WriteBlockedMonth != cur {
		t.Errorf("清理轮把**当月**的写入阻塞观测清掉了：轮前 %v/%q，轮后 %v/%q。"+
			"当月的每一次计量写入仍然失败（每一次对话 503 METERING_FAILED），"+
			"而 /readyz 的 usage_retention.write_blocked 已经翻回 false",
			before.WriteBlocked, before.WriteBlockedMonth, after.WriteBlocked, after.WriteBlockedMonth)
	}
	if after.WriteBlockedKind != usagePartitionKindOverlap {
		t.Errorf("当月条目必须仍是同一条观测（kind 不得被改写/丢失）：got %q want %q",
			after.WriteBlockedKind, usagePartitionKindOverlap)
	}
	if after.WriteBlockedCount < before.WriteBlockedCount {
		t.Errorf("当月条目的累计次数不得因清理轮回退：%d → %d", before.WriteBlockedCount, after.WriteBlockedCount)
	}
	// 同一个判据也罩 write_error 面（同一个清理函数被两个槽位各调一次）。
	if !after.WriteError || after.WriteErrorMonth != cur {
		t.Errorf("当月**瞬时**写失败（write_error 面）同样不得被清理轮清掉：write_error=%v month=%q（want true/%q）",
			after.WriteError, after.WriteErrorMonth, cur)
	}

	// 棘轮修复（本函数存在的理由）不得回归：关系已不在的非当月条目必须被收敛。
	if got := auditWriteStateOtherMonth(after.WriteBlockedOtherMonths, "200002"); got != nil {
		t.Errorf("关系已不在的到期月条目必须被这一轮收敛掉（R11A-04 的棘轮修复）：%+v", got)
	}
	// 关系仍在的到期月必须保留。
	if got := auditWriteStateOtherMonth(after.WriteBlockedOtherMonths, "200001"); got == nil {
		t.Errorf("关系仍在的到期月条目必须保留（它仍是真实读数）：%+v", after.WriteBlockedOtherMonths)
	}
	if after.WriteBlockedOtherCount != 1 {
		t.Errorf("其它月份读数只应剩关系仍在的那一条：count=%d list=%+v",
			after.WriteBlockedOtherCount, after.WriteBlockedOtherMonths)
	}
}

// TestUsageWriteStateEmptyRetentionRoundKeepsCurrentMonth 是 T2：`len(round.ExistingMonths)==0`
// 的分支（旧实现直接 clearAllUsageWriteState 清空整张表）同样必须保住当月，
// 同时仍然清掉别的月（不是"什么都不删"）。
func TestUsageWriteStateEmptyRetentionRoundKeepsCurrentMonth(t *testing.T) {
	resetUsageRetentionStatusForTest()
	now := time.Now()
	cur := monthKey(BeijingMonth(now))

	noteUsagePartitionWriteFailure(now, auditWriteStateFixtureOverlapErr(now))
	storeUsageWriteError(&usageWriteBlockVal, "200002", usagePartitionKindOverlap, "关系已被回收")

	before := CurrentUsageRetentionStatus()
	if !before.WriteBlocked || before.WriteBlockedMonth != cur {
		t.Fatalf("夹具失效：当月 %s 未进写入面（%v/%q）", cur, before.WriteBlocked, before.WriteBlockedMonth)
	}

	recordUsageRetentionRound(usageRetentionRound{
		EndedAt:               now,
		ConfiguredMonths:      6,
		ConfiguredMonthsKnown: true,
		CutoffMonth:           monthKey(BeijingMonth(now).AddDate(0, -6, 0)),
		Scanned:               true, // ExistingMonths 为空：本轮一条月关系都没枚举到
	}, nil)

	after := CurrentUsageRetentionStatus()
	t.Logf("空枚举轮：write_blocked=%v/%q other=%+v total=%d",
		after.WriteBlocked, after.WriteBlockedMonth, after.WriteBlockedOtherMonths, after.WriteBlockedOtherCount)

	if !after.WriteBlocked || after.WriteBlockedMonth != cur {
		t.Errorf("空枚举的分支把当月的写入阻塞观测一并清掉了：轮前 %v/%q，轮后 %v/%q",
			before.WriteBlocked, before.WriteBlockedMonth, after.WriteBlocked, after.WriteBlockedMonth)
	}
	if got := auditWriteStateOtherMonth(after.WriteBlockedOtherMonths, "200002"); got != nil {
		t.Errorf("空枚举轮仍须收敛非当月条目（不是「什么都不删」）：%+v", got)
	}
}

// TestUsageWriteStateCurrentMonthSurvivesRetentionCleanup 是 T3：真 PG + 真
// `CleanupUsageRetention` 的端到端判据（用户面后果 = 当月全站 503 必须一直可见）。
func TestUsageWriteStateCurrentMonthSurvivesRetentionCleanup(t *testing.T) {
	for _, tc := range []struct {
		name string
		// withOtherMonth 造出"别的月关系仍在场"的形态 ⇒ 清理轮的 ExistingMonths
		// **非空**（主分支）；否则 ExistingMonths 为空（另一条分支）。
		withOtherMonth bool
	}{
		{name: "枚举里有别的月关系", withOtherMonth: true},
		{name: "一条月关系都没枚举到", withOtherMonth: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, cleanup := NewTestDB(t)
			defer cleanup()
			uid := mustUserID(t, db)
			cur := auditWriteStateOverlapFixture(t, db, uid, tc.withOtherMonth)

			before := CurrentUsageRetentionStatus()
			if !before.WriteBlocked || before.WriteBlockedMonth != cur {
				t.Fatalf("夹具失效：当月 %s 未进写入面（%v/%q）", cur, before.WriteBlocked, before.WriteBlockedMonth)
			}

			// 真实清理轮（调度器 / 管理端保存保留期走的就是它）。
			if err := CleanupUsageRetention(db); err != nil {
				t.Logf("CleanupUsageRetention 返回：%v", err)
			}
			after := CurrentUsageRetentionStatus()
			t.Logf("清理轮：rounds %d→%d cutoff=%q failed_rounds %d→%d；write_blocked=%v month=%q other=%+v",
				before.RoundNumber, after.RoundNumber, after.CutoffMonth, before.FailedRounds, after.FailedRounds,
				after.WriteBlocked, after.WriteBlockedMonth, after.WriteBlockedOtherMonths)

			// 自校准：这一轮必须真是**有证据轮**（保留期读到 + catalog 扫描成功），
			// 否则本判据咬不到对象（例如保留期被配成 0 = 永不删除时提前返回）。
			if after.RoundNumber != before.RoundNumber+1 || after.CutoffMonth == "" {
				t.Fatalf("清理轮没有真的跑起来（保留期读到 0 或扫描失败）：rounds %d→%d cutoff=%q",
					before.RoundNumber, after.RoundNumber, after.CutoffMonth)
			}
			if after.FailedRounds != before.FailedRounds {
				t.Fatalf("夹具失效：清理轮出现真失败（failed_relations=%v last_error=%q）",
					after.FailedRelations, after.LastError)
			}
			// 自校准（这条判据咬到的是哪条分支）：两个子例必须分别落在"枚举到 1 条
			// 月关系（不含当月）"与"一条都没枚举到"上 —— 否则两条子例会退化成同
			// 一条分支，"主分支也被覆盖"就成了假绿。
			wantRelations := 0
			if tc.withOtherMonth {
				wantRelations = 1
			}
			if after.Relations != wantRelations {
				t.Fatalf("夹具失效：本轮枚举到的关系数 = %d，want %d（月关系集合与子例不符）",
					after.Relations, wantRelations)
			}

			if !after.WriteBlocked || after.WriteBlockedMonth != cur {
				t.Errorf("一轮保留清理之后「当月写不进去」这条观测消失：write_blocked=%v month=%q（want true/%q）——"+
					"当月每一次计量写入仍然 503 METERING_FAILED，而所有健康面已报绿",
					after.WriteBlocked, after.WriteBlockedMonth, cur)
			}

			// 健康面必须与事实一致：再写一笔仍然失败，且失败仍是同一种布局阻塞。
			if _, err := RecordUsageKind(db, uid, "audit-write-state", 10, 5, "chat"); err == nil {
				t.Fatalf("夹具失效：重叠分区还在，当月写入不该成功")
			} else if kind, _, _ := partitionLayoutFailure(err); kind != usagePartitionKindOverlap {
				t.Fatalf("夹具失效：期望 kind=%s，实得 %q（%v）", usagePartitionKindOverlap, kind, err)
			}
		})
	}
}

// auditWriteStateOverlapFixture 造出"当月每一次计量写入都失败"的布局，并走**生产
// 写路径**把当月记进写入面；返回当月键。
//
// 形态：先摘掉所有 `usage_<YYYYMM>` 月关系（保证当月**同名关系不存在** —— 这是
// kind=overlap 的前提），再建一个**部分落在当月窗口内**的异名分区 ⇒ 写路径的
// `CREATE … PARTITION OF` 必吃 42P17（PG 不允许与既有分区部分重叠的窗口）。
// withOtherMonth 为真时再预建下月分区（月对齐、在保留期内），让清理轮枚举到的
// 关系集合非空且**不含当月**。
func auditWriteStateOverlapFixture(t *testing.T, db *sql.DB, uid int64, withOtherMonth bool) string {
	t.Helper()
	curStart := BeijingMonth(time.Now())
	cur := monthKey(curStart)
	if _, err := db.Exec(`DO $aw$ DECLARE r RECORD; BEGIN
      FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname='public' AND c.relkind='r' AND c.relname ~ '^usage_[0-9]{6}$' LOOP
        EXECUTE format('DROP TABLE IF EXISTS %I', r.relname);
      END LOOP; END $aw$;`); err != nil {
		t.Fatalf("摘掉既有月分区: %v", err)
	}
	if withOtherMonth {
		spec := usageMonthPartitionSpec(curStart.AddDate(0, 1, 0)) // 下月：月对齐、在保留期内
		if _, err := db.Exec("CREATE TABLE " + quoteRelationIdent(spec.relation()) +
			" PARTITION OF usage FOR VALUES FROM ('" + spec.from + "') TO ('" + spec.to + "')"); err != nil {
			t.Fatalf("预建下月分区 %s: %v", spec.relation(), err)
		}
	}
	var reg *string
	if err := db.QueryRow("SELECT to_regclass('public.usage_" + cur + "')::text").Scan(&reg); err != nil {
		t.Fatal(err)
	}
	if reg != nil {
		t.Fatalf("夹具失效：当月关系 usage_%s 仍存在（overlap 形态要求它不存在）", cur)
	}
	ovFrom := pgInstantArg(BeijingDayInstant(curStart.AddDate(0, 0, 4)))
	ovTo := pgInstantArg(BeijingDayInstant(curStart.AddDate(0, 0, 14)))
	if _, err := db.Exec("CREATE TABLE usage_overlap_probe PARTITION OF usage FOR VALUES FROM ('" +
		ovFrom + "') TO ('" + ovTo + "')"); err != nil {
		t.Fatalf("造与当月窗口部分重叠的异名分区: %v", err)
	}
	// 生产写路径：一次真实的计量写入（必须失败在分区布局上）。
	if _, err := RecordUsageKind(db, uid, "audit-write-state", 10, 5, "chat"); err == nil {
		t.Fatalf("夹具失效：当月写入没有失败（重叠布局应让 CREATE 吃 %s）", pgSQLStateOverlapPartition)
	} else if kind, _, _ := partitionLayoutFailure(err); kind != usagePartitionKindOverlap {
		t.Fatalf("夹具失效：期望 kind=%s，实得 %q（%v）", usagePartitionKindOverlap, kind, err)
	}
	return cur
}
