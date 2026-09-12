package serverstore

import (
	"database/sql/driver"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
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

// isDuplicateRelationErr 报告 err 是否为 PG 42P07(relation already exists)。
// 并发路径专用:并发 CREATE TABLE IF NOT EXISTS ... PARTITION OF 的存在性
// 检查用语句快照,挡不住"另一会话刚提交同名对象"的竞态(2026-09-12 P1-3)。
func isDuplicateRelationErr(err error) bool {
	if err == nil {
		return false
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "42P07"
	}
	// 兜底:错误被驱动/中间层包装成非 *pgconn.PgError 时,SQLSTATE 文本
	// 通常仍保留在错误串里(与 isUniqueViolation 的既有做法一致)。
	return strings.Contains(err.Error(), "42P07")
}
