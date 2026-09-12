package serverstore

import (
	"database/sql"
	"errors"
	"fmt"
)

// 本文件是 usage 家族**所有**分区创建的唯一实现。
//
// 2026-09-13 P1-3 同族缺陷:月明细分区(usage_<YYYYMM>)与年日账分区
// (usage_daily_<YYYY>)曾各写一份创建逻辑,年分区那份只抄了 DDL,漏掉了
// 「探测 → 建表」窗口的 42P07 兜底复检 —— 16 并发首写实测 5–15/16 报
// `relation "usage_daily_2027" already exists (SQLSTATE 42P07)`,
// RebuildUsageLedger 整轮失败、日账自愈被跳过。两处现在共用
// ensureRangePartition,语义不允许再分叉。

// partitionSpec 描述一次"幂等建范围分区"请求:父表、分区 key 与边界字面量。
//
// from/to 用**字面量**传入(而不是 time.Time):月分区的边界是"显式 UTC 偏移
// 的瞬时"(分区范围不随 PG 会话时区漂移),日账年分区是裸日期(day 是 DATE
// 列),两套口径各自的既有语义由调用方保留,helper 只负责创建流程。
type partitionSpec struct {
	parent string // 父表名:usage / usage_daily
	key    string // 分区后缀:202608(月) / 2026(年)
	from   string // 下界字面量
	to     string // 上界字面量
}

// relation 返回分区关系名(如 usage_202608 / usage_daily_2026)。
func (p partitionSpec) relation() string { return p.parent + "_" + p.key }

// usageRelationIsPartition 探测 public.<relation> 的 pg_class 记录:
// Valid=false = 不存在;Bool=true = 是父表的真分区;Bool=false = 同名孤儿表
// (F11:被 DETACH 但未 DROP,探测必须与真分区区分)。
func usageRelationIsPartition(db *sql.DB, relation string) (sql.NullBool, error) {
	var isPartition sql.NullBool
	err := db.QueryRow(`SELECT c.relispartition FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relname = ? AND n.nspname = 'public'`, relation).Scan(&isPartition)
	return isPartition, err
}

// staleDetachedTableErr 是同名孤儿表的固定错误(F11)。
func staleDetachedTableErr(relation string) error {
	return fmt.Errorf("%s exists but is not a partition (stale detached table); drop it manually", relation)
}

// ensureRangePartition 幂等创建 spec 描述的分区,月明细与年日账共用:
//
//  1. 先做廉价 catalog 探测(to_regclass 级,热路径不跑 DDL);
//  2. 缺失才 CREATE TABLE IF NOT EXISTS ... PARTITION OF;
//  3. 42P07(IF NOT EXISTS 的存在性检查用语句快照,挡不住"另一会话刚提交同名
//     分区")视为成功 —— 但必须复检占用者是真分区,不能把 F11 的同名孤儿表
//     一起吞掉。
func ensureRangePartition(db *sql.DB, spec partitionSpec) error {
	rel := spec.relation()
	isPartition, probeErr := usageRelationIsPartition(db, rel)
	if probeErr == nil && isPartition.Valid {
		if isPartition.Bool {
			return nil
		}
		return staleDetachedTableErr(rel)
	}
	if probeErr != nil && !errors.Is(probeErr, sql.ErrNoRows) {
		return probeErr
	}
	stmt := fmt.Sprintf(`CREATE TABLE IF NOT EXISTS %s PARTITION OF %s
		FOR VALUES FROM ('%s') TO ('%s')`, rel, spec.parent, spec.from, spec.to)
	_, err := db.Exec(stmt)
	if err != nil && isDuplicateRelationErr(err) {
		// 并发竞态:另一会话已建好同名分区。复检确认(READ COMMITTED 下新
		// 语句拿新快照,能看到对方已提交的分区);确认不了就保留原始错误。
		again, perr := usageRelationIsPartition(db, rel)
		if perr == nil && again.Valid {
			if again.Bool {
				return nil
			}
			return staleDetachedTableErr(rel)
		}
	}
	return err
}
