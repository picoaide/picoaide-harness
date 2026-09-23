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

// PG 的 SQLSTATE 码——**唯一字面量落点**（2026-09-23 抽取）。
//
// 此前 5 个判定各自带一份 `errors.As` + 串匹配副本散在 pg.go / partitions.go×2 /
// users.go / wasmapps.go，其中 3 个的注释还互相指认「与 isXxx 同一实现形态」；
// 结果是"新加一种 SQLSTATE 判定"要在 5 个地方各写一遍，而漏掉任一处不会报错。
const (
	// 42P07 relation already exists。
	pgSQLStateDuplicateRelation = "42P07"
	// 42P17 分区边界与既有分区重叠。
	pgSQLStateOverlapPartition = "42P17"
	// 23514 往 DEFAULT 分区加窄分区会让既有行违反分区约束。
	pgSQLStateDefaultPartitionViolated = "23514"
	// 23505 唯一约束冲突。
	pgSQLStateUniqueViolation = "23505"
	// 23503 外键冲突。
	pgSQLStateForeignKeyViolation = "23503"
)

// pgSQLStateCodes 是 pgErrorCode 回落路径会去错误串里找的码集合。
// 新增一种判定时在这里补一行常量与一项，别在各谓词里另写串匹配。
var pgSQLStateCodes = []string{
	pgSQLStateDuplicateRelation,
	pgSQLStateOverlapPartition,
	pgSQLStateDefaultPartitionViolated,
	pgSQLStateUniqueViolation,
	pgSQLStateForeignKeyViolation,
}

// pgErrorCode 抽出 err 携带的 PG SQLSTATE 码，两级判定：
//
//  1. `errors.As` 命中 `*pgconn.PgError` ⇒ 取**结构化** Code（驱动已经把码解析出来）；
//  2. 否则退回错误串里的已知码文本 —— 错误被驱动/中间层包装成非 `*pgconn.PgError`
//     时（如 `fmt.Errorf("建分区: %w", …)` 经非 pgx 层再包装），SQLSTATE 通常仍原样
//     留在串里（`ERROR: … (SQLSTATE 42P07)`）。
//
// 语义与合并前的 5 份副本一致：5 个业务谓词原先都是这两级的子集（3 个是
// `As` 优先 + 单码串匹配，2 个是纯串匹配），现在统一走这里。
// 唯一的形式差异：某条错误串里同时出现**两个**已知码时返回先命中的那个（旧实现
// 各谓词只看自己那一个码）。真实驱动错误不会带两个码，结构化 Code 也永远优先。
//
// 文本回落是**有意保留**的（不是遗漏）：它比 `errors.As` 更宽，删掉属于行为收紧。
func pgErrorCode(err error) (string, bool) {
	if err == nil {
		return "", false
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code, true
	}
	msg := err.Error()
	for _, code := range pgSQLStateCodes {
		if strings.Contains(msg, code) {
			return code, true
		}
	}
	return "", false
}

// pgErrorCodeIs 报告 err 是否携带 SQLSTATE 码 code —— 5 个业务谓词的唯一判定点。
func pgErrorCodeIs(err error, code string) bool {
	got, ok := pgErrorCode(err)
	return ok && got == code
}

// isDuplicateRelationErr 报告 err 是否为 PG 42P07(relation already exists)。
// 并发路径专用:并发 CREATE TABLE IF NOT EXISTS ... PARTITION OF 的存在性
// 检查用语句快照,挡不住"另一会话刚提交同名对象"的竞态(2026-09-12 P1-3)。
func isDuplicateRelationErr(err error) bool {
	return pgErrorCodeIs(err, pgSQLStateDuplicateRelation)
}
