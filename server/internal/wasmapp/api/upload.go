package api

import (
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/upload"
)

// 本文件是 §4.2 的**分片上传面**（5 个端点，全部挂 `/api/client/v2/apps/wasm/uploads`）：
//
//	POST   /uploads                            开会话
//	PUT    /uploads/:upload_id/chunks/:index   上传第 index 片（application/octet-stream）
//	GET    /uploads/:upload_id                 续传查询（已收到哪些片）
//	POST   /uploads/:upload_id/complete        拼装并走既有发布链路
//	DELETE /uploads/:upload_id                 主动放弃（回收磁盘）
//
// # 为什么分片、为什么 5 个端点
//
// §7.3 的计时序是硬约束：**客户端 90 s > 服务端 ReadTimeout 60 s > 编译 60 s**。
// 32 MiB 一次 POST 必然撞 60 s，所以大载荷必须分片（§10.5 第 58 项）；而"断线后
// 只补缺失的片"要求服务端能回答"我收到了哪些片"—— 这就是 GET 那一条。
//
// # 与会话存储的分工（本文件**不**碰文件系统）
//
// 全部磁盘/元数据逻辑在 `internal/wasmapp/upload`；本文件只做四件事：
// 身份、形态闸（upload_id 必须严格 hex，**在拼路径之前**）、HTTP 语义（413/411/429）、
// 以及把拼装出的字节交给**同一个**发布实现（publishFromBytes，见 publish.go）。
//
// # 三条不变量的落点
//
//   - **总量上限不因分片放宽**：开会话时 total_bytes ≤ limits.WasmMaxBytes（存储层），
//     每片按 Content-Length + MaxBytesReader 限体，累计超限增量拒（存储层）；
//   - **会话绑定发起者**：publisher 一律取**已认证身份**（`h.currentUser`），请求体里
//     没有、也不接受任何"发起者"字段；跨用户访问由存储层回 404（与"不存在"逐字相同）；
//   - **不能绕过上传频率闸门**：complete 走 `acquireUpload`（每用户 30 次/小时 +
//     同时 1 次编译中），与 validate/publish 合计 —— 见下面三个决定的说明。

// uploadState 是分片上传会话存储的**惰性单例**（Handlers 的字段，类型定义在本文件）。
//
// 为什么惰性：Store 需要 DataRoot（装配期才知道），而 NewHandlers 没有 error 通道；
// 惰性构造让"未配置数据根"在第一次请求时以结构化错误暴露（与 requirePlatform 同口径）。
type uploadState struct {
	once  sync.Once
	store *upload.Store
}

// uploads 返回进程内唯一的分片上传会话存储。
//
// **唯一**很重要：会话级互斥（同一会话的 PUT 串行、complete 与 PUT 互斥）与幂等
// 重放缓存都活在 Store 实例里 —— 两个实例 = 两把锁 = meta.json 丢更新。
func (h *Handlers) uploads() *upload.Store {
	h.up.once.Do(func() {
		h.up.store = upload.New(upload.Options{
			DataRoot: h.opt.DataRoot,
			// 时钟必须是**动态**的（h.now 每次读 h.opt.Now）：测试用它造过期会话。
			Now:                h.now,
			AppIDExtraReserved: h.opt.AppIDExtraReserved,
		})
	})
	return h.up.store
}

// UploadCleaner 返回分片上传会话的保留期回收器（§4.2：会话有效期 30 分钟）。
//
// cmd/server 用它挂 `upload.NewCleanupScheduler(...)`：没有生产调用方时，过期会话
// 只能靠"恰好有人用同一个 upload_id"惰性回收 —— 一个断线客户端留下的 32 MiB 会
// 永久占盘（与 events.Cleanup 的坑同型：实现是对的，但零调用方）。
func (h *Handlers) UploadCleaner() upload.Cleaner { return h.uploads() }

const (
	// uploadCreateBodyMaxBytes 是 POST /uploads 的请求体上限：只有 4 个短字段。
	// 与包内既有小 JSON 端点同口径（release.go 的 freeze/set_published 用 4096），
	// **不是**新的平台数值（§4 的上限数值仍全部来自 limits）。
	uploadCreateBodyMaxBytes = 4096
	// uploadCompleteBodyMaxBytes 是 complete 的请求体上限：与 publish 的**小体**部分
	// 同形（title/changelog/config）。config 本身另有 limits.AppConfigMaxBytes 上限
	// （64 KiB），这里再留 8 KiB 给 title/changelog 与 JSON 结构。
	uploadCompleteBodyMaxBytes = int64(limits.AppConfigMaxBytes) + (8 << 10)
	// jsonContentType 与 gin 的 c.JSON 写出的 Content-Type 逐字一致。
	//
	// 用它 + c.Data 是为了**幂等重放**：重复 complete 必须回放与首次逐字相同的字节
	// （含 Content-Type），所以响应体先在发布链路里序列化一次、再原样写出。
	jsonContentType = "application/json; charset=utf-8"
)

// uploadCreateRequest 是 POST /uploads 的请求体（§4.2）。
type uploadCreateRequest struct {
	AppID      string `json:"app_id"`
	Version    string `json:"version"`
	TotalBytes int64  `json:"total_bytes"`
	ChunkBytes int64  `json:"chunk_bytes"`
}

// ---------------------------------------------------------------------------
// POST /uploads：开会话
// ---------------------------------------------------------------------------

func (h *Handlers) uploadCreate(c *gin.Context) {
	if err := h.requireCompiler(); err != nil {
		writeErr(c, err)
		return
	}
	u, aerr := h.currentUser(c)
	if aerr != nil {
		writeErr(c, aerr)
		return
	}
	in, berr := bindJSONLimited[uploadCreateRequest](c, uploadCreateBodyMaxBytes, "uploads")
	if berr != nil {
		writeErr(c, createBindError(berr, c.Request.ContentLength))
		return
	}
	// 开会话**不占**上传频率额度：§4.3 的闸门罩的是"上传即预编译"的编译 CPU，
	// 而开会话只写一份 meta.json（不编译、不落制品）；把它计入会让"32 MiB 分 4 片"
	// 白吃 4 次/30 次的小时额度。**complete 一律计数**（它真的编译）。
	//
	// 归属检查也不在这里：唯一检查点是发布链路的 checkOwner（§8/R6）—— 开会话
	// 只消耗**发起者自己**的配额，不影响别人，提前判会让"先传好再确认归属"这种
	// 正常时序变成两个错误码。
	sess, serr := h.uploads().Create(u.Username, upload.CreateInput{
		AppID:      in.AppID,
		Version:    in.Version,
		TotalBytes: in.TotalBytes,
		ChunkBytes: in.ChunkBytes,
	})
	if serr != nil {
		writeErr(c, serr)
		return
	}
	c.JSON(http.StatusCreated, gin.H{
		"upload_id":   sess.UploadID,
		"received":    sess.Received,
		"chunk_bytes": sess.ChunkBytes,
		"expires_at":  sess.ExpiresAt.UTC().Format(time.RFC3339),
	})
}

// ---------------------------------------------------------------------------
// PUT /uploads/:upload_id/chunks/:index：上传一片
// ---------------------------------------------------------------------------

func (h *Handlers) uploadChunk(c *gin.Context) {
	if err := h.requireCompiler(); err != nil {
		writeErr(c, err)
		return
	}
	u, aerr := h.currentUser(c)
	if aerr != nil {
		writeErr(c, aerr)
		return
	}
	id, ierr := h.uploadIDParam(c)
	if ierr != nil {
		writeErr(c, ierr)
		return
	}
	rawIndex := strings.TrimSpace(c.Param("index"))
	index, perr := strconv.Atoi(rawIndex)
	if perr != nil {
		// 负数在这里也能解析成功（"-1"），由存储层的越界判据回 400。
		writeErr(c, upload.IndexParamError(rawIndex))
		return
	}
	body, berr := readChunkBody(c)
	if berr != nil {
		writeErr(c, berr)
		return
	}
	// 片序号越界 + 单片尺寸 + 增量累计三道闸门都在存储层（唯一归属），
	// 且全部发生在**写文件之前**（§4.2：单片超限 413 且不落盘）。
	sess, serr := h.uploads().Put(u.Username, id, index, body)
	if serr != nil {
		writeErr(c, serr)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"received":       sess.Received,
		"received_bytes": sess.ReceivedBytes(),
	})
}

// readChunkBody 读单片请求体（§4.2「先查头再读体」）。
//
// 三道，缺一不可：
//  1. **Content-Length 必须存在**（§4.2：每片必须带）—— 否则 411：服务端要靠它
//     在"读一个字节之前"决定收不收（chunked 上传没有这个信息）；
//  2. Content-Length 超限直接 413（不读体）；
//  3. 再套 `http.MaxBytesReader`：路由在 largeBodyRoutes 里被豁免了 1 MiB 中间件
//     （§4.2「白名单只是豁免」），这里是**唯一**的上限；chunked 路径也靠它兜底。
//
// 为什么先在内存里读满再交给存储层：§4.2 明写"超限且**不落盘**（不能先写后判）"。
// 代价是单片最多占 8 MiB 内存（有界、且远小于既有 base64 路径的 ≈118 MB 峰值）。
func readChunkBody(c *gin.Context) ([]byte, *apperr.Error) {
	cl := c.Request.ContentLength
	if cl < 0 {
		return nil, lengthRequiredErr()
	}
	if cl > limits.UploadChunkMaxBytes {
		return nil, upload.ChunkTooLargeError(cl, limits.UploadChunkMaxBytes)
	}
	if c.Request.Body == nil {
		return nil, apperr.New(apperr.CodeValidation, "请求体为空").
			WithHint("分片请求体就是该片的字节（Content-Type: application/octet-stream）")
	}
	limited := http.MaxBytesReader(c.Writer, c.Request.Body, limits.UploadChunkMaxBytes)
	data, rerr := io.ReadAll(io.LimitReader(limited, limits.UploadChunkMaxBytes+1))
	if rerr != nil {
		var mbe *http.MaxBytesError
		if errors.As(rerr, &mbe) {
			return nil, upload.ChunkTooLargeError(int64(len(data)), limits.UploadChunkMaxBytes)
		}
		// 读体失败 = 客户端中断（超时/断网）：这是**可恢复**的，而且重传的语义正好
		// 是"覆盖这一片"，所以 400 + 明确的重试指引，不报 500。
		return nil, apperr.New(apperr.CodeValidation, "读取分片请求体失败（上传被中断）").
			WithCause(rerr).
			WithHint("直接重传该片即可：同一序号是覆盖语义，重传不会产生重复片").
			WithHint("若反复中断，请减小 chunk_bytes（单片上限 " + humanBytes(limits.UploadChunkMaxBytes) + "）")
	}
	if int64(len(data)) > limits.UploadChunkMaxBytes {
		return nil, upload.ChunkTooLargeError(int64(len(data)), limits.UploadChunkMaxBytes)
	}
	return data, nil
}

// lengthRequiredErr 是"分片没带 Content-Length"（411 Length Required）。
//
// 用 CodeValidation + 显式 HTTP：apperr 的 code→status 表里没有 411，而 411 正是
// HTTP 为这件事准备的状态码（"Length Required"）——比笼统的 400 更能指路。
func lengthRequiredErr() *apperr.Error {
	e := apperr.New(apperr.CodeValidation, "分片请求必须带 Content-Length").
		WithDetail("max_chunk_bytes", int64(limits.UploadChunkMaxBytes)).
		WithHint("服务端要**先看头再决定收不收**（§4.2）：chunked 编码（没有 Content-Length）的上传一律拒").
		WithHint("整片一次性发送（不要分包/流式未知长度）：单片上限 " + humanBytes(limits.UploadChunkMaxBytes))
	e.HTTP = http.StatusLengthRequired
	return e
}

// ---------------------------------------------------------------------------
// GET /uploads/:upload_id：续传查询
// ---------------------------------------------------------------------------

func (h *Handlers) uploadStatus(c *gin.Context) {
	if err := h.requireCompiler(); err != nil {
		writeErr(c, err)
		return
	}
	u, aerr := h.currentUser(c)
	if aerr != nil {
		writeErr(c, aerr)
		return
	}
	id, ierr := h.uploadIDParam(c)
	if ierr != nil {
		writeErr(c, ierr)
		return
	}
	sess, oerr := h.uploads().Open(u.Username, id)
	if oerr != nil {
		writeErr(c, oerr)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"received":       sess.Received,
		"received_bytes": sess.ReceivedBytes(),
		"total_bytes":    sess.TotalBytes,
		"expires_at":     sess.ExpiresAt.UTC().Format(time.RFC3339),
	})
}

// ---------------------------------------------------------------------------
// POST /uploads/:upload_id/complete：拼装 + 发布
// ---------------------------------------------------------------------------

func (h *Handlers) uploadComplete(c *gin.Context) {
	if err := h.requireCompiler(); err != nil {
		writeErr(c, err)
		return
	}
	u, aerr := h.currentUser(c)
	if aerr != nil {
		writeErr(c, aerr)
		return
	}
	id, ierr := h.uploadIDParam(c)
	if ierr != nil {
		writeErr(c, ierr)
		return
	}
	// ---- 幂等重放（**决定**：重复 complete 回放首次的成功体）----
	//
	// 位置有意：在发布水位闸门与频率闸门之前。一次重放不编译、不落库、不占额度 ——
	// 让"平台此刻水位偏低"把一个**已经成功**的结果变成 503，只会逼客户端重传 32 MiB。
	//
	// 这是**无锁的快速路径**；"首次仍在进行中"的重复请求命中不了缓存（缓存要等首次
	// 结束才写），它由下面的 complete 租约回答（审计 FIX-45）。
	if body, ok := h.uploads().Completed(id, u.Username); ok {
		c.Data(http.StatusCreated, jsonContentType, body)
		return
	}
	// ---- complete 租约（审计 FIX-45）----
	//
	// 为什么闸门与请求体解析必须排在租约**之后**：租约是"同会话同时只有一次发布尝试"
	// 的临界区，锁内先判重放 ⇒ 同会话的第二个 complete 会**等待首次结束**然后拿到回放。
	// 若把闸门留在锁外，它会在缓存写入之前先撞上"同时 1 次编译"的并发位，得到 429
	// （审计实测形态：客户端丢了 201、150 ms 后重试 ⇒ 429 而不是逐字相同的 201）。
	//
	// 持租约期间同会话的 PUT 也会排队 —— 与既有语义一致（complete 与 PUT 互斥），
	// 只是临界区从"拼装 + 发布"扩到"整次请求"。
	lease, replay, lerr := h.uploads().BeginComplete(u.Username, id)
	if lerr != nil {
		writeErr(c, lerr)
		return
	}
	defer lease.Release() // 回放命中时是 no-op：无条件 defer，不会漏放锁
	if replay != nil {
		c.Data(http.StatusCreated, jsonContentType, replay)
		return
	}
	// complete 的 body 是**小 JSON**（title/changelog/config，§4.2：不豁免 1 MB 上限）。
	// 先查 Content-Length 再读体，并给一个**指向性**错误：把 wasm_base64 一起塞进来
	// 是这里最可能的误用，泛泛的"请求体过大"会让客户端不知道该怎么改。
	// 位置在发布闸门与频率闸门**之前**：形状错误不该消耗用户的小时额度。
	if c.Request.ContentLength > uploadCompleteBodyMaxBytes {
		writeErr(c, completeBodyTooLarge(c.Request.ContentLength))
		return
	}
	if rerr := h.publishGate(); rerr != nil {
		writeErr(c, rerr)
		return
	}
	// §4.3：complete 触发的发布**必须**仍受 Compiler.AllowUpload 约束
	// （每用户 30 次/小时 + 同时 1 次编译中）。这条是"分片不能绕过闸门"的落点：
	// 分片把一次上传拆成 N 次请求，但**只有 complete 会编译**，所以只有它计数。
	if after, rerr := h.acquireUpload(u); rerr != nil {
		writeErrWithRetry(c, rerr, after)
		return
	}
	defer h.opt.Compiler.ReleaseUpload(u.ID) // 失败路径也要释放并发占位

	p, berr := bindJSONLimited[uploadPayload](c, uploadCompleteBodyMaxBytes, "complete")
	if berr != nil {
		writeErr(c, berr)
		return
	}
	// 会话锁内：拼装 → 发布 → 成功删目录 / 失败保留（续传重试）。
	body, cerr := lease.Complete(
		func(wasm []byte, sess *upload.Session) ([]byte, *apperr.Error) {
			if xerr := checkCompletePayload(p, sess); xerr != nil {
				return nil, xerr
			}
			// app_id / version **取会话元数据**（不是请求体）：会话在创建时就绑定了
			// (app_id, version, publisher)，让 complete 再带一份 app_id 只会多出一个
			// 可能与元数据不一致的自由度 —— "用 A 的会话发布 B" 的正确防法是只有一个
			// 权威来源，而不是要求两个来源一致。
			return h.publishFromBytes(c, u, publishInput{
				appID:     sess.AppID,
				version:   sess.Version,
				title:     p.Title,
				changelog: p.Changelog,
				config:    p.Config,
				// 制品配额预检：会话声明的确切体积（比 base64 路径的 4/3 估算更准）。
				sizeHint: sess.TotalBytes,
				wasm:     func() ([]byte, *apperr.Error) { return wasm, nil },
			})
		})
	if cerr != nil {
		writeErr(c, cerr)
		return
	}
	c.Data(http.StatusCreated, jsonContentType, body)
}

// completeBodyTooLarge 是 complete 体的 413（**有指向性**：最可能的误用是把
// wasm_base64 一起塞进来，而分片上传的全部意义就是不要它）。
func completeBodyTooLarge(got int64) *apperr.Error {
	return apperr.Newf(apperr.CodeBodyTooLarge,
		"complete 的请求体 %s 超过上限 %s", humanBytes(got), humanBytes(uploadCompleteBodyMaxBytes)).
		WithDetail("content_length", got).
		WithDetail("max_body_bytes", uploadCompleteBodyMaxBytes).
		WithDetail("kind", "complete").
		WithHint("complete 的 body 只带 title/changelog/config（与 publish 的小体部分同构）：" +
			"**不要**带 wasm_base64 —— 模块字节来自已上传的分片").
		WithHint("config 本身另有 " + humanBytes(limits.AppConfigMaxBytes) + " 上限")
}

// createBindError 把开会话的 413 换成**这条端点自己的**文案（审计 FIX-46；其余错误原样透出）。
//
// 为什么不能复用通用 bodyTooLarge：那段 hints 讲的是"base64 直传的 4/3 膨胀"
// （`请求体上限 4.0 KiB 对应约 3.0 KiB 的 .wasm`）—— 对 `POST /uploads` 而言这是**完全
// 错误的方向**：开会话的 body 只是四个短字段，与模块体积无关。§8 明写错误响应的第一
// 消费者是 AI，一条把人引向"压缩 wasm"的提示会制造真实的排查浪费（对照：complete 有
// 自己的 completeBodyTooLarge，缺的只是开会话这一份）。
func createBindError(berr *apperr.Error, contentLength int64) *apperr.Error {
	if berr == nil || berr.Code != apperr.CodeBodyTooLarge {
		return berr
	}
	got := contentLength
	if v, ok := berr.Details["content_length"].(int64); ok && got <= 0 {
		// chunked（无 Content-Length）时通用错误里存的是 -1：不要把它当体积回显。
		got = v
	}
	return createBodyTooLarge(got)
}

// createBodyTooLarge 是 POST /uploads 的 413（**这条端点自己的**文案）。
func createBodyTooLarge(got int64) *apperr.Error {
	e := apperr.New(apperr.CodeBodyTooLarge,
		"开会话的请求体超过上限 "+humanBytes(uploadCreateBodyMaxBytes)).
		WithDetail("max_body_bytes", uploadCreateBodyMaxBytes).
		WithDetail("kind", "uploads").
		WithDetail("fields", []string{"app_id", "version", "total_bytes", "chunk_bytes"}).
		WithHint("POST /uploads 只负责开会话：body 是 app_id/version/total_bytes/chunk_bytes " +
			"四个短字段的 JSON，**不要**在开会话时带模块字节").
		WithHint("要传模块：POST /uploads 换 upload_id ⇒ " +
			"PUT /uploads/:upload_id/chunks/:index 逐片上传（每片 ≤ " +
			humanBytes(limits.UploadChunkMaxBytes) + "）⇒ POST /uploads/:upload_id/complete")
	if got > 0 {
		e.Message = "开会话的请求体 " + humanBytes(got) + " 超过上限 " +
			humanBytes(uploadCreateBodyMaxBytes) + "（body 只有四个短字段）"
		e.WithDetail("content_length", got)
	}
	return e
}

// checkCompletePayload 校验 complete 的请求体与**会话元数据**是否一致。
//
// 三个字段三种处理，都是"宁可报错也不静默"：
//   - `wasm_base64` 出现即拒：模块字节来自分片，静默忽略会让客户端以为它传的字节被用了；
//   - `app_id` / `version` 给了就必须与会话逐字一致（防呆）：**不**用它们覆盖会话值，
//     否则"用 A 的会话发布 B"只需要在 complete 时改一个字符串；
//   - `title` / `changelog` / `config` 正常参与发布（与 publish 同构）。
func checkCompletePayload(p uploadPayload, sess *upload.Session) *apperr.Error {
	if strings.TrimSpace(p.WasmBase64) != "" {
		return apperr.New(apperr.CodeValidation, "complete 不接受 wasm_base64").
			WithDetail("field", "wasm_base64").
			WithHint("模块字节来自已上传的分片（这正是分片上传的意义）：去掉该字段，" +
				"或改用 POST /apps/wasm/:app_id/releases 一次性直传")
	}
	if v := strings.TrimSpace(p.AppID); v != "" && v != sess.AppID {
		return apperr.New(apperr.CodeValidation, "请求体中的 app_id 与会话不一致").
			WithDetail("body_app_id", v).
			WithDetail("session_app_id", sess.AppID).
			WithHint("app_id 在开会话时定死（会话是唯一权威来源）：这里只做防呆校验")
	}
	if v := releaseVersion(p.Version); v != "" && v != sess.Version {
		return apperr.New(apperr.CodeValidation, "请求体中的 version 与会话不一致").
			WithDetail("body_version", v).
			WithDetail("session_version", sess.Version).
			WithHint("改版本号 = 重新开会话（版本号与会话一起定死，防止「用 A 的会话发布 B」）")
	}
	return nil
}

// ---------------------------------------------------------------------------
// DELETE /uploads/:upload_id：主动放弃
// ---------------------------------------------------------------------------

func (h *Handlers) uploadAbort(c *gin.Context) {
	if err := h.requireCompiler(); err != nil {
		writeErr(c, err)
		return
	}
	u, aerr := h.currentUser(c)
	if aerr != nil {
		writeErr(c, aerr)
		return
	}
	id, ierr := h.uploadIDParam(c)
	if ierr != nil {
		writeErr(c, ierr)
		return
	}
	if derr := h.uploads().Discard(u.Username, id); derr != nil {
		writeErr(c, derr)
		return
	}
	// 200 + JSON（§7.0：API 响应一律 JSON 信封；204 无 body 不符合本仓契约）。
	c.JSON(http.StatusOK, gin.H{"upload_id": id, "deleted": true})
}

// ---------------------------------------------------------------------------
// 共用
// ---------------------------------------------------------------------------

// uploadIDParam 取并校验路径里的 upload_id。
//
// 这是**路径穿越的第一道闸**（§4.2）：upload_id 会直接成为 `<DataRoot>/apps/_uploads/`
// 下的目录名，所以必须"先校验、后拼接"。形态不合法一律回 **404**（不是 400）——
// 它不可能对应任何会话，用与"不存在"完全相同的响应避免变成一个可探测的差异面。
func (h *Handlers) uploadIDParam(c *gin.Context) (string, *apperr.Error) {
	id := strings.TrimSpace(c.Param("upload_id"))
	if !upload.ValidID(id) {
		return "", upload.NotFoundError()
	}
	return id, nil
}

// 编译期断言：Store 必须满足 Cleaner（cmd/server 的调度器接线依赖它）。
var _ upload.Cleaner = (*upload.Store)(nil)
