package serverstore

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

//go:embed migrations-pg/*.sql
var migrationFS embed.FS

type migration struct {
	version int
	name    string
	sql     string
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
func ApplyMigrations(db *sql.DB) error {
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
	if _, err := conn.ExecContext(ctx, "SELECT pg_advisory_lock(?)", migrationLockKey); err != nil {
		return fmt.Errorf("acquire migration lock: %w", err)
	}
	defer func() {
		_, _ = conn.ExecContext(context.Background(), "SELECT pg_advisory_unlock(?)", migrationLockKey)
	}()
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		version INTEGER PRIMARY KEY,
		applied_at ` + TimestampType() + ` DEFAULT (` + NowExpr() + `)
	)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}
	applied := map[int64]bool{}
	rows, err := db.Query("SELECT version FROM schema_migrations")
	if err != nil {
		return err
	}
	for rows.Next() {
		var v int64
		if err := rows.Scan(&v); err != nil {
			rows.Close()
			return err
		}
		applied[v] = true
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

	for _, m := range ms {
		if applied[int64(m.version)] {
			continue
		}
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(m.sql); err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %04d %s: %w", m.version, m.name, err)
		}
		if _, err := tx.Exec("INSERT INTO schema_migrations (version) VALUES (?)", m.version); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
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
