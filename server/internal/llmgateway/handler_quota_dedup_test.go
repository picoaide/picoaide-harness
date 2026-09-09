package llmgateway

import (
	"database/sql"
	"errors"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// P2-6 回归:每个生效部门预算只查一次部门成员 id(此前步骤 2/步骤 3 各查一次,
// 预算数 N 时 2N 次查询)。计数由 deptMemberIDsFn 注入,断言调用次数 == 预算数。
func TestQuotaBlockedFetchesDeptMembersOnce(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	uid, err := serverstore.CreateUser(db, &serverstore.User{Username: "qb-user", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	// 两个部门各有预算(链上全部生效)→ 期望恰好 2 次成员查询。
	for _, name := range []string{"qb-dept-a", "qb-dept-b"} {
		gid, err := serverstore.GetOrCreateGroup(db, name)
		if err != nil {
			t.Fatal(err)
		}
		if err := serverstore.SetDeptBudget(db, gid, 1000); err != nil {
			t.Fatal(err)
		}
		if err := serverstore.AddUserGroup(db, uid, gid); err != nil {
			t.Fatal(err)
		}
	}
	user, err := serverstore.GetUserByID(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	budgets, err := serverstore.EffectiveDeptBudget(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	if len(budgets) != 2 {
		t.Fatalf("effective budgets = %d, want 2", len(budgets))
	}

	prev := deptMemberIDsFn
	defer func() { deptMemberIDsFn = prev }()
	calls := map[int64]int{}
	deptMemberIDsFn = func(db *sql.DB, groupID int64) ([]int64, error) {
		calls[groupID]++
		return prev(db, groupID)
	}

	api := &API{DB: db}
	blocked, msg := api.quotaBlocked(user)
	if blocked {
		t.Fatalf("quotaBlocked = true (%s), want false (no usage yet)", msg)
	}
	for _, b := range budgets {
		if calls[b.GroupID] != 1 {
			t.Fatalf("DeptMemberIDs(group=%d) called %d times, want 1", b.GroupID, calls[b.GroupID])
		}
	}
	if len(calls) != len(budgets) {
		t.Fatalf("distinct member lookups = %d, want %d", len(calls), len(budgets))
	}
}

// P2-6 语义保持:部门成员查询失败仍 fail-closed(复用同一次查询不得改变语义)。
func TestQuotaBlockedFailsClosedOnDeptMemberError(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	uid, err := serverstore.CreateUser(db, &serverstore.User{Username: "qb-fail", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	gid, err := serverstore.GetOrCreateGroup(db, "qb-dept-fail")
	if err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetDeptBudget(db, gid, 1000); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.AddUserGroup(db, uid, gid); err != nil {
		t.Fatal(err)
	}
	user, err := serverstore.GetUserByID(db, uid)
	if err != nil {
		t.Fatal(err)
	}

	prev := deptMemberIDsFn
	defer func() { deptMemberIDsFn = prev }()
	deptMemberIDsFn = func(db *sql.DB, groupID int64) ([]int64, error) {
		return nil, errors.New("boom")
	}

	api := &API{DB: db}
	blocked, msg := api.quotaBlocked(user)
	if !blocked || msg == "" {
		t.Fatalf("quotaBlocked = (%v,%q), want fail-closed block", blocked, msg)
	}
}
