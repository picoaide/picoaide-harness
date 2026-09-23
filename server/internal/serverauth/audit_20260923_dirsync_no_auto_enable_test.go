package serverauth

// R5-B-8（第五轮审计 2026-09-23，P3→已修）：目录同步不得复活管理员显式禁用的账号。
//
// 缺陷形态：`SyncDirectoryRun` 每 1 小时把「仍在目录里」的外部用户一律写回
// `Status=1`（走不吊销 token 的 UpdateUser），且**不写任何审计** —— 管理员为安全
// 事件按下的「禁用」会在 ≤1h 内被静默撤销，管理端此前显示的"已禁用"与事实相反。
//
// 定案语义：**目录同步只自动停用，永不自动启用**；启用一律是管理员的显式动作。
// 依据与代价（含"为什么不为存量行引入『显式禁用』标记"）见 dirsync.go 文件头。
//
// 判据（可用例打坏）：
//  1. 管理员禁用 → 跑一轮同步 → status 仍为 0，且每轮一条点名审计；
//  2. 目录侧消失→返回的账号同样保持停用（规则没有例外分支）；
//  3. 管理员显式启用 → 同步不再干预；
//  4. 目录同步自己停用账号时也写审计（此前 dirsync 全文零 AuditLog）。

import (
	"strings"
	"testing"

	"github.com/go-ldap/ldap/v3"

	"github.com/picoaide/picoaide/internal/serverstore"
)

func TestDirectorySyncDoesNotReviveAdminDisabledAccount(t *testing.T) {
	db := mustDB(t)
	p, f := fakeDir(t)
	if _, err := SyncDirectoryRun(db, p); err != nil {
		t.Fatal(err)
	}
	alice, err := serverstore.GetUserByUsername(db, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if alice.Status != 1 {
		t.Fatalf("alice status = %d, want 1(首次同步创建后应为启用)", alice.Status)
	}

	// ① 管理员显式禁用（与 webadmin 的 PUT /users/:id status=0 同一条 DAO 路径,
	//    该路径同事务吊销全部 token）。
	upd := *alice
	upd.Status = 0
	if err := serverstore.UpdateUserRevokingTokens(db, &upd); err != nil {
		t.Fatal(err)
	}

	// ② 跑一轮目录同步：alice 仍在目录里 —— 必须**保持停用**并留下审计。
	res, err := SyncDirectoryRun(db, p)
	if err != nil {
		t.Fatal(err)
	}
	if res.SkippedDisabled != 1 {
		t.Fatalf("skipped_disabled = %d, want 1(alice 已停用,目录同步不得启用)", res.SkippedDisabled)
	}
	alice, err = serverstore.GetUserByUsername(db, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if alice.Status != 0 {
		t.Fatal("目录同步把管理员显式禁用的账号复活了(R5-B-8 回归)")
	}
	rows, _, err := serverstore.ListAuditLogsPagedFiltered(db, 0, 50, "directory_enable_skipped", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("directory_enable_skipped 审计条数 = %d, want 1(每轮最多一条,点名到上限)", len(rows))
	}
	if !strings.Contains(rows[0].Detail, "alice") {
		t.Fatalf("审计未点名被跳过的账号: %q", rows[0].Detail)
	}
	if rows[0].Username != dirSyncAuditActor {
		t.Fatalf("审计 actor = %q, want %q(无真人发起者)", rows[0].Username, dirSyncAuditActor)
	}
	// 规则本身也写进详情：读到这条审计的人应当知道"这不是故障,是策略"。
	if !strings.Contains(rows[0].Detail, "只由管理员显式恢复") {
		t.Fatalf("审计详情未写明规则: %q", rows[0].Detail)
	}

	// ③ 管理员显式启用 ⇒ 同步不再干预（保持 1）。
	alice.Status = 1
	if err := serverstore.UpdateUserRevokingTokens(db, alice); err != nil {
		t.Fatal(err)
	}
	if _, err := SyncDirectoryRun(db, p); err != nil {
		t.Fatal(err)
	}
	alice, _ = serverstore.GetUserByUsername(db, "alice")
	if alice.Status != 1 {
		t.Fatalf("alice status = %d, want 1(管理员显式恢复后不得被改动)", alice.Status)
	}

	// ④ 目录侧"消失又出现"的账号同样保持停用（规则没有例外分支）：
	//    bob 从目录消失 → 同步停用；bob 回到目录 → 仍须保持停用（管理员启用）。
	f.searchResults["(uid=*)"] = &ldap.SearchResult{Entries: []*ldap.Entry{
		dirUser("uid=alice,ou=people,dc=example", "alice", "Alice", "alice@example.com"),
		dirUser("uid=carol,ou=people,dc=example", "carol", "Carol", "carol@example.com"),
	}}
	if res, err = SyncDirectoryRun(db, p); err != nil {
		t.Fatal(err)
	} else if res.Deact != 1 {
		t.Fatalf("deactivated = %d, want 1(bob 已从目录消失)", res.Deact)
	}
	bob, _ := serverstore.GetUserByUsername(db, "bob")
	if bob.Status != 0 {
		t.Fatalf("bob status = %d, want 0(目录消失即停用)", bob.Status)
	}
	f.searchResults["(uid=*)"] = &ldap.SearchResult{Entries: []*ldap.Entry{
		dirUser("uid=alice,ou=people,dc=example", "alice", "Alice", "alice@example.com"),
		dirUser("uid=bob,ou=people,dc=example", "bob", "Bob", "bob@example.com"),
		dirUser("uid=carol,ou=people,dc=example", "carol", "Carol", "carol@example.com"),
	}}
	if res, err = SyncDirectoryRun(db, p); err != nil {
		t.Fatal(err)
	} else if res.SkippedDisabled != 1 {
		t.Fatalf("skipped_disabled = %d, want 1(bob 回到目录但账号已停用)", res.SkippedDisabled)
	}
	bob, _ = serverstore.GetUserByUsername(db, "bob")
	if bob.Status != 0 {
		t.Fatal("目录同步把因离职停用的账号自动复活了(需要管理员显式启用)")
	}
}

// 目录同步自己停用账号时也要写审计（此前 dirsync 全文零 AuditLog：
// "账号在企业里已经不存在了"这种自动化收紧动作必须可追溯）。
func TestDirectorySyncDisableWritesAudit(t *testing.T) {
	db := mustDB(t)
	p, f := fakeDir(t)
	if _, err := SyncDirectoryRun(db, p); err != nil {
		t.Fatal(err)
	}
	f.searchResults["(uid=*)"] = &ldap.SearchResult{Entries: []*ldap.Entry{
		dirUser("uid=alice,ou=people,dc=example", "alice", "Alice", "alice@example.com"),
		dirUser("uid=carol,ou=people,dc=example", "carol", "Carol", "carol@example.com"),
	}}
	res, err := SyncDirectoryRun(db, p)
	if err != nil {
		t.Fatal(err)
	}
	if res.Deact != 1 {
		t.Fatalf("deactivated = %d, want 1", res.Deact)
	}
	rows, _, err := serverstore.ListAuditLogsPagedFiltered(db, 0, 50, "directory_user_disabled", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || !strings.Contains(rows[0].Detail, "bob") {
		t.Fatalf("缺少 directory_user_disabled 审计(且需点名 bob): %+v", rows)
	}
	if rows[0].Username != dirSyncAuditActor {
		t.Fatalf("审计 actor = %q, want %q", rows[0].Username, dirSyncAuditActor)
	}
}
