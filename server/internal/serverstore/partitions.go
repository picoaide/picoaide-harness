package serverstore

import (
	"database/sql"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
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
// FROM/TO 是否**覆盖**期望区间(比对见 verifyPartitionBound);不覆盖即
// fail-loud 并把「人工处置」写进错误消息 —— **绝不自动 DROP 别人的表**。
// (第四轮一度用"语义相等"作判据,把**更宽但完整覆盖**的合法分区也判成错界;
// 修正见下方 r7 条目。)
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
//
// 2026-09-13 r7 srvbill-3(P2,第七轮审计复核;R4 引入的回归):边界判据从
// 「语义相等」改成「**区间覆盖**」—— 危害是"期望窗口没被完整覆盖",判据必须
// 与危害同构。更宽但完整覆盖期望窗口的同名分区(DBA 按季度预建)在 R4 之前
// 是被接受的、写入本就能正确路由;旧判据把这类**合法配置**判成故障,导致该月
// 每一次 RecordUsage/账本重算都失败(网关 503 METERING_FAILED)且不自愈。

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
//	Exists && IsPartition    → 真分区,还要比对 RelKind / 分区树根(挂在哪棵树上)
//	                           与 Bound(边界表达式原文)
type partitionProbe struct {
	Exists      bool
	IsPartition bool
	// RelKind 是 pg_class.relkind:'r' 普通表(pg 里"叶子分区"的唯一形态);
	// 'p' = 该分区**自身又是分区父表**(二级分区)—— 子分区只覆盖半个窗口时
	// 写入照样 23514,所以不算「已就绪」(见 partitionReadyErr)。
	RelKind byte
	// Parent 是 pg_inherits 的**直接**父表名('' = 无父表)。
	Parent string
	// Root 是分区树的**传递根**关系名(pg_partition_root;非分区 = '')。
	//
	// 它与 Parent 的区别就是 R8-A-1 的判据面:多级布局
	// `usage → usage_<YYYY> → usage_<YYYYMM>` 里的月叶子直接父是 `usage_<YYYY>`,
	// 但它的传递根仍是 `usage` —— 行照样能被 `SELECT … FROM usage` 读到、
	// 写入也照样按区间路由进这株树,所以它是**就绪的**月分区。
	Root string
	// RootIsExpectedParent 报告传递根**就是** expectedRoot 指定的那个关系。
	//
	// 判据按 **oid** 比较(`pg_partition_root(c.oid) = to_regclass('public.'||$n)`),
	// 不比 relname:另一个 schema 里同名的分区树(R8-A-7)不参与判定。
	RootIsExpectedParent bool
	Bound                string
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
// pg_get_expr(relpartbound, oid)(非分区为 NULL → 空串)、继承父表名
// (pg_inherits → pg_class;无父表为 NULL → 空串)与**分区树传递根**
// (pg_partition_root)。
//
// 根判据(R8-A-1):"该关系能不能直接当作 expectedRoot 的月分区使用"问的是
// **它是不是这株树里的分区**,而不是"它的直接父是不是 expectedRoot" —— 多级
// 布局里的孙辈叶子直接父是中间父表,但它的行对 `SELECT … FROM expectedRoot`
// 可见、写入也按区间路由进同一株树。只比直接父会让**当月每一次计量写入**失败
// (网关 503 METERING_FAILED,不自愈);比传递根才与"能不能用"同构。
// 比较按 oid(to_regclass),不比 relname —— 跨 schema 的同名父表不算同一株树
// (R8-A-7)。relkind 同时取回:二级分区('p')不能当叶子分区用。
func probeUsagePartition(db *sql.DB, relation, expectedRoot string) (partitionProbe, error) {
	// 只读事务:固定会话渲染(见 partitionProbeDateStyle),读完即回滚。
	tx, err := db.Begin()
	if err != nil {
		return partitionProbe{}, err
	}
	defer tx.Rollback() //nolint:errcheck // 只读事务,回滚失败无副作用
	if _, err := tx.Exec(partitionProbeDateStyle); err != nil {
		return partitionProbe{}, fmt.Errorf("fix partition probe session rendering (%s): %w", partitionProbeDateStyle, err)
	}
	var isPartition, rootOK sql.NullBool
	var relkind, bound, parent, root sql.NullString
	err = tx.QueryRow(`SELECT c.relispartition, c.relkind, pg_get_expr(c.relpartbound, c.oid), p.relname,
       CASE WHEN c.relispartition THEN COALESCE(r.relname, '') ELSE '' END,
       COALESCE(c.relispartition AND r.oid = to_regclass('public.' || ?), false)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_inherits i ON i.inhrelid = c.oid
LEFT JOIN pg_class p ON p.oid = i.inhparent
LEFT JOIN pg_class r ON r.oid = pg_partition_root(c.oid)
WHERE c.relname = ? AND n.nspname = 'public'`, expectedRoot, relation).Scan(&isPartition, &relkind, &bound, &parent, &root, &rootOK)
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
		Exists:               true,
		IsPartition:          isPartition.Valid && isPartition.Bool,
		RelKind:              kind,
		Parent:               parent.String,
		Root:                 root.String,
		RootIsExpectedParent: rootOK.Valid && rootOK.Bool,
		Bound:                bound.String,
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
//  3. 缺失时先按**区间**扫一遍既有分区(r7 r7f1-3):期望窗口已被别的分区
//     (季度/年度预建)完整覆盖就直接复用、**跳过 CREATE**;否则才建;
//  4. 42P07(IF NOT EXISTS 的存在性检查用语句快照,挡不住"另一会话刚提交同名
//     分区")视为需要复检 —— 复检同样要过"真分区 + 边界正确"两道闸,不能把
//     F11 的同名孤儿表或并发建出的错界分区一起吞掉;
//  5. 42P17(与既有分区 overlap)与 **23514**(DEFAULT/MINVALUE..MAXVALUE 分区
//     里已有该窗口的行)都翻译成含人工处置指引的可诊断错误,不抛裸 PG
//     错误(r7 r7f1-3;23514 见 rc3-4:该布局可写,只是不能再建窄分区)。
//
// rc3-4(第三轮复核 §2 P2):第 3 步的覆盖探测此前只认**可解析的区间字面量**,
// `DEFAULT` 与 `FOR VALUES FROM (MINVALUE) TO (MAXVALUE)` 这两种"最宽的覆盖"
// 被归入"读不懂" ⇒ 该布局下每月首写都去 CREATE:分区为空时建出不必要的月分区,
// 分区里已有行时直接吃 23514(裸错误、无指引、每月首写永久 503 且不自愈)。
// 现在 scanUsagePartitions 把这两种形态显式识别为"覆盖一切"(partitionBoundCoversEverything),
// 命中即复用、跳过 CREATE;CREATE 真的撞上 23514 时也有同级的人工处置指引。
// 注意分工:同名关系(probe.Exists)仍走 verifyPartitionBound 的「读不懂 ⇒
// 人工核对」契约(审计 r5 §2),本轮的放宽只作用于**异名覆盖分区**的扫描。
func ensureRangePartition(db *sql.DB, spec partitionSpec) error {
	rel := spec.relation()
	probe, probeErr := probeUsagePartition(db, rel, spec.parent)
	if probeErr != nil {
		return probeErr
	}
	if probe.Exists {
		return partitionReadyErr(spec, probe)
	}
	// r7 r7f1-3(P2):同名关系不存在 ≠ 期望窗口没被覆盖。覆盖判据是**区间语义**,
	// 入口不能只有"同名关系":季度分区覆盖 8 月时,usage_209908 不存在,但窗口
	// 已被 usage_209909 覆盖 —— 再建月分区必然 overlap(42P17),RecordUsage /
	// RebuildUsageLedger 全挂、该月 503 且不自愈。
	//
	// R8-A-1:扫描面是整株子树(任意深度的后代),不只是直接子分区 —— 多级布局
	// `usage → usage_<YYYY>[p]` 下窗口可能已被**孙辈叶子**完整覆盖(直接复用),
	// 也可能只被中间父表覆盖:那时月分区必须建在**那个父表**下面,挂在 usage 下
	// 必然 42P17 overlap(当月每次计量写入 503 且不自愈)。
	if scan, serr := scanUsagePartitions(db, spec); serr != nil {
		return serr
	} else if scan.Covering != "" {
		logPartitionWindowCovered(spec, scan.Covering)
		return nil
	} else if scan.Attach != "" {
		logPartitionAttachPoint(spec, scan.Attach)
		return createRangePartition(db, spec, scan.Attach)
	}
	return createRangePartition(db, spec, spec.parent)
}

// createRangePartition 在 parent 下幂等创建 spec 的分区,并把 PG 的两类"建不进去"
// 翻译成可诊断错误(23514 DEFAULT 分区已有本窗口的行 / 42P17 与既有分区重叠)。
//
// parent 由调用方决定:缺省是 spec.parent;多级布局下窗口只被中间父表覆盖时,
// 是那个**最深的覆盖窗口的中间父表**(见 usagePartitionScan.Attach)。
func createRangePartition(db *sql.DB, spec partitionSpec, parent string) error {
	rel := spec.relation()
	stmt := fmt.Sprintf(`CREATE TABLE IF NOT EXISTS %s PARTITION OF %s
		FOR VALUES FROM ('%s') TO ('%s')`, rel, quoteRelationIdent(parent), spec.from, spec.to)
	_, err := db.Exec(stmt)
	if err != nil {
		// rc3-4:DEFAULT 分区(或 MINVALUE..MAXVALUE 分区)里已经有本窗口的行时,
		// PG 报 **23514**(不是 42P17):"updated partition constraint for default
		// partition … would be violated by some row"。该布局本身完全可写(写入会
		// 路由进 DEFAULT 分区),只是不能再加窄分区 —— 必须翻译成同级的可诊断
		// 结论,而不是把裸 SQLSTATE 抛给计量热路径(管理员只看到 503)。
		if isDefaultPartitionViolationErr(err) {
			scan, serr := scanUsagePartitions(db, spec)
			if serr == nil && scan.Covering != "" {
				logPartitionWindowCovered(spec, scan.Covering)
				return nil
			}
			if serr != nil {
				log.Printf("usage partition: rescan after default-partition violation failed: %v", serr)
			}
			return coveredByDefaultPartitionErr(spec, err)
		}
		if isOverlapPartitionErr(err) {
			// CREATE 与扫描之间有人建了覆盖窗口的分区(并发),或者只存在**部分
			// 重叠**的既有分区。复扫一次拿最新布局,再给管理员可诊断的结论。
			scan, serr := scanUsagePartitions(db, spec)
			if serr == nil && scan.Covering != "" {
				logPartitionWindowCovered(spec, scan.Covering)
				return nil
			}
			if serr != nil {
				log.Printf("usage partition: rescan after overlap failed: %v", serr)
			}
			return overlappingPartitionErr(spec, scan.Overlapping, err)
		}
		if isDuplicateRelationErr(err) {
			// 并发竞态:另一会话已建好同名分区。复检确认(READ COMMITTED 下新
			// 语句拿新快照,能看到对方已提交的分区);确认不了就保留原始错误。
			again, perr := probeUsagePartition(db, rel, spec.parent)
			if perr == nil && again.Exists {
				return partitionReadyErr(spec, again)
			}
		}
	}
	return err
}

// partitionSkipLogged 记录已经记过"窗口已被更宽分区覆盖"日志的 (parent,key)。
// 这**不是判定缓存**(判定每次调用都重新探测),只是防止热路径上同一窗口每次
// 计量写入都打一行日志。
var partitionSkipLogged sync.Map

// logPartitionWindowCovered 记录一次"同名关系不存在但窗口已被别的分区覆盖"
// (r7 r7f1-3):这是季度/年度预建布局被正常复用的诊断线索,同一窗口只记一次。
func logPartitionWindowCovered(spec partitionSpec, covering string) {
	key := "covered:" + spec.parent + "." + spec.key
	if _, loaded := partitionSkipLogged.LoadOrStore(key, struct{}{}); loaded {
		return
	}
	log.Printf("usage partition: %s not present but its window FROM '%s' TO '%s' of %s is already covered by partition %s; reusing it (no monthly partition created)",
		spec.relation(), spec.from, spec.to, spec.parent, covering)
}

// logPartitionAttachPoint 记录一次"窗口只被中间父表覆盖 ⇒ 月分区建在那个父表下"
// (R8-A-1)。这是多级布局被**写路径自愈**的诊断线索,同一窗口只记一次。
//
// 为什么必须自愈而不是 fail-loud:该布局下窗口本身**已经是可写的**(中间父表覆盖
// 了它),缺的只是一个更贴月粒度的叶子;不建的话每一次计量写入都要失败(网关
// 503 METERING_FAILED,不交付),而"这笔计量能不能落账"与"叶子挂在哪一层"无关 ——
// 判据必须与危害同构。
func logPartitionAttachPoint(spec partitionSpec, parent string) {
	key := "attach:" + spec.parent + "." + spec.key
	if _, loaded := partitionSkipLogged.LoadOrStore(key, struct{}{}); loaded {
		return
	}
	log.Printf("usage partition: %s not present; its window FROM '%s' TO '%s' of %s is covered by the multi-level layout — creating the partition under %s (deepest descendant covering the window) instead of %s",
		spec.relation(), spec.from, spec.to, spec.parent, parent, spec.parent)
}

// usagePartitionScan 是一次"期望窗口 vs spec.parent 子树"的扫描结果
// (r7 r7f1-3,P2 + R8-A-1):判据是**区间覆盖/重叠**,入口不再只有同名关系;
// 扫描面是整株子树(任意深度的后代),不再只有直接子分区。
type usagePartitionScan struct {
	// Covering 非空 = 该**叶子**分区完整覆盖期望窗口(可直接复用,不得再建月/年分区)。
	Covering string
	// Attach 非空 = 没有任何叶子覆盖窗口,但该**中间父表**('p')完整覆盖窗口 ⇒
	// 月分区必须建在它下面(R8-A-1):挂在 spec.parent 下会与它 42P17 overlap,
	// 当月每一次计量写入都会失败且不自愈。取**最深**的那个覆盖者(最贴近月粒度)。
	Attach string
	// Overlapping 非空 = 该分区与期望窗口部分重叠(再建必然 42P17)。只在与创建
	// 目标同一个父表下的兄弟里找 —— 别的分支上的重叠与本次 CREATE 无关。
	Overlapping string
}

// partitionDescendant 是分区树里的一个后代关系(见 usageTreeDescendants)。
type partitionDescendant struct {
	Rel    string
	Parent string
	Kind   string // pg_class.relkind:'r' 叶子 / 'p' 自身又是分区父表 / 其它
	Depth  int    // 1 = root 的直接子分区
	Bound  string // pg_get_expr(relpartbound, oid)
}

// usageTreeDescendants 枚举 root 关系所在分区树的**全部后代**(递归 CTE,任意深度),
// 返回按深度升序排列的后代清单(root 自身不在结果里)。
//
// 只读事务 + 固定会话渲染(见 partitionProbeDateStyle):边界原文由
// partitionBoundCoverage/partitionBoundOverlaps 解析,而它们只认 ISO 渲染。
func usageTreeDescendants(db *sql.DB, root string) ([]partitionDescendant, error) {
	tx, err := db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback() //nolint:errcheck // 只读事务,回滚失败无副作用
	if _, err := tx.Exec(partitionProbeDateStyle); err != nil {
		return nil, fmt.Errorf("fix partition probe session rendering (%s): %w", partitionProbeDateStyle, err)
	}
	rows, err := tx.Query(`WITH RECURSIVE tree AS (
    SELECT c.oid AS oid, 0 AS depth
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = ? AND n.nspname = 'public'
  UNION ALL
    SELECT i.inhrelid, t.depth + 1
    FROM tree t
    JOIN pg_inherits i ON i.inhparent = t.oid
)
SELECT c.relname, COALESCE(p.relname, ''), c.relkind, t.depth, COALESCE(pg_get_expr(c.relpartbound, c.oid), '')
FROM tree t
JOIN pg_class c ON c.oid = t.oid
LEFT JOIN pg_inherits i ON i.inhrelid = c.oid
LEFT JOIN pg_class p ON p.oid = i.inhparent
WHERE t.depth > 0
ORDER BY t.depth, c.relname`, root)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []partitionDescendant
	for rows.Next() {
		var d partitionDescendant
		if err := rows.Scan(&d.Rel, &d.Parent, &d.Kind, &d.Depth, &d.Bound); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// scanUsagePartitions 扫 spec.parent 子树里的**全部后代**,用 partitionBoundCoverage
// 的同一比较器找出覆盖期望窗口的那个关系(叶子 ⇒ 复用;中间父表 ⇒ 挂载点)。
//
// 只把**叶子**分区('r')当作覆盖者:中间父表('p')的边界覆盖窗口推不出"它自己的
// 子分区也覆盖了窗口"(与 partitionReadyErr 的判据同源,不允许再分叉),所以它只
// 能当**挂载点** —— 把月分区建在它下面,由 PG 自己保证行落进这株子树。
//
// rc3-4:`DEFAULT` 与 `MINVALUE..MAXVALUE` 由 partitionBoundCoversEverything
// 在进入字面量比较器**之前**识别为"覆盖一切",命中 Covering 分支、跳过
// CREATE —— 否则该布局下每月首写都要 CREATE 并吃 23514/42P17。
func scanUsagePartitions(db *sql.DB, spec partitionSpec) (usagePartitionScan, error) {
	desc, err := usageTreeDescendants(db, spec.parent)
	if err != nil {
		return usagePartitionScan{}, err
	}
	var out usagePartitionScan
	targetParent := spec.parent
	for _, d := range desc {
		if d.Rel == spec.relation() {
			continue // 同名关系由 probeUsagePartition 判(错误分类更精确)
		}
		// rc3-4:最宽的两类覆盖在这里先认 —— DEFAULT / MINVALUE..MAXVALUE 没有
		// 可解析的字面量,但对**异名**分区来说它们完整覆盖一切(写入经 PG 路由
		// 正确落进该分区),必须命中 Covering 而跳过 CREATE(否则该布局下每月
		// 首写都要 CREATE 并吃 23514/42P17)。
		if partitionBoundCoversEverything(d.Bound) {
			if d.Kind == "r" {
				out.Covering = d.Rel
				break
			}
			out.Attach, targetParent = d.Rel, d.Rel
			continue
		}
		covered, _, readable := partitionBoundCoverage(spec, d.Bound)
		if !readable {
			continue // 读不懂的边界不参与判定(交给同名探测/人工)
		}
		if covered {
			if d.Kind == "r" {
				out.Covering = d.Rel
				break
			}
			// desc 按深度升序:后到的覆盖者更深、窗口更窄、更贴月粒度。
			out.Attach, targetParent = d.Rel, d.Rel
		}
	}
	if out.Covering != "" {
		return out, nil
	}
	// 重叠只在**创建目标的兄弟**里找:别的分支上的重叠与本次 CREATE 无关。
	for _, d := range desc {
		if d.Rel == spec.relation() || d.Parent != targetParent || partitionBoundCoversEverything(d.Bound) {
			continue
		}
		if partitionBoundOverlaps(spec, d.Bound) {
			out.Overlapping = d.Rel
			break
		}
	}
	return out, nil
}

// overlappingPartitionErr 把 PG 的 42P17(partition would overlap)翻译成与
// misboundedPartitionErr 同级的可诊断错误(r7 r7f1-3,P2)。
//
// 文案纪律与 misboundedPartitionErr 一致:只描述"需要人看什么",不替管理员
// 决定 DROP/改写任何既有分区。
func overlappingPartitionErr(spec partitionSpec, overlapping string, cause error) error {
	who := fmt.Sprintf("该窗口与 %s 的既有分区重叠(无法确定是哪一个)", spec.parent)
	if overlapping != "" {
		who = fmt.Sprintf("该窗口与既有分区 %q 部分重叠(它既不完整覆盖本窗口,也不允许再建本窗口的分区)", overlapping)
	}
	return fmt.Errorf("%s cannot be created: %s (want FOR VALUES FROM ('%s') TO ('%s') of %s); upstream error: %v — "+
		"需人工处置(manual intervention):请人工核对上面那个分区的实际边界;"+
		"若窗口本就被更宽的分区完整覆盖,计量写入会正常路由,不要为该窗口单独建分区(服务端不会自动 DROP/改写)",
		spec.relation(), who, spec.from, spec.to, spec.parent, cause)
}

// isOverlapPartitionErr 报告 err 是否为 PG 42P17(分区边界与既有分区重叠)。
// 判定唯一实现在 pg.go 的 pgErrorCode（`errors.As` 优先，回落错误串）。
func isOverlapPartitionErr(err error) bool {
	return pgErrorCodeIs(err, pgSQLStateOverlapPartition)
}

// partitionReadyErr 判定"已存在的关系能否直接当作目标分区使用"。
func partitionReadyErr(spec partitionSpec, probe partitionProbe) error {
	if !probe.IsPartition {
		return staleDetachedTableErr(spec.relation())
	}
	// 判据是**分区树传递根**,不是直接父(R8-A-1,严重级 P2→可用性事故):
	//
	// 旧判据 `probe.Parent != spec.parent` 只认一层。多级布局
	// `usage → usage_<YYYY>[p] → usage_<YYYYMM>` 一旦覆盖**当前月**,该月每一次
	// `RecordUsage*` 都在这里报错 ⇒ 网关侧唯一出口是 fail-closed 的
	// 503 METERING_FAILED(不交付上游内容),而清理侧的"深层后代只补账不 DETACH"
	// 取舍又保证它**永不自愈** ⇒ 当月全部对话不可用,只能人工拆分区树。
	//
	// 而危害本来只是"这笔计量能不能落账":孙辈叶子的行对 `SELECT … FROM usage`
	// 可见、写入也按区间路由进同一株树 —— 与"直接挂在 usage 下"逐条等价。判据必须
	// 与危害同构,所以取 `pg_partition_root`(见 probeUsagePartition),并且按 **oid**
	// 比较(R8-A-7:另一个 schema 里的同名 `usage` 分区树不算同一株树)。
	if !probe.RootIsExpectedParent {
		return misboundedPartitionErr(spec, probe.Bound,
			fmt.Sprintf("该关系是父表 %q 的分区(分区树根 %q),期望父表 %q(判据是分区树的传递根)",
				probe.Parent, probe.Root, spec.parent))
	}
	// 二级分区('p')不是叶子:边界对不代表子分区覆盖整个窗口(P2,审计 r5 §2)。
	// 只接受普通表形态;'f'(外部表)/'v'/'m'(视图)/其它同样是"写不进去"的关系。
	if probe.RelKind != 'r' {
		return subPartitionedErr(spec, probe)
	}
	return verifyPartitionBound(spec, probe.Bound)
}

// verifyPartitionBound 校验已存在分区的边界是否**覆盖期望区间**(N4 + r7 srvbill-3)。
//
// 比对对象是 pg_get_expr(relpartbound, oid) 的原文,但**不做字符串直比**:
// PG 按**会话 TimeZone** 渲染 timestamptz 字面量(UTC 下 `+00`、
// Asia/Shanghai 下 `+08`、Asia/Kathmandu 下 `+05:45`),而期望字面量是显式
// UTC 偏移(pgInstantArg)。因此先按字面量类型解析成"日期值"或"绝对瞬时",
// 再语义比较。
//
// 判据是**区间覆盖**,不是语义相等(P2,审计 r7 srvbill-3):本校验要防的危害
// 是「期望窗口没有被完整覆盖」(更窄/错位 → 窗口边缘的写入 23514 且永不自愈),
// 判据必须与危害同构。第四轮用了 `Equal`,于是一个边界更宽、**完整覆盖**期望
// 窗口的同名分区(DBA 按季度预建的 usage_<本月>)被判错界 → 该月每一次计量
// 写入与账本重算都失败(网关 503 METERING_FAILED)且不自愈;而它在 R4 之前
// 是被接受的、写入本就能正确路由。现在:
//
//	actualFrom <= wantFrom 且 actualTo >= wantTo → 就绪;
//	不覆盖(更窄/错位) → misboundedPartitionErr(fail-loud);
//	读不懂(MINVALUE/MAXVALUE/LIST/DEFAULT/手工表达式/解析不了的字面量)
//	→ partitionBoundUnreadableErr:单独一类,不冒充"错界"。
func verifyPartitionBound(spec partitionSpec, bound string) error {
	covered, detail, readable := partitionBoundCoverage(spec, bound)
	if !readable {
		return partitionBoundUnreadableErr(spec, bound, detail)
	}
	if !covered {
		return misboundedPartitionErr(spec, bound, detail)
	}
	return nil
}

// partitionBoundCoverage 是"实际边界是否**完整覆盖**期望窗口"的**唯一判据**
// (verifyPartitionBound 与 scanUsagePartitions 共用,不允许再分叉):
//
//	covered=true,  readable=true  → 覆盖(就绪)
//	covered=false, readable=true  → 确实不覆盖(detail 说明是哪一侧)
//	readable=false                → 读不懂(不得判错界;detail 说明原因)
//
// rc3-4(第三轮复核 §2 P2):`DEFAULT` 与 `FROM (MINVALUE) TO (MAXVALUE)` 是
// **最宽**的覆盖,但它们不是"可解析的区间字面量",所以**这个比较器**仍然按
// 「读不懂」处理(与审计 r5 §2 的契约一致:同名关系读不懂 ⇒ fail-loud + 人工
// 核对)。异名分区的覆盖判定在 scanUsagePartitions —— 那里 DEFAULT 是标准 DBA
// 布局,必须先按 partitionBoundCoversEverything 判"覆盖一切"(见该函数)。
func partitionBoundCoverage(spec partitionSpec, bound string) (covered bool, detail string, readable bool) {
	from, to, ok := splitRangeBound(bound)
	if !ok {
		return false, "分区边界不是 RANGE 的 FROM/TO 字面量形态", false
	}
	for _, side := range []struct {
		name     string
		want     string
		got      string
		upper    bool // 上界要求实际值不早于期望;下界要求不晚于期望
		mismatch string
	}{
		{"下界", spec.from, from, false, "实际下界晚于期望下界:窗口前段未被覆盖"},
		{"上界", spec.to, to, true, "实际上界早于期望上界:窗口后段未被覆盖"},
	} {
		order, readable := comparePartitionBoundOrder(side.want, side.got)
		if !readable {
			return false, side.name + "字面量无法解析", false
		}
		covers := order <= 0 // 实际 <= 期望
		if side.upper {
			covers = order >= 0 // 实际 >= 期望
		}
		if !covers {
			return false, side.mismatch, true
		}
	}
	return true, "", true
}

// partitionBoundOverlaps 判定实际边界与期望窗口是否**部分重叠**
// (actualFrom < wantTo && actualTo > wantFrom)。读不懂一律返回 false:
// 判据不能建立在对边界的猜测上。
//
// 覆盖一切(DEFAULT/MINVALUE..MAXVALUE)不由这里判定:scanUsagePartitions 会
// 先用 partitionBoundCoversEverything 命中覆盖分支,走不到 overlap。读不懂仍然
// 一律 false(判据不建立在对边界的猜测上)。
func partitionBoundOverlaps(spec partitionSpec, bound string) bool {
	from, to, ok := splitRangeBound(bound)
	if !ok {
		return false
	}
	beforeUpper, ok1 := comparePartitionBoundOrder(spec.to, from) // from vs wantTo
	afterLower, ok2 := comparePartitionBoundOrder(spec.from, to)  // to vs wantFrom
	if !ok1 || !ok2 {
		return false
	}
	return beforeUpper < 0 && afterLower > 0
}

// partitionBoundCoversEverything 判定边界是否是"覆盖一切"的两种形态
// (rc3-4):
//
//	DEFAULT                                  — PG 的默认分区
//	FROM (MINVALUE) TO (MAXVALUE)            — 显式无限区间(等价 DEFAULT)
//
// 判据只做**形态归一化后的前缀/包含**比较(去掉空白、大小写不敏感),不解析
// 字面量:这两种边界本来就没有字面量可解析。返回 false 时调用方仍按原有
// 字面量路径判定,语义不允许再分叉。
//
// 只被 scanUsagePartitions(异名分区扫描)与 23514 的复扫使用:同名关系的
// verifyPartitionBound 仍把 DEFAULT 当"读不懂"(审计 r5 §2 的契约 —— 一个
// 名字是月分区、边界却是 DEFAULT 的手工对象要求人工核对)。
func partitionBoundCoversEverything(bound string) bool {
	b := strings.ToUpper(strings.TrimSpace(bound))
	if b == "" {
		return false
	}
	if strings.HasPrefix(b, "DEFAULT") {
		return true
	}
	// 归一化:去掉全部空白与多余括号,得到 FROM(MINVALUE)TO(MAXVALUE)。
	compact := strings.NewReplacer(" ", "", "\t", "", "\n", "", "\r", "").Replace(b)
	compact = strings.TrimSuffix(compact, ";")
	return compact == "FORVALUESFROM(MINVALUE)TO(MAXVALUE)" ||
		strings.Contains(compact, "FROM(MINVALUE)TO(MAXVALUE)")
}

// isDefaultPartitionViolationErr 报告 err 是否为 PG 23514 —— "往 DEFAULT 分区
// 表加新分区会让既有行违反分区约束"(rc3-4)。它与 42P17(overlap)是同一族的
// 两种 PG 拒绝形态:布局本身完全可写,只是**不能再加窄分区**。
//
// 判定唯一实现在 pg.go 的 pgErrorCode（`errors.As` 优先，回落错误串）。
func isDefaultPartitionViolationErr(err error) bool {
	return pgErrorCodeIs(err, pgSQLStateDefaultPartitionViolated)
}

// coveredByDefaultPartitionErr 把 23514 翻译成与 overlappingPartitionErr 同级
// 的可诊断错误(rc3-4):布局本身可写(DEFAULT / MINVALUE..MAXVALUE 分区吞下
// 了该窗口的行),服务端**不该**再为这个窗口建窄分区。
//
// 文案纪律与 overlappingPartitionErr 一致:只描述"需要人看什么",不替管理员
// 决定 DROP/改写任何既有分区。
func coveredByDefaultPartitionErr(spec partitionSpec, cause error) error {
	return fmt.Errorf("%s cannot be created: %s 的 DEFAULT 分区(或 MINVALUE..MAXVALUE 分区)已经含有本窗口的行,新增分区会让它们违反分区约束"+
		"(want FOR VALUES FROM ('%s') TO ('%s')); upstream error: %v — "+
		"计量写入本就会正常路由进那个分区,不要为本窗口单独建分区;"+
		"需人工处置(manual intervention):请人工确认父表 %s 确实存在覆盖本窗口的分区(DEFAULT / MINVALUE..MAXVALUE),服务端不会自动 DROP/改写任何既有分区",
		spec.relation(), spec.parent, spec.from, spec.to, cause, spec.parent)
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

// comparePartitionBoundOrder 语义比较两个字面量的时间先后,并区分「读不懂」:
// 先按字节(最常见:边界就是会话时区无关的裸日期),再按解析出的日期/绝对瞬时
// 比较。返回 (order, readable):
//
//	order<0   → got 早于 want(下界方向 = 覆盖到了窗口之前)
//	order==0  → 同一时刻
//	order>0   → got 晚于 want
//	readable=false → 读不懂(不得判错界,见 partitionBoundUnreadableErr)
func comparePartitionBoundOrder(want, got string) (order int, readable bool) {
	if want == got {
		return 0, true
	}
	wantKind, wantTime, okWant := parsePartitionBoundLiteral(want)
	gotKind, gotTime, okGot := parsePartitionBoundLiteral(got)
	if !okWant || !okGot || wantKind != gotKind {
		// 期望字面量是我们自己生成的(pgInstantArg/裸日期),正常永远可解析;
		// 走到这里说明**实际边界**的形态读不懂(或类型种类对不上),按"读不懂"
		// 处理 —— 宁可要求人工核对,也不把可能正确的分区判成错界。
		return 0, false
	}
	return gotTime.Compare(wantTime), true
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
