package serverstore

import (
	"database/sql"
	"time"
)

// AgentPresetStatus is the review state of one shared agent preset.
type AgentPresetStatus string

const (
	// AgentPresetPending awaits an admin review decision.
	AgentPresetPending AgentPresetStatus = "pending"
	// AgentPresetApproved is visible and installable by every employee.
	AgentPresetApproved AgentPresetStatus = "approved"
	// AgentPresetRejected is invisible to everyone but its author, who may
	// resubmit the same name+version (the row is reused, reset to pending).
	AgentPresetRejected AgentPresetStatus = "rejected"
)

// AgentPreset is one shared agent preset row (unique by name+version).
type AgentPreset struct {
	ID          int64
	Name        string
	DisplayName string
	Description string
	Version     string
	Author      string
	Checksum    string
	Status      AgentPresetStatus
	// Reason is the admin's rejection reason; empty unless the row is
	// rejected. Visible only to the author (and admins).
	Reason string
	// Quality 是组织库质量标记(0037, 0059 起仅 ''|featured——官方语义移交 apps.official):
	// 仅对 approved 行有展示语义;与市场「免费/专业」分级词表隔离。
	Quality string
	// Archive 是上传的归档字节(0041: 归档直存 DB,不再落磁盘)。
	Archive []byte
	// Downloads 统计归档下载次数(0041)。
	Downloads int64
	CreatedAt time.Time
	UpdatedAt time.Time
}

// ---------------------------------------------------------------------------
// P2 适配层(迁移 0053/0054):智能体预设与技能共用 apps/app_releases
// (kind=agent, channel=org),保留原有签名与语义。旧表 agent_presets 兼容期
// 内只读保留,P5 下线。
// ---------------------------------------------------------------------------

// releaseToPreset 把统一模型的 Release 投影成旧 DTO。
// 注意 Author 语义:旧 DTO 的 Author 是**上传者**(归属判断依赖它),对应 Publisher。
func releaseToPreset(r Release) AgentPreset {
	return AgentPreset{
		ID: r.ID, Name: r.AppID, DisplayName: r.Title, Description: r.Description,
		Version: r.Version, Author: r.Publisher, Checksum: r.Checksum,
		Status: AgentPresetStatus(r.Status), Reason: r.Reason, Quality: r.Quality,
		Archive: r.Archive, Downloads: r.Downloads,
		CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
	}
}

// latestPresetRelease 取一个预设的展示版本:最高 approved;没有则取最新一条。
func latestPresetRelease(db *sql.DB, name string) (*Release, error) {
	list, err := ListReleases(db, AppKindAgent, name)
	if err != nil {
		return nil, err
	}
	var best, newest *Release
	for i := range list {
		r := list[i]
		if r.DeletedAt != nil {
			continue
		}
		if newest == nil || r.CreatedAt.After(newest.CreatedAt) {
			newest = &list[i]
		}
		if r.Status != ReleaseStatusApproved {
			continue
		}
		if best == nil || compareVersionStrings(r.Version, best.Version) > 0 {
			best = &list[i]
		}
	}
	if best == nil {
		best = newest
	}
	if best == nil {
		return nil, ErrNotFound
	}
	return GetRelease(db, AppKindAgent, name, best.Version)
}

// CreateAgentPreset 新建一个预设版本(App 身份 + Release 快照)。
func CreateAgentPreset(db *sql.DB, p *AgentPreset) (int64, error) {
	appTitle := p.DisplayName
	if appTitle == "" {
		appTitle = p.Name
	}
	if err := UpsertApp(db, &App{
		Kind: AppKindAgent, AppID: p.Name, Title: appTitle, Description: p.Description,
		Owner: p.Author, Channel: AppChannelOrg, Enabled: 1,
	}); err != nil {
		return 0, err
	}
	status := string(p.Status)
	if status == "" {
		status = ReleaseStatusPending
	}
	version := p.Version
	if version == "" {
		version = "1.0.0"
	}
	id, err := CreateRelease(db, &Release{
		Kind: AppKindAgent, AppID: p.Name, Version: version, Title: p.DisplayName,
		Description: p.Description, Author: p.Author, Publisher: p.Author,
		Checksum: p.Checksum, Archive: p.Archive, Status: status, Reason: p.Reason, Quality: p.Quality,
	})
	if err != nil && isUniqueViolation(err) {
		return 0, ErrDuplicate
	}
	return id, err
}

// CreateAgentPresetCapped 同上,附带每作者待审配额。
func CreateAgentPresetCapped(db *sql.DB, p *AgentPreset, pendingCap int) (int64, error) {
	if pendingCap > 0 {
		n, err := PendingReleaseCount(db, p.Author)
		if err != nil {
			return 0, err
		}
		if n >= pendingCap {
			return 0, ErrTooManyPending
		}
	}
	return CreateAgentPreset(db, p)
}

// GetAgentPreset 取展示版本(含归档)。
func GetAgentPreset(db *sql.DB, name string) (*AgentPreset, error) {
	r, err := latestPresetRelease(db, name)
	if err != nil {
		return nil, err
	}
	out := releaseToPreset(*r)
	return &out, nil
}

// GetAgentPresetByVersion 取指定版本(含归档)。
func GetAgentPresetByVersion(db *sql.DB, name, version string) (*AgentPreset, error) {
	r, err := GetRelease(db, AppKindAgent, name, version)
	if err != nil {
		return nil, err
	}
	if r.DeletedAt != nil {
		return nil, ErrNotFound
	}
	out := releaseToPreset(*r)
	return &out, nil
}

// ListAgentPresets 管理端清单(status 为空 = 全部)。
func ListAgentPresets(db *sql.DB, status string) ([]AgentPreset, error) {
	list, err := ListReleasesByStatus(db, AppKindAgent, status)
	if err != nil {
		return nil, err
	}
	out := make([]AgentPreset, 0, len(list))
	for _, r := range list {
		out = append(out, releaseToPreset(r))
	}
	return out, nil
}

// ListVisibleAgentPresets 员工可见清单:approved 且已授权 + 自己上传的全部状态。
func ListVisibleAgentPresets(db *sql.DB, author string, granted []string) ([]AgentPreset, error) {
	list, err := ListReleasesByStatus(db, AppKindAgent, "")
	if err != nil {
		return nil, err
	}
	ok := map[string]bool{}
	for _, g := range granted {
		ok[g] = true
	}
	out := []AgentPreset{}
	for _, r := range list {
		if r.Publisher == author || (r.Status == ReleaseStatusApproved && ok[r.AppID]) {
			out = append(out, releaseToPreset(r))
		}
	}
	return out, nil
}

// SetAgentPresetStatus 审核展示版本。
func SetAgentPresetStatus(db *sql.DB, name string, status AgentPresetStatus, reason string) error {
	r, err := latestPresetRelease(db, name)
	if err != nil {
		return err
	}
	return SetReleaseStatus(db, AppKindAgent, name, r.Version, string(status), reason)
}

// SetAgentPresetStatusByVersion 审核指定版本。
func SetAgentPresetStatusByVersion(db *sql.DB, name, version string, status AgentPresetStatus, reason string) error {
	return SetReleaseStatus(db, AppKindAgent, name, version, string(status), reason)
}

// DeleteAgentPreset 删除展示版本(软删:版本号永久占位)。
func DeleteAgentPreset(db *sql.DB, name string) error {
	r, err := latestPresetRelease(db, name)
	if err != nil {
		return err
	}
	return SoftDeleteRelease(db, AppKindAgent, name, r.Version)
}

// DeleteAgentPresetByVersion 删除指定版本(软删)。
func DeleteAgentPresetByVersion(db *sql.DB, name, version string) error {
	return SoftDeleteRelease(db, AppKindAgent, name, version)
}

// ValidAgentQuality 质量标记合法值。
func ValidAgentQuality(q string) bool { return q == "" || q == "featured" }

// SetAgentPresetQuality 质量标记(仅 approved 版本)。
func SetAgentPresetQuality(db *sql.DB, name, version, quality string) error {
	if !ValidAgentQuality(quality) {
		return ErrValidation
	}
	return SetReleaseQuality(db, AppKindAgent, name, version, quality)
}

// SetAgentPresetArchive 覆盖某版本归档(数据修复/测试播种用;发布路径不调用)。
func SetAgentPresetArchive(db *sql.DB, name, version string, archive []byte) error {
	_, err := db.Exec(`UPDATE app_releases SET archive = ?, size = ?, updated_at = `+NowExpr()+`
		WHERE kind = ? AND app_id = ? AND version = ?`, archive, len(archive), AppKindAgent, name, version)
	return err
}

// GetAgentPresetArchive 取归档字节。
func GetAgentPresetArchive(db *sql.DB, name, version string) ([]byte, error) {
	r, err := GetRelease(db, AppKindAgent, name, version)
	if err != nil {
		return nil, err
	}
	return r.Archive, nil
}

// ClearAgentPresetArchive 清空归档字节。
func ClearAgentPresetArchive(db *sql.DB, name, version string) error {
	_, err := db.Exec(`UPDATE app_releases SET archive = NULL, size = 0, updated_at = `+NowExpr()+`
		WHERE kind = ? AND app_id = ? AND version = ?`, AppKindAgent, name, version)
	return err
}

// IncrementAgentPresetDownload 下载计数。
func IncrementAgentPresetDownload(db *sql.DB, name, version string) (bool, error) {
	if err := IncrementReleaseDownload(db, AppKindAgent, name, version); err != nil {
		return false, err
	}
	return true, nil
}

// UpdateAgentPresetResubmit 兼容旧签名:覆盖展示版本的元数据并回到 pending。
// 版本快照原则下生产不再走覆盖重提(必须升版本号),此函数仅供数据修复与测试。
func UpdateAgentPresetResubmit(db *sql.DB, name, displayName, description, checksum string) error {
	r, err := latestPresetRelease(db, name)
	if err != nil {
		return err
	}
	return UpdateAgentPresetResubmitByVersion(db, name, r.Version, displayName, description, checksum, r.Publisher)
}

// UpdateAgentPresetResubmitByVersion 覆盖指定版本的元数据并回到 pending。
func UpdateAgentPresetResubmitByVersion(db *sql.DB, name, version, displayName, description, checksum, author string) error {
	res, err := db.Exec(`UPDATE app_releases SET title = ?, description = ?, checksum = ?,
		publisher = ?, status = 'pending', reason = '', quality = '', updated_at = `+NowExpr()+`
		WHERE kind = ? AND app_id = ? AND version = ?`,
		displayName, description, checksum, author, AppKindAgent, name, version)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// UpdateAgentPresetResubmitByVersionWithArchive 同上并覆盖归档。
func UpdateAgentPresetResubmitByVersionWithArchive(db *sql.DB, name, version, displayName, description, checksum, author string, archive []byte) error {
	res, err := db.Exec(`UPDATE app_releases SET title = ?, description = ?, checksum = ?,
		publisher = ?, archive = ?, size = ?, status = 'pending', reason = '', quality = '',
		updated_at = `+NowExpr()+` WHERE kind = ? AND app_id = ? AND version = ?`,
		displayName, description, checksum, author, archive, len(archive), AppKindAgent, name, version)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
