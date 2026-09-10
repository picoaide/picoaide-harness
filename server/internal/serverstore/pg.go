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
	// 会话时区固定 Asia/Shanghai(UTC+8,无 DST)。
	// 注意(2026-09-10 时区缺陷修复):**业务日/月窗口不再依赖这个设置** ——
	// 日窗口走 beijing.go 的固定 +8h 与「绝对瞬时」参数,任何会话时区下结果
	// 一致(回归用例 TestUsageDayWindowIndependentOfTimezone)。这里保留是为了
	// 兼容历史 SQL/psql 诊断的一致观感与分区 DDL 的可读性;裸 ?::date 与裸
	// 墙钟字符串参数已从业务路径清除。
	// application_name 便于管理端 pg_stat_activity 识别本服务连接。
	// 连接池由 openPG 配置 SetMaxOpenConns/Idle/Lifetime。
	cfg.RuntimeParams["TimeZone"] = "Asia/Shanghai"
	cfg.RuntimeParams["application_name"] = "picoaide-server"
	return stdlib.GetConnector(*cfg), nil
}
