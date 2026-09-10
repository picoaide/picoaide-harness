// Package channel 读取并下发本部署所属渠道的对外内容。
//
// 2026-09-10 起,原来那套"运行时品牌"被渠道配置取代:
//
//   - 内容的唯一来源是镜像内的渠道目录 /opt/picoaide/channel/
//     (构建时由 CI 从仓库 channels/<channel-id>/ 复制进来)。
//   - 没有上传接口、没有快照、没有开关:改内容 = 改渠道配置 → 重新构建镜像,
//     因此内容始终可审计、可追溯,也不会出现"某人改了线上品牌没人知道"。
//   - 客户端登录页、客户端界面、服务端门户读的都是**同一份**渠道内容。
//
// 渠道 id 与配置里的 channel_id 必须一致(updatecheck 也据此校验升级渠道,
// 见 internal/updatecheck 的渠道隔离)。
package channel

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// DirEnv 渠道目录在镜像内的位置(可由 Dockerfile 覆盖)。
const DirEnv = "PICOAI_CHANNEL_DIR"

// defaultDir 渠道目录默认位置。
const defaultDir = "/opt/picoaide/channel"

// maxConfigBytes 配置体积上限(防御异常文件)。
const maxConfigBytes = 64 * 1024

// Config 渠道配置(镜像内 channel.json 的结构)。
type Config struct {
	Schema    int    `json:"schema"`
	ChannelID string `json:"channel_id"`
	Identity  struct {
		DisplayName string `json:"display_name"`
		ShortName   string `json:"short_name"`
		Tagline     string `json:"tagline"`
		Title       string `json:"title"`
	} `json:"identity"`
	Copy struct {
		LoginDisplayName  string `json:"login_display_name"`
		LoginTagline      string `json:"login_tagline"`
		LoginWelcome      string `json:"login_welcome"`
		ClientDisplayName string `json:"client_display_name"`
		ClientTagline     string `json:"client_tagline"`
		PortalWelcome     string `json:"portal_welcome"`
	} `json:"copy"`
	Assets struct {
		Logo     string `json:"logo"`
		LogoDark string `json:"logo_dark"`
		Favicon  string `json:"favicon"`
		Accent   string `json:"accent"`
	} `json:"assets"`
}

// Dir 渠道目录(测试可改)。
var Dir = func() string {
	if v := os.Getenv(DirEnv); v != "" {
		return v
	}
	return defaultDir
}()

// Load 读取渠道配置。
//
// 配置缺失或损坏时返回**中性**兜底值(不含任何厂商品牌),而不是报错:渠道目录
// 缺失意味着"镜像没带渠道配置"(本地开发构建),此时服务端仍应可用。
// 兜底值刻意不带厂商名 —— 仓库里不留任何品牌描述,一切对外文案必须来自渠道包;
// 缺配置的**发行镜像**属交付事故,由 CI 在构建期强制该文件存在(见 ci.yml),
// 启动期另有一致性校验(见 cmd/server 的 resolveStartupChannel)。
func Load() Config {
	raw, err := os.ReadFile(filepath.Join(Dir, "channel.json"))
	if err != nil || len(raw) > maxConfigBytes {
		return fallback()
	}
	var cfg Config
	if err := json.Unmarshal(raw, &cfg); err != nil || cfg.ChannelID == "" {
		return fallback()
	}
	applyDefaults(&cfg)
	return cfg
}

// fallbackBrandName 渠道配置缺失时的中性占位(刻意不含厂商品牌)。
const fallbackBrandName = "Harness"

func fallback() Config {
	cfg := Config{Schema: 1, ChannelID: "official"}
	cfg.Identity.DisplayName = fallbackBrandName
	cfg.Identity.ShortName = fallbackBrandName
	cfg.Identity.Title = fallbackBrandName
	cfg.Copy.LoginDisplayName = fallbackBrandName
	cfg.Copy.ClientDisplayName = fallbackBrandName
	cfg.Assets.Accent = "#2563eb"
	return cfg
}

// applyDefaults 补齐空字段(渠道配置允许省略,省略时用官方值)。
func applyDefaults(cfg *Config) {
	def := fallback()
	setIfEmpty(&cfg.Identity.DisplayName, def.Identity.DisplayName)
	setIfEmpty(&cfg.Identity.ShortName, def.Identity.ShortName)
	setIfEmpty(&cfg.Identity.Title, cfg.Identity.DisplayName)
	setIfEmpty(&cfg.Copy.LoginDisplayName, cfg.Identity.ShortName)
	setIfEmpty(&cfg.Copy.ClientDisplayName, cfg.Identity.DisplayName)
	setIfEmpty(&cfg.Assets.Accent, def.Assets.Accent)
	// 标语/欢迎语允许为空(不强制显示),不做兜底。
}

func setIfEmpty(dst *string, v string) {
	if strings.TrimSpace(*dst) == "" {
		*dst = v
	}
}

// Response 是 GET /api/client/v2/channel 的响应体。
// 字段名与客户端消费方(enterprise 的 channel-sync)对齐。
type Response struct {
	ChannelID string `json:"channel_id"`
	Title     string `json:"title"`
	Login     struct {
		DisplayName string `json:"display_name"`
		Tagline     string `json:"tagline"`
		Welcome     string `json:"welcome"`
		LogoURL     string `json:"logo_url,omitempty"`
	} `json:"login"`
	Client struct {
		DisplayName string `json:"display_name"`
		Tagline     string `json:"tagline"`
	} `json:"client"`
	FaviconURL string `json:"favicon_url,omitempty"`
	Accent     string `json:"accent,omitempty"`
}

// BuildResponse 由渠道配置构造下发内容。
// logo_url / favicon_url 是相对路径,客户端按自己的 serverURL 绝对化
// (与旧 brand 下发的契约一致,客户端侧无需改动绝对化逻辑)。
func BuildResponse(cfg Config) Response {
	var r Response
	r.ChannelID = cfg.ChannelID
	r.Title = cfg.Identity.Title
	r.Login.DisplayName = cfg.Copy.LoginDisplayName
	r.Login.Tagline = cfg.Copy.LoginTagline
	r.Login.Welcome = cfg.Copy.LoginWelcome
	r.Client.DisplayName = cfg.Copy.ClientDisplayName
	r.Client.Tagline = cfg.Copy.ClientTagline
	r.Accent = cfg.Assets.Accent
	// 仅当渠道目录里真有对应文件时才给 URL(避免 404 的图片链接)
	if cfg.Assets.Logo != "" && assetExists(cfg.Assets.Logo) {
		r.Login.LogoURL = "/api/client/v2/channel/logo"
	}
	if cfg.Assets.Favicon != "" && assetExists(cfg.Assets.Favicon) {
		r.FaviconURL = "/api/client/v2/channel/logo"
	}
	return r
}

// assetExists 判断渠道目录里的素材文件是否存在且非目录。
func assetExists(name string) bool {
	if strings.ContainsAny(name, `/\`) || name == "" {
		return false
	}
	st, err := os.Stat(filepath.Join(Dir, name))
	return err == nil && !st.IsDir()
}

// LogoPath 返回要下发的 logo 文件的绝对路径(不存在则返回空)。
// 暗色场景优先 logo_dark(客户端按主题二选一,这里给浅色版:门户与登录页
// 背景都是亮色,深色版留给客户端界面自行处理)。
func LogoPath(dark bool) string {
	cfg := Load()
	name := cfg.Assets.Logo
	if dark && cfg.Assets.LogoDark != "" {
		name = cfg.Assets.LogoDark
	}
	if !assetExists(name) {
		return ""
	}
	return filepath.Join(Dir, name)
}
