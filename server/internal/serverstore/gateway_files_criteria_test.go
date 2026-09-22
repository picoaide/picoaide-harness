package serverstore

// 网关文件台账（迁移 0077/0078）的**判据补强**（2026-09-22，修复代理 L1 数据层泳道）。
//
// 覆盖面（每条都带"能被打坏"的断言，不是存在性检查）：
//  1. escapeLike：用户输入里的 % _ \ 在 **真实 PG 的 ILIKE** 下必须按字面匹配；
//  2. GatewayFileSummary 三档排序：断言**首行与整体次序**（不是只看行数）；
//  3. ListGatewayFiles 的 sort 白名单：注入串必须无效并回落 created_at；
//  4. 分页：page/size 与 total 的一致性（翻页不重叠、不漏行、页大小有界）；
//  5. ClaimExpiredGatewayFile 的并发正确性（两个真连接 + 真行锁，实测恰好一个成功）；
//  6. Purge 与 Claim 交叉（谁先删都不会误删活行、也不报错）；
//  7. NormalizeLegacyPermanentGatewayFiles 的幂等与边界；
//  8. GatewayFilesOwnedBy 的空/重复/畸形 id 与**参数个数上限**；
//  9. RecordGatewayFileSize 的 size_bytes 合并语义与过期行重占用的字段保真；
// 10. ListGatewayFileIDs 的 LIMIT 截断语义；
// 11. 迁移 0077/0078 的可重入性（原样重放整份 SQL）。

import (
	"database/sql"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// 助手
// ---------------------------------------------------------------------------

// rawGatewayFile 直插一行台账：测试需要精确控制 created_at/expires_at/size_bytes
// （RecordGatewayFileSize 恒把 created_at 写成 now()，表达不了"存量老行"）。
func rawGatewayFile(t *testing.T, db *sql.DB, fileID string, userID int64, createdAt time.Time, expiresAt *time.Time, sizeBytes int64) {
	t.Helper()
	if _, err := db.Exec(`INSERT INTO gateway_files (file_id, user_id, created_at, expires_at, size_bytes)
		VALUES (?, ?, ?, ?, ?)`, fileID, userID, createdAt, expiresAt, sizeBytes); err != nil {
		t.Fatalf("insert %s: %v", fileID, err)
	}
}

func listFileIDs(t *testing.T, db *sql.DB, q GatewayFileQuery) ([]string, int64) {
	t.Helper()
	rows, total, err := ListGatewayFiles(db, q)
	if err != nil {
		t.Fatalf("ListGatewayFiles(%+v): %v", q, err)
	}
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.FileID)
	}
	return out, total
}

func sameOrder(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

// blockedOnGatewayFiles 轮询 pg_stat_activity，确认**确实有会话卡在 gateway_files 的行锁上**
// （用它把"并发"从时序巧合升级为可观测事实）。
func blockedOnGatewayFiles(t *testing.T, db *sql.DB, want int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		var n int
		err := db.QueryRow(`SELECT count(*) FROM pg_stat_activity
		                     WHERE datname = current_database()
		                       AND wait_event_type = 'Lock'
		                       AND query LIKE '%gateway_files%'`).Scan(&n)
		if err != nil {
			t.Fatalf("pg_stat_activity: %v", err)
		}
		if n >= want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("等待行锁的会话数 = %d, want >= %d（claim 没有真的阻塞在行锁上 ⇒ 本判据失效）", n, want)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// ---------------------------------------------------------------------------
// 1. escapeLike：% _ \ 必须按字面匹配（真实 PG ILIKE）
// ---------------------------------------------------------------------------

func TestListGatewayFilesSearchTreatsLikeWildcardsLiterally(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)
	alice := mustUser(t, db, "gw-like-alice")

	base := time.Now().Add(-time.Hour).Truncate(time.Microsecond)
	// 五个字面量互不相同：只有转义正确时才可能各命中各自的那一行。
	fPercent := "file-a%b"
	fUnderscore := "file-a_b"
	fBackslash := `file-a\b`
	fBoth := `file-a\%b` // \ 与 % 相邻：验证"先转义反斜杠再转义通配符"不会互相吃掉
	fPlain := "file-ab"
	all := []string{fPercent, fUnderscore, fBackslash, fBoth, fPlain}
	for i, id := range all {
		rawGatewayFile(t, db, id, alice, base.Add(time.Duration(i)*time.Minute), nil, int64(i))
	}

	cases := []struct {
		q    string
		want []string
		why  string
	}{
		{"a%", []string{fPercent}, "% 必须按字面匹配（不是通配符）"},
		{"a_", []string{fUnderscore}, "_ 必须按字面匹配（不是单字符通配）"},
		{`a\`, []string{fBackslash, fBoth}, `\ 必须按字面匹配（不是转义引子）`},
		{"ab", []string{fPlain}, "无通配符时只命中真正含该子串的行"},
		{`a\%`, []string{fBoth}, `反斜杠 + 通配符的组合必须分别按字面匹配`},
		{`\%`, []string{fBoth}, `\% 是"字面反斜杠紧跟字面百分号"`},
		{"%", []string{fPercent, fBoth}, "单独一个 % 只按字面匹配"},
		{"_", []string{fUnderscore}, "单独一个 _ 只按字面匹配"},
		{`\`, []string{fBackslash, fBoth}, `单独一个 \ 只按字面匹配`},
		// ILIKE：大小写不敏感（M13）—— 若实现被改成 LIKE 这一条必红
		{"FILE-A", all, "必须走 ILIKE（大小写不敏感）"},
		{"A%", []string{fPercent}, "转义不得破坏大小写不敏感语义"},
		{"file-a", all, "前缀命中全部五行"},
	}
	for _, tc := range cases {
		got, total := listFileIDs(t, db, GatewayFileQuery{Search: tc.q, Limit: 50})
		if !sameOrder(got, tc.want) {
			t.Errorf("Search=%q（%s）: 命中 %v, want %v", tc.q, tc.why, got, tc.want)
		}
		if total != int64(len(tc.want)) {
			t.Errorf("Search=%q: total=%d, want %d", tc.q, total, len(tc.want))
		}
	}

	// 空 / 纯空白搜索 = 不过滤（不是"命中 0 行"，也不是别的退化行为）
	for _, q := range []string{"", "   ", "\t"} {
		got, total := listFileIDs(t, db, GatewayFileQuery{Search: q, Limit: 50})
		if !sameOrder(got, all) {
			t.Errorf("Search=%q: 命中 %v, want 全量 %v（空搜索 = 不过滤）", q, got, all)
		}
		if total != int64(len(all)) {
			t.Errorf("Search=%q: total=%d, want %d", q, total, len(all))
		}
	}

	// 大小写不敏感必须**同时**体现在过滤与 total 上（total 走的是另一条 count 查询）
	if _, total := listFileIDs(t, db, GatewayFileQuery{Search: "FILE-A%B", Limit: 50}); total != 1 {
		t.Errorf("Search=FILE-A%%B: total=%d, want 1（count 查询也必须是 ILIKE）", total)
	}
}

// ---------------------------------------------------------------------------
// 2. GatewayFileSummary 三档排序：首行 + 整体次序
// ---------------------------------------------------------------------------

func TestGatewayFileSummarySortModesOrderRows(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)

	// 三档排序给出**三种互不相同**的次序，位置错位必红：
	//   bytes:  bob(3000) > cyra(200) > ada(30)
	//   files:  ada(3) > cyra(2) > bob(1)
	//   username: ada < bob < cyra
	ada := mustUser(t, db, "gw-sum-ada")
	bob := mustUser(t, db, "gw-sum-bob")
	cyra := mustUser(t, db, "gw-sum-cyra")

	now := time.Now().Truncate(time.Microsecond)
	future := now.Add(time.Hour)
	earliest := now.Add(-2 * time.Hour) // ada 的最早过期时刻（已过期也计入 min）
	past := now.Add(-time.Minute)

	rawGatewayFile(t, db, "sum-ada-1", ada, now, &future, 10)
	rawGatewayFile(t, db, "sum-ada-2", ada, now, nil, 10) // 永久行：min() 忽略 NULL
	rawGatewayFile(t, db, "sum-ada-3", ada, now, &earliest, 10)
	rawGatewayFile(t, db, "sum-bob-1", bob, now, nil, 3000)
	rawGatewayFile(t, db, "sum-cyra-1", cyra, now, nil, 100)
	rawGatewayFile(t, db, "sum-cyra-2", cyra, now, &past, 100)

	type want struct {
		sort  string
		desc  bool
		order []int64
	}
	cases := []want{
		{"bytes", true, []int64{bob, cyra, ada}},
		{"bytes", false, []int64{ada, cyra, bob}},
		{"files", true, []int64{ada, cyra, bob}},
		{"files", false, []int64{bob, cyra, ada}},
		{"username", true, []int64{cyra, bob, ada}},
		{"username", false, []int64{ada, bob, cyra}},
		// 非法/未知 sort 必须落回 bytes（不得报错、不得注入）
		{"1;DROP TABLE gateway_files--", true, []int64{bob, cyra, ada}},
		{"user_id", true, []int64{bob, cyra, ada}},
		{"bytes DESC NULLS LAST --", true, []int64{bob, cyra, ada}},
	}
	for _, tc := range cases {
		rows, err := GatewayFileSummary(db, tc.sort, tc.desc)
		if err != nil {
			t.Fatalf("GatewayFileSummary(%q,%v): %v", tc.sort, tc.desc, err)
		}
		got := make([]int64, 0, len(rows))
		for _, r := range rows {
			got = append(got, r.UserID)
		}
		if len(got) != len(tc.order) {
			t.Errorf("sort=%q desc=%v: 行数=%d, want %d（%v）", tc.sort, tc.desc, len(got), len(tc.order), got)
			continue
		}
		if got[0] != tc.order[0] {
			t.Errorf("sort=%q desc=%v: **首行**=%d, want %d（全序 %v）", tc.sort, tc.desc, got[0], tc.order[0], got)
		}
		if !sameInt64Order(got, tc.order) {
			t.Errorf("sort=%q desc=%v: 次序 %v, want %v", tc.sort, tc.desc, got, tc.order)
		}
	}

	// 汇总的数值本身：files / bytes / expired_files / earliest_expires_at
	rows, err := GatewayFileSummary(db, "username", false)
	if err != nil {
		t.Fatal(err)
	}
	byUser := map[int64]GatewayFileSummaryRow{}
	for _, r := range rows {
		byUser[r.UserID] = r
	}
	a := byUser[ada]
	if a.Files != 3 || a.Bytes != 30 || a.Expired != 1 {
		t.Errorf("ada 汇总 = files:%d bytes:%d expired:%d, want 3/30/1", a.Files, a.Bytes, a.Expired)
	}
	if a.Earliest == nil || !a.Earliest.Truncate(time.Microsecond).Equal(earliest) {
		t.Errorf("ada earliest_expires_at = %v, want %v（min 必须忽略 NULL 并且计入已过期行）", a.Earliest, earliest)
	}
	if b := byUser[bob]; b.Files != 1 || b.Bytes != 3000 || b.Expired != 0 || b.Earliest != nil {
		t.Errorf("bob 汇总 = %+v, want files:1 bytes:3000 expired:0 earliest:nil", b)
	}
	if c := byUser[cyra]; c.Files != 2 || c.Bytes != 200 || c.Expired != 1 {
		t.Errorf("cyra 汇总 = %+v, want files:2 bytes:200 expired:1", c)
	}
	if byUser[bob].Username != "gw-sum-bob" || byUser[bob].DisplayName != "" {
		t.Errorf("bob 展示名 = %q/%q", byUser[bob].Username, byUser[bob].DisplayName)
	}
}

func sameInt64Order(got, want []int64) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

// ---------------------------------------------------------------------------
// 3. ListGatewayFiles 的 sort/order 白名单（注入无效 + 白名单兜底）
// ---------------------------------------------------------------------------

func TestListGatewayFilesSortWhitelistBlocksInjection(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)

	alice := mustUser(t, db, "gw-sort-alice")
	base := time.Now().Add(-time.Hour).Truncate(time.Microsecond)
	// created_at 递增 ⇒ created_at DESC 的次序恰好是 a3,a2,a1
	rawGatewayFile(t, db, "sort-a1", alice, base, nil, 300)
	rawGatewayFile(t, db, "sort-a2", alice, base.Add(time.Minute), nil, 100)
	rawGatewayFile(t, db, "sort-a3", alice, base.Add(2*time.Minute), nil, 200)

	// 基线：白名单键 created_at + desc
	baseline, baselineTotal := listFileIDs(t, db, GatewayFileQuery{Sort: "created_at", Desc: true, Limit: 50})
	if !sameOrder(baseline, []string{"sort-a3", "sort-a2", "sort-a1"}) {
		t.Fatalf("created_at DESC 基线 = %v", baseline)
	}

	injections := []string{
		"1;DROP TABLE gateway_files--",
		"created_at; DELETE FROM gateway_files WHERE 1=1--",
		"user_id",
		"g.file_id",
		"file_id",
		"(SELECT 1)",
		"username DESC NULLS LAST --",
		"created_at, size_bytes",
		"1)",
		"",
		"0x41",
	}
	for _, bad := range injections {
		got, total := listFileIDs(t, db, GatewayFileQuery{Sort: bad, Desc: true, Limit: 50})
		if !sameOrder(got, baseline) {
			t.Errorf("sort=%q 未被白名单兜底: 次序 %v, want %v", bad, got, baseline)
		}
		if total != baselineTotal {
			t.Errorf("sort=%q: total=%d, want %d", bad, total, baselineTotal)
		}
	}

	// 表还在（注入串没有被拼进 SQL 执行）
	var exists bool
	if err := db.QueryRow(`SELECT to_regclass('public.gateway_files') IS NOT NULL`).Scan(&exists); err != nil || !exists {
		t.Fatalf("gateway_files 表在注入尝试后不存在: exists=%v err=%v", exists, err)
	}

	// 白名单键确实各自生效（不是"全部回落 created_at"的假绿）
	sizeDesc, _ := listFileIDs(t, db, GatewayFileQuery{Sort: "size_bytes", Desc: true, Limit: 50})
	if !sameOrder(sizeDesc, []string{"sort-a1", "sort-a3", "sort-a2"}) {
		t.Errorf("size_bytes DESC = %v, want [sort-a1 sort-a3 sort-a2]", sizeDesc)
	}
	byName, _ := listFileIDs(t, db, GatewayFileQuery{Sort: "username", Desc: false, Limit: 50})
	if len(byName) != 3 {
		t.Errorf("username 排序行数 = %v", byName)
	}
	expiresDesc, _ := listFileIDs(t, db, GatewayFileQuery{Sort: "expires_at", Desc: true, Limit: 50})
	if len(expiresDesc) != 3 {
		t.Errorf("expires_at 排序行数 = %v", expiresDesc)
	}

	// 同 created_at 时按 file_id 升序兜底（翻页不重叠的前提）
	rawGatewayFile(t, db, "sort-b0", alice, base, nil, 1)
	rawGatewayFile(t, db, "sort-b1", alice, base, nil, 1)
	tie, _ := listFileIDs(t, db, GatewayFileQuery{Sort: "created_at", Desc: true, Limit: 50})
	if !sameOrder(tie, []string{"sort-a3", "sort-a2", "sort-a1", "sort-b0", "sort-b1"}) {
		t.Errorf("同 created_at 的次序不稳定: %v", tie)
	}
}

// ---------------------------------------------------------------------------
// 4. 分页：页大小有界 + 翻页不重叠不漏行 + total 一致
// ---------------------------------------------------------------------------

func TestListGatewayFilesPaginationIsConsistent(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)

	alice := mustUser(t, db, "gw-page-alice")
	bob := mustUser(t, db, "gw-page-bob")
	base := time.Now().Add(-24 * time.Hour).Truncate(time.Microsecond)
	// 7 行 alice（其中 1 行已过期）+ 3 行 bob；过滤 alice&active ⇒ 6 行
	for i := 0; i < 7; i++ {
		created := base.Add(time.Duration(i) * time.Minute)
		var expires *time.Time
		if i == 0 {
			e := base.Add(-time.Minute)
			expires = &e
		}
		rawGatewayFile(t, db, fmt.Sprintf("page-a%d", i), alice, created, expires, int64(i))
	}
	for i := 0; i < 3; i++ {
		rawGatewayFile(t, db, fmt.Sprintf("page-b%d", i), bob, base.Add(time.Duration(i)*time.Minute), nil, int64(i))
	}

	q := GatewayFileQuery{UserID: alice, OnlyActive: true, Sort: "created_at", Desc: false}
	seen := map[string]int{}
	pageSize := 2
	for page := 0; ; page++ {
		rows, total, err := ListGatewayFiles(db, GatewayFileQuery{
			UserID: q.UserID, OnlyActive: true, Sort: "created_at", Desc: false,
			Limit: pageSize, Offset: page * pageSize,
		})
		if err != nil {
			t.Fatal(err)
		}
		if total != 6 {
			t.Fatalf("第 %d 页 total = %d, want 6（过滤条件改变后 total 必须同步）", page, total)
		}
		if len(rows) == 0 {
			break
		}
		if page > 10 {
			t.Fatal("翻页没有收敛")
		}
		for _, r := range rows {
			seen[r.FileID]++
		}
	}
	if len(seen) != 6 {
		t.Fatalf("翻页共覆盖 %d 行, want 6（漏行或重复）: %v", len(seen), seen)
	}
	for id, n := range seen {
		if n != 1 {
			t.Errorf("%s 在翻页中出现 %d 次（重叠）", id, n)
		}
	}

	// 页大小上界：Limit=200 必须真的生效（不是被夹回缺省 50）
	mustBulkFiles(t, db, alice, 250)
	rows, total, err := ListGatewayFiles(db, GatewayFileQuery{UserID: alice, Limit: 200})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 200 {
		t.Errorf("Limit=200 返回 %d 行, want 200（上限必须可用）", len(rows))
	}
	if total != 257 {
		t.Errorf("total = %d, want 257（7 行 alice（含 1 过期）+ 250 批量；此处没有 state 过滤）", total)
	}
	// 越界请求必须被夹住（不得整表读进内存）
	for _, bad := range []int{201, 500, 100000, -1, 0} {
		rows, _, err := ListGatewayFiles(db, GatewayFileQuery{UserID: alice, Limit: bad})
		if err != nil {
			t.Fatalf("Limit=%d: %v", bad, err)
		}
		if len(rows) > 200 {
			t.Errorf("Limit=%d 返回 %d 行（超过分页上限 200）", bad, len(rows))
		}
	}
}

// mustBulkFiles 批量插入 n 行（容量/分页用例要几百行，逐行 insert 太慢）。
func mustBulkFiles(t *testing.T, db *sql.DB, userID int64, n int) {
	t.Helper()
	_, err := db.Exec(`INSERT INTO gateway_files (file_id, user_id, created_at, expires_at, size_bytes)
		SELECT 'bulk-' || lpad(i::text, 6, '0'), ?, now() + (i || ' seconds')::interval, NULL, i
		  FROM generate_series(1, ?) AS i`, userID, n)
	if err != nil {
		t.Fatalf("bulk insert %d: %v", n, err)
	}
}

// ---------------------------------------------------------------------------
// 5. ClaimExpiredGatewayFile：并发正确性（真连接 + 真行锁）
// ---------------------------------------------------------------------------

// 两个真连接同时认领同一过期行 ⇒ 恰好一个成功（每轮都必须成立）。
func TestClaimExpiredGatewayFileConcurrentClaimsExactlyOneWins(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)
	alice := mustUser(t, db, "gw-claim-alice")
	past := time.Now().Add(-time.Minute)

	const rounds = 12
	for i := 0; i < rounds; i++ {
		id := fmt.Sprintf("claim-race-%02d", i)
		if err := RecordGatewayFile(db, id, alice, &past); err != nil {
			t.Fatal(err)
		}
		start := make(chan struct{})
		var wg sync.WaitGroup
		oks := make([]bool, 2)
		errs := make([]error, 2)
		for k := 0; k < 2; k++ {
			wg.Add(1)
			go func(k int) {
				defer wg.Done()
				<-start
				_, ok, err := ClaimExpiredGatewayFile(db, id)
				oks[k], errs[k] = ok, err
			}(k)
		}
		close(start)
		wg.Wait()

		wins := 0
		for k := 0; k < 2; k++ {
			if errs[k] != nil {
				t.Fatalf("第 %d 轮 goroutine %d 报错: %v", i, k, errs[k])
			}
			if oks[k] {
				wins++
			}
		}
		if wins != 1 {
			t.Fatalf("第 %d 轮成功数 = %d, want 1（oks=%v）", i, wins, oks)
		}
		// 认领是"打标记"，**不删行**（R7 N11：删行会让上游对象在崩溃时失去凭据）——
		// 收尾（FinishReapedGatewayFile）之后行才消失。
		var left int
		var marked bool
		if err := db.QueryRow(`SELECT count(*), COALESCE(bool_or(reaping_at IS NOT NULL), false)
		                         FROM gateway_files WHERE file_id = ?`, id).Scan(&left, &marked); err != nil {
			t.Fatal(err)
		}
		if left != 1 || !marked {
			t.Fatalf("第 %d 轮认领后应保留带标记的行（left=%d marked=%v）", i, left, marked)
		}
		if err := FinishReapedGatewayFile(db, id); err != nil {
			t.Fatal(err)
		}
		if err := db.QueryRow(`SELECT count(*) FROM gateway_files WHERE file_id = ?`, id).Scan(&left); err != nil {
			t.Fatal(err)
		}
		if left != 0 {
			t.Fatalf("第 %d 轮收尾后行应被清掉（left=%d）", i, left)
		}
	}
}

// 认领必须**阻塞在行锁上**并复检：并发续期（把 expires_at 推到未来）提交后，
// 认领必须失败且**不得删掉这条活行**。
func TestClaimExpiredGatewayFileRefusesRowRenewedUnderLock(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)
	alice := mustUser(t, db, "gw-claim-renew")
	past := time.Now().Add(-time.Minute)
	if err := RecordGatewayFile(db, "claim-renew", alice, &past); err != nil {
		t.Fatal(err)
	}

	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	var locked string
	if err := tx.QueryRow(`SELECT file_id FROM gateway_files WHERE file_id = 'claim-renew' FOR UPDATE`).Scan(&locked); err != nil {
		t.Fatalf("持有行锁: %v", err)
	}

	type res struct {
		ok  bool
		err error
	}
	done := make(chan res, 1)
	go func() {
		_, ok, err := ClaimExpiredGatewayFile(db, "claim-renew")
		done <- res{ok, err}
	}()
	// 证据：claim 确实卡在行锁上（不是"跑得比续期快"的时序巧合）
	blockedOnGatewayFiles(t, db, 1)

	future := time.Now().Add(time.Hour)
	if _, err := tx.Exec(`UPDATE gateway_files SET expires_at = ? WHERE file_id = 'claim-renew'`, future); err != nil {
		t.Fatalf("并发续期: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	got := <-done
	if got.err != nil {
		t.Fatalf("claim 报错: %v", got.err)
	}
	if got.ok {
		t.Fatal("行已被续期为活行，claim 仍报告认领成功 ⇒ 会删掉活行 + 上游对象")
	}
	var expires time.Time
	if err := db.QueryRow(`SELECT expires_at FROM gateway_files WHERE file_id = 'claim-renew'`).Scan(&expires); err != nil {
		t.Fatalf("活行被误删了: %v", err)
	}
	if !expires.After(time.Now()) {
		t.Fatalf("活行的 expires_at = %v（应仍在未来）", expires)
	}
}

// 持锁事务回滚（续期没提交）后，认领必须成功 —— 锁内复检不能把"别人的回滚"当"已处理"。
func TestClaimExpiredGatewayFileSucceedsAfterRollback(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)
	alice := mustUser(t, db, "gw-claim-rb")
	past := time.Now().Add(-time.Minute)
	if err := RecordGatewayFile(db, "claim-rb", alice, &past); err != nil {
		t.Fatal(err)
	}

	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	var locked string
	if err := tx.QueryRow(`SELECT file_id FROM gateway_files WHERE file_id = 'claim-rb' FOR UPDATE`).Scan(&locked); err != nil {
		t.Fatal(err)
	}
	done := make(chan bool, 1)
	errc := make(chan error, 1)
	go func() {
		_, ok, err := ClaimExpiredGatewayFile(db, "claim-rb")
		done <- ok
		errc <- err
	}()
	blockedOnGatewayFiles(t, db, 1)
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	if !<-done {
		t.Fatalf("持锁事务回滚后认领应成功（err=%v）", <-errc)
	}
}

// 未过期 / 不存在的 id：必须是 ok=false 且不报错、不删行。
func TestClaimExpiredGatewayFileRejectsLiveAndUnknownRows(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)
	alice := mustUser(t, db, "gw-claim-live")
	future := time.Now().Add(time.Hour)
	if err := RecordGatewayFile(db, "claim-live", alice, &future); err != nil {
		t.Fatal(err)
	}
	if err := RecordGatewayFile(db, "claim-perm", alice, nil); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"claim-live", "claim-perm", "claim-missing"} {
		if _, ok, err := ClaimExpiredGatewayFile(db, id); err != nil || ok {
			t.Errorf("ClaimExpiredGatewayFile(%s) = ok:%v err:%v, want false/nil", id, ok, err)
		}
	}
	var left int
	if err := db.QueryRow(`SELECT count(*) FROM gateway_files`).Scan(&left); err != nil {
		t.Fatal(err)
	}
	if left != 2 {
		t.Fatalf("活行被认领删掉了: left=%d, want 2", left)
	}
}

// ---------------------------------------------------------------------------
// 6. Purge 与 Claim 交叉
// ---------------------------------------------------------------------------

func TestPurgeAndClaimCrossPaths(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)
	alice := mustUser(t, db, "gw-cross-alice")
	past := time.Now().Add(-time.Minute)

	// ① claim 先打标记 → purge 必须跳过它（否则删行会让上游对象在回收器崩溃时失去凭据）
	if err := RecordGatewayFile(db, "cross-1", alice, &past); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := ClaimExpiredGatewayFile(db, "cross-1"); err != nil || !ok {
		t.Fatalf("claim: ok=%v err=%v", ok, err)
	}
	if n, err := PurgeExpiredGatewayFiles(db, 10); err != nil || n != 0 {
		t.Fatalf("claim 之后 purge = %d/%v, want 0/nil（标记行必须被跳过）", n, err)
	}
	if err := FinishReapedGatewayFile(db, "cross-1"); err != nil {
		t.Fatal(err)
	}
	if n, err := PurgeExpiredGatewayFiles(db, 10); err != nil || n != 0 {
		t.Fatalf("收尾之后 purge 仍应为 0（行已删）: %d/%v", n, err)
	}

	// ② purge 先删 → claim 报 ok=false（不是错误）
	if err := RecordGatewayFile(db, "cross-2", alice, &past); err != nil {
		t.Fatal(err)
	}
	if n, err := PurgeExpiredGatewayFiles(db, 10); err != nil || n != 1 {
		t.Fatalf("purge = %d/%v, want 1/nil", n, err)
	}
	if _, ok, err := ClaimExpiredGatewayFile(db, "cross-2"); err != nil || ok {
		t.Fatalf("purge 之后 claim = ok:%v err:%v, want false/nil", ok, err)
	}

	// ③ 真并发：purge（SKIP LOCKED）与 claim（阻塞复检）都不能误删"续期后的活行"
	if err := RecordGatewayFile(db, "cross-3", alice, &past); err != nil {
		t.Fatal(err)
	}
	if err := RecordGatewayFile(db, "cross-4", alice, &past); err != nil {
		t.Fatal(err)
	}
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	var locked string
	if err := tx.QueryRow(`SELECT file_id FROM gateway_files WHERE file_id = 'cross-3' FOR UPDATE`).Scan(&locked); err != nil {
		t.Fatal(err)
	}
	claimDone := make(chan bool, 1)
	claimErr := make(chan error, 1)
	go func() {
		_, ok, err := ClaimExpiredGatewayFile(db, "cross-3")
		claimDone <- ok
		claimErr <- err
	}()
	blockedOnGatewayFiles(t, db, 1)

	// purge 必须跳过被锁的 cross-3，只清掉 cross-4
	n, err := PurgeExpiredGatewayFiles(db, 10)
	if err != nil {
		t.Fatalf("purge: %v", err)
	}
	if n != 1 {
		t.Fatalf("purge = %d, want 1（被并发持有行锁的 cross-3 必须 SKIP LOCKED 跳过）", n)
	}

	future := time.Now().Add(time.Hour)
	if _, err := tx.Exec(`UPDATE gateway_files SET expires_at = ? WHERE file_id = 'cross-3'`, future); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if ok := <-claimDone; ok {
		t.Fatalf("claim 认领了已被续期的活行（err=%v）", <-claimErr)
	}
	var rows int
	if err := db.QueryRow(`SELECT count(*) FROM gateway_files WHERE file_id = 'cross-3'`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("活行 cross-3 被误删（rows=%d）", rows)
	}
}

// ---------------------------------------------------------------------------
// 7. NormalizeLegacyPermanentGatewayFiles：幂等与边界
// ---------------------------------------------------------------------------

func TestNormalizeLegacyPermanentGatewayFilesIdempotentAndBounded(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)
	alice := mustUser(t, db, "gw-norm-alice")

	old := time.Now().Add(-30 * 24 * time.Hour).Truncate(time.Microsecond)
	future := time.Now().Add(time.Hour).Truncate(time.Microsecond)
	past := time.Now().Add(-time.Minute).Truncate(time.Microsecond)

	rawGatewayFile(t, db, "norm-null-1", alice, old, nil, 1)
	rawGatewayFile(t, db, "norm-null-2", alice, old.Add(time.Minute), nil, 2)
	rawGatewayFile(t, db, "norm-null-3", alice, old.Add(2*time.Minute), nil, 3)
	rawGatewayFile(t, db, "norm-live", alice, old, &future, 4)
	rawGatewayFile(t, db, "norm-expired", alice, old, &past, 5)

	// cap<=0：直接返回，一行都不动（包括 NULL 行）
	if n, err := NormalizeLegacyPermanentGatewayFiles(db, 0, 10); err != nil || n != 0 {
		t.Fatalf("cap=0: n=%d err=%v, want 0/nil", n, err)
	}
	if n, err := NormalizeLegacyPermanentGatewayFiles(db, -time.Hour, 10); err != nil || n != 0 {
		t.Fatalf("cap<0: n=%d err=%v, want 0/nil", n, err)
	}
	var nulls int
	if err := db.QueryRow(`SELECT count(*) FROM gateway_files WHERE expires_at IS NULL`).Scan(&nulls); err != nil {
		t.Fatal(err)
	}
	if nulls != 3 {
		t.Fatalf("cap<=0 时改动了 NULL 行: nulls=%d, want 3", nulls)
	}

	// limit 生效：只补 2 行
	const cap = 7 * 24 * time.Hour
	n, err := NormalizeLegacyPermanentGatewayFiles(db, cap, 2)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("limit=2 时补齐 %d 行, want 2", n)
	}
	if err := db.QueryRow(`SELECT count(*) FROM gateway_files WHERE expires_at IS NULL`).Scan(&nulls); err != nil {
		t.Fatal(err)
	}
	if nulls != 1 {
		t.Fatalf("limit=2 后剩余 NULL 行 = %d, want 1", nulls)
	}

	// 补齐值必须是 created_at + cap（精确到微秒），且**只动 NULL 行**
	var gotCreated, gotExpires time.Time
	if err := db.QueryRow(`SELECT created_at, expires_at FROM gateway_files
	                        WHERE expires_at IS NOT NULL AND file_id LIKE 'norm-null-%'
	                        ORDER BY file_id LIMIT 1`).Scan(&gotCreated, &gotExpires); err != nil {
		t.Fatal(err)
	}
	want := gotCreated.Add(cap)
	if !gotExpires.Truncate(time.Microsecond).Equal(want.Truncate(time.Microsecond)) {
		t.Errorf("补齐值 = %v, want created_at+cap = %v", gotExpires, want)
	}
	var liveExpires, expiredExpires time.Time
	if err := db.QueryRow(`SELECT expires_at FROM gateway_files WHERE file_id = 'norm-live'`).Scan(&liveExpires); err != nil {
		t.Fatal(err)
	}
	if !liveExpires.Truncate(time.Microsecond).Equal(future) {
		t.Errorf("活行的 expires_at 被改了: %v, want %v", liveExpires, future)
	}
	if err := db.QueryRow(`SELECT expires_at FROM gateway_files WHERE file_id = 'norm-expired'`).Scan(&expiredExpires); err != nil {
		t.Fatal(err)
	}
	if !expiredExpires.Truncate(time.Microsecond).Equal(past) {
		t.Errorf("已过期行的 expires_at 被改了: %v, want %v", expiredExpires, past)
	}

	// 幂等：再跑一次补齐剩下的 1 行，第三次 0 行
	if n, err := NormalizeLegacyPermanentGatewayFiles(db, cap, 500); err != nil || n != 1 {
		t.Fatalf("第二轮 = %d/%v, want 1/nil", n, err)
	}
	if n, err := NormalizeLegacyPermanentGatewayFiles(db, cap, 500); err != nil || n != 0 {
		t.Fatalf("第三轮 = %d/%v, want 0/nil（必须幂等）", n, err)
	}

	// 补齐后的老行必须能被 purge 收敛（这就是本次归一的全部目的）：
	// 三条 norm-null-* 的 created_at = 30 天前 + 7 天上限 ⇒ 23 天前就该过期，
	// 加上本来就过期的 norm-expired，共 4 行。
	before, err := PurgeExpiredGatewayFiles(db, 500)
	if err != nil {
		t.Fatal(err)
	}
	if before != 4 {
		t.Fatalf("purge = %d, want 4（3 条补齐后已过期的存量永久行 + norm-expired）", before)
	}
	if n, err := PurgeExpiredGatewayFiles(db, 500); err != nil || n != 0 {
		t.Fatalf("purge 第二遍 = %d/%v, want 0/nil（收敛）", n, err)
	}
	// norm-live（未来过期）必须留下
	var left int
	if err := db.QueryRow(`SELECT count(*) FROM gateway_files`).Scan(&left); err != nil {
		t.Fatal(err)
	}
	if left != 1 {
		t.Fatalf("清理后剩余 %d 行, want 1（活行）", left)
	}
}

// ---------------------------------------------------------------------------
// 8. GatewayFilesOwnedBy：空/重复/畸形 id 与参数上限
// ---------------------------------------------------------------------------

func TestGatewayFilesOwnedByHandlesDuplicatesAndHostileIDs(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)
	alice := mustUser(t, db, "gw-batch-alice")
	bob := mustUser(t, db, "gw-batch-bob")
	future := time.Now().Add(time.Hour)
	for _, id := range []string{"dup-1", "dup-2"} {
		if err := RecordGatewayFile(db, id, alice, &future); err != nil {
			t.Fatal(err)
		}
	}
	if err := RecordGatewayFile(db, "dup-bob", bob, &future); err != nil {
		t.Fatal(err)
	}

	// 重复 id：结果与去重后一致，不得报错、不得把 map 覆盖成奇怪状态
	got, err := GatewayFilesOwnedBy(db, []string{"dup-1", "dup-1", "dup-2", "dup-2", "dup-bob"}, alice)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("重复 id 的结果 = %v, want {dup-1,dup-2}", got)
	}
	for _, id := range []string{"dup-1", "dup-2"} {
		if _, ok := got[id]; !ok {
			t.Fatalf("缺少 %s: %v", id, got)
		}
	}

	// 注入串/空串/超长 id：只能当**字面量**，不得命中任何行、不得报错
	hostile := []string{"", "' OR 1=1--", `dup-1' OR '1'='1`, "%", "_", `\`, "dup-bob", strings.Repeat("x", 4096)}
	got, err = GatewayFilesOwnedBy(db, hostile, alice)
	if err != nil {
		t.Fatalf("畸形 id 导致报错（说明被拼进了 SQL）: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("畸形 id 命中了行: %v", got)
	}

	// 空输入：nil 与空切片都返回空 map
	for _, ids := range [][]string{nil, {}} {
		got, err := GatewayFilesOwnedBy(db, ids, alice)
		if err != nil || len(got) != 0 {
			t.Fatalf("空输入 %#v: %v/%v", ids, got, err)
		}
	}
}

// 参数个数上限：`IN (...)` 的展开受 PG 扩展协议 65535 参数的限制。批量归属判定是
// **对外可达**的（引用上限运行期可配到 4096，且调用方未来可能放宽），所以 DAO 必须
// 自己分片，不能把"参数太多"变成 500。
func TestGatewayFilesOwnedByHandlesLargeIDBatches(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)
	alice := mustUser(t, db, "gw-big-alice")
	future := time.Now().Add(time.Hour)

	const owned = 3
	ids := make([]string, 0, 70000)
	for i := 0; i < 70000; i++ {
		ids = append(ids, fmt.Sprintf("big-%06d", i))
	}
	// 只有首/中/尾三个真的登记过（跨分片边界）
	for _, i := range []int{0, 40000, 69999} {
		if err := RecordGatewayFile(db, ids[i], alice, &future); err != nil {
			t.Fatal(err)
		}
	}
	got, err := GatewayFilesOwnedBy(db, ids, alice)
	if err != nil {
		t.Fatalf("超长 id 列表报错（PG 扩展协议参数上限 65535 未分片）: %v", err)
	}
	if len(got) != owned {
		t.Fatalf("命中 %d 个, want %d: %v", len(got), owned, got)
	}
	for _, i := range []int{0, 40000, 69999} {
		if _, ok := got[ids[i]]; !ok {
			t.Fatalf("缺少跨分片的 %s", ids[i])
		}
	}
}

// ---------------------------------------------------------------------------
// 9. RecordGatewayFileSize 的字段语义
// ---------------------------------------------------------------------------

func TestRecordGatewayFileSizeMergeSemantics(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)
	alice := mustUser(t, db, "gw-size-alice")
	bob := mustUser(t, db, "gw-size-bob")
	future := time.Now().Add(time.Hour)
	past := time.Now().Add(-time.Minute)

	readSize := func(id string) (int64, int64, *time.Time) {
		t.Helper()
		var size, uid int64
		var exp *time.Time
		if err := db.QueryRow(`SELECT size_bytes, user_id, expires_at FROM gateway_files WHERE file_id = ?`, id).
			Scan(&size, &uid, &exp); err != nil {
			t.Fatalf("read %s: %v", id, err)
		}
		return size, uid, exp
	}

	// ① 首次登记带真实大小
	if err := RecordGatewayFileSize(db, "size-1", alice, &future, 1234); err != nil {
		t.Fatal(err)
	}
	if size, uid, _ := readSize("size-1"); size != 1234 || uid != alice {
		t.Fatalf("首次登记 = size:%d uid:%d", size, uid)
	}
	// ② 同归属续期带 0（上游没回大小）必须**保留**已知大小，不能清零
	if err := RecordGatewayFileSize(db, "size-1", alice, &future, 0); err != nil {
		t.Fatal(err)
	}
	if size, _, _ := readSize("size-1"); size != 1234 {
		t.Errorf("size=0 的续期把已知大小清零了: %d", size)
	}
	// ③ 同归属续期带新大小 ⇒ 覆盖
	if err := RecordGatewayFileSize(db, "size-1", alice, &future, 4321); err != nil {
		t.Fatal(err)
	}
	if size, _, _ := readSize("size-1"); size != 4321 {
		t.Errorf("续期未更新大小: %d, want 4321", size)
	}
	// ④ 负数按 0 处理（不写负值）
	if err := RecordGatewayFileSize(db, "size-neg", alice, &future, -5); err != nil {
		t.Fatal(err)
	}
	if size, _, _ := readSize("size-neg"); size != 0 {
		t.Errorf("负数大小 = %d, want 0", size)
	}
	// ⑤ 他人不得抢占**活行**（ON CONFLICT ... WHERE 不成立 ⇒ 静默不改行）
	if err := RecordGatewayFileSize(db, "size-1", bob, &future, 999999); err != nil {
		t.Fatal(err)
	}
	if size, uid, _ := readSize("size-1"); uid != alice || size != 4321 {
		t.Errorf("活行被他人改写: uid=%d size=%d", uid, size)
	}
	// ⑥ 过期行可被他人重占用，归属与过期时间都转手
	if err := RecordGatewayFileSize(db, "size-exp", alice, &past, 777); err != nil {
		t.Fatal(err)
	}
	if err := RecordGatewayFileSize(db, "size-exp", bob, &future, 888); err != nil {
		t.Fatal(err)
	}
	if size, uid, exp := readSize("size-exp"); uid != bob || size != 888 || exp == nil || !exp.After(time.Now()) {
		t.Errorf("过期行未被正确重占用: uid=%d size=%d exp=%v", uid, size, exp)
	}
	// ⑦ 永久行（NULL）永不被他人占用
	if err := RecordGatewayFileSize(db, "size-perm", alice, nil, 55); err != nil {
		t.Fatal(err)
	}
	if err := RecordGatewayFileSize(db, "size-perm", bob, &future, 66); err != nil {
		t.Fatal(err)
	}
	if size, uid, exp := readSize("size-perm"); uid != alice || size != 55 || exp != nil {
		t.Errorf("永久行被改写: uid=%d size=%d exp=%v", uid, size, exp)
	}
	// ⑧ 重占用后的 created_at 必须是**本次登记**的时间（不是上一个归属人的老时间）：
	//    老的 created_at 会让管理端显示错误的"上传时间"，也会让
	//    `ListGatewayFilesForPurge` 的"最旧优先"清理把刚上传的文件排在最前。
	old := time.Now().Add(-30 * 24 * time.Hour).Truncate(time.Microsecond)
	rawGatewayFile(t, db, "size-reclaim", alice, old, &past, 100)
	if err := RecordGatewayFileSize(db, "size-reclaim", bob, &future, 200); err != nil {
		t.Fatal(err)
	}
	var createdAt time.Time
	if err := db.QueryRow(`SELECT created_at FROM gateway_files WHERE file_id = 'size-reclaim'`).Scan(&createdAt); err != nil {
		t.Fatal(err)
	}
	if createdAt.Before(time.Now().Add(-time.Minute)) {
		t.Errorf("重占用后 created_at = %v（仍是上一个归属人 30 天前的时间）⇒ 上传时间与清理顺序都失真", createdAt)
	}
	// ⑨ 普通的同归属续期**不得**改写 created_at（续期不是重新上传）
	if err := db.QueryRow(`SELECT created_at FROM gateway_files WHERE file_id = 'size-1'`).Scan(&createdAt); err != nil {
		t.Fatal(err)
	}
	firstCreated := createdAt
	time.Sleep(20 * time.Millisecond)
	if err := RecordGatewayFileSize(db, "size-1", alice, &future, 4321); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT created_at FROM gateway_files WHERE file_id = 'size-1'`).Scan(&createdAt); err != nil {
		t.Fatal(err)
	}
	if !createdAt.Equal(firstCreated) {
		t.Errorf("同归属续期改写了 created_at: %v → %v", firstCreated, createdAt)
	}
}

// ---------------------------------------------------------------------------
// 10. ListGatewayFileIDs 的 LIMIT 截断语义
// ---------------------------------------------------------------------------

// 单用户活行超过 gatewayFilesListLimit 时，返回的是**按 created_at 最新的那批**。
// 上游每 key 上限 10000 个文件（全组织共用一把 key）⇒ 该截断在现实中不可达；
// 本用例把语义钉住，防止将来有人把 ORDER BY 去掉后静默变成"任意 20000 行"。
func TestListGatewayFileIDsTruncatesToNewestRows(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)
	alice := mustUser(t, db, "gw-ids-alice")

	base := time.Now().Add(-48 * time.Hour)
	if _, err := db.Exec(`INSERT INTO gateway_files (file_id, user_id, created_at, expires_at, size_bytes)
		SELECT 'oldest-' || lpad(i::text, 5, '0'), ?, ?, NULL, 0
		  FROM generate_series(1, ?) AS i`, alice, base, gatewayFilesListLimit+1); err != nil {
		t.Fatalf("bulk insert: %v", err)
	}
	ids, err := ListGatewayFileIDs(db, alice)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != gatewayFilesListLimit {
		t.Fatalf("集合大小 = %d, want %d", len(ids), gatewayFilesListLimit)
	}
	// created_at 全部相同 ⇒ 必须仍然返回确定的一批（而不是随机行）：这里只断言
	// "最旧的那一行可能被截断"这一现象的**存在性判据** —— 数量有界即可，
	// 具体丢哪一行由 created_at 决定。
	if _, ok := ids["oldest-00001"]; ok && len(ids) == gatewayFilesListLimit {
		// 不能断定一定丢这一行（created_at 相同时次序未定义），但下面的"新行必在手"必须成立
		t.Log("created_at 相同时的截断集合不保证包含最旧行（PG 未定义次序）")
	}
	// 新增一行"最新"的活行后必须出现在集合里（ORDER BY created_at DESC 的语义）
	newest := time.Now().Add(time.Hour)
	if err := RecordGatewayFile(db, "newest-row", alice, &newest); err != nil {
		t.Fatal(err)
	}
	ids, err = ListGatewayFileIDs(db, alice)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := ids["newest-row"]; !ok {
		t.Fatal("最新的活行不在集合里（ORDER BY created_at DESC 失效）")
	}
	// 过期行永远不在集合里，无论多少行
	past := time.Now().Add(-time.Minute)
	if err := RecordGatewayFile(db, "expired-row", alice, &past); err != nil {
		t.Fatal(err)
	}
	ids, err = ListGatewayFileIDs(db, alice)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := ids["expired-row"]; ok {
		t.Fatal("过期行出现在集合里")
	}
}

// ---------------------------------------------------------------------------
// 11. 迁移可重入性 + 台账其余读面
// ---------------------------------------------------------------------------

// 0077/0078 必须逐字可重放（IF NOT EXISTS 语义）；生产升级只在首次执行，
// 但模板库/重放/回滚场景都会二次执行同一份 SQL。
func TestGatewayFilesMigrationsAreReentrant(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)

	for _, name := range []string{"0077_gateway_files.sql", "0078_gateway_files_size.sql"} {
		content, err := migrationFS.ReadFile("migrations-pg/" + name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		if _, err := db.Exec(string(content)); err != nil {
			t.Fatalf("重放 %s 失败（迁移不幂等）: %v", name, err)
		}
	}

	// 列齐全且类型/默认值符合契约
	cols := map[string]string{}
	rows, err := db.Query(`SELECT column_name, data_type FROM information_schema.columns
	                        WHERE table_name = 'gateway_files'`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var name, typ string
		if err := rows.Scan(&name, &typ); err != nil {
			t.Fatal(err)
		}
		cols[name] = typ
	}
	rows.Close()
	for want, typ := range map[string]string{
		"file_id": "text", "user_id": "bigint", "created_at": "timestamp with time zone",
		"expires_at": "timestamp with time zone", "size_bytes": "bigint",
	} {
		if got, ok := cols[want]; !ok || got != typ {
			t.Errorf("列 %s = %q(%v), want %q", want, got, ok, typ)
		}
	}
	// 0078 的两条索引必须在（管理端"按员工 + 状态"与回收扫描走它们）
	for _, idx := range []string{
		"idx_gateway_files_user_created", "idx_gateway_files_expires",
		"idx_gateway_files_user_expires", "idx_gateway_files_expires_created",
	} {
		var got string
		if err := db.QueryRow(`SELECT indexname FROM pg_indexes
		                        WHERE tablename = 'gateway_files' AND indexname = ?`, idx).Scan(&got); err != nil {
			t.Errorf("索引 %s 缺失: %v", idx, err)
		}
	}
}

func TestGatewayFileTotalsAndPurgeListRespectFilters(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)
	alice := mustUser(t, db, "gw-tot-alice")
	bob := mustUser(t, db, "gw-tot-bob")
	now := time.Now().Truncate(time.Microsecond)
	pastA, pastB := now.Add(-2*time.Hour), now.Add(-time.Hour)

	rawGatewayFile(t, db, "tot-a-live", alice, now, nil, 100)
	rawGatewayFile(t, db, "tot-a-exp-old", alice, now, &pastA, 200)
	rawGatewayFile(t, db, "tot-a-exp-new", alice, now, &pastB, 300)
	rawGatewayFile(t, db, "tot-b-live", bob, now, nil, 400)

	files, bytes, expired, err := GatewayFileTotals(db)
	if err != nil {
		t.Fatal(err)
	}
	if files != 4 || bytes != 1000 || expired != 2 {
		t.Fatalf("totals = %d/%d/%d, want 4/1000/2", files, bytes, expired)
	}

	// ListExpiredGatewayFiles：按过期时间**升序**（最旧的先回收）
	ids, err := ListExpiredGatewayFiles(db, 10)
	if err != nil {
		t.Fatal(err)
	}
	if !sameOrder(ids, []string{"tot-a-exp-old", "tot-a-exp-new"}) {
		t.Fatalf("ListExpiredGatewayFiles = %v, want 最旧在前", ids)
	}
	// limit 生效
	if ids, err := ListExpiredGatewayFiles(db, 1); err != nil || len(ids) != 1 || ids[0] != "tot-a-exp-old" {
		t.Fatalf("ListExpiredGatewayFiles(1) = %v/%v", ids, err)
	}

	// ListGatewayFilesForPurge：按 created_at 升序 + 过滤条件与列表面同源
	for _, tc := range []struct {
		q    GatewayFileQuery
		want []string
	}{
		{GatewayFileQuery{UserID: alice, OnlyExpired: true}, []string{"tot-a-exp-old", "tot-a-exp-new"}},
		{GatewayFileQuery{UserID: alice, OnlyActive: true}, []string{"tot-a-live"}},
		{GatewayFileQuery{UserID: bob}, []string{"tot-b-live"}},
		{GatewayFileQuery{UserID: -1}, nil},
		{GatewayFileQuery{Search: "exp"}, []string{"tot-a-exp-old", "tot-a-exp-new"}},
	} {
		got, err := ListGatewayFilesForPurge(db, tc.q, 100)
		if err != nil {
			t.Fatalf("ListGatewayFilesForPurge(%+v): %v", tc.q, err)
		}
		if !sameOrder(got, tc.want) {
			t.Errorf("ListGatewayFilesForPurge(%+v) = %v, want %v", tc.q, got, tc.want)
		}
		// 清理面的过滤结果必须与列表面一致（两处共用 gatewayFileWhere）
		_, total := listFileIDs(t, db, tc.q)
		if int(total) != len(tc.want) {
			t.Errorf("列表 total=%d 与清理面 %d 条不一致（%+v）", total, len(tc.want), tc.q)
		}
	}

	// GatewayFileRowExists 不看过期：过期行也必须能被按 id 删掉
	for _, id := range []string{"tot-a-live", "tot-a-exp-old"} {
		ok, err := GatewayFileRowExists(db, id)
		if err != nil || !ok {
			t.Errorf("GatewayFileRowExists(%s) = %v/%v, want true", id, ok, err)
		}
	}
	if ok, err := GatewayFileRowExists(db, "tot-missing"); err != nil || ok {
		t.Errorf("未登记 id: %v/%v, want false/nil", ok, err)
	}
	// 列表里的 expired 标记与记录一致
	rows, _, err := ListGatewayFiles(db, GatewayFileQuery{UserID: alice, Limit: 50})
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range rows {
		want := strings.HasSuffix(r.FileID, "-exp-old") || strings.HasSuffix(r.FileID, "-exp-new")
		if r.Expired != want {
			t.Errorf("%s: expired=%v, want %v", r.FileID, r.Expired, want)
		}
	}
}

// ---------------------------------------------------------------------------
// 12. RestoreGatewayFileRow：回收器写回（审计 N7/N10）
// ---------------------------------------------------------------------------

// 认领快照必须带上 created_at —— 否则写回只能记 now()，台账丢掉真实上传时间（N10）。
func TestClaimExpiredGatewayFileSnapshotCarriesOriginalFields(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)
	alice := mustUser(t, db, "gw-snap-alice")

	created := time.Now().Add(-6 * 24 * time.Hour).Truncate(time.Microsecond)
	expires := time.Now().Add(-2 * time.Hour).Truncate(time.Microsecond)
	rawGatewayFile(t, db, "snap-1", alice, created, &expires, 4242)

	snap, ok, err := ClaimExpiredGatewayFile(db, "snap-1")
	if err != nil || !ok {
		t.Fatalf("claim = %v/%v", ok, err)
	}
	if snap.FileID != "snap-1" || snap.UserID != alice || snap.SizeBytes != 4242 {
		t.Fatalf("快照 = %+v", snap)
	}
	if !snap.CreatedAt.Truncate(time.Microsecond).Equal(created) {
		t.Errorf("快照 CreatedAt = %v, want %v（写回要保留原始上传时间）", snap.CreatedAt, created)
	}
	if snap.ExpiresAt == nil || !snap.ExpiresAt.Truncate(time.Microsecond).Equal(expires) {
		t.Errorf("快照 ExpiresAt = %v, want %v", snap.ExpiresAt, expires)
	}
}

// ① 行已存在（且可能已被并发续期）⇒ 写回**绝不覆盖**；② 行不存在 ⇒ 按传入值补回；
// ③ 重复调用幂等。
func TestRestoreGatewayFileRowNeverOverwritesExistingRow(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)
	alice := mustUser(t, db, "gw-restore-alice")
	bob := mustUser(t, db, "gw-restore-bob")

	type row struct {
		userID    int64
		createdAt time.Time
		expiresAt *time.Time
		size      int64
	}
	read := func(id string) row {
		t.Helper()
		var r row
		if err := db.QueryRow(`SELECT user_id, created_at, expires_at, size_bytes
		                         FROM gateway_files WHERE file_id = ?`, id).
			Scan(&r.userID, &r.createdAt, &r.expiresAt, &r.size); err != nil {
			t.Fatalf("read %s: %v", id, err)
		}
		return r
	}

	past := time.Now().Add(-2 * time.Hour).Truncate(time.Microsecond)
	future := time.Now().Add(48 * time.Hour).Truncate(time.Microsecond)
	original := time.Now().Add(-6 * 24 * time.Hour).Truncate(time.Microsecond)

	// 场景（N7）：认领后原主重新上传把 expires_at 推到未来 ⇒ 写回不得把它打回过去
	rawGatewayFile(t, db, "rest-1", alice, original, &past, 100)
	snap, ok, err := ClaimExpiredGatewayFile(db, "rest-1")
	if err != nil || !ok {
		t.Fatalf("claim: %v/%v", ok, err)
	}
	if err := RecordGatewayFileSize(db, "rest-1", alice, &future, 300); err != nil {
		t.Fatal(err)
	}
	renewed := read("rest-1")
	if err := RestoreGatewayFileRow(db, snap.FileID, snap.UserID, &snap.CreatedAt, snap.ExpiresAt, snap.SizeBytes); err != nil {
		t.Fatalf("restore: %v", err)
	}
	after := read("rest-1")
	if after.expiresAt == nil || !after.expiresAt.Truncate(time.Microsecond).Equal(future) {
		t.Errorf("写回把续期后的 expires_at 打回了过去: %v, want %v", after.expiresAt, future)
	}
	if !after.createdAt.Truncate(time.Microsecond).Equal(renewed.createdAt.Truncate(time.Microsecond)) {
		t.Errorf("写回改写了 created_at: %v → %v", renewed.createdAt, after.createdAt)
	}
	if after.size != 300 || after.userID != alice {
		t.Errorf("写回改写了 size/user: %+v", after)
	}

	// ③ 重复写回幂等
	for i := 0; i < 3; i++ {
		if err := RestoreGatewayFileRow(db, snap.FileID, snap.UserID, &snap.CreatedAt, snap.ExpiresAt, snap.SizeBytes); err != nil {
			t.Fatal(err)
		}
	}
	if again := read("rest-1"); again.size != 300 || !again.expiresAt.Truncate(time.Microsecond).Equal(future) {
		t.Errorf("重复写回不幂等: %+v", again)
	}

	// ① 行存在但是**别人**的（过期被别人重占用）⇒ 同样不覆盖
	rawGatewayFile(t, db, "rest-2", alice, original, &past, 100)
	snap2, ok, err := ClaimExpiredGatewayFile(db, "rest-2")
	if err != nil || !ok {
		t.Fatalf("claim2: %v/%v", ok, err)
	}
	if err := RecordGatewayFileSize(db, "rest-2", bob, &future, 700); err != nil {
		t.Fatal(err)
	}
	if err := RestoreGatewayFileRow(db, snap2.FileID, snap2.UserID, &snap2.CreatedAt, snap2.ExpiresAt, snap2.SizeBytes); err != nil {
		t.Fatal(err)
	}
	if got := read("rest-2"); got.userID != bob || got.size != 700 {
		t.Errorf("写回抢回了已转手的行: %+v（want bob/700）", got)
	}

	// ② 行不存在（上游删除失败后下轮重试前进程重启等）⇒ 按传入值**原样**补回
	if err := RestoreGatewayFileRow(db, "rest-3", alice, &original, &past, 55); err != nil {
		t.Fatal(err)
	}
	got := read("rest-3")
	if got.userID != alice || got.size != 55 {
		t.Errorf("补回的行 = %+v, want alice/55", got)
	}
	if !got.createdAt.Truncate(time.Microsecond).Equal(original) {
		t.Errorf("补回的 created_at = %v, want %v（必须保留原始上传时间）", got.createdAt, original)
	}
	if got.expiresAt == nil || !got.expiresAt.Truncate(time.Microsecond).Equal(past) {
		t.Errorf("补回的 expires_at = %v, want %v（过期行留待下轮重试）", got.expiresAt, past)
	}
	// 补回后的行必须能被认领/清理路径继续看见
	if ids, err := ListExpiredGatewayFiles(db, 10); err != nil || len(ids) == 0 {
		t.Fatalf("补回后的过期行未被回收面看见: %v/%v", ids, err)
	}

	// createdAt=nil ⇒ 记 now()；负数大小 ⇒ 0；expires_at=nil 允许（永久行）
	before := time.Now().Add(-time.Minute)
	if err := RestoreGatewayFileRow(db, "rest-4", alice, nil, nil, -9); err != nil {
		t.Fatal(err)
	}
	got4 := read("rest-4")
	if got4.createdAt.Before(before) {
		t.Errorf("createdAt=nil 时未记 now(): %v", got4.createdAt)
	}
	if got4.size != 0 || got4.expiresAt != nil {
		t.Errorf("rest-4 = %+v, want size 0 / expires nil", got4)
	}
}

// 反面对照（证明 RestoreGatewayFileRow 不是多余的）：把写回换成
// `RecordGatewayFileSize` 会把已续期的活行打回过期 —— 这正是 N7 的现场。
func TestRecordGatewayFileSizeIsNotASafeWriteBack(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)
	alice := mustUser(t, db, "gw-n7-alice")

	past := time.Now().Add(-2 * time.Hour).Truncate(time.Microsecond)
	future := time.Now().Add(48 * time.Hour).Truncate(time.Microsecond)
	rawGatewayFile(t, db, "n7-1", alice, time.Now().Add(-6*24*time.Hour), &past, 100)
	snap, ok, err := ClaimExpiredGatewayFile(db, "n7-1")
	if err != nil || !ok {
		t.Fatalf("claim: %v/%v", ok, err)
	}
	// 原主并发续期（同一 user_id ⇒ ON CONFLICT 的 WHERE 命中）
	if err := RecordGatewayFileSize(db, "n7-1", alice, &future, 300); err != nil {
		t.Fatal(err)
	}
	// 用 RecordGatewayFileSize 写回快照
	if err := RecordGatewayFileSize(db, snap.FileID, snap.UserID, snap.ExpiresAt, snap.SizeBytes); err != nil {
		t.Fatal(err)
	}
	var expires *time.Time
	if err := db.QueryRow(`SELECT expires_at FROM gateway_files WHERE file_id = 'n7-1'`).Scan(&expires); err != nil {
		t.Fatal(err)
	}
	if expires == nil || !expires.Before(time.Now()) {
		t.Fatalf("反面对照失效：RecordGatewayFileSize 写回后 expires_at = %v（本应被打回过期 ⇒ 说明它不再是危险路径，需重审 RestoreGatewayFileRow 的必要性）", expires)
	}
	// 活行被打回过期后，任何人都能抢占它 —— 这就是必须用 DO NOTHING 写回的原因
	if owned, err := GatewayFileOwnedBy(db, "n7-1", alice); err != nil || owned {
		t.Fatalf("被打回的活行仍判为归属自己（%v/%v）—— 与上面的结论矛盾", owned, err)
	}
}

// ---------------------------------------------------------------------------
// 13. 畸形搜索输入：NUL 字节不得把管理端打成 500
// ---------------------------------------------------------------------------

// `?q=%00` 是 URL 就能表达的一字节输入；PG 的 text **参数**不能含 NUL
// （SQLSTATE 22021），而 text **列**也存不了 NUL ⇒ 唯一正确语义是"无命中"。
// 判据要同时钉住三件事：不报错 / 空集 / **不得退化成"忽略搜索条件返回全量"**。
func TestListGatewayFilesSearchWithNulByteDoesNotError(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)
	alice := mustUser(t, db, "gw-nul-alice")
	bob := mustUser(t, db, "gw-nul-bob")
	for i, id := range []string{"nul-a", "nul-b", "nul-c"} {
		if err := RecordGatewayFile(db, id, alice, nil); err != nil {
			t.Fatal(err)
		}
		_ = i
	}
	if err := RecordGatewayFile(db, "nul-other", bob, nil); err != nil {
		t.Fatal(err)
	}

	for _, q := range []string{"\x00", "nul\x00-1", "nul\x00", "\x00nul", "nul-a\x00"} {
		rows, total, err := ListGatewayFiles(db, GatewayFileQuery{Search: q, Limit: 50})
		if err != nil {
			t.Errorf("Search=%q 报错（管理端会 500）: %v", q, err)
			continue
		}
		if len(rows) != 0 || total != 0 {
			t.Errorf("Search=%q: rows=%d total=%d, want 0/0（含 NUL 的搜索必须是无命中）", q, len(rows), total)
		}
	}
	// 带 userId 过滤时也一样：不能因为丢了搜索条件就把该员工的行全部返回
	rows, total, err := ListGatewayFiles(db, GatewayFileQuery{UserID: alice, Search: "\x00", Limit: 50})
	if err != nil || len(rows) != 0 || total != 0 {
		t.Errorf("user 过滤 + NUL 搜索 = rows:%d total:%d err:%v, want 0/0/nil", len(rows), total, err)
	}
	// 清理面共用同一份 WHERE：NUL 同样不能报错
	if ids, err := ListGatewayFilesForPurge(db, GatewayFileQuery{Search: "\x00"}, 50); err != nil || len(ids) != 0 {
		t.Errorf("ListGatewayFilesForPurge(NUL) = %v/%v, want 空集/nil", ids, err)
	}
	// 数据没被动过，且正常搜索仍然工作（防"为了不报错把搜索整个禁用"）
	all, allTotal := listFileIDs(t, db, GatewayFileQuery{Limit: 50})
	if allTotal != 4 || len(all) != 4 {
		t.Fatalf("NUL 搜索后全量 = %d/%d, want 4/4", len(all), allTotal)
	}
	if got, total := listFileIDs(t, db, GatewayFileQuery{Search: "nul-a", Limit: 50}); !sameOrder(got, []string{"nul-a"}) || total != 1 {
		t.Errorf("正常搜索被 NUL 分支影响: %v/%d", got, total)
	}
}
