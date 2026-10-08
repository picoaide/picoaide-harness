package serverstore

import (
	"errors"
	"os"
	"regexp"
	"strings"
	"testing"
)

// 标准 MCP 配置（mcpServers）→ 规范 ConnectorDef 的归一化判据。
//
// 期望值写成**逐字节**的规范 JSON：encoding/json 序列化 map 时按键排序，
// 所以"同样的输入 → 同样的字节"是可以钉死的不变量（否则同一份配置每次保存
// 都产生一份新 definition，diff/审计都失去意义）。

func TestNormalizeConnectorDefinitionStandardShape(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "标准形状（带 mcpServers 包装）",
			input: `{"mcpServers":{"neo-crm":{"type":"streamableHttp","url":"https://mcp.example.com/mcp"}}}`,
			want:  `{"mcp":[{"serverName":"neo-crm","transport":"streamable-http","url":"https://mcp.example.com/mcp"}]}`,
		},
		{
			name:  "裸映射（省掉 mcpServers 包装）",
			input: `{"neo-crm":{"type":"streamableHttp","url":"https://mcp.example.com/mcp"}}`,
			want:  `{"mcp":[{"serverName":"neo-crm","transport":"streamable-http","url":"https://mcp.example.com/mcp"}]}`,
		},
		{
			name:  "省略 type（有 url 即远程）",
			input: `{"mcpServers":{"neo-crm":{"url":"https://mcp.example.com/mcp"}}}`,
			want:  `{"mcp":[{"serverName":"neo-crm","transport":"streamable-http","url":"https://mcp.example.com/mcp"}]}`,
		},
		{
			name:  "type 别名 http",
			input: `{"mcpServers":{"neo-crm":{"type":"http","url":"https://mcp.example.com/mcp"}}}`,
			want:  `{"mcp":[{"serverName":"neo-crm","transport":"streamable-http","url":"https://mcp.example.com/mcp"}]}`,
		},
		{
			name:  "stdio 形态（command/args/env）",
			input: `{"mcpServers":{"local-tools":{"command":"npx","args":["-y","foo-mcp"],"env":{"FOO":"bar"}}}}`,
			want:  `{"mcp":[{"args":["-y","foo-mcp"],"command":"npx","env":{"FOO":"bar"},"serverName":"local-tools","transport":"stdio"}]}`,
		},
		{
			name:  "静态请求头原样保留",
			input: `{"mcpServers":{"neo-crm":{"type":"streamableHttp","url":"https://mcp.example.com/mcp","headers":{"X-Key":"abc"}}}}`,
			want:  `{"mcp":[{"headers":{"X-Key":"abc"},"serverName":"neo-crm","transport":"streamable-http","url":"https://mcp.example.com/mcp"}]}`,
		},
		{
			name:  "多个 server 按键排序",
			input: `{"mcpServers":{"b-tools":{"url":"https://b.example.com/mcp"},"a-tools":{"url":"https://a.example.com/mcp"}}}`,
			want:  `{"mcp":[{"serverName":"a-tools","transport":"streamable-http","url":"https://a.example.com/mcp"},{"serverName":"b-tools","transport":"streamable-http","url":"https://b.example.com/mcp"}]}`,
		},
		{
			name:  "我们的可选键（examples/tokenFields）与标准形状共存",
			input: `{"mcpServers":{"neo-crm":{"url":"https://mcp.example.com/mcp"}},"examples":["查商机"],"tokenFields":[{"key":"K","label":"Key","type":"password","required":true}]}`,
			want:  `{"examples":["查商机"],"mcp":[{"serverName":"neo-crm","transport":"streamable-http","url":"https://mcp.example.com/mcp"}],"tokenFields":[{"key":"K","label":"Key","required":true,"type":"password"}]}`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, declared, err := normalizeConnectorDefinition(tc.input)
			if err != nil {
				t.Fatalf("normalize(%s) = %v", tc.input, err)
			}
			if got != tc.want {
				t.Fatalf("normalize(%s)\n got = %s\nwant = %s", tc.input, got, tc.want)
			}
			if declared != "" {
				t.Fatalf("declared authMode = %q, want empty", declared)
			}
			// 幂等：归一化的产物再归一化必须一字不变（同一份配置反复保存不漂移）。
			again, _, err := normalizeConnectorDefinition(got)
			if err != nil || again != got {
				t.Fatalf("normalize is not idempotent: %s (%v)", again, err)
			}
		})
	}
}

// 已经是规范形状的定义必须**原样**返回：既有行不该因为一次无关编辑被重排。
func TestNormalizeConnectorDefinitionKeepsCanonicalBytes(t *testing.T) {
	canonical := `{"authMode":"oauth","examples":["x"],  "mcp":[{"serverName":"neo-crm","transport":"streamable-http","url":"https://mcp.example.com/mcp"}]}`
	got, declared, err := normalizeConnectorDefinition(canonical)
	if err != nil {
		t.Fatalf("normalize canonical: %v", err)
	}
	if got != canonical {
		t.Fatalf("canonical definition was rewritten:\n got = %s\nwant = %s", got, canonical)
	}
	if declared != "oauth" {
		t.Fatalf("declared authMode = %q, want oauth", declared)
	}
}

func TestNormalizeConnectorDefinitionRejects(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string // 报错里必须出现的片段（可行动文案）
	}{
		{
			name:  "sse 传输不支持（不静默降级）",
			input: `{"mcpServers":{"neo-crm":{"type":"sse","url":"https://mcp.example.com/sse"}}}`,
			want:  "sse",
		},
		{
			name:  "未登记的键（少写一个 s 的 header 不会被静默丢掉）",
			input: `{"mcpServers":{"neo-crm":{"url":"https://mcp.example.com/mcp","header":{"X-Key":"abc"}}}}`,
			want:  "header",
		},
		{
			name:  "serverName 形状不合法",
			input: `{"mcpServers":{"NeoCrm":{"url":"https://mcp.example.com/mcp"}}}`,
			want:  "NeoCrm",
		},
		{
			name:  "既没有 url 也没有 command",
			input: `{"mcpServers":{"neo-crm":{"type":"streamableHttp"}}}`,
			want:  "url",
		},
		{
			name:  "url 与 command 同时给（传输无法判断）",
			input: `{"mcpServers":{"neo-crm":{"url":"https://mcp.example.com/mcp","command":"npx"}}}`,
			want:  "command",
		},
		{
			name:  "声明 stdio 却给了 url",
			input: `{"mcpServers":{"neo-crm":{"type":"stdio","command":"npx","url":"https://mcp.example.com/mcp"}}}`,
			want:  "url",
		},
		{
			name:  "mcpServers 不是对象",
			input: `{"mcpServers":[{"url":"https://mcp.example.com/mcp"}]}`,
			want:  "mcpServers",
		},
		{
			name:  "mcp 存在但不是数组",
			input: `{"mcp":{"serverName":"neo-crm"}}`,
			want:  "mcp",
		},
		{
			name:  "空对象",
			input: `{}`,
			want:  "MCP server",
		},
		{
			name:  "非法 JSON",
			input: `{`,
			want:  "无法解析",
		},
		{
			name:  "没有 mcp 也没有 mcpServers（只有我们的顶层键）",
			input: `{"authMode":"oauth","auth":{"discoveryUrl":"https://mcp.example.com/mcp"}}`,
			want:  "authMode",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, _, err := normalizeConnectorDefinition(tc.input)
			if !errors.Is(err, ErrValidation) {
				t.Fatalf("err = %v, want ErrValidation", err)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %q, want it to mention %q", err.Error(), tc.want)
			}
		})
	}
}

// 归一化只做形状翻译：受保护的 env 键仍由 validateConnector（既有 denylist）拦。
func TestNormalizeConnectorRejectsDeniedEnvThroughValidation(t *testing.T) {
	c := &Connector{
		ID: "local-tools", Name: "本地工具",
		Definition: `{"mcpServers":{"local-tools":{"command":"npx","args":["-y","foo-mcp"],"env":{"NODE_OPTIONS":"--require /tmp/evil.js"}}}}`,
	}
	if err := normalizeConnector(c); err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if err := validateConnector(c); !errors.Is(err, ErrValidation) {
		t.Fatalf("validate = %v, want ErrValidation for a denied env key", err)
	}
}

// auth_mode 与定义里的 authMode 必须自洽：行字段优先（与客户端
// parseServerConnectors 的 `auth_mode || authMode` 同序），两者都没有 → auto。
func TestNormalizeConnectorAuthModePrecedence(t *testing.T) {
	cases := []struct {
		name     string
		mode     string
		def      string
		wantMode string
		wantIn   string
	}{
		{
			name: "行字段优先并写回定义", mode: "token",
			def:      `{"mcpServers":{"neo-crm":{"url":"https://mcp.example.com/mcp"}},"authMode":"oauth"}`,
			wantMode: "token", wantIn: `"authMode":"token"`,
		},
		{
			name: "行字段为空时取定义声明", mode: "",
			def:      `{"mcpServers":{"neo-crm":{"url":"https://mcp.example.com/mcp"}},"authMode":"oauth"}`,
			wantMode: "oauth", wantIn: `"authMode":"oauth"`,
		},
		{
			name: "都没声明 → auto", mode: "",
			def:      `{"mcpServers":{"neo-crm":{"url":"https://mcp.example.com/mcp"}}}`,
			wantMode: "auto", wantIn: `"authMode":"auto"`,
		},
		{
			name: "规范形状也被写回 authMode", mode: "auto",
			def:      `{"mcp":[{"serverName":"neo-crm","transport":"streamable-http","url":"https://mcp.example.com/mcp"}]}`,
			wantMode: "auto", wantIn: `"authMode":"auto"`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := &Connector{ID: "neo-crm", Name: "NeoCRM", AuthMode: tc.mode, Definition: tc.def}
			if err := normalizeConnector(c); err != nil {
				t.Fatalf("normalize: %v", err)
			}
			if c.AuthMode != tc.wantMode {
				t.Fatalf("auth_mode = %q, want %q", c.AuthMode, tc.wantMode)
			}
			if !strings.Contains(c.Definition, tc.wantIn) {
				t.Fatalf("definition = %s, want it to contain %s", c.Definition, tc.wantIn)
			}
			if err := validateConnector(c); err != nil {
				t.Fatalf("validate after normalize: %v", err)
			}
		})
	}
}

// 接线判据（"有能力没接线"是本仓反复出现的缺陷形态）：写入路径必须真的归一，
// 不能只有 normalizeConnector 这一个可测函数。
func TestCreateAndUpdateConnectorNormalizeStandardShape(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()

	created := &Connector{
		ID: "neo-crm", Name: "销售易", Description: "官方 MCP",
		Definition: `{"mcpServers":{"neo-crm":{"type":"streamableHttp","url":"https://mcp.example.com/mcp"}}}`,
		Enabled:    true,
	}
	if err := CreateConnector(db, created); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := GetConnector(db, "neo-crm")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	want := `{"authMode":"auto","mcp":[{"serverName":"neo-crm","transport":"streamable-http","url":"https://mcp.example.com/mcp"}]}`
	if got.Definition != want {
		t.Fatalf("stored definition = %s, want %s", got.Definition, want)
	}
	if got.AuthMode != "auto" {
		t.Fatalf("stored auth_mode = %q, want auto", got.AuthMode)
	}

	// 更新路径同样归一（管理员把标准配置贴回编辑框再保存）。
	got.Definition = `{"mcpServers":{"neo-crm":{"url":"https://mcp.example.com/v2/mcp"}}}`
	got.AuthMode = ""
	if err := UpdateConnector(db, got); err != nil {
		t.Fatalf("update: %v", err)
	}
	got2, err := GetConnector(db, "neo-crm")
	if err != nil {
		t.Fatalf("get after update: %v", err)
	}
	if !strings.Contains(got2.Definition, `"url":"https://mcp.example.com/v2/mcp"`) ||
		!strings.Contains(got2.Definition, `"transport":"streamable-http"`) {
		t.Fatalf("updated definition = %s", got2.Definition)
	}
	if got2.AuthMode != "auto" {
		t.Fatalf("updated auth_mode = %q, want auto", got2.AuthMode)
	}
}

// 0084：默认第三方 MCP 连接器改为「端点自述授权」，且只改没被动过的行。
//
// 两条判据各自有牙：① 种子行确实被改写（否则默认连接器仍是手写端点，RFC 8707 的
// resource 依旧缺失）；② 管理员改过的行再跑一次迁移**一个字都不动**（否则升级会
// 覆盖客户自己的端点/请求头）。
func TestMigration0084RewritesOnlyUntouchedSeed(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()

	seeded, err := GetConnector(db, "sales-easy")
	if err != nil {
		t.Fatalf("get seed: %v", err)
	}
	if seeded.AuthMode != "oauth" {
		t.Fatalf("seed auth_mode = %q, want oauth（旧客户端也认这条形状）", seeded.AuthMode)
	}
	if !strings.Contains(seeded.Definition, `"discoveryUrl":"https://mcp.xiaoshouyi.com/mcp"`) {
		t.Fatalf("seed definition 未改为端点自述：%s", seeded.Definition)
	}
	if strings.Contains(seeded.Definition, "oauth/authorize") {
		t.Fatalf("seed definition 仍带手写端点：%s", seeded.Definition)
	}
	if err := validateConnector(seeded); err != nil {
		t.Fatalf("改写后的种子行未过校验：%v", err)
	}

	// 管理员改过的行：迁移必须放手（定义与示例提示词都可能被改过）。
	edited := `{"examples":["只查我负责的客户"],"mcp":[{"serverName":"neo-crm","transport":"streamable-http","url":"https://mcp.example.com/mcp"}]}`
	if _, err := db.Exec(`UPDATE connectors SET definition = ? WHERE id = 'sales-easy'`, edited); err != nil {
		t.Fatalf("edit: %v", err)
	}
	sql, err := os.ReadFile("migrations-pg/0084_sales_easy_endpoint_discovery.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	if _, err := db.Exec(string(sql)); err != nil {
		t.Fatalf("re-apply migration: %v", err)
	}
	after, err := GetConnector(db, "sales-easy")
	if err != nil {
		t.Fatalf("get after re-apply: %v", err)
	}
	if after.Definition != edited {
		t.Fatalf("迁移覆盖了管理员改过的行：%s", after.Definition)
	}

	// 正控：把 0042 的原文放回去再跑一次，必须**又**被改写 —— 否则上面那条
	// "没被动过就改写" 的判据在迁移的 UPDATE 被掏空时同样会绿（本仓登记过的假绿形态）。
	original := seedSalesEasyDefinition(t)
	if _, err := db.Exec(`UPDATE connectors SET definition = ? WHERE id = 'sales-easy'`, original); err != nil {
		t.Fatalf("restore original: %v", err)
	}
	if _, err := db.Exec(string(sql)); err != nil {
		t.Fatalf("re-apply migration on original: %v", err)
	}
	restored, err := GetConnector(db, "sales-easy")
	if err != nil {
		t.Fatalf("get after restore: %v", err)
	}
	if restored.Definition == original || !strings.Contains(restored.Definition, `"discoveryUrl"`) {
		t.Fatalf("迁移对未改动的原文没有生效（判据失去牙）：%s", restored.Definition)
	}
}

// seedSalesEasyDefinition 从 0042 迁移文件里取出 sales-easy 的定义原文 —— 迁移文件
// 自己就是唯一真源。测试里再抄一份的话，文件一改（或形状一变）两边就漂移，而 0084 的
// "没被动过" 判据会静默失效。
func seedSalesEasyDefinition(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile("migrations-pg/0042_connectors.sql")
	if err != nil {
		t.Fatalf("read 0042: %v", err)
	}
	match := regexp.MustCompile(`(?s)\('sales-easy'.*?\n\s*'oauth',\n\s*'(\{.*?\})'\)`).FindSubmatch(raw)
	if match == nil {
		t.Fatal("0042 里找不到 sales-easy 种子定义（形状变了，本判据要跟着改）")
	}
	return string(match[1])
}
