package serverstore

import (
	"testing"
	"time"
)

func TestDeptGrouping(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	// 全员组(0018 播种)作为根
	var everyoneID int64
	if err := db.QueryRow(`SELECT id FROM groups WHERE name = ?`, "全员").Scan(&everyoneID); err != nil {
		t.Fatalf("everyone group: %v", err)
	}
	rdID, err := CreateDepartment(db, "研发部", everyoneID, 0, "")
	if err != nil {
		t.Fatal(err)
	}
	fgID, err := CreateDepartment(db, "前研一组", rdID, 0, "")
	if err != nil {
		t.Fatal(err)
	}

	u1, err := CreateUser(db, &User{Username: "dev1", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	u2, err := CreateUser(db, &User{Username: "dev2", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	u3, err := CreateUser(db, &User{Username: "nobody", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	_ = fgID
	if err := SyncUserGroups(db, u1, []string{"研发部"}); err != nil {
		t.Fatal(err)
	}
	if err := SyncUserGroups(db, u2, []string{"前研一组"}); err != nil {
		t.Fatal(err)
	}
	if err := SyncUserGroups(db, u3, []string{}); err != nil {
		t.Fatal(err)
	}

	// 用量:u1 100 tokens, u2 300 tokens, u3 500 tokens
	if _, err := RecordUsage(db, u1, "m1", 100, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := RecordUsage(db, u2, "m1", 300, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := RecordUsage(db, u3, "m1", 500, 0); err != nil {
		t.Fatal(err)
	}

	// 1) DeptUserIDsByName:研发部 = {u1,u2}(子树)
	ids, err := DeptUserIDsByName(db, "研发部")
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 2 {
		t.Fatalf("DeptUserIDsByName(研发部) = %v, want 2 members", ids)
	}
	if _, err := DeptUserIDsByName(db, "不存在的部门"); err != ErrNotFound {
		t.Fatalf("unknown dept: %v, want ErrNotFound", err)
	}

	// 2) 聚合 group=dept:全员 = u1+u2, 研发部 = u1+u2, 前研一组 = u2
	rows, err := UsageAggregateWithLedger(db, time.Now().AddDate(0, 0, -1), time.Now(), "dept")
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]UsageAggregateRow{}
	for _, r := range rows {
		byName[r.Label] = r
	}
	if r, ok := byName["研发部"]; !ok {
		t.Fatalf("missing dept row, got %v", rows)
	} else if r.PromptTokens != 400 {
		t.Fatalf("研发部 tokens = %d, want 400", r.PromptTokens)
	}
	if r, ok := byName["前研一组"]; !ok {
		t.Fatalf("missing child dept row")
	} else if r.PromptTokens != 300 {
		t.Fatalf("前研一组 tokens = %d, want 300", r.PromptTokens)
	}
	if r, ok := byName["全员"]; !ok {
		t.Fatalf("missing everyone row")
	} else if r.PromptTokens != 400 {
		t.Fatalf("全员 tokens = %d, want 400 (u3 无归属不计)", r.PromptTokens)
	}
	if _, ok := byName["nobody"]; ok {
		t.Fatalf("user row leaked into dept view")
	}

	// 3) WithDept 过滤 + 模型分组:研发部 → m1 只含 u1+u2
	mrows, err := UsageAggregateWithLedger(db, time.Now().AddDate(0, 0, -1), time.Now(), "model", WithDept("研发部"))
	if err != nil {
		t.Fatal(err)
	}
	if len(mrows) != 1 || mrows[0].PromptTokens != 400 || mrows[0].Requests != 2 {
		t.Fatalf("WithDept model rows = %+v, want m1 400 tokens 2 req", mrows)
	}

	// 4) WithDept + group=user
	urows, err := UsageAggregateWithLedger(db, time.Now().AddDate(0, 0, -1), time.Now(), "user", WithDept("前研一组"))
	if err != nil {
		t.Fatal(err)
	}
	if len(urows) != 1 || urows[0].Label != "dev2" || urows[0].PromptTokens != 300 {
		t.Fatalf("WithDept(user) rows = %+v, want dev2 only", urows)
	}

	// 5) 部门不存在 → 空结果(不 500)
	empty, err := UsageAggregateWithLedger(db, time.Now().AddDate(0, 0, -1), time.Now(), "user", WithDept("幽灵部门"))
	if err != nil || len(empty) != 0 {
		t.Fatalf("unknown dept: %v %v, want empty", empty, err)
	}
}
