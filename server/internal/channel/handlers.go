package channel

import (
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/gin-gonic/gin"
)

// 渠道目录里的素材由 Load/LogoPath 统一解析,这里只负责 HTTP 面。

// Handlers 渠道端点(路由声明集中在 internal/router)。
type Handlers struct {
	// PublicChannel GET /api/client/v2/channel —— 下发渠道内容(登录页/客户端/门户共用)
	PublicChannel gin.HandlerFunc
	// Logo GET /api/client/v2/channel/logo —— 下发浅色 logo(来自镜像内渠道目录)
	Logo gin.HandlerFunc
	// LogoDark GET /api/client/v2/channel/logo-dark —— 下发暗色 logo(未配置即 404)
	LogoDark gin.HandlerFunc
	// Favicon GET /api/client/v2/channel/favicon —— 下发站点图标(未配置即 404)
	Favicon gin.HandlerFunc
}

// NewHandlers 构造端点集合。
func NewHandlers() *Handlers {
	return &Handlers{
		PublicChannel: func(c *gin.Context) {
			// 内容随镜像固定,但 no-cache 便于升级后立即生效(体量极小)
			c.Header("Cache-Control", "no-cache")
			c.JSON(http.StatusOK, BuildResponse(Load()))
		},
		Logo:     serveAsset(LogoPath(false), "渠道未配置 logo"),
		LogoDark: serveAsset(LogoDarkPath(), "渠道未配置暗色 logo"),
		Favicon:  serveAsset(FaviconPath(), "渠道未配置 favicon"),
	}
}

// assetCSP 渠道素材响应的沙箱 CSP。
//
// 为什么素材也要 CSP:渠道素材是**不可信输入**(镜像构建期由私有渠道仓注入,
// 构建期校验是唯一上游门禁),而 SVG 是"能被浏览器当文档执行"的图片格式。
// 消费方(管理台/门户/客户端)都用 <img>,不执行脚本;但**顶层导航**到素材
// URL(钓鱼链接/手输地址)会让浏览器按 image/svg+xml 渲染该文档 —— 内联
// <script>/onload= 会在本服务端源上执行,并可携带 picoaide_session
// (HttpOnly + SameSite=Lax)读同源管理接口(审计 R7 webadmin-branding-1)。
//
// 口径与桌面侧 packages/host/desktop/src/brand-web-route.ts 的沙箱 CSP 同源:
// default-src 'none' 禁掉一切资源(没有 script-src 即不放开脚本,回落到
// default-src), style-src 'unsafe-inline' 只放行 SVG 自身的样式,
// sandbox 再把整份文档降为唯一不透明源(即使内容检查漏了,也取不到同源数据)。
const assetCSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox"

// serveAsset 是三个素材端点的公共实现:路径为空(= 未配置或文件不存在)时
// 404 JSON 信封,否则长缓存下发(素材随镜像固定,ServeFile 处理条件请求与 Range)。
//
// 下发时按不可信输入处理:沙箱 CSP + nosniff + Content-Disposition: inline。
// 内容**原样下发**(渠道目录里没有可回落的可信素材,改内容会让 logo 变破图),
// 防线在响应头与构建期门禁(scripts/ci-channels.sh 的脚本特征校验)。
func serveAsset(path, missingMessage string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if path == "" {
			c.JSON(http.StatusNotFound, gin.H{"error": gin.H{
				"code":    "NOT_FOUND",
				"message": missingMessage,
			}})
			return
		}
		c.Header("Cache-Control", "public, max-age=86400")
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("Content-Disposition", "inline")
		c.Header("Content-Security-Policy", assetCSP)
		http.ServeFile(c.Writer, c.Request, path)
	}
}

// AssetPath 返回渠道目录内某素材的绝对路径(供构建期校验/测试)。
func AssetPath(name string) (string, error) {
	if !assetExists(name) {
		return "", os.ErrNotExist
	}
	return filepath.Join(Dir, name), nil
}

// Age 渠道目录的修改时间(排查用:确认镜像里的渠道配置是本次构建的)。
func Age() time.Time {
	st, err := os.Stat(filepath.Join(Dir, "channel.json"))
	if err != nil {
		return time.Time{}
	}
	return st.ModTime()
}
