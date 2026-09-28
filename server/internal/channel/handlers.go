package channel

import (
	"io"
	"net/http"
	"path/filepath"

	"github.com/gin-gonic/gin"
)

// 渠道目录里的素材由 Load/LogoPath 统一解析,这里只负责 HTTP 面。

// assetCacheControl 素材响应的缓存策略。
//
// 素材 URL(/channel/logo、/channel/logo-dark、/channel/favicon)是**无版本**的
// 常量路径(channel.go 的 *URLPath),而字节随镜像变化 ⇒ 不能用长缓存:渠道升级后
// 旧 logo 会在浏览器/Electron 会话里滞留到 max-age 过期,而门户 HTML 自身是
// no-store,表现就是"页面是新的、图是旧的"(2026-09-26 审计 W5-04)。
//
// no-cache = 每次都带 Last-Modified 重校验,字节没变就是 304 —— 素材在 KB 量级,
// 代价可忽略;语义与同一个源的 /channel(PublicChannel 的 no-cache)保持一致:
// "内容随镜像固定,但升级后必须立即生效"。
const assetCacheControl = "no-cache"

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

// serveAsset 是三个素材端点的公共实现:路径为空(= 未配置或文件不可用)或
// SVG 内容检查不通过时给 404 JSON 信封,否则下发(ServeContent 处理条件请求与 Range)。
//
// 素材来自镜像内的渠道目录(CI 从私有渠道仓注入,属不可信输入),因此响应统一
// 携带 nosniff 与沙箱 CSP —— 三个端点、成功与拒绝路径**同一个**头集合
// (见 svg_guard.go)。URL 是否下发仍只看文件是否存在(LogoPath/BuildResponse
// 语义不变),这里管的是"下发时能不能在服务端源上执行脚本"。
//
// # 判据与下发必须是同一个对象(2026-09-26 审计 W5-01)
//
// 三个素材端点**未认证**,而渠道目录里的素材可以是渠道包放进去的符号链接 ——
// 于是"素材必须是渠道目录内的普通文件"是这条链路唯一的防线。旧写法
// (LogoPath 判存在 + http.ServeFile 按路径再打开)每次请求都重新解析一次路径,
// 两次解析之间文件可以被换掉。所以这里:
//
//	openAsset(名字) —— Lstat 拒一切非普通文件 → os.Open 取 fd → os.SameFile 复验;
//	checkAssetContentReader —— 内容检查读**同一个 fd**;
//	http.ServeContent —— 下发也读**同一个 fd**,路径不再被解析第三次。
func serveAsset(path, missingMessage string) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("X-Content-Type-Options", assetNoSniff)
		c.Header("Content-Security-Policy", assetCSP)
		if path == "" {
			assetNotFound(c, missingMessage)
			return
		}
		name := filepath.Base(path)
		f, info, err := openAsset(name)
		if err != nil {
			// 目录/符号链接/悬空链接/FIFO/被换掉 —— 一律按"未配置"处理:
			// 与既有拒绝路径**同一个** 404 JSON 信封(不新增响应形态,也不向
			// 匿名调用方泄露"这个文件有问题"这个信息)。
			assetNotFound(c, missingMessage)
			return
		}
		defer func() { _ = f.Close() }()
		// 内容检查(只对 .svg):命中脚本特征即拒绝下发。
		if reason := checkAssetContentReader(name, f); reason != "" {
			assetNotFound(c, missingMessage)
			return
		}
		if _, err := f.Seek(0, io.SeekStart); err != nil {
			assetNotFound(c, missingMessage)
			return
		}
		c.Header("Cache-Control", assetCacheControl)
		http.ServeContent(c.Writer, c.Request, name, info.ModTime(), f)
	}
}

// assetNotFound 是三个素材端点统一的 404 信封(未配置 / 内容检查拒绝共用)。
func assetNotFound(c *gin.Context, message string) {
	c.JSON(http.StatusNotFound, gin.H{"error": gin.H{
		"code":    "NOT_FOUND",
		"message": message,
	}})
}
