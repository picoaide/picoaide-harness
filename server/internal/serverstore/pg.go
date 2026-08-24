package serverstore

import (
	"database/sql/driver"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

// newPGConnector parses a PostgreSQL DSN and returns a database/sql driver
// connector backed by pgx. The caller wraps it with rewriteConnector so `?`
// placeholders become $N.
func newPGConnector(dsn string) (driver.Connector, error) {
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		return nil, err
	}
	// default: allow all connections to run the same simple statements the
	// application expects from sqlite; keep extended protocol for params.
	return stdlib.GetConnector(*cfg), nil
}
