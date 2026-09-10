package portal

import (
	"database/sql"
	"strconv"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// Config 门户页的可配置项(webadmin「门户」页)。
//
// 2026-09-10 起**站点名/标语/欢迎语不在本配置里**:它们来自渠道配置
// (镜像内 channels/<id>/channel.json),与客户端登录页/界面同一份内容。
// 这里只保留"分发与开关"类设置:是否公开、下载地址覆盖、说明文字。
type Config struct {
	// Enabled 门户页是否启用(历史字段:保留读写以兼容既有部署)。
	Enabled bool `json:"enabled"`
	// Public 未认证访客是否可访问(默认 true);false 时跳转管理后台登录。
	Public bool `json:"public"`
	// Subtitle 副标题(预留字段,当前模板未渲染)。
	Subtitle string `json:"subtitle"`
	// ClientDownloadURL 兼容旧的单链接配置(拆分前三平台共用)。
	ClientDownloadURL string `json:"client_download_url,omitempty"`
	// ClientDownload* 三平台下载地址覆盖;留空则用**本服务端**的安装包
	// (随镜像发布,见 internal/clientrelease),可指向自有 CDN。
	ClientDownloadLinux string `json:"client_download_linux"`
	ClientDownloadMac   string `json:"client_download_mac"`
	ClientDownloadWin   string `json:"client_download_win"`
	// ClientDownloadNote 下载区补充说明(如"安装包暂未签名")。
	ClientDownloadNote string `json:"client_download_note"`
	// LandingPath 登录后跳转路径。
	LandingPath string `json:"landing_path"`
}

// 设置键(与历史部署兼容:沿用 portal.* 命名,不迁移已有数据)。
const (
	keyEnabled     = "portal.enabled"
	keyPublic      = "portal.public"
	keySubtitle    = "portal.subtitle"
	keyDLURL       = "portal.client_download_url"
	keyDLLinux     = "portal.client_download_linux"
	keyDLMac       = "portal.client_download_mac"
	keyDLWin       = "portal.client_download_win"
	keyDLNote      = "portal.client_download_note"
	keyLandingPath = "portal.landing_path"
)

// LoadConfig 从设置表读取门户配置(缺省:启用且公开)。
func LoadConfig(db *sql.DB) Config {
	s, _ := serverstore.GetAllSettings(db)
	return Config{
		Enabled:             s[keyEnabled] != "false",
		Public:              s[keyPublic] != "false",
		Subtitle:            s[keySubtitle],
		ClientDownloadURL:   s[keyDLURL],
		ClientDownloadLinux: s[keyDLLinux],
		ClientDownloadMac:   s[keyDLMac],
		ClientDownloadWin:   s[keyDLWin],
		ClientDownloadNote:  s[keyDLNote],
		LandingPath:         s[keyLandingPath],
	}
}

// SaveConfig 写回门户配置。
func SaveConfig(db *sql.DB, c Config) error {
	pairs := map[string]string{
		keyEnabled:     strconv.FormatBool(c.Enabled),
		keyPublic:      strconv.FormatBool(c.Public),
		keySubtitle:    c.Subtitle,
		keyDLURL:       c.ClientDownloadURL,
		keyDLLinux:     c.ClientDownloadLinux,
		keyDLMac:       c.ClientDownloadMac,
		keyDLWin:       c.ClientDownloadWin,
		keyDLNote:      c.ClientDownloadNote,
		keyLandingPath: c.LandingPath,
	}
	for k, v := range pairs {
		if err := serverstore.SetSetting(db, k, v); err != nil {
			return err
		}
	}
	return nil
}

// AdminHandlers 门户配置的管理端点(权限由 router 申报:portal:read/write)。
type AdminHandlers struct {
	// Get GET /api/server/admin/portal
	Get gin.HandlerFunc
	// Put PUT /api/server/admin/portal
	Put gin.HandlerFunc
}

// NewAdminHandlers 构造门户管理端点。
func NewAdminHandlers(db *sql.DB) *AdminHandlers {
	return &AdminHandlers{
		Get: func(c *gin.Context) {
			c.JSON(200, LoadConfig(db))
		},
		Put: func(c *gin.Context) {
			var body Config
			if err := c.ShouldBindJSON(&body); err != nil {
				serverauth.WriteError(c, 400, "VALIDATION", "门户配置格式不正确")
				return
			}
			if err := SaveConfig(db, body); err != nil {
				serverauth.WriteError(c, 500, "INTERNAL", "门户配置保存失败")
				return
			}
			c.JSON(200, LoadConfig(db))
		},
	}
}
