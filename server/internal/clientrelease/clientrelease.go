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
	"errors"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

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

// 下载链路的写截止时间(2026-09-21 实测缺陷的修复)。
//
// 背景:http.Server 的 WriteTimeout(cmd/server/main.go 的 5 分钟)是**整个响应**写出的
// 硬上限,而客户端安装包是 150–180 MB 的静态大文件、由本包用 http.ServeFile 直接下发。
// 实测(某次部署后,从域名实拉 154 MB 的 AppImage):上行 260–430 KB/s 时下载**恰好在
// 5m0s 处**被服务端断开(访问日志 `200 | 5m0s`,客户端侧 HTTP/2 报 stream INTERNAL_ERROR /
// 连接重置),员工无法自助绕过 —— 保底速率 = 体积/300s ≈ 525 KB/s,低于它的链路必然失败。
//
// 因此这条路由单独放宽写截止时间,判据是"有界但足够":
//
//   - downloadFloorRate:必须仍能下完的**保底速率**,取 64 KiB/s。按当前最大的资产
//     (Windows NSIS 安装包约 180 MB)计,180 MiB / 64 KiB/s ≈ 48 分钟;
//   - downloadWriteDeadlineMin 不低于全局 WriteTimeout(5 分钟),避免比修复前更严;
//   - downloadWriteDeadlineMax 给 1 小时硬上限 —— 只放宽、不取消超时:客户端挂死
//     (既不读也不断开)时连接仍会被回收,不会变成"永不超时"的连接泄漏。
//
// 只影响 /updates/client/* 这一条路由:http.Server 的全局 WriteTimeout 与 SSE/网关
// 语义都不动(用 http.ResponseController 精确改写本次响应的写 deadline)。
const (
	downloadFloorRateBytesPerSec = 64 << 10
	downloadWriteDeadlineMin     = 5 * time.Minute
	downloadWriteDeadlineMax     = time.Hour
)

// downloadWriteDeadline 按文件字节数推出本次响应的写截止时间(供 file 用)。
func downloadWriteDeadline(size int64) time.Duration {
	if size <= 0 {
		// 大小未知(理论上不会走到:ServeFile 之前已 os.Stat):退回全局超时语义。
		return downloadWriteDeadlineMin
	}
	d := time.Duration(size/downloadFloorRateBytesPerSec+1) * time.Second
	if d < downloadWriteDeadlineMin {
		return downloadWriteDeadlineMin
	}
	if d > downloadWriteDeadlineMax {
		return downloadWriteDeadlineMax
	}
	return d
}

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
// (name=".." 曾实测可列出资产目录的父文件名 —— 未认证的目录探测)。
//
// # 下载面的响应头必须**显式**给定（R3-A A-12）
//
// 此前本函数只设 Cache-Control 与写截止,类型完全交给 `http.ServeFile` ——
// 那意味着:没有 `nosniff`(类型判定权交给浏览器)、没有 `Content-Disposition`
// (浏览器可以**内联渲染**下载内容),而 Content-Type 由 ServeFile 按扩展名推导,
// 推不出来时直接**按内容嗅探**(运行镜像里不一定有 mime 数据库,未知扩展名必然
// 走这条路)。安装包一律是二进制下载面,这三件事都不该由字节内容决定。
//
// 三条约束（`download_headers_test.go` 逐条钉住）:
//   - `X-Content-Type-Options: nosniff` —— 浏览器不得改写类型判定;
//   - `Content-Type` 按**扩展名**显式声明（见 assetContentType）;
//   - `Content-Disposition: attachment` —— 一律作为附件下载。
//
// 为什么是 attachment 而不是 inline:本路由的白名单只有安装包
// (.dmg/.exe/.appimage/.deb/.zip/.tar.gz/.msi/.pkg),没有任何一种需要浏览器内联
// 渲染;inline 的收益是零,代价是一个**同源渲染面**。文件名经 mime.FormatMediaType
// 编码(RFC 6266/5987),所以含非 ASCII 的文件名也不会拼出畸形头。
//
// # 只下发**普通文件**（第二十七轮 AA2-01）
//
// 本路由**未认证**（客户端装机时还没有登录态），而资产目录由 CI 产物注入、
// 升级路径还会用 `docker cp`（不 dereference）刷新 —— 与渠道素材完全同类的
// 不可信输入。旧写法 `os.Stat`（跟随符号链接）+ `http.ServeFile`（**按路径
// 二次解析**并再次跟随）意味着资产目录里一个符号链接就等于把容器内任意可读
// 文件挂到了这个未认证端点上。
//
// 现在判据与下发绑成同一个对象：`openAsset` 的 Lstat + os.SameFile 复验收口
// "是不是目录内的普通文件"，下发用 `http.ServeContent` 读**同一个 fd**。
// 与 `internal/channel` 的 assetRegular/openAsset 同源（那一族只差本包没收口）。
func file(c *gin.Context) {
	// 错误面同样不该由嗅探决定类型(nosniff 对 JSON 404 无害,所以放在最前面)。
	c.Header("X-Content-Type-Options", "nosniff")
	name := strings.TrimPrefix(c.Param("file"), "/")
	if !assetNameOK(name) || !allowedAssetName(name) {
		writeNotFound(c)
		return
	}
	// 判据与打开是同一个对象（见 openAsset）：这里的 err 已经覆盖
	// "不存在"、"是目录/符号链接/FIFO/设备"、"打开时被换成了另一个对象"。
	f, st, err := openAsset(name)
	if err != nil {
		writeNotFound(c)
		return
	}
	defer func() { _ = f.Close() }()
	// 文件名含版本号 → 内容固定,可长缓存;ServeContent 自带 Range/断点续传。
	c.Header("Cache-Control", "public, max-age=31536000, immutable")
	// 显式类型 + 附件下载：必须在 ServeContent **之前**设好（它只在
	// Content-Type 为空时才去推导/嗅探）。Range/206 走的是同一份响应头。
	c.Header("Content-Type", assetContentType(name))
	c.Header("Content-Disposition", contentDispositionAttachment(name))
	// 只放宽**这一条路由**的写截止时间(见 downloadWriteDeadline 的推导):
	// 安装包体积大、慢链路下载远超全局 WriteTimeout。底层实现不支持时
	// (SetWriteDeadline 返回 ErrNotSupported)保持原语义,不新增失败面。
	_ = http.NewResponseController(c.Writer).SetWriteDeadline(
		time.Now().Add(downloadWriteDeadline(st.Size())))
	// 用 ServeContent（读上面那个**已校验的 fd**）而不是 ServeFile：后者会
	// 自己再解析一次路径并重新打开，把 openAsset 的 Lstat/SameFile 整体绕开
	// （这正是修前形态的第二半）。
	http.ServeContent(c.Writer, c.Request, name, st.ModTime(), f)
}

// errAssetNotRegular 资产不是普通文件（目录/符号链接/设备/FIFO 等）。
var errAssetNotRegular = errors.New("clientrelease: asset is not a regular file")

// assetNameOK 判定下载面接受的**名字形状**：非空、单段（不含路径分隔符）、不含 `..`。
//
// 唯一实现：端点用它挡请求参数（`c.Param("file")`），openAsset 用它挡"将来可能
// 出现的第二个调用方"—— 两处各自写一份就是本仓反复记录过的漂移源。
// 扩展名白名单是另一件事（allowedAssetName），只在端点用：它是**对外面**的
// 取舍，不是"目录内的东西能不能被打开"的判据。
func assetNameOK(name string) bool {
	return name != "" && !strings.ContainsAny(name, `/\`) && !strings.Contains(name, "..")
}

// assetOpen 是 os.Open 的**测试注入点**（生产恒为 os.Open；包外不可见，无任何
// 运行期赋值）。唯一用途是在测试里构造"Lstat 之后、open 之前路径被换掉"的 TOCTOU
// 窗口 —— 那个窗口在真实文件系统上无法确定性复现，没有它就只能靠概率性竞态或
// 纯结构断言（见 download_regular_file_test.go 的 TOCTOU 用例）。
var assetOpen = os.Open

// openAsset 打开资产目录内的安装包，只接受**普通文件**；返回已打开的 fd 与它的
// 文件信息。
//
// 与 `internal/channel` 的 `openAsset`/`assetRegular` **同源**（同一件事只允许一份
// 形态；跨包不能复用是因为两边的 `Dir` 与名字来源不同，且本包不允许反向依赖
// channel）。为什么不是"先按路径判存在、再按路径打开"（旧写法 = os.Stat +
// http.ServeFile）：两次解析路径之间文件可以被换掉。这里把判据与打开绑成**同一个
// 对象**：
//
//  1. Lstat —— 不跟随符号链接，拒一切非普通文件（目录/链接/设备/FIFO）；
//  2. os.Open 拿 fd；
//  3. f.Stat + os.SameFile —— 关掉"第 1 步之后、第 2 步之前被换成另一个 inode
//     （含换成符号链接）"这个窗口。
//
// 调用方此后只读这个 fd（下发用 http.ServeContent），不再解析路径一次。
//
// 残留（如实记下，不假装没有）：第 1 步是普通文件、第 2 步之前被换成 **FIFO** 时，
// os.Open 会阻塞到有写者。该形态要求攻击者已经能在运行中的容器里写资产目录
// （即已经拿到服务端账户），且旧实现在同一位置暴露得更宽（任何一次请求都跟随
// 链接），因此不引入平台相关的 O_NONBLOCK 去换一个更窄的洞。
func openAsset(name string) (*os.File, os.FileInfo, error) {
	if !assetNameOK(name) {
		return nil, nil, errAssetNotRegular
	}
	return openRegularAsset(filepath.Join(Dir, name))
}

// openRegularAsset 是"判据与打开必须是同一个对象"这条不变式的**唯一实现**。
// 收一个已经由调用方解析好的路径（openAsset 负责名字形状），因此也可以直接对
// 任意路径判类型 —— 测试用 `os.DevNull` 钉"设备文件不算资产"时走的就是这里。
func openRegularAsset(full string) (*os.File, os.FileInfo, error) {
	lst, err := os.Lstat(full)
	if err != nil {
		return nil, nil, err
	}
	if !lst.Mode().IsRegular() {
		return nil, nil, errAssetNotRegular
	}
	f, err := assetOpen(full)
	if err != nil {
		return nil, nil, err
	}
	st, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, nil, err
	}
	if !assetIdentityMatches(lst, st) {
		_ = f.Close()
		return nil, nil, errAssetNotRegular
	}
	return f, st, nil
}

// assetIdentityMatches 报告"按路径看到的东西"（Lstat，不跟随链接）与"fd 打开的东西"
// 是不是**同一个普通文件** —— 与 channel.assetIdentityMatches 同源。
//
// 为什么单拎成一个谓词：那个窗口在真实文件系统上没法确定性复现，但谓词本身可以
// 直接喂真实 FileInfo 判真假（符号链接与其目标是**不同**对象，这正是要拒的形态）。
func assetIdentityMatches(byPath, byFD os.FileInfo) bool {
	return byFD.Mode().IsRegular() && os.SameFile(byPath, byFD)
}

// assetContentTypes 把白名单里的扩展名映射到**平台声明**的媒体类型。
//
// 为什么要一张表而不是 `application/octet-stream` 一刀切:下载面虽然是 attachment,
// 类型仍是操作系统与下载管理器用来"打开/安装"的依据(选错会让用户双击后得到
// "未知文件")。表里全部是 IANA 注册类型或 shared-mime-info 的既定取值,未知扩展名
// 回落 `application/octet-stream` —— 回落值同样**不是**嗅探结果。
//
// 与 allowedAssetExts 必须成对维护:新增白名单扩展名时没配类型 = 回落成
// octet-stream(功能仍正确,只是信息量少),而**不会**退回嗅探。
var assetContentTypes = map[string]string{
	".dmg":      "application/x-apple-diskimage",
	".exe":      "application/vnd.microsoft.portable-executable",
	".appimage": "application/vnd.appimage",
	".deb":      "application/vnd.debian.binary-package",
	".zip":      "application/zip",
	".tar.gz":   "application/gzip",
	".msi":      "application/x-msi",
	".pkg":      "application/vnd.apple.installer+xml",
}

// assetContentType 按扩展名给媒体类型(小写比较,未知回落 octet-stream)。
func assetContentType(name string) string {
	lower := strings.ToLower(name)
	for ext, ctype := range assetContentTypes {
		if strings.HasSuffix(lower, ext) {
			return ctype
		}
	}
	return "application/octet-stream"
}

// contentDispositionAttachment 构造 `attachment; filename="…"`（下载面固定形态）。
//
// 为什么不用 `mime.FormatMediaType`：它把 token 形态的文件名写成**不带引号**的
// `filename=x.dmg`（RFC 6266 允许，但并非所有下载管理器/旧客户端都认）。
// 这里的文件名形态固定（`<slug>-<ver>-<os>.<ext>`），固定输出带引号的
// quoted-string 更稳，也让判据可以逐字断言。
//
// 含非 ASCII 时**同时**给 RFC 5987 的 `filename*`（ASCII 替身在前、UTF-8 真名在后，
// 即 RFC 6266 §4.3 的兼容写法）—— 只给一种会让某类客户端拿到乱码文件名。
//
// 控制字符显式剔除：合法资产名里不可能有换行（文件名由 CI 生成），但响应头绝不
// 接受调用方可控的换行是纵深防御，成本一行（Go 的 http 层也会把 CR/LF 换成空格，
// 那会让"文件名被判据读成另一个值"，不如自己先删掉）。
func contentDispositionAttachment(name string) string {
	clean := strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, name)
	quoted := `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(clean) + `"`
	if isASCII(clean) {
		return "attachment; filename=" + quoted
	}
	return "attachment; filename=" + quoted + "; filename*=UTF-8''" + url.PathEscape(clean)
}

// isASCII 报告字符串是否全部是 ASCII（决定要不要补 filename*）。
func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] > 0x7f {
			return false
		}
	}
	return true
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

// PublicBaseResolver 返回**服务端配置的对外地址**(settings: server.base_url),
// 由 main 注入(缺省 nil = 未配置)。P3-5(审计 2026-09-13):此前来源判定完全
// 依赖请求的 Host/X-Forwarded-Proto ⇒ 攻击者可控的 Host 会被拼进下发的下载
// URL(no-store 已挡住缓存投毒,但配置了对外地址时应以配置为权威)。
var PublicBaseResolver func() string

// configuredBaseURL 读取显式配置的对外地址(只接受 https/回环 http)。
func configuredBaseURL() string {
	if PublicBaseResolver == nil {
		return ""
	}
	raw := strings.TrimSpace(PublicBaseResolver())
	if raw == "" {
		return ""
	}
	base, ok := normalizeBaseURL(raw)
	if !ok || !isSecureBase(base) {
		return ""
	}
	return base
}

// originInput 是来源判定所需的请求事实(与 gin 解耦,便于表驱动测试)。
type originInput struct {
	// ForwardedProto 反代声明的协议(X-Forwarded-Proto)。判定必须走
	// ForwardedProtoIsHTTPS —— 这个字段只负责把**原始头**带进来。
	ForwardedProto string
	// TLS 是否 TLS 直连。
	TLS bool
	// Host 请求 Host(含端口)。
	Host string
}

// ForwardedProtoIsHTTPS 判定 `X-Forwarded-Proto` 是否声明了 https —— 这条判定在
// **全仓只允许这一份实现**（本包的来源判定与 `serverauth.secureCookieFor` 共用）。
//
// 为什么必须共用（第二十七轮 AA2-02 的病根）：同一个头在本仓曾有三处三种口径 ——
// 这里全等比较 `== "https"`、`serverauth` 用 `EqualFold`（不认列表/空白）、
// `wasmapp/appproof` 只判非空。三种口径的取值域都小于**真实解析面**，于是
// `HTTPS` / `https ` / `https, http` 这类代理常态形态下：清单 HTTP 200 但
// `client.assets.*.url` 全空（门户下载卡静默消失，只有一行进程级 warn），
// 而管理会话 cookie 同时丢掉 `Secure`。判定是同一个事实，分成几份就必然分叉。
//
// 为什么落在 clientrelease 而不是 serverauth：`serverauth` 已经依赖本包
// （`oidc.go` 用 `PublicBaseURLEnv` 构造深链回跳地址），反过来放会产生 import
// 环；本包是这两个消费点里更靠下的一层。
//
// 语义（保守正确，宁可不给也不给错）：
//   - **大小写不敏感**：HTTP 的 scheme 是大小写不敏感的 token；
//   - **忽略首尾空白**：代理拼接列表时常带空格；
//   - **逗号列表取最左段**：多跳链路里代理把"自己收到的协议"追加在右侧，最左段
//     才是**客户端侧**那一跳（与 `wasmapp/appproof.ServerURL` 同口径，也是
//     XFF/XFP 的通行约定）；本仓信任模型不按 `PICOAI_TRUSTED_PROXIES` 过滤这个头
//     （gin 的可信代理只作用于 XFF/ClientIP），所以"取最左"必须与"伪造只会更严"
//     一起成立：伪造 `http, https` 只会**降级**，不会凭空造出 https；
//   - **无法判定为 https 一律 false（fail-closed）**：空串、未知 scheme（`wss`/`on`）、
//     最左段为空（形如 `", https"` 的畸形形态）都当作非 https —— 不乐观假设。
//     注意 `http, https` 因此判 false：客户端到第一跳是明文，给 https 下载地址
//     或给 cookie 打 `Secure` 都会让那条链路直接不可用。
func ForwardedProtoIsHTTPS(raw string) bool {
	first, _, _ := strings.Cut(raw, ",")
	return strings.EqualFold(strings.TrimSpace(first), "https")
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
	// 服务端显式配置的对外地址优先于请求头(P3-5)。
	if base := configuredBaseURL(); base != "" {
		return Origin{Base: base}
	}
	if in.Host == "" {
		return Origin{Reason: originUnavailableReason}
	}
	// XFP 的判定只有一份实现(见 ForwardedProtoIsHTTPS):此前这里的字面量全等
	// 比较把 `HTTPS`/`https ` /`https, http` 判成"非 https"⇒ urls=0。
	if ForwardedProtoIsHTTPS(in.ForwardedProto) || in.TLS {
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
