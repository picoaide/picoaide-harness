package appserver

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/assets"
	"github.com/picoaide/picoaide/internal/wasmapp/edge"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// staticCacheMaxAge 是宿主直出的静态资源的浏览器缓存时长。
//
// ⚠️ 这不是 §4 的"平台上限数值"（limits 是那些数值的唯一真源），而是 HTTP 缓存策略：
// 资源在 (app_id, version, path) 三元组下**不可变**（§4.2：要改内容只能发新版），
// 但 URL 在不同版本之间是同一个，因此不能给"一年"这种长缓存 —— 否则新版本发布后
// 浏览器还会拿旧字节。5 分钟 + ETag 复验（304 只回头）是"更新能及时生效"与
// "省掉重复传输"的折中。
const staticCacheMaxAge = 5 * time.Minute

// serveStatic 尝试用宿主直出的方式服务一个静态资源（§4.2 / §4.6「响应缓存」）。
//
// 返回 true = 已经写完响应；false = 请求应当继续交给 wasm。
//
// # 路由规则（**这里就是规则本身**，改动前先读 §4.2 与 §4.6 的两行）
//
//  1. **只服务 GET/HEAD**：其余方法（POST/PUT/DELETE…）一律交给 wasm ——
//     否则一个 `POST /` 会拿到 index.html，应用的路由根本没机会跑。
//  2. **`/api` 与 `/api/*` 一律交给 wasm**：这是应用的 API 保留前缀。
//     即使包里恰好有 `api/x.json` 这样的资源也不直出 —— "资源能盖住 API"
//     会让应用的路由表变得不可预测（作者以为在调接口，实际拿到静态文件）。
//  3. **其余路径：资源确实存在（assets.Read 成功）才直出**，否则交给 wasm。
//     判据必须是"真的读到了"，不能用"路径像静态资源"这类形状判断：
//     `/`、`/data`、`/save` 在应用里既可能是页面也可能是 API 路径（§5.1 的应用
//     只用宿主能力，路由形状完全由作者决定），形状判断必然打架。
//  4. 目录形态（以 `/` 结尾）等价于该目录下的 `index.html`；`/` 等价于 `/index.html`。
//  5. **入口文档的特例**：`RequiresLogin()` 为真的应用（allowEntry=false）下
//     `/`、`/index.html`、`<dir>/` 这些**入口**不直出，交给 wasm。
//     理由：R24 把名单判定交给应用，且 §6.1 的链路明写"未授权请求照样进 wasm，
//     由应用返回 403（页面必须显示本人账号）"。如果宿主把入口 HTML 直出，
//     不在名单里的已登录用户就永远看不到那个 403 页面（只看到一个空壳页面，
//     而它的 API 调用会 403）—— 名单应用的入口必须由应用自己把门。
//     子资源（JS/CSS/图片）仍然直出：它们是壳资源，且在 (app,version) 下不可变，
//     正是 §4.6「资源响应缓存是 P0 必配」要保护的部分。
//  6. **平台保留资源（`picoaide.app.json`）永不直出**，见 isReservedAsset 的注释。
//
// # 缓存键
//
// ETag = hash(app_id ‖ version ‖ path ‖ content)。**键必须含 app_id + version**：
// 少了 version 会让"同一路径不同版本"互相命中（本包的测试 explicitly 钉死这一条），
// 少了 app_id 会让不同应用的 `/index.html` 共用一个 ETag。
func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request, appID string,
	rel *serverstore.WasmRelease, store *assets.Store, allowEntry bool) bool {

	if r == nil || store == nil || rel == nil {
		return false
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	logical, isEntry, ok := staticLogicalPath(r.URL)
	if !ok {
		return false
	}
	// 平台保留资源不走静态面（规则 6）。放在入口判定**之前**：保留资源在任何
	// 路径形态下都不该由宿主代答，与 allowEntry 无关。
	if isReservedAsset(logical) {
		return false
	}
	if isEntry && !allowEntry {
		return false
	}
	contentType, data, aerr := store.Read(logical)
	if aerr != nil {
		// 资源不存在 / 路径非法 / 超限：都不是"静态资源命中"，交给 wasm 决定
		// （应用的 404 页面比宿主代答更准确，且这里绝不能因为一个坏资源就 500）。
		return false
	}

	h := w.Header()
	// 宿主安全头（§4.8：含 4xx/5xx，这里也含 304）。
	edge.ApplyHostSecurityHeaders(h, edge.SelfOrigin(r))

	// 应用可控头的白名单过滤（§4.8）：静态资源的头是宿主产物，但统一过一遍
	// 同一条策略 —— content-type 必须在允许集合内，否则宁可不写（由 Go 嗅探）。
	appHeaders := http.Header{}
	appHeaders.Set("Content-Type", contentType)
	for k, vs := range edge.StripAppControlledHeaders(appHeaders) {
		h[k] = vs
	}

	etag := assetETag(appID, rel.Version, logical, data)
	h.Set("ETag", etag)
	// §4.6：「响应缓存 仅缓存 assets.read 的静态资源」—— 这里覆盖
	// ApplyHostSecurityHeaders 写的 no-store（那是给**动态响应**的口径，
	// §4.6 明写"动态响应一律不缓存"）。两条一起读才是完整语义。
	h.Set("Cache-Control", "private, max-age="+strconv.Itoa(int(staticCacheMaxAge.Seconds())))

	if etagMatches(r.Header.Get("If-None-Match"), etag) {
		// 304：不带 body，也不带 Content-Length（RFC 9110：304 不得有消息体）。
		w.WriteHeader(http.StatusNotModified)
		return true
	}

	h.Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(data)
	}
	return true
}

// isReservedAsset 判定一个包内逻辑路径是否是**平台保留资源**（不直出）。
//
// 只有 `picoaide.app.json` 一个（文件名常量取自 limits，不写字面量）：它是平台
// 保留的**应用配置**（`access` / `whitelist[]` / `purpose` /
// `data_sensitivity` / `owner`），而不是应用自己挑的静态资源。
//
// # 为什么必须排除（三条，任一条都足以成立）
//
//  1. `whitelist` 是一份**账号名单**。宿主直出等于把它发给任何能打开应用的人
//     （`access=public` 时是匿名访问者），而平台刻意不校验名单里的账号
//     是否存在就是为了"不提供账号枚举面"（§10.5 第 56d 项）—— 直出名单把这条
//     设计意图整个抹掉；`data_sensitivity` / `owner` 一并暴露。
//  2. R24 把准入判定交给应用（未授权请求**照样进 wasm**，由应用返回 403 并显示
//     本人账号）。静态直出绕过了应用的全部准入判断，等于平台替应用做了一次
//     "谁都能拿"的准入决定。
//  3. §5.1 R26：平台不提供任何员工目录能力。名单文件本身就是一份（小规模）名录。
//
// # 语义（刻意选择）
//
// 保留资源**不是"404"，而是"不由宿主直出"** —— 与入口文档特例同一条路：
// 交给 wasm（`serveStatic` 返回 false），应用照常自己决定（通常 404 或 403）。
// 这样 hosts 侧不需要为它写死任何状态码，也不会把"这个应用有没有配置"变成
// 一个只有宿主才知道的探针面。反向的代价也认账：应用若真的把配置当普通资源
// 返回给访问者，那是应用自己的决定（`assets.read` 仍是 guest 自己的权利）。
//
// # 判定覆盖面
//
//   - **任意目录层级**：`/picoaide.app.json`、`/assets/picoaide.app.json`、
//     `/a/b/picoaide.app.json` 都算 —— 只看最后一段，因为抽取目录是作者可控的，
//     只挡根路径等于留一个搬家就能绕过的口子。
//   - **大小写不敏感**：macOS/Windows 的文件系统就是大小写不敏感的，
//     `PicoAide.App.JSON` 在那些部署上能读到同一个文件。
//   - **编码形态**：`r.URL.Path` 在到达 handler 之前已被 net/http 解码过一次
//     （`/%70icoaide.app.json` ⇒ `/picoaide.app.json`），规则 4/5 的 `path.Clean`
//     也把 `//`、`/./` 归一掉了。这里对**多层编码**做有限次（≤3）解码兜底，
//     防止上游反代/网关的解码层数与 net/http 不同（`/%2570icoaide…` 在只解一次
//     的链路上会以 `%70…` 形态出现）。解码后若出现新的 `/`、`\`、`..` 段则停止 ——
//     那些形态由 staticLogicalPath/assets 负责拒，不属于"保留资源"的判定范围。
func isReservedAsset(logical string) bool {
	if logical == "" {
		return false
	}
	p := logical
	for i := 0; i < 3; i++ {
		if reservedAssetName(p) {
			return true
		}
		decoded, err := url.PathUnescape(p)
		if err != nil || decoded == p {
			return false
		}
		// 解码引入了新的路径结构（分隔符/穿越段）⇒ 不再往下解，交给上层的路径规则。
		if strings.ContainsAny(decoded, "\\") || hasDotSegment(decoded) {
			return false
		}
		p = decoded
	}
	return reservedAssetName(p)
}

// hasDotSegment 报告路径里是否含 `.`/`..` 段（解码后可能出现）。
func hasDotSegment(p string) bool {
	for _, seg := range strings.Split(p, "/") {
		if seg == "." || seg == ".." {
			return true
		}
	}
	return false
}

// reservedAssetName 是 isReservedAsset 的单串判定（原串与解码后的串共用）。
func reservedAssetName(p string) bool {
	name := p
	if i := strings.LastIndexByte(name, '/'); i >= 0 {
		name = name[i+1:]
	}
	return strings.EqualFold(name, limits.AppConfigFileName)
}

// staticLogicalPath 把请求路径映射成包内逻辑路径。
//
// 返回 ok=false 表示"这条路不该由静态服务处理"（交给 wasm）：非绝对路径、
// 含反斜杠、含 `.`/`..` 段、或落在 `/api` 保留前缀下。
//
// 为什么 `..` 段直接判"不静态"而不清洗掉：清洗会把一次穿越尝试变成一次
// "看起来正常"的读取（`/a/../b` 变成 `/b`），审计上就看不到有人在试探。
// assets.Store 自己也会拒（纵深防御），这里只是不让它进入静态路径。
func staticLogicalPath(u *url.URL) (logical string, isEntry bool, ok bool) {
	if u == nil {
		return "", false, false
	}
	p := u.Path
	if p == "" || !strings.HasPrefix(p, "/") || strings.ContainsRune(p, '\\') {
		return "", false, false
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == "." || seg == ".." {
			return "", false, false
		}
	}
	rel := strings.TrimPrefix(path.Clean(p), "/")
	if rel == "." {
		rel = ""
	}
	if strings.HasSuffix(p, "/") && rel != "" {
		rel += "/index.html"
	}
	if rel == "" {
		rel = "index.html"
	}
	// `/api` 是应用 API 的保留前缀：一律交给 wasm（规则 2）。
	if rel == "api" || strings.HasPrefix(rel, "api/") {
		return "", false, false
	}
	return rel, rel == "index.html", true
}

// assetETag 计算静态资源的 ETag：hash(app_id ‖ version ‖ path ‖ content)。
//
// 用带引号的强 ETag（弱校验会让"内容变了"和"内容没变"在语义上混在一起）。
// content 的摘要也进键，是为了让"同样的路径在两台机器上组出同一份内容"这种情况
// 自然得到同一个 ETag（多副本部署下的复验命中），同时保底保证"内容变了 ETag 必变"。
func assetETag(appID, version, logicalPath string, data []byte) string {
	h := sha256.New()
	_, _ = io.WriteString(h, appID)
	_, _ = h.Write([]byte{0})
	_, _ = io.WriteString(h, version)
	_, _ = h.Write([]byte{0})
	_, _ = io.WriteString(h, logicalPath)
	_, _ = h.Write([]byte{0})
	sum := sha256.Sum256(data)
	_, _ = h.Write(sum[:])
	return `"` + hex.EncodeToString(h.Sum(nil))[:32] + `"`
}

// etagMatches 判定 If-None-Match 是否命中（支持 `*`、逗号分隔列表与 `W/` 前缀）。
func etagMatches(header, etag string) bool {
	header = strings.TrimSpace(header)
	if header == "" || etag == "" {
		return false
	}
	if header == "*" {
		return true
	}
	for _, item := range strings.Split(header, ",") {
		item = strings.TrimSpace(item)
		item = strings.TrimPrefix(item, "W/")
		if item == etag {
			return true
		}
	}
	return false
}
