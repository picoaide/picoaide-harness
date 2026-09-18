// ---- WASM 应用平台 DAO(迁移 0069)----
//
// 设计基线 docs/planning/2026-09-17-wasm-app-platform.md:
//
//	§4.1 命名与标识(域名标签就是 app_id,不新增标识列)
//	§4.8 Host 第一级标签 → app_id,查不到直接 404、绝不回落主站
//	§5.3 保留最近 3 个曾生效版本 / 每用户 1 GiB 制品
//	§8   发布者即管理员(归属首占)、上下架、冻结/导出/删除
//
// 本文件**只做数据访问**:权限、审批、版本号递增、冻结期策略等业务判断在
// 各自的业务包里;这里只保证落库的语义与不变量(归属首占、版本号永久占位、
// 软删不释放版本号、GC 不碰当前生效版本)。
//
// 约定:
//   - 一律 `$N` 占位(PG-only;连接层虽有 `?`→`$N` 重写,但新代码直接用 `$N`)。
//   - app_id 是域名标签 ⇒ **一律小写入库、小写查询**(域名不区分大小写)。
//   - 软删只置 deleted_at:行还在,**版本号/名字永久占位**(§4.1 防抢占)。
package serverstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// AppKindWasmApp / AppChannelWasm 是 wasm 应用在统一应用模型里的取值
// (迁移 0069 放开了 apps.kind / apps.channel 的 CHECK)。
//
// 渠道刻意取**独立值** wasm,而不是复用 market/org:既有按 channel 过滤的
// 查询(marketplace / agentshare / capabilities / sharedskills 全部显式传
// market|org)因此天然不会把 wasm 应用当成技能/智能体展示;wasm 应用的分发面
// 是 <app_id>.<基域> 应用子域(§4.8),与能力中心两个渠道正交。
const (
	AppKindWasmApp = "wasm_app"
	AppChannelWasm = "wasm"
)

// WasmApp 是一个 wasm 应用的长期身份 + **当前生效状态**。
//
// DeletedAt 是只读投影,由 SoftDeleteWasmApp 写;访问模式(access)不再有独立投影列
// (0071 起 apps.visible 已删):目录与运维面要显示访问级别时从 ConfigJSON 现解
// (appcfg.AccessOfConfigJSON)。2026-09-18 收敛为 access 三模式后,目录**不按**访问
// 级别过滤 —— 所有应用都展示,访问级别只是条目上的一个字段。
type WasmApp struct {
	AppID            string
	Title            string
	Description      string
	Owner            string
	Channel          string
	Enabled          bool
	Purpose          string
	DataSensitivity  string
	ConfigJSON       string
	CurrentReleaseID int64
	FrozenAt         *time.Time
	CreatedAt        time.Time
	UpdatedAt        time.Time
	// DeletedAt 非空 = 已软删(退役)。GetWasmApp 仍返回该行(R37 冻结期还要
	// 导出),GetWasmAppByHost 则必须查不到。
	DeletedAt *time.Time
}

// WasmRelease 是一个不可变的 wasm 版本快照。
//
// 制品字节复用 app_releases.archive(BYTEA):审核不变量 N-4(「approved 必须
// 有归档字节」)对 wasm 版本同样成立,PruneWasmReleases 置空该列即释放配额。
type WasmRelease struct {
	ID          int64
	AppID       string
	Version     string
	Title       string
	Description string
	Changelog   string
	Publisher   string
	Checksum    string
	Size        int64
	Status      string
	Wasm        []byte
	ConfigJSON  string
	AssetsDir   string
	DeletedAt   *time.Time
	CreatedAt   time.Time
}

// wasmAppColumns 是 apps 上 wasm 应用用到的列(显式列名:既有 skill/agent
// 代码用 appColumns,互不影响)。
const wasmAppColumns = `app_id, title, description, owner, channel, enabled, purpose,
	data_sensitivity, config_json, current_release_id, frozen_at, deleted_at,
	created_at, updated_at`

// wasmReleaseListColumns 不含 archive blob:清单查询绝不加载全部制品。
const wasmReleaseListColumns = `id, app_id, version, title, description, changelog, publisher,
	checksum, size, status, config_json, assets_dir, deleted_at, created_at`

const wasmReleaseFullColumns = wasmReleaseListColumns + ", archive"

// normalizeWasmAppID 把 app_id(= 域名标签,§4.1)统一为小写。
// 域名不区分大小写 ⇒ 入库与查询必须同口径,否则同一个应用会出现两个身份。
func normalizeWasmAppID(appID string) string {
	return strings.ToLower(strings.TrimSpace(appID))
}

// nullableSQLTime 把可空时间列(NULL 或零值)映射成 *time.Time。
func nullableSQLTime(v any) *time.Time {
	if v == nil {
		return nil
	}
	t := parseSQLTime(v)
	if t.IsZero() {
		return nil
	}
	return &t
}

// isForeignKeyViolation 报告 PG 的外键冲突(23503):CreateWasmRelease 用它
// 把"应用不存在"翻译成 ErrNotFound,而不是让调用方拿到裸驱动错误。
func isForeignKeyViolation(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "SQLSTATE 23503") || strings.Contains(msg, "23503") ||
		strings.Contains(msg, "foreign key constraint")
}

func scanWasmApp(row interface{ Scan(...any) error }) (*WasmApp, error) {
	var a WasmApp
	var enabled int
	var frozen, deleted, created, updated any
	if err := row.Scan(&a.AppID, &a.Title, &a.Description, &a.Owner, &a.Channel, &enabled,
		&a.Purpose, &a.DataSensitivity, &a.ConfigJSON, &a.CurrentReleaseID,
		&frozen, &deleted, &created, &updated); err != nil {
		return nil, err
	}
	a.Enabled = enabled == 1
	a.FrozenAt = nullableSQLTime(frozen)
	a.DeletedAt = nullableSQLTime(deleted)
	a.CreatedAt, a.UpdatedAt = parseSQLTime(created), parseSQLTime(updated)
	return &a, nil
}

func scanWasmRelease(row interface{ Scan(...any) error }, withWasm bool) (*WasmRelease, error) {
	var r WasmRelease
	var deleted, created any
	dest := []any{&r.ID, &r.AppID, &r.Version, &r.Title, &r.Description, &r.Changelog,
		&r.Publisher, &r.Checksum, &r.Size, &r.Status, &r.ConfigJSON, &r.AssetsDir,
		&deleted, &created}
	if withWasm {
		dest = append(dest, &r.Wasm)
	}
	if err := row.Scan(dest...); err != nil {
		return nil, err
	}
	r.DeletedAt = nullableSQLTime(deleted)
	r.CreatedAt = parseSQLTime(created)
	return &r, nil
}

// wasmAppRowsAffected 把"条件 UPDATE 影响 0 行"翻译成 ErrNotFound(其余错误原样)。
func wasmAppRowsAffected(res sql.Result, err error) error {
	if err != nil {
		return err
	}
	if n, nerr := res.RowsAffected(); nerr == nil && n == 0 {
		return ErrNotFound
	}
	return nil
}

// UpsertWasmApp 建立或更新一个 wasm 应用身份(幂等)。
//
// 归属语义与 UpsertApp 完全一致(0053/2026-09-02 决策):**owner 一经写入不可被
// 后续发布改写**(`COALESCE(NULLIF(apps.owner,”), excluded.owner)`),首个成功
// 发布者永久占名,被拒/软删也不释放 —— 否则任何人都能靠"重新发布"接管他人应用。
//
// 冲突分支**只**更新 title/description/owner/updated_at:
//   - enabled 只由 SetWasmAppEnabled 改(上下架是独立动作,不该被一次发布静默改写);
//   - config_json / purpose / data_sensitivity 只由 SetWasmAppConfig 改
//     (它们的真源是随包的应用配置文件,一次只带标题的 upsert 不该抹掉配置);
//   - current_release_id 只由 SetWasmAppCurrentRelease 改(§8 待审期间线上仍旧版本)。
func UpsertWasmApp(ctx context.Context, db *sql.DB, app WasmApp) error {
	appID := normalizeWasmAppID(app.AppID)
	if appID == "" {
		return errors.New("wasm app: app_id 不能为空")
	}
	_, err := db.ExecContext(ctx, `INSERT INTO apps
		(kind, app_id, title, description, owner, channel, enabled, purpose, data_sensitivity, config_json)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		ON CONFLICT (kind, app_id) DO UPDATE SET
			title = excluded.title,
			description = excluded.description,
			owner = COALESCE(NULLIF(apps.owner, ''), excluded.owner),
			updated_at = now()`,
		AppKindWasmApp, appID, app.Title, app.Description, app.Owner, AppChannelWasm,
		boolToInt(app.Enabled), app.Purpose, app.DataSensitivity, app.ConfigJSON)
	return err
}

// GetWasmApp 按 app_id 取应用;不存在返回 ErrNotFound。
// **软删的行同样返回**(DeletedAt 非空)—— R37 的"冻结 → 90 天内可导出"必须
// 还能读到已退役的行(与 GetRelease 的既有口径一致:由调用方据 DeletedAt 判断)。
func GetWasmApp(ctx context.Context, db *sql.DB, appID string) (*WasmApp, error) {
	a, err := scanWasmApp(db.QueryRowContext(ctx, `SELECT `+wasmAppColumns+`
		FROM apps WHERE kind = $1 AND app_id = $2`, AppKindWasmApp, normalizeWasmAppID(appID)))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return a, err
}

// WasmAppFilter 是 ListWasmApps 的过滤条件(零值 = 全部未删除的应用)。
type WasmAppFilter struct {
	// Owner 非空 = 只列该发布者的应用(管理平面按发布者过滤)。
	Owner string
	// Enabled 非 nil = 只看上/下架状态为该值的应用。
	Enabled *bool
	// IncludeDeleted = true 时把已软删(退役)的应用也列出来(R37 运维面)。
	IncludeDeleted bool
}

// ListWasmApps 列出 wasm 应用。默认**不含**软删行。
func ListWasmApps(ctx context.Context, db *sql.DB, opts WasmAppFilter) ([]WasmApp, error) {
	q := `SELECT ` + wasmAppColumns + ` FROM apps WHERE kind = $1`
	args := []any{AppKindWasmApp}
	if !opts.IncludeDeleted {
		q += ` AND deleted_at IS NULL`
	}
	if opts.Owner != "" {
		args = append(args, opts.Owner)
		q += fmt.Sprintf(` AND owner = $%d`, len(args))
	}
	if opts.Enabled != nil {
		args = append(args, boolToInt(*opts.Enabled))
		q += fmt.Sprintf(` AND enabled = $%d`, len(args))
	}
	q += ` ORDER BY app_id`
	rows, err := db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WasmApp{}
	for rows.Next() {
		a, err := scanWasmApp(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	return out, rows.Err()
}

// SetWasmAppEnabled 上下架(§8;复用 apps.enabled,与审核开关无关)。
func SetWasmAppEnabled(ctx context.Context, db *sql.DB, appID string, enabled bool) error {
	return wasmAppRowsAffected(db.ExecContext(ctx, `UPDATE apps SET enabled = $1, updated_at = now()
		WHERE kind = $2 AND app_id = $3 AND deleted_at IS NULL`,
		boolToInt(enabled), AppKindWasmApp, normalizeWasmAppID(appID)))
}

// TransferWasmAppOwner 转移归属(§11 第 17 项:离职/接管)。空 owner 直接拒:
// 归属悬空正是"发布者离职后应用无人能改"的病根。
func TransferWasmAppOwner(ctx context.Context, db *sql.DB, appID, newOwner string) error {
	if strings.TrimSpace(newOwner) == "" {
		return errors.New("wasm app: 新归属不能为空")
	}
	return wasmAppRowsAffected(db.ExecContext(ctx, `UPDATE apps SET owner = $1, updated_at = now()
		WHERE kind = $2 AND app_id = $3 AND deleted_at IS NULL`,
		newOwner, AppKindWasmApp, normalizeWasmAppID(appID)))
}

// FreezeWasmApp 冻结(只读快照,R37)。at 为零值 = 解冻(frozen_at 置 NULL)——
// 冻结是"冻结时刻 + 保留期"的判定依据,解冻必须能显式表达。
func FreezeWasmApp(ctx context.Context, db *sql.DB, appID string, at time.Time) error {
	var frozen any
	if !at.IsZero() {
		frozen = at.UTC()
	}
	return wasmAppRowsAffected(db.ExecContext(ctx, `UPDATE apps SET frozen_at = $1, updated_at = now()
		WHERE kind = $2 AND app_id = $3 AND deleted_at IS NULL`,
		frozen, AppKindWasmApp, normalizeWasmAppID(appID)))
}

// SoftDeleteWasmApp 软删(退役):行仍在、名字与版本号永久占位(§4.1 防抢占),
// 同时下架(下架与删除是两件事,但"已删仍上架"没有意义)。
func SoftDeleteWasmApp(ctx context.Context, db *sql.DB, appID string) error {
	return wasmAppRowsAffected(db.ExecContext(ctx, `UPDATE apps
		SET deleted_at = now(), enabled = 0, updated_at = now()
		WHERE kind = $1 AND app_id = $2 AND deleted_at IS NULL`,
		AppKindWasmApp, normalizeWasmAppID(appID)))
}

// SetWasmAppConfig 写入**当前生效**的应用配置(§4.2 的 picoaide.app.json 投影)。
//
// 投影列只有 config_json / purpose / data_sensitivity:访问模式(access)不再单列
// (0071 删掉了 apps.visible),要显示时由调用方从 configJSON 现解
// (appcfg.AccessOfConfigJSON)。configJSON 为空表示"只改用途/敏感性"。
// JSON 非法即拒 —— 存进去的配置将来要投影与展示,落库前失败好过之后静默漂移。
func SetWasmAppConfig(ctx context.Context, db *sql.DB, appID, configJSON, purpose, sensitivity string) error {
	if configJSON != "" && !json.Valid([]byte(configJSON)) {
		return fmt.Errorf("wasm app 配置不是合法 JSON")
	}
	return wasmAppRowsAffected(db.ExecContext(ctx, `UPDATE apps
		SET config_json = $1, purpose = $2, data_sensitivity = $3, updated_at = now()
		WHERE kind = $4 AND app_id = $5 AND deleted_at IS NULL`,
		configJSON, purpose, sensitivity, AppKindWasmApp, normalizeWasmAppID(appID)))
}

// SetWasmAppCurrentRelease 把某个版本置为**当前生效版本**(§8:开启审核时新版进
// 待审队列,线上仍旧版本 ⇒ 生效版本必须显式落库)。
//
// 条件里带 EXISTS 校验:该 release 必须属于本应用且未被软删。否则一次写错的
// id 会让应用指向别人的版本 —— 应用子域直接交付错误内容,属于越权级事故。
func SetWasmAppCurrentRelease(ctx context.Context, db *sql.DB, appID string, releaseID int64) error {
	if releaseID <= 0 {
		return errors.New("wasm app: release id 必须为正")
	}
	id := normalizeWasmAppID(appID)
	return wasmAppRowsAffected(db.ExecContext(ctx, `UPDATE apps
		SET current_release_id = $1, updated_at = now()
		WHERE kind = $2 AND app_id = $3 AND deleted_at IS NULL
		  AND EXISTS (SELECT 1 FROM app_releases r
		              WHERE r.id = $1 AND r.kind = $2 AND r.app_id = $3 AND r.deleted_at IS NULL)`,
		releaseID, AppKindWasmApp, id))
}

// CreateWasmRelease 写入一个不可变的版本快照。
//
// 版本号**永久占位**(§4.1):(kind, app_id, version) 唯一冲突返回 ErrDuplicate,
// 被拒/软删的版本同样不可复用(软删行还在,唯一约束照旧生效)。应用不存在时
// 外键冲突翻译成 ErrNotFound。状态缺省 pending(§4.2 审核态由业务层决定)。
func CreateWasmRelease(ctx context.Context, db *sql.DB, rel WasmRelease) (int64, error) {
	appID := normalizeWasmAppID(rel.AppID)
	if appID == "" {
		return 0, errors.New("wasm release: app_id 不能为空")
	}
	if strings.TrimSpace(rel.Version) == "" {
		return 0, errors.New("wasm release: version 不能为空")
	}
	status := rel.Status
	if status == "" {
		status = ReleaseStatusPending
	}
	var id int64
	err := db.QueryRowContext(ctx, `INSERT INTO app_releases
		(kind, app_id, version, title, description, changelog, publisher, checksum,
		 size, archive, status, config_json, assets_dir)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		RETURNING id`,
		AppKindWasmApp, appID, rel.Version, rel.Title, rel.Description, rel.Changelog,
		rel.Publisher, rel.Checksum, int64(len(rel.Wasm)), rel.Wasm, status,
		rel.ConfigJSON, rel.AssetsDir).Scan(&id)
	if err != nil {
		if isUniqueViolation(err) {
			return 0, ErrDuplicate
		}
		if isForeignKeyViolation(err) {
			return 0, fmt.Errorf("%w: wasm 应用 %q 不存在", ErrNotFound, appID)
		}
		return 0, err
	}
	return id, nil
}

// ListWasmReleases 列出一个应用的版本(不含制品字节),按写入顺序升序。
// 默认不含软删行;includeDeleted=true 用于"版本号永久占位"的判重与审计。
func ListWasmReleases(ctx context.Context, db *sql.DB, appID string, includeDeleted bool) ([]WasmRelease, error) {
	q := `SELECT ` + wasmReleaseListColumns + ` FROM app_releases WHERE kind = $1 AND app_id = $2`
	if !includeDeleted {
		q += ` AND deleted_at IS NULL`
	}
	q += ` ORDER BY created_at, id`
	rows, err := db.QueryContext(ctx, q, AppKindWasmApp, normalizeWasmAppID(appID))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WasmRelease{}
	for rows.Next() {
		r, err := scanWasmRelease(rows, false)
		if err != nil {
			return nil, err
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}

// GetWasmRelease 取一个版本(含制品字节)。软删的版本同样返回,调用方据
// DeletedAt 判断(与被拒/软删版本号永久占位的语义配套)。
func GetWasmRelease(ctx context.Context, db *sql.DB, appID, version string) (*WasmRelease, error) {
	r, err := scanWasmRelease(db.QueryRowContext(ctx, `SELECT `+wasmReleaseFullColumns+`
		FROM app_releases WHERE kind = $1 AND app_id = $2 AND version = $3`,
		AppKindWasmApp, normalizeWasmAppID(appID), version), true)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return r, err
}

// LatestApprovedWasmRelease 取最新的**已批准且未软删**版本(应用子域交付的
// 候选版本)。版本号严格递增 ⇒ id 顺序即版本顺序,取 max(id) 即可。
func LatestApprovedWasmRelease(ctx context.Context, db *sql.DB, appID string) (*WasmRelease, error) {
	r, err := scanWasmRelease(db.QueryRowContext(ctx, `SELECT `+wasmReleaseFullColumns+`
		FROM app_releases
		WHERE kind = $1 AND app_id = $2 AND status = $3 AND deleted_at IS NULL
		ORDER BY id DESC LIMIT 1`,
		AppKindWasmApp, normalizeWasmAppID(appID), ReleaseStatusApproved), true)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return r, err
}

// SoftDeleteWasmRelease 软删一个版本(按 id)。版本号仍永久占位;释放字节是
// PruneWasmReleases 的职责(GC 与"删一个版本"是两件事)。
func SoftDeleteWasmRelease(ctx context.Context, db *sql.DB, id int64) error {
	return wasmAppRowsAffected(db.ExecContext(ctx, `UPDATE app_releases
		SET deleted_at = now(), updated_at = now()
		WHERE id = $1 AND kind = $2 AND deleted_at IS NULL`, id, AppKindWasmApp))
}

// CountUserArtifactBytes 统计某发布者的 wasm 制品总量(§5.3 每用户 1 GiB 配额,
// PG BYTEA 口径、含全部版本)。软删但未 GC 的版本仍占配额(字节还在库里);
// PruneWasmReleases 置空 archive 后立即释放。
func CountUserArtifactBytes(ctx context.Context, db *sql.DB, username string) (int64, error) {
	var n int64
	err := db.QueryRowContext(ctx, `SELECT COALESCE(SUM(octet_length(archive)), 0)
		FROM app_releases WHERE kind = $1 AND publisher = $2`,
		AppKindWasmApp, username).Scan(&n)
	return n, err
}

// PruneWasmReleases 版本 GC(§5.3 / §11 第 16 项):**保留最近 keep 个曾生效
// (approved)版本**,更早的软删并置空制品字节;返回被软删的 release id。
//
// 不变量:
//   - 只动 approved(曾生效)版本 —— pending 还在等审核、rejected 的字节已由
//     审核路径释放,GC 不该碰它们;
//   - **绝不软删 apps.current_release_id 指向的版本**:回滚会让"当前生效"
//     早于最近 3 个版本,若一并回收就等于把线上版本删掉;
//   - 软删不删行 ⇒ 版本号永久占位(§4.1),size 归零与 archive 置空同步,
//     保持"size == 字节长度"这条 createRelease 建立的不变量;
//   - 幂等:重复调用返回空切片(没有可回收的行)。
//
// keep ≤ 0 直接报错而不是"全部回收":一次传错 0 就抹掉全部制品字节,代价不可逆。
func PruneWasmReleases(ctx context.Context, db *sql.DB, appID string, keep int) ([]int64, error) {
	if keep <= 0 {
		return nil, errors.New("wasm release prune: keep 必须 > 0")
	}
	id := normalizeWasmAppID(appID)
	if id == "" {
		return nil, errors.New("wasm release prune: app_id 不能为空")
	}
	rows, err := db.QueryContext(ctx, `
		WITH doomed AS (
			SELECT r.id FROM app_releases r
			WHERE r.kind = $1 AND r.app_id = $2
			  AND r.status = $3 AND r.deleted_at IS NULL
			  AND r.id <> COALESCE((SELECT a.current_release_id FROM apps a
			                        WHERE a.kind = $1 AND a.app_id = $2), 0)
			ORDER BY r.id DESC OFFSET $4
		)
		UPDATE app_releases
		SET deleted_at = now(), archive = NULL, size = 0, updated_at = now()
		WHERE id IN (SELECT id FROM doomed)
		RETURNING id`, AppKindWasmApp, id, ReleaseStatusApproved, keep)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var pruned []int64
	for rows.Next() {
		var rid int64
		if err := rows.Scan(&rid); err != nil {
			return nil, err
		}
		pruned = append(pruned, rid)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.Slice(pruned, func(i, j int) bool { return pruned[i] < pruned[j] })
	return pruned, nil
}

// GetWasmAppByHost 按 Host 的第一级标签反查应用(§4.8)。
//
// 三条硬要求:
//   - 只认 kind=wasm_app(技能/智能体同名行绝不能被当应用命中);
//   - **已软删的应用查不到**(退役即停止路由);
//   - 查不到返回明确的 not-found(ErrNotFound),调用方据此 **404 且绝不回落
//     主站内容** —— 回落会让任意未登记子域变成钓鱼页(§4.8 域名安全)。
//
// hostLabel 做防御性规范化:域名不区分大小写,端口与末尾根点不属于标签。
func GetWasmAppByHost(ctx context.Context, db *sql.DB, hostLabel string) (*WasmApp, error) {
	label := normalizeHostLabel(hostLabel)
	if label == "" {
		return nil, fmt.Errorf("%w: 空主机名", ErrNotFound)
	}
	a, err := scanWasmApp(db.QueryRowContext(ctx, `SELECT `+wasmAppColumns+`
		FROM apps WHERE kind = $1 AND app_id = $2 AND deleted_at IS NULL`,
		AppKindWasmApp, label))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("%w: 未登记的 wasm 应用主机名 %q", ErrNotFound, label)
	}
	return a, err
}

// normalizeHostLabel 取主机名的**第一级标签**并小写化(§4.8:「Host 的第一级
// 标签 → apps.app_id」)。传裸标签("my-app")与传完整主机名
// ("my-app.example.com")都得到同一结果 —— app_id 是 DNS label、不含点,
// 所以按第一个点切分不会误伤。端口只在形如 "<host>:<数字>" 时剥离,
// 避免把 IPv6 字面量切坏(切坏了也只是查不到,不会误命中)。
func normalizeHostLabel(host string) string {
	h := strings.TrimSpace(host)
	if i := strings.LastIndexByte(h, ':'); i >= 0 {
		if _, err := strconv.Atoi(h[i+1:]); err == nil {
			h = h[:i]
		}
	}
	h = strings.TrimSuffix(h, ".") // DNS 根点
	h = strings.ToLower(h)
	if i := strings.IndexByte(h, '.'); i >= 0 {
		h = h[:i]
	}
	return h
}
