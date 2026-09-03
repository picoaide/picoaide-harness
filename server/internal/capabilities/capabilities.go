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
	"sort"

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
	// Official 官方属性(0059, App 级): 客户端渲染蓝色「官方」标。
	Official bool `json:"official"`
	// Downloads/Calls 展示与评分数据源(App 级:市场取展示版本,组织取自身行)。
	Downloads int64 `json:"downloads"`
	Calls     int64 `json:"calls"`
	// Score 综合评分 = calls*3 + downloads(聚合面统一计算,客户端按此排序)。
	Score int64 `json:"score"`
	// IsOwner 当前用户是否为该 App 的归属人(2026-09-02 归属权补强)。
	// 客户端上传前据此预检:同名且非本人 → 提前提示「名称已被占用」,
	// 不必等一次网络往返(服务端 409 NAME_TAKEN 兜底,语义一致)。
	IsOwner bool `json:"is_owner"`
	// Versions 是该名全部 approved 版本(升序,数值感知)。归并后当前
	// Version = 最高 approved 版本;versions[last] 恒等于 Version。
	Versions []string `json:"versions"`
}

// RegisterRoutes mounts /api/capabilities (employee Bearer endpoints).
// 仅测试自建路由树使用;生产路由由 internal/router 集中声明,
// 实际路径为 /api/client/v2/capabilities。
func RegisterRoutes(r *gin.Engine, db *sql.DB, cacheDir string) {
	base := "/api/client/v2/capabilities"
	g := r.Group(base, serverauth.BearerAuth(db))
	g.GET("", listCapabilities(db, cacheDir))
}

// RegisterAdminRoutes mounts /api/admin/capabilities (AdminAuth + RBAC v3b):
// the unified approval queue over shared-skills + agent-presets.
// 仅测试自建路由树使用;生产路由由 internal/router 集中声明,
// 实际路径为 /api/server/admin/capabilities/approvals。
func RegisterAdminRoutes(r *gin.Engine, db *sql.DB, cacheDir string) {
	base := "/api/server/admin/capabilities"
	g := r.Group(base, serverauth.AdminAuth(db))
	serverauth.AdminRoute(g, "GET", "/approvals", serverauth.PermCapabilityRead, listApprovals(db, cacheDir))
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
// isOwner 由调用方按 apps.owner 计算(市场适配层 Skill.Author == apps.owner)。
func appendSkill(out *[]CapabilityItem, s serverstore.Skill, versions map[string][]string, isOwner bool, official bool) {
	versions[s.Name] = append(versions[s.Name], s.Version)
	// 展示名(0051):优先包内 title 写入的 display_name,为空回退 name
	// ——此前这里硬编码 s.Name,是「市场卡片显示目录名」的直接原因。
	display := s.DisplayName
	if display == "" {
		display = s.Name
	}
	*out = append(*out, CapabilityItem{
		Kind:        KindSkill,
		Source:      SourceMarket,
		Name:        s.Name,
		DisplayName: display,
		Version:     s.Version,
		Description: s.Description,
		Author:      s.Author,
		Status:      "approved",
		Official:    official,
		Downloads:   s.Downloads,
		Calls:       s.Calls,
		IsOwner:     isOwner,
	})
}

// appendMarketAgent merges one marketplace agent into the catalog
// (enabled+authorized only; G4 2026-09-04 市场智能体)。
func appendMarketAgent(out *[]CapabilityItem, a serverstore.App, versions map[string][]string, releases map[string]serverstore.Release, isOwner bool) {
	r, ok := releases[a.AppID]
	if !ok {
		return
	}
	versions[a.AppID] = append(versions[a.AppID], r.Version)
	display := a.Title
	if display == "" {
		display = a.AppID
	}
	*out = append(*out, CapabilityItem{
		Kind:        KindAgent,
		Source:      SourceMarket,
		Name:        a.AppID,
		DisplayName: display,
		Version:     r.Version,
		Description: a.Description,
		Author:      a.Owner,
		Status:      "approved",
		Official:    a.Official == 1,
		Downloads:   r.Downloads,
		Calls:       r.Calls,
		IsOwner:     isOwner,
	})
}

// appendSharedSkill merges one shared-skill row (already visibility-filtered
// by the caller) with its quality tag and status.
func appendSharedSkill(out *[]CapabilityItem, s serverstore.SharedSkill, versions map[string][]string, isOwner bool, official bool) {
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
		IsOwner:     isOwner,
	}
	*out = append(*out, item)
}

// appendSharedAgent merges one shared-agent row (visibility-filtered).
func appendSharedAgent(out *[]CapabilityItem, p serverstore.AgentPreset, versions map[string][]string, isOwner bool, official bool) {
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
		Official:    official,
		Downloads:   p.Downloads,
		IsOwner:     isOwner,
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

// appOwnerMap 一次性取某 (kind, channel) 全部 App 的归属映射(列表量级小,
// 一次查询避免逐行 GetApp;2026-09-02 归属权:is_owner 供客户端预检)。
func appOwnerMap(db *sql.DB, kind, channel string) map[string]string {
	apps, err := serverstore.ListApps(db, kind, channel)
	if err != nil {
		return map[string]string{}
	}
	m := make(map[string]string, len(apps))
	for _, a := range apps {
		m[a.AppID] = a.Owner
	}
	return m
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
		// own:作者本人上传的任意状态行(「我的」分区专用)。客户端
		// /api/pico/capabilities?source=local 经宿主转换为 source=own,
		// 用于渲染本地上传行的 status/reason 徽章(2026-09-01 契约修复:
		// 此前 org 仅 approved 且 a6eed6397d 过滤掉 own 非 approved 行,
		// 徽章与拒因恒空)。
		includeOwn := src == "own" || src == "local"
		ft := parseTypeFilter(c)
		items := []CapabilityItem{}
		versions := map[string][]string{}
		// 归属映射(2026-09-02):一个 App 的 owner 恒定,一次查询覆盖全部行。
		skillOwners := appOwnerMap(db, serverstore.AppKindSkill, serverstore.AppChannelOrg)
		agentOwners := appOwnerMap(db, serverstore.AppKindAgent, serverstore.AppChannelOrg)
		// 官方属性(0059, App 级,与来源无关:market/org 行取同一 App)。
		skillOfficials, _ := serverstore.AppOfficialMap(db, serverstore.AppKindSkill)
		agentOfficials, _ := serverstore.AppOfficialMap(db, serverstore.AppKindAgent)

		// 1) 市场技能(授权制)。
		if includeMarket && ft.skills {
			api := marketplace.NewAPI(db, cacheDir)
			skillList, err := api.AccessibleSkills(u, groups)
			if err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
				return
			}
			for _, s := range skillList {
				// 市场适配层 Skill.Author == apps.owner(2026-09-02 归属权)。
				appendSkill(&items, s, versions, s.Author == u.Username, skillOfficials[s.Name])
			}
		}

		// 1b) 市场智能体(授权制,G4)。
		if includeMarket && ft.agents {
			agentApps, err := serverstore.ListApps(db, serverstore.AppKindAgent, serverstore.AppChannelMarket)
			if err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
				return
			}
			allowed := map[string]bool{}
			if !u.IsAdmin {
				names, err := serverstore.AccessibleAppIDs(db, serverstore.AppKindAgent, u.Username, groups)
				if err != nil {
					serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
					return
				}
				for _, n := range names {
					allowed[n] = true
				}
			}
			releases := map[string]serverstore.Release{}
			for _, a := range agentApps {
				if a.Enabled != 1 {
					continue
				}
				if !u.IsAdmin && !allowed[a.AppID] {
					continue
				}
				r, err := serverstore.CurrentMarketReleaseFor(db, serverstore.AppKindAgent, a.AppID, false)
				if err != nil || r == nil {
					continue
				}
				releases[a.AppID] = *r
				appendMarketAgent(&items, a, versions, releases, a.Owner == u.Username)
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
						appendSharedSkill(&items, s, versions, skillOwners[s.Name] == u.Username, skillOfficials[s.Name])
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
					appendSharedSkill(&items, s, versions, skillOwners[s.Name] == u.Username, skillOfficials[s.Name])
				}
			}
		}

		// 2b) 「我的」分区:作者 own 的任意状态(含 pending/rejected + 拒因)。
		// 只取 own 行,不混入他人已授权的 approved 行。管理员 own 恒空
		// (管理员不通过共享库上传),仍走同一查询语义保持简单。
		if includeOwn && ft.skills && !u.IsAdmin {
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
				if s.Author != u.Username {
					continue
				}
				appendSharedSkill(&items, s, versions, true, skillOfficials[s.Name])
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
						appendSharedAgent(&items, p, versions, agentOwners[p.Name] == u.Username, agentOfficials[p.Name])
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
					appendSharedAgent(&items, p, versions, agentOwners[p.Name] == u.Username, agentOfficials[p.Name])
				}
			}
		}

		// 3b) 「我的」分区:作者 own 的智能体预设(任意状态)。
		if includeOwn && ft.agents && !u.IsAdmin {
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
				if p.Author != u.Username {
					continue
				}
				appendSharedAgent(&items, p, versions, true, agentOfficials[p.Name])
			}
		}

		merged := mergeVersions(items, versions)
		if src == "market" {
			merged = mergeMarketFirst(merged)
		}
		// 评分与市场排序(0059 定案):官方→精选→score 降序→名称;"我的"
		// (own/local)不参与(自制内容无官方/评分语义)。
		if src != "own" && src != "local" {
			scoreItems(merged)
			merged = sortCatalog(merged)
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
		// B5(2026-09-01):append 顺序不保证升序,合并后按数值感知 semver
		// 升序重排,否则客户端「历史版本」展开乱序(如 [1.0.0,2.0.0]+1.5.0)。
		versions = sortVersions(versions)
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

// sortVersions 按数值感知 semver 升序排序(非原地,B5:mergeMarketFirst 折叠
// 合并后的 versions 需保持升序,与 mergeVersions.approvedOnly 同规则)。
func sortVersions(vs []string) []string {
	out := make([]string, len(vs))
	copy(out, vs)
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && util.CompareSemVer(out[j-1], out[j]) > 0; j-- {
			out[j-1], out[j] = out[j], out[j-1]
		}
	}
	return out
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
	// Owner 是该 (kind, name) 的归属人(apps.owner,2026-09-02 归属权):
	// 与 Author(本行上传者)可不同——管理员代发/归属转移后即分叉。
	Owner     string `json:"owner"`
	Status    string `json:"status"`
	Reason    string `json:"reason,omitempty"`
	Quality   string `json:"quality,omitempty"`
	CreatedAt string `json:"created_at"`
	// Downloads 归档下载次数;Calls 技能调用计数(telemetry,仅共享技能有)。
	Downloads int64 `json:"downloads"`
	Calls     int64 `json:"calls,omitempty"`
	// 原始域端点(approve/reject/delete 仍走各自原路由,本队列只读)。
	BasePath string `json:"base_path"`
	// 授权端点基路径——与 BasePath 不同:授权是资源级(name-only,同名多版本
	// 共享授权),而 BasePath 含版本段(approve/reject/delete/preview 需要)。
	// 管理端授权弹窗用本字段拼 /grant、/grants;若误用 BasePath 会多出版本
	// 段 → 404(2026-09-01 实际线上故障)。
	GrantsBase string `json:"grants_base"`
	// Preview 是域预览端点(composition / SKILL.md),管理端弹窗复用。
	PreviewPath string `json:"preview_path"`
	// Conflict 历史字段(决策 2026-08-25):曾用于标记「组织技能名与市场同名」。
	// P2(迁移 0053)后一个 (kind, app_id) 只能属于一个渠道,这种冲突**结构上
	// 不可能**再产生,因此恒为 false;字段保留仅为不破坏 webadmin 的旧响应契约。
	// 原注释:该共享技能名与市场 skills 表同名(跨源互斥),
	// approve 会被 409 阻断——管理端据此提示先处理市场技能。
	Conflict bool `json:"conflict"`
	// Official 官方属性(0059, App 级,与来源无关): 管理端渲染蓝标与归属语义。
	Official bool `json:"official"`
}

// listApprovals 归并 shared-skills 与 agent-presets 的列表(默认 pending,
// ?status=all|pending|approved|rejected 过滤,type= 过滤 kind),返回统一行
// 以便管理端单列表操作。BasePath/PreviewPath 指向 /api/server/admin 命名
// 空间下的原域端点(2026-09 工程化重构后前缀,勿回退旧 /api/admin)。
func listApprovals(db *sql.DB, cacheDir string) gin.HandlerFunc {
	return func(c *gin.Context) {
		status := c.Query("status")
		if status == "" {
			status = "pending"
		}
		ft := parseTypeFilter(c)
		out := []ApprovalRow{}

		if ft.skills {
			rows, err := serverstore.ListSharedSkills(db, mungeStatus(status))
			if err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
				return
			}
			// 归属映射(2026-09-02):owner 是 App 级,与版本无关,一次查询覆盖。
			skillOwners := appOwnerMap(db, serverstore.AppKindSkill, "")
			skillOfficials, _ := serverstore.AppOfficialMap(db, serverstore.AppKindSkill)
			for _, s := range rows {
				// 决策 2026-08-25:跨源同名(市场技能表已有同名)标记冲突,
				// 管理端提示且 approve 将被 409 阻断。
				// P2 后跨渠道同名不可能并存,恒 false(见 ApprovalRow.Conflict 说明)。
				conflict := false
				out = append(out, ApprovalRow{
					Kind:        KindSkill,
					Name:        s.Name,
					Version:     s.Version,
					DisplayName: s.DisplayName,
					Description: s.Description,
					Author:      s.Author,
					Owner:       skillOwners[s.Name],
					Status:      string(s.Status),
					Reason:      s.Reason,
					Quality:     s.Quality,
					CreatedAt:   s.CreatedAt.Format("2006-01-02 15:04:05"),
					Downloads:   s.Downloads,
					Calls:       s.Calls,
					Official:    skillOfficials[s.Name],
					BasePath:    "/api/server/admin/shared-skills/" + pathEscape(s.Name) + "/" + pathEscape(s.Version),
					GrantsBase:  "/api/server/admin/shared-skills/" + pathEscape(s.Name),
					PreviewPath: "/api/server/admin/shared-skills/" + pathEscape(s.Name) + "/" + pathEscape(s.Version) + "/preview",
					Conflict:    conflict,
				})
			}
		}
		if ft.agents {
			rows, err := serverstore.ListAgentPresets(db, mungeStatus(status))
			if err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
				return
			}
			agentOwners := appOwnerMap(db, serverstore.AppKindAgent, "")
			agentOfficials, _ := serverstore.AppOfficialMap(db, serverstore.AppKindAgent)
			for _, p := range rows {
				out = append(out, ApprovalRow{
					Kind:        KindAgent,
					Name:        p.Name,
					Version:     p.Version,
					DisplayName: p.DisplayName,
					Description: p.Description,
					Author:      p.Author,
					Owner:       agentOwners[p.Name],
					Status:      string(p.Status),
					Reason:      p.Reason,
					Quality:     p.Quality,
					CreatedAt:   p.CreatedAt.Format("2006-01-02 15:04:05"),
					Downloads:   p.Downloads,
					Official:    agentOfficials[p.Name],
					BasePath:    "/api/server/admin/agent-presets/" + pathEscape(p.Name) + "/" + pathEscape(p.Version),
					GrantsBase:  "/api/server/admin/agent-presets/" + pathEscape(p.Name),
					PreviewPath: "/api/server/admin/agent-presets/" + pathEscape(p.Name) + "/" + pathEscape(p.Version) + "/preview",
				})
			}
		}
		c.JSON(http.StatusOK, gin.H{"approvals": out})
	}
}

// mungeStatus maps the queue's ?status= 语法到 serverstore 的过滤语义:
// 缺省/空 = pending;all = 全部(传 "" 关闭过滤);其余原样(权威状态值)。
func mungeStatus(status string) string {
	if status == "" || status == "all" {
		return ""
	}
	return status
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

// scoreItems 统一计算综合评分(score = calls*3 + downloads),在排序前调用。
func scoreItems(items []CapabilityItem) {
	for i := range items {
		items[i].Score = items[i].Calls*3 + items[i].Downloads
	}
}

// sortCatalog 市场排序(0059 定案):官方置顶 → 精选(quality=featured) →
// score 降序 → 名称升序兜底(稳定)。「我的」分区不调用。
func sortCatalog(items []CapabilityItem) []CapabilityItem {
	if len(items) == 0 {
		return []CapabilityItem{}
	}
	sorted := append([]CapabilityItem(nil), items...)
	sort.SliceStable(sorted, func(i, j int) bool {
		a, b := sorted[i], sorted[j]
		if a.Official != b.Official {
			return a.Official
		}
		af, bf := a.Quality == "featured", b.Quality == "featured"
		if af != bf {
			return af
		}
		if a.Score != b.Score {
			return a.Score > b.Score
		}
		return a.Name < b.Name
	})
	return sorted
}
