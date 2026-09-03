package serverstore

import (
	"database/sql"
	"errors"
	"strconv"
	"strings"
	"time"
)

// Skill is a marketplace skill row.
type Skill struct {
	ID   int64
	Name string
	// DisplayName 是展示名(0051):来自包内 SKILL.md 的 frontmatter title,
	// 空值时读侧回退 Name。
	DisplayName string
	Version     string
	Description string
	Author      string
	Checksum    string
	Enabled     int
	// Archive holds the uploaded archive bytes (归档上传是唯一入口)。
	Archive []byte
	// Downloads counts successful archive downloads.
	Downloads int64
	// Calls counts skill invocations reported by clients (telemetry).
	Calls int64
	// Official 官方属性(0059, App 级): 归属官方 = 蓝标 + 仅管理员可上传。
	Official int
	// DownloadedAt/updated overlay created/updated.
	CreatedAt time.Time
	UpdatedAt time.Time
}

// ---------------------------------------------------------------------------
// P2 适配层(迁移 0053/0054):市场技能保留原有签名,内部读写统一的
// apps/app_releases(channel=market)。市场因此获得**多版本快照**能力——
// 旧的单行原地覆盖模型是「无版本历史、不能回滚」的根因。
// 旧表 skills 兼容期内只读保留,P5 下线。
// ---------------------------------------------------------------------------

// currentMarketRelease 取市场技能的展示版本:最高 approved 且未软删。
func currentMarketRelease(db *sql.DB, appID string, withArchive bool) (*Release, error) {
	return currentRelease(db, AppKindSkill, appID, withArchive)
}

// CurrentMarketReleaseFor 取任意 kind 的展示版本(G4 市场智能体复用同一语义)。
func CurrentMarketReleaseFor(db *sql.DB, kind, appID string, withArchive bool) (*Release, error) {
	return currentRelease(db, kind, appID, withArchive)
}

// currentRelease 取某 App 的展示版本:最高 approved 且未软删。
func currentRelease(db *sql.DB, kind, appID string, withArchive bool) (*Release, error) {
	list, err := ListReleases(db, kind, appID)
	if err != nil {
		return nil, err
	}
	var best *Release
	for i := range list {
		r := list[i]
		if r.DeletedAt != nil || r.Status != ReleaseStatusApproved {
			continue
		}
		if best == nil || compareVersionStrings(r.Version, best.Version) > 0 {
			best = &list[i]
		}
	}
	if best == nil {
		return nil, nil
	}
	if withArchive {
		return GetRelease(db, kind, appID, best.Version)
	}
	return best, nil
}

// compareVersionStrings 数值感知比较(与 skillmanifest.CompareVersions 同规则;
// serverstore 不依赖上层包,故在此保留一份小实现)。
func compareVersionStrings(a, b string) int {
	as, bs := strings.Split(strings.SplitN(a, "-", 2)[0], "."), strings.Split(strings.SplitN(b, "-", 2)[0], ".")
	for i := 0; i < 3; i++ {
		var av, bv int
		if i < len(as) {
			av, _ = strconv.Atoi(as[i])
		}
		if i < len(bs) {
			bv, _ = strconv.Atoi(bs[i])
		}
		if av != bv {
			return av - bv
		}
	}
	return strings.Compare(a, b)
}

// appToSkill 把 App + 展示版本投影成旧 Skill DTO。
func appToSkill(a App, r *Release) Skill {
	out := Skill{
		Name: a.AppID, DisplayName: a.Title, Description: a.Description,
		Author: a.Owner, Enabled: a.Enabled, Official: a.Official,
		CreatedAt: a.CreatedAt, UpdatedAt: a.UpdatedAt,
	}
	if r != nil {
		out.ID, out.Version, out.Checksum = r.ID, r.Version, r.Checksum
		out.Archive, out.Downloads, out.Calls = r.Archive, r.Downloads, r.Calls
		// 描述以 App 层为准(管理端元数据编辑写在 App 上);App 为空才回退版本描述。
		if out.Description == "" {
			out.Description = r.Description
		}
	}
	return out
}

// SkillNameExists 市场命名占用检查。
func SkillNameExists(db *sql.DB, name string) (bool, error) {
	a, err := GetApp(db, AppKindSkill, name)
	if errors.Is(err, ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return a.Channel == AppChannelMarket, nil
}

// AddSkill 登记一个市场 App(可带首个版本的归档)。跨渠道同名互斥。
func AddSkill(db *sql.DB, s *Skill) (int64, error) {
	if existing, err := GetApp(db, AppKindSkill, s.Name); err == nil {
		if existing.Channel != AppChannelMarket {
			return 0, ErrConflict
		}
		return 0, ErrDuplicate
	} else if !errors.Is(err, ErrNotFound) {
		return 0, err
	}
	title := s.DisplayName
	if title == "" {
		title = s.Name
	}
	if err := UpsertApp(db, &App{
		Kind: AppKindSkill, AppID: s.Name, Title: title, Description: s.Description,
		Owner: s.Author, Channel: AppChannelMarket, Enabled: s.Enabled,
	}); err != nil {
		return 0, err
	}
	// 没有归档就只登记 App 身份:版本号必须随内容一起产生,
	// 否则「创建时填了版本 → 首次上传同版本」会撞版本唯一约束。
	if len(s.Archive) == 0 {
		return 1, nil
	}
	version := s.Version
	if version == "" {
		version = "1.0.0"
	}
	return CreateRelease(db, &Release{
		Kind: AppKindSkill, AppID: s.Name, Version: version, Title: s.DisplayName,
		Description: s.Description, Author: s.Author, Publisher: s.Author,
		Checksum: s.Checksum, Archive: s.Archive, Status: ReleaseStatusApproved,
	})
}

// GetSkill 取市场技能(展示版本 + 归档)。
func GetSkill(db *sql.DB, name string) (*Skill, error) {
	a, err := GetApp(db, AppKindSkill, name)
	if err != nil {
		return nil, err
	}
	if a.Channel != AppChannelMarket {
		return nil, ErrNotFound
	}
	r, err := currentMarketRelease(db, name, true)
	if err != nil {
		return nil, err
	}
	out := appToSkill(*a, r)
	return &out, nil
}

// UpdateSkill 更新元数据(不触碰版本与归档:内容一律由发布写入)。
func UpdateSkill(db *sql.DB, s *Skill) error {
	title := s.DisplayName
	if title == "" {
		title = s.Name
	}
	res, err := db.Exec(`UPDATE apps SET title = ?, description = ?, owner = ?, enabled = ?,
		updated_at = `+NowExpr()+` WHERE kind = ? AND app_id = ?`,
		title, s.Description, s.Author, s.Enabled, AppKindSkill, s.Name)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ReplaceSkillArchive 发布一个新版本(不再原地覆盖——版本即不可变快照)。
// 同版本号已存在时返回 ErrDuplicate,由上层给出明确的 VERSION_EXISTS。
func ReplaceSkillArchive(db *sql.DB, name, version, checksum string, archive []byte) error {
	a, err := GetApp(db, AppKindSkill, name)
	if err != nil {
		return err
	}
	if _, err := CreateRelease(db, &Release{
		Kind: AppKindSkill, AppID: name, Version: version, Title: a.Title,
		Description: a.Description, Author: a.Owner, Publisher: a.Owner,
		Checksum: checksum, Archive: archive, Status: ReleaseStatusApproved,
	}); err != nil {
		if isUniqueViolation(err) {
			return ErrDuplicate
		}
		return err
	}
	return nil
}

// SetSkillEnabled 上下架(保留数据)。
func SetSkillEnabled(db *sql.DB, name string, enabled bool) (int64, error) {
	if err := SetAppEnabled(db, AppKindSkill, name, enabled); err != nil {
		return 0, err
	}
	return 1, nil
}

// ListSkills 市场清单(enabledOnly=true 只返回已上架)。
func ListSkills(db *sql.DB, enabledOnly bool) ([]Skill, error) {
	apps, err := ListApps(db, AppKindSkill, AppChannelMarket)
	if err != nil {
		return nil, err
	}
	out := []Skill{}
	for _, a := range apps {
		if enabledOnly && a.Enabled != 1 {
			continue
		}
		r, err := currentMarketRelease(db, a.AppID, false)
		if err != nil {
			return nil, err
		}
		out = append(out, appToSkill(a, r))
	}
	return out, nil
}

// IncrementSkillDownload 下载计数(记在展示版本上)。
func IncrementSkillDownload(db *sql.DB, name string) (bool, error) {
	r, err := currentMarketRelease(db, name, false)
	if err != nil || r == nil {
		return false, err
	}
	return true, IncrementReleaseDownload(db, AppKindSkill, name, r.Version)
}

// IncrementSkillCall 调用计数(客户端遥测按 name+version 上报)。
func IncrementSkillCall(db *sql.DB, name, version string) (bool, error) {
	if version == "" {
		// 遥测可能只上报名字:落到展示版本上。
		r, err := currentMarketRelease(db, name, false)
		if err != nil || r == nil {
			return false, err
		}
		version = r.Version
	}
	res, err := db.Exec(`UPDATE app_releases SET calls = calls + 1
		WHERE kind = ? AND app_id = ? AND version = ?`, AppKindSkill, name, version)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// SetSkillDisplayName 写入展示名(来自包内 title)。
func SetSkillDisplayName(db *sql.DB, name, displayName string) error {
	res, err := db.Exec(`UPDATE apps SET title = ?, updated_at = `+NowExpr()+`
		WHERE kind = ? AND app_id = ?`, displayName, AppKindSkill, name)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
