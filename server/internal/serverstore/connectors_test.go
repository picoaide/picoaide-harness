package serverstore

import (
	"errors"
	"testing"
)

// TestConnectorCRUD: 0042 连接器目录 CRUD——迁移后种子存在;
// 创建/更新/启用开关/删除走完整生命周期;非法参数拒绝。
func TestConnectorCRUD(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()

	// 种子:迁移 0042 插入 moka + glitchtip。
	list, err := ListConnectors(db)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) < 3 {
		t.Fatalf("seed connectors = %d, want >= 3", len(list))
	}
	ids := map[string]bool{}
	for _, c := range list {
		ids[c.ID] = true
	}
	if !ids["moka"] || !ids["glitchtip"] || !ids["sales-easy"] {
		t.Fatalf("seed missing moka/glitchtip/sales-easy: %v", ids)
	}

	// 创建新连接器。
	nc := &Connector{
		ID: "feishu", Name: "飞书", Description: "协作与文档",
		AuthMode:   "token",
		Definition: `{"tokenFields":[{"key":"TOKEN","label":"Token","type":"password","required":true}],"mcp":[{"serverName":"feishu","transport":"streamable-http","url":"https://mcp.example.com"}]}`,
		Enabled:    true,
	}
	if err := CreateConnector(db, nc); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := GetConnector(db, "feishu")
	if err != nil || got.Name != "飞书" || !got.Enabled || got.Definition == "" {
		t.Fatalf("get = %+v err=%v", got, err)
	}

	// 更新。
	got.Name = "飞书协作"
	got.Description = "更新描述"
	if err := UpdateConnector(db, got); err != nil {
		t.Fatalf("update: %v", err)
	}
	got2, _ := GetConnector(db, "feishu")
	if got2.Name != "飞书协作" {
		t.Fatalf("after update name = %q", got2.Name)
	}

	// 启用开关 → 下发列表过滤。
	if err := SetConnectorEnabled(db, "feishu", false); err != nil {
		t.Fatalf("disable: %v", err)
	}
	enabled, _ := ListEnabledConnectors(db)
	for _, c := range enabled {
		if c.ID == "feishu" {
			t.Fatalf("disabled connector still in enabled list")
		}
	}

	// 删除。
	if err := DeleteConnector(db, "feishu"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := GetConnector(db, "feishu"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("after delete err = %v, want ErrNotFound", err)
	}
}

// TestConnectorValidation: 非法 id/空名/坏 auth_mode/坏定义 JSON/无 MCP/无 serverName 全拒绝。
func TestConnectorValidation(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()

	base := &Connector{ID: "ok", Name: "OK", AuthMode: "token",
		Definition: `{"mcp":[{"serverName":"x"}]}`}
	valid := func() *Connector {
		c := *base
		return &c
	}

	if err := CreateConnector(db, valid()); err != nil {
		t.Fatalf("valid base: %v", err)
	}
	cases := []struct {
		name string
		mut  func(*Connector)
		want error
	}{
		{"bad id", func(c *Connector) { c.ID = "Bad_ID" }, ErrValidation},
		{"empty name", func(c *Connector) { c.Name = "  " }, ErrValidation},
		{"bad mode", func(c *Connector) { c.AuthMode = "cli" }, ErrValidation},
		{"bad json", func(c *Connector) { c.Definition = "{not json" }, ErrValidation},
		{"no mcp", func(c *Connector) { c.Definition = `{"tokenFields":[{"key":"T","label":"T"}]}` }, ErrValidation},
		{"mcp no serverName", func(c *Connector) { c.Definition = `{"mcp":[{"url":"https://x"}]}` }, ErrValidation},
	}
	for _, tc := range cases {
		c := valid()
		c.ID = "case-" + tc.name
		tc.mut(c)
		err := CreateConnector(db, c)
		if !errors.Is(err, tc.want) {
			t.Errorf("%s: err = %v, want %v", tc.name, err, tc.want)
		}
	}
}
