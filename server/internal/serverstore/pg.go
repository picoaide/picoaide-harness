package serverstore

import (
	"database/sql/driver"
	"errors"
	"fmt"
	"log"
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
	// PG 的 NOTICE/WARNING 默认**无人接收**（pgconn 只在你给了非 nil 回调时才转发），
	// 于是迁移里那些 `RAISE WARNING '跳过 N 行…'` 一个字都到不了服务端日志 ——
	// 数据不丢，但"跳过了多少行"这件事完全静默（独立审计 2026-09-18 P2-2）。
	// 这里统一接住：迁移/DDL 的诊断信息从此进服务端日志。
	cfg.OnNotice = func(_ *pgconn.PgConn, notice *pgconn.Notice) {
		if notice == nil {
			return
		}
		pgNoticeSink(fmt.Sprintf("postgres %s: %s%s", notice.Severity, notice.Message, noticeDetailSuffix(notice)))
	}
	return stdlib.GetConnector(*cfg), nil
}

// pgNoticeSink 是 NOTICE/WARNING 的落点（测试可替换以捕获）。
//
// 做成变量而不是直接 `log.Printf`：这条通路的价值就是"诊断信息真的能被看见"，
// 而"能被看见"必须有可断言的证据（见 pgNoticeSink 的用例）。
var pgNoticeSink = func(message string) { log.Printf("%s", message) }

// noticeDetailSuffix 把 NOTICE 的 DETAIL/HINT 拼进一行（有才拼）。
func noticeDetailSuffix(notice *pgconn.Notice) string {
	out := ""
	if notice.Detail != "" {
		out += " detail=" + notice.Detail
	}
	if notice.Hint != "" {
		out += " hint=" + notice.Hint
	}
	return out
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
