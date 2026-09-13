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
	// Enabled 门户页是否启用。
	//
	// 注意(R7 srvcore-4 / R7-RV-7,审计确认的死字段):服务端**没有任何消费方** ——
	// cmd/server 的 servePortal 只读 portal.public,写 enabled=false 不会下线
	// 门户。字段不能删(webadmin 契约 + 部分更新语义),所以 API 用
	// reserved_fields / reserved_note 显式声明它"已接受、尚未生效"
	// (见 ReservedFields):谁给它接上消费方,谁就必须把它从保留清单里删掉。
	// 真要用它下线门户请用 portal.public。
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
	//
	// 与 Enabled 同类(R7 srvcore-4 / R7-RV-7):全仓无消费方(服务端不下发、
	// 客户端也没有对应字段),设计文档承诺的"可配置落地页"并未实现;同样通过
	// reserved_fields / reserved_note 向调用方声明"尚未生效"。真要用它,
	// 请先实现消费方再把本字段移出保留清单。
	LandingPath string `json:"landing_path"`
}

// Update 门户配置的**部分更新**(PUT /api/server/admin/portal 的请求体)。
//
// 2026-09-13(审计 R7 srvcore-3):原来直接把请求体解码进 Config 再整份写回,
// Go 零值让"没提供的字段"变成 false/"" —— 一次「只改 Windows 下载地址」的
// PUT 会把 public/enabled 打成 false,公开门户当场 302 → /admin/。
// 指针字段区分两种语义:nil = 未提供(保持库里现值),显式 false/空串 = 生效。
type Update struct {
	Enabled             *bool   `json:"enabled"`
	Public              *bool   `json:"public"`
	Subtitle            *string `json:"subtitle"`
	ClientDownloadURL   *string `json:"client_download_url"`
	ClientDownloadLinux *string `json:"client_download_linux"`
	ClientDownloadMac   *string `json:"client_download_mac"`
	ClientDownloadWin   *string `json:"client_download_win"`
	ClientDownloadNote  *string `json:"client_download_note"`
	LandingPath         *string `json:"landing_path"`
}

// Apply 把部分更新合并到现值上(未提供的字段原样保持)。
func (u Update) Apply(cur Config) Config {
	if u.Enabled != nil {
		cur.Enabled = *u.Enabled
	}
	if u.Public != nil {
		cur.Public = *u.Public
	}
	if u.Subtitle != nil {
		cur.Subtitle = *u.Subtitle
	}
	if u.ClientDownloadURL != nil {
		cur.ClientDownloadURL = *u.ClientDownloadURL
	}
	if u.ClientDownloadLinux != nil {
		cur.ClientDownloadLinux = *u.ClientDownloadLinux
	}
	if u.ClientDownloadMac != nil {
		cur.ClientDownloadMac = *u.ClientDownloadMac
	}
	if u.ClientDownloadWin != nil {
		cur.ClientDownloadWin = *u.ClientDownloadWin
	}
	if u.ClientDownloadNote != nil {
		cur.ClientDownloadNote = *u.ClientDownloadNote
	}
	if u.LandingPath != nil {
		cur.LandingPath = *u.LandingPath
	}
	return cur
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

// reservedConfigFields 门户配置里**已接受、已回显、但没有任何消费方**的字段
// (审计 R7-RV-7:死开关)。
//
// 为什么保留而不是删掉:字段是 webadmin 与历史客户端已经在用的 JSON 契约,
// 删除 = 破坏读写(且 srvcore-3 的部分更新语义依赖它们)。但"改了没反应"的
// 开关比没有开关更危险 —— 运维按文档写 enabled=false,以为门户下线了,实际
// 门户照常公开。所以让 API 自描述:GET/PUT 响应里显式声明这份清单。
//
// 单一真源:响应里的 reserved_fields 只由本变量生成,GET 与 PUT 不可能漂移。
// 将来谁给 Enabled/LandingPath 接上消费方(例如 cmd/server 的 servePortal
// 读 portal.enabled),**必须同时把它从本清单删掉** —— 否则 API 会对运维
// 继续谎称"该字段未生效"。
var reservedConfigFields = []string{"enabled", "landing_path"}

// reservedNote 对 reserved_fields 的人话说明:为什么无效、真正该动哪个开关。
const reservedNote = "enabled 与 landing_path 是保留字段(尚未生效):接口照常接受并原样回显,但当前没有任何消费方。" +
	"要让门户下线请设 public=false;登录后落地页由角色默认分区决定。"

// ReservedFields 返回门户配置里当前**已接受但尚未生效**的字段名(副本,
// 调用方可安全修改)。与 API 响应里的 reserved_fields 同源;新增消费方后
// 必须同步从 reservedConfigFields 移除,见其注释。
func ReservedFields() []string {
	return append([]string(nil), reservedConfigFields...)
}

// ConfigResponse 门户配置的对外响应体:Config **内嵌**(JSON 里字段仍在顶层,
// 既有客户端/测试直接 unmarshal 成 Config 不受影响)+ 自描述元字段。
type ConfigResponse struct {
	Config
	// ReservedFields 已接受但尚未生效的字段名(见 ReservedFields)。
	ReservedFields []string `json:"reserved_fields"`
	// ReservedNote 这些字段为什么没效果、真正该用什么开关。
	ReservedNote string `json:"reserved_note"`
}

// response 把配置包成对外响应(元字段始终来自同一份 Go 定义)。
func response(c Config) ConfigResponse {
	return ConfigResponse{Config: c, ReservedFields: ReservedFields(), ReservedNote: reservedNote}
}

// NewAdminHandlers 构造门户管理端点。
func NewAdminHandlers(db *sql.DB) *AdminHandlers {
	return &AdminHandlers{
		Get: func(c *gin.Context) {
			c.JSON(200, response(LoadConfig(db)))
		},
		Put: func(c *gin.Context) {
			// 部分更新:未提供的字段保持现值(见 Update 的注释)。
			var body Update
			if err := c.ShouldBindJSON(&body); err != nil {
				serverauth.WriteError(c, 400, "VALIDATION", "门户配置格式不正确")
				return
			}
			if err := SaveConfig(db, body.Apply(LoadConfig(db))); err != nil {
				serverauth.WriteError(c, 500, "INTERNAL", "门户配置保存失败")
				return
			}
			c.JSON(200, response(LoadConfig(db)))
		},
	}
}
