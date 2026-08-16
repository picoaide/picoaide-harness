package serverauth

import (
	"database/sql"
	"errors"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// LocalProvider authenticates against the local users table.
type LocalProvider struct {
	db *sql.DB
}

// NewLocalProvider creates the local password provider.
func NewLocalProvider(db *sql.DB) *LocalProvider {
	return &LocalProvider{db: db}
}

func (p *LocalProvider) Name() string { return "local" }

func (p *LocalProvider) Configure(map[string]string) error { return nil }

func (p *LocalProvider) Authenticate(username, password string) (UserInfo, error) {
	u, err := serverstore.AuthenticateLocal(p.db, username, password)
	if err != nil {
		if errors.Is(err, serverstore.ErrNotFound) {
			return UserInfo{}, errors.New("invalid credentials")
		}
		return UserInfo{}, err
	}
	groups, _ := serverstore.UserGroups(p.db, u.ID)
	return UserInfo{Username: u.Username, DisplayName: u.DisplayName, Email: u.Email, Groups: groups, Source: "local"}, nil
}
