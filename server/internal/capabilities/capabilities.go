// Package capabilities implements the unified capability catalog facade:
// one read surface aggregating the marketplace skills (授权制商城), the
// shared skills (组织共享库), and the shared agent presets (组织共享库)
// into a single CapabilityItem view for the desktop client, plus a unified
// admin approval queue over the two review domains.
//
// 设计(决策文档 2026-08-25):只做读侧 facade,不复制审核逻辑、不动表结构。
// 三源的可见性语义不同(见下),各自取数后合并;审核动作仍走原域端点。
package capabilities

import (
	"database/sql"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/marketplace"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/util"
)

// CapabilityKind is the content type discriminator.
type CapabilityKind string

const (
	KindSkill CapabilityKind = "skill"
	KindAgent CapabilityKind = "agent"
)

// CapabilitySource is the distribution source.
type CapabilitySource string

const (
	SourceMarket CapabilitySource = "market"
	SourceOrg    CapabilitySource = "org"
)

// CapabilityItem is one unified catalog row.
// 归并:同名(kind+name)的 approved 多版本被归并为一条(最高 approved 版本),
// versions 携带全部 approved 版本供「历史版本」展开;installed/hasUpdate 由
// 客户端 host 代理按本地磁盘补齐(本包不感知本地状态)。
type CapabilityItem struct {
	Kind        CapabilityKind   `json:"kind"`
	Source      CapabilitySource `json:"source"`
	Name        string           `json:"name"`
	DisplayName string           `json:"display_name"`
	Version     string           `json:"version"`
	Description string           `json:"description"`
	Author      string           `json:"author"`
	Status      string           `json:"status"`
	Reason      string           `json:"reason,omitempty"`
	Quality     string           `json:"quality,omitempty"`
	// Versions 是该名全部 approved 版本(升序,数值感知)。归并后当前
	// Version = 最高 approved 版本;versions[last] 恒等于 Version。
	Versions []string `json:"versions"`
}

// RegisterRoutes mounts /api/capabilities (employee Bearer endpoints).
func RegisterRoutes(r *gin.Engine, db *sql.DB, cacheDir string) {
	g := r.Group("/api/capabilities", serverauth.BearerAuth(db))
	g.GET("", listCapabilities(db, cacheDir))
}

// RegisterAdminRoutes mounts /api/admin/capabilities (AdminAuth endpoints):
// the unified approval queue over shared-skills + agent-presets.
func RegisterAdminRoutes(r *gin.Engine, db *sql.DB, cacheDir string) {
	g := r.Group("/api/admin/capabilities", serverauth.AdminAuth(db))
	g.GET("/approvals", listApprovals(db, cacheDir))
}

// ---------------------------------------------------------------------------
// 员工侧聚合
// ---------------------------------------------------------------------------

// viewer resolves the calling user's effective groups and admin flag, or ok=false.
func viewer(c *gin.Context, db *sql.DB) (u *serverstore.User, groups []string, ok bool) {
	u = serverauth.CurrentUser(c)
	if u == nil {
		return nil, nil, false
	}
	groups, err := serverstore.UserEffectiveGroups(db, u.ID)
	if err != nil {
		return nil, nil, false
	}
	return u, groups, true
}

type typeFilter struct {
	skills bool
	agents bool
}

// parseTypeFilter accepts ?type=all|skill|agent|comma-list; default all.
func parseTypeFilter(c *gin.Context) typeFilter {
	t := c.Query("type")
	switch t {
	case "skill":
		return typeFilter{skills: true}
	case "agent":
		return typeFilter{agents: true}
	case "", "all":
		return typeFilter{skills: true, agents: true}
	default:
		// 容忍逗号列表 (skill,agent) 与全量回退。
		seen := map[string]bool{}
		part := ""
		flush := func() {
			if part != "" {
				seen[part] = true
				part = ""
			}
		}
		for _, ch := range t {
			if ch == ',' {
				flush()
				continue
			}
			part += string(ch)
		}
		flush()
		return typeFilter{skills: seen["skill"], agents: seen["agent"]}
	}
}

// appendSkill merges one marketplace skill into the catalog (authorized/enabled only).
func appendSkill(out *[]CapabilityItem, s serverstore.Skill, versions map[string][]string) {
	versions[s.Name] = append(versions[s.Name], s.Version)
	*out = append(*out, CapabilityItem{
		Kind:        KindSkill,
		Source:      SourceMarket,
		Name:        s.Name,
		DisplayName: s.Name,
		Version:     s.Version,
		Description: s.Description,
		Author:      s.Author,
		Status:      "approved",
	})
}

// appendSharedSkill merges one shared-skill row (already visibility-filtered
// by the caller) with its quality tag and status.
func appendSharedSkill(out *[]CapabilityItem, s serverstore.SharedSkill, versions map[string][]string) {
	versions[s.Name] = append(versions[s.Name], s.Version)
	item := CapabilityItem{
		Kind:        KindSkill,
		Source:      SourceOrg,
		Name:        s.Name,
		DisplayName: s.DisplayName,
		Version:     s.Version,
		Description: s.Description,
		Author:      s.Author,
		Status:      string(s.Status),
		Reason:      s.Reason,
		Quality:     s.Quality,
	}
	*out = append(*out, item)
}

// appendSharedAgent merges one shared-agent row (visibility-filtered).
func appendSharedAgent(out *[]CapabilityItem, p serverstore.AgentPreset, versions map[string][]string) {
	versions[p.Name] = append(versions[p.Name], p.Version)
	*out = append(*out, CapabilityItem{
		Kind:        KindAgent,
		Source:      SourceOrg,
		Name:        p.Name,
		DisplayName: p.DisplayName,
		Version:     p.Version,
		Description: p.Description,
		Author:      p.Author,
		Status:      string(p.Status),
		Reason:      p.Reason,
		Quality:     p.Quality,
	})
}

// mergeVersions fills each item's Versions with the name's full approved set
// (ascending), collapsing per-name duplicates (one row per version).
func mergeVersions(items []CapabilityItem, versions map[string][]string) []CapabilityItem {
	// 重建 map:按 (kind,name) 归并。
	type key struct {
		kind CapabilityKind
		name string
	}
	sets := map[key]map[string]bool{}
	qualityBy := map[key]string{}
	for _, it := range items {
		k := key{it.Kind, it.Name}
		if sets[k] == nil {
			sets[k] = map[string]bool{}
		}
		sets[k][it.Version] = it.Status == "approved"
		if it.Quality != "" {
			qualityBy[k] = it.Quality
		}
	}
	approvedOnly := func(k key) []string {
		out := []string{}
		for v, ok := range sets[k] {
			if ok {
				out = append(out, v)
			}
		}
		// 升序(数值感知)。
		for i := 1; i < len(out); i++ {
			for j := i; j > 0 && util.CompareSemVer(out[j-1], out[j]) > 0; j-- {
				out[j-1], out[j] = out[j], out[j-1]
			}
		}
		return out
	}
	// 顶层归并:同名(kind+name)保留当前版本最高的 approved 行作为展示行。
	merged := map[key]CapabilityItem{}
	order := []key{}
	for _, it := range items {
		k := key{it.Kind, it.Name}
		cur, exists := merged[k]
		if it.Status != "approved" {
			// 作者自己可见的非 approved 行:仅当无 approved 展示行时保留。
			if !exists {
				it.Versions = approvedOnly(k)
				it.Quality = qualityBy[k]
				merged[k] = it
				order = append(order, k)
			}
			continue
		}
		if !exists || it.Status == "approved" && (cur.Status != "approved" || util.CompareSemVer(it.Version, cur.Version) > 0) {
			it.Versions = approvedOnly(k)
			it.Quality = qualityBy[k]
			merged[k] = it
			if !exists {
				order = append(order, k)
			}
		}
	}
	out := make([]CapabilityItem, 0, len(order))
	for _, k := range order {
		it := merged[k]
		if it.Status == "approved" && len(it.Versions) == 0 {
			it.Versions = []string{it.Version}
		}
		out = append(out, it)
	}
	return out
}

// listCapabilities 聚合市场(授权) + 组织(共享技能/共享 Agent)可见条目。
// 可见性语义各自保留:market = enabled+authorized;org = author-own(任意
// 状态) OR (approved+granted);admin 恒全量(不落授权表)。
//
// 决策 2026-08-25(市场/组织合并为「市场」):?source=market 返回合并结果——
// 市场与组织可见条目合并,同名(kind+name) market 优先展示(组织同名折叠到
// versions 与 source 徽章);?source=org 保留旧语义(仅组织,兼容旧客户端);
// 无 source 参数返回全量(向后兼容)。
func listCapabilities(db *sql.DB, cacheDir string) gin.HandlerFunc {
	return func(c *gin.Context) {
		u, groups, ok := viewer(c, db)
		if !ok {
			serverauth.WriteError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未认证")
			return
		}
		src := c.Query("source")
		includeMarket := src == "" || src == "market"
		includeOrg := src == "" || src == "market" || src == "org"
		ft := parseTypeFilter(c)
		items := []CapabilityItem{}
		versions := map[string][]string{}

		// 1) 市场技能(授权制)。
		if includeMarket && ft.skills {
			api := marketplace.NewAPI(db, cacheDir)
			skillList, err := api.AccessibleSkills(u, groups)
			if err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
				return
			}
			for _, s := range skillList {
				appendSkill(&items, s, versions)
			}
		}

		// 2) 组织·共享技能(审核+授权)。
		if includeOrg && ft.skills {
			if u.IsAdmin {
				all, err := serverstore.ListSharedSkills(db, "")
				if err != nil {
					serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
					return
				}
				for _, s := range all {
					if s.Status == serverstore.SharedSkillApproved {
						appendSharedSkill(&items, s, versions)
					}
				}
			} else {
				granted, err := serverstore.AccessibleSharedResourceNames(db, serverstore.SharedSkillGrantTable, u.Username, groups)
				if err != nil {
					serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
					return
				}
				visible, err := serverstore.ListVisibleSharedSkills(db, u.Username, granted)
				if err != nil {
					serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
					return
				}
				for _, s := range visible {
					// 组织分区只展示 approved(决策 2026-08-25):作者 own 的
					// pending/rejected 状态由「我的」分区展示,不在来源分区
					// 重复/混入。
					if s.Status != serverstore.SharedSkillApproved {
						continue
					}
					appendSharedSkill(&items, s, versions)
				}
			}
		}

		// 3) 组织·共享 Agent(审核+授权)。
		if includeOrg && ft.agents {
			if u.IsAdmin {
				all, err := serverstore.ListAgentPresets(db, "")
				if err != nil {
					serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
					return
				}
				for _, p := range all {
					if p.Status == serverstore.AgentPresetApproved {
						appendSharedAgent(&items, p, versions)
					}
				}
			} else {
				granted, err := serverstore.AccessibleSharedResourceNames(db, serverstore.SharedPresetGrantTable, u.Username, groups)
				if err != nil {
					serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
					return
				}
				visible, err := serverstore.ListVisibleAgentPresets(db, u.Username, granted)
				if err != nil {
					serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
					return
				}
				for _, p := range visible {
					// 组织分区只展示 approved(决策 2026-08-25),作者 own 状态
					// 由「我的」分区展示。
					if p.Status != serverstore.AgentPresetApproved {
						continue
					}
					appendSharedAgent(&items, p, versions)
				}
			}
		}

		merged := mergeVersions(items, versions)
		if src == "market" {
			merged = mergeMarketFirst(merged)
		}
		c.JSON(http.StatusOK, gin.H{"items": merged})
	}
}

// mergeMarketFirst 决策 2026-08-25(市场/组织合并):同名(kind+name)时市场行
// 优先——保留市场行的 Source/质量,组织行折叠进 versions(旧版本)与一个
// org 同名标记(客户端徽章区分)。仅当无市场行时保留组织行。
func mergeMarketFirst(items []CapabilityItem) []CapabilityItem {
	type key struct {
		kind CapabilityKind
		name string
	}
	order := []key{}
	byKey := map[key]CapabilityItem{}
	for _, it := range items {
		k := key{it.Kind, it.Name}
		cur, exists := byKey[k]
		if !exists {
			byKey[k] = it
			order = append(order, k)
			continue
		}
		// 同名折叠:市场行优先。fold 时以双行的版本+当前版本回填 versions,
		// 保证历史版本展开完整(单源 mergeVersions 只填了自己的版本集)。
		versions := appendUniqueAll(appendUnique(appendUnique(cur.Versions, cur.Version), it.Version), it.Versions)
		if cur.Source == SourceMarket {
			cur.Versions = versions
			byKey[k] = cur
		} else if it.Source == SourceMarket {
			merged := it
			merged.Versions = versions
			byKey[k] = merged
		} else {
			cur.Versions = versions
			byKey[k] = cur
		}
	}
	out := make([]CapabilityItem, 0, len(order))
	for _, k := range order {
		out = append(out, byKey[k])
	}
	return out
}

// appendUnique appends s to items unless already present (stable order).
func appendUnique(items []string, s string) []string {
	for _, v := range items {
		if v == s {
			return items
		}
	}
	return append(items, s)
}

// appendUniqueAll appends every element of extra that is not already present.
func appendUniqueAll(items []string, extra []string) []string {
	for _, e := range extra {
		items = appendUnique(items, e)
	}
	return items
}

// ---------------------------------------------------------------------------
// 管理端统一审批队列
// ---------------------------------------------------------------------------

// ApprovalRow is one pending/reviewable row in the unified admin queue.
type ApprovalRow struct {
	Kind        CapabilityKind `json:"kind"`
	Name        string         `json:"name"`
	Version     string         `json:"version"`
	DisplayName string         `json:"display_name"`
	Description string         `json:"description"`
	Author      string         `json:"author"`
	Status      string         `json:"status"`
	Reason      string         `json:"reason,omitempty"`
	Quality     string         `json:"quality,omitempty"`
	CreatedAt   string         `json:"created_at"`
	// 原始域端点(approve/reject/delete 仍走各自原路由,本队列只读)。
	BasePath string `json:"base_path"`
	// Preview 是域预览端点(composition / SKILL.md),管理端弹窗复用。
	PreviewPath string `json:"preview_path"`
	// Conflict 决策 2026-08-25:该共享技能名与市场 skills 表同名(跨源互斥),
	// approve 会被 409 阻断——管理端据此提示先处理市场技能。
	Conflict bool `json:"conflict"`
}

// listApprovals 归并 shared-skills 与 agent-presets 的列表(默认 pending,
// ?status= 过滤,type= 过滤 kind),返回统一行以便管理端单列表操作。
func listApprovals(db *sql.DB, cacheDir string) gin.HandlerFunc {
	return func(c *gin.Context) {
		status := c.Query("status")
		if status == "" {
			status = "pending"
		}
		ft := parseTypeFilter(c)
		out := []ApprovalRow{}

		if ft.skills {
			rows, err := serverstore.ListSharedSkills(db, status)
			if err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
				return
			}
			for _, s := range rows {
				// 决策 2026-08-25:跨源同名(市场技能表已有同名)标记冲突,
				// 管理端提示且 approve 将被 409 阻断。
				conflict := false
				if s.Name != "" {
					if has, err := serverstore.SkillNameExists(db, s.Name); err == nil {
						conflict = has
					}
				}
				out = append(out, ApprovalRow{
					Kind:        KindSkill,
					Name:        s.Name,
					Version:     s.Version,
					DisplayName: s.DisplayName,
					Description: s.Description,
					Author:      s.Author,
					Status:      string(s.Status),
					Reason:      s.Reason,
					Quality:     s.Quality,
					CreatedAt:   s.CreatedAt.Format("2006-01-02 15:04:05"),
					BasePath:    "/api/admin/shared-skills/" + pathEscape(s.Name) + "/" + pathEscape(s.Version),
					PreviewPath: "/api/admin/shared-skills/" + pathEscape(s.Name) + "/" + pathEscape(s.Version) + "/preview",
					Conflict:    conflict,
				})
			}
		}
		if ft.agents {
			rows, err := serverstore.ListAgentPresets(db, status)
			if err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
				return
			}
			for _, p := range rows {
				out = append(out, ApprovalRow{
					Kind:        KindAgent,
					Name:        p.Name,
					Version:     p.Version,
					DisplayName: p.DisplayName,
					Description: p.Description,
					Author:      p.Author,
					Status:      string(p.Status),
					Reason:      p.Reason,
					Quality:     p.Quality,
					CreatedAt:   p.CreatedAt.Format("2006-01-02 15:04:05"),
					BasePath:    "/api/admin/agent-presets/" + pathEscape(p.Name) + "/" + pathEscape(p.Version),
					PreviewPath: "/api/admin/agent-presets/" + pathEscape(p.Name) + "/" + pathEscape(p.Version) + "/preview",
				})
			}
		}
		c.JSON(http.StatusOK, gin.H{"approvals": out})
	}
}

// pathEscape percent-encodes one path segment (RFC 3986, keep unreserved).
func pathEscape(s string) string {
	const hex = "0123456789ABCDEF"
	var out []byte
	for i := 0; i < len(s); i++ {
		b := s[i]
		if (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9') || b == '-' || b == '.' || b == '_' || b == '~' {
			out = append(out, b)
		} else {
			out = append(out, '%', hex[b>>4], hex[b&0x0F])
		}
	}
	return string(out)
}
