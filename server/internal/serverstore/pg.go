package serverstore

import (
	"database/sql/driver"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

// newPGConnector parses a PostgreSQL DSN and returns a database/sql driver
// connector backed by pgx.
func newPGConnector(dsn string) (driver.Connector, error) {
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		return nil, err
	}
	// 时区:业务时间均按北京时间(与成本计算/汇总分桶一致,含 DST 免疫)。
	// application_name 便于管理端 pg_stat_activity 识别本服务连接。
	// 连接池由 openPG 配置 SetMaxOpenConns/Idle/Lifetime。
	cfg.RuntimeParams["TimeZone"] = "Asia/Shanghai"
	cfg.RuntimeParams["application_name"] = "picoaide-server"
	return stdlib.GetConnector(*cfg), nil
}
