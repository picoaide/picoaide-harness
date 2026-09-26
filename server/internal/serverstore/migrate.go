package serverstore

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/hex"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed migrations-pg/*.sql
var migrationFS embed.FS

type migration struct {
	version int
	name    string
	sql     string
}

// checksum 返回迁移文件正文的 sha256（小写 hex）。
//
// 与 `scripts/check-migration-range.mjs` 生成的 `migrations-checksums.json` **同一算法**
// （JS 侧 `createHash('sha256').update(<文件字节>).digest('hex')`，Go 侧 `//go:embed`
// 拿到的就是文件原始字节）。两侧一致性由 `TestMigrationChecksumsMatchJSRegistry`
// 逐条对拍 —— 同一件事只允许一份实现，所以这里不引入第二种摘要口径。
func (m migration) checksum() string {
	sum := sha256.Sum256([]byte(m.sql))
	return hex.EncodeToString(sum[:])
}

// testMigrationHook, when non-nil (tests only), overrides the migration set
// so failure paths can be exercised without a real broken embed.
var testMigrationHook func() []migration

// migrationFileNameRE 是迁移文件名的**唯一形状判据**：`NNNN_<描述>.sql`。
//
// 为什么必须自检（R6-A-3，审计 2026-09-23，P2）：旧实现 `Atoi(前缀)` 失败即
// `continue`，于是
//   - 文件名不合规（如 `0082-badname.sql`：分隔符不是下划线）**从第一次启动起**
//     就被静默跳过 —— 整条迁移的 DDL 永不生效，症状转移到运行期（缺表/缺列，
//     看着像代码 bug），且零日志零判据；
//   - 版本号重复（`0082_a.sql` + `0082_b.sql`）第一次启动会在
//     `INSERT INTO schema_migrations` 上撞主键报错（生产 = main.go 的
//     log.Fatalf、容器退出），**第二次启动却返回 nil** —— applied 快照里已有 82，
//     两条 0082 一起被跳过 ⇒ 后一条的 DDL 永不生效，此后同样零判据。
var migrationFileNameRE = regexp.MustCompile(`^([0-9]{4})_([A-Za-z0-9][A-Za-z0-9_-]*)\.sql$`)

// loadMigrations 读取 dir 下的迁移文件并做**形状自检**（fail-loud）：
//   - 文件名不合规 ⇒ 报错并点名文件（含期望形状）；
//   - 版本号重复 ⇒ 报错并**同时点名两个文件**（指出"第二次启动会一起跳过"的后果）；
//   - 描述名重复（同一描述配了不同版本号）⇒ 报错并点名两个文件 ——
//     同一件事被写进两条迁移通常是复制粘贴时忘了改内容。
//
// 只有 `.sql` 文件参与（与 `//go:embed migrations-pg/*.sql` 同口径）；子目录忽略。
// 返回集合按版本升序（版本重复已在上面报错，因此顺序是确定的）。
func loadMigrations(fsys fs.FS, dir string) ([]migration, error) {
	entries, err := fs.ReadDir(fsys, dir)
	if err != nil {
		return nil, fmt.Errorf("migrations dir %s: %w", dir, err)
	}
	var out []migration
	byVersion := make(map[int]string, len(entries))
	byStem := make(map[string]string, len(entries))
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".sql") {
			continue
		}
		m := migrationFileNameRE.FindStringSubmatch(name)
		if m == nil {
			return nil, fmt.Errorf("迁移文件名不合规：%s/%s —— 必须形如 NNNN_name.sql"+
				"（4 位版本号 + 下划线 + 描述 + .sql）；不合规的名字会被旧实现**静默跳过**"+
				"（该迁移的 DDL 永不生效），因此这里 fail-loud", dir, name)
		}
		v, err := strconv.Atoi(m[1])
		if err != nil {
			return nil, fmt.Errorf("迁移文件名不合规：%s/%s（版本号不是十进制数）: %w", dir, name, err)
		}
		if prev, dup := byVersion[v]; dup {
			return nil, fmt.Errorf("迁移版本号重复：%s/%s 与 %s/%s 都是版本 %04d —— "+
				"首次启动会在 schema_migrations 主键上失败，而第二次启动会因已应用快照"+
				"把两条**一起跳过**（后一条的 DDL 永不生效）；请给其中一条重新编号",
				dir, prev, dir, name, v)
		}
		byVersion[v] = name
		if prev, dup := byStem[m[2]]; dup {
			return nil, fmt.Errorf("迁移描述名重复：%s/%s 与 %s/%s 的描述名同为 %q（版本号不同）—— "+
				"同一件事被写进两条迁移（通常是复制粘贴未改内容），请合并或改名",
				dir, prev, dir, name, m[2])
		}
		byStem[m[2]] = name
		content, err := fs.ReadFile(fsys, path.Join(dir, name))
		if err != nil {
			return nil, fmt.Errorf("read migration %s/%s: %w", dir, name, err)
		}
		out = append(out, migration{version: v, name: name, sql: string(content)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].version < out[j].version })
	return out, nil
}

// migrationLoader 是"加载 + 形状自检"的装配接缝：生产恒为 embedded FS 的加载器，
// 仅测试替换（用夹具目录造重复版本号 / 不合规文件名两种形态）。
var migrationLoader = func() ([]migration, error) {
	return loadMigrations(migrationFS, "migrations-pg")
}

// currentMigrations 返回本次启动要应用的迁移集合。
//
// 形状自检在**每次调用**都执行，与 schema_migrations 的 applied 快照无关 ——
// 这正是"第二次启动也必须报错"的判据（R6-A-3 的静默跳过恰恰发生在第二次启动）。
// testMigrationHook 只用于测试注入任意集合（迁移语义用例），它绕过形状自检
// （夹具里的 version 999/过滤后的子集本就不满足生产形状）。
func currentMigrations() ([]migration, error) {
	if testMigrationHook != nil {
		return testMigrationHook(), nil
	}
	return migrationLoader()
}

// migrationsFor returns the embedded migration set (PostgreSQL only since the
// SQLite removal). Sorted by version ascending.
//
// 形状自检失败时 panic：本函数是"包级不变式"访问点（多处测试与 latestMigration
// 直接用它）。生产启动路径一律经 ApplyMigrations 拿到 **error**（main.go 的
// log.Fatalf 会打印可行动的文案），不依赖这个 panic。
func migrationsFor() []migration {
	ms, err := currentMigrations()
	if err != nil {
		panic(err)
	}
	return ms
}

// latestMigration returns the highest migration version for the current driver.
func latestMigration() int64 {
	ms := migrationsFor()
	if len(ms) == 0 {
		return 0
	}
	return int64(ms[len(ms)-1].version)
}

// init embedded FS is validated at package init: both migration dirs must
// exist and parse.
func init() {
	for _, dir := range []string{"migrations-pg"} {
		if _, err := migrationFS.ReadDir(dir); err != nil {
			panic(fmt.Sprintf("migrations dir %s: %v", dir, err))
		}
	}
}

// SchemaMismatchError 是"二进制可见的迁移文件集合"与库里 `schema_migrations`
// **双向对账**失败时的错误（R13-GE · R13A-03）。
//
// 被审形态：`ApplyMigrations` 只做**单向**遍历（文件 → DB），DB 里多出来的版本
// 既无错误、无日志、无告警 —— 三条现实来源：
//
//	① **二进制回滚**（DB 已到 0081，二进制只认到 0080）；
//	② 手工/脚本写入的条目；
//	③ 历史上删过/改过号的迁移文件。
//
// 后果：服务端**静默**带着比自己新的 schema 启动（`/api/server/server-info` 只是把
// DB 的 `MAX(version)` 原样报出来，从不与二进制可见集合对账）；一条**从不生效**的
// 死版本也可以长期存在而无人知晓。加列/建表类迁移通常容忍，一旦出现
// "重命名 / 删列 / 改语义"的代，静默通过会变成运行期的错误而非启动期的失败 ——
// 那正是 0039 那次"升级永不成功"的同族形态（只是方向相反）。
//
// 口径（R13-GE 定案）：**fail-loud**，不做"打个日志继续跑"。理由与 `loadMigrations`
// 的形状自检同源 —— 这一类缺陷的全部危害都来自"静默"，而启动期是唯一能给出
// 可行动文案的位置。运维后果如实登记：**跨迁移代回滚旧二进制时它会拒绝启动**
// （回滚口径从"换镜像"变成"换镜像 + 把库恢复到与该二进制同代"，部署脚本本来就
// 会先做 pg_dump）。
type SchemaMismatchError struct {
	// Unknown 是"库里存在、但二进制可见的迁移集合里没有对应文件"的版本（升序）。
	Unknown []int64
	// MaxFile 是二进制可见集合的最大版本（0 = 空集合）。
	MaxFile int64
	// AppliedMax 是库里 `schema_migrations` 的最大版本（0 = 空表）。
	AppliedMax int64
}

func (e *SchemaMismatchError) Error() string {
	dir, action := "库比二进制**旧**（有版本在库里但不在文件集里）", ""
	switch {
	case e.AppliedMax > e.MaxFile:
		dir = "库比二进制**新**（二进制被回滚到更早的代）"
		action = "两条可行动作：① 把二进制前滚回 >= " + strconv.FormatInt(e.AppliedMax, 10) +
			" 的那一版（推荐）；② 确认这些版本的 DDL 与本二进制兼容后，从 schema_migrations 里" +
			"删除这些条目（需明确知道自己在做什么）——**不要**直接改名/删库凑合。"
	default:
		action = "这些版本在库里有记录、但当前二进制的迁移目录里没有对应文件（历史上删过/改过号的迁移，" +
			"或手工写入的死条目）。请核对它们是否真的应用过：能确认是死条目就从 schema_migrations 里删除；" +
			"否则把对应迁移文件补回来。"
	}
	return fmt.Sprintf("schema 与二进制不同代：schema_migrations 里有 %d 个版本没有对应的迁移文件 %v"+
		"（二进制可见集合最大版本=%d，库内最大版本=%d）；%s。%s",
		len(e.Unknown), e.Unknown, e.MaxFile, e.AppliedMax, dir, action)
}

// MigrationChecksumError 是"库里登记的内容摘要与随包迁移文件不一致"的错误
// （R27-FIX39 ③，对应 R27 审计 AA2-09 / S1-F3 的**形态 B**）。
//
// 被审形态：`schema_migrations` 只记版本号、**不记内容**，于是"同一个版本号、两种
// 内容"这件事在两侧都完全不可见 —— 老库（该版本已应用）永远拿到旧 DDL，新装的库
// 拿到新 DDL，**同一个二进制产出两套 schema**，两边都 err=nil、零日志（S1 真跑：
// 改过 0058 后老库缺 `aa2_drift_probe`、新库有，`ApplyMigrations` 两次都返回 nil）。
//
// 口径（R27-FIX39 定案）：**fail-loud**，与 `SchemaMismatchError` 同一纪律 ——
// 这一类缺陷的全部危害同样来自"静默"，而启动期是唯一能给出可行动文案的位置。
// 兼容性（硬要求）：**老库（checksum 列出现之前的版本行）不拒绝启动**，
// 首启用随包文件回填一次（见 ApplyMigrations 的 R27-FIX39 ③ 段），此后冻结绑定。
type MigrationChecksumError struct {
	// Version 是冲突的迁移版本号。
	Version int
	// Name 是迁移文件名。
	Name string
	// Applied 是库里登记的内容摘要（写库那一刻的文件字节）。
	Applied string
	// Expected 是当前二进制里该迁移文件的内容摘要。
	Expected string
}

func (e *MigrationChecksumError) Error() string {
	return fmt.Sprintf("迁移内容与库内登记不符：version=%04d file=%s（库内 checksum=%s，随包文件 checksum=%s）。"+
		"两种成因：① 本二进制把**已发布**的迁移文件就地改写过（本仓明令禁止：已部署的库永不重放该版本、"+
		"新库却会执行新内容 ⇒ 同一个二进制在两种库上得到两套 schema）；② 这个库的 schema_migrations 行被手工改过。"+
		"两条可行动作：换回官方构建（推荐）；或确认两边 schema 真的等价后，用 "+
		"`UPDATE schema_migrations SET checksum='%s' WHERE version=%d` 显式承认当前二进制的内容。"+
		"**不要**删版本行逼它重放（重放整条迁移在存量库上不是幂等的）",
		e.Version, e.Name, `"`+e.Applied+`"`, `"`+e.Expected+`"`, e.Expected, e.Version)
}

// schemaUnknownVersions 是反向对账的**唯一实现**：库里已应用、但当前文件集合里
// 没有对应迁移的版本（升序）。
func schemaUnknownVersions(applied map[int64]bool, ms []migration) []int64 {
	known := make(map[int64]bool, len(ms))
	for _, m := range ms {
		known[int64(m.version)] = true
	}
	var out []int64
	for v := range applied {
		if !known[v] {
			out = append(out, v)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// schemaMaxVersion 返回文件集合的最大版本（0 = 空集合）。
func schemaMaxVersion(ms []migration) int64 {
	if len(ms) == 0 {
		return 0
	}
	return int64(ms[len(ms)-1].version) // ms 已按版本升序（loadMigrations 的返回约定）
}

// migrationLockKey 迁移互斥的 PG advisory lock key(固定常量,跨实例共享)。
const migrationLockKey = int64(0x5069636D) // "Picm"

// ---------------------------------------------------------------------------
// R27-FIX39：等锁预算 / 锁窗口可观测性 / 内容校验和
// ---------------------------------------------------------------------------

// 三个预算/阈值是同一条纪律的产物（R27 审计 AA2-07 = ★P1、S1-F1；真跑复现）：
//
//	迁移执行器此前**没有任何等锁预算** —— 启动那一刻只要有任一会话对目标表持冲突锁
//	（pg_dump 的 ACCESS SHARE、长分析查询、autovacuum、上一实例遗留的
//	`idle in transaction`），`ALTER TABLE` 就无界等待；而此时 HTTP 还没开始监听，
//	应用侧一行日志都不打。实测（真 PG + 真二进制）：
//	  · `timeout 60 <ApplyMigrations>` ⇒ EXIT=124，60s 内应用侧只有一行 PG 驱动转发的
//	    NOTICE（`pg_locks` 里是迁移自己的 AccessExclusiveLock granted=f）；
//	  · 真二进制 `cmd/server` 同场景 20.01s **零输出**；
//	  · 连 advisory lock 的等待也是 30.02s 零输出。
//
// 判据与危害同构（与 partitions.go 的 `probeUsagePartitionBudget` 同一条纪律：
// "谁受不了无界等待，谁才带预算"）：启动期迁移**受得了失败、受不了挂住** ——
// 挂住 = 容器永远停在 starting、编排器与运维都拿不到线索（旧实例还在服务）；
// 失败 = 一行可行动文案 + 容器退出 + 旧实例继续服务。运行期计量热路径**不**带预算
// （那里把等锁变失败 = 全站 503），这条区别是有意的，别"统一"。
const (
	// migrationDDLLockBudgetDefault 是**每条迁移事务**的等锁预算，用
	// `SET LOCAL lock_timeout` 施加在**真正执行该迁移 DDL 的那条会话**上
	// （见 applyOneMigration）。取 5 分钟的理由：① 迁移的合法时长由数据量决定
	// （0059 在 15 万行夹具上 19.4s，生产是百万行量级 ⇒ 分钟级正常）；② 而"等锁"
	// 这种慢是病态的，5 分钟远超任何正常 DDL 的等待；③ 有界即可：到期 fail-loud，
	// 运维停掉长事务重试、或用 env 收紧预算，代价远小于无界挂住。
	migrationDDLLockBudgetDefault = 5 * time.Minute
	// migrationAdvisoryLockBudgetDefault 是迁移互斥锁（`pg_advisory_lock`）的等待预算：
	// 滚动升级时另一个实例可能正在迁移（几十条迁移、分钟级），所以同样给 5 分钟。
	// 超时说明"另一个实例卡住了"，此时 fail-loud 比继续等更有价值。
	migrationAdvisoryLockBudgetDefault = 5 * time.Minute
	// migrationSlowWarnDefault 是"慢迁移"告警阈值（AA2-08：`ACCESS EXCLUSIVE` 窗口 =
	// **整个迁移文件**，0059 实测按住 apps 19.17s、期间该表读写全等到迁移结束）。
	// 超过它单独打一条可检索的 WARN，让运维能发现"这次升级锁了 19 秒"。
	migrationSlowWarnDefault = 5 * time.Second
	// migrationLockSampleInterval 是锁窗口采样间隔（见 migrationWatch）：250ms 足以
	// 抓住"秒级及更长"的 AE 窗口（运维关心的正是这种），又足够便宜。
	migrationLockSampleInterval = 250 * time.Millisecond
)

// 三个 env：只用来**调整**缺省预算（毫秒）。非法/非正值一律回落缺省并告警 ——
// 不许用一条 env（写 0 或写错）把预算变成"无预算"，那正是本修复要消灭的形态。
const (
	migrationDDLLockBudgetEnv      = "PICOAI_MIGRATION_LOCK_TIMEOUT_MS"
	migrationAdvisoryLockBudgetEnv = "PICOAI_MIGRATION_ADVISORY_TIMEOUT_MS"
	migrationSlowWarnEnv           = "PICOAI_MIGRATION_SLOW_MS"
)

// migrationDurationEnv 读一个毫秒级预算/阈值（见上）。
func migrationDurationEnv(name string, def time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return def
	}
	ms, err := strconv.Atoi(raw)
	if err != nil || ms <= 0 {
		log.Printf("migrate: ignoring invalid %s=%q (want positive milliseconds); using default %s", name, raw, def)
		return def
	}
	return time.Duration(ms) * time.Millisecond
}

// migrationObservation 是**单条迁移**的可观测事实（R27-FIX39 ②）。
//
// 为什么需要（AA2-08，无任何判据）：迁移的 `ACCESS EXCLUSIVE` 窗口是**整个迁移文件**
// 而不是那条 `ALTER` —— 0059 在 15 万行 `apps` 夹具上实测按住 `apps` **19.17s**
// （447/500 个 20ms 采样），期间该表的并发 SELECT/INSERT/UPDATE 全部等到迁移结束
// （21.1 / 18.6 / 18.8s）。而升级的人只看到"升级花了 20 秒"，看不到"有一张表被
// 独占锁了 19 秒"，更看不到是哪张表。
type migrationObservation struct {
	// Version / Name 是被观测的迁移。
	Version int
	Name    string
	// Elapsed 是该迁移事务的墙钟耗时（Begin → Commit）。
	Elapsed time.Duration
	// LockWait 是采样到的"等锁"累计时长（wait_event_type = Lock），0 = 未观察到。
	LockWait time.Duration
	// Waiting 报告采样期间是否观察到过等锁。
	Waiting bool
	// AEWindow 是采样到的 `AccessExclusiveLock` 持有窗口（**采样下界**：两次采样之间的
	// 起止点会各损失至多一个采样间隔；0 = 未观察到，含"窗口短于采样间隔"）。
	AEWindow time.Duration
	// AETables 是上述窗口内被 AE 锁住的关系名（升序）。
	AETables []string
	// Blockers 是观察到等锁时阻塞该迁移的会话（`pid:state`，升序）。
	Blockers []string
	// SlowAfter 是本次生效的慢迁移阈值；Slow = Elapsed > SlowAfter。
	SlowAfter time.Duration
	Slow      bool
	// Failed 报告这条迁移**没有成功**（DDL / 落账 / 提交失败）。失败同样要留下可观测
	// 事实（等了多久、被谁挡住），所以失败的观测照走 sink，只是行首词换成 failed。
	Failed bool
}

// migrationObservationSink 是观测结果的唯一出口：生产 = 打到标准日志（可检索），
// 测试 = 直接收结构体（`applyMigrations(db, sink)` 的接缝，见其注释）。
type migrationObservationSink func(migrationObservation)

// formatMigrationObservation 把观测结果格式化成**定宽键值**的一行，供
// `grep 'migrate: applied migration'` / `grep 'ae_window='` 使用。
func formatMigrationObservation(ob migrationObservation) string {
	verb := "applied"
	if ob.Failed {
		verb = "failed"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "migrate: %s migration %04d %s elapsed=%s",
		verb, ob.Version, ob.Name, ob.Elapsed.Round(time.Millisecond))
	if ob.Waiting {
		fmt.Fprintf(&b, " lock_wait=%s", ob.LockWait.Round(time.Millisecond))
	}
	if ob.AEWindow > 0 {
		fmt.Fprintf(&b, " ae_window=%s ae_tables=[%s]",
			ob.AEWindow.Round(time.Millisecond), strings.Join(ob.AETables, " "))
	} else {
		// 如实说明"没观测到"，而不是打印 0s（0s 会被读成"没有持锁"，
		// 而事实是"窗口短于采样间隔或采样不可用"）。
		b.WriteString(" ae_window=not-observed")
	}
	if len(ob.Blockers) > 0 {
		fmt.Fprintf(&b, " blocked_by=[%s]", strings.Join(ob.Blockers, " "))
	}
	return b.String()
}

// formatSlowMigration 是超过阈值时**单独**的一条 WARN 行（与上面那行分开，
// 便于告警规则只 grep 这一种前缀）。
func formatSlowMigration(ob migrationObservation) string {
	msg := fmt.Sprintf("migrate: SLOW migration %04d %s elapsed=%s exceeded %s",
		ob.Version, ob.Name, ob.Elapsed.Round(time.Millisecond), ob.SlowAfter)
	if ob.AEWindow > 0 {
		msg += fmt.Sprintf(" — held ACCESS EXCLUSIVE on [%s] for %s",
			strings.Join(ob.AETables, " "), ob.AEWindow.Round(time.Millisecond))
	} else if ob.Waiting {
		msg += fmt.Sprintf(" — waited on locks for %s", ob.LockWait.Round(time.Millisecond))
	}
	return msg + "; concurrent readers/writers of those tables were blocked for the same window" +
		" (raise PICOAI_MIGRATION_SLOW_MS to silence, or move the data backfill out of the structural migration)"
}

// migrationObservationSinkDefault 是生产出口：两条可检索日志行（慢迁移时两条）。
var migrationObservationSinkDefault migrationObservationSink = func(ob migrationObservation) {
	log.Print(formatMigrationObservation(ob))
	if ob.Slow {
		log.Print(formatSlowMigration(ob))
	}
}

// migrationWatch 在迁移执行期间**从 advisory-lock 那条连接**采样
// `pg_locks` / `pg_stat_activity`，回答两个问题：① 这条迁移有没有在等锁（等谁）；
// ② 它拿到了多久的 ACCESS EXCLUSIVE（AA2-08 的"取到 AE 的时刻"）。
//
// 为什么必须另开一条会话：等锁的会话自己正卡在锁上，同一条会话查不出任何东西；
// 而 PG 不提供"锁的持有时间"（`pg_locks` 无时间戳、`pg_stat_activity` 无锁等待累计）
// ⇒ 采样是唯一可行的观测手段（S1 的 20ms 采样正是这么量出 19.17s 的）。
//
// 为什么用 advisory-lock 那条连接而不是新借一条：那条连接在迁移循环期间**本来就
// 闲置**（它只持有会话级 advisory lock），复用它既不需要额外的池位、也不会在
// "池上限很小"的部署里把 DDL 事务饿死（新借一条会把池位从 2 变成 3，池上限=2 时
// 直接死锁）。`*sql.Conn` 本身对并发使用是安全的（database/sql 会串行化）。
//
// **失败开放**：采样查询失败只记一次日志，迁移照常进行 —— 观测不能成为启动失败的
// 新原因，也不能改变迁移语义。
type migrationWatch struct {
	conn     *sql.Conn
	interval time.Duration

	stop chan struct{}
	done chan struct{}

	mu          sync.Mutex
	active      bool
	pid         int
	version     int
	name        string
	waiting     time.Duration
	waitingSeen bool
	blockers    map[string]bool
	aeFrom      time.Time
	aeTo        time.Time
	aeTables    map[string]bool
	sampleErr   bool
}

// startMigrationWatch 启动采样协程；conn 为 nil 时返回 nil（方法对 nil 接收者安全，
// 于是调用点不必到处判空）。
func startMigrationWatch(conn *sql.Conn) *migrationWatch {
	if conn == nil {
		return nil
	}
	w := &migrationWatch{
		conn:     conn,
		interval: migrationLockSampleInterval,
		stop:     make(chan struct{}),
		done:     make(chan struct{}),
		blockers: map[string]bool{},
		aeTables: map[string]bool{},
	}
	go w.run()
	return w
}

func (w *migrationWatch) run() {
	defer close(w.done)
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()
	for {
		select {
		case <-w.stop:
			return
		case <-ticker.C:
			w.sampleLockState()
		}
	}
}

// close 停止采样并等它退出（nil 安全）。调用点必须在 advisory unlock **之前**完成
// —— 采样与 unlock 共用同一条连接，必须先停采样。
func (w *migrationWatch) close() {
	if w == nil {
		return
	}
	select {
	case <-w.stop: // 已经关过
	default:
		close(w.stop)
	}
	<-w.done
}

// begin 把采样目标切到一条新迁移（pid = 该迁移事务的 backend pid；0 = 观测不到，
// 只记墙钟）。
func (w *migrationWatch) begin(version int, name string, pid int) {
	if w == nil {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	w.version, w.name, w.pid = version, name, pid
	w.active = pid > 0
	w.waiting, w.waitingSeen = 0, false
	w.blockers, w.aeTables = map[string]bool{}, map[string]bool{}
	w.aeFrom, w.aeTo = time.Time{}, time.Time{}
}

// collect 结束对当前迁移的观测并返回这一条迁移的可观测事实。
func (w *migrationWatch) collect(version int, name string, elapsed, slowAfter time.Duration) migrationObservation {
	ob := migrationObservation{
		Version: version, Name: name, Elapsed: elapsed,
		SlowAfter: slowAfter, Slow: elapsed > slowAfter,
	}
	if w == nil {
		return ob
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	ob.Waiting = w.waitingSeen
	ob.LockWait = w.waiting
	if !w.aeFrom.IsZero() {
		ob.AEWindow = w.aeTo.Sub(w.aeFrom)
		ob.AETables = sortedKeys(w.aeTables)
	}
	ob.Blockers = sortedKeys(w.blockers)
	w.active, w.pid = false, 0
	w.version, w.name = 0, ""
	return ob
}

// sampleLockState 取一次样本（见函数内的 sampleSQL 与类型注释）。
func (w *migrationWatch) sampleLockState() {
	// 采样 SQL：一次往返同时回答"当前迁移是否在等锁 / 等谁"与"它此刻持有哪些关系的
	// ACCESS EXCLUSIVE"。
	//
	// 四个 `?` 都绑同一个 backend pid（`?`→`$N` 重写层负责转换）。`pg_blocking_pids`
	// 只在**真的在等**时返回非空，而"被谁挡住"必须在这一刻取 —— 迁移超时回滚之后
	// 那把等待就消失了，事后 `pg_blocking_pids(pid)` 永远是空（这正是它必须靠采样
	// 才能拿到诊断信息的原因）。
	//
	// 只读 `pg_catalog` / `pg_locks` / `pg_stat_activity`：没有对任何**族内关系**的
	// 动作，也不需要 pin search_path（pg_catalog 恒在 search_path 最前）。
	const sampleSQL = `SELECT
  (SELECT count(*) FROM pg_locks WHERE pid = ? AND locktype = 'relation' AND granted AND mode = 'AccessExclusiveLock'),
  EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = ? AND wait_event_type = 'Lock'),
  COALESCE((SELECT string_agg(DISTINCT c.relname, ' ') FROM pg_locks l
              JOIN pg_class c ON c.oid = l.relation
             WHERE l.pid = ? AND l.locktype = 'relation' AND l.granted AND l.mode = 'AccessExclusiveLock'), ''),
  COALESCE((SELECT string_agg(DISTINCT b::text || ':' || COALESCE(a.state, '?'), ' ')
              FROM unnest(pg_blocking_pids(?)) b
              LEFT JOIN pg_stat_activity a ON a.pid = b), '')`

	w.mu.Lock()
	if !w.active || w.pid == 0 {
		w.mu.Unlock()
		return
	}
	pid, version, name := w.pid, w.version, w.name
	w.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	var ae int
	var waiting bool
	var tables, blockers string
	if err := w.conn.QueryRowContext(ctx, sampleSQL, pid, pid, pid, pid).
		Scan(&ae, &waiting, &tables, &blockers); err != nil {
		w.noteSampleError(pid, err)
		return
	}
	now := time.Now()
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.active || w.pid != pid {
		return // 已经切到下一条迁移
	}
	if waiting {
		w.waiting += w.interval
		if !w.waitingSeen {
			// "等锁中"这一行是排障的关键（修复前整个启动期零输出）：
			// 它把"挂住"与"慢慢跑"在日志里分开，并点名阻塞者。
			w.waitingSeen = true
			log.Printf("migrate: migration %04d %s waiting for a lock (blocked_by=[%s])", version, name, blockers)
		}
	}
	for _, b := range strings.Fields(blockers) {
		w.blockers[b] = true
	}
	if ae > 0 {
		if w.aeFrom.IsZero() {
			w.aeFrom = now
		}
		w.aeTo = now
		for _, t := range strings.Fields(tables) {
			w.aeTables[t] = true
		}
	}
}

// noteSampleError 只记一次采样失败（观测是尽力而为，不能刷日志、不能影响迁移）。
func (w *migrationWatch) noteSampleError(pid int, err error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.sampleErr {
		return
	}
	w.sampleErr = true
	log.Printf("migrate: lock-window sampling disabled for backend pid=%d (%v); migration continues", pid, err)
}

// sortedKeys 返回集合的升序切片（观测行要**稳定**，否则每次启动的日志顺序不同，
// 无法做 diff/告警规则）。
func sortedKeys(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// applyOneMigration 在**一条独立事务**里应用一条迁移（DDL 与它的版本行必须原子：
// 半应用 = schema 与账本不一致，本仓历史事故的同一形态）。
//
// 等锁预算（R27-FIX39 ①）承重的一点：`SET LOCAL lock_timeout` 设在**本事务**上，
// 也就是真正执行 DDL 的那条会话。advisory lock 拿在**另一条**连接上
// （ApplyMigrations 的 conn），所以"把预算设在 advisory 连接上"这种写法对这里的
// DDL **完全无效** —— DDL 跑在池里的另一条会话上（R27 审计 AA2 已实测证伪：
// 预算设在 advisory 连接上仍然 60s+ 挂死；同样预算设在本事务上 6s 响亮失败）。
// 变异 B（把预算挪回 advisory 连接）必须让 TestMigrationDDLLockBudget* 变红。
func applyOneMigration(ctx context.Context, db *sql.DB, m migration, lockBudget, slowAfter time.Duration, watch *migrationWatch) (migrationObservation, error) {
	log.Printf("migrate: applying migration %04d %s (lock_budget=%s)", m.version, m.name, lockBudget)
	start := time.Now()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return migrationObservation{}, fmt.Errorf("migration %04d %s: begin: %w", m.version, m.name, err)
	}
	defer tx.Rollback() //nolint:errcheck // 提交成功后回滚是 no-op
	if _, err := tx.ExecContext(ctx, fmt.Sprintf("SET LOCAL lock_timeout = '%dms'", lockBudget.Milliseconds())); err != nil {
		return migrationObservation{}, fmt.Errorf("migration %04d %s: set lock budget (%s): %w", m.version, m.name, lockBudget, err)
	}
	// 观测目标 = 本事务的 backend pid（拿不到就只记墙钟，不影响迁移）。
	pid := 0
	if watch != nil {
		if err := tx.QueryRowContext(ctx, "SELECT pg_backend_pid()").Scan(&pid); err != nil {
			pid = 0
		}
		watch.begin(m.version, m.name, pid)
	}
	if _, err := tx.ExecContext(ctx, m.sql); err != nil {
		ob := watch.collect(m.version, m.name, time.Since(start), slowAfter)
		ob.Failed = true
		return ob, migrationExecError(m, err, ob, lockBudget)
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO schema_migrations (version, checksum) VALUES (?, ?)",
		m.version, m.checksum()); err != nil {
		ob := watch.collect(m.version, m.name, time.Since(start), slowAfter)
		ob.Failed = true
		return ob, fmt.Errorf("migration %04d %s: record version row: %w", m.version, m.name, err)
	}
	if err := tx.Commit(); err != nil {
		ob := watch.collect(m.version, m.name, time.Since(start), slowAfter)
		ob.Failed = true
		return ob, fmt.Errorf("migration %04d %s: commit: %w", m.version, m.name, err)
	}
	return watch.collect(m.version, m.name, time.Since(start), slowAfter), nil
}

// migrationExecError 把迁移事务里的失败包装成**点名迁移号 + SQLSTATE +（拿得到时）
// 阻塞者**的可行动文案 —— "响亮"是 R27-FIX39 ① 的硬要求：修复前这条路径只有
// "无界静默挂住"，现在必须在一行里说清"哪一条迁移、等了多久、被谁挡住、怎么办"。
func migrationExecError(m migration, err error, ob migrationObservation, lockBudget time.Duration) error {
	blocked := ""
	if len(ob.Blockers) > 0 {
		blocked = fmt.Sprintf(" blocked_by=[%s]", strings.Join(ob.Blockers, " "))
	}
	code, hasCode := pgErrorCode(err)
	if hasCode && code == pgSQLStateLockNotAvailable {
		return fmt.Errorf("migration %04d %s: 等表锁超时（SQLSTATE %s，预算 %s，已等 %s）%s —— "+
			"有会话对该迁移要改的表持冲突锁（备份/长查询/idle in transaction 都可能）；"+
			"停掉阻塞者后重试，或用 PICOAI_MIGRATION_LOCK_TIMEOUT_MS 调整预算: %w",
			m.version, m.name, code, lockBudget, ob.Elapsed.Round(time.Millisecond), blocked, err)
	}
	if hasCode {
		return fmt.Errorf("migration %04d %s failed after %s (SQLSTATE %s)%s: %w",
			m.version, m.name, ob.Elapsed.Round(time.Millisecond), code, blocked, err)
	}
	return fmt.Errorf("migration %04d %s failed after %s%s: %w",
		m.version, m.name, ob.Elapsed.Round(time.Millisecond), blocked, err)
}

// ApplyMigrations creates the schema_migrations table and applies all pending
// migrations, each in its own transaction. It is idempotent.
// P2-2:整个迁移循环用会话级 pg_advisory_lock 包住——多实例并发启动时,
// 「查已应用 → 逐条 Begin/Commit」的竞态会让两个实例同时执行同一条迁移
// (CREATE TABLE 竞态、schema_migrations 唯一键冲突、半套 schema)。
// 锁持有在专用连接上,defer 释放(连接归还池前解锁)。
//
// R6-A-3(审计 2026-09-23,P2):执行任何 DB 操作**之前**先做迁移文件的形状自检
// (loadMigrations)。判据与 applied 快照无关 ⇒ 每一次启动都会判,包括"上一次
// 已经应用了一半"的第二次启动(旧实现正是在第二次启动静默跳过重复版本号的后一条)。
//
// R27-FIX39:① 每条迁移事务带**有界等锁预算**（超时 fail-loud，点名迁移号与 SQLSTATE）；
// ② 每条迁移**前后各一条日志** + 锁窗口采样（慢迁移单独 WARN）；
// ③ 已应用迁移的**内容摘要**与随包文件对账（不一致 fail-loud；老库首启回填）。
func ApplyMigrations(db *sql.DB) error {
	return applyMigrations(db, nil)
}

// applyMigrations 是 ApplyMigrations 的实现体；sink 为 nil 时用生产日志出口。
// 把出口做成参数（而不是包级变量）是为了让判据能在**不污染进程全局状态**的前提下
// 拿到观测结构体：测试直接调 applyMigrations(db, recorder)，生产恒走 ApplyMigrations。
func applyMigrations(db *sql.DB, sink migrationObservationSink) error {
	if sink == nil {
		sink = migrationObservationSinkDefault
	}
	ms, err := currentMigrations()
	if err != nil {
		return err
	}
	ctx := context.Background()
	conn, err := db.Conn(ctx)
	if err != nil {
		return fmt.Errorf("migration lock conn: %w", err)
	}
	defer conn.Close()

	// R27-FIX39 ①：advisory lock 的等待也要有界（实测 30.02s 零输出）。
	// 预算**只**作用在这一次 advisory 等待上，拿到锁（或失败）后立刻复原这条会话 ——
	// 会话级 SET 会随连接归还池而泄漏给后续业务查询，而且这条会话不是执行 DDL 的
	// 那条（DDL 的预算由每个迁移事务自己 SET LOCAL，见 applyOneMigration）。
	advisoryBudget := migrationDurationEnv(migrationAdvisoryLockBudgetEnv, migrationAdvisoryLockBudgetDefault)
	lockStart := time.Now()
	log.Printf("migrate: acquiring migration lock (advisory key=%d, budget=%s) — another instance may be migrating",
		migrationLockKey, advisoryBudget)
	if _, err := conn.ExecContext(ctx, fmt.Sprintf("SET lock_timeout = '%dms'", advisoryBudget.Milliseconds())); err != nil {
		return fmt.Errorf("migration lock: set wait budget: %w", err)
	}
	_, lockErr := conn.ExecContext(ctx, "SELECT pg_advisory_lock(?)", migrationLockKey)
	if _, rerr := conn.ExecContext(context.Background(), "RESET lock_timeout"); rerr != nil {
		return fmt.Errorf("migration lock: reset session lock_timeout: %w", rerr)
	}
	if lockErr != nil {
		if code, ok := pgErrorCode(lockErr); ok && code == pgSQLStateLockNotAvailable {
			return fmt.Errorf("migration lock: 等待迁移互斥锁超时（预算 %s 内没拿到 pg_advisory_lock(%d)，SQLSTATE %s）—— "+
				"另一个实例可能正在迁移、或上一次迁移留下了未释放的会话；确认没有其它实例在迁移后重试"+
				"（可用 PICOAI_MIGRATION_ADVISORY_TIMEOUT_MS 调整预算）: %w",
				advisoryBudget, migrationLockKey, code, lockErr)
		}
		return fmt.Errorf("acquire migration lock: %w", lockErr)
	}
	log.Printf("migrate: migration lock acquired (%s)", time.Since(lockStart).Round(time.Millisecond))
	defer func() {
		_, _ = conn.ExecContext(context.Background(), "SELECT pg_advisory_unlock(?)", migrationLockKey)
	}()

	// schema_migrations 是执行器**自有**的账本表（建表语句就在本函数里，不走迁移
	// 文件），所以加列也在同处：迁移文件没法跑在"迁移循环自己往这张表 INSERT"之前
	// ——0083 会是最末一条，而它之前的每一条迁移都要写 checksum 列。因此这里不用
	// 新增迁移文件：迁移区间行的上限仍然是 0082，`migrations-checksums.json`
	// 与已发布迁移的字节一个都不动。
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		version INTEGER PRIMARY KEY,
		applied_at ` + TimestampType() + ` DEFAULT (` + NowExpr() + `),
		checksum TEXT
	)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}
	// 老库（checksum 列出现之前建的 schema_migrations）补列：IF NOT EXISTS 幂等。
	if _, err := db.Exec(`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT`); err != nil {
		return fmt.Errorf("add schema_migrations.checksum: %w", err)
	}
	applied := map[int64]bool{}
	checksums := map[int64]string{}
	rows, err := db.Query("SELECT version, checksum FROM schema_migrations")
	if err != nil {
		return err
	}
	for rows.Next() {
		var v int64
		var cs sql.NullString
		if err := rows.Scan(&v, &cs); err != nil {
			rows.Close()
			return err
		}
		applied[v] = true
		checksums[v] = cs.String // NULL / 空串都落成 ""（= 未登记）
	}
	rows.Close()

	// R13-GE（R13A-03）：**反向对账** —— 库里存在、而当前文件集合里没有对应迁移的
	// 版本必须 fail-loud（旧实现只做"文件 → DB"单向遍历，DB 里多出来的版本
	// err=nil、零日志、零告警）。
	//
	// 为什么在 `testMigrationHook != nil` 时跳过：那个接缝是**测试专用**的迁移集合
	// 注入点（`currentMigrations` 的注释已说明它"绕过形状自检"），而迁移语义夹具
	// 的固定手法就是"先只应用到 00NN 造升级前的库，再应用 00NN+1" —— 此时库里
	// 必然有大量"不在注入集合里"的版本，那不是产品缺陷。生产路径（hook == nil，
	// 走 embedded FS）永远做这次对账。
	if testMigrationHook == nil {
		if unknown := schemaUnknownVersions(applied, ms); len(unknown) > 0 {
			appliedMax := int64(0)
			for v := range applied {
				if v > appliedMax {
					appliedMax = v
				}
			}
			return &SchemaMismatchError{Unknown: unknown, MaxFile: schemaMaxVersion(ms), AppliedMax: appliedMax}
		}
	}

	// R27-FIX39 ③：**内容对账** —— 已应用迁移的字节摘要必须与随包文件一致。
	//
	// 前向兼容（硬要求）：checksum 列出现之前的版本行没有摘要（NULL），此时**绝不
	// 拒绝启动**，而是用随包文件**回填一次**并在日志里点名 —— 此后这个库就与"首次
	// 见到它的那一版文件"冻结绑定，后续任何就地改写都会在启动期被抓住。回填的
	// 代价如实登记：对一个**从未**被 checksum 覆盖过的老库，"历史上改过文件"这件事
	// 本身不可考（没有任何历史摘要可比），只能从回填那一刻起生效。
	//
	// 与反向对账同一条理由跳过测试钩子：夹具注入的迁移正文不是真实文件内容。
	if testMigrationHook == nil {
		byVersion := make(map[int64]migration, len(ms))
		for _, m := range ms {
			byVersion[int64(m.version)] = m
		}
		var backfill []int64
		for _, m := range ms {
			if !applied[int64(m.version)] {
				continue
			}
			want := m.checksum()
			switch got := checksums[int64(m.version)]; {
			case got == want:
				// 一致，无事。
			case got == "":
				backfill = append(backfill, int64(m.version))
			default:
				return &MigrationChecksumError{
					Version: m.version, Name: m.name, Applied: got, Expected: want,
				}
			}
		}
		if len(backfill) > 0 {
			for _, v := range backfill {
				m := byVersion[v]
				if _, err := db.Exec("UPDATE schema_migrations SET checksum = ? WHERE version = ? AND checksum IS NULL",
					m.checksum(), v); err != nil {
					return fmt.Errorf("backfill schema_migrations.checksum for %04d: %w", v, err)
				}
			}
			log.Printf("migrate: backfilled content checksums for %d migration(s) applied before checksums existed "+
				"(low=%04d high=%04d); any later in-place edit of those files will now fail loud at startup",
				len(backfill), backfill[0], backfill[len(backfill)-1])
		}
	}

	ddlBudget := migrationDurationEnv(migrationDDLLockBudgetEnv, migrationDDLLockBudgetDefault)
	slowAfter := migrationDurationEnv(migrationSlowWarnEnv, migrationSlowWarnDefault)
	pending := 0
	for _, m := range ms {
		if !applied[int64(m.version)] {
			pending++
		}
	}
	if pending == 0 {
		log.Printf("migrate: schema up to date (head=%04d, %d migrations applied)", schemaMaxVersion(ms), len(applied))
		return nil
	}
	log.Printf("migrate: %d pending migration(s) (head=%04d, lock_budget=%s, slow_warn=%s)",
		pending, schemaMaxVersion(ms), ddlBudget, slowAfter)

	// 采样用的会话 = advisory-lock 那条（它在循环期间闲置，见 migrationWatch 注释）。
	// defer 顺序是承重的：watch.close() 必须先于 advisory unlock 跑完（同一个 *sql.Conn）。
	watch := startMigrationWatch(conn)
	defer watch.close()

	appliedCount := 0
	for _, m := range ms {
		if applied[int64(m.version)] {
			continue
		}
		ob, err := applyOneMigration(ctx, db, m, ddlBudget, slowAfter, watch)
		// ob.Version != 0 = 这条迁移的事务真的开始过（Begin / 预算设置就失败时没有观测）。
		// 失败的迁移**同样**要输出观测：等锁时长与阻塞者正是排障要看的东西。
		if ob.Version != 0 {
			sink(ob)
		}
		if err != nil {
			log.Printf("migrate: migration %04d %s FAILED after %s: %v",
				m.version, m.name, ob.Elapsed.Round(time.Millisecond), err)
			return err
		}
		appliedCount++
	}
	log.Printf("migrate: applied %d migration(s) (head=%04d)", appliedCount, schemaMaxVersion(ms))
	return nil
}

// EnsureMigrated opens the DB with the given config and applies migrations.
func EnsureMigrated(cfg DBConfig) (*sql.DB, error) {
	db, err := Open(cfg)
	if err != nil {
		return nil, err
	}
	if err := ApplyMigrations(db); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}
