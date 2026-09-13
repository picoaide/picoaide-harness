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

// serveAsset 是三个素材端点的公共实现:路径为空(= 未配置或文件不存在)或
// SVG 内容检查不通过时给 404 JSON 信封,否则长缓存下发(素材随镜像固定,
// ServeFile 处理条件请求与 Range)。
//
// 素材来自镜像内的渠道目录(CI 从私有渠道仓注入,属不可信输入),因此响应统一
// 携带 nosniff 与沙箱 CSP —— 三个端点、成功与拒绝路径**同一个**头集合
// (见 svg_guard.go)。URL 是否下发仍只看文件是否存在(LogoPath/BuildResponse
// 语义不变),这里管的是"下发时能不能在服务端源上执行脚本"。
func serveAsset(path, missingMessage string) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("X-Content-Type-Options", assetNoSniff)
		c.Header("Content-Security-Policy", assetCSP)
		if path == "" {
			assetNotFound(c, missingMessage)
			return
		}
		// 内容检查(只对 .svg):命中脚本特征即拒绝下发 —— 与"未配置"返回
		// **同一个** 404 JSON 信封,连 message 都照旧(不新增响应形态,也不向
		// 匿名调用方泄露"素材内容有问题"这个信息)。
		if reason := checkAssetContent(path); reason != "" {
			assetNotFound(c, missingMessage)
			return
		}
		c.Header("Cache-Control", "public, max-age=86400")
		http.ServeFile(c.Writer, c.Request, path)
	}
}

// assetNotFound 是三个素材端点统一的 404 信封(未配置 / 内容检查拒绝共用)。
func assetNotFound(c *gin.Context, message string) {
	c.JSON(http.StatusNotFound, gin.H{"error": gin.H{
		"code":    "NOT_FOUND",
		"message": message,
	}})
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
