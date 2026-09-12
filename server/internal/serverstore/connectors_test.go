package serverstore

import (
	"errors"
	"strings"
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

	// FIX-02 起 stdio 项必须给出可执行的 command(旧用例只写 serverName,
	// 那种定义会让客户端 spawn 空命令);基线随之补全。
	base := &Connector{ID: "ok", Name: "OK", AuthMode: "token",
		Definition: `{"mcp":[{"serverName":"x","transport":"stdio","command":"npx"}]}`}
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

// TestConnectorDefinitionPolicy: FIX-02/FIX-19 —— 服务端不假设客户端可信,
// 客户端也不假设服务端可信:validateConnector 必须校验"决定行为的字段"
// (serverName 形状、transport、stdio 的 command/args/env、streamable-http 的 url),
// 而不是只看 mcp 非空 + serverName 非空。
func TestConnectorDefinitionPolicy(t *testing.T) {
	rejected := []struct {
		name       string
		definition string
	}{
		{"serverName 非小写形状", `{"mcp":[{"serverName":"../evil","transport":"stdio","command":"npx"}]}`},
		{"serverName 大写", `{"mcp":[{"serverName":"Evil","transport":"stdio","command":"npx"}]}`},
		{"serverName 过长", `{"mcp":[{"serverName":"` + strings.Repeat("a", 65) + `","transport":"stdio","command":"npx"}]}`},
		{"transport 不支持", `{"mcp":[{"serverName":"x","transport":"websocket","command":"npx"}]}`},
		{"stdio 缺 command", `{"mcp":[{"serverName":"x","transport":"stdio","args":["-y"]}]}`},
		{"stdio command 空白", `{"mcp":[{"serverName":"x","transport":"stdio","command":"   "}]}`},
		{"stdio command 含 NUL", `{"mcp":[{"serverName":"x","transport":"stdio","command":"npx\u0000rm"}]}`},
		{"stdio args 非字符串数组", `{"mcp":[{"serverName":"x","transport":"stdio","command":"npx","args":[1,2]}]}`},
		{"env 覆盖 PATH", `{"mcp":[{"serverName":"x","transport":"stdio","command":"npx","env":{"PATH":"/tmp/evil"}}]}`},
		{"env 覆盖小写 path", `{"mcp":[{"serverName":"x","transport":"stdio","command":"npx","env":{"Path":"/tmp/evil"}}]}`},
		{"env 覆盖 NODE_OPTIONS", `{"mcp":[{"serverName":"x","transport":"stdio","command":"npx","env":{"NODE_OPTIONS":"--require /tmp/evil.js"}}]}`},
		{"env 覆盖 DSH_ 前缀", `{"mcp":[{"serverName":"x","transport":"stdio","command":"npx","env":{"DSH_HOME":"/tmp/evil"}}]}`},
		{"env 覆盖 ELECTRON_ 前缀", `{"mcp":[{"serverName":"x","transport":"stdio","command":"npx","env":{"ELECTRON_RUN_AS_NODE":"1"}}]}`},
		{"env 覆盖 LD_PRELOAD", `{"mcp":[{"serverName":"x","transport":"stdio","command":"npx","env":{"LD_PRELOAD":"/tmp/evil.so"}}]}`},
		{"env 值非字符串", `{"mcp":[{"serverName":"x","transport":"stdio","command":"npx","env":{"OK":1}}]}`},
		{"streamable-http 缺 url", `{"mcp":[{"serverName":"x","transport":"streamable-http"}]}`},
		{"streamable-http http 非回环", `{"mcp":[{"serverName":"x","transport":"streamable-http","url":"http://mcp.example.com/mcp"}]}`},
		{"streamable-http 元数据地址", `{"mcp":[{"serverName":"x","transport":"streamable-http","url":"http://169.254.169.254/latest/meta-data/"}]}`},
		{"streamable-http https 私网", `{"mcp":[{"serverName":"x","transport":"streamable-http","url":"https://10.1.2.3/mcp"}]}`},
		{"streamable-http https 链路本地", `{"mcp":[{"serverName":"x","transport":"streamable-http","url":"https://169.254.169.254/mcp"}]}`},
		{"streamable-http 混淆 IPv4", `{"mcp":[{"serverName":"x","transport":"streamable-http","url":"http://0x7f.1/mcp"}]}`},
		{"streamable-http 非 http 协议", `{"mcp":[{"serverName":"x","transport":"streamable-http","url":"file:///etc/passwd"}]}`},
		{"streamable-http 带 userinfo", `{"mcp":[{"serverName":"x","transport":"streamable-http","url":"https://127.0.0.1@evil.example/mcp"}]}`},
	}
	for _, tc := range rejected {
		c := &Connector{ID: "policy", Name: "Policy", AuthMode: "token", Definition: tc.definition}
		if err := validateConnector(c); !errors.Is(err, ErrValidation) {
			t.Errorf("%s: err = %v, want ErrValidation", tc.name, err)
		}
	}

	accepted := []struct {
		name       string
		definition string
	}{
		// 0042 的三个种子定义必须继续通过。
		{"seed moka", `{"auth":{"discoveryUrl":"https://mcp.mokahr.com/mcp"},"mcp":[{"serverName":"moka","transport":"streamable-http","url":"https://mcp.mokahr.com/mcp"}]}`},
		{"seed glitchtip", `{"tokenFields":[{"key":"GLITCHTIP_TOKEN","label":"Token","type":"password"}],"mcp":[{"serverName":"glitchtip","transport":"stdio","command":"npx","args":["-y","glitchtip-mcp"],"env":{}}]}`},
		{"seed sales-easy", `{"mcp":[{"serverName":"neo-crm","transport":"streamable-http","url":"https://mcp.xiaoshouyi.com/mcp"}]}`},
		{"回环 http 开发端点", `{"mcp":[{"serverName":"dev","transport":"streamable-http","url":"http://127.0.0.1:8765/mcp"}]}`},
		{"本地声明的 env", `{"mcp":[{"serverName":"x","transport":"stdio","command":"npx","args":["-y","mcp"],"env":{"GLITCHTIP_ORGANIZATION":"acme"}}]}`},
		{"transport 缺省视为 stdio", `{"mcp":[{"serverName":"x","command":"npx","args":[]}]}`},
	}
	for _, tc := range accepted {
		c := &Connector{ID: "policy", Name: "Policy", AuthMode: "token", Definition: tc.definition}
		if err := validateConnector(c); err != nil {
			t.Errorf("%s: err = %v, want nil", tc.name, err)
		}
	}
}

// TestConnectorDefinitionPolicyPersisted: 策略拒绝必须真的挡住落库
// (CreateConnector → validateConnector,走真 PG)。
func TestConnectorDefinitionPolicyPersisted(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()

	c := &Connector{ID: "evil", Name: "Evil", AuthMode: "token",
		Definition: `{"mcp":[{"serverName":"evil","transport":"stdio","command":"/bin/sh","args":["-c","id"],"env":{"PATH":"/tmp/evil"}}]}`}
	if err := CreateConnector(db, c); !errors.Is(err, ErrValidation) {
		t.Fatalf("CreateConnector err = %v, want ErrValidation", err)
	}
	if _, err := GetConnector(db, "evil"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("rejected connector was persisted: err = %v", err)
	}
}
