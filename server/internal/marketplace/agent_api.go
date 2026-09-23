package marketplace

import (
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/agentshare"
	"github.com/picoaide/picoaide/internal/appstore"
	"github.com/picoaide/picoaide/internal/archiveutil"
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
	// marketplace-9:登记与上传必须同一套名字口径。上传走 appstore.Publish
	// 的 skillmanifest.IsAppID;此处若只做 SafePathSegment,就会登记出
	// `My_Agent`/中文名这类**永远无法上传内容**的空壳 App(releases=0,
	// enabled=1,且没有硬删除入口)。
	if !skillmanifest.IsAppID(req.Name) {
		serverauth.WriteError(c, http.StatusBadRequest, skillmanifest.CodeInvalidAppID,
			"名称不合法:必须是小写 kebab-case(如 my-agent)")
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
	entries, composition, listErr := agentshare.ListArchiveContents(raw)
	if listErr != nil {
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "归档校验失败: "+listErr.Error())
		return
	}
	// archupd-1②:编排必须可读(非空且在上限内)且可解析才能发布 —— 与员工
	// 上传路径同一闸门,否则审核面同样只能看到空编排。
	if cerr := agentshare.ValidateAgentComposition(composition); cerr != nil {
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", cerr.Error())
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
	// 包内展示名回写 App(技能同语义)。只写展示名:
	//   - marketplace-3(R7):不能用留空的 UpsertApp 覆写 Description —— 管理员
	//     登记时填的描述必须保留(技能侧同样保留);
	//   - P2-6(审计 2026-09-13):owner 只认登录态占名(appstore.Publish 按发布
	//     账号写),包内 author 是**不可信输入** —— 用它回写会把官方 App 刻意
	//     保留的空归属(蓝标语义)改写成个人,非官方 App 的描述也会被清空。
	// 因此走只更新标题的 SetAppTitle,不碰 Description/Owner/Channel。
	_ = serverstore.SetAppTitle(db, serverstore.AppKindAgent, name, man.Title)
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
	a, err := marketAgentApp(db, name)
	if err != nil {
		if errors.Is(err, serverstore.ErrNotFound) {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "智能体不存在")
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
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
	if _, err := marketAgentApp(db, name); err == nil {
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
	if _, err := marketAgentApp(db, name); err == nil {
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
	// A-8:渠道守卫在任何实际工作之前(与 agentshare.requireOrgAgent 的授权面同形)
	// —— org 行在这个命名空间下按不存在处理,不得被预览。
	if !requireMarketAgent(c, db, name) {
		return
	}
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

// downloadAgentArchiveAdmin 管理面下载市场智能体的归档（2026-09-23，与技能侧
// downloadSkillArchiveAdmin 同形、同权限、同响应契约）。
//
// 落点同上：webadmin 归档预览弹层「文件过大 → 下载归档」= 预览基路径 + `/archive`，
// 市场智能体的基路径是 `/api/server/admin/agents/:name`，此前只声明了 POST（上传新版）
// ⇒ 市场行 404。组织侧对应端点是 `/agent-presets/:name/:version/archive`。
//
// 取"当前展示版本"（最高 approved 且未软删）——与同命名空间的 preview/file 两面
// 同一条解析（CurrentMarketReleaseFor），因此三面看到的永远是同一份内容。
func downloadAgentArchiveAdmin(c *gin.Context, db *sql.DB) {
	name := c.Param("name")
	// 市场命名空间的渠道守卫：市场行 = apps.channel='market'（与 listAgentsAdmin 的
	// 过滤同一判据）。技能侧的守卫来自 serverstore.GetSkill 自身；智能体侧 A-8
	// （2026-09-23）起九个逐名端点统一走 requireMarketAgent / marketAgentApp，
	// 不再各自内联判据 —— 否则组织的智能体会从市场命名空间的 URL 下走归档，
	// 正是「按行 channel 选命名空间」要杜绝的越渠道形态。
	if _, err := marketAgentApp(db, name); err != nil {
		if errors.Is(err, serverstore.ErrNotFound) {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "智能体不存在")
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	r, err := serverstore.CurrentMarketReleaseFor(db, serverstore.AppKindAgent, name, true)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	if r == nil || len(r.Archive) == 0 {
		// 尚未发布版本 / 归档缺失：与预览面同措辞的 JSON 404（不是空 body、不是 405）。
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "智能体尚未发布版本")
		return
	}
	// 按归档实际格式回响应（zip 推荐 / tar.gz 兼容），头名与组织侧
	// agentshare.serveArchive 一致（X-Preset-*），客户端安装器靠它做对照。
	dispName := name + "-" + r.Version + ".tar.gz"
	contentType := "application/gzip"
	if archiveutil.Format(r.Archive) == "zip" {
		dispName = name + "-" + r.Version + ".zip"
		contentType = "application/zip"
	}
	c.Header("Content-Type", contentType)
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", dispName))
	c.Header("X-Preset-Version", r.Version)
	c.Header("X-Preset-Checksum", r.Checksum)
	_, _ = serverstore.IncrementAgentPresetDownload(db, name, r.Version)
	c.Data(http.StatusOK, contentType, r.Archive)
}

// fileContentAgentAdmin 按路径返回归档内文件内容(与技能预览同语义)。
func fileContentAgentAdmin(c *gin.Context, db *sql.DB) {
	name := c.Param("name")
	// A-8:渠道守卫在任何实际工作之前 —— org 行不得被逐文件读出。
	if !requireMarketAgent(c, db, name) {
		return
	}
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
		// 键名是**跨端契约**：webadmin 的 FileContentData.too_large 读它，组织侧的
		// `/agent-presets/:name/:version/file`（agentshare）与技能侧
		// （fileContentSkillAdmin）产出的也是 `too_large`。这里曾写成驼峰 `tooLarge`
		// ⇒ 市场智能体的超大文件**永不显示**「文件过大 → 下载归档」入口（三段里只有
		// 这一段静默失效，两端各自"自证"都测不出来）。别改回驼峰。
		c.JSON(http.StatusOK, gin.H{"size": size, "too_large": true})
		return
	}
	c.JSON(http.StatusOK, gin.H{"content": content, "size": size})
}

// ---- 授权(与市场技能同语义:app_grants kind=agent) ----

func listAgentGrants(c *gin.Context, db *sql.DB) {
	name := c.Param("name")
	// A-8:授权**读**也只服务市场行(市场与组织库同名同 kind 共用一张 app_grants,
	// 不过滤渠道就会读出组织行的 ACL)。与 agentshare.listPresetGrants 的
	// requireOrgAgent 同形、方向相反。
	if !requireMarketAgent(c, db, name) {
		return
	}
	grants, err := serverstore.ListAppGrants(db, serverstore.AppKindAgent, name)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	// marketplace-2:与技能侧同形状(单层 {"grants":[...]})。多包一层会让
	// webadmin 授权弹窗 data.grants.filter 抛异常,并在保存时发出
	// {"groups":[]} 把全部授权清空。
	c.JSON(http.StatusOK, grantsJSON(grants))
}

func applyAgentGrant(c *gin.Context, db *sql.DB, grant bool) {
	name := c.Param("name")
	// A-8:**写**面守卫在任何实际工作之前 —— 组织行的授权不得被市场命名空间增删。
	// 位置与 agentshare.setPresetGrant 的 requireOrgAgent 同形(首段,先于 body 解析)。
	if !requireMarketAgent(c, db, name) {
		return
	}
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
	// marketplace-5:与技能侧 applyGrant 同口径 —— 单条授权也要剥掉 webadmin
	// 发来的 '@' 前缀(整组替换本来就会剥,同文件两种口径会落库一条永远匹配
	// 不上的死授权),并校验主体存在性,防拼错用户名/部门名静默落库。
	if t == serverstore.GranteeGroup {
		subject = strings.TrimPrefix(subject, "@")
	}
	if t == serverstore.GranteeUser {
		if _, err := serverstore.GetUserByUsername(db, subject); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "用户不存在: "+subject)
			return
		}
	} else {
		if _, err := serverstore.GroupByName(db, subject); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "部门不存在: "+subject)
			return
		}
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
	// marketplace-7:撤销必须记 revoke(技能侧 skill_grant/skill_revoke 成对,
	// 此前无论授权还是撤销都写 agent_grant,审计页无法区分)。
	action := "agent_grant"
	if !grant {
		action = "agent_revoke"
	}
	_ = serverstore.AuditLog(db, adminUsername(c), action, name+" "+string(t)+":"+subject)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// replaceAgentGrants 整组替换智能体的**部门**授权(原子;用户级授权保留),
// 与技能侧 replaceSkillGrants/ReplaceSkillGroupGrants 同语义。
func replaceAgentGrants(c *gin.Context, db *sql.DB) {
	name := c.Param("name")
	// A-8:**写**面守卫在任何实际工作之前(先于 body 解析与事务)。
	// 与 agentshare.replacePresetGrants 的 requireOrgAgent 同形、方向相反。
	if !requireMarketAgent(c, db, name) {
		return
	}
	var req struct {
		Groups []string `json:"groups"`
	}
	// 审计 A5-M7 同源(marketplace-1 放大器):未知字段必须报错而非静默忽略
	// —— 此前误传 {departments:[...]} 的请求在智能体侧是「200 + 授权清空」,
	// 技能侧同请求 400。
	if err := strictBindJSON(c, &req); err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体错误(仅接受 groups 字段)")
		return
	}
	if err := replaceAgentGroupGrants(db, name, req.Groups); err != nil {
		if errors.Is(err, serverstore.ErrValidation) || errors.Is(err, serverstore.ErrNotFound) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "存在不认识的部门名称")
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "操作失败")
		return
	}
	_ = serverstore.AuditLog(db, adminUsername(c), "agent_grants", name+" "+strings.Join(req.Groups, ","))
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// replaceAgentGroupGrants 在一个事务里把「智能体」的部门授权替换为给定集合,
// 用户级授权原样保留。
//
// 为什么不复用 serverstore.ReplaceSkillGroupGrants:那份实现的 kind='skill'
// 是硬编码的,智能体侧没有对偶 DAO(marketplace 无法新增 serverstore 函数)。
// 为什么必须事务化(marketplace-6):旧实现先逐条 RevokeApp(遍历**全部**
// 授权,含用户级)再逐条 GrantApp,中途失败会留下半套授权
// (复核实测 [group:研发部 user:eve] → 500 后只剩 [group:人事部],
// 技能侧同请求整组回滚)。部门存在性校验放在同一事务内,消除 TOCTOU。
func replaceAgentGroupGrants(db *sql.DB, appID string, groups []string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	normalized := make([]string, 0, len(groups))
	seen := map[string]bool{}
	for _, g := range groups {
		g = strings.TrimPrefix(g, "@")
		if g == "" || seen[g] {
			return serverstore.ErrValidation
		}
		seen[g] = true
		var n int
		if err := tx.QueryRow("SELECT COUNT(*) FROM groups WHERE "+serverstore.CaseInsensitiveCmp("name"), g).Scan(&n); err != nil {
			return err
		}
		if n == 0 {
			return serverstore.ErrNotFound
		}
		normalized = append(normalized, g)
	}
	if _, err := tx.Exec("DELETE FROM app_grants WHERE kind = ? AND app_id = ? AND grantee_type = ?",
		serverstore.AppKindAgent, appID, serverstore.GranteeGroup); err != nil {
		return err
	}
	for _, g := range normalized {
		if _, err := tx.Exec("INSERT INTO app_grants (kind, app_id, grantee_type, grantee) VALUES (?, ?, ?, ?)",
			serverstore.AppKindAgent, appID, serverstore.GranteeGroup, g); err != nil {
			return err
		}
	}
	return tx.Commit()
}
