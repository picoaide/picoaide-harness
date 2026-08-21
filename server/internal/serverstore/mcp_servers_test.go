package serverstore

import (
	"testing"
)

func TestMCPServers(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}

	id, err := AddMCPServer(db, &MCPServer{
		Name: "files", Description: "files mcp",
		Transport: "stdio", Command: "node", Args: []string{"server.js"},
		Env:     map[string]string{"TOKEN": "enc:v1:abc"},
		Headers: map[string]string{"Authorization": "Bearer x"},
		Enabled: 1,
	})
	if err != nil || id == 0 {
		t.Fatalf("AddMCPServer: id=%d err=%v", id, err)
	}
	// 审计 A5-M9(0026): name 唯一约束,同名插入返回 ErrDuplicate
	if _, err := AddMCPServer(db, &MCPServer{Name: "files", Transport: "stdio", Enabled: 0}); err != ErrDuplicate {
		t.Fatalf("duplicate name err = %v, want ErrDuplicate", err)
	}
	if _, err := AddMCPServer(db, &MCPServer{Name: "hidden", Transport: "stdio", Enabled: 0}); err != nil {
		t.Fatalf("distinct name insert: %v", err)
	}

	m, err := GetMCPServer(db, id)
	if err != nil {
		t.Fatal(err)
	}
	if m.Name != "files" || m.Transport != "stdio" || len(m.Args) != 1 || m.Args[0] != "server.js" ||
		m.Env["TOKEN"] != "enc:v1:abc" || m.Headers["Authorization"] != "Bearer x" || m.Enabled != 1 {
		t.Fatalf("GetMCPServer = %+v", m)
	}

	m.Description = "updated"
	m.Enabled = 0
	if err := UpdateMCPServer(db, m); err != nil {
		t.Fatal(err)
	}
	m, _ = GetMCPServer(db, id)
	if m.Description != "updated" || m.Enabled != 0 {
		t.Fatalf("after update = %+v", m)
	}

	// re-enable so list checks are meaningful
	m.Enabled = 1
	_ = UpdateMCPServer(db, m)
	list, err := ListMCPServers(db, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ID != id {
		t.Fatalf("enabled list = %+v", list)
	}
	all, err := ListMCPServers(db, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 {
		t.Fatalf("all list = %+v", all)
	}
}
