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
	// Logo GET /api/client/v2/channel/logo —— 下发渠道 logo(来自镜像内渠道目录)
	Logo gin.HandlerFunc
}

// NewHandlers 构造端点集合。
func NewHandlers() *Handlers {
	return &Handlers{
		PublicChannel: func(c *gin.Context) {
			// 内容随镜像固定,但 no-cache 便于升级后立即生效(体量极小)
			c.Header("Cache-Control", "no-cache")
			c.JSON(http.StatusOK, BuildResponse(Load()))
		},
		Logo: func(c *gin.Context) {
			path := LogoPath(false)
			if path == "" {
				c.JSON(http.StatusNotFound, gin.H{"error": gin.H{
					"code":    "NOT_FOUND",
					"message": "渠道未配置 logo",
				}})
				return
			}
			// 渠道 logo 随镜像固定 → 可长缓存;ServeFile 处理条件请求与 Range
			c.Header("Cache-Control", "public, max-age=86400")
			http.ServeFile(c.Writer, c.Request, path)
		},
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
