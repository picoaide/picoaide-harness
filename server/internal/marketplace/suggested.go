package marketplace

import (
	"database/sql"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// MCPItem is one entry of the client-visible MCP suggestion list (masked).
type MCPItem struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Recommended bool   `json:"recommended"`
}

// SuggestedMCP returns the enabled MCP servers as masked suggestions,
// reusing the marketplace list logic (no direct table reads by callers).
// SuggestedMCP returns all enabled MCP servers as suggestions (admin view).
func SuggestedMCP(db *sql.DB) ([]MCPItem, error) {
	return SuggestedMCPForUser(db, "", nil, true)
}

// SuggestedMCPForUser returns enabled MCP servers the user may use: admins
// see everything, everyone else only granted servers (strict default).
func SuggestedMCPForUser(db *sql.DB, username string, groups []string, isAdmin bool) ([]MCPItem, error) {
	list, err := serverstore.ListMCPServers(db, true)
	if err != nil {
		return nil, err
	}
	var allowed map[int64]bool
	if !isAdmin {
		allowed, err = serverstore.AccessibleMCPSet(db, username, groups)
		if err != nil {
			return nil, err
		}
	}
	out := make([]MCPItem, 0, len(list))
	for _, m := range list {
		if !isAdmin && !allowed[m.ID] {
			continue
		}
		out = append(out, MCPItem{ID: m.ID, Name: m.Name, Description: m.Description, Recommended: true})
	}
	return out, nil
}
