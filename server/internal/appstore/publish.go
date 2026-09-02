// Package appstore implements the unified publish kernel over the App /
// Release model (决策 docs/decisions/2026-09-01-skill-app-management.md P2)。
//
// 它是**唯一的内容写入口**:管理后台上架、客户端能力中心上传、客户端智能体
// 预设上传三条路径最终都调用 Publish,因此严格校验、版本语义、锁定与配额只
// 需实现一次。各域的 HTTP handler 只负责鉴权与参数搬运。
package appstore

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/skillmanifest"
)

// 冲突类错误码(包内校验类错误码定义在 skillmanifest)。
const (
	CodeVersionExists        = "VERSION_EXISTS"
	CodeVersionNotIncreasing = "VERSION_NOT_INCREASING"
	CodeContentUnchanged     = "CONTENT_UNCHANGED"
	CodeAppLocked            = "APP_LOCKED"
	CodeNameTaken            = "NAME_TAKEN"
	CodePendingLimit         = "PENDING_LIMIT"
	CodeNotFound             = "NOT_FOUND"
)

// Error 是发布失败的结构化结果:HTTP 状态 + 稳定错误码 + 面向用户的中文说明。
type Error struct {
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func newErr(status int, code, format string, args ...any) *Error {
	return &Error{Status: status, Code: code, Message: fmt.Sprintf(format, args...)}
}

// PublishRequest 描述一次发布。元数据一律由服务端从包内解析(「包内即真相」),
// 调用方只提供身份、渠道与归档字节。
type PublishRequest struct {
	Kind    string // skill | agent
	AppID   string
	Channel string // market | org
	Archive []byte
	// Publisher 是发布账号(登录态),不可由请求体伪造。
	Publisher string
	// AdminPublish=true 时跳过锁定检查与待审配额,且发布即 approved
	// (管理后台上架等价于已审核)。
	AdminPublish bool
	// PendingCap 为 0 表示不限;仅对非管理员发布生效。
	PendingCap int
	// DeclaredVersion 非空时必须与包内版本一致(管理后台表单是显式意图)。
	DeclaredVersion string
	// Manifest 由调用方预先解析好(技能走 skillmanifest;智能体没有 SKILL.md,
	// 由各自域构造一个等价清单)。
	Manifest Manifest
	// Checksum 是归档的 sha256(由调用方在安全校验时算出,避免重复哈希)。
	Checksum string
}

// Manifest 是发布所需的元数据集合(技能来自 SKILL.md frontmatter)。
type Manifest struct {
	Version     string
	Title       string
	Description string
	Changelog   string
	Category    string
	Author      string
	Tags        []string
}

// FromSkillManifest 把技能清单转成发布内核的通用清单。
func FromSkillManifest(m *skillmanifest.Manifest) Manifest {
	return Manifest{
		Version: m.Version, Title: m.Title, Description: m.Description,
		Changelog: m.Changelog, Category: m.Category, Author: m.Author, Tags: m.Tags,
	}
}

// Result 是一次成功发布的结果。
type Result struct {
	Version  string
	Status   string
	Checksum string
}

// Publish 执行一次发布:锁定检查 → 版本语义 → 落库。
//
// 版本语义(决策 D1/D3),三条规则都以「该 App 的全部历史版本」为依据,
// 被拒与软删的版本同样占位——版本号一经使用即永久不可复用:
//  1. 同版本号已存在 → VERSION_EXISTS;
//  2. 内容与本人已提交过的某版本完全相同 → CONTENT_UNCHANGED;
//  3. 新版本号必须严格大于现有最高版本 → VERSION_NOT_INCREASING
//     (首次发布、即该 App 尚无任何版本时不适用)。
func Publish(db *sql.DB, req PublishRequest) (*Result, error) {
	if !skillmanifest.IsAppID(req.AppID) {
		return nil, newErr(http.StatusBadRequest, skillmanifest.CodeInvalidAppID,
			"名称不合法:必须是小写 kebab-case(如 my-skill)")
	}
	if req.Manifest.Version == "" || !skillmanifest.IsVersion(req.Manifest.Version) {
		return nil, newErr(http.StatusUnprocessableEntity, skillmanifest.CodeInvalidVersion,
			"版本号不合法:必须是 x.y.z")
	}
	if req.DeclaredVersion != "" && req.DeclaredVersion != req.Manifest.Version {
		return nil, newErr(http.StatusUnprocessableEntity, skillmanifest.CodeManifestMismatch,
			"表单版本(%s)与包内 version(%s)不一致,请以包内版本为准",
			req.DeclaredVersion, req.Manifest.Version)
	}

	// 锁定:被锁定的名字只能由管理员发布,员工命中即明确拒绝并回显理由。
	if !req.AdminPublish {
		if lock, err := serverstore.GetCapabilityLock(db, req.Kind, req.AppID); err == nil {
			msg := "该能力已被管理员锁定,仅管理员可发布"
			if lock.Reason != "" {
				msg += ":" + lock.Reason
			}
			return nil, newErr(http.StatusForbidden, CodeAppLocked, "%s", msg)
		} else if !errors.Is(err, serverstore.ErrNotFound) {
			return nil, newErr(http.StatusInternalServerError, "INTERNAL", "查询失败")
		}
	}

	// 跨渠道同名互斥:一个 (kind, app_id) 只能属于一个渠道。
	existingApp, appErr := serverstore.GetApp(db, req.Kind, req.AppID)
	if appErr != nil && !errors.Is(appErr, serverstore.ErrNotFound) {
		return nil, newErr(http.StatusInternalServerError, "INTERNAL", "查询失败")
	}
	if appErr == nil && existingApp.Channel != req.Channel {
		return nil, newErr(http.StatusConflict, CodeNameTaken,
			"名称已被%s占用,请换个名字或联系管理员", channelLabel(existingApp.Channel))
	}
	// 归属保护(2026-09-02 收紧):他人的 App(任意状态,含空 owner 的历史
	// 行——空 owner 一律视同占名,杜绝员工「接管」成新 owner)不允许被其他
	// 非管理员接管发布。404 不泄露存在性(与「未授权不可见」同一原则),
	// 文案保持中性,不暴露被占名者的任何信息。
	if appErr == nil && !req.AdminPublish && existingApp.Owner != req.Publisher {
		return nil, newErr(http.StatusNotFound, CodeNotFound,
			"名称不可用:可能已被占用或不属于你")
	}

	history, err := serverstore.ListReleases(db, req.Kind, req.AppID)
	if err != nil {
		return nil, newErr(http.StatusInternalServerError, "INTERNAL", "查询失败")
	}
	newest := ""
	for _, h := range history {
		if h.Version == req.Manifest.Version {
			return nil, newErr(http.StatusConflict, CodeVersionExists,
				"版本 %s 已存在(每个版本都是不可修改的快照),请升版本号后重试", req.Manifest.Version)
		}
		if h.Checksum != "" && h.Checksum == req.Checksum && h.Publisher == req.Publisher {
			return nil, newErr(http.StatusConflict, CodeContentUnchanged,
				"内容与你已提交的 v%s 完全一致,无需重复上传", h.Version)
		}
		if newest == "" || skillmanifest.CompareVersions(h.Version, newest) > 0 {
			newest = h.Version
		}
	}
	if newest != "" && skillmanifest.CompareVersions(req.Manifest.Version, newest) <= 0 {
		return nil, newErr(http.StatusConflict, CodeVersionNotIncreasing,
			"版本号必须大于当前最高版本 v%s(当前包内为 %s)", newest, req.Manifest.Version)
	}
	// 非首个版本必须写更新说明(决策 §5.2):审核人与使用者据此判断该不该升级。
	// 该规则依赖「是否已有历史版本」,因此只能在发布内核里判定。
	if len(history) > 0 && strings.TrimSpace(req.Manifest.Changelog) == "" {
		return nil, newErr(http.StatusUnprocessableEntity, skillmanifest.CodeMissingField,
			"非首个版本必须填写 changelog(本版改了什么)")
	}

	// 待审配额(仅员工发布)。
	if !req.AdminPublish && req.PendingCap > 0 {
		n, err := serverstore.PendingReleaseCount(db, req.Publisher)
		if err != nil {
			return nil, newErr(http.StatusInternalServerError, "INTERNAL", "查询失败")
		}
		if n >= req.PendingCap {
			return nil, newErr(http.StatusTooManyRequests, CodePendingLimit,
				"待审核数量已达上限(%d),请等待审核", req.PendingCap)
		}
	}

	owner := req.Publisher
	if appErr == nil && existingApp.Owner != "" {
		owner = existingApp.Owner
	}
	enabled := 1
	if appErr == nil {
		enabled = existingApp.Enabled
	}
	if err := serverstore.UpsertApp(db, &serverstore.App{
		Kind: req.Kind, AppID: req.AppID, Title: req.Manifest.Title,
		Description: req.Manifest.Description, Owner: owner, Channel: req.Channel, Enabled: enabled,
	}); err != nil {
		return nil, newErr(http.StatusInternalServerError, "INTERNAL", "保存失败")
	}

	status := serverstore.ReleaseStatusPending
	if req.AdminPublish {
		// 管理后台上架 = 已审核(与旧市场语义一致:上架即可分发)。
		status = serverstore.ReleaseStatusApproved
	}
	if _, err := serverstore.CreateRelease(db, &serverstore.Release{
		Kind: req.Kind, AppID: req.AppID, Version: req.Manifest.Version,
		Title: req.Manifest.Title, Description: req.Manifest.Description,
		Changelog: req.Manifest.Changelog, Category: req.Manifest.Category,
		Tags: req.Manifest.Tags, Author: req.Manifest.Author, Publisher: req.Publisher,
		Checksum: req.Checksum, Archive: req.Archive, Status: status,
	}); err != nil {
		// B7(2026-09-01):并发窗口内 (kind,app_id,version) 唯一约束兜底,
		// 映射为语义正确的 409 VERSION_EXISTS 而非 500。
		if errors.Is(err, serverstore.ErrDuplicate) {
			return nil, newErr(http.StatusConflict, CodeVersionExists,
				"版本 %s 已存在(每个版本都是不可修改的快照),请升版本号后重试", req.Manifest.Version)
		}
		return nil, newErr(http.StatusInternalServerError, "INTERNAL", "保存失败")
	}
	return &Result{Version: req.Manifest.Version, Status: status, Checksum: req.Checksum}, nil
}

func channelLabel(channel string) string {
	if channel == serverstore.AppChannelMarket {
		return "市场"
	}
	return "组织共享库"
}

// VisibleReleases 返回某用户可见的「展示版本」清单:每个 App 一条,取其
// 最高 approved 版本。可见性 = App 已上架 ∧ 已授权 ∧ 该版本 approved 未删;
// 管理员恒全量;作者可见自己 App 的全部状态(便于看审核进度)。
func VisibleReleases(db *sql.DB, kind, username string, groups []string, isAdmin bool) ([]serverstore.Release, map[string]serverstore.App, error) {
	apps, err := serverstore.ListApps(db, kind, "")
	if err != nil {
		return nil, nil, err
	}
	granted := map[string]bool{}
	if !isAdmin {
		names, err := serverstore.AccessibleAppIDs(db, kind, username, groups)
		if err != nil {
			return nil, nil, err
		}
		for _, n := range names {
			granted[n] = true
		}
	}
	byID := map[string]serverstore.App{}
	out := []serverstore.Release{}
	for _, a := range apps {
		own := a.Owner == username
		if !isAdmin && !granted[a.AppID] && !own {
			continue
		}
		if a.Enabled != 1 && !isAdmin {
			continue
		}
		releases, err := serverstore.ListReleases(db, a.Kind, a.AppID)
		if err != nil {
			return nil, nil, err
		}
		best := pickDisplayRelease(releases, isAdmin || own)
		if best == nil {
			continue
		}
		byID[a.AppID] = a
		out = append(out, *best)
	}
	return out, byID, nil
}

// pickDisplayRelease 取展示版本:优先最高 approved;当查看者是作者/管理员时,
// 没有 approved 也返回最新一条(让他看到 pending/rejected 的进度)。
func pickDisplayRelease(releases []serverstore.Release, includeUnapproved bool) *serverstore.Release {
	var best *serverstore.Release
	for i := range releases {
		r := releases[i]
		if r.DeletedAt != nil {
			continue
		}
		if r.Status != serverstore.ReleaseStatusApproved {
			continue
		}
		if best == nil || skillmanifest.CompareVersions(r.Version, best.Version) > 0 {
			best = &releases[i]
		}
	}
	if best != nil || !includeUnapproved {
		return best
	}
	for i := range releases {
		if releases[i].DeletedAt != nil {
			continue
		}
		if best == nil || releases[i].CreatedAt.After(best.CreatedAt) {
			best = &releases[i]
		}
	}
	return best
}

// ApprovedVersions 返回某 App 全部 approved 且未删的版本号(升序)。
func ApprovedVersions(db *sql.DB, kind, appID string) ([]string, error) {
	releases, err := serverstore.ListReleases(db, kind, appID)
	if err != nil {
		return nil, err
	}
	out := []string{}
	for _, r := range releases {
		if r.Status == serverstore.ReleaseStatusApproved && r.DeletedAt == nil {
			out = append(out, r.Version)
		}
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && skillmanifest.CompareVersions(out[j-1], out[j]) > 0; j-- {
			out[j-1], out[j] = out[j], out[j-1]
		}
	}
	return out, nil
}
