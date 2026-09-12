package serverstore

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// 本文件是 usage 家族**所有**分区创建的唯一实现。
//
// 2026-09-13 P1-3 同族缺陷:月明细分区(usage_<YYYYMM>)与年日账分区
// (usage_daily_<YYYY>)曾各写一份创建逻辑,年分区那份只抄了 DDL,漏掉了
// 「探测 → 建表」窗口的 42P07 兜底复检 —— 16 并发首写实测 5–15/16 报
// `relation "usage_daily_2027" already exists (SQLSTATE 42P07)`,
// RebuildUsageLedger 整轮失败、日账自愈被跳过。两处现在共用
// ensureRangePartition,语义不允许再分叉。
//
// 2026-09-13 N4(第三轮独立复核 §2.2,P2):探测只看 relispartition,
// **不校验边界**。历史/手工 DDL 建出的错界真分区(例如按 UTC 自然月建的
// usage_203701)会被判「已就绪」,而写入路径的期望窗口是北京月 —— 每月最后
// 8 小时的计量写入落到该分区之外(23514 `no partition of relation`),R3 之后
// 表现为 503 METERING_FAILED,而且**永不自愈**(探测永远认为已就绪)。
// ensureRangePartition 现在额外校验 pg_get_expr(relpartbound, oid) 的
// FROM/TO 是否与期望区间语义相等(比对见 verifyPartitionBound);不匹配即
// fail-loud 并把「人工处置」写进错误消息 —— **绝不自动 DROP 别人的表**。

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

// partitionProbe 是一次 catalog 探测的结果。
//
//	Exists=false             → 关系不存在,需要建
//	Exists && !IsPartition   → 同名孤儿表(F11:被 DETACH 但未 DROP)
//	Exists && IsPartition    → 真分区,还要比对 Parent(挂在哪个父表下)与
//	                           Bound(边界表达式原文)
type partitionProbe struct {
	Exists      bool
	IsPartition bool
	Parent      string
	Bound       string
}

// probeUsagePartition 探测 public.<relation> 的 pg_class 记录,并取回
// pg_get_expr(relpartbound, oid)(非分区为 NULL → 空串)与继承父表名
// (pg_inherits → pg_class;无父表为 NULL → 空串)。父表也必须核对:同名关系
// 若是**别的**分区父表的分区(边界可以恰好一致),写路径照样路由不到本表。
// 一次往返拿到全部判据,热路径(每次计量写入都会探测)不额外加查询。
func probeUsagePartition(db *sql.DB, relation string) (partitionProbe, error) {
	var isPartition sql.NullBool
	var bound, parent sql.NullString
	err := db.QueryRow(`SELECT c.relispartition, pg_get_expr(c.relpartbound, c.oid), p.relname
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_inherits i ON i.inhrelid = c.oid
LEFT JOIN pg_class p ON p.oid = i.inhparent
WHERE c.relname = ? AND n.nspname = 'public'`, relation).Scan(&isPartition, &bound, &parent)
	if errors.Is(err, sql.ErrNoRows) {
		return partitionProbe{}, nil
	}
	if err != nil {
		return partitionProbe{}, err
	}
	return partitionProbe{
		Exists:      true,
		IsPartition: isPartition.Valid && isPartition.Bool,
		Parent:      parent.String,
		Bound:       bound.String,
	}, nil
}

// staleDetachedTableErr 是同名孤儿表的固定错误(F11)。
func staleDetachedTableErr(relation string) error {
	return fmt.Errorf("%s exists but is not a partition (stale detached table); drop it manually", relation)
}

// misboundedPartitionErr 是错界真分区的固定错误(N4):fail-loud + 人工处置。
// 故意不提供"自动 DROP 重建"的路径 —— 同名表可能是别人手工建的业务对象,
// 服务端无权替管理员决定丢弃它。
func misboundedPartitionErr(spec partitionSpec, actual, detail string) error {
	return fmt.Errorf("%s exists as a partition of %s but its range is not the expected window: %s "+
		"(got %s, want FOR VALUES FROM ('%s') TO ('%s')); refusing to drop or rewrite a foreign table — "+
		"需人工处置(manual intervention):DROP 该分区让服务端重建,或 ATTACH 一个边界正确的分区",
		spec.relation(), spec.parent, detail, actual, spec.from, spec.to)
}

// ensureRangePartition 幂等创建 spec 描述的分区,月明细与年日账共用:
//
//  1. 先做廉价 catalog 探测(热路径不跑 DDL),同时取回边界表达式;
//  2. 已存在:真分区 → **校验边界**(N4);孤儿表 → staleDetachedTableErr;
//  3. 缺失才 CREATE TABLE IF NOT EXISTS ... PARTITION OF;
//  4. 42P07(IF NOT EXISTS 的存在性检查用语句快照,挡不住"另一会话刚提交同名
//     分区")视为需要复检 —— 复检同样要过"真分区 + 边界正确"两道闸,不能把
//     F11 的同名孤儿表或并发建出的错界分区一起吞掉。
func ensureRangePartition(db *sql.DB, spec partitionSpec) error {
	rel := spec.relation()
	probe, probeErr := probeUsagePartition(db, rel)
	if probeErr != nil {
		return probeErr
	}
	if probe.Exists {
		return partitionReadyErr(spec, probe)
	}
	stmt := fmt.Sprintf(`CREATE TABLE IF NOT EXISTS %s PARTITION OF %s
		FOR VALUES FROM ('%s') TO ('%s')`, rel, spec.parent, spec.from, spec.to)
	_, err := db.Exec(stmt)
	if err != nil && isDuplicateRelationErr(err) {
		// 并发竞态:另一会话已建好同名分区。复检确认(READ COMMITTED 下新
		// 语句拿新快照,能看到对方已提交的分区);确认不了就保留原始错误。
		again, perr := probeUsagePartition(db, rel)
		if perr == nil && again.Exists {
			return partitionReadyErr(spec, again)
		}
	}
	return err
}

// partitionReadyErr 判定"已存在的关系能否直接当作目标分区使用"。
func partitionReadyErr(spec partitionSpec, probe partitionProbe) error {
	if !probe.IsPartition {
		return staleDetachedTableErr(spec.relation())
	}
	// 父表也必须对:同名关系可能是**别的**分区父表的分区(边界甚至能完全一致),
	// 那样写路径依旧路由不到本表 —— 「已就绪」必须包含这一条。
	if probe.Parent != spec.parent {
		return misboundedPartitionErr(spec, probe.Bound,
			fmt.Sprintf("该关系是父表 %q 的分区,期望父表 %q", probe.Parent, spec.parent))
	}
	return verifyPartitionBound(spec, probe.Bound)
}

// verifyPartitionBound 校验已存在分区的边界是否与期望区间一致(N4)。
//
// 比对对象是 pg_get_expr(relpartbound, oid) 的原文,但**不做字符串直比**:
// PG 按**会话 TimeZone** 渲染 timestamptz 字面量(UTC 下 `+00`、
// Asia/Shanghai 下 `+08`、Asia/Kathmandu 下 `+05:45`),而期望字面量是显式
// UTC 偏移(pgInstantArg)。因此先按字面量类型解析成"日期值"或"绝对瞬时",
// 再语义比较;解析不出(MINVALUE/MAXVALUE/LIST/DEFAULT/手工表达式)一律视为
// 不匹配(fail-loud),不猜。
func verifyPartitionBound(spec partitionSpec, bound string) error {
	from, to, ok := splitRangeBound(bound)
	if !ok {
		return misboundedPartitionErr(spec, bound, "分区边界不是 RANGE 的 FROM/TO 字面量形态")
	}
	if !samePartitionBoundLiteral(spec.from, from) {
		return misboundedPartitionErr(spec, bound, "下界与期望不一致")
	}
	if !samePartitionBoundLiteral(spec.to, to) {
		return misboundedPartitionErr(spec, bound, "上界与期望不一致")
	}
	return nil
}

// splitRangeBound 从 `FOR VALUES FROM ('x') TO ('y')` 取出两个字面量内容。
// 用 LastIndex(") TO (") 切分以容忍字面量外的多余括号/类型转换
// (`FROM (('2026-01-01'::date)) TO (...)`)。MINVALUE/MAXVALUE 没有引号
// 字面量 → ok=false(调用方按不匹配处理)。
func splitRangeBound(bound string) (from, to string, ok bool) {
	const prefix = "FOR VALUES FROM ("
	if !strings.HasPrefix(bound, prefix) {
		return "", "", false
	}
	rest := strings.TrimSpace(bound[len(prefix):])
	i := strings.LastIndex(rest, ") TO (")
	if i < 0 {
		return "", "", false
	}
	toPart := strings.TrimSpace(rest[i+len(") TO ("):])
	if !strings.HasSuffix(toPart, ")") {
		return "", "", false
	}
	from, okFrom := extractPartitionLiteral(rest[:i])
	to, okTo := extractPartitionLiteral(strings.TrimSuffix(toPart, ")"))
	if !okFrom || !okTo {
		return "", "", false
	}
	return from, to, true
}

// extractPartitionLiteral 取第一个单引号字面量的内容(SQL 的 ” 转义按一个
// 引号还原),忽略类型转换等尾巴。
func extractPartitionLiteral(raw string) (string, bool) {
	start := strings.IndexByte(raw, '\'')
	if start < 0 {
		return "", false
	}
	var b strings.Builder
	for i := start + 1; i < len(raw); i++ {
		if raw[i] != '\'' {
			b.WriteByte(raw[i])
			continue
		}
		if i+1 < len(raw) && raw[i+1] == '\'' { // '' 转义
			b.WriteByte('\'')
			i++
			continue
		}
		return b.String(), true
	}
	return "", false // 引号没闭合
}

// samePartitionBoundLiteral 语义比较两个字面量:先按字节(最常见:边界就是
// 会话时区无关的裸日期)、再按解析出的日期/绝对瞬时比较。
func samePartitionBoundLiteral(want, got string) bool {
	if want == got {
		return true
	}
	wantKind, wantTime, okWant := parsePartitionBoundLiteral(want)
	gotKind, gotTime, okGot := parsePartitionBoundLiteral(got)
	if !okWant || !okGot || wantKind != gotKind {
		return false
	}
	return wantTime.Equal(gotTime)
}

// partitionBoundDateLayout / partitionBoundInstantLayouts 覆盖 PG 的渲染形态:
// DATE 列打裸日期;timestamptz 打 `2006-01-02 15:04:05±HH[:MM]`(整点偏移不带
// 分钟,半小时/45 分偏移带分钟)。session 时区不同只改偏移,不改瞬时。
const partitionBoundDateLayout = "2006-01-02"

var partitionBoundInstantLayouts = []string{
	"2006-01-02 15:04:05-07",
	"2006-01-02 15:04:05-07:00",
	"2006-01-02 15:04:05.999999-07",
	"2006-01-02 15:04:05.999999-07:00",
}

// parsePartitionBoundLiteral 解析一个字面量,返回 ("date"|"instant", 时间, ok)。
func parsePartitionBoundLiteral(raw string) (string, time.Time, bool) {
	if t, err := time.Parse(partitionBoundDateLayout, raw); err == nil {
		return "date", t, true
	}
	for _, layout := range partitionBoundInstantLayouts {
		if t, err := time.Parse(layout, raw); err == nil {
			return "instant", t, true
		}
	}
	return "", time.Time{}, false
}
