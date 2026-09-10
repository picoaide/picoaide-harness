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
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"

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

// Asset 单个平台安装包(CLIENT-RELEASE.json 里的一条)。
type Asset struct {
	// File 文件名(相对镜像内资产目录);下载地址由请求来源拼出。
	File string `json:"file"`
	// SHA256 安装包摘要(小写十六进制);客户端据此校验完整性。
	SHA256 string `json:"sha256"`
	// Size 字节数(清单未提供时为 0)。
	Size int64 `json:"size"`
}

// Info 是 CLIENT-RELEASE.json 的结构(CI 的 release job 生成)。
// 用 client.* 嵌套与客户端清单(最新版 latest.json 的 client 段)保持同形状,
// 少一层翻译;schema/channel_id 供排查与将来演进。
type Info struct {
	Schema    int    `json:"schema"`
	ChannelID string `json:"channel_id"`
	Client    struct {
		Version string           `json:"version"`
		Assets  map[string]Asset `json:"assets"`
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
	resp := gin.H{
		"schema":     1,
		"channel_id": channel,
		"server":     gin.H{"version": serverVersion},
	}
	// 下载地址按请求来源拼出,不写死 —— 官方 HTTPS 与内网自签/非 443 端口都对。
	// 但客户端只接受**绝对 https** 地址(见 packages/host/desktop 的
	// desktop-release.ts):给不出安全地址时宁可明说不可用,也不下发一个会被
	// 整份丢弃、客户端静默显示"已是最新"的 http 链接。
	origin := RequestOrigin(c)
	info := LoadInfo()
	switch {
	case info == nil:
		// 镜像没带客户端资产:没有下载地址可给,不属于错误。
	case !origin.OK():
		warnOriginUnavailable(origin.Reason)
		resp["client_unavailable"] = origin.Reason
	default:
		assets := make(map[string]gin.H, len(info.Client.Assets))
		for key, a := range info.Client.Assets {
			if a.File == "" {
				continue
			}
			assets[key] = gin.H{
				"url":    origin.Base + "/updates/client/" + a.File,
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
//
// 只服务资产目录下的**普通安装包文件**:目录里除了安装包还有
// CLIENT-RELEASE.json 等文件,而 http.ServeFile 对目录会直接返回目录列表
// (name=".." 曾实测可列出资产目录的父目录文件名 —— 未认证的目录探测)。
func file(c *gin.Context) {
	name := strings.TrimPrefix(c.Param("file"), "/")
	if name == "" || strings.ContainsAny(name, `/\`) ||
		strings.Contains(name, "..") || !allowedAssetName(name) {
		writeNotFound(c)
		return
	}
	full := filepath.Join(Dir, name)
	st, err := os.Stat(full)
	if err != nil || !st.Mode().IsRegular() {
		writeNotFound(c)
		return
	}
	// 文件名含版本号 → 内容固定,可长缓存;ServeFile 自带 Range/断点续传。
	c.Header("Cache-Control", "public, max-age=31536000, immutable")
	http.ServeFile(c.Writer, c.Request, full)
}

// allowedAssetExts 可对外下发的安装包扩展名白名单(小写比较)。
//
// 白名单而非黑名单:任何新格式都必须显式加入,避免把目录里的任意文件
// (清单 json、将来可能出现的密钥/配置)意外下发出去。
var allowedAssetExts = []string{".dmg", ".exe", ".appimage", ".deb", ".zip", ".tar.gz", ".msi", ".pkg"}

// allowedAssetName 判定文件名扩展名是否在白名单内(大小写不敏感)。
func allowedAssetName(name string) bool {
	lower := strings.ToLower(name)
	for _, ext := range allowedAssetExts {
		if strings.HasSuffix(lower, ext) {
			return true
		}
	}
	return false
}

// PublicBaseURLEnv 显式声明本服务端对外可达地址的环境变量(如
// https://ai.example.com,允许带子路径)。配置后是下载地址的**唯一权威来源**。
const PublicBaseURLEnv = "PICOAI_PUBLIC_BASE_URL"

// originUnavailableReason 是"给不出安全下载地址"时的兜底原因说明
// (下发给客户端/体现在服务端日志里,供运维定位)。
const originUnavailableReason = "server origin is not https; set " + PublicBaseURLEnv

// Origin 是客户端可达的绝对来源解析结果。
type Origin struct {
	// Base 形如 https://ai.example.com[/sub];不可用时为空。
	Base string
	// Reason 不可用的原因(不含任何链接,可直接展示给运维);可用时为空。
	Reason string
}

// OK 报告是否拿到了可下发的安全来源。
func (o Origin) OK() bool { return o.Base != "" }

// 来源告警出口与"只告警一次"闸(测试可替换/重置)。
var (
	logWarn      = log.Printf
	originWarnMu sync.Mutex
	originWarned bool
)

// warnOriginUnavailable 每个进程只告警一次(来源不安全是部署配置问题,
// 每个请求都刷屏只会把日志淹掉)。
func warnOriginUnavailable(reason string) {
	originWarnMu.Lock()
	defer originWarnMu.Unlock()
	if originWarned {
		return
	}
	originWarned = true
	logWarn("clientrelease: %s", reason)
}

// RequestOrigin 解析本请求下客户端可达的绝对来源。
// 门户页与清单用**同一个**判定口径(见 cmd/server 的 portalDownloads)。
func RequestOrigin(c *gin.Context) Origin {
	return resolveOrigin(originInput{
		ForwardedProto: c.GetHeader("X-Forwarded-Proto"),
		TLS:            c.Request.TLS != nil,
		Host:           c.Request.Host,
	})
}

// originInput 是来源判定所需的请求事实(与 gin 解耦,便于表驱动测试)。
type originInput struct {
	// ForwardedProto 反代声明的协议(X-Forwarded-Proto)。
	ForwardedProto string
	// TLS 是否 TLS 直连。
	TLS bool
	// Host 请求 Host(含端口)。
	Host string
}

// resolveOrigin 判定客户端可达来源。
//
// 优先级:显式配置(PICOAI_PUBLIC_BASE_URL,配了就是唯一权威)→ XFP:https
// → TLS → 回环 Host(http,本地开发)→ 无法提供安全地址。
func resolveOrigin(in originInput) Origin {
	if raw := strings.TrimSpace(os.Getenv(PublicBaseURLEnv)); raw != "" {
		base, ok := normalizeBaseURL(raw)
		if !ok {
			return Origin{Reason: PublicBaseURLEnv + " is invalid: expect an absolute http(s) URL without query or fragment"}
		}
		if !isSecureBase(base) {
			return Origin{Reason: PublicBaseURLEnv + " must be https (the client rejects non-https download URLs)"}
		}
		return Origin{Base: base}
	}
	if in.Host == "" {
		return Origin{Reason: originUnavailableReason}
	}
	if in.ForwardedProto == "https" || in.TLS {
		return Origin{Base: "https://" + in.Host}
	}
	if isLoopbackHost(in.Host) {
		return Origin{Base: "http://" + in.Host}
	}
	return Origin{Reason: originUnavailableReason}
}

// normalizeBaseURL 规范化显式配置的对外地址:去掉尾斜杠(允许子路径),
// 拒绝 query/fragment、相对地址与非 http(s) scheme。
func normalizeBaseURL(raw string) (string, bool) {
	if strings.ContainsAny(raw, "?#") {
		return "", false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", false
	}
	return strings.TrimRight(raw, "/"), true
}

// isSecureBase 判定来源是否安全:https 恒安全;http 仅回环(本地开发)可接受。
func isSecureBase(base string) bool {
	u, err := url.Parse(base)
	if err != nil {
		return false
	}
	if u.Scheme == "https" {
		return true
	}
	return isLoopbackHost(u.Host)
}

// isLoopbackHost 判定 host(可含端口,IPv6 可带方括号)是否为本机回环。
func isLoopbackHost(host string) bool {
	switch hostOnly(host) {
	case "127.0.0.1", "localhost", "::1":
		return true
	}
	return false
}

// hostOnly 去掉端口与 IPv6 方括号(如 "127.0.0.1:8080" → "127.0.0.1")。
func hostOnly(hostport string) string {
	h := strings.TrimSpace(hostport)
	if host, _, err := net.SplitHostPort(h); err == nil {
		h = host
	}
	return strings.Trim(strings.ToLower(h), "[]")
}

// LoadInfo 读并解析资产清单;不存在或损坏时返回 nil(镜像可不带客户端)。
// 门户页据此生成下载入口,与 /api/client/v2/updates/manifest 同源。
func LoadInfo() *Info {
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

func writeNotFound(c *gin.Context) {
	c.JSON(http.StatusNotFound, gin.H{"error": gin.H{
		"code":    "NOT_FOUND",
		"message": "客户端安装包不存在",
	}})
}
