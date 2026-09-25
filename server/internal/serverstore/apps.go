// Package serverstore — 统一应用模型 DAO(迁移 0053/0054)。
//
// 决策 docs/decisions/2026-09-01-skill-app-management.md P2:技能与智能体
// 统一为 App(长期身份)+ Release(不可变版本快照)。本文件是该模型的唯一
// 数据访问层——旧的 skills/shared_skills/agent_presets DAO 在兼容期内保留
// 只读,新写入一律走这里。
package serverstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// App 分发渠道与内容类型的合法取值。
const (
	AppChannelMarket = "market"
	AppChannelOrg    = "org"
	AppKindSkill     = "skill"
	AppKindAgent     = "agent"
)

// Release 审核状态(与旧三表一致,迁移不改变审核语义)。
const (
	ReleaseStatusPending  = "pending"
	ReleaseStatusApproved = "approved"
	ReleaseStatusRejected = "rejected"
)

// App 是一个能力的长期身份:名字、归属、渠道、上下架状态与授权都挂在它上面。
type App struct {
	Kind        string
	AppID       string
	Title       string
	Description string
	Owner       string
	Channel     string
	Enabled     int
	// Official 官方属性(0059, App 级): 1=归属官方(蓝标/仅管理员可上传),
	// 此时 Owner 为 ''(无个人归属)。
	Official  int
	CreatedAt time.Time
	UpdatedAt time.Time
}

// Release 是一次不可变的版本快照。内容字段一经写入不再更新,只有审核状态、
// 质量标记、下载计数与软删标记可变。
type Release struct {
	ID          int64
	Kind        string
	AppID       string
	Version     string
	Title       string
	Description string
	Changelog   string
	Category    string
	Tags        []string
	Author      string // 包内署名
	Publisher   string // 发布账号(登录态,不可伪造)
	Checksum    string
	Size        int64
	Archive     []byte
	Status      string
	Reason      string
	Quality     string
	Downloads   int64
	Calls       int64
	DeletedAt   *time.Time
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

const appColumns = "kind, app_id, title, description, owner, channel, enabled, official, created_at, updated_at"

// releaseListColumns 不含 archive blob:清单查询绝不加载全部归档。
const releaseListColumns = "id, kind, app_id, version, title, description, changelog, category, tags, " +
	"author, publisher, checksum, size, status, reason, quality, downloads, calls, deleted_at, created_at, updated_at"

const releaseFullColumns = "id, kind, app_id, version, title, description, changelog, category, tags, " +
	"author, publisher, checksum, size, status, reason, quality, downloads, calls, deleted_at, created_at, updated_at, archive"

func scanApp(row interface{ Scan(...any) error }) (*App, error) {
	var a App
	var created, updated any
	if err := row.Scan(&a.Kind, &a.AppID, &a.Title, &a.Description, &a.Owner, &a.Channel,
		&a.Enabled, &a.Official, &created, &updated); err != nil {
		return nil, err
	}
	a.CreatedAt, a.UpdatedAt = parseSQLTime(created), parseSQLTime(updated)
	return &a, nil
}

func scanRelease(row interface{ Scan(...any) error }, withArchive bool) (*Release, error) {
	var r Release
	var tags string
	var deleted, created, updated any
	dest := []any{&r.ID, &r.Kind, &r.AppID, &r.Version, &r.Title, &r.Description, &r.Changelog,
		&r.Category, &tags, &r.Author, &r.Publisher, &r.Checksum, &r.Size, &r.Status, &r.Reason,
		&r.Quality, &r.Downloads, &r.Calls, &deleted, &created, &updated}
	if withArchive {
		dest = append(dest, &r.Archive)
	}
	if err := row.Scan(dest...); err != nil {
		return nil, err
	}
	if tags != "" {
		_ = json.Unmarshal([]byte(tags), &r.Tags)
	}
	if deleted != nil {
		t := parseSQLTime(deleted)
		r.DeletedAt = &t
	}
	r.CreatedAt, r.UpdatedAt = parseSQLTime(created), parseSQLTime(updated)
	return &r, nil
}

// UpsertApp 建立或更新一个 App 身份(幂等)。渠道一经确定不再变更——跨渠道
// 迁移属于人工决策,不应由一次发布静默改写。
//
// 冲突分支带**官方归属守卫**(`official=1 ⇒ owner=”`,R15C-G-04):与 wasm 面的
// UpsertWasmApp 逐字同形,理由见 upsertApp 的注释。
func UpsertApp(db *sql.DB, a *App) error {
	return upsertApp(db, a)
}

// RecomputeAppProjection 把 apps 行的**展示投影列**(title/description)重算为
// "最新 approved 版本"的值,返回生效版本号(没有任何 approved 版本时返回 "")。
//
// 为什么必须有这一步(审计 2026-09-23 G-P2-3):apps 行是**目录对全员下发的
// 投影**(技能/智能体/应用共用同一张表),而 app_releases 才是真相。发布内核
// 只保证"待审版本不提前投影"(见 appstore.Publish 的 pending 分支),审核落定
// 之后还必须把投影**切到**生效版本:
//
//   - approve:新版本成为生效版本 ⇒ 投影切到它(漏掉这一步 = "批准了却永远
//     看不到新标题");
//   - reject :被拒版本从未生效 ⇒ 投影**恢复**成仍在生效的那一版(漏掉这一步 =
//     被拒/被撤回的标题永久留在目录上,而且没有任何自愈路径 —— 必须等下一次
//     approved 发布才会被覆盖)。
//
// 取最高 approved 而不是"本次审核的版本":审批一个更旧的待审版本时(v2 待审、
// v3 已通过),生效版本仍是更新的那个 —— 与线上交付(max(id) approved)同口径。
//
// 没有任何 approved 版本(首版待审被拒)时回落到 **app_id 占位**:空标题不是
// 可接受的终态(目录/详情/导出都直接读这一列),而 app_id 至少是可识别、可定位
// 的占位值 —— 与发布期首版待审的占位口径一致。
//
// **幂等且最小写入**:值没变就不写(updated_at 不跳),因此重复调用能自愈脏行、
// 且第二次调用零副作用。
//
// 2026-09-25(R15C-G-02):整个"读最高 approved 版本 → 写投影"必须收在**同一个事务 +
// apps 行锁**里。旧实现是 autocommit 下的两条语句,两个管理员并发审批两个待审版本
// 时会丢更新:后写者用自己那一刻读到的**陈旧快照**覆盖先写者,终态是
// `app_releases` 里最高 approved 已是 v3、而 `apps.title/description` 停在 v1 ——
// 目录、详情、导出都读 apps 行,于是**全组织看到的标题属于一个已经过期的版本**,
// 而且此后没有任何路径会修回来(发布内核的 pending 分支刻意"投影一字不动",
// 只有下一次 approve/reject 才会再走到这里)。
//
// 为什么是"先锁 apps 行、再读版本",而不是把判定推进 UPDATE 的子查询:后者只保证
// 写入值与**该语句的**快照一致,返回值(调用方要的"生效版本号")仍来自另一条
// 陈旧读;而行锁把"读版本快照"与"写投影"绑成一个串行单元 —— 与 serverstore 既有
// 的读-改-写范式一致(见 users.go 的 FOR UPDATE 与 gateway.go 的同款注释)。
// 锁粒度选 apps 行:投影的唯一写入口就是这里,而它写的正是这一行;锁 release 行
// 既锁不住"另一个版本被 approve",又会与发布路径(apps 行 → app_releases)反序死锁。
func RecomputeAppProjection(db *sql.DB, kind, appID string) (string, error) {
	tx, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback() //nolint:errcheck // Commit 之后是 no-op
	// 行不存在时 `FOR UPDATE` 锁不到东西(也不报错):此时下面的 UPDATE 同样是 0 行,
	// 与旧实现"没有 apps 行"的语义逐字一致(返回值仍按版本表算)。
	var locked int
	if err := tx.QueryRow(`SELECT 1 FROM apps WHERE kind = ? AND app_id = ? FOR UPDATE`,
		kind, appID).Scan(&locked); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	var version, title, description string
	err = tx.QueryRow(`SELECT version, title, description FROM app_releases
		WHERE kind = ? AND app_id = ? AND status = ? AND deleted_at IS NULL
		ORDER BY id DESC LIMIT 1`, kind, appID, ReleaseStatusApproved).
		Scan(&version, &title, &description)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		version, title, description = "", appID, ""
	case err != nil:
		return "", err
	}
	if _, err := tx.Exec(`UPDATE apps SET title = ?, description = ?, updated_at = `+NowExpr()+`
		WHERE kind = ? AND app_id = ? AND (title <> ? OR description <> ?)`,
		title, description, kind, appID, title, description); err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	return version, nil
}

// upsertApp 是 UpsertApp 的 executor 版本(可传入 *sql.Tx,供原子发布复用)。
//
// **官方归属守卫**(R15C-G-04,与 UpsertWasmApp 的 R3-A A-9 逐字同形):
// `official=1 ⇒ owner=”` 是迁移 0059/P2-21 的不变量,`SetAppOfficial` 对
// "official=1 ∧ owner≠”"直接返回 ErrValidation。而本函数的 COALESCE 分支恰好能
// 造出那个禁止状态:官方行的 owner 本来就是空串,于是
// `COALESCE(NULLIF(”,”), excluded.owner)` 把归属填成发布者、official 仍是 1 ——
// 聚合面随后把这条官方内容当成"某人的应用"(is_owner 为真而发布仍被拒)。
//
// 两个孪生 upsert 曾经只有 wasm 那一侧有守卫,技能/智能体这一侧没有 ——
// 与 A-9 同一条纪律:**不变量必须在唯一写入口成立,与调用点无关**
// (调用点今天恰好传了现值不构成防线;`marketplace/agent_api.go` 的
// createAgentAdmin 就是先查后 upsert 的冲突分支)。
func upsertApp(ex queryer, a *App) error {
	if a.Kind != AppKindSkill && a.Kind != AppKindAgent {
		return errors.New("invalid app kind")
	}
	if a.Channel != AppChannelMarket && a.Channel != AppChannelOrg {
		return errors.New("invalid app channel")
	}
	_, err := ex.Exec(`INSERT INTO apps (kind, app_id, title, description, owner, channel, enabled)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (kind, app_id) DO UPDATE SET
			title = excluded.title, description = excluded.description,
			owner = CASE WHEN apps.official = 1 THEN ''
				ELSE COALESCE(NULLIF(apps.owner, ''), excluded.owner) END,
			updated_at = `+NowExpr(),
		a.Kind, a.AppID, a.Title, a.Description, a.Owner, a.Channel, a.Enabled)
	return err
}

// Queryer 是 *sql.DB / *sql.Tx / *sql.Conn 的公共子集(groups.go 的内部
// queryer 只含 QueryRow/Exec,这里因为要读版本清单,把 Query 一并列出)。
//
// 2026-09-13(N-2):发布路径必须把咨询锁与全部读写放在**同一条连接**上 ——
// 「持锁连接 + 干活连接」的方案在连接需求 > 池上限时会死锁,而不同名并发
// 上传在生产里是正常负载。因此这些 DAO 需要「在调用方给定的事务里执行」
// 的变体(后缀 On)。
type Queryer interface {
	QueryRow(query string, args ...any) *sql.Row
	Query(query string, args ...any) (*sql.Rows, error)
	Exec(query string, args ...any) (sql.Result, error)
}

// GetAppOn 是 GetApp 的 executor 版本(可在 *sql.Tx 上执行)。
func GetAppOn(ex Queryer, kind, appID string) (*App, error) {
	a, err := scanApp(ex.QueryRow(`SELECT `+appColumns+` FROM apps WHERE kind = ? AND app_id = ?`, kind, appID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return a, err
}

// ListReleasesOn 是 ListReleases 的 executor 版本(可在 *sql.Tx 上执行)。
func ListReleasesOn(ex Queryer, kind, appID string) ([]Release, error) {
	rows, err := ex.Query(`SELECT `+releaseListColumns+` FROM app_releases
		WHERE kind = ? AND app_id = ? ORDER BY created_at`, kind, appID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return collectReleases(rows)
}

// PendingReleaseCountOn 是 PendingReleaseCount 的 executor 版本。
func PendingReleaseCountOn(ex Queryer, publisher string) (int, error) {
	var n int
	err := ex.QueryRow(`SELECT count(*) FROM app_releases
		WHERE publisher = ? AND status = 'pending' AND deleted_at IS NULL`, publisher).Scan(&n)
	return n, err
}

// UpsertAppAndCreateReleaseOn 在**调用方提供的事务**里完成「占名 + 建版本」
// (N-2:发布锁已在该事务上,落库不能再开第二条连接)。调用方负责 Commit;
// 任一步失败由调用方 Rollback,原子性与 UpsertAppAndCreateRelease 相同。
func UpsertAppAndCreateReleaseOn(ex Queryer, a *App, r *Release) (int64, error) {
	if err := upsertApp(ex, a); err != nil {
		return 0, err
	}
	return createRelease(ex, r)
}

// GetApp 按 (kind, app_id) 取 App;不存在返回 ErrNotFound。
func GetApp(db *sql.DB, kind, appID string) (*App, error) {
	return GetAppOn(db, kind, appID)
}

// ListApps 列出全部 App(管理端视图),可按 kind/channel 过滤(空 = 不过滤)。
func ListApps(db *sql.DB, kind, channel string) ([]App, error) {
	q := `SELECT ` + appColumns + ` FROM apps WHERE 1=1`
	args := []any{}
	if kind != "" {
		q += ` AND kind = ?`
		args = append(args, kind)
	}
	if channel != "" {
		q += ` AND channel = ?`
		args = append(args, channel)
	}
	q += ` ORDER BY kind, app_id`
	rows, err := db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []App{}
	for rows.Next() {
		a, err := scanApp(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	return out, rows.Err()
}

// SetAppOfficial 设置 App 官方属性与归属(转官方=official=1+owner=”;
// 转用户=official=0+owner=<username>)。官方属性是 App 级唯一事实源,
// 不经 UpsertApp 泄露(发布/元数据更新不触碰本列)。
//
// **不变量守卫**(审计 2026-09-23 G-P2-1):官方归属的唯一合法形态是
// `official=1 ∧ owner 为空`(迁移 0059 / P2-21)。此前本函数接受任意组合,于是
// 任何一条"顺手也写 owner"的调用点都能造出 `official=1 ∧ owner 非空` ——
// 那会让 is_owner 对 owner 为 true(员工端显示「我的」)而发布仍被
// OFFICIAL_LOCKED 403 拒绝,客户端预检与服务端判定分叉。守卫放在这里,
// 未来的调用者无论怎么传都造不出禁止状态。
func SetAppOfficial(db *sql.DB, kind, appID string, official bool, owner string) error {
	if official && owner != "" {
		return fmt.Errorf("%w: 官方归属必须 owner 为空(official=1 ∧ owner 非空 是禁止状态)", ErrValidation)
	}
	_, err := db.Exec(`UPDATE apps SET official = ?, owner = ?, updated_at = `+NowExpr()+`
		WHERE kind = ? AND app_id = ?`, boolToInt(official), owner, kind, appID)
	return err
}

// AppOfficialMap 返回某 kind 全部 App 的官方属性(名→bool),聚合面/列表用。
func AppOfficialMap(db *sql.DB, kind string) (map[string]bool, error) {
	rows, err := db.Query(`SELECT app_id, official FROM apps WHERE kind = ?`, kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var id string
		var off int
		if err := rows.Scan(&id, &off); err != nil {
			return nil, err
		}
		out[id] = off == 1
	}
	return out, rows.Err()
}

// boolToInt 布尔转 smallint。
func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// EnabledAppIDs 返回某 kind 下全部**上架**(enabled=1)的 app_id 集合。
// 读取侧一次取回后按名过滤,替代逐行查 apps 的 N+1(与 AppOfficialMap 同形):
// 清单里漏掉一个下架行,与漏掉一个不存在的行同语义。
//
// **新代码不要再用它做可见性或写入判定**(第五轮审计 R5-B-1,2026-09-23 收敛):
// 那类判定必须经 distribution.go 的 Distribution(Delivered / Writable /
// AuthorVisible)—— 否则又会退化成"每个面各写一遍 enabled 判断",而这正是
// 「作者面被下架过滤掉」「审批准了却没人看得见」的根因。本函数保留给"只要一个
// 上架集合"的批量**投影**场景(以及跨泳道尚未迁移的调用点)。
func EnabledAppIDs(db *sql.DB, kind string) (map[string]bool, error) {
	rows, err := db.Query(`SELECT app_id FROM apps WHERE kind = ? AND enabled = 1`, kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

// AppEnabled 报告一个 App 是否上架(enabled=1),单个查询(下载/详情入口用)。
// App 不存在返回 false:nil 错误 + false 与「不存在」同语义,调用方无需区分
// (不泄露资源存在性)。
func AppEnabled(db *sql.DB, kind, appID string) (bool, error) {
	var enabled int
	err := db.QueryRow(`SELECT enabled FROM apps WHERE kind = ? AND app_id = ?`, kind, appID).Scan(&enabled)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return enabled == 1, nil
}

// SetAppTitle 只更新展示名(App 的展示元数据回写路径);owner、官方属性、
// 渠道与上下架一律不受触碰——包内 author 是不可信输入,归属只认登录态
// (P2-6,审计 2026-09-13:官方 App 的 owner 曾被包内 author 回写成个人)。
func SetAppTitle(db *sql.DB, kind, appID, title string) error {
	res, err := db.Exec(`UPDATE apps SET title = ?, updated_at = `+NowExpr()+`
		WHERE kind = ? AND app_id = ?`, title, kind, appID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// SetAppEnabled 上下架(保留数据)。
func SetAppEnabled(db *sql.DB, kind, appID string, enabled bool) error {
	res, err := db.Exec(`UPDATE apps SET enabled = ?, updated_at = `+NowExpr()+`
		WHERE kind = ? AND app_id = ?`, boolInt(enabled), kind, appID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// CreateRelease 写入一个新的版本快照。调用方必须已完成严格校验与版本语义
// 判定(版本不可复用、必须递增、内容未变更等),本函数只负责落库。
// (kind, app_id, version) 唯一约束兜底并发判重:竞争窗口内先落库者赢,
// 后者返回 ErrDuplicate(B7,2026-09-01——此前直接吞成 INTERNAL 500)。
func CreateRelease(db *sql.DB, r *Release) (int64, error) {
	return createRelease(db, r)
}

// createRelease 是 CreateRelease 的 executor 版本(可传入 *sql.Tx)。
func createRelease(ex queryer, r *Release) (int64, error) {
	tags := "[]"
	if len(r.Tags) > 0 {
		if b, err := json.Marshal(r.Tags); err == nil {
			tags = string(b)
		}
	}
	if r.Status == "" {
		r.Status = ReleaseStatusPending
	}
	var id int64
	err := ex.QueryRow(`INSERT INTO app_releases
		(kind, app_id, version, title, description, changelog, category, tags, author, publisher,
		 checksum, size, archive, status, reason, quality)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
		r.Kind, r.AppID, r.Version, r.Title, r.Description, r.Changelog, r.Category, tags,
		r.Author, r.Publisher, r.Checksum, int64(len(r.Archive)), r.Archive, r.Status, r.Reason, r.Quality).Scan(&id)
	if err != nil && isUniqueViolation(err) {
		return 0, ErrDuplicate
	}
	return id, err
}

// GetRelease 取一个版本(含归档);软删的版本同样返回,调用方据 DeletedAt 判断。
func GetRelease(db *sql.DB, kind, appID, version string) (*Release, error) {
	r, err := scanRelease(db.QueryRow(`SELECT `+releaseFullColumns+` FROM app_releases
		WHERE kind = ? AND app_id = ? AND version = ?`, kind, appID, version), true)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return r, err
}

// ListReleases 列出一个 App 的全部版本(不含归档),含被拒与软删——
// 版本号一经使用即永久占位(决策 D3),判重必须看到全部历史。
func ListReleases(db *sql.DB, kind, appID string) ([]Release, error) {
	return ListReleasesOn(db, kind, appID)
}

// ListReleasesByStatus 列出全部 App 的版本(管理端审核队列),status 为空 = 全部。
func ListReleasesByStatus(db *sql.DB, kind, status string) ([]Release, error) {
	q := `SELECT ` + releaseListColumns + ` FROM app_releases WHERE deleted_at IS NULL`
	args := []any{}
	if kind != "" {
		q += ` AND kind = ?`
		args = append(args, kind)
	}
	if status != "" {
		q += ` AND status = ?`
		args = append(args, status)
	}
	q += ` ORDER BY created_at DESC`
	rows, err := db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return collectReleases(rows)
}

func collectReleases(rows *sql.Rows) ([]Release, error) {
	out := []Release{}
	for rows.Next() {
		r, err := scanRelease(rows, false)
		if err != nil {
			return nil, err
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}

// ErrReleaseArchiveCleared 表示「该版本已被拒绝、归档字节已释放」,因此不能
// 再被置为 approved(N-4:审核通过意味着版本对员工可见可安装,必须有归档字节)。
// 定义在 apps.go 而不是 errors.go,因为它是本文件审核不变量的一部分。
var ErrReleaseArchiveCleared = errors.New("release archive cleared")

// ErrReleaseApprovedNotRejectable 表示目标版本**已通过审核**,因此不允许走
// 「审核拒绝」这条路径(审计 2026-09-23 ID-01)。
//
// 为什么必须是错误而不是"照旧执行":拒绝与释放归档在**同一条 UPDATE** 里完成
// (见 SetReleaseStatusForReview 的 rejected 分支),而 approved 版本可能正在对
// 全员服务(甚至是唯一可回滚的历史版本)。对它执行拒绝会
//
//	① 不可恢复地销毁归档字节(PG BYTEA 置 NULL,没有任何软删回收);
//	② 让正在服务的版本立刻对全员下载 404;
//	③ 烧掉版本号 —— (kind,app_id,version) 唯一约束 + "版本号永久占位"语义
//	   使同一版本号无法重传,再 approve 也只会得到 ErrReleaseArchiveCleared。
//
// 管理员想要的"停服务"是**另一个可逆动作**:下架(apps.enabled=0)。因此
// 「已 approved 的版本不可被拒绝」这条前置条件是产品语义,不是调用方的礼貌。
//
// **这是全仓唯一的判定实现**:三个审核面(sharedskills / agentshare /
// wasmapp)都依赖本函数返回的 sentinel,而不是各自读一遍状态位 —— 此前
// WASM 面自带一份 check-then-act 守卫、技能/智能体两面一份都没有,导致同一
// 个概念三份实现、只有一份正确。
//
// 定义在 apps.go 而不是 errors.go,与 ErrReleaseArchiveCleared 同理。
var ErrReleaseApprovedNotRejectable = errors.New("release already approved and cannot be rejected")

// 审核拒绝被拒时的**对外**文案(409)。三个审核面共用同一份,避免"同一个事实
// 三种说法"——文案是契约的一部分:它必须同时说清「发生了什么」与「该用什么
// 替代动作」,否则管理员只会反复重试。
const (
	// CodeReleaseNotRejectable 是 409 信封的 error.code。
	CodeReleaseNotRejectable = "APPROVED_NOT_REJECTABLE"
	// MsgReleaseNotRejectable 说明拒绝的破坏性后果(不可恢复)。
	MsgReleaseNotRejectable = "该版本已通过审核,不能审核拒绝:" +
		"拒绝会在同一条语句里永久释放该版本的归档字节(不可恢复),该版本将立刻无法安装或下载"
	// HintReleaseNotRejectable 指向可逆的替代动作。
	HintReleaseNotRejectable = "审核拒绝只针对待审版本;要停止服务请用「下架」(可恢复),要换内容请让作者发布新版本(版本号永久占位,不能复用)"
)

// ReleaseRejectable 是「该版本能否被审核拒绝」的**唯一 Go 判定**。
//
// SQL 侧的同一判定是 SetReleaseStatusForReview 的 `AND status <> 'approved'`
// —— 那一份才是并发下的真正防线(原子,不受 check-then-act 窗口影响);本函数
// 只供需要在调用前给出友好提示的调用方使用,两边必须同时成立。
func ReleaseRejectable(status string) bool { return status != ReleaseStatusApproved }

// SetReleaseStatus 审核:approved/rejected(rejected 必须带理由,由调用方保证)。
// 只改状态位,绝不触碰内容或归档——这是「快照」与「审核」得以共存的关键。
//
// 注意:这是**通用原语**,不含 F2-N3/N-4 的审核不变量(见
// SetReleaseStatusForReview)。产品的审核路径(agentshare / sharedskills 的
// admin approve|reject)必须走 ForReview 变体,因为「通过审核」意味着版本对
// 员工可见可安装,必须有归档字节 —— 这一点只能在**写入时**原子判定,不能由
// 调用方先读后写(check-then-act 会被并发绕过)。
func SetReleaseStatus(db *sql.DB, kind, appID, version, status, reason string) error {
	res, err := db.Exec(`UPDATE app_releases SET status = ?, reason = ?,
		quality = CASE WHEN ? = 'approved' THEN quality ELSE '' END, updated_at = `+NowExpr()+`
		WHERE kind = ? AND app_id = ? AND version = ?`,
		status, reason, status, kind, appID, version)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// SetReleaseStatusForReview 是**审核路径专用**的状态写入(F2-N3 + N-4):
//
//   - approved:条件 UPDATE(`archive IS NOT NULL AND deleted_at IS NULL`),
//     与「归档非空」在同一语句里判定。条件不满足时区分「行不存在」
//     (ErrNotFound)与「归档已被拒绝释放」(ErrReleaseArchiveCleared),
//     调用方据此回 404 / 409。
//     `status <> 'rejected'` 的例外:从未被拒过的行(历史/播种数据)archive
//     列为 NULL 时仍允许通过审核 —— 「归档被释放」这件事**只**发生在下面的
//     rejected 转换里,所以 `status='rejected' AND archive IS NULL` 与「被
//     释放过」等价;这条例外让迁移前的存量行不受影响(它们仍走串行审核)。
//   - rejected:拒绝与释放归档在**同一条 UPDATE**里完成(agentshare-5 的
//     存储上界:拒绝即释放,否则员工可无限循环「上传 → 被拒」堆字节)。
//     调用方不需要、也不应该再补一次清归档 —— 「置 rejected」与「清 archive」
//     分成两条语句时,中间那段窗口恰好就是被并发 approve 穿过的窗口。
//     但这条语句**只对未生效的版本成立**:`status <> 'approved'` 是前置条件
//     (审计 2026-09-23 ID-01)。approved 版本可能正在服务、也可能是唯一可
//     回滚的历史版本,拒绝它会不可恢复地销毁归档字节并烧掉版本号 ⇒ 该条件
//     不满足时返回 ErrReleaseApprovedNotRejectable(调用方映射 409),管理员
//     要停服务请用下架(apps.enabled,可逆)。历史行为(approve 后仍可 reject)
//     只对"尚未生效的待审版本"有意义,对 approved 版本是 P0 数据销毁。
//
// 为什么这就是 N-4 的修复:两个管理员并发 approve/reject 时,PostgreSQL 在
// READ COMMITTED 下用行级锁串行化两条 UPDATE,后到的那条会**重新求值**
// WHERE(EPQ),因此它看到的一定是先提交者的结果 —— 要么 approve 先提交而
// reject 的条件(status <> 'approved')不再成立而被拒,要么 reject 先提交而
// approve 的条件不再成立而拒绝。任何交错都产不出 `approved + archive IS NULL`
// 的坏行,也产不出"已生效版本的字节被销毁"。这条不变量只能写在 WHERE 里:
// 调用方先读后写(check-then-act)在并发下必被绕过。
func SetReleaseStatusForReview(db *sql.DB, kind, appID, version, status, reason string) error {
	switch status {
	case ReleaseStatusApproved:
		res, err := db.Exec(`UPDATE app_releases SET status = ?, reason = '',
			updated_at = `+NowExpr()+`
			WHERE kind = ? AND app_id = ? AND version = ? AND deleted_at IS NULL
			  AND (archive IS NOT NULL OR status <> 'rejected')`,
			status, kind, appID, version)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			var exists bool
			if err := db.QueryRow(`SELECT EXISTS(SELECT 1 FROM app_releases
				WHERE kind = ? AND app_id = ? AND version = ?)`, kind, appID, version).Scan(&exists); err != nil {
				return err
			}
			if !exists {
				return ErrNotFound
			}
			return ErrReleaseArchiveCleared
		}
		return nil
	case ReleaseStatusRejected:
		res, err := db.Exec(`UPDATE app_releases SET status = ?, reason = ?, quality = '',
			archive = NULL, size = 0, updated_at = `+NowExpr()+`
			WHERE kind = ? AND app_id = ? AND version = ? AND status <> ?`,
			status, reason, kind, appID, version, ReleaseStatusApproved)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			// 0 行只有两种可能:行不存在,或行**已通过审核**(被上面的
			// `status <> ?` 挡下)。两者对调用方的语义完全不同(404 vs 409),
			// 必须区分 —— 这里的第二个查询只用于在**已经判定拒绝失败**之后
			// 解释原因,不构成 check-then-act:真正的前置条件已经由 UPDATE
			// 的分支保证,并发的 approve 只会让这次拒绝更早返回 sentinel。
			var exists bool
			if err := db.QueryRow(`SELECT EXISTS(SELECT 1 FROM app_releases
				WHERE kind = ? AND app_id = ? AND version = ?)`, kind, appID, version).Scan(&exists); err != nil {
				return err
			}
			if !exists {
				return ErrNotFound
			}
			return ErrReleaseApprovedNotRejectable
		}
		return nil
	default:
		return SetReleaseStatus(db, kind, appID, version, status, reason)
	}
}

// SetReleaseQuality 质量标记(”|official|featured),仅 approved 版本可设置。
func SetReleaseQuality(db *sql.DB, kind, appID, version, quality string) error {
	res, err := db.Exec(`UPDATE app_releases SET quality = ?, updated_at = `+NowExpr()+`
		WHERE kind = ? AND app_id = ? AND version = ? AND status = 'approved'`,
		quality, kind, appID, version)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// SoftDeleteRelease 软删一个版本:内容不再可用,但版本号永久占位不可复用。
func SoftDeleteRelease(db *sql.DB, kind, appID, version string) error {
	res, err := db.Exec(`UPDATE app_releases SET deleted_at = `+NowExpr()+`, archive = NULL,
		updated_at = `+NowExpr()+` WHERE kind = ? AND app_id = ? AND version = ? AND deleted_at IS NULL`,
		kind, appID, version)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// IncrementReleaseDownload 下载计数(best effort)。
func IncrementReleaseDownload(db *sql.DB, kind, appID, version string) error {
	_, err := db.Exec(`UPDATE app_releases SET downloads = downloads + 1
		WHERE kind = ? AND app_id = ? AND version = ?`, kind, appID, version)
	return err
}

// ---------------------------------------------------------------------------
// 授权(App 级:同名多版本共享一份授权,与旧语义一致)
// ---------------------------------------------------------------------------

// GrantApp 授权给用户或部门组(幂等)。
func GrantApp(db *sql.DB, kind, appID, grantee, granteeType string) error {
	_, err := db.Exec(`INSERT INTO app_grants (kind, app_id, grantee_type, grantee)
		VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`, kind, appID, granteeType, grantee)
	return err
}

// RevokeApp 撤销一条授权。
func RevokeApp(db *sql.DB, kind, appID, grantee, granteeType string) error {
	_, err := db.Exec(`DELETE FROM app_grants
		WHERE kind = ? AND app_id = ? AND grantee_type = ? AND grantee = ?`,
		kind, appID, granteeType, grantee)
	return err
}

// ListAppGrants 列出一个 App 的授权对象。
func ListAppGrants(db *sql.DB, kind, appID string) ([]Grant, error) {
	rows, err := db.Query(`SELECT grantee_type, grantee FROM app_grants
		WHERE kind = ? AND app_id = ? ORDER BY grantee_type, grantee`, kind, appID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Grant{}
	for rows.Next() {
		var g Grant
		if err := rows.Scan(&g.GranteeType, &g.Grantee); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// AccessibleAppIDs 返回某用户(含其部门组)有权访问的 App 名单。
// 严格默认:未授权即不可见(与旧三域一致)。
func AccessibleAppIDs(db *sql.DB, kind, username string, groups []string) ([]string, error) {
	q := `SELECT DISTINCT app_id FROM app_grants WHERE kind = ? AND (
			(grantee_type = 'user' AND lower(grantee) = lower(?))`
	args := []any{kind, username}
	if len(groups) > 0 {
		q += ` OR (grantee_type = 'group' AND lower(grantee) IN (` + qmarks(len(groups)) + `))`
		for _, g := range groups {
			args = append(args, strings.ToLower(g))
		}
	}
	q += `)`
	rows, err := db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	return out, rows.Err()
}
