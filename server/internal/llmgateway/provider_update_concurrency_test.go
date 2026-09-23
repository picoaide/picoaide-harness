package llmgateway

// 2026-09-23(第三轮 §7.3 B):PUT /providers/:id 的**丢失更新**窗口。
//
// 缺陷形态(VERIFY.md §5.4 已确定性复现):handler 在**事务外**用
// GetGatewayProvider 读基线,事务内整行写回 —— 两步之间别的写者提交的字段会被
// 这份过期快照覆盖。最扎眼的形态是"并发改名把刚轮换的密钥写回旧密文":A 轮换
// 密钥、B 只改名,B 用读到的旧 api_key_enc 覆盖 A 刚写的新密文,而且**回 200、
// 审计也只字不提**(B 的 orig 与 p 都来自同一份旧快照,两者相等 ⇒ 不记"已更换")。
//
// 判据用**确定性交错**(不靠赢得竞态):
//  1. 控制事务先拿下**审计链锁**(与 handler 事务内 AuditLogTx 争用的同一把
//     pg_advisory_xact_lock)—— A 写完 provider 行、进审计时必停在这把锁上,
//     此时它已持有 provider 行锁且未提交;
//  2. 等到 A 确实阻塞在 advisory 锁上,再放 B 进入(只改名):修复前 B 在事务外
//     读基线、拿不到锁(普通 SELECT 不阻塞)⇒ 读到 A 提交前的旧值,随后 UPDATE
//     被 A 的行锁挡住;修复后 B 直接停在事务内的 SELECT … FOR UPDATE 上;
//  3. 释放链锁 ⇒ A 提交、B 继续。修复前 B 用旧快照整行写回(A 的变更被回滚),
//     修复后 B 基于 A 提交后的最新值写回(两者都留)。
//
// 断言的是**库里的值**而不是返回码:两个请求在两种实现下都是 200。

import (
	"database/sql"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// waitForBlockedBackends 轮询 pg_stat_activity,等到当前测试库里出现
// wantAdvisory 个"等 advisory 锁"与 wantXact 个"等事务/行锁"的后端
// (不含本连接;idle in transaction 的控制连接不算 active,天然被排除)。
// 用它把"两个写者都已经进入临界区并停在预期的锁上"变成可观测事实。
func waitForBlockedBackends(t *testing.T, db *sql.DB, wantAdvisory, wantXact int) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	var last string
	for time.Now().Before(deadline) {
		var adv, xact int
		err := db.QueryRow(`SELECT
			COALESCE(SUM(CASE WHEN wait_event = 'advisory' THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN wait_event IN ('transactionid', 'tuple') THEN 1 ELSE 0 END), 0)
			FROM pg_stat_activity
			WHERE datname = current_database() AND pid <> pg_backend_pid()
			  AND state = 'active' AND wait_event_type = 'Lock'`).Scan(&adv, &xact)
		if err != nil {
			t.Fatalf("读 pg_stat_activity 失败: %v", err)
		}
		last = fmt.Sprintf("advisory=%d xact=%d", adv, xact)
		if adv >= wantAdvisory && xact >= wantXact {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("等待阻塞中的后端超时: want advisory>=%d xact>=%d, 实测 %s", wantAdvisory, wantXact, last)
}

// holdAuditChainLock 用一个控制事务占住审计哈希链的 advisory 锁(写一条审计即
// 等于取锁,锁持有到本事务提交/回滚)。返回的 release 放行。
//
// 为什么用审计链锁当屏障:它是 handler 事务内**最后**一个跨连接争用点,位置正好
// 在"provider 行已写、事务未提交"这一刻 —— 修复前后两种实现都会停在这里,所以
// 同一个用例在两种实现下都能构造出确定的交错。
func holdAuditChainLock(t *testing.T, db *sql.DB) (release func()) {
	t.Helper()
	tx, err := db.Begin()
	if err != nil {
		t.Fatalf("开启控制事务失败: %v", err)
	}
	if err := serverstore.AuditLogTx(tx, "r3-barrier", "r3_barrier", "hold audit chain lock"); err != nil {
		_ = tx.Rollback()
		t.Fatalf("控制事务取审计链锁失败: %v", err)
	}
	return func() {
		if err := tx.Commit(); err != nil {
			t.Errorf("释放审计链锁失败: %v", err)
		}
	}
}

// putOutcome 是并发 PUT 的结果(在 goroutine 里采集,主 goroutine 断言)。
type putOutcome struct {
	code int
	body string
}

// TestAdminProviderUpdateConcurrentRenameKeepsRotatedKey 是 §7.3 B 的核心判据:
// 并发的"只改名"不得把另一个请求刚轮换的密钥与刚改的 base_url 写回旧值。
func TestAdminProviderUpdateConcurrentRenameKeepsRotatedKey(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	// 手动型上游(不触发出网同步)。m1 是清单里唯一的模型。
	if w, _ := adminReq(t, r, "POST", "/api/server/admin/providers",
		`{"name":"manual","base_url":"http://orig","api_key":"orig-key","models":["m1"]}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("建上游: %d %s", w.Code, w.Body.String())
	}
	oldKey := providerRowField(gatewayProviderRowDump(t, db, 1), "api_key_enc")
	if oldKey == "" {
		t.Fatal("前置条件不成立:provider 没有 api_key_enc")
	}

	// 屏障:控制事务先占住审计链锁。
	release := holdAuditChainLock(t, db)

	// A:轮换密钥 + 改 base_url(两处变更 ⇒ 一定写审计 ⇒ 一定停在链锁上)。
	doneA := make(chan putOutcome, 1)
	go func() {
		w, _ := adminReq(t, r, "PUT", "/api/server/admin/providers/1",
			`{"base_url":"http://a","api_key":"key-A"}`, hdr)
		doneA <- putOutcome{code: w.Code, body: w.Body.String()}
	}()
	// A 停在链锁上 = 它已经写完 provider 行、持有行锁、尚未提交。
	waitForBlockedBackends(t, db, 1, 0)

	// B:只改名(不碰 base_url / api_key)。
	doneB := make(chan putOutcome, 1)
	go func() {
		w, _ := adminReq(t, r, "PUT", "/api/server/admin/providers/1", `{"name":"renamed"}`, hdr)
		doneB <- putOutcome{code: w.Code, body: w.Body.String()}
	}()
	// B 停在 provider 行锁上(修复前:事务外读基线 + UPDATE 等锁;修复后:
	// 事务内 SELECT … FOR UPDATE 等锁)。
	waitForBlockedBackends(t, db, 1, 1)

	release()

	a, b := <-doneA, <-doneB
	if a.code != http.StatusOK {
		t.Fatalf("A(轮换密钥+改 base_url): %d %s", a.code, a.body)
	}
	if b.code != http.StatusOK {
		t.Fatalf("B(改名): %d %s", b.code, b.body)
	}

	row := gatewayProviderRowDump(t, db, 1)
	if got := providerRowField(row, "name"); got != "renamed" {
		t.Fatalf("B 的改名没落库: %s", row)
	}
	if got := providerRowField(row, "base_url"); got != "http://a" {
		t.Fatalf("丢失更新:A 改的 base_url=http://a 被 B 用旧快照写回 %q\n%s", got, row)
	}
	if got := providerRowField(row, "api_key_enc"); got == oldKey {
		t.Fatalf("丢失更新:A 轮换的密钥被 B 写回旧密文(静默回滚密钥轮换)\n%s", row)
	}
	// 审计口径:只有 A 换了密钥 ⇒ B 的明细不得出现"api_key:已更换";
	// 两条 provider_update 都必须落库(链完好)。
	var details []string
	rows, err := db.Query(`SELECT detail FROM audit_logs WHERE action = 'provider_update' ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var d string
		if err := rows.Scan(&d); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		details = append(details, d)
	}
	rows.Close()
	if len(details) != 2 {
		t.Fatalf("provider_update 审计 = %d 条(%v), want 2 条", len(details), details)
	}
	keyChanges := 0
	for _, d := range details {
		if strings.Contains(d, "api_key:已更换") {
			keyChanges++
		}
	}
	if keyChanges != 1 {
		t.Fatalf("审计谎报密钥更换:明细 = %v, want 恰好 1 条含 api_key:已更换", details)
	}
	if broken, err := serverstore.VerifyAuditChain(db); err != nil || broken != 0 {
		t.Fatalf("审计哈希链校验失败: broken=%d err=%v", broken, err)
	}
}
