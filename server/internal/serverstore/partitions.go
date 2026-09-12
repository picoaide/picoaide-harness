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
//
// 2026-09-13 P1/P2(第五轮独立复核 §2,本轮修复):
//   - **P1 可用性回归**:pg_get_expr 的渲染受**会话 DateStyle** 影响
//     (German/SQL/Postgres 下是 `01.09.2026 00:00:00 CST`),只认 ISO 的解析
//     把**正确**的分区判成错界 → 每次计量写入失败(全站 503)。现在探测跑在
//     独立事务里并 SET LOCAL 固定 DateStyle=ISO + TimeZone=UTC(见
//     partitionProbeDateStyle),判定与会话设置解耦。
//   - **解析失败不再冒充错界**:「读不懂」与「确实不匹配」分成两个错误
//     (partitionBoundUnreadableErr / misboundedPartitionErr),错误文案也删掉了
//     "DROP 该分区让服务端重建"这类会诱导管理员删掉正确分区的行动指引。
//   - **P2 二级分区漏网**:探测增加 relkind 判据,只接受叶子分区 'r';'p'
//     (自身又是分区父表)边界再对也不算「已就绪」。

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
//	Exists && IsPartition    → 真分区,还要比对 RelKind / Parent(挂在哪个父表下)
//	                           与 Bound(边界表达式原文)
type partitionProbe struct {
	Exists      bool
	IsPartition bool
	// RelKind 是 pg_class.relkind:'r' 普通表(pg 里"叶子分区"的唯一形态);
	// 'p' = 该分区**自身又是分区父表**(二级分区)—— 子分区只覆盖半个窗口时
	// 写入照样 23514,所以不算「已就绪」(见 partitionReadyErr)。
	RelKind byte
	Parent  string
	Bound   string
}

// partitionProbeDateStyle:探测事务里的**会话渲染**固定值(P1,审计 r5 §2)。
//
// pg_get_expr(relpartbound, oid) 把边界常量渲染成文本,而 timestamptz/date 的
// 输出走 date_out/timestamptz_out,**受会话 DateStyle 影响**:
//
//	ISO, MDY(默认)     → '2026-09-01 00:00:00+08'
//	German/SQL/Postgres → '01.09.2026 00:00:00 CST'
//
// 第四轮引入的边界解析只认 ISO 形态 ⇒ 在 German/SQL/Postgres 会话下**正确**的
// 分区被判成错界 → ensureUsagePartition 在每次计量写入的热路径上报错 →
// 全站 LLM 请求 503 METERING_FAILED(可用性回归)。
//
// 修法:探测查询跑在**独立事务**里,先用 SET LOCAL 把渲染固定成 ISO(推荐的
// 最小修法),再取边界原文 —— 比对的仍然是语义(parsePartitionBoundLiteral 按
// 偏移解析瞬时),固定渲染只是为了"读得懂";会话设置随事务结束自动失效,不会
// 泄漏到连接池上的其它语句。
//
// 只固定 DateStyle 而**不动 TimeZone**:偏移仍按会话时区渲染(UTC 下 `+00`、
// Asia/Shanghai 下 `+08`),解析按偏移还原瞬时,所以判定与会话时区无关(既有
// r4 用例逐时区验证过);而错误消息里回显的边界原文保持与会话一致,便于管理员
// 与自己的 psql 会话对照。
const partitionProbeDateStyle = "SET LOCAL DateStyle = 'ISO, MDY'"

// probeUsagePartition 探测 public.<relation> 的 pg_class 记录,并取回
// pg_get_expr(relpartbound, oid)(非分区为 NULL → 空串)与继承父表名
// (pg_inherits → pg_class;无父表为 NULL → 空串)。父表也必须核对:同名关系
// 若是**别的**分区父表的分区(边界可以恰好一致),写路径照样路由不到本表。
// relkind 同时取回:二级分区('p')不能当叶子分区用。
func probeUsagePartition(db *sql.DB, relation string) (partitionProbe, error) {
	// 只读事务:固定会话渲染(见 partitionProbeDateStyle),读完即回滚。
	tx, err := db.Begin()
	if err != nil {
		return partitionProbe{}, err
	}
	defer tx.Rollback() //nolint:errcheck // 只读事务,回滚失败无副作用
	if _, err := tx.Exec(partitionProbeDateStyle); err != nil {
		return partitionProbe{}, fmt.Errorf("fix partition probe session rendering (%s): %w", partitionProbeDateStyle, err)
	}
	var isPartition sql.NullBool
	var relkind, bound, parent sql.NullString
	err = tx.QueryRow(`SELECT c.relispartition, c.relkind, pg_get_expr(c.relpartbound, c.oid), p.relname
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_inherits i ON i.inhrelid = c.oid
LEFT JOIN pg_class p ON p.oid = i.inhparent
WHERE c.relname = ? AND n.nspname = 'public'`, relation).Scan(&isPartition, &relkind, &bound, &parent)
	if errors.Is(err, sql.ErrNoRows) {
		return partitionProbe{}, nil
	}
	if err != nil {
		return partitionProbe{}, err
	}
	kind := byte(0)
	if relkind.Valid && relkind.String != "" {
		kind = relkind.String[0]
	}
	return partitionProbe{
		Exists:      true,
		IsPartition: isPartition.Valid && isPartition.Bool,
		RelKind:     kind,
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
//
// 文案纪律(审计 r5 §2 放大器):**不得**出现"DROP 该分区让服务端重建"这类
// 行动指引 —— 探测一旦误判(例如会话 DateStyle 造成解析失败),管理员照做会
// 删掉一个完全正确的分区、丢掉该月计量明细。人工处置只描述"需要人看",不替
// 人做决定。
func misboundedPartitionErr(spec partitionSpec, actual, detail string) error {
	return fmt.Errorf("%s exists as a partition of %s but its range is not the expected window: %s "+
		"(got %s, want FOR VALUES FROM ('%s') TO ('%s')); refusing to drop or rewrite a foreign table — "+
		"需人工处置(manual intervention):请人工核对上面的实际边界后再决定如何处置(服务端不会自动 DROP/改写)",
		spec.relation(), spec.parent, detail, actual, spec.from, spec.to)
}

// partitionBoundUnreadableErr 是「边界读不懂」的固定错误(P1,审计 r5 §2)。
//
// 与 misboundedPartitionErr 的区别是**语义**:读不懂 ≠ 边界错误。第四轮把
// "解析失败"直接并进"错界",于是一个**正确但形态特殊**的分区(非 ISO 会话
// 渲染、DEFAULT/MINVALUE/MAXVALUE、表达式边界)会被判成错界并建议处置。
// 现在两者用不同文案:这里说明"无法确认覆盖范围",并明确要求人工核对。
func partitionBoundUnreadableErr(spec partitionSpec, bound, detail string) error {
	return fmt.Errorf("%s exists as a partition of %s but its range cannot be read back from the catalog: %s "+
		"(got %s, want FOR VALUES FROM ('%s') TO ('%s')); 读不懂 ≠ 错界 —— 该分区可能完全正确,只是边界不是"+
		"可解析的字面量;需人工处置(manual intervention):请人工核对该分区的实际覆盖范围(服务端不会自动 DROP/改写)",
		spec.relation(), spec.parent, detail, bound, spec.from, spec.to)
}

// subPartitionedErr 是二级分区的固定错误(P2,审计 r5 §2):同名关系是 usage 的
// 真分区、边界也正确,但**自身又按 RANGE 分区**(relkind='p')。
//
// 缺陷形态:手工 `CREATE TABLE usage_209908 PARTITION OF usage … PARTITION BY
// RANGE (created_at)` + 一个只覆盖半个窗口的子分区 → 旧探测只看
// relispartition/边界,判「已就绪」;写入落到子分区之外报
// `no partition of relation "usage_209908" found for row`(23514),且永不自愈。
// 二级分区本身合法(可以覆盖完整),但**探测无法用一次往返证明覆盖完整**,
// 所以只接受叶子分区(relkind='r'),其余留给人工。
func subPartitionedErr(spec partitionSpec, probe partitionProbe) error {
	return fmt.Errorf("%s exists as a partition of %s but is itself partitioned (relkind='p'): "+
		"its own sub-partitions may not cover the whole expected window (got %s, want FOR VALUES FROM ('%s') TO ('%s')); "+
		"无法保证写入路由 —— 需人工处置(manual intervention):请人工确认其子分区覆盖完整,或改为叶子分区"+
		"(服务端不会自动 DROP/改写)",
		spec.relation(), spec.parent, probe.Bound, spec.from, spec.to)
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
	// 二级分区('p')不是叶子:边界对不代表子分区覆盖整个窗口(P2,审计 r5 §2)。
	// 只接受普通表形态;'f'(外部表)/'v'/'m'(视图)/其它同样是"写不进去"的关系。
	if probe.RelKind != 'r' {
		return subPartitionedErr(spec, probe)
	}
	return verifyPartitionBound(spec, probe.Bound)
}

// verifyPartitionBound 校验已存在分区的边界是否与期望区间一致(N4)。
//
// 比对对象是 pg_get_expr(relpartbound, oid) 的原文,但**不做字符串直比**:
// PG 按**会话 TimeZone** 渲染 timestamptz 字面量(UTC 下 `+00`、
// Asia/Shanghai 下 `+08`、Asia/Kathmandu 下 `+05:45`),而期望字面量是显式
// UTC 偏移(pgInstantArg)。因此先按字面量类型解析成"日期值"或"绝对瞬时",
// 再语义比较。
//
// 三种结果分开(审计 r5 §2,P1):
//   - 一致 → 就绪;
//   - **确实不一致** → misboundedPartitionErr(fail-loud);
//   - **读不懂**(MINVALUE/MAXVALUE/LIST/DEFAULT/手工表达式/解析不了的字面量)
//     → partitionBoundUnreadableErr:单独一类,不再冒充"错界"。第四轮把这两种
//     混成一条,导致任何渲染/形态变化都被当成"分区错了"。
func verifyPartitionBound(spec partitionSpec, bound string) error {
	from, to, ok := splitRangeBound(bound)
	if !ok {
		return partitionBoundUnreadableErr(spec, bound, "分区边界不是 RANGE 的 FROM/TO 字面量形态")
	}
	for _, side := range []struct {
		name     string
		want     string
		got      string
		mismatch string
	}{
		{"下界", spec.from, from, "下界与期望不一致"},
		{"上界", spec.to, to, "上界与期望不一致"},
	} {
		same, readable := comparePartitionBoundLiteral(side.want, side.got)
		if !readable {
			return partitionBoundUnreadableErr(spec, bound, side.name+"字面量无法解析")
		}
		if !same {
			return misboundedPartitionErr(spec, bound, side.mismatch)
		}
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

// comparePartitionBoundLiteral 语义比较两个字面量,并区分「不一致」与
// 「读不懂」:先按字节(最常见:边界就是会话时区无关的裸日期),再按解析出的
// 日期/绝对瞬时比较。返回 (same, readable):
//
//	same=true               → 一致
//	same=false, readable=true   → **确实不一致**(可以判错界)
//	same=false, readable=false  → 读不懂(不得判错界,见 partitionBoundUnreadableErr)
func comparePartitionBoundLiteral(want, got string) (same, readable bool) {
	if want == got {
		return true, true
	}
	wantKind, wantTime, okWant := parsePartitionBoundLiteral(want)
	gotKind, gotTime, okGot := parsePartitionBoundLiteral(got)
	if !okWant || !okGot || wantKind != gotKind {
		// 期望字面量是我们自己生成的(pgInstantArg/裸日期),正常永远可解析;
		// 走到这里说明**实际边界**的形态读不懂(或类型种类对不上),按"读不懂"
		// 处理 —— 宁可要求人工核对,也不把可能正确的分区判成错界。
		return false, false
	}
	return wantTime.Equal(gotTime), true
}

// partitionBoundDateLayout / partitionBoundInstantLayouts 覆盖 PG 的渲染形态:
// DATE 列打裸日期;timestamptz 打 `2006-01-02 15:04:05±HH[:MM[:SS]]`(整点偏移
// 不带分钟,半小时/45 分偏移带分钟,极少数历史时区偏移带秒)。session 时区
// 不同只改偏移,不改瞬时;探测事务已把渲染固定成 ISO + UTC(见
// partitionProbeDateStyle),这些形态是纵深防御。
const partitionBoundDateLayout = "2006-01-02"

var partitionBoundInstantLayouts = []string{
	"2006-01-02 15:04:05-07",
	"2006-01-02 15:04:05-07:00",
	"2006-01-02 15:04:05-07:00:00",
	"2006-01-02 15:04:05.999999-07",
	"2006-01-02 15:04:05.999999-07:00",
	"2006-01-02 15:04:05.999999-07:00:00",
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
