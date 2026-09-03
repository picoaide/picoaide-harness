package serverstore

import (
	"database/sql"
	"errors"
	"strings"
	"time"
)

// qmarks builds an n-item comma-separated `?,?` list for IN clauses.
func qmarks(n int) string {
	if n <= 0 {
		return "''"
	}
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

// SharedSkillStatus is the review state of one shared skill row.
type SharedSkillStatus string

const (
	// SharedSkillPending awaits an admin review decision.
	SharedSkillPending SharedSkillStatus = "pending"
	// SharedSkillApproved is visible and installable by every employee.
	SharedSkillApproved SharedSkillStatus = "approved"
	// SharedSkillRejected is invisible to everyone but its author, who may
	// resubmit the same name+version (the row is reused, reset to pending).
	SharedSkillRejected SharedSkillStatus = "rejected"
)

// SharedSkill is one shared skill row (unique by name+version).
type SharedSkill struct {
	ID          int64
	Name        string
	DisplayName string
	Version     string
	Description string
	Author      string
	Checksum    string
	Status      SharedSkillStatus
	// Reason is the admin's rejection reason; empty unless rejected.
	Reason string
	// Quality 是组织库质量标记(0037):''|'official'|'featured' 互斥,
	// 仅对 approved 行有展示语义;与市场「免费/专业」分级词表隔离。
	Quality string
	// Archive is the uploaded archive bytes (0040: 归档直存 DB,不再落磁盘).
	Archive []byte
	// Downloads counts successful archive downloads.
	Downloads int64
	// Calls counts skill invocations reported by clients (telemetry).
	Calls     int64
	CreatedAt time.Time
	UpdatedAt time.Time
}

// ---------------------------------------------------------------------------
// P2 适配层(迁移 0053/0054):以下函数保留原有签名与语义,内部改为读写统一的
// apps/app_releases。旧表 shared_skills 在兼容期内只读保留,P5 再下线。
// 这样做的好处是三条上传路径与全部审核/授权 handler 无需改动即可切换存储。
// ---------------------------------------------------------------------------

// releaseToShared 把统一模型的 Release 投影成旧 DTO。
func releaseToShared(r Release) SharedSkill {
	return SharedSkill{
		ID: r.ID, Name: r.AppID, DisplayName: r.Title, Version: r.Version,
		// 旧 DTO 的 Author 语义是**上传者**(全部归属/可见性判断都依赖它),
		// 对应统一模型的 Publisher;包内署名 Release.Author 不参与这些判断。
		Description: r.Description, Author: r.Publisher, Checksum: r.Checksum,
		Status: SharedSkillStatus(r.Status), Reason: r.Reason, Quality: r.Quality,
		Archive: r.Archive, Downloads: r.Downloads, Calls: r.Calls,
		CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
	}
}

// orgSkillReleases 取组织渠道技能的全部版本(排除软删)。
func orgSkillReleases(db *sql.DB, status string) ([]Release, error) {
	all, err := ListReleasesByStatus(db, AppKindSkill, status)
	if err != nil {
		return nil, err
	}
	apps, err := ListApps(db, AppKindSkill, AppChannelOrg)
	if err != nil {
		return nil, err
	}
	org := map[string]bool{}
	for _, a := range apps {
		org[a.AppID] = true
	}
	out := []Release{}
	for _, r := range all {
		if org[r.AppID] {
			out = append(out, r)
		}
	}
	return out, nil
}

// GetSharedSkill 取一个版本(含归档)。
func GetSharedSkill(db *sql.DB, name, version string) (*SharedSkill, error) {
	r, err := GetRelease(db, AppKindSkill, name, version)
	if err != nil {
		return nil, err
	}
	if r.DeletedAt != nil {
		return nil, ErrNotFound
	}
	out := releaseToShared(*r)
	return &out, nil
}

// ListSharedSkills 管理端清单(status 为空 = 全部)。
func ListSharedSkills(db *sql.DB, status string) ([]SharedSkill, error) {
	list, err := orgSkillReleases(db, status)
	if err != nil {
		return nil, err
	}
	out := make([]SharedSkill, 0, len(list))
	for _, r := range list {
		out = append(out, releaseToShared(r))
	}
	return out, nil
}

// ListVisibleSharedSkills 员工可见清单:approved 且已授权 + 自己上传的全部状态。
func ListVisibleSharedSkills(db *sql.DB, author string, granted []string) ([]SharedSkill, error) {
	list, err := orgSkillReleases(db, "")
	if err != nil {
		return nil, err
	}
	ok := map[string]bool{}
	for _, g := range granted {
		ok[g] = true
	}
	out := []SharedSkill{}
	for _, r := range list {
		if r.Publisher == author || (r.Status == ReleaseStatusApproved && ok[r.AppID]) {
			out = append(out, releaseToShared(r))
		}
	}
	return out, nil
}

// GetSharedSkillArchive 取归档字节。
func GetSharedSkillArchive(db *sql.DB, name, version string) ([]byte, error) {
	r, err := GetRelease(db, AppKindSkill, name, version)
	if err != nil {
		return nil, err
	}
	return r.Archive, nil
}

// IncrementSharedSkillDownload 下载计数。
func IncrementSharedSkillDownload(db *sql.DB, name, version string) (bool, error) {
	if err := IncrementReleaseDownload(db, AppKindSkill, name, version); err != nil {
		return false, err
	}
	return true, nil
}

// SetSharedSkillStatus 审核(只改状态位,不碰内容)。
func SetSharedSkillStatus(db *sql.DB, name, version string, status SharedSkillStatus, reason string) error {
	return SetReleaseStatus(db, AppKindSkill, name, version, string(status), reason)
}

// DeleteSharedSkill 删除一个版本 = 软删(版本号永久占位,不可复用)。
func DeleteSharedSkill(db *sql.DB, name, version string) error {
	return SoftDeleteRelease(db, AppKindSkill, name, version)
}

// DeleteSharedSkillArchive 清空某版本的归档字节(版本行与审核记录保留)。
func DeleteSharedSkillArchive(db *sql.DB, name, version string) error {
	_, err := db.Exec(`UPDATE app_releases SET archive = NULL, size = 0, updated_at = `+NowExpr()+`
		WHERE kind = ? AND app_id = ? AND version = ?`, AppKindSkill, name, version)
	return err
}

// ValidSharedQuality 质量标记合法值。
func ValidSharedQuality(q string) bool { return q == "" || q == "featured" }

// SetSharedSkillQuality 质量标记(仅 approved 版本)。
func SetSharedSkillQuality(db *sql.DB, name, version, quality string) error {
	if !ValidSharedQuality(quality) {
		return ErrValidation
	}
	return SetReleaseQuality(db, AppKindSkill, name, version, quality)
}

// CreateSharedSkill 新建一个组织渠道技能版本(App 身份 + Release 快照)。
// 保留此签名供播种与测试使用;生产上传路径走 appstore.Publish(统一发布内核)。
func CreateSharedSkill(db *sql.DB, s *SharedSkill) (int64, error) {
	appTitle := s.DisplayName
	if appTitle == "" {
		appTitle = s.Name
	}
	// 跨渠道同名互斥(旧 skills/shared_skills 双向阻断的等价约束)。
	if existing, err := GetApp(db, AppKindSkill, s.Name); err == nil && existing.Channel != AppChannelOrg {
		return 0, ErrConflict
	} else if err != nil && !errors.Is(err, ErrNotFound) {
		return 0, err
	}
	if err := UpsertApp(db, &App{
		Kind: AppKindSkill, AppID: s.Name, Title: appTitle, Description: s.Description,
		Owner: s.Author, Channel: AppChannelOrg, Enabled: 1,
	}); err != nil {
		return 0, err
	}
	status := string(s.Status)
	if status == "" {
		status = ReleaseStatusPending
	}
	id, err := CreateRelease(db, &Release{
		// Release.Title 保留调用方给的展示名原值(可为空),DTO 往返一致。
		Kind: AppKindSkill, AppID: s.Name, Version: s.Version, Title: s.DisplayName,
		Description: s.Description, Author: s.Author, Publisher: s.Author,
		Checksum: s.Checksum, Archive: s.Archive, Status: status, Reason: s.Reason,
		Quality: s.Quality,
	})
	if err != nil && isUniqueViolation(err) {
		return 0, ErrDuplicate
	}
	return id, err
}

// CreateSharedSkillCapped 同上,附带每作者待审配额(超出返回 ErrTooManyPending)。
func CreateSharedSkillCapped(db *sql.DB, s *SharedSkill, pendingCap int) (int64, error) {
	if pendingCap > 0 {
		n, err := PendingReleaseCount(db, s.Author)
		if err != nil {
			return 0, err
		}
		if n >= pendingCap {
			return 0, ErrTooManyPending
		}
	}
	return CreateSharedSkill(db, s)
}

// SetSharedSkillArchive 覆盖某版本的归档。
// 注意:版本快照不可变(决策 D3),该函数仅供数据修复/测试播种使用,
// 生产发布路径不会调用它。
func SetSharedSkillArchive(db *sql.DB, name, version string, archive []byte) error {
	res, err := db.Exec(`UPDATE app_releases SET archive = ?, size = ?, updated_at = `+NowExpr()+`
		WHERE kind = ? AND app_id = ? AND version = ?`,
		archive, len(archive), AppKindSkill, name, version)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
