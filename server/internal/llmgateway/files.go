package llmgateway

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
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
	tracker := &filesBodyTracker{inner: http.MaxBytesReader(c.Writer, c.Request.Body, maxFilesUploadBody)}
	req, err := http.NewRequestWithContext(c.Request.Context(), http.MethodPost, target, tracker)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "构造上游请求失败")
		return
	}
	req.Header.Set("Authorization", "Bearer "+up.APIKey)
	req.Header.Set("Accept", "application/json")
	// multipart boundary 在 Content-Type 里，必须原样带给上游。
	if ct := c.Request.Header.Get("Content-Type"); ct != "" {
		req.Header.Set("Content-Type", ct)
	}
	if c.Request.ContentLength >= 0 {
		req.ContentLength = c.Request.ContentLength
	}
	resp, err := a.filesHTTPClient().Do(req)
	if err != nil {
		// 请求体读失败（超限/读超时/客户端断开）按请求体语义报；否则是上游侧失败。
		writeFilesTransportError(c, tracker.err)
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

// recordUploadedFile 从上传响应里取出 id/expires_at 写归属台账。
// 取不到 id（上游响应异常）时不阻断交付，只留日志 —— 该文件在网关侧等于"未登记"，
// list/retrieve/delete 会按 404 处理（安全方向的降级；chat 引用仍可用）。
func (a *API) recordUploadedFile(userID int64, body []byte) {
	var obj struct {
		ID        string          `json:"id"`
		ExpiresAt json.RawMessage `json:"expires_at"`
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
	if err := serverstore.RecordGatewayFile(a.DB, obj.ID, userID, expires); err != nil {
		log.Printf("gateway: files: record ownership for uploaded file failed: %v", err)
	}
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
