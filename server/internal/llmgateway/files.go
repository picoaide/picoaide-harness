package llmgateway

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// ---------------------------------------------------------------------------
// DeepSeek Files API 直通（2026-09-22）
// ---------------------------------------------------------------------------
//
// 背景：上游 DSH 0.1.6 起的 llm-deepseek 适配器默认走 Files API 传图片
// （`representation = 'file'`，见 chat-completions/adapter.ts）：先把图片上传一次拿
// `file_id`，之后每条聊天请求只引用这个 id；拿不到 id 才回落成把图片 base64 内联进
// **每一个**后续请求（`FileResolutionFailure` → base64）。此前网关没有这条路由 ⇒
// 客户端每步先打一次 `POST /v1/files` 404、再回落，请求体长期背着图片字节
// （现场：24h 内多台机器大量 `POST /v1/files 404`）。
//
// 语义（2026-09-22 定案）：
//   - **只支持 DeepSeek**：`/files` 请求里没有 model 字段，无法像 chat 那样按模型选
//     上游；只认 deepseek 系 provider（与余额查询同一个判据 `balanceSupports`：
//     `base_url` 或 `name` 含 `deepseek`），一个都没有就 503。
//     ⚠️ 这是**路由判据**、不是安全边界：能改 provider 配置的人（`gateway:write`，
//     仅 super_admin）本就能把 base_url 指向任意地址，改名同理 —— 它保证的是
//     "默认不会把企业文件发给非 DeepSeek 的既有上游"，不保证"永远发不到别处"。
//   - **归属隔离**（迁移 0077 `gateway_files`）：上游按 API key 划分文件命名空间，
//     而全组织共用一个上游 key ⇒ 文件都在同一账号下。因此网关侧记归属台账：
//     上传记 `(file_id, user_id, expires_at)`；`GET|DELETE /files/{id}` 先判归属，
//     不是自己的按 **404** 处理（与"不存在"同形，不泄露存在性）；`GET /files`
//     只回自己的文件（官方客户端在配额不足时会删"最旧的 dsh- 文件"，不隔离就会
//     误删他人仍在引用的图片）。
//   - **流式转发**：上限 **64MiB**（官方 Files API 文档：单文件 ≤64 MiB，且上传须在
//     10 分钟内完成），上传体边读边转发，不整段进内存。
//   - **仅限流**：不计 token、不落 usage（官方也不按 token 计费文件）；仍走每用户
//     限流（rateLimitPerMinute）与路由组上的 InFlightGuard。
//   - 上游非 2xx 时保留状态码并收敛成 `{"error":{...}}` 信封，客户端据此回落 base64
//     （FileResolutionFailure），不会因为文件接口异常而发不出图。
const (
	// maxFilesResponseBody 上限：/files 的响应是 JSON 元数据（对象/列表），
	// 4MiB 足够，同时防上游异常时无限读进内存。
	maxFilesResponseBody = 4 << 20
	// maxGatewayFileIDLen 是 file_id 的长度上限（官方是 `file-api-<32hex>`）。
	maxGatewayFileIDLen = 200
)

// maxFilesUploadBody 是单次上传体上限，取官方文档口径 **64MiB**
// （api-docs.deepseek.com/api/create-file：单文件 ≤64 MiB，上传须在 10 分钟内完成）。
// 注意上游 SDK 自己允许到 128MiB，比官方服务端口径宽 —— 以官方为准，超限在我们这
// 里就返回 413，不必等上游拒。Test-injectable（与 maxUpstreamBody 同惯例）。
var maxFilesUploadBody int64 = 64 << 20

// fileUpstream 返回 /files 唯一的目标上游：deepseek 系 provider（判据与
// /user/balance 的 balanceSupports 同源：base_url 或 name 含 deepseek），
// 按 id 升序取第一个。没有可用上游时 ok=false。
func fileUpstream(db *sql.DB) (Upstream, bool) {
	ups, err := LoadUpstreams(db)
	if err != nil {
		log.Printf("gateway: files: load upstreams: %v", err)
		return Upstream{}, false
	}
	for i := range ups {
		if !balanceSupports(ups[i].BaseURL, ups[i].Name) {
			continue
		}
		// Files 面是 OpenAI 形状：anthropic-only 的 provider 要走 /anthropic/v1/files，
		// 我们没实现那条路径 —— 选中它会让 filesURL 拼出 <base>/anthropic/... 永久 404
		// 并静默回落 base64（审计 2026-09-22 G-5 实测）。这里显式跳过。
		if ups[i].Protocol != "openai" && ups[i].Protocol != "both" {
			log.Printf("gateway: files: skip provider %s (protocol=%s, Files API 只支持 openai 形状)", ups[i].Name, ups[i].Protocol)
			continue
		}
		return ups[i], true
	}
	return Upstream{}, false
}

// filesURL 拼接官方 Files 路径。
//
// **不插 `/v1`**：官方文档四个 Files 端点（api/create-file、list-files、
// retrieve-file、delete-file）给的路径都是 `<base>/files`（base =
// https://api.deepseek.com），官方客户端（llm-deepseek/common/files-api.ts 的
// `this.path = '/files'`）同样如此。而 base 里显式带 `/v1` 的配置（历史上为迁就
// OpenAI SDK 的 chat 习惯而写）也要归一到同一个真实路径 —— 否则一旦上游只认
// `/files`，上传会 404 并静默回落 base64（功能等于没生效）。
func filesURL(base, suffix string) string {
	base = strings.TrimSuffix(strings.TrimSpace(base), "/")
	base = strings.TrimSuffix(base, "/v1")
	return base + "/files" + suffix
}

// validGatewayFileID 限定 file_id 的形状：官方是 `file-api-<hex>`，这里保守放行
// 字母数字与 `-`/`_`（不含 `.`、`/`、`%`）⇒ `..`、`%2e%2e`、`a/../b` 这类点段与
// 编码穿越形态一律按"不存在"处理，不进上游 URL。
func validGatewayFileID(id string) bool {
	if id == "" || len(id) > maxGatewayFileIDLen {
		return false
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return false
		}
	}
	return true
}

// filesTarget 完成 /files 四个入口共用的前置：认证 → 限流 → 选上游 → 拼 URL。
// 返回 ok=false 时响应已写好，调用方直接 return。
func (a *API) filesTarget(c *gin.Context, suffix string) (*Upstream, string, int64, bool) {
	user := serverauth.CurrentUser(c)
	if user == nil {
		serverauth.WriteError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未认证")
		return nil, "", 0, false
	}
	if !a.rl.allow(user.ID, a.rateLimitPerMinute()) {
		serverauth.WriteError(c, http.StatusTooManyRequests, "RATE_LIMITED", "请求过于频繁,请稍后再试")
		return nil, "", 0, false
	}
	up, ok := fileUpstream(a.DB)
	if !ok {
		serverauth.WriteError(c, http.StatusServiceUnavailable, "UPSTREAM",
			"未配置可用的 DeepSeek 上游(文件接口仅支持 DeepSeek)")
		return nil, "", 0, false
	}
	return &up, filesURL(up.BaseURL, suffix), user.ID, true
}

// filesHTTPClient 返回 Files 转发用的客户端：**不跟随重定向**（3xx 原样交回）。
// 与 balance.go 的 ErrUseLastResponse、官方客户端的 redirect:'error' 同口径 ——
// 跟随重定向会把上游 key 带到另一个主机（Go 只在跨域时剥 Authorization，同域
// 子域仍会转发）。
func (a *API) filesHTTPClient() *http.Client {
	return &http.Client{
		Transport:     a.client.Transport,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// fileNotFoundMessage 是"文件不存在 / 不属于你"的统一文案。
//
// **必须含 ASCII 的 `file` + `not found|expired`，且带上 file id**：官方客户端
// （llm-deepseek/request-files.ts 的 `providerRejectedFileId` + `staleMappings`）用
// 这两个正则判定"这个 file_id 不能用了"，据此失效本地映射并在同一次请求内回落 base64。
// 用纯中文文案（旧版「文件不存在」）它判不出来 ⇒ 该图片让整条会话**每一轮都 404**
// （审计 2026-09-22 F3 用真实正则实测）。文案对所有失败原因同形（不泄露存在性/归属），
// 回显的 id 本来就是调用方自己发来的。
func fileNotFoundMessage(fileID string) string {
	const base = "file_id not found or expired（文件不存在或已过期，请重新上传）"
	if fileID == "" {
		return base
	}
	return base + ": " + fileID
}

// writeFileNotFound 统一的"文件不存在"响应：未登记 / 不属于调用者 / 形状非法
// 一律同形（不泄露存在性）。
func writeFileNotFound(c *gin.Context, fileID string) {
	serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", fileNotFoundMessage(fileID))
}

// filesBodyTracker 记录客户端请求体的读取错误。
//
// 为什么需要：`http.Client.Do` 的失败既可能来自"客户端上传慢/断"，也可能来自
// "上游拨号/TLS/响应头超时"。若只看 `url.Error.Timeout()`，上游超时会被误报成
// "客户端上传过慢"（审计探针 3/3 复现）。这里把**请求体读取**的错误单独抓出来，
// 只有它才允许映射成 413/503，其余一律 502。
type filesBodyTracker struct {
	inner io.ReadCloser
	err   error
}

func (t *filesBodyTracker) Read(p []byte) (int, error) {
	n, err := t.inner.Read(p)
	if err != nil && !errors.Is(err, io.EOF) && t.err == nil {
		t.err = err
	}
	return n, err
}

func (t *filesBodyTracker) Close() error { return t.inner.Close() }

// handleFilesUpload 处理 POST /files(以及 /v1/files)：multipart 上传流式转发。
func (a *API) handleFilesUpload(c *gin.Context) {
	up, target, userID, ok := a.filesTarget(c, "")
	if !ok {
		return
	}
	// 上传体可能远大于聊天请求体，必须放宽读预算，否则 60s 的全局 ReadTimeout
	// 会把慢链路直接判成"请求体格式错误"。
	extendBodyReadDeadline(c)
	// 声明了 Content-Length 且已超限时**先拒后转**：否则要等上游收了一部分字节
	// 才由 MaxBytesReader 中断，白占上游配额（chunked 无声明长度，只能边读边判）。
	if c.Request.ContentLength > maxFilesUploadBody {
		log.Printf("gateway: files upload rejected before forwarding: content-length=%d limit=%d",
			c.Request.ContentLength, maxFilesUploadBody)
		serverauth.WriteError(c, http.StatusRequestEntityTooLarge, "VALIDATION", "请求体过大")
		return
	}
	// 上传体读进内存后**重写 multipart**（把过期时间收进平台上限；见
	// rewriteUploadExpiry）。因此这里不再流式转发：峰值内存 = 原文 + 重写体 ≈ 2×，
	// 由内存闸门按 2× 计费；超限/超预算分别 413 / 503（都在调用上游之前）。
	// 内存闸门**在读体之前**申请（重写期间原文 + 出站体同时在内存 ⇒ 按 2× 计费）：
	// 旧实现先读后申请，闸门占满时仍会先吃下整个 32MiB 才 503（审计 2026-09-22
	// R6 P1-G）。Content-Length 未知（chunked）时只能读完后补记，见 readUploadBody。
	uploadBudget := gatewayLimitsFor(a.DB).budgetBytes
	var uploadRelease func()
	if cl := c.Request.ContentLength; cl > 0 {
		rel, ok := globalBodyParseGate.acquire(uploadBudget, cl*2)
		if !ok {
			log.Printf("gateway: files upload rejected by memory gate before reading: content-length=%d", cl)
			writeBodyParseBusy(c)
			return
		}
		uploadRelease = rel
		defer uploadRelease()
	}
	rawBody, trackerErr, ok := readUploadBody(c, uploadBudget, &uploadRelease)
	if !ok {
		writeFilesTransportError(c, trackerErr)
		return
	}
	if uploadRelease != nil {
		defer uploadRelease()
	}
	outBody, contentType := a.rewriteUploadExpiry(c, rawBody)
	if outBody == nil {
		return // 闸门拒绝，响应已写
	}
	req, err := http.NewRequestWithContext(c.Request.Context(), http.MethodPost, target, bytes.NewReader(outBody))
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "构造上游请求失败")
		return
	}
	req.Header.Set("Authorization", "Bearer "+up.APIKey)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", contentType)
	// 重写后的体长度已知（重写会换 boundary，必须显式带上新的 Content-Type/Length）。
	req.ContentLength = int64(len(outBody))
	resp, err := a.filesHTTPClient().Do(req)
	if err != nil {
		writeFilesTransportError(c, nil)
		return
	}
	// 上传体可能耗时数分钟（官方窗口 10 分钟），已经吃掉全局 WriteTimeout(5m) ——
	// 写响应前必须续写截止时间，否则客户端拿到 EOF 而服务端当成功。
	renewWriteDeadline(c)
	defer resp.Body.Close()
	body, ok := readFilesResponseBody(c, resp)
	if !ok {
		return
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		a.recordUploadedFile(userID, body)
		// 过期行清理也在上传路径做一次：官方客户端的正常路径**从不 list**（只在配额
		// 不足时才 list 回收），只靠 list 兜底会让过期行一直堆积（审计 2026-09-22 F8）。
		if n, err := serverstore.PurgeExpiredGatewayFiles(a.DB, 200); err != nil {
			log.Printf("gateway: files: purge expired ownership rows: %v", err)
		} else if n > 0 {
			log.Printf("gateway: files: purged %d expired ownership row(s)", n)
		}
	}
	relayFilesBody(c, resp, up.APIKey, body)
}

// readUploadBody 把上传体读进内存（上限 maxFilesUploadBody），返回 (体, 读错误, ok)。
// 失败时响应已写好；trackerErr 供三类失败分类（超限/读超时/其它）。
//
// 若调用方因 Content-Length 未知（chunked）尚未申请内存额度，这里读完后按 2× 补记：
// 读已经发生，这道额度主要约束后续重写与并发叠加（闸门仍会挡住新的上传）。
func readUploadBody(c *gin.Context, budget int64, release *func()) ([]byte, error, bool) {
	tracker := &filesBodyTracker{inner: http.MaxBytesReader(c.Writer, c.Request.Body, maxUploadBody())}
	raw, err := io.ReadAll(tracker)
	if err != nil {
		return nil, tracker.err, false
	}
	renewWriteDeadline(c)
	if release != nil && *release == nil {
		rel, ok := globalBodyParseGate.acquire(budget, int64(len(raw))*2)
		if !ok {
			log.Printf("gateway: files upload rejected by memory gate after reading: bytes=%d", len(raw))
			writeBodyParseBusy(c)
			return nil, nil, false
		}
		*release = rel
	}
	return raw, nil, true
}

// maxUploadBody 是上传体上限（测试可注入，见 maxFilesUploadBody 的说明）。
func maxUploadBody() int64 { return maxFilesUploadBody }

// uploadExpiryFields 是官方口径的过期字段名（OpenAI SDK 的 multipart 扁平化写法）。
const (
	expirySecondsField = "expires_after[seconds]"
	expiryAnchorField  = "expires_after[anchor]"
	// expiryJSONField 兼容"整个对象塞进一个字段"的写法（部分客户端直接
	// `form.append('expires_after', JSON.stringify({anchor, seconds}))`）。
	expiryJSONField = "expires_after"
)

// rewriteUploadExpiry 重写上传的 multipart 体，把过期时间收进平台上限
// （`gateway.file_expiry_days`，缺省 7 天）——**让上游也按上限保存**，而不是只在
// 我们的台账里记账（用户 2026-09-22 明确要求："没有带过期时间、或大于 7 天的，
// 直接强制改为 7 天"）。
//
// 语义：
//   - `expires_after[seconds]` 缺失或大于上限 ⇒ 写上限；更小 ⇒ 原样保留（更早的保留
//     期不占配额，尊重客户端）；
//   - `expires_after[anchor]` 缺失 ⇒ 补 `created_at`（官方唯一支持的锚点）；
//   - 整段没有过期字段 ⇒ 在 `file` 部分**之前**插入两个字段（保持"元数据在前、
//     文件在后"的常规顺序）；
//   - 非 multipart / 解析失败 ⇒ **原样转发**（保持既有兼容性：让上游去拒绝畸形请求，
//     而不是我们本地变成一个新失败面），只留一条日志。
//
// 返回值 (出站体, Content-Type)。出站体为 nil 表示已写出响应（内存闸门拒绝）。
func (a *API) rewriteUploadExpiry(c *gin.Context, raw []byte) ([]byte, string) {
	origCT := c.Request.Header.Get("Content-Type")
	_, params, err := mime.ParseMediaType(origCT)
	boundary := params["boundary"]
	if err != nil || boundary == "" || !strings.HasPrefix(strings.ToLower(strings.TrimSpace(origCT)), "multipart/") {
		// 非 multipart：原样转发（不新增失败面），但**照样**按 1× 占内存额度 ——
		// 否则这条路径成了闸门的后门（审计 2026-09-22 R6 P1-G：闸门占满时非 multipart
		// 上传仍 200 且上游收到 8MiB）。
		rel, ok := globalBodyParseGate.acquire(gatewayLimitsFor(a.DB).budgetBytes, int64(len(raw)))
		if !ok {
			log.Printf("gateway: files upload (non-multipart) rejected by memory gate: bytes=%d", len(raw))
			writeBodyParseBusy(c)
			return nil, ""
		}
		defer rel()
		log.Printf("gateway: files upload: not multipart (content-type=%q); forwarded unchanged", origCT)
		return raw, origCT
	}
	capSeconds := int64(gatewayLimitsFor(a.DB).fileExpiry / time.Second)

	// 内存闸门：重写期间原文 + 新体同时在内存里 ⇒ 按 2× 计费。
	budget := gatewayLimitsFor(a.DB).budgetBytes
	release, ok := globalBodyParseGate.acquire(budget, int64(len(raw))*2)
	if !ok {
		log.Printf("gateway: files upload rejected by memory gate: bytes=%d", len(raw))
		writeBodyParseBusy(c)
		return nil, ""
	}
	defer release()

	mr := multipart.NewReader(bytes.NewReader(raw), boundary)
	var buf bytes.Buffer
	buf.Grow(len(raw) + 256)
	mw := multipart.NewWriter(&buf)
	seenExpiry := false // 见过任何过期字段（anchor / seconds / JSON 对象）
	seenAnchor := false
	inserted := false
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			// 解析中途失败：整段原样转发（不把上游能处理的请求变成我们的新错误面）。
			log.Printf("gateway: files upload: multipart parse failed (%v); forwarded unchanged", err)
			return raw, origCT
		}
		name := part.FormName()
		// 插入时机：**读到文件部分之前**（那时元数据都已出现过）。旧实现在第一个非过期
		// 字段（通常是 `purpose`）前就插入，于是真实客户端随后自带的 anchor/seconds
		// 又各写一份 ⇒ `expires_after[anchor]×2 + [seconds]×2`（审计 2026-09-22 R6 P1-E；
		// 官方客户端形态见 llm-deepseek/common/files-api.ts:225-228）。上游对重复字段的
		// 取法未定义，必须避免。
		if !inserted && part.FileName() != "" && !seenExpiry {
			writeExpiryFields(mw, capSeconds)
			inserted = true
		}
		switch name {
		case expirySecondsField:
			seenExpiry = true
			if err := writePart(mw, name, part.FileName(), []byte(strconv.FormatInt(clampExpirySeconds(part, capSeconds), 10))); err != nil {
				log.Printf("gateway: files upload: rewrite expiry failed (%v); forwarded unchanged", err)
				return raw, origCT
			}
		case expiryAnchorField:
			seenExpiry = true
			seenAnchor = true
			if err := writePart(mw, name, part.FileName(), []byte("created_at")); err != nil {
				log.Printf("gateway: files upload: rewrite anchor failed (%v); forwarded unchanged", err)
				return raw, origCT
			}
		case expiryJSONField:
			seenExpiry = true
			// 读满上限再多读 1 字节：超过 maxExpiryJSONBytes 时**放弃重写、整段原样转发**，
			// 绝不用截断后的值去改写（旧实现 LimitReader(4096) 会把超长值截断后发上游，
			// 与"解析失败即原样返回"的注释承诺相反 —— 审计 2026-09-22 R6 P2）。
			val, rerr := io.ReadAll(io.LimitReader(part, maxExpiryJSONBytes+1))
			if rerr != nil || len(val) > maxExpiryJSONBytes {
				log.Printf("gateway: files upload: expires_after JSON too large or unreadable (%v); forwarded unchanged", rerr)
				return raw, origCT
			}
			if err := writePart(mw, name, part.FileName(), rewriteExpiryJSON(val, capSeconds)); err != nil {
				log.Printf("gateway: files upload: rewrite expiry json failed (%v); forwarded unchanged", err)
				return raw, origCT
			}
		default:
			if err := copyPart(mw, part); err != nil {
				log.Printf("gateway: files upload: copy part failed (%v); forwarded unchanged", err)
				return raw, origCT
			}
		}
	}
	if !seenExpiry && !inserted {
		writeExpiryFields(mw, capSeconds)
	} else if seenExpiry && !seenAnchor {
		// 只给了 seconds、没给 anchor：补一个（官方形状要求 anchor=created_at）。
		if err := writePart(mw, expiryAnchorField, "", []byte("created_at")); err != nil {
			log.Printf("gateway: files upload: append anchor failed (%v); forwarded unchanged", err)
			return raw, origCT
		}
	}
	if err := mw.Close(); err != nil {
		log.Printf("gateway: files upload: finalize multipart failed (%v); forwarded unchanged", err)
		return raw, origCT
	}
	return buf.Bytes(), mw.FormDataContentType()
}

// writeExpiryFields 写入官方形状的两个过期字段（元数据在前）。
func writeExpiryFields(mw *multipart.Writer, capSeconds int64) {
	_ = writePart(mw, expiryAnchorField, "", []byte("created_at"))
	_ = writePart(mw, expirySecondsField, "", []byte(strconv.FormatInt(capSeconds, 10)))
}

// writePart 写一个普通（非文件）字段；文件部分走 copyPart 以保留文件名与头。
func writePart(mw *multipart.Writer, name, filename string, value []byte) error {
	var w io.Writer
	var err error
	if filename != "" {
		w, err = mw.CreateFormFile(name, filename)
	} else {
		w, err = mw.CreateFormField(name)
	}
	if err != nil {
		return err
	}
	_, err = w.Write(value)
	return err
}

// copyPart 原样搬运一个部分：**保留原始 part 头**（Content-Type、以及客户端可能带的
// 其它头），只搬运内容。
//
// 不能用 `CreateFormFile`：它会把 Content-Type 强制成 `application/octet-stream` 并把
// 客户端原有的 `image/webp` 等头一律丢掉（审计 2026-09-22 R6 P1-F 实测）——
// 上游据此判媒体类型，丢掉就可能把图片当二进制拒绝。
func copyPart(mw *multipart.Writer, part *multipart.Part) error {
	header := textproto.MIMEHeader{}
	for k, vs := range part.Header {
		// Content-Disposition 由 multipart.Writer 依据 header 里的 filename 重建，原样带上。
		cp := make([]string, len(vs))
		copy(cp, vs)
		header[k] = cp
	}
	w, err := mw.CreatePart(header)
	if err != nil {
		return err
	}
	_, err = io.Copy(w, part)
	return err
}

// clampExpirySeconds 读客户端的 `expires_after[seconds]` 并收敛到上限：
// 解析失败/非正数/超过上限一律写上限（解析失败即按"没带"处理）。
func clampExpirySeconds(part *multipart.Part, capSeconds int64) int64 {
	b, _ := io.ReadAll(io.LimitReader(part, 64))
	n, err := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
	if err != nil || n <= 0 || n > capSeconds {
		return capSeconds
	}
	return n
}

// maxExpiryJSONBytes 是 `expires_after` 整对象写法的体积上限（正常只有几十字节）。
const maxExpiryJSONBytes = 4096

// rewriteExpiryJSON 处理"整个 expires_after 对象塞在一个字段里"的写法：
// 解析成对象后收敛 seconds、锚点固定 created_at；解析失败则原样返回（交给上游）。
func rewriteExpiryJSON(val []byte, capSeconds int64) []byte {
	var obj map[string]any
	if err := json.Unmarshal(val, &obj); err != nil || obj == nil {
		return val
	}
	obj["anchor"] = "created_at"
	// 用 float64 比较：`int64(1e300)` 在 Go 里是溢出/未定义值，旧写法会让超大 seconds
	// **绕过上限**（审计 2026-09-22 R6 P2 实测 1e300 未被收敛）。
	if n, ok := obj["seconds"].(float64); !ok || n <= 0 || n > float64(capSeconds) {
		obj["seconds"] = capSeconds
	}
	out, err := json.Marshal(obj)
	if err != nil {
		return val
	}
	return out
}

// handleFilesList 处理 GET /files（列表）：query 原样透传，**结果按归属过滤**。
func (a *API) handleFilesList(c *gin.Context) {
	suffix := ""
	if q := c.Request.URL.RawQuery; q != "" {
		suffix = "?" + q
	}
	up, target, userID, ok := a.filesTarget(c, suffix)
	if !ok {
		return
	}
	resp, body, ok := a.doFilesMeta(c, up, http.MethodGet, target)
	if !ok {
		return
	}
	// 过期台账顺手清理（低并发路径；失败只记日志，不影响本次请求）。
	if n, err := serverstore.PurgeExpiredGatewayFiles(a.DB, 200); err != nil {
		log.Printf("gateway: files: purge expired ownership rows: %v", err)
	} else if n > 0 {
		log.Printf("gateway: files: purged %d expired ownership row(s)", n)
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		owned, err := serverstore.ListGatewayFileIDs(a.DB, userID)
		if err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "读取文件归属失败")
			return
		}
		body = filterFileList(body, owned)
	}
	relayFilesBody(c, resp, up.APIKey, body)
}

// handleFilesRetrieve 处理 GET /files/:file_id（仅限自己的文件）。
func (a *API) handleFilesRetrieve(c *gin.Context) {
	fileID := c.Param("file_id")
	up, target, userID, ok := a.filesTarget(c, "/"+url.PathEscape(fileID))
	if !ok {
		return
	}
	if !validGatewayFileID(fileID) {
		writeFileNotFound(c, fileID)
		return
	}
	owned, err := serverstore.GatewayFileOwnedBy(a.DB, fileID, userID)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "读取文件归属失败")
		return
	}
	if !owned {
		writeFileNotFound(c, fileID)
		return
	}
	resp, body, ok := a.doFilesMeta(c, up, http.MethodGet, target)
	if !ok {
		return
	}
	// 上游说这个 id 已经不存在（过期/被上游清掉）⇒ 顺手收敛台账，别让悬垂行
	// 一直占着"归属"（否则该 id 会永远被判为自己的、却每次都在上游 404）。
	if resp.StatusCode == http.StatusNotFound {
		if err := serverstore.DeleteGatewayFileRow(a.DB, fileID); err != nil {
			log.Printf("gateway: files: drop stale ownership row %s failed: %v", fileID, err)
		}
	}
	relayFilesBody(c, resp, up.APIKey, body)
}

// handleFilesDelete 处理 DELETE /files/:file_id（仅限自己的文件）。
func (a *API) handleFilesDelete(c *gin.Context) {
	fileID := c.Param("file_id")
	up, target, userID, ok := a.filesTarget(c, "/"+url.PathEscape(fileID))
	if !ok {
		return
	}
	if !validGatewayFileID(fileID) {
		writeFileNotFound(c, fileID)
		return
	}
	owned, err := serverstore.GatewayFileOwnedBy(a.DB, fileID, userID)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "读取文件归属失败")
		return
	}
	if !owned {
		writeFileNotFound(c, fileID)
		return
	}
	resp, body, ok := a.doFilesMeta(c, up, http.MethodDelete, target)
	if !ok {
		return
	}
	// 上游确认删除成功、或上游说这个 id 已经不存在（过期/被上游清掉）时收敛台账。
	if (resp.StatusCode >= 200 && resp.StatusCode < 300) || resp.StatusCode == http.StatusNotFound {
		if err := serverstore.DeleteGatewayFileRow(a.DB, fileID); err != nil {
			log.Printf("gateway: files: delete ownership row %s failed: %v", fileID, err)
		}
	}
	relayFilesBody(c, resp, up.APIKey, body)
}

// doFilesMeta 执行一次无请求体的 Files 转发（GET 列表/检索、DELETE）并读回响应体。
// 返回 ok=false 时响应已写好；resp.Body 已关闭（Header 仍可读）。
func (a *API) doFilesMeta(c *gin.Context, up *Upstream, method, target string) (*http.Response, []byte, bool) {
	req, err := http.NewRequestWithContext(c.Request.Context(), method, target, nil)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "构造上游请求失败")
		return nil, nil, false
	}
	req.Header.Set("Authorization", "Bearer "+up.APIKey)
	req.Header.Set("Accept", "application/json")
	resp, err := a.filesHTTPClient().Do(req)
	if err != nil {
		writeFilesTransportError(c, nil) // 无请求体 ⇒ 一律上游侧失败
		return nil, nil, false
	}
	defer resp.Body.Close()
	body, ok := readFilesResponseBody(c, resp)
	if !ok {
		return nil, nil, false
	}
	return resp, body, true
}

// readFilesResponseBody 按 maxFilesResponseBody 读取上游响应体；超限/读失败时
// 写好错误响应并返回 ok=false。
func readFilesResponseBody(c *gin.Context, resp *http.Response) ([]byte, bool) {
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxFilesResponseBody+1))
	if err != nil {
		serverauth.WriteError(c, http.StatusBadGateway, "UPSTREAM", "读取上游响应失败")
		return nil, false
	}
	if len(body) > maxFilesResponseBody {
		serverauth.WriteError(c, http.StatusBadGateway, "UPSTREAM", "上游响应过大")
		return nil, false
	}
	return body, true
}

// writeFilesTransportError 把 Files 转发失败分成可判定形态。
//
// readErr = **客户端请求体读取**错误（由 filesBodyTracker 捕获），只有它才允许映射成
// "请求体过大/读超时"；readErr == nil 表示失败发生在上游侧（拨号/TLS/响应头超时等），
// 一律 502 —— 否则上游超时会被误报成"客户端上传过慢"，把排查方向带偏。
func writeFilesTransportError(c *gin.Context, readErr error) {
	// 这些分支同样发生在"上传体已经吃掉全局 WriteTimeout"之后（审计 2026-09-22 F6：
	// 不续期时慢上传的失败信封写不出去，客户端只看到 EOF）。写错误响应前先续期。
	renewWriteDeadline(c)
	var maxErr *http.MaxBytesError
	switch {
	case readErr == nil:
		log.Printf("gateway: files upstream request failed: %s", c.Request.URL.Path)
		serverauth.WriteError(c, http.StatusBadGateway, "UPSTREAM", "上游请求失败")
	case errors.As(readErr, &maxErr):
		log.Printf("gateway: files upload over limit (%d): %v", maxFilesUploadBody, readErr)
		serverauth.WriteError(c, http.StatusRequestEntityTooLarge, "VALIDATION", "请求体过大")
	case bodyReadTimeout(readErr):
		log.Printf("gateway: files upload read timed out: %s err=%v", c.Request.URL.Path, readErr)
		serverauth.WriteError(c, http.StatusServiceUnavailable, "SERVER", "读取请求体超时（客户端上传过慢），请稍后重试")
	default:
		log.Printf("gateway: files request body read failed: %s err=%v", c.Request.URL.Path, readErr)
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体读取失败")
	}
}

// recordUploadedFile 从上传响应里取出 id / expires_at / 体积写归属台账。
// 取不到 id（上游响应异常）时不阻断交付，只留日志 —— 该文件在网关侧等于"未登记"，
// list/retrieve/delete 会按 404 处理（安全方向的降级；chat 引用仍可用）。
func (a *API) recordUploadedFile(userID int64, body []byte) {
	var obj struct {
		ID        string          `json:"id"`
		ExpiresAt json.RawMessage `json:"expires_at"`
		Bytes     int64           `json:"bytes"`      // OpenAI 形状
		SizeBytes int64           `json:"size_bytes"` // Anthropic 形状
	}
	if err := json.Unmarshal(body, &obj); err != nil || strings.TrimSpace(obj.ID) == "" {
		log.Printf("gateway: files: upload response has no usable id; ownership not recorded")
		return
	}
	if !validGatewayFileID(obj.ID) {
		log.Printf("gateway: files: upstream returned an unusable file id shape; ownership not recorded")
		return
	}
	var expires *time.Time
	if t, ok := parseFileExpiry(obj.ExpiresAt); ok {
		expires = &t
	}
	expires, clamped := enforceFileExpiry(a.DB, expires)
	if clamped {
		// 上游保留期比平台上限长（或客户端根本没带过期时间）：台账按上限记，
		// 到点即拒绝授权并由回收器在上游删除 —— 公司共享配额不会被长期占用。
		log.Printf("gateway: files: upload expiry clamped to the platform cap (%dd)", int(gatewayLimitsFor(a.DB).fileExpiry/(24*time.Hour)))
	}
	size := obj.Bytes
	if size <= 0 {
		size = obj.SizeBytes
	}
	if err := serverstore.RecordGatewayFileSize(a.DB, obj.ID, userID, expires, size); err != nil {
		log.Printf("gateway: files: record ownership for uploaded file failed: %v", err)
	}
}

// enforceFileExpiry 把"上游给的过期时间"收进平台上限内：
//   - 没给（永久）⇒ 上限时刻；
//   - 给了但比上限更晚 ⇒ 上限时刻；
//   - 给了且更早 ⇒ 尊重客户端（更早的保留期不影响配额）。
//
// 返回 (生效的过期时间, 是否被收敛)。**只在台账层收敛**：上游那边仍按客户端的
// `expires_after` 保存，但我们（唯一的访问路径）到点即拒绝授权，并由 files_reaper
// 在上游删除，因此有效保留期 ≤ 上限（最多多一个回收周期）。
//
// 为什么不改写上传体：官方上传是 multipart（`expires_after[seconds]` + 文件字节），
// 改字段要整包重编码或改走 chunked；而配额的关键是"到点能删掉"，回收器已经做到。
func enforceFileExpiry(db *sql.DB, upstream *time.Time) (*time.Time, bool) {
	capAt := time.Now().Add(gatewayLimitsFor(db).fileExpiry)
	if upstream == nil {
		return &capAt, true
	}
	if upstream.After(capAt) {
		return &capAt, true
	}
	return upstream, false
}

// parseFileExpiry 解析官方 `expires_at`：文档口径是 **Unix 秒（number）**，
// 这里同时容错 RFC3339 与数字字符串（上游/中转的形态漂移不该让归属台账失真）。
func parseFileExpiry(raw json.RawMessage) (time.Time, bool) {
	s := strings.TrimSpace(string(raw))
	if s == "" || s == "null" {
		return time.Time{}, false
	}
	if s[0] == '"' {
		var str string
		if err := json.Unmarshal(raw, &str); err != nil {
			return time.Time{}, false
		}
		str = strings.TrimSpace(str)
		if str == "" {
			return time.Time{}, false
		}
		if n, err := strconv.ParseInt(str, 10, 64); err == nil {
			return time.Unix(n, 0), true
		}
		if t, err := time.Parse(time.RFC3339, str); err == nil {
			return t, true
		}
		return time.Time{}, false
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n <= 0 {
		return time.Time{}, false
	}
	return time.Unix(n, 0), true
}

// filterFileList 把上游返回的**全账号**文件列表过滤成"只含调用者自己的文件"。
//
// 解析失败（形状不符）时**失败关闭**：返回空列表，绝不放行归属不明的 id。
// 其余信封字段（object/has_more/first_id/last_id）原样保留 —— has_more 是上游的
// 分页提示，过滤后可能偏保守（客户端多翻一页），比"漏掉自己的文件"安全。
func filterFileList(body []byte, owned map[string]struct{}) []byte {
	empty := []byte(`{"object":"list","data":[]}`)
	var envelope map[string]any
	if err := json.Unmarshal(body, &envelope); err != nil {
		log.Printf("gateway: files: list response is not a JSON object; returning empty list")
		return empty
	}
	items, ok := envelope["data"].([]any)
	if !ok {
		log.Printf("gateway: files: list response has no data array; returning empty list")
		return empty
	}
	kept := make([]any, 0, len(items))
	for _, item := range items {
		obj, ok := item.(map[string]any)
		if !ok {
			continue
		}
		id, _ := obj["id"].(string)
		if _, mine := owned[id]; !mine {
			continue
		}
		kept = append(kept, obj)
	}
	envelope["data"] = kept
	// first_id/last_id 是上游真实字段（客户端会读），**必须按过滤后的结果重算** ——
	// 原样透传会把别人的 file_id 直接送给调用方（`?limit=1` 即可拿到，再配合
	// `after=` 就能全量枚举；审计 2026-09-22 F1 实测）。
	if len(kept) == 0 {
		delete(envelope, "first_id")
		delete(envelope, "last_id")
		// 本页没有自己的文件：不让客户端继续翻页（继续翻只会拿更多空页，且我们
		// 无法在"不泄露游标"的前提下给出跨页游标）。客户端的配额回收会因此得到
		// deleted=0 ⇒ 回落 base64，功能不受影响。
		envelope["has_more"] = false
	} else {
		first, _ := kept[0].(map[string]any)["id"].(string)
		last, _ := kept[len(kept)-1].(map[string]any)["id"].(string)
		if first != "" {
			envelope["first_id"] = first
		} else {
			delete(envelope, "first_id")
		}
		if last != "" {
			envelope["last_id"] = last
		} else {
			delete(envelope, "last_id")
		}
	}
	out, err := json.Marshal(envelope)
	if err != nil {
		return empty
	}
	return out
}

// relayFilesBody 透传 Files API 响应：2xx 原样（上游 key 脱敏 + 体积上限 +
// content-type 归一），非 2xx 收敛成统一错误信封（与 chat 路径同一个
// sanitizeUpstreamError）。Retry-After / X-Request-Id 白名单透传，便于客户端退避。
func relayFilesBody(c *gin.Context, resp *http.Response, apiKey string, body []byte) {
	for _, k := range []string{"Retry-After", "X-Request-Id"} {
		if v := resp.Header.Get(k); v != "" {
			c.Header(k, v)
		}
	}
	secrets := []string{apiKey}
	body = redactSecrets(body, secrets)
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		// Files API 不会合法地返回 3xx；而上游重定向正是"把 provider key 带去另一个
		// 主机"的经典路径（Go 只在跨域时剥 Authorization，同域子域仍会转发）。
		// 我们既不跟随、也不把 3xx 透传给客户端（那会让客户端去追一个它没有凭据的
		// 地址），统一按上游失败处理。
		log.Printf("gateway: files upstream returned %d (redirect not allowed): %s",
			resp.StatusCode, c.Request.URL.Path)
		serverauth.WriteError(c, http.StatusBadGateway, "UPSTREAM", "上游请求失败")
		return
	}
	if resp.StatusCode >= 400 {
		c.Header("Content-Type", "application/json; charset=utf-8")
		c.Status(resp.StatusCode)
		_, _ = c.Writer.Write(sanitizeUpstreamError(body, secrets))
		return
	}
	if len(body) == 0 {
		if resp.StatusCode == http.StatusNoContent {
			// 204：HTTP 语义禁止 body，保持无体。
			c.Status(resp.StatusCode)
			return
		}
		// §7.0（服务端 API 一律 JSON）：空 2xx 不透传成"无 body 的 200"，
		// 给一个最小的 JSON 对象。
		c.Data(resp.StatusCode, "application/json; charset=utf-8", []byte("{}"))
		return
	}
	ct := strings.TrimSpace(resp.Header.Get("Content-Type"))
	if !strings.HasPrefix(strings.ToLower(ct), "application/json") {
		// Files API 的 2xx 只有 JSON；上游给了别的 content-type（或被中间设备改写）
		// 时不把非 JSON 契约透传给客户端（§7.0）。
		ct = "application/json; charset=utf-8"
	}
	c.Data(resp.StatusCode, ct, body)
}
