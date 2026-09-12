package serverstore

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// Connector 是服务端连接器目录的一行(定义 JSON 与客户端 ConnectorDef 对齐)。
type Connector struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	AuthMode    string `json:"auth_mode"`
	Definition  string `json:"definition"`
	Enabled     bool   `json:"enabled"`
	UpdatedAt   string `json:"updated_at"`
	CreatedAt   string `json:"created_at"`
}

var (
// ErrValidation: 连接器参数不合法(名称/编号/模式/定义 JSON)。
// ErrNotFound: 连接器不存在。
// 均复用 errors.go 的包级错误(避免重复定义)。
)

// connectorIDRe: id 作为路径段/客户端键,限小写字母数字连字符。
var connectorIDRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

// connectorAuthModes 是合法的认证模式(与客户端 ConnectorAuthMode 对齐)。
var connectorAuthModes = map[string]bool{
	"oauth": true, "device": true, "token": true, "server-side": true,
}

func validateConnector(c *Connector) error {
	if !connectorIDRe.MatchString(c.ID) {
		return ErrValidation
	}
	if strings.TrimSpace(c.Name) == "" {
		return ErrValidation
	}
	if !connectorAuthModes[c.AuthMode] {
		return ErrValidation
	}
	if strings.TrimSpace(c.Definition) == "" {
		return ErrValidation
	}
	var probe map[string]any
	if err := json.Unmarshal([]byte(c.Definition), &probe); err != nil {
		return ErrValidation
	}
	// 必填结构:mcp 非空数组;每项必须含 serverName。
	mcp, ok := probe["mcp"].([]any)
	if !ok || len(mcp) == 0 {
		return ErrValidation
	}
	if err := validateConnectorMCP(mcp); err != nil {
		return err
	}
	// tokenFields / settings 的 key 是**同一条注入通道**(客户端
	// buildStdioEnv 会把凭据里 key 命中已声明字段名的值直接写进子进程 env),
	// 必须与 mcp[].env 过同一套 denylist。2026-09-13:此前只校验 env,
	// 一份 {"tokenFields":[{"key":"NODE_OPTIONS"}]} 的定义即可在每台员工
	// 机器上向 MCP 子进程注入引导变量(与客户端 policy.ts 同源缺口)。
	return validateConnectorCredentialFields(probe)
}

// 客户端会拿定义 JSON 直接 spawn 子进程/发起出站请求,所以服务端也必须校验
// "决定行为的字段"(FIX-02:客户端不假设服务端可信)。两侧规则同源:
// 客户端 packages/host/connectors/src/policy.ts 与
// packages/host/connectors/src/outbound.ts。
var (
	// connectorServerNameRe: MCP serverName 是客户端工具命名空间的一部分
	// (mcp__<serverName>__<tool>),限小写字母数字连字符。
	connectorServerNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
	// connectorDeniedEnvKeys: 进程引导/加载器钩子与代理键,连接器定义不得覆盖。
	connectorDeniedEnvKeys = map[string]bool{
		"PATH": true, "NODE_OPTIONS": true, "NODE_PATH": true,
		"LD_PRELOAD": true, "LD_LIBRARY_PATH": true, "LD_AUDIT": true,
		"PYTHONPATH": true, "PYTHONSTARTUP": true, "BASH_ENV": true,
		"ENV": true, "SHELL": true, "COMSPEC": true,
		"HTTP_PROXY": true, "HTTPS_PROXY": true, "ALL_PROXY": true, "NO_PROXY": true,
		"NODE_TLS_REJECT_UNAUTHORIZED": true, "NODE_EXTRA_CA_CERTS": true,
	}
	// connectorDeniedEnvPrefixes: 产品自有命名空间。
	connectorDeniedEnvPrefixes = []string{"DSH_", "ELECTRON_", "PICOAIDE_"}
	// connectorMetadataHosts: 按名字指向云元数据服务的常见主机名。
	connectorMetadataHosts = map[string]bool{
		"metadata": true, "metadata.google.internal": true, "metadata.goog": true,
		"instance-data": true, "instance-data.ec2.internal": true,
	}
)

// connectorEnvKeyAllowed: 与客户端 isDeniedEnvKey 同规则(Windows 环境变量名
// 大小写不敏感,故统一大写比较;两侧都先 trim,否则 " NODE_OPTIONS " 就是
// 一条绕过路径)。
func connectorEnvKeyAllowed(key string) bool {
	upper := strings.ToUpper(strings.TrimSpace(key))
	if upper == "" {
		return false
	}
	if connectorDeniedEnvKeys[upper] {
		return false
	}
	for _, prefix := range connectorDeniedEnvPrefixes {
		if strings.HasPrefix(upper, prefix) {
			return false
		}
	}
	return true
}

// connectorCredentialFieldLists 是凭据字段声明的两个容器(客户端
// declaredCredentialKeys 读取的正是这两个列表)。
var connectorCredentialFieldLists = []string{"tokenFields", "settings"}

// validateConnectorCredentialFields 校验 tokenFields[] / settings[] 的元素形状,
// 并拒绝任何 key 命中受保护环境键(denylist 与客户端 policy.ts 的
// DENIED_ENV_KEYS + DSH_/ELECTRON_/PICOAIDE_ 前缀逐条对齐,由
// TestConnectorDeniedEnvKeysMatchClientPolicy 守卫防漂移)。
//
// 为什么必须在这里拦:客户端把"定义里声明过的字段名"当成可信白名单
// (declaredCredentialKeys → buildStdioEnv 的 env[key] = value),所以声明
// NODE_OPTIONS / LD_PRELOAD / DSH_* 与直接写 mcp[].env 等价 —— 服务端 schema
// 必须把两条通道一起堵住。
func validateConnectorCredentialFields(probe map[string]any) error {
	for _, list := range connectorCredentialFieldLists {
		raw, present := probe[list]
		if !present {
			continue
		}
		items, ok := raw.([]any)
		if !ok {
			return ErrValidation
		}
		for _, item := range items {
			m, ok := item.(map[string]any)
			if !ok {
				return ErrValidation
			}
			key, ok := m["key"].(string)
			if !ok || !connectorEnvKeyAllowed(key) {
				return ErrValidation
			}
		}
	}
	return nil
}

// connectorURLAllowed: 出站策略的 Go 侧镜像(https,或回环 http;
// 拒绝私网/链路本地/元数据/保留段)。与客户端 assertOutboundUrlAllowed 同规则。
func connectorURLAllowed(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return false
	}
	if parsed.User != nil || parsed.Scheme == "" {
		return false
	}
	isHTTPS := parsed.Scheme == "https"
	isHTTP := parsed.Scheme == "http"
	if !isHTTPS && !isHTTP {
		return false
	}
	host := parsed.Hostname()
	if host == "" {
		return false
	}
	// FQDN 根点归一(2026-09-13 审计 R3):`metadata.google.internal.` / `localhost.`
	// 与不带点的写法解析到同一目标,不归一就能绕过下面的名单;与客户端
	// classifyHost 的 `.replace(/\.$/,'')` 同口径。
	host = strings.TrimSuffix(host, ".")
	if host == "" {
		return false
	}
	if connectorMetadataHosts[strings.ToLower(host)] {
		return false
	}
	loopback := false
	if ip := net.ParseIP(host); ip != nil {
		loopback = ip.IsLoopback()
		if connectorBlockedIP(ip) {
			return false
		}
	} else if isObfuscatedIPv4(host) {
		// url.Parse 不会把 0x7f.1 / 2130706433 / 0177.0.0.1 归一成点分十进制,
		// 这类"看起来是 IP"的主机名一律拒绝(客户端侧 WHATWG URL 会归一)。
		return false
	} else if strings.EqualFold(host, "localhost") || strings.HasSuffix(strings.ToLower(host), ".localhost") {
		loopback = true
	}
	if isHTTP && !loopback {
		return false
	}
	return true
}

// connectorBlockedIP: 非公网字面地址(私网/链路本地/元数据/多播/保留)。
// 回环单独处理:策略允许"回环 http"(本地开发),故这里不拦回环。
func connectorBlockedIP(ip net.IP) bool {
	if ip.IsLoopback() {
		return false
	}
	return ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified()
}

// isObfuscatedIPv4: 主机名每个标签都是数字(十进制/0x 十六进制/0o 八进制)时,
// 视为伪装的 IPv4 字面量。真正的 DNS 名不会全部由数字标签组成。
func isObfuscatedIPv4(host string) bool {
	labels := strings.Split(host, ".")
	if len(labels) == 0 || len(labels) > 4 {
		return false
	}
	for _, label := range labels {
		if label == "" {
			return false
		}
		if _, err := strconv.ParseUint(label, 0, 64); err != nil {
			return false
		}
	}
	return true
}

// validateConnectorMCP: 逐项校验 mcp[](形状 + 出站策略)。任一项不合规即整体拒绝。
func validateConnectorMCP(mcp []any) error {
	for _, item := range mcp {
		m, ok := item.(map[string]any)
		if !ok {
			return ErrValidation
		}
		name, _ := m["serverName"].(string)
		if !connectorServerNameRe.MatchString(name) {
			return ErrValidation
		}
		transport := "stdio"
		if raw, present := m["transport"]; present {
			value, ok := raw.(string)
			if !ok || (value != "stdio" && value != "streamable-http") {
				return ErrValidation
			}
			transport = value
		}
		if transport == "streamable-http" {
			target, _ := m["url"].(string)
			if !connectorURLAllowed(target) {
				return ErrValidation
			}
		} else {
			if err := validateStdioServer(m); err != nil {
				return err
			}
		}
		if raw, present := m["headers"]; present {
			headers, ok := raw.(map[string]any)
			if !ok {
				return ErrValidation
			}
			for _, value := range headers {
				if _, ok := value.(string); !ok {
					return ErrValidation
				}
			}
		}
	}
	return nil
}

// validateStdioServer: stdio 分支必须给出可执行的 command;args/env(若声明)
// 必须是字符串形态,且 env 不得触碰受保护的键。
func validateStdioServer(m map[string]any) error {
	command, _ := m["command"].(string)
	if strings.TrimSpace(command) == "" || strings.ContainsRune(command, 0) {
		return ErrValidation
	}
	if raw, present := m["args"]; present {
		args, ok := raw.([]any)
		if !ok {
			return ErrValidation
		}
		for _, arg := range args {
			if _, ok := arg.(string); !ok {
				return ErrValidation
			}
		}
	}
	if raw, present := m["env"]; present {
		env, ok := raw.(map[string]any)
		if !ok {
			return ErrValidation
		}
		for key, value := range env {
			if !connectorEnvKeyAllowed(key) {
				return ErrValidation
			}
			if _, ok := value.(string); !ok {
				return ErrValidation
			}
		}
	}
	return nil
}

// connectorColumns (无 definition 大字段时列表读;单行读全字段)。
const connectorColumns = `id, name, description, auth_mode, definition, enabled, updated_at, created_at`

func scanConnector(rows interface{ Scan(...any) error }) (*Connector, error) {
	var c Connector
	var enabled int
	var updatedAt, createdAt sql.NullString
	if err := rows.Scan(&c.ID, &c.Name, &c.Description, &c.AuthMode, &c.Definition, &enabled, &updatedAt, &createdAt); err != nil {
		return nil, err
	}
	c.Enabled = enabled != 0
	c.UpdatedAt = updatedAt.String
	c.CreatedAt = createdAt.String
	return &c, nil
}

// ListConnectors returns all connectors (admin, ordered by id).
// Definition 大字段一并返回——管理端编辑需要;客户端下发走
// ListEnabledConnectors(只返回定义 JSON,由 bootstrap 解析)。
func ListConnectors(db *sql.DB) ([]Connector, error) {
	rows, err := db.Query("SELECT " + connectorColumns + " FROM connectors ORDER BY id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Connector
	for rows.Next() {
		c, err := scanConnector(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *c)
	}
	return out, rows.Err()
}

// ListEnabledConnectors returns only enabled connectors (bootstrap/下发),
// 定义 JSON 直接可用,无需二次 DTO。
func ListEnabledConnectors(db *sql.DB) ([]Connector, error) {
	rows, err := db.Query("SELECT " + connectorColumns + " FROM connectors WHERE enabled = 1 ORDER BY id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Connector
	for rows.Next() {
		c, err := scanConnector(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *c)
	}
	return out, rows.Err()
}

// GetConnector returns one connector row by id.
func GetConnector(db *sql.DB, id string) (*Connector, error) {
	row := db.QueryRow("SELECT "+connectorColumns+" FROM connectors WHERE id = ?", id)
	c, err := scanConnector(row)
	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return c, nil
}

// CreateConnector inserts a new connector row (id conflict → ErrDuplicate)。
func CreateConnector(db *sql.DB, c *Connector) error {
	if err := validateConnector(c); err != nil {
		return err
	}
	// PG 兼容:先查存在性再插入(单用户管理端,无并发竞争)。
	if existing, err := GetConnector(db, c.ID); err == nil && existing != nil {
		return ErrDuplicate
	} else if err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	_, err := db.Exec(`INSERT INTO connectors (id, name, description, auth_mode, definition, enabled)
		VALUES (?, ?, ?, ?, ?, ?)`, c.ID, strings.TrimSpace(c.Name), c.Description, c.AuthMode, c.Definition, boolInt(c.Enabled))
	return err
}

// UpdateConnector updates name/description/auth_mode/definition/enabled.
func UpdateConnector(db *sql.DB, c *Connector) error {
	if err := validateConnector(c); err != nil {
		return err
	}
	res, err := db.Exec(`UPDATE connectors SET name=?, description=?, auth_mode=?, definition=?, enabled=?
		WHERE id=?`, strings.TrimSpace(c.Name), c.Description, c.AuthMode, c.Definition, boolInt(c.Enabled), c.ID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// SetConnectorEnabled toggles the enable flag (bootstrap 下发开关)。
func SetConnectorEnabled(db *sql.DB, id string, enabled bool) error {
	res, err := db.Exec("UPDATE connectors SET enabled = ? WHERE id = ?", boolInt(enabled), id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteConnector removes one connector row (bootstrap 不再下发)。
func DeleteConnector(db *sql.DB, id string) error {
	res, err := db.Exec("DELETE FROM connectors WHERE id = ?", id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}
