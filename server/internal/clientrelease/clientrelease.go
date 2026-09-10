// Package clientrelease 下发随服务端镜像一起发布的客户端安装包。
//
// 客户端安装包**随服务端镜像发布**(CI 三平台 job 产出 → 镜像内
// /opt/picoaide/client/),服务端直接把那个目录对外提供。于是客户端从
// **它登录的这台服务端**取包:员工机器不需要访问任何外网,且客户端版本
// 天然跟随服务端版本 —— "客户端升了服务端没升"在结构上不可能发生。
//
// 目录里有两样东西(都由 CI 生成,见 .github/workflows/ci.yml 的 release job):
//
//	CLIENT-RELEASE.json   资产清单(版本 + 各平台文件名/sha256)
//	*.exe / *.dmg / ...   安装包本体
package clientrelease

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
)

// Dir 客户端资产的镜像内目录,由 Dockerfile 的 ENV 固定(/opt/picoaide/client)。
// 服务端直接读它 —— 镜像层里的文件随镜像升级而更新,正是要的语义。
var Dir = func() string {
	if v := os.Getenv("PICOAI_CLIENT_RELEASE_DIR"); v != "" {
		return v
	}
	return "/opt/picoaide/client"
}()

// Info 是 CLIENT-RELEASE.json 的结构(CI 的 release job 生成)。
// 用 client.* 嵌套与客户端清单(最新版 latest.json 的 client 段)保持同形状,
// 少一层翻译;schema/channel_id 供排查与将来演进。
type Info struct {
	Schema    int    `json:"schema"`
	ChannelID string `json:"channel_id"`
	Client    struct {
		Version string                     `json:"version"`
		Assets  map[string]json.RawMessage `json:"assets"`
	} `json:"client"`
}

// Handlers 客户端分发端点(路由声明集中在 internal/router)。
type Handlers struct {
	Manifest gin.HandlerFunc
	File     gin.HandlerFunc
}

// NewHandlers 构造端点集合。
// @param version - 服务端版本(compile-time 注入)。
// @param channel - 本部署所属渠道(PICOAI_CHANNEL,缺省 official)。
func NewHandlers(version func() string, channel string) *Handlers {
	if channel == "" {
		channel = "official"
	}
	return &Handlers{
		Manifest: func(c *gin.Context) { manifest(c, version(), channel) },
		File:     file,
	}
}

// manifest 处理 GET /api/client/v2/updates/manifest。
func manifest(c *gin.Context, serverVersion, channel string) {
	// 下载地址按请求来源拼出,不写死 —— 官方 HTTPS 与内网自签/非 443 端口都对。
	base := requestOrigin(c)

	resp := gin.H{
		"schema":     1,
		"channel_id": channel,
		"server":     gin.H{"version": serverVersion},
	}
	if info := loadInfo(); info != nil {
		assets := make(map[string]gin.H, len(info.Client.Assets))
		for key, raw := range info.Client.Assets {
			var a struct {
				File   string `json:"file"`
				SHA256 string `json:"sha256"`
				Size   int64  `json:"size"`
			}
			if json.Unmarshal(raw, &a) != nil || a.File == "" {
				continue
			}
			assets[key] = gin.H{
				"url":    base + "/updates/client/" + a.File,
				"sha256": a.SHA256,
				"size":   a.Size,
			}
		}
		resp["client"] = gin.H{"version": info.Client.Version, "assets": assets}
	}
	// 清单随发布变化,客户端每次检查都要拿最新值 → 不缓存。
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, resp)
}

// file 处理 GET /updates/client/*file。
func file(c *gin.Context) {
	name := strings.TrimPrefix(c.Param("file"), "/")
	if name == "" || strings.ContainsAny(name, `/\`) {
		writeNotFound(c)
		return
	}
	full := filepath.Join(Dir, name)
	if _, err := os.Stat(full); err != nil {
		writeNotFound(c)
		return
	}
	// 文件名含版本号 → 内容固定,可长缓存;ServeFile 自带 Range/断点续传。
	c.Header("Cache-Control", "public, max-age=31536000, immutable")
	http.ServeFile(c.Writer, c.Request, full)
}

// loadInfo 读并解析资产清单;不存在或损坏时返回 nil(镜像可不带客户端)。
func loadInfo() *Info {
	raw, err := os.ReadFile(filepath.Join(Dir, "CLIENT-RELEASE.json"))
	if err != nil {
		return nil
	}
	var info Info
	if err := json.Unmarshal(raw, &info); err != nil || info.Client.Version == "" {
		return nil
	}
	return &info
}

// requestOrigin 拼出客户端可达的绝对来源(如 https://ai.example.com)。
// 优先用反代声明的 X-Forwarded-Proto(Caddy 已配置),否则按连接判断。
func requestOrigin(c *gin.Context) string {
	proto := c.GetHeader("X-Forwarded-Proto")
	if proto != "https" {
		proto = "http"
		if c.Request.TLS != nil {
			proto = "https"
		}
	}
	host := c.Request.Host
	if host == "" {
		host = "127.0.0.1"
	}
	return proto + "://" + host
}

func writeNotFound(c *gin.Context) {
	c.JSON(http.StatusNotFound, gin.H{"error": gin.H{
		"code":    "NOT_FOUND",
		"message": "客户端安装包不存在",
	}})
}
