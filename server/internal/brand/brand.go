// Package brand 实现服务端品牌与门户首页配置(设计 v3b 2026-09-04):
//   - 公开端点 GET /api/brand(未认证, 登录页/客户端/门户读取品牌)
//   - 公开端点 GET /api/brand/logo/:name(logo 文件, 白名单+SVG sanitize+ETag)
//   - 管理端点 GET/PUT /api/admin/brand(brand:read/write, logo 走 multipart)
//   - 门户首页 GET /api/portal + PUT /api/admin/portal(欢迎语/客户端下载地址)
//
// 配置存 settings KV 表(brand.* / portal.*); logo 文件存 dataDir/brand/(0700),
// 文件名白名单 {login,client,favicon}, 大小 ≤4MB, 扩展名→MIME 白名单, SVG
// sanitize(strip <script>/on*/javascript:), 响应 nosniff。
package brand

import (
	"database/sql"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// LogoKind 是 logo 文件名白名单。
type LogoKind string

const (
	LogoLogin   LogoKind = "login"
	LogoClient  LogoKind = "client"
	LogoFavicon LogoKind = "favicon"
)

var logoKinds = map[string]bool{
	string(LogoLogin):   true,
	string(LogoClient):  true,
	string(LogoFavicon): true,
}

// MaxLogoBytes bounds uploaded logo files (4MB).
const MaxLogoBytes = 4 << 20

// MaxSnapshotKeep is the number of brand snapshots retained.
const MaxSnapshotKeep = 10

// BrandConfig 是品牌配置(JSON 形态), 与 settings 键一一映射。
type BrandConfig struct {
	Enabled bool        `json:"enabled"`
	Login   LoginBrand  `json:"login"`
	Client  ClientBrand `json:"client"`
	Favicon string      `json:"favicon_url,omitempty"`
	Title   string      `json:"title"`
}

type LoginBrand struct {
	LogoURL     string `json:"logo_url,omitempty"`
	DisplayName string `json:"display_name"`
	Tagline     string `json:"tagline"`
	Welcome     string `json:"welcome"`
}

type ClientBrand struct {
	LogoURL     string `json:"logo_url,omitempty"`
	DisplayName string `json:"display_name"`
	Tagline     string `json:"tagline"`
	Accent      string `json:"accent"`
}

// PortalConfig 是门户首页配置。
type PortalConfig struct {
	Enabled            bool   `json:"enabled"`
	Welcome            string `json:"welcome"`
	Subtitle           string `json:"subtitle"`
	ClientDownloadURL  string `json:"client_download_url"`
	ClientDownloadNote string `json:"client_download_note"`
	LandingPath        string `json:"landing_path"`
}

// settings 键映射。
func (b *BrandConfig) load(s map[string]string) {
	b.Enabled = s["brand.enabled"] == "true"
	b.Login = LoginBrand{
		DisplayName: s["brand.login.display_name"],
		Tagline:     s["brand.login.tagline"],
		Welcome:     s["brand.login.welcome"],
	}
	if f := s["brand.login.logo"]; f != "" {
		b.Login.LogoURL = "/api/brand/logo/login"
	}
	b.Client = ClientBrand{
		DisplayName: s["brand.client.display_name"],
		Tagline:     s["brand.client.tagline"],
		Accent:      s["brand.client.accent"],
	}
	if f := s["brand.client.logo"]; f != "" {
		b.Client.LogoURL = "/api/brand/logo/client"
	}
	if f := s["brand.favicon"]; f != "" {
		b.Favicon = "/api/brand/logo/favicon"
	}
	b.Title = s["brand.title"]
}

func (b *BrandConfig) save(db *sql.DB, set func(key, val string) error) error {
	if err := set("brand.enabled", strconv.FormatBool(b.Enabled)); err != nil {
		return err
	}
	for k, v := range map[string]string{
		"brand.login.display_name":  b.Login.DisplayName,
		"brand.login.tagline":       b.Login.Tagline,
		"brand.login.welcome":       b.Login.Welcome,
		"brand.client.display_name": b.Client.DisplayName,
		"brand.client.tagline":      b.Client.Tagline,
		"brand.client.accent":       b.Client.Accent,
		"brand.title":               b.Title,
	} {
		if err := set(k, v); err != nil {
			return err
		}
	}
	return nil
}

func (p *PortalConfig) load(s map[string]string) {
	p.Enabled = s["portal.enabled"] != "false"
	p.Welcome = s["portal.welcome"]
	p.Subtitle = s["portal.subtitle"]
	p.ClientDownloadURL = s["portal.client_download_url"]
	p.ClientDownloadNote = s["portal.client_download_note"]
	p.LandingPath = s["portal.landing_path"]
}

func (p *PortalConfig) save(set func(key, val string) error) error {
	for k, v := range map[string]string{
		"portal.enabled":              strconv.FormatBool(p.Enabled),
		"portal.welcome":              p.Welcome,
		"portal.subtitle":             p.Subtitle,
		"portal.client_download_url":  p.ClientDownloadURL,
		"portal.client_download_note": p.ClientDownloadNote,
		"portal.landing_path":         p.LandingPath,
	} {
		if err := set(k, v); err != nil {
			return err
		}
	}
	return nil
}

// RegisterRoutes 挂载公开端点(gateway 调用, 无需鉴权组)。
func RegisterRoutes(r *gin.Engine, db *sql.DB, dataDir string) {
	g := r.Group("/api")
	g.GET("/brand", func(c *gin.Context) { getPublicBrand(c, db) })
	g.GET("/brand/logo/:name", func(c *gin.Context) { serveLogo(c, db, dataDir) })
	g.GET("/portal", func(c *gin.Context) { getPublicPortal(c, db) })
}

// RegisterAdminRoutes 挂载管理端点(AdminAuth + RBAC 权限)。
func RegisterAdminRoutes(r *gin.Engine, db *sql.DB, dataDir string) {
	g := r.Group("/api/admin", serverauth.AdminAuth(db))
	serverauth.AdminRoute(g, "GET", "/brand", serverauth.PermBrandRead, func(c *gin.Context) { getAdminBrand(c, db) })
	serverauth.AdminRoute(g, "PUT", "/brand", serverauth.PermBrandWrite, func(c *gin.Context) { putAdminBrand(c, db, dataDir) })
	serverauth.AdminRoute(g, "POST", "/brand/logo", serverauth.PermBrandWrite, func(c *gin.Context) { uploadLogo(c, db, dataDir) })
	serverauth.AdminRoute(g, "DELETE", "/brand/logo", serverauth.PermBrandWrite, func(c *gin.Context) { deleteLogo(c, db, dataDir) })
	serverauth.AdminRoute(g, "GET", "/brand/snapshots", serverauth.PermBrandRead, func(c *gin.Context) { listSnapshots(c, db) })
	serverauth.AdminRoute(g, "POST", "/brand/restore", serverauth.PermBrandWrite, func(c *gin.Context) { restoreSnapshot(c, db, dataDir) })
	serverauth.AdminRoute(g, "GET", "/portal", serverauth.PermPortalRead, func(c *gin.Context) { getAdminPortal(c, db) })
	serverauth.AdminRoute(g, "PUT", "/portal", serverauth.PermPortalWrite, func(c *gin.Context) { putAdminPortal(c, db, dataDir) })
}

// loadBrand reads brand settings.
func loadBrand(db *sql.DB) (*BrandConfig, error) {
	s, err := serverstore.GetAllSettings(db)
	if err != nil {
		return nil, err
	}
	b := &BrandConfig{}
	b.load(s)
	return b, nil
}

func loadPortal(db *sql.DB) (*PortalConfig, error) {
	s, err := serverstore.GetAllSettings(db)
	if err != nil {
		return nil, err
	}
	p := &PortalConfig{}
	p.load(s)
	return p, nil
}

func getPublicBrand(c *gin.Context, db *sql.DB) {
	b, err := loadBrand(db)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	if !b.Enabled {
		// 禁用即不吐旧值(防代理缓存旧 logo)。
		c.JSON(http.StatusOK, gin.H{"enabled": false})
		return
	}
	c.JSON(http.StatusOK, b)
}

func getPublicPortal(c *gin.Context, db *sql.DB) {
	p, err := loadPortal(db)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	c.JSON(http.StatusOK, p)
}

// ---------------------------------------------------------------------------
// logo 文件
// ---------------------------------------------------------------------------

var errBadLogoName = fmt.Errorf("invalid logo name")

func brandDir(dataDir string) string { return filepath.Join(dataDir, "brand") }

// logoPath resolves the stored file for a logo kind: brand.<kind>.logo holds
// the filename (e.g. "login.svg"); kinds without a file return "",nil.
func logoPath(db *sql.DB, dataDir, name string) (string, error) {
	if !logoKinds[name] {
		return "", errBadLogoName
	}
	s, err := serverstore.GetAllSettings(db)
	if err != nil {
		return "", err
	}
	f := s["brand."+name+".logo"]
	if f == "" {
		return "", nil
	}
	// 白名单文件名:仅允许 [a-z0-9.-]+ 且以白名单扩展名结尾, 防路径遍历。
	if !regexp.MustCompile(`^[a-z0-9.-]+$`).MatchString(f) {
		return "", errBadLogoName
	}
	return filepath.Join(brandDir(dataDir), f), nil
}

// mimeFor maps extensions to allowed MIME (no content sniffing).
func mimeFor(ext string) string {
	switch strings.ToLower(ext) {
	case ".svg":
		return "image/svg+xml"
	case ".png":
		return "image/png"
	case ".webp":
		return "image/webp"
	case ".ico":
		return "image/x-icon"
	default:
		return ""
	}
}

// serveLogo serves a logo file with ETag + nosniff. SVG content is sanitized.
func serveLogo(c *gin.Context, db *sql.DB, dataDir string) {
	name := c.Param("name")
	path, err := logoPath(db, dataDir, name)
	if err != nil || path == "" {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "logo 不存在")
		return
	}
	s, err := serverstore.GetAllSettings(db)
	if err == nil && s["brand.enabled"] != "true" {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "logo 不存在")
		return
	}
	fi, err := os.Stat(path)
	if err != nil {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "logo 不存在")
		return
	}
	etag := fmt.Sprintf(`"%x-%x"`, fi.ModTime().Unix(), fi.Size())
	if c.GetHeader("If-None-Match") == etag {
		c.Status(http.StatusNotModified)
		return
	}
	raw, err := os.ReadFile(path)
	if err != nil || len(raw) > MaxLogoBytes {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "logo 不存在")
		return
	}
	ext := filepath.Ext(path)
	mt := mimeFor(ext)
	if mt == "" {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "logo 不存在")
		return
	}
	body := raw
	if mt == "image/svg+xml" {
		clean, ok := sanitizeSVG(raw)
		if !ok {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "SVG 内容不合法")
			return
		}
		body = clean
	}
	c.Header("Content-Type", mt)
	c.Header("Cache-Control", "public, max-age=3600")
	c.Header("ETag", etag)
	c.Header("X-Content-Type-Options", "nosniff")
	c.Data(http.StatusOK, mt, body)
}

// sanitizeSVG strips <script>, on* attributes and javascript: URLs.
var reOnAttr = regexp.MustCompile(`(?i)\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)`)
var reScriptTag = regexp.MustCompile(`(?is)<script\b[^>]*>.*?</script\s*>`)
var reJsURL = regexp.MustCompile(`(?i)(href|xlink:href)\s*=\s*("|')javascript:`)

func sanitizeSVG(raw []byte) ([]byte, bool) {
	// 先做 XML 结构校验(解析失败即拒绝), 保证是合法 XML/SVG。
	var v struct{}
	if err := xml.Unmarshal(raw, &v); err != nil {
		return nil, false
	}
	s := string(raw)
	s = reScriptTag.ReplaceAllString(s, "")
	s = reOnAttr.ReplaceAllString(s, "")
	s = reJsURL.ReplaceAllString(s, "$1=$2#")
	return []byte(s), true
}

// ---------------------------------------------------------------------------
// 管理端点
// ---------------------------------------------------------------------------

func getAdminBrand(c *gin.Context, db *sql.DB) {
	b, err := loadBrand(db)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	c.JSON(http.StatusOK, b)
}

func putAdminBrand(c *gin.Context, db *sql.DB, dataDir string) {
	var req struct {
		Enabled bool        `json:"enabled"`
		Login   LoginBrand  `json:"login"`
		Client  ClientBrand `json:"client"`
		Title   string      `json:"title"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体错误")
		return
	}
	// 品牌名/副标题长度约束
	if len(req.Login.DisplayName) > 64 || len(req.Client.DisplayName) > 64 ||
		len(req.Login.Tagline) > 200 || len(req.Client.Tagline) > 200 || len(req.Login.Welcome) > 200 {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "品牌文本过长")
		return
	}
	// accent 校验 #RRGGBB
	if req.Client.Accent != "" && !regexp.MustCompile(`^#[0-9a-fA-F]{6}$`).MatchString(req.Client.Accent) {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "品牌主色格式错误(需 #RRGGBB)")
		return
	}
	// 快照保存前当前配置(若已配置)
	if cur, err := loadBrand(db); err == nil && cur.Enabled || hasBrandEntries(db) {
		snapshotBrand(db, dataDir)
	}
	b := &BrandConfig{Enabled: req.Enabled, Login: req.Login, Client: req.Client, Title: req.Title}
	if err := b.save(db, func(k, v string) error { return serverstore.SetSetting(db, k, v) }); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
		return
	}
	_ = serverstore.AuditLog(db, serverauth.AdminUser(c).Username, "brand_update", "enabled="+strconv.FormatBool(req.Enabled))
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func hasBrandEntries(db *sql.DB) bool {
	s, _ := serverstore.GetAllSettings(db)
	for k, v := range s {
		if strings.HasPrefix(k, "brand.") && v != "" {
			return true
		}
	}
	return false
}

// snapshotBrand stores the current brand config JSON (previous version).
func snapshotBrand(db *sql.DB, dataDir string) {
	cur, err := loadBrand(db)
	if err != nil {
		return
	}
	raw, err := json.Marshal(cur)
	if err != nil {
		return
	}
	_, _ = db.Exec(`INSERT INTO brand_snapshots (data) VALUES (?)`, string(raw))
	// 裁剪:仅保留最近 MaxSnapshotKeep 份
	_, _ = db.Exec(`DELETE FROM brand_snapshots WHERE id NOT IN (
		SELECT id FROM brand_snapshots ORDER BY id DESC LIMIT ?)`, MaxSnapshotKeep)
}

func listSnapshots(c *gin.Context, db *sql.DB) {
	rows, err := db.Query(`SELECT id, created_at, data FROM brand_snapshots ORDER BY id DESC LIMIT 10`)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var id int64
		var createdAt time.Time
		var data string
		if err := rows.Scan(&id, &createdAt, &data); err != nil {
			continue
		}
		out = append(out, gin.H{"id": id, "created_at": createdAt, "data": data})
	}
	c.JSON(http.StatusOK, gin.H{"snapshots": out})
}

func restoreSnapshot(c *gin.Context, db *sql.DB, dataDir string) {
	var req struct {
		ID int64 `json:"id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.ID <= 0 {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "缺少快照 id")
		return
	}
	var data string
	if err := db.QueryRow(`SELECT data FROM brand_snapshots WHERE id = ?`, req.ID).Scan(&data); err != nil {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "快照不存在")
		return
	}
	var b BrandConfig
	if err := json.Unmarshal([]byte(data), &b); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "快照损坏")
		return
	}
	if err := b.save(db, func(k, v string) error { return serverstore.SetSetting(db, k, v) }); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "恢复失败")
		return
	}
	_ = serverstore.AuditLog(db, serverauth.AdminUser(c).Username, "brand_snapshot", fmt.Sprintf("restore:%d", req.ID))
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func deleteLogo(c *gin.Context, db *sql.DB, dataDir string) {
	var req struct {
		Name string `json:"name"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || !logoKinds[req.Name] {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "非法 logo 名")
		return
	}
	path, _ := logoPath(db, dataDir, req.Name)
	if path != "" {
		_ = os.Remove(path)
	}
	_ = serverstore.SetSetting(db, "brand."+req.Name+".logo", "")
	_ = serverstore.AuditLog(db, serverauth.AdminUser(c).Username, "brand_logo_delete", req.Name)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// uploadLogo handles multipart logo upload: form field "name" (login/client/
// favicon) + "file". Stores at <dataDir>/brand/<name>.<ext>, records the
// filename in settings, and sanitizes SVG content before writing.
func uploadLogo(c *gin.Context, db *sql.DB, dataDir string) {
	name := c.PostForm("name")
	if !logoKinds[name] {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "非法 logo 名")
		return
	}
	file, header, err := c.Request.FormFile("file")
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "缺少上传文件")
		return
	}
	defer file.Close()
	if header.Size > MaxLogoBytes {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "logo 文件过大(≤4MB)")
		return
	}
	ext := strings.ToLower(filepath.Ext(header.Filename))
	if mimeFor(ext) == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "仅支持 SVG/PNG/WebP/ICO")
		return
	}
	raw := make([]byte, header.Size)
	if _, err := file.Read(raw); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "读取失败")
		return
	}
	if ext == ".svg" {
		clean, ok := sanitizeSVG(raw)
		if !ok {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "SVG 内容不合法")
			return
		}
		raw = clean
	}
	if err := os.MkdirAll(brandDir(dataDir), 0o700); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "目录创建失败")
		return
	}
	fname := fmt.Sprintf("%s%s", name, ext)
	if err := os.WriteFile(filepath.Join(brandDir(dataDir), fname), raw, 0o600); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "写入失败")
		return
	}
	_ = serverstore.SetSetting(db, "brand."+name+".logo", fname)
	_ = serverstore.AuditLog(db, serverauth.AdminUser(c).Username, "brand_logo_upload", name+":"+fname)
	c.JSON(http.StatusOK, gin.H{"ok": true, "url": "/api/brand/logo/" + name})
}

// ---------------------------------------------------------------------------
// 门户
// ---------------------------------------------------------------------------

func getAdminPortal(c *gin.Context, db *sql.DB) {
	p, err := loadPortal(db)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	c.JSON(http.StatusOK, p)
}

func putAdminPortal(c *gin.Context, db *sql.DB, dataDir string) {
	var req PortalConfig
	if err := c.ShouldBindJSON(&req); err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体错误")
		return
	}
	if err := req.save(func(k, v string) error { return serverstore.SetSetting(db, k, v) }); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
		return
	}
	_ = serverstore.AuditLog(db, serverauth.AdminUser(c).Username, "portal_update", "welcome="+req.Welcome)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
