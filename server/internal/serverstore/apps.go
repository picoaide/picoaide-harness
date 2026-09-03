// Package serverstore — 统一应用模型 DAO(迁移 0053/0054)。
//
// 决策 docs/decisions/2026-09-01-skill-app-management.md P2:技能与智能体
// 统一为 App(长期身份)+ Release(不可变版本快照)。本文件是该模型的唯一
// 数据访问层——旧的 skills/shared_skills/agent_presets DAO 在兼容期内保留
// 只读,新写入一律走这里。
package serverstore

import (
	"database/sql"
	"encoding/json"
	"errors"
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
func UpsertApp(db *sql.DB, a *App) error {
	if a.Kind != AppKindSkill && a.Kind != AppKindAgent {
		return errors.New("invalid app kind")
	}
	if a.Channel != AppChannelMarket && a.Channel != AppChannelOrg {
		return errors.New("invalid app channel")
	}
	_, err := db.Exec(`INSERT INTO apps (kind, app_id, title, description, owner, channel, enabled)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (kind, app_id) DO UPDATE SET
			title = excluded.title, description = excluded.description,
			owner = COALESCE(NULLIF(apps.owner, ''), excluded.owner),
			updated_at = `+NowExpr(),
		a.Kind, a.AppID, a.Title, a.Description, a.Owner, a.Channel, a.Enabled)
	return err
}

// GetApp 按 (kind, app_id) 取 App;不存在返回 ErrNotFound。
func GetApp(db *sql.DB, kind, appID string) (*App, error) {
	a, err := scanApp(db.QueryRow(`SELECT `+appColumns+` FROM apps WHERE kind = ? AND app_id = ?`, kind, appID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return a, err
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
func SetAppOfficial(db *sql.DB, kind, appID string, official bool, owner string) error {
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

// SetAppOwner 归属转移(管理员指定,2026-09-02):apps.owner 是归属人的唯一
// 真源——转移后旧归属者发布的后续版本请求一律 404,新归属者获得续传权。
func SetAppOwner(db *sql.DB, kind, appID, owner string) error {
	res, err := db.Exec(`UPDATE apps SET owner = ?, updated_at = `+NowExpr()+`
		WHERE kind = ? AND app_id = ?`, owner, kind, appID)
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
	tags := "[]"
	if len(r.Tags) > 0 {
		if b, err := json.Marshal(r.Tags); err == nil {
			tags = string(b)
		}
	}
	if r.Status == "" {
		r.Status = ReleaseStatusPending
	}
	id, err := InsertID(db, `INSERT INTO app_releases
		(kind, app_id, version, title, description, changelog, category, tags, author, publisher,
		 checksum, size, archive, status, reason, quality)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.Kind, r.AppID, r.Version, r.Title, r.Description, r.Changelog, r.Category, tags,
		r.Author, r.Publisher, r.Checksum, int64(len(r.Archive)), r.Archive, r.Status, r.Reason, r.Quality)
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
	rows, err := db.Query(`SELECT `+releaseListColumns+` FROM app_releases
		WHERE kind = ? AND app_id = ? ORDER BY created_at`, kind, appID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return collectReleases(rows)
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

// SetReleaseStatus 审核:approved/rejected(rejected 必须带理由,由调用方保证)。
// 只改状态位,绝不触碰内容——这是「快照」与「审核」得以共存的关键。
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

// PendingReleaseCount 某发布者的待审数量(配额)。
func PendingReleaseCount(db *sql.DB, publisher string) (int, error) {
	var n int
	err := db.QueryRow(`SELECT count(*) FROM app_releases
		WHERE publisher = ? AND status = 'pending' AND deleted_at IS NULL`, publisher).Scan(&n)
	return n, err
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
			(grantee_type = 'user' AND grantee = ?)`
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
