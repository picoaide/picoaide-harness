package marketplace

import (
	"database/sql"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/agentshare"
	"github.com/picoaide/picoaide/internal/appstore"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/skillmanifest"
	"github.com/picoaide/picoaide/internal/util"
)

// ---------------------------------------------------------------------------
// 市场智能体管理(G4,2026-09-04):与市场技能同构的「上架/编辑/上传新版/预览/
// 授权/归属/上下架」管理面,数据落在统一的 apps/app_releases(kind=agent,
// channel=market)。发布也走 appstore.Publish 统一内核(版本语义/锁定/跨渠道
// 同名互斥/包内即真相),归档校验/代理清单复用 agentshare + skillmanifest。
// 技能专用(参考其实现)的 normalize/磁盘缓存不适用于智能体。
// ---------------------------------------------------------------------------

// agentJSON 投影一个市场智能体(展示版本)。
func agentJSON(a serverstore.App, r *serverstore.Release) gin.H {
	out := gin.H{
		"name": a.AppID, "title": a.Title, "description": a.Description,
		"author": a.Owner, "enabled": a.Enabled == 1,
		"official":   a.Official == 1,
		"created_at": a.CreatedAt, "updated_at": a.UpdatedAt,
	}
	if r != nil {
		out["version"] = r.Version
		out["quality"] = r.Quality
		out["downloads"] = r.Downloads
		out["changelog"] = r.Changelog
	}
	return out
}

// listAgentsAdmin 市场智能体清单(含已下架,与技能列表一致)。
func listAgentsAdmin(c *gin.Context, db *sql.DB) {
	apps, err := serverstore.ListApps(db, serverstore.AppKindAgent, serverstore.AppChannelMarket)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	out := make([]gin.H, 0, len(apps))
	for _, a := range apps {
		r, _ := serverstore.CurrentMarketReleaseFor(db, serverstore.AppKindAgent, a.AppID, false)
		out = append(out, agentJSON(a, r))
	}
	c.JSON(http.StatusOK, gin.H{"agents": out})
}

type agentReq struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Author      string `json:"author"`
}

// createAgentAdmin 登记市场智能体(与内容两步走;内容一律由 archive 上传)。
func createAgentAdmin(c *gin.Context, db *sql.DB) {
	var req agentReq
	if err := c.ShouldBindJSON(&req); err != nil || req.Name == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "名称必填")
		return
	}
	if !util.SafePathSegment(req.Name) {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "智能体名不合法")
		return
	}
	// 与市场技能同语义:组织共享库已存在同名(任意状态)时跨源互斥。
	if existing, err := serverstore.GetApp(db, serverstore.AppKindAgent, req.Name); err == nil {
		if existing.Channel == serverstore.AppChannelOrg {
			serverauth.WriteError(c, http.StatusConflict, "CONFLICT", "名称与组织共享库智能体冲突,请先在共享库处理同名智能体")
			return
		}
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "智能体已存在")
		return
	} else if !errors.Is(err, serverstore.ErrNotFound) {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	owner := req.Author
	if owner == "" {
		owner = adminUsername(c)
	}
	if err := serverstore.UpsertApp(db, &serverstore.App{
		Kind: serverstore.AppKindAgent, AppID: req.Name, Title: req.Name,
		Description: req.Description, Owner: owner, Channel: serverstore.AppChannelMarket, Enabled: 1,
	}); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "创建失败")
		return
	}
	_ = serverstore.AuditLog(db, adminUsername(c), "agent_create", req.Name)
	c.JSON(http.StatusOK, gin.H{"agent": gin.H{"name": req.Name, "author": owner}})
}

// uploadAgentArchiveAdmin 上传/发布智能体版本:安全校验 → preset.yml 清单 →
// appstore.Publish(管理端发布即 approved)。
func uploadAgentArchiveAdmin(c *gin.Context, db *sql.DB) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, agentshare.MaxBodyBytes)
	name := c.Param("name")
	if !util.SafePathSegment(name) {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "智能体名不合法")
		return
	}
	if _, err := serverstore.GetApp(db, serverstore.AppKindAgent, name); err != nil {
		if errors.Is(err, serverstore.ErrNotFound) {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "智能体不存在")
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	var req struct {
		Version string `json:"version"`
		Archive string `json:"archive"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Archive == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "archive 必填")
		return
	}
	raw, err := base64.StdEncoding.DecodeString(req.Archive)
	if err != nil || len(raw) == 0 {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "归档编码错误或为空")
		return
	}
	checksum, err := agentshare.ValidatePresetArchive(raw)
	if err != nil {
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "归档校验失败: "+err.Error())
		return
	}
	entries, _, listErr := agentshare.ListArchiveContents(raw)
	if listErr != nil {
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "归档校验失败: "+listErr.Error())
		return
	}
	presetYML, err := archEntryText(raw, skillmanifest.PresetMetaFile)
	if err != nil {
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "归档校验失败: "+err.Error())
		return
	}
	man, manErr := skillmanifest.ParseAgent(entries, presetYML, name)
	if manErr != nil {
		var me *skillmanifest.Error
		if errors.As(manErr, &me) {
			serverauth.WriteError(c, skillmanifest.StatusFor(me.Code), me.Code, me.Message)
			return
		}
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "preset.yml 校验失败")
		return
	}
	res, perr := appstore.Publish(db, appstore.PublishRequest{
		Kind:            serverstore.AppKindAgent,
		AppID:           name,
		Channel:         serverstore.AppChannelMarket,
		Archive:         raw,
		Publisher:       adminUsername(c),
		AdminPublish:    true,
		DeclaredVersion: req.Version,
		Manifest:        appstore.FromSkillManifest(man),
		Checksum:        checksum,
	})
	if perr != nil {
		var ae *appstore.Error
		if errors.As(perr, &ae) {
			serverauth.WriteError(c, ae.Status, ae.Code, ae.Message)
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "发布失败")
		return
	}
	// 包内展示名回写 App(技能同语义)。
	_ = serverstore.UpsertApp(db, &serverstore.App{
		Kind: serverstore.AppKindAgent, AppID: name, Title: man.Title,
		Owner: man.Author, Channel: serverstore.AppChannelMarket,
	})
	_ = serverstore.AuditLog(db, adminUsername(c), "agent_update",
		fmtAgentUploadAudit(name, res.Version, man.Title, checksum))
	c.JSON(http.StatusOK, gin.H{"ok": true, "version": res.Version, "checksum": checksum})
}

func fmtAgentUploadAudit(name, version, title, checksum string) string {
	return name + " v" + version + " title=" + title + " sha256=" + checksum
}

// updateAgentAdmin 更新元数据(不触碰版本与归档)。
func updateAgentAdmin(c *gin.Context, db *sql.DB) {
	name := c.Param("name")
	if !util.SafePathSegment(name) {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "智能体名不合法")
		return
	}
	var req agentReq
	if err := c.ShouldBindJSON(&req); err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体错误")
		return
	}
	a, err := serverstore.GetApp(db, serverstore.AppKindAgent, name)
	if err != nil {
		if errors.Is(err, serverstore.ErrNotFound) {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "智能体不存在")
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	if a.Channel != serverstore.AppChannelMarket {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "智能体不存在")
		return
	}
	title := req.Name
	if title == "" {
		title = a.Title
	}
	desc := req.Description
	if desc == "" {
		desc = a.Description
	}
	// 归属(owner)一经写入不可覆盖(UpsertApp 语义);改归属走 apps/:kind/:app_id/owner。
	if err := serverstore.UpsertApp(db, &serverstore.App{
		Kind: serverstore.AppKindAgent, AppID: name, Title: title,
		Description: desc, Owner: a.Owner, Channel: serverstore.AppChannelMarket, Enabled: a.Enabled,
	}); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
		return
	}
	_ = serverstore.AuditLog(db, adminUsername(c), "agent_update_meta", name)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// deleteAgentAdmin 下架(保留数据,可重新上架)。
func deleteAgentAdmin(c *gin.Context, db *sql.DB) {
	name := c.Param("name")
	if a, err := serverstore.GetApp(db, serverstore.AppKindAgent, name); err == nil && a.Channel == serverstore.AppChannelMarket {
		_ = serverstore.SetAppEnabled(db, serverstore.AppKindAgent, name, false)
		_ = serverstore.AuditLog(db, adminUsername(c), "agent_disable", name)
		c.JSON(http.StatusOK, gin.H{"ok": true})
		return
	}
	serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "智能体不存在")
}

// enableAgentAdmin 重新上架。
func enableAgentAdmin(c *gin.Context, db *sql.DB) {
	name := c.Param("name")
	if a, err := serverstore.GetApp(db, serverstore.AppKindAgent, name); err == nil && a.Channel == serverstore.AppChannelMarket {
		_ = serverstore.SetAppEnabled(db, serverstore.AppKindAgent, name, true)
		_ = serverstore.AuditLog(db, adminUsername(c), "agent_enable", name)
		c.JSON(http.StatusOK, gin.H{"ok": true})
		return
	}
	serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "智能体不存在")
}

// previewAgentAdmin 返回展示版本归档的文件清单与主文件内容。
func previewAgentAdmin(c *gin.Context, db *sql.DB) {
	name := c.Param("name")
	r, err := serverstore.CurrentMarketReleaseFor(db, serverstore.AppKindAgent, name, true)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	if r == nil {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "智能体尚未发布版本")
		return
	}
	files, composition, listErr := agentshare.ListArchiveContents(r.Archive)
	if listErr != nil {
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "归档解析失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"files": files, "composition": composition, "version": r.Version})
}

// archEntryText 提取归档内某顶层文件文本(预览/校验用)。
func archEntryText(data []byte, target string) (string, error) {
	content, _, found, _, tooLarge, err := agentshare.ExtractFileContent(data, target)
	if err != nil {
		return "", err
	}
	if !found {
		return "", errors.New("归档缺少顶层 " + target)
	}
	if tooLarge {
		return "", errors.New(target + " 过大")
	}
	return content, nil
}

// fileContentAgentAdmin 按路径返回归档内文件内容(与技能预览同语义)。
func fileContentAgentAdmin(c *gin.Context, db *sql.DB) {
	name := c.Param("name")
	filePath := c.Query("path")
	r, err := serverstore.CurrentMarketReleaseFor(db, serverstore.AppKindAgent, name, true)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	if r == nil {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "智能体尚未发布版本")
		return
	}
	content, size, found, binary, tooLarge, err := agentshare.ExtractFileContent(r.Archive, filePath)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "读取失败")
		return
	}
	if !found {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "文件不存在")
		return
	}
	if binary {
		c.JSON(http.StatusOK, gin.H{"size": size, "binary": true})
		return
	}
	if tooLarge {
		c.JSON(http.StatusOK, gin.H{"size": size, "tooLarge": true})
		return
	}
	c.JSON(http.StatusOK, gin.H{"content": content, "size": size})
}

// ---- 授权(与市场技能同语义:app_grants kind=agent) ----

func listAgentGrants(c *gin.Context, db *sql.DB) {
	name := c.Param("name")
	if _, err := serverstore.GetApp(db, serverstore.AppKindAgent, name); err != nil {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "智能体不存在")
		return
	}
	grants, err := serverstore.ListAppGrants(db, serverstore.AppKindAgent, name)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"grants": grantsJSON(grants)})
}

func applyAgentGrant(c *gin.Context, db *sql.DB, grant bool) {
	name := c.Param("name")
	var req grantReq
	if err := c.ShouldBindJSON(&req); err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体错误")
		return
	}
	subject, t, ok := parseGrantSubject(req)
	if !ok {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "username 与 group 必须指定其一")
		return
	}
	if _, err := serverstore.GetApp(db, serverstore.AppKindAgent, name); err != nil {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "智能体不存在")
		return
	}
	var err error
	if grant {
		err = serverstore.GrantApp(db, serverstore.AppKindAgent, name, subject, string(t))
	} else {
		err = serverstore.RevokeApp(db, serverstore.AppKindAgent, name, subject, string(t))
	}
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "操作失败")
		return
	}
	_ = serverstore.AuditLog(db, adminUsername(c), "agent_grant", name+" grant="+subject)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// replaceAgentGrants 整组替换授权(与技能 replaceSkillGrants 同语义)。
func replaceAgentGrants(c *gin.Context, db *sql.DB) {
	name := c.Param("name")
	if _, err := serverstore.GetApp(db, serverstore.AppKindAgent, name); err != nil {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "智能体不存在")
		return
	}
	var req struct {
		Groups    []string `json:"groups"`
		Usernames []string `json:"usernames"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体错误")
		return
	}
	revoke := func(subject string, t serverstore.GranteeType) error {
		return serverstore.RevokeApp(db, serverstore.AppKindAgent, name, subject, string(t))
	}
	// 保留当前全部授权以做差量:直接清空重放(与技能实现一致的安全边界:
	// 整组替换 = 以提交清单为准,未列入者全部撤销)。
	list, err := serverstore.ListAppGrants(db, serverstore.AppKindAgent, name)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	for _, g := range list {
		if err := revoke(g.Grantee, g.GranteeType); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "操作失败")
			return
		}
	}
	for _, g := range req.Groups {
		if g == "" {
			continue
		}
		if err := serverstore.GrantApp(db, serverstore.AppKindAgent, name, strings.TrimPrefix(g, "@"), string(serverstore.GranteeGroup)); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "操作失败")
			return
		}
	}
	for _, u := range req.Usernames {
		if u == "" {
			continue
		}
		if err := serverstore.GrantApp(db, serverstore.AppKindAgent, name, u, string(serverstore.GranteeUser)); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "操作失败")
			return
		}
	}
	_ = serverstore.AuditLog(db, adminUsername(c), "agent_grants", name+" replace")
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
