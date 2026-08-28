package serverstore

import (
	"database/sql"
	"encoding/json"
	"errors"
	"regexp"
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
	for _, item := range mcp {
		m, ok := item.(map[string]any)
		if !ok {
			return ErrValidation
		}
		if name, _ := m["serverName"].(string); strings.TrimSpace(name) == "" {
			return ErrValidation
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
