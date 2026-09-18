package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/upload"
)

// 本文件是 §4.2 分片上传面的**端到端**用例：真 PG + 真编译器 + 真文件系统 +
// 生产路径的 HTTP 路由树（夹具复用 helpers_test.go 的 newTestEnv）。
//
// 变异方式（把闸门改回危险值，本文件哪条用例会红 —— 全部**已实测**，见交付说明）：
//   - complete 不走 publishFromBytes（自己复制一份发布逻辑）⇒
//     TestUploadFlowEqualsOneShotPublish 红（必须与一次性 publish 逐字段等价）；
//   - complete 不 acquireUpload（或把 ReleaseUpload 从 defer 里挪出去）⇒
//     TestUploadCompleteStillUsesUploadRateGate 红（实测：正是这一条）；
//   - 重复 complete 重新发布（不做幂等重放）⇒ TestUploadCompleteIsIdempotent 红
//     （第二次会 409 NAME_TAKEN「版本已存在」而不是回放 201）；
//   - complete 成功后不删会话目录 ⇒ TestUploadCompleteFailureKeepsSession 红；
//   - 失败时也删会话 ⇒ 同一条用例的另一半红；
//   - 去掉跨用户判据（upload_id 只按 id 查）⇒ TestUploadCrossUserIs404 红；
//   - 把"先查 Content-Length"删掉（先读体再判）⇒ TestUploadChunkErrors 的
//     411（无 CL）与"磁盘上不得出现该片"断言红；
//   - 去掉开会话的每用户会话数闸门 ⇒ TestUploadSessionsPerUserLimit 红。
//
// 一条**实测的负面结论**（写下来避免误判）：单独删掉 api 层的 hex 形态闸
// （uploadIDParam 的 ValidID）本文件仍然全绿 —— 存储层 dirChecked 是同一判据的
// 第二道。真正的穿越证明在存储层：upload.TestPathTraversalCannotEscapeRoot。

// ---------------------------------------------------------------------------
// 路由与请求夹具
// ---------------------------------------------------------------------------

// mountUploads 把分片上传的 5 条端点挂到测试路由树上（**生产路径**）。
//
// 与 helpers_test.go 的 mount 同一个理由：测试树必须与生产树同前缀，否则测不出
// 路径不匹配（本仓 2026-08-30 的既有教训）。
func (e *testEnv) mountUploads() {
	cli := e.r.Group("/api/client/v2/apps/wasm", serverauth.BearerAuth(e.db))
	cli.POST("/uploads", e.h.UploadCreate)
	cli.PUT("/uploads/:upload_id/chunks/:index", e.h.UploadChunk)
	cli.GET("/uploads/:upload_id", e.h.UploadStatus)
	cli.POST("/uploads/:upload_id/complete", e.h.UploadComplete)
	cli.DELETE("/uploads/:upload_id", e.h.UploadAbort)
}

// newUploadEnv 装配带分片上传端点的测试环境。
func newUploadEnv(t *testing.T, mutators ...func(*Options)) *testEnv {
	t.Helper()
	env := newTestEnv(t, mutators...)
	env.mountUploads()
	return env
}

// rawReq 发一个**原始字节**请求（分片体不是 JSON）。
//
// unknownLen=true 时让 httptest 把 ContentLength 置为 -1（模拟 chunked：没有
// Content-Length），用来验证 §4.2「每片必须带 Content-Length」那条闸门。
func (e *testEnv) rawReq(method, path, token string, body []byte, unknownLen bool) *httptest.ResponseRecorder {
	e.t.Helper()
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	if unknownLen && reader != nil {
		reader = struct{ io.Reader }{reader}
	}
	req := httptest.NewRequest(method, path, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/octet-stream")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	e.r.ServeHTTP(w, req)
	return w
}

type uploadCreated struct {
	UploadID   string `json:"upload_id"`
	Received   []int  `json:"received"`
	ChunkBytes int64  `json:"chunk_bytes"`
	ExpiresAt  string `json:"expires_at"`
}

type uploadStatusOut struct {
	Received      []int  `json:"received"`
	ReceivedBytes int64  `json:"received_bytes"`
	TotalBytes    int64  `json:"total_bytes"`
	ExpiresAt     string `json:"expires_at"`
}

type uploadChunkOut struct {
	Received      []int `json:"received"`
	ReceivedBytes int64 `json:"received_bytes"`
}

// createUpload 开会话并断言 201。
func (e *testEnv) createUpload(token, appID, version string, total, chunk int64) uploadCreated {
	e.t.Helper()
	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/uploads", token, map[string]any{
		"app_id": appID, "version": version, "total_bytes": total, "chunk_bytes": chunk,
	})
	if w.Code != http.StatusCreated {
		e.t.Fatalf("开会话失败: %d %s", w.Code, w.Body.String())
	}
	var out uploadCreated
	e.decodeJSON(w, http.StatusCreated, &out)
	if out.UploadID == "" || out.ChunkBytes != chunk {
		e.t.Fatalf("开会话响应不完整: %s", w.Body.String())
	}
	if out.Received == nil {
		e.t.Fatalf("received 必须是数组（不能是 null）: %s", w.Body.String())
	}
	return out
}

// putChunk 上传一片并断言 200。
func (e *testEnv) putChunk(token, id string, index int, body []byte) uploadChunkOut {
	e.t.Helper()
	w := e.rawReq(http.MethodPut, uploadChunkPath(id, index), token, body, false)
	if w.Code != http.StatusOK {
		e.t.Fatalf("上传第 %d 片失败: %d %s", index, w.Code, w.Body.String())
	}
	var out uploadChunkOut
	e.decodeJSON(w, http.StatusOK, &out)
	return out
}

func uploadChunkPath(id string, index int) string {
	return "/api/client/v2/apps/wasm/uploads/" + id + "/chunks/" + strconv.Itoa(index)
}

func uploadPath(id string) string   { return "/api/client/v2/apps/wasm/uploads/" + id }
func completePath(id string) string { return uploadPath(id) + "/complete" }

// completeBody 是 complete 的请求体（与 publish 同构但不含 wasm_base64/app_id/version）。
func completeBody(title string, cfg map[string]any) map[string]any {
	return map[string]any{"title": title, "changelog": "首版", "config": cfg}
}

// chunkPlan 按 chunkBytes 切分载荷（最后一片是余数）。
func chunkPlan(payload []byte, chunk int64) [][]byte {
	var out [][]byte
	for off := 0; off < len(payload); off += int(chunk) {
		end := off + int(chunk)
		if end > len(payload) {
			end = len(payload)
		}
		out = append(out, payload[off:end])
	}
	return out
}

// planThree 返回"恰好 3 片"的切分（片大小不低于单片下限）。
func planThree(t *testing.T, wasm []byte) (int64, [][]byte) {
	t.Helper()
	chunk := int64((len(wasm) + 2) / 3)
	if chunk < limits.UploadChunkMinBytes {
		t.Fatalf("夹具过小（%d 字节）：无法切成 3 片且每片 ≥ %d 字节",
			len(wasm), int64(limits.UploadChunkMinBytes))
	}
	parts := chunkPlan(wasm, chunk)
	if len(parts) != 3 {
		t.Fatalf("切分结果 = %d 片, want 3（chunk=%d total=%d）", len(parts), chunk, len(wasm))
	}
	return chunk, parts
}

// uploadRoot 返回测试环境的会话根目录（磁盘断言用）。
func (e *testEnv) uploadRoot() string {
	return filepath.Join(e.dataRoot, limits.AppsDirName, upload.DirName)
}

func (e *testEnv) sessionDir(id string) string { return filepath.Join(e.uploadRoot(), id) }

// ---------------------------------------------------------------------------
// 1. 全链路：与一次性 publish 等价
// ---------------------------------------------------------------------------

func TestUploadFlowEqualsOneShotPublish(t *testing.T) {
	env := newUploadEnv(t)
	wasm := testGuestModule(t)
	chunk, parts := planThree(t, wasm)
	cfg := goodConfig()

	// ---- 分片路径：3 片 + complete ----
	sess := env.createUpload(env.tokens["alice"], "split-app", "1.0.0", int64(len(wasm)), chunk)
	for i, part := range parts {
		out := env.putChunk(env.tokens["alice"], sess.UploadID, i, part)
		if len(out.Received) != i+1 {
			t.Fatalf("第 %d 片之后 received = %v, want 前 %d 个", i, out.Received, i+1)
		}
	}
	// 续传查询：三片都在、字节数正确、total_bytes 回显。
	w := env.req(http.MethodGet, uploadPath(sess.UploadID), env.tokens["alice"], nil)
	var st uploadStatusOut
	env.decodeJSON(w, http.StatusOK, &st)
	if len(st.Received) != 3 || st.ReceivedBytes != int64(len(wasm)) || st.TotalBytes != int64(len(wasm)) {
		t.Fatalf("续传查询结果不对: %+v", st)
	}
	w = env.req(http.MethodPost, completePath(sess.UploadID), env.tokens["alice"], completeBody("分片应用", cfg))
	if w.Code != http.StatusCreated {
		t.Fatalf("complete 失败: %d %s", w.Code, w.Body.String())
	}
	var split struct {
		App     map[string]any `json:"app"`
		Release map[string]any `json:"release"`
	}
	env.decodeJSON(w, http.StatusCreated, &split)

	// ---- 一次性路径：同样的字节、不同的应用 ----
	oneShot := env.publishOK(env.tokens["alice"], "oneshot-app", "1.0.0", wasm, cfg)

	// 等价判据（§4.2：分片只是把一次 POST 拆成 N+1 次请求，发布语义必须逐字段相同）。
	for _, key := range []string{"checksum", "size", "status", "current", "assets", "ignored_sections"} {
		if got, want := split.Release[key], oneShot[key]; !jsonEqual(got, want) {
			t.Errorf("release.%s: 分片路径 %v != 一次性 %v", key, got, want)
		}
	}
	// 真落库：版本行存在，且是当前生效版本。
	hist, err := serverstore.ListWasmReleases(context.Background(), env.db, "split-app", true)
	if err != nil || len(hist) != 1 {
		t.Fatalf("版本行数 = %d (err=%v), want 1", len(hist), err)
	}
	if hist[0].Checksum != oneShot["checksum"] || hist[0].Size != int64(len(wasm)) {
		t.Fatalf("落库的 checksum/size 与一次性发布不一致: %+v", hist[0])
	}
	if hist[0].Publisher != "alice" {
		t.Fatalf("publisher = %q, want alice（身份必须来自登录态）", hist[0].Publisher)
	}
	app, err := serverstore.GetWasmApp(context.Background(), env.db, "split-app")
	if err != nil || app.CurrentReleaseID != hist[0].ID {
		t.Fatalf("current_release_id 未指向新版本: app=%+v err=%v", app, err)
	}
	// 真落盘：资源目录与宿主写的应用配置文件都在。
	assetsDir := filepath.Join(env.dataRoot, limits.AppsDirName, "split-app", "assets", strconv.FormatInt(hist[0].ID, 10))
	if _, serr := os.Stat(filepath.Join(assetsDir, limits.AppConfigFileName)); serr != nil {
		t.Fatalf("发布产物 %s 不存在: %v", limits.AppConfigFileName, serr)
	}
	// 审计：应用级动作留痕（与一次性发布同一条动作名）。
	if actions := env.auditActions("split-app"); !containsStr(actions, "wasm_app_release") {
		t.Fatalf("缺少 wasm_app_release 审计: %v", actions)
	}
	// 成功 ⇒ 会话目录立即删除（§4.2 磁盘不驻留）。
	if _, serr := os.Stat(env.sessionDir(sess.UploadID)); !os.IsNotExist(serr) {
		t.Fatalf("complete 成功后会话目录仍在: %v", serr)
	}
}

func jsonEqual(a, b any) bool {
	ra, _ := json.Marshal(a)
	rb, _ := json.Marshal(b)
	return bytes.Equal(ra, rb)
}

func containsStr(in []string, want string) bool {
	for _, v := range in {
		if v == want {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// 2. 断线续传 / 乱序 / 幂等 PUT
// ---------------------------------------------------------------------------

func TestUploadResumeAfterInterruption(t *testing.T) {
	env := newUploadEnv(t)
	wasm := testGuestModule(t)
	chunk, parts := planThree(t, wasm)

	sess := env.createUpload(env.tokens["alice"], "resume-app", "1.0.0", int64(len(wasm)), chunk)
	// 只传第 0 片（模拟断在第 2 片：第 0 片成功、后续失败）。
	env.putChunk(env.tokens["alice"], sess.UploadID, 0, parts[0])

	// 客户端重连后先查询：只该看到 [0]。
	w := env.req(http.MethodGet, uploadPath(sess.UploadID), env.tokens["alice"], nil)
	var st uploadStatusOut
	env.decodeJSON(w, http.StatusOK, &st)
	if len(st.Received) != 1 || st.Received[0] != 0 {
		t.Fatalf("断线后 received = %v, want [0]", st.Received)
	}
	if !strings.Contains(st.ExpiresAt, "T") {
		t.Fatalf("expires_at 不是 RFC3339: %q", st.ExpiresAt)
	}
	// 乱序补缺失的片（先 2 再 1），然后 complete。
	env.putChunk(env.tokens["alice"], sess.UploadID, 2, parts[2])
	env.putChunk(env.tokens["alice"], sess.UploadID, 1, parts[1])
	w = env.req(http.MethodPost, completePath(sess.UploadID), env.tokens["alice"], completeBody("续传应用", goodConfig()))
	if w.Code != http.StatusCreated {
		t.Fatalf("续传后 complete 失败: %d %s", w.Code, w.Body.String())
	}
	// 拼装顺序对：与一次性发布的 checksum 一致。
	oneShot := env.publishOK(env.tokens["alice"], "resume-ref", "1.0.0", wasm, goodConfig())
	var out struct {
		Release map[string]any `json:"release"`
	}
	env.decodeJSON(w, http.StatusCreated, &out)
	if out.Release["checksum"] != oneShot["checksum"] {
		t.Fatalf("乱序上传拼出来的 checksum 不一致: %v != %v", out.Release["checksum"], oneShot["checksum"])
	}
}

func TestUploadChunkPutIsIdempotent(t *testing.T) {
	env := newUploadEnv(t)
	wasm := testGuestModule(t)
	chunk, parts := planThree(t, wasm)
	token := env.tokens["alice"]

	sess := env.createUpload(token, "idem-app", "1.0.0", int64(len(wasm)), chunk)
	// 先落一片**长度对、内容错**的第 1 片（PUT 只判尺寸，不判内容）。
	junk := append([]byte{}, parts[1]...)
	junk[len(junk)-1] ^= 0xff
	env.putChunk(token, sess.UploadID, 1, junk)
	// 再按同一序号覆盖成正确字节：received 不重复计数（幂等）。
	out := env.putChunk(token, sess.UploadID, 1, parts[1])
	if len(out.Received) != 1 || out.Received[0] != 1 {
		t.Fatalf("重复 PUT 后 received = %v, want [1]", out.Received)
	}
	if out.ReceivedBytes != int64(len(parts[1])) {
		t.Fatalf("重复 PUT 后 received_bytes = %d, want %d", out.ReceivedBytes, len(parts[1]))
	}
	for _, i := range []int{0, 2} {
		env.putChunk(token, sess.UploadID, i, parts[i])
	}
	w := env.req(http.MethodPost, completePath(sess.UploadID), token, completeBody("覆盖应用", goodConfig()))
	if w.Code != http.StatusCreated {
		t.Fatalf("complete 失败: %d %s", w.Code, w.Body.String())
	}
	// 覆盖必须真的生效：拼出来的是**覆盖后**的载荷 ⇒ checksum 与一次性发布逐字相同。
	// （若 PUT 没覆盖，拼装出的会是那段损坏字节：轻则编译失败，重则 checksum 不符。）
	ref := env.publishOK(token, "idem-ref", "1.0.0", wasm, goodConfig())
	var out2 struct {
		Release map[string]any `json:"release"`
	}
	env.decodeJSON(w, http.StatusCreated, &out2)
	if out2.Release["checksum"] != ref["checksum"] {
		t.Fatalf("覆盖未生效：checksum %v != %v", out2.Release["checksum"], ref["checksum"])
	}
}

// ---------------------------------------------------------------------------
// 3. 分片闸门：过小/过大/越界/无 CL/空片/总量不符
// ---------------------------------------------------------------------------

func TestUploadChunkErrors(t *testing.T) {
	env := newUploadEnv(t)
	wasm := testGuestModule(t)
	chunk, parts := planThree(t, wasm)
	sess := env.createUpload(env.tokens["alice"], "errs-app", "1.0.0", int64(len(wasm)), chunk)
	token := env.tokens["alice"]

	// 非尾片过小（< UploadChunkMinBytes）⇒ 400。
	w := env.rawReq(http.MethodPut, uploadChunkPath(sess.UploadID, 0), token,
		make([]byte, limits.UploadChunkMinBytes-1), false)
	eb := env.decodeErr(w, http.StatusBadRequest)
	if eb.Error.Code != string(apperr.CodeValidation) {
		t.Errorf("过小片的 code = %s, want VALIDATION", eb.Error.Code)
	}
	// 空片 ⇒ 400。
	w = env.rawReq(http.MethodPut, uploadChunkPath(sess.UploadID, 0), token, []byte{}, false)
	env.decodeErr(w, http.StatusBadRequest)
	// 序号越界（负数 / 等于片数 / 极大值）⇒ 400。
	for _, index := range []string{"-1", "3", "999999999999999999999"} {
		w = env.rawReq(http.MethodPut, "/api/client/v2/apps/wasm/uploads/"+sess.UploadID+"/chunks/"+index,
			token, parts[0], false)
		env.decodeErr(w, http.StatusBadRequest)
	}
	// 无 Content-Length（chunked）⇒ 411 Length Required（§4.2：每片必须带）。
	w = env.rawReq(http.MethodPut, uploadChunkPath(sess.UploadID, 0), token, parts[0], true)
	eb = env.decodeErr(w, http.StatusLengthRequired)
	if eb.Error.Code != string(apperr.CodeValidation) {
		t.Errorf("无 CL 的 code = %s, want VALIDATION", eb.Error.Code)
	}
	// 单片超限 ⇒ 413，且**不落盘**（§4.2：先查头再读体）。
	w = env.rawReq(http.MethodPut, uploadChunkPath(sess.UploadID, 0), token,
		make([]byte, limits.UploadChunkMaxBytes+1), false)
	eb = env.decodeErr(w, http.StatusRequestEntityTooLarge)
	if eb.Error.Code != string(apperr.CodeBodyTooLarge) {
		t.Errorf("超限片的 code = %s, want BODY_TOO_LARGE", eb.Error.Code)
	}
	if _, serr := os.Stat(filepath.Join(env.sessionDir(sess.UploadID), "chunk-0")); !os.IsNotExist(serr) {
		t.Fatalf("超限的片落了盘: %v", serr)
	}
	// 增量超总量：第 0 片整片 + 第 1 片整片 + 一个把总量顶穿的尾片 ⇒ 400。
	env.putChunk(token, sess.UploadID, 0, parts[0])
	env.putChunk(token, sess.UploadID, 1, parts[1])
	w = env.rawReq(http.MethodPut, uploadChunkPath(sess.UploadID, 2), token,
		append(append([]byte{}, parts[2]...), 0), false)
	env.decodeErr(w, http.StatusBadRequest)
	if _, serr := os.Stat(filepath.Join(env.sessionDir(sess.UploadID), "chunk-2")); !os.IsNotExist(serr) {
		t.Fatalf("超总量的片落了盘: %v", serr)
	}
	// 会话状态未被上面任何一次失败污染（只有 0/1 两片）。
	st := env.status(token, sess.UploadID)
	if len(st.Received) != 2 || st.ReceivedBytes != int64(len(parts[0])+len(parts[1])) {
		t.Fatalf("失败请求污染了会话状态: %+v", st)
	}
}

func TestUploadCompleteMissingChunksAndTotalMismatch(t *testing.T) {
	env := newUploadEnv(t)
	wasm := testGuestModule(t)
	chunk, parts := planThree(t, wasm)
	token := env.tokens["alice"]

	// 缺片 ⇒ 400 + 会话保留（可续传）。
	sess := env.createUpload(token, "gap-app", "1.0.0", int64(len(wasm)), chunk)
	env.putChunk(token, sess.UploadID, 0, parts[0])
	w := env.req(http.MethodPost, completePath(sess.UploadID), token, completeBody("缺口应用", goodConfig()))
	eb := env.decodeErr(w, http.StatusBadRequest)
	if eb.Error.Details["missing_chunks"] == nil {
		t.Errorf("缺片错误必须带 missing_chunks: %s", w.Body.String())
	}
	if _, serr := os.Stat(env.sessionDir(sess.UploadID)); serr != nil {
		t.Fatalf("缺片时应保留会话: %v", serr)
	}
	if n := env.countReleases("gap-app"); n != 0 {
		t.Fatalf("缺片不得落版本行: %d", n)
	}

	// 各片之和 ≠ total_bytes ⇒ 400（片齐了但总量对不上）。
	//
	// ⚠️ 片大小必须按**声明的总量**重算，不能沿用 `planThree` 给原尺寸算出来的那个：
	// 服务端按 `ceil(total_bytes / chunk_bytes)` 推导期望片数，而 `len(wasm)+1` 在
	// `len(wasm)` 恰好能被 3 整除时会把它顶成 **4** ⇒ 服务端先报"还有 1 片没有收到"，
	// 这条断言就变成看编译产物字节数的掷骰子（CI 实测红过，本地因为尺寸不同而绿）。
	// 取 `ceil(total/3)` 保证期望片数恒为 3，且三片之和 = len(wasm) ≠ total ⇒ 稳定命中"总量不符"。
	mismatchTotal := int64(len(wasm)) + 1
	mismatchChunk := (mismatchTotal + 2) / 3
	if got := (mismatchTotal + mismatchChunk - 1) / mismatchChunk; got != 3 {
		t.Fatalf("夹具不自洽：服务端会推导出 %d 片（want 3，total=%d chunk=%d）", got, mismatchTotal, mismatchChunk)
	}
	mismatch := env.createUpload(token, "mismatch-app", "1.0.0", mismatchTotal, mismatchChunk)
	env.putChunk(token, mismatch.UploadID, 0, parts[0])
	env.putChunk(token, mismatch.UploadID, 1, parts[1])
	env.putChunk(token, mismatch.UploadID, 2, parts[2])
	w = env.req(http.MethodPost, completePath(mismatch.UploadID), token, completeBody("错量应用", goodConfig()))
	eb = env.decodeErr(w, http.StatusBadRequest)
	if eb.Error.Details["diff_bytes"] == nil {
		t.Errorf("总量不符必须带 diff_bytes: %s", w.Body.String())
	}
	if n := env.countReleases("mismatch-app"); n != 0 {
		t.Fatalf("总量不符不得落版本行: %d", n)
	}
}

// ---------------------------------------------------------------------------
// 4. 安全：跨用户 / 不存在 / 穿越 / 归属
// ---------------------------------------------------------------------------

func TestUploadCrossUserIs404(t *testing.T) {
	env := newUploadEnv(t)
	wasm := testGuestModule(t)
	chunk, parts := planThree(t, wasm)
	alice, bob := env.tokens["alice"], env.tokens["bob"]

	sess := env.createUpload(alice, "priv-app", "1.0.0", int64(len(wasm)), chunk)
	env.putChunk(alice, sess.UploadID, 0, parts[0])

	// 不存在的 id（形态合法）与别人的 id：**响应体必须逐字相同**。
	unknown := strings.Repeat("0123456789abcdef", 4)
	if unknown == sess.UploadID {
		unknown = strings.Repeat("fedcba9876543210", 4)
	}
	other := env.req(http.MethodGet, uploadPath(sess.UploadID), bob, nil)
	ghost := env.req(http.MethodGet, uploadPath(unknown), bob, nil)
	if other.Code != http.StatusNotFound || ghost.Code != http.StatusNotFound {
		t.Fatalf("跨用户/不存在必须 404: other=%d ghost=%d", other.Code, ghost.Code)
	}
	if other.Body.String() != ghost.Body.String() {
		t.Fatalf("跨用户与不存在的响应体不同（可探测存在性）:\n other=%s\n ghost=%s",
			other.Body.String(), ghost.Body.String())
	}
	// 跨用户的 PUT / complete / DELETE 一律 404，且不得动到别人的会话。
	if w := env.rawReq(http.MethodPut, uploadChunkPath(sess.UploadID, 1), bob, parts[1], false); w.Code != http.StatusNotFound {
		t.Errorf("跨用户 PUT = %d, want 404", w.Code)
	}
	if w := env.req(http.MethodPost, completePath(sess.UploadID), bob, completeBody("偷梁换柱", goodConfig())); w.Code != http.StatusNotFound {
		t.Errorf("跨用户 complete = %d, want 404", w.Code)
	}
	if w := env.req(http.MethodDelete, uploadPath(sess.UploadID), bob, nil); w.Code != http.StatusNotFound {
		t.Errorf("跨用户 DELETE = %d, want 404", w.Code)
	}
	if _, serr := os.Stat(env.sessionDir(sess.UploadID)); serr != nil {
		t.Fatalf("跨用户访问动到了会话目录: %v", serr)
	}
	// 发起者本人仍然可用（没有被所谓"保护"误伤）。
	if st := env.status(alice, sess.UploadID); len(st.Received) != 1 {
		t.Fatalf("发起者本人查询失败: %+v", st)
	}
	// 别人的 404 不得让发起者的 complete 失败：补齐后正常发布。
	env.putChunk(alice, sess.UploadID, 1, parts[1])
	env.putChunk(alice, sess.UploadID, 2, parts[2])
	if w := env.req(http.MethodPost, completePath(sess.UploadID), alice, completeBody("私有应用", goodConfig())); w.Code != http.StatusCreated {
		t.Fatalf("发起者 complete 失败: %d %s", w.Code, w.Body.String())
	}
}

func TestUploadBadIDIs404(t *testing.T) {
	env := newUploadEnv(t)
	token := env.tokens["alice"]
	bad := []string{
		"..", "../../etc/passwd", "abc", strings.Repeat("a", 63), strings.Repeat("a", 65),
		strings.Repeat("A", 64), strings.Repeat("z", 64), strings.Repeat("a", 62) + "%2e",
	}
	for _, id := range bad {
		if w := env.req(http.MethodGet, uploadPath(id), token, nil); w.Code != http.StatusNotFound {
			t.Errorf("GET %q = %d, want 404", id, w.Code)
		}
		if w := env.rawReq(http.MethodPut, "/api/client/v2/apps/wasm/uploads/"+id+"/chunks/0", token,
			[]byte("x"), false); w.Code != http.StatusNotFound {
			t.Errorf("PUT %q = %d, want 404", id, w.Code)
		}
		if w := env.req(http.MethodDelete, uploadPath(id), token, nil); w.Code != http.StatusNotFound {
			t.Errorf("DELETE %q = %d, want 404", id, w.Code)
		}
		if w := env.req(http.MethodPost, completePath(id), token, completeBody("x", goodConfig())); w.Code != http.StatusNotFound {
			t.Errorf("POST complete %q = %d, want 404", id, w.Code)
		}
	}
	// 会话根之外不得出现任何文件（穿越失败的直接判据）。
	entries, err := os.ReadDir(filepath.Dir(filepath.Dir(env.uploadRoot()))) // apps/_uploads → apps
	if err != nil {
		t.Fatalf("读会话根失败: %v", err)
	}
	for _, e := range entries {
		if e.Name() != upload.DirName {
			t.Fatalf("apps/ 下出现了意外目录: %s", e.Name())
		}
	}
}

// TestUploadCannotPublishOthersApp 证明分片路径**复用**了发布链路的归属检查：
// 用自己开的会话提交别人应用的新版本，仍然被拒（不是"换个入口就能绕过"）。
func TestUploadCannotPublishOthersApp(t *testing.T) {
	env := newUploadEnv(t)
	wasm := testGuestModule(t)
	chunk, parts := planThree(t, wasm)
	// alice 先占地。
	env.publishOK(env.tokens["alice"], "taken-app", "1.0.0", wasm, goodConfig())

	// bob 开自己的会话、传自己的片，但 app_id 指向 alice 的应用。
	sess := env.createUpload(env.tokens["bob"], "taken-app", "2.0.0", int64(len(wasm)), chunk)
	for i, part := range parts {
		env.putChunk(env.tokens["bob"], sess.UploadID, i, part)
	}
	w := env.req(http.MethodPost, completePath(sess.UploadID), env.tokens["bob"], completeBody("我要接管", goodConfig()))
	eb := env.decodeErr(w, http.StatusConflict)
	if eb.Error.Code != string(apperr.CodeNameTaken) {
		t.Fatalf("越权发布的 code = %s, want NAME_TAKEN", eb.Error.Code)
	}
	if n := env.countReleases("taken-app"); n != 1 {
		t.Fatalf("越权发布落了版本行: %d", n)
	}
	// 失败保留会话（bob 可以换个 app_id 重新开会话；这个会话本身没被污染）。
	if _, serr := os.Stat(env.sessionDir(sess.UploadID)); serr != nil {
		t.Fatalf("失败时不该删会话: %v", serr)
	}
}

// ---------------------------------------------------------------------------
// 5. 过期与回收（注入时钟）
// ---------------------------------------------------------------------------

func TestUploadExpiredSessionIs404AndReclaimed(t *testing.T) {
	var clockMs atomic.Int64
	clockMs.Store(time.Now().UnixMilli())
	env := newUploadEnv(t, func(o *Options) {
		o.Now = func() time.Time { return time.UnixMilli(clockMs.Load()).UTC() }
	})
	wasm := testGuestModule(t)
	chunk, parts := planThree(t, wasm)
	token := env.tokens["alice"]

	sess := env.createUpload(token, "ttl-app", "1.0.0", int64(len(wasm)), chunk)
	env.putChunk(token, sess.UploadID, 0, parts[0])

	// 拨过 TTL：查询、补片、complete 一律 404，且目录被惰性回收。
	clockMs.Add(int64(limits.UploadSessionTTL+time.Minute) / int64(time.Millisecond))
	if w := env.req(http.MethodGet, uploadPath(sess.UploadID), token, nil); w.Code != http.StatusNotFound {
		t.Fatalf("过期会话 GET = %d, want 404", w.Code)
	}
	if _, serr := os.Stat(env.sessionDir(sess.UploadID)); !os.IsNotExist(serr) {
		t.Fatalf("过期会话目录未被回收: %v", serr)
	}
	if w := env.rawReq(http.MethodPut, uploadChunkPath(sess.UploadID, 1), token, parts[1], false); w.Code != http.StatusNotFound {
		t.Fatalf("过期会话 PUT = %d, want 404", w.Code)
	}
	if w := env.req(http.MethodPost, completePath(sess.UploadID), token, completeBody("过期应用", goodConfig())); w.Code != http.StatusNotFound {
		t.Fatalf("过期会话 complete = %d, want 404", w.Code)
	}
	if n := env.countReleases("ttl-app"); n != 0 {
		t.Fatalf("过期会话不得发布: %d", n)
	}
}

// ---------------------------------------------------------------------------
// 6. 并发 PUT / 会话数上限 / 频率闸门 / 幂等 complete
// ---------------------------------------------------------------------------

func TestUploadConcurrentPutsDoNotLoseChunks(t *testing.T) {
	env := newUploadEnv(t)
	wasm := testGuestModule(t)
	chunk, parts := planThree(t, wasm)
	token := env.tokens["alice"]
	sess := env.createUpload(token, "race-app", "1.0.0", int64(len(wasm)), chunk)

	var wg sync.WaitGroup
	codes := make([]int, len(parts))
	for i, part := range parts {
		wg.Add(1)
		go func(i int, part []byte) {
			defer wg.Done()
			codes[i] = env.rawReq(http.MethodPut, uploadChunkPath(sess.UploadID, i), token, part, false).Code
		}(i, part)
	}
	wg.Wait()
	for i, code := range codes {
		if code != http.StatusOK {
			t.Fatalf("并发 PUT 第 %d 片 = %d, want 200", i, code)
		}
	}
	st := env.status(token, sess.UploadID)
	if len(st.Received) != len(parts) {
		t.Fatalf("并发写入后 received = %v（丢片）", st.Received)
	}
	if st.ReceivedBytes != int64(len(wasm)) {
		t.Fatalf("received_bytes = %d, want %d", st.ReceivedBytes, len(wasm))
	}
	// 拼装仍然正确。
	env.putChunk(token, sess.UploadID, 0, parts[0]) // 覆盖一次，确保锁释放干净
	if w := env.req(http.MethodPost, completePath(sess.UploadID), token, completeBody("并发应用", goodConfig())); w.Code != http.StatusCreated {
		t.Fatalf("并发上传后 complete 失败: %d %s", w.Code, w.Body.String())
	}
}

func TestUploadSessionsPerUserLimit(t *testing.T) {
	env := newUploadEnv(t)
	wasm := testGuestModule(t)
	chunk, _ := planThree(t, wasm)
	token := env.tokens["alice"]
	for i := 0; i < limits.UploadSessionsPerUser; i++ {
		env.createUpload(token, "quota-app", "1.0.0", int64(len(wasm)), chunk)
	}
	w := env.req(http.MethodPost, "/api/client/v2/apps/wasm/uploads", token, map[string]any{
		"app_id": "quota-app", "version": "1.0.0",
		"total_bytes": int64(len(wasm)), "chunk_bytes": chunk,
	})
	eb := env.decodeErr(w, http.StatusTooManyRequests)
	if eb.Error.Code != string(apperr.CodeRateLimited) {
		t.Fatalf("超会话数的 code = %s, want RATE_LIMITED", eb.Error.Code)
	}
	if w.Header().Get("Retry-After") == "" {
		t.Errorf("429 必须带 Retry-After")
	}
	// DELETE 一个会话即可腾出槽位（主动放弃是**唯一**不依赖过期的自救方式）。
	var first string
	entries, _ := os.ReadDir(env.uploadRoot())
	for _, e := range entries {
		first = e.Name()
		break
	}
	if w := env.req(http.MethodDelete, uploadPath(first), token, nil); w.Code != http.StatusOK {
		t.Fatalf("DELETE 会话 = %d", w.Code)
	}
	if _, serr := os.Stat(env.sessionDir(first)); !os.IsNotExist(serr) {
		t.Fatalf("DELETE 未回收磁盘: %v", serr)
	}
	if w := env.req(http.MethodPost, "/api/client/v2/apps/wasm/uploads", token, map[string]any{
		"app_id": "quota-app", "version": "1.0.0",
		"total_bytes": int64(len(wasm)), "chunk_bytes": chunk,
	}); w.Code != http.StatusCreated {
		t.Fatalf("腾出槽位后仍被拒: %d %s", w.Code, w.Body.String())
	}
}

// TestUploadCompleteStillUsesUploadRateGate：分片不能绕过 §4.3 的上传频率闸门。
//
// 手法：先用 30 次**廉价失败**的 validate 吃掉 alice 的小时额度（限流只按用户计数、
// 失败不返还），再做一次完整的分片上传 —— complete 必须 429。
func TestUploadCompleteStillUsesUploadRateGate(t *testing.T) {
	env := newUploadEnv(t)
	wasm := testGuestModule(t)
	chunk, parts := planThree(t, wasm)
	token := env.tokens["alice"]

	// 开会话与 PUT **不**计数：先做完整上传，再吃额度，确保顺序不影响结论。
	sess := env.createUpload(token, "gate-app", "1.0.0", int64(len(wasm)), chunk)
	for i, part := range parts {
		env.putChunk(token, sess.UploadID, i, part)
	}
	used, _ := env.compiler.UploadState(env.ids["alice"], time.Now())
	if used != 0 {
		t.Fatalf("分片 PUT/开会话不该计入上传频率（used=%d，设计决定：只有 complete 计数）", used)
	}
	for i := 0; i < limits.UploadRatePerHour; i++ {
		// app_id 非法 ⇒ 请求在占位之后立刻失败（不编译），额度照样消耗。
		w := env.req(http.MethodPost, "/api/client/v2/apps/wasm/validate", token,
			map[string]any{"app_id": "Bad"})
		if w.Code != http.StatusBadRequest {
			t.Fatalf("第 %d 次 validate = %d, want 400; %s", i+1, w.Code, w.Body.String())
		}
	}
	w := env.req(http.MethodPost, completePath(sess.UploadID), token, completeBody("闸门应用", goodConfig()))
	eb := env.decodeErr(w, http.StatusTooManyRequests)
	if eb.Error.Code != string(apperr.CodeRateLimited) {
		t.Fatalf("第 31 次上传的 code = %s, want RATE_LIMITED", eb.Error.Code)
	}
	if w.Header().Get("Retry-After") == "" {
		t.Errorf("429 必须带 Retry-After（§7.4）")
	}
	if n := env.countReleases("gate-app"); n != 0 {
		t.Fatalf("被限流的 complete 落了版本行: %d", n)
	}
	// 被限流时保留会话（额度恢复后可以直接重试，不必重传 32 MiB）。
	if _, serr := os.Stat(env.sessionDir(sess.UploadID)); serr != nil {
		t.Fatalf("被限流时不该删会话: %v", serr)
	}
}

// TestUploadCompleteIsIdempotent：重复 complete 回放**逐字相同**的成功体。
//
// 决定（交付说明里写明）：成功后会话目录立即删除（磁盘不驻留），首次的成功响应体
// 进内存重放缓存（TTL = 会话有效期）。于是"客户端丢了 201"有确定的恢复路径：
// 重发一次拿到同样的字节，而不是 404（那会逼它重传 32 MiB 并撞 NAME_TAKEN）。
func TestUploadCompleteIsIdempotent(t *testing.T) {
	env := newUploadEnv(t)
	wasm := testGuestModule(t)
	chunk, parts := planThree(t, wasm)
	token := env.tokens["alice"]
	sess := env.createUpload(token, "idemc-app", "1.0.0", int64(len(wasm)), chunk)
	for i, part := range parts {
		env.putChunk(token, sess.UploadID, i, part)
	}
	first := env.req(http.MethodPost, completePath(sess.UploadID), token, completeBody("幂等应用", goodConfig()))
	if first.Code != http.StatusCreated {
		t.Fatalf("首次 complete = %d %s", first.Code, first.Body.String())
	}
	releases := env.countReleases("idemc-app")
	audits := env.countAudit()
	usedBefore, _ := env.compiler.UploadState(env.ids["alice"], time.Now())

	// 篡改请求体也不影响（重放不看请求体：会话已经完结）。
	second := env.req(http.MethodPost, completePath(sess.UploadID), token, completeBody("换个标题", goodConfig()))
	if second.Code != http.StatusCreated {
		t.Fatalf("重复 complete = %d %s", second.Code, second.Body.String())
	}
	if first.Body.String() != second.Body.String() {
		t.Fatalf("重复 complete 的回放体不同:\n first=%s\nsecond=%s", first.Body.String(), second.Body.String())
	}
	if got := env.countReleases("idemc-app"); got != releases {
		t.Fatalf("重复 complete 又落了一个版本行: %d → %d", releases, got)
	}
	if got := env.countAudit(); got != audits {
		t.Fatalf("重复 complete 又写了审计: %d → %d", audits, got)
	}
	usedAfter, _ := env.compiler.UploadState(env.ids["alice"], time.Now())
	if usedAfter != usedBefore {
		t.Fatalf("重放消耗了上传额度: %d → %d", usedBefore, usedAfter)
	}
	// 别的用户拿不到这次重放（跨用户仍 404，不泄露"这个 id 曾经成功过"）。
	if w := env.req(http.MethodPost, completePath(sess.UploadID), env.tokens["bob"], completeBody("x", goodConfig())); w.Code != http.StatusNotFound {
		t.Fatalf("跨用户重放 = %d, want 404", w.Code)
	}
}

// waitUploadInflight 轮询到该用户有"编译中的上传"（确定性同步点）。
//
// 它证明首个 complete 已经进入发布链路（拿到"同时 1 次编译"的占位、并持着会话锁），
// 因此此刻发出的第二个同会话 complete 必定要在会话锁上排队 —— 这是本用例不靠 sleep
// 赌竞态的关键（审计探针用的是 `time.Sleep(150ms)`）。
func waitUploadInflight(t *testing.T, env *testEnv, user string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if _, inflight := env.compiler.UploadState(env.ids[user], time.Now()); inflight >= 1 {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("等不到 %s 的 complete 进入发布链路（inflight 恒为 0）", user)
}

// TestUploadConcurrentDuplicateCompleteReplays：审计 FIX-45 的**端到端**判据。
//
// 契约：同一会话**并发/交错**的第二个 complete 必须与首个**逐字相同**地回放 201，
// 且不重新编译、不重复落库、不重复写审计、不重复消耗上传额度。
//
// 手法（确定性）：首个请求放 goroutine，主协程轮询 Compiler.UploadState 直到
// `inflight == 1`（= 首个已在发布链路里、持着会话锁），**此时**才发第二个请求 ——
// 它拿到 201 的唯一途径就是"在会话锁上等首个结束 → 锁内命中重放缓存"。
//
// 变异方式（把重放判定移回会话锁之外 —— api 层不再取租约、闸门回到锁外 ⇒ 本用例必红，
// 已实测）：第二个请求会得到 429 RATE_LIMITED（审计报告的实测形态），而不是 201。
func TestUploadConcurrentDuplicateCompleteReplays(t *testing.T) {
	env := newUploadEnv(t)
	wasm := testGuestModule(t)
	chunk, parts := planThree(t, wasm)
	token := env.tokens["alice"]
	const appID = "concurrent-replay"
	sess := env.createUpload(token, appID, "1.0.0", int64(len(wasm)), chunk)
	for i, p := range parts {
		env.putChunk(token, sess.UploadID, i, p)
	}

	type result struct {
		code int
		body string
	}
	firstDone := make(chan result, 1)
	go func() {
		w := env.req(http.MethodPost, completePath(sess.UploadID), token,
			completeBody("第一次 complete", goodConfig()))
		firstDone <- result{w.Code, w.Body.String()}
	}()
	waitUploadInflight(t, env, "alice")
	select {
	case got := <-firstDone:
		t.Fatalf("首个 complete 在第二个请求发出前就结束了（并发前提不成立，本用例会退化成顺序重放）: %d", got.code)
	default:
	}

	// 客户端丢了 201 之后的立即重试（标题不同也不影响：重放不看请求体）。
	second := env.req(http.MethodPost, completePath(sess.UploadID), token,
		completeBody("第二次 complete（重试）", goodConfig()))
	first := <-firstDone
	if first.code != http.StatusCreated {
		t.Fatalf("第一次 complete 应 201，实际 %d %s", first.code, clipBody(first.body))
	}
	if second.Code != http.StatusCreated {
		t.Fatalf("并发重复 complete = %d（契约：等待首个结束后回放逐字相同的 201）: %s",
			second.Code, clipBody(second.Body.String()))
	}
	if second.Body.String() != first.body {
		t.Fatalf("并发重复 complete 的回放体不同:\n first=%s\nsecond=%s",
			clipBody(first.body), clipBody(second.Body.String()))
	}
	// 只落 1 行 / 只写 1 次审计 / 只消耗 1 次额度。
	if n := env.countReleases(appID); n != 1 {
		t.Fatalf("版本行数 = %d, want 1（重复发布）", n)
	}
	var audits int
	if err := env.db.QueryRow(`SELECT COUNT(*) FROM audit_logs WHERE app_id = $1`, appID).Scan(&audits); err != nil {
		t.Fatalf("统计应用级审计失败: %v", err)
	}
	if audits != 1 {
		t.Fatalf("应用级审计行数 = %d, want 1（重复 complete 又写了一次审计）", audits)
	}
	used, inflight := env.compiler.UploadState(env.ids["alice"], time.Now())
	if used != 1 {
		t.Fatalf("上传额度消耗 = %d, want 1（回放不占额度）", used)
	}
	if inflight != 0 {
		t.Fatalf("编译占位没有释放干净: inflight=%d", inflight)
	}
	// 成功即删会话（磁盘不驻留）。
	if _, serr := os.Stat(env.sessionDir(sess.UploadID)); !os.IsNotExist(serr) {
		t.Fatalf("成功后会话目录仍在: %v", serr)
	}
	// 事后重试同样回放（缓存 TTL 内）。
	third := env.req(http.MethodPost, completePath(sess.UploadID), token, completeBody("第三次", goodConfig()))
	if third.Code != http.StatusCreated || third.Body.String() != first.body {
		t.Fatalf("事后重试未回放: %d %s", third.Code, clipBody(third.Body.String()))
	}

	// 第二阶段：两个请求**同时**发出（无先后），断言任何交错下都不会退化成 429/404 ——
	// 租约把同会话的发布串行化：先拿到租约的那个成为"首个"，另一个在锁上等它结束再回放。
	// （第一阶段的同步点是"首个已在编译中"；这里连那个前提都不给。）
	const simApp = appID + "-simul"
	sess2 := env.createUpload(token, simApp, "1.0.0", int64(len(wasm)), chunk)
	for i, p := range parts {
		env.putChunk(token, sess2.UploadID, i, p)
	}
	start := make(chan struct{})
	results := make(chan result, 2)
	for i := 0; i < 2; i++ {
		go func() {
			<-start
			w := env.req(http.MethodPost, completePath(sess2.UploadID), token,
				completeBody("同时提交", goodConfig()))
			results <- result{w.Code, w.Body.String()}
		}()
	}
	close(start)
	a, b := <-results, <-results
	if a.code != http.StatusCreated || b.code != http.StatusCreated {
		t.Fatalf("同时提交的两个 complete 必须都回放 201，实际 %d 与 %d（%s / %s）",
			a.code, b.code, clipBody(a.body), clipBody(b.body))
	}
	if a.body != b.body {
		t.Fatalf("同时提交的两个 complete 回放体不同:\n a=%s\n b=%s", clipBody(a.body), clipBody(b.body))
	}
	if n := env.countReleases(simApp); n != 1 {
		t.Fatalf("同时提交落了 %d 个版本行, want 1", n)
	}
	used2, inflight2 := env.compiler.UploadState(env.ids["alice"], time.Now())
	if used2 != 2 {
		t.Fatalf("总上传额度消耗 = %d, want 2（同时提交的重复请求不占额度）", used2)
	}
	if inflight2 != 0 {
		t.Fatalf("编译占位没有释放干净: inflight=%d", inflight2)
	}
}

// clipBody 截断日志里的响应体（错误/成功体最长可达 KB 级，全量打印会淹没失败信息）。
func clipBody(s string) string {
	const max = 240
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}

// TestUploadCreateBodyTooLargeHintPointsToChunkedUpload：审计 FIX-46 的判据。
//
// POST /uploads 的 body 只是四个短字段的小 JSON（上限 4096 B），但通用 413 的 hints 讲的是
// "base64 直传的 4/3 膨胀"（"请求体上限 4.0 KiB 对应约 3.0 KiB 的 .wasm"）—— 对这条端点
// 会把第一消费者（AI/作者）带向"把模块压到 3 KiB"这条**完全错误**的修法。§8 要求错误
// 必须指向真实修法；对照：同文件的 completeBodyTooLarge 就是正确示范（点出不要带
// wasm_base64），缺的只是开会话这一份。
//
// 变异方式（把开会话的 413 换回通用 bodyTooLarge ⇒ 本用例必红，已实测）。
func TestUploadCreateBodyTooLargeHintPointsToChunkedUpload(t *testing.T) {
	env := newUploadEnv(t)
	big := strings.Repeat("a", uploadCreateBodyMaxBytes)
	w := env.req(http.MethodPost, "/api/client/v2/apps/wasm/uploads", env.tokens["alice"],
		`{"app_id":"`+big+`","version":"1.0.0","total_bytes":1,"chunk_bytes":1}`)
	eb := env.decodeErr(w, http.StatusRequestEntityTooLarge)
	if eb.Error.Code != string(apperr.CodeBodyTooLarge) {
		t.Fatalf("code = %s, want BODY_TOO_LARGE", eb.Error.Code)
	}
	joined := strings.Join(eb.Error.Hints, " | ")
	t.Logf("开会话 413: message=%q hints=%v", eb.Error.Message, eb.Error.Hints)
	if strings.Contains(joined, "base64") {
		t.Errorf("开会话的 413 仍在讲 base64 直传（指向错误修法）: %s", joined)
	}
	if strings.Contains(joined, ".wasm") {
		t.Errorf("开会话的 413 仍在讲 .wasm 体积（指向错误修法）: %s", joined)
	}
	if !strings.Contains(joined, "chunks/:index") {
		t.Errorf("开会话的 413 必须点出真实修法：分片接口 PUT .../uploads/:upload_id/chunks/:index: %s", joined)
	}
	if !strings.Contains(joined, "字段") && !strings.Contains(joined, "JSON") {
		t.Errorf("开会话的 413 必须说清 body 只是四个短字段的小 JSON: %s", joined)
	}
	if strings.Contains(joined, "子集化") || strings.Contains(joined, "压缩") {
		t.Errorf("开会话的 413 不该引导压缩模块: %s", joined)
	}
	if eb.Error.Details["max_body_bytes"] != float64(uploadCreateBodyMaxBytes) {
		t.Errorf("details.max_body_bytes = %v, want %d", eb.Error.Details["max_body_bytes"], uploadCreateBodyMaxBytes)
	}
	if eb.Error.Details["fields"] == nil {
		t.Errorf("开会话的 413 必须列出真正的字段集: %s", w.Body.String())
	}
	// 上限必须与会话体积无关（开会话的 body 不装模块字节）：
	if !strings.Contains(eb.Error.Message, humanBytes(uploadCreateBodyMaxBytes)) {
		t.Errorf("message 必须给出上限：%q", eb.Error.Message)
	}
	// 对照（防止两套文案被"统一"回去）：complete 的 413 仍必须点出"不要带 wasm_base64"。
	completeHints := strings.Join(completeBodyTooLarge(1<<20).Hints, " | ")
	if !strings.Contains(completeHints, "wasm_base64") {
		t.Errorf("complete 的 413 丢了'不要带 wasm_base64'的指向性文案: %s", completeHints)
	}
}

// TestUploadCompletePayloadCrossCheck：complete 的 body 只带 title/changelog/config，
// 但给了 app_id/version/wasm_base64 就必须自洽（防"我以为发布了 B"）。
func TestUploadCompletePayloadCrossCheck(t *testing.T) {
	env := newUploadEnv(t)
	wasm := testGuestModule(t)
	chunk, parts := planThree(t, wasm)
	token := env.tokens["alice"]
	sess := env.createUpload(token, "check-app", "1.0.0", int64(len(wasm)), chunk)
	for i, part := range parts {
		env.putChunk(token, sess.UploadID, i, part)
	}
	cases := []struct {
		name string
		body map[string]any
	}{
		{"带 wasm_base64", map[string]any{"title": "x", "changelog": "首版", "config": goodConfig(), "wasm_base64": b64([]byte("x"))}},
		{"app_id 不一致", map[string]any{"title": "x", "changelog": "首版", "config": goodConfig(), "app_id": "other-app"}},
		{"version 不一致", map[string]any{"title": "x", "changelog": "首版", "config": goodConfig(), "version": "9.9.9"}},
	}
	for _, tc := range cases {
		w := env.req(http.MethodPost, completePath(sess.UploadID), token, tc.body)
		eb := env.decodeErr(w, http.StatusBadRequest)
		if eb.Error.Code != string(apperr.CodeValidation) {
			t.Errorf("%s: code = %s, want VALIDATION", tc.name, eb.Error.Code)
		}
		if n := env.countReleases("check-app"); n != 0 {
			t.Fatalf("%s: 落版本行了", tc.name)
		}
	}
	// 把 4.6 MiB 的 wasm_base64 塞进 complete ⇒ 413，且错误**有指向性**
	// （complete 的 body 是小 JSON；泛泛的"请求体过大"会让客户端不知道该怎么改）。
	huge := map[string]any{"title": "x", "changelog": "首版", "config": goodConfig(), "wasm_base64": b64(wasm)}
	w := env.req(http.MethodPost, completePath(sess.UploadID), token, huge)
	eb := env.decodeErr(w, http.StatusRequestEntityTooLarge)
	if eb.Error.Code != string(apperr.CodeBodyTooLarge) {
		t.Errorf("超大 complete 体 code = %s, want BODY_TOO_LARGE", eb.Error.Code)
	}
	if !strings.Contains(w.Body.String(), "wasm_base64") {
		t.Errorf("413 的提示必须点出 wasm_base64: %s", w.Body.String())
	}
	if n := env.countReleases("check-app"); n != 0 {
		t.Fatalf("超大 complete 体落了版本行: %d", n)
	}
	// 自洽的 app_id/version（与会话一致）必须被接受。
	ok := map[string]any{"title": "自洽应用", "changelog": "首版", "config": goodConfig(),
		"app_id": "check-app", "version": "1.0.0"}
	if w := env.req(http.MethodPost, completePath(sess.UploadID), token, ok); w.Code != http.StatusCreated {
		t.Fatalf("自洽的完整 body 被拒: %d %s", w.Code, w.Body.String())
	}
}

// TestUploadCompleteFailureKeepsSession：失败保留（可续传重试）、成功删除（磁盘不驻留）。
func TestUploadCompleteFailureKeepsSession(t *testing.T) {
	env := newUploadEnv(t)
	wasm := testGuestModule(t)
	chunk, parts := planThree(t, wasm)
	token := env.tokens["alice"]
	sess := env.createUpload(token, "keep-app", "1.0.0", int64(len(wasm)), chunk)
	for i, part := range parts {
		env.putChunk(token, sess.UploadID, i, part)
	}
	// 缺 config ⇒ 发布失败（§10.5 第 56b 项），会话必须留下。
	w := env.req(http.MethodPost, completePath(sess.UploadID), token, map[string]any{
		"title": "缺配置", "changelog": "首版",
	})
	w2 := env.req(http.MethodPost, completePath(sess.UploadID), token, map[string]any{
		"title": "缺配置", "changelog": "首版", "config": nil,
	})
	for _, resp := range []*httptest.ResponseRecorder{w, w2} {
		if resp.Code != http.StatusUnprocessableEntity && resp.Code != http.StatusBadRequest {
			t.Fatalf("缺 config 应被拒: %d %s", resp.Code, resp.Body.String())
		}
	}
	if _, serr := os.Stat(env.sessionDir(sess.UploadID)); serr != nil {
		t.Fatalf("失败的 complete 删掉了会话（不能续传重试）: %v", serr)
	}
	if st := env.status(token, sess.UploadID); len(st.Received) != 3 {
		t.Fatalf("失败的 complete 破坏了会话状态: %+v", st)
	}
	// 修好 body 后重试成功，且目录被删。
	if w := env.req(http.MethodPost, completePath(sess.UploadID), token, completeBody("修好了", goodConfig())); w.Code != http.StatusCreated {
		t.Fatalf("重试 complete 失败: %d %s", w.Code, w.Body.String())
	}
	if _, serr := os.Stat(env.sessionDir(sess.UploadID)); !os.IsNotExist(serr) {
		t.Fatalf("成功后会话目录仍在: %v", serr)
	}
}

// TestUploadDeleteReclaimsDisk：DELETE 只回收磁盘，不影响已发布的版本。
func TestUploadDeleteReclaimsDisk(t *testing.T) {
	env := newUploadEnv(t)
	wasm := testGuestModule(t)
	chunk, parts := planThree(t, wasm)
	token := env.tokens["alice"]
	sess := env.createUpload(token, "del-app", "1.0.0", int64(len(wasm)), chunk)
	for i, part := range parts {
		env.putChunk(token, sess.UploadID, i, part)
	}
	if w := env.req(http.MethodDelete, uploadPath(sess.UploadID), token, nil); w.Code != http.StatusOK {
		t.Fatalf("DELETE = %d %s", w.Code, w.Body.String())
	}
	if _, serr := os.Stat(env.sessionDir(sess.UploadID)); !os.IsNotExist(serr) {
		t.Fatalf("DELETE 未回收目录: %v", serr)
	}
	if w := env.req(http.MethodGet, uploadPath(sess.UploadID), token, nil); w.Code != http.StatusNotFound {
		t.Fatalf("已放弃的会话仍可查: %d", w.Code)
	}
	if n := env.countReleases("del-app"); n != 0 {
		t.Fatalf("放弃会话不该落版本: %d", n)
	}
	// 删过之后仍可重新开会话（配额已释放）。
	if w := env.req(http.MethodPost, "/api/client/v2/apps/wasm/uploads", token, map[string]any{
		"app_id": "del-app", "version": "1.0.0", "total_bytes": int64(len(wasm)), "chunk_bytes": chunk,
	}); w.Code != http.StatusCreated {
		t.Fatalf("放弃后重新开会话失败: %d %s", w.Code, w.Body.String())
	}
}

// TestUploadRequiresAuth：五个端点全部要求 Bearer（路由挂 BearerAuth，测试树同样挂）。
func TestUploadRequiresAuth(t *testing.T) {
	env := newUploadEnv(t)
	id := strings.Repeat("ab", 32)
	for _, tc := range []struct {
		method, path string
		body         []byte
	}{
		{http.MethodPost, "/api/client/v2/apps/wasm/uploads", []byte(`{}`)},
		{http.MethodPut, uploadChunkPath(id, 0), []byte("x")},
		{http.MethodGet, uploadPath(id), nil},
		{http.MethodPost, completePath(id), []byte(`{}`)},
		{http.MethodDelete, uploadPath(id), nil},
	} {
		w := env.rawReq(tc.method, tc.path, "", tc.body, false)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("%s %s 无令牌 = %d, want 401", tc.method, tc.path, w.Code)
		}
	}
}

// TestUploadCreateBodyShape：开会话的请求体是小 JSON（形状错一律 400，不是 500）。
func TestUploadCreateBodyShape(t *testing.T) {
	env := newUploadEnv(t)
	token := env.tokens["alice"]
	for _, body := range []string{`{`, ``, `[]`, `{"app_id":123}`, `{}{}`} {
		w := env.req(http.MethodPost, "/api/client/v2/apps/wasm/uploads", token, body)
		if w.Code != http.StatusBadRequest && w.Code != http.StatusUnprocessableEntity {
			t.Errorf("畸形体 %q = %d, want 4xx; %s", body, w.Code, w.Body.String())
		}
		eb := env.decodeErr(w, w.Code)
		if eb.Error.Code == "" {
			t.Errorf("畸形体 %q 没有错误码", body)
		}
	}
	// 超过小 JSON 上限（4 KiB）⇒ 413 且有指向性（不是"JSON 解析失败"）。
	big := strings.Repeat("a", uploadCreateBodyMaxBytes)
	w := env.req(http.MethodPost, "/api/client/v2/apps/wasm/uploads", token,
		`{"app_id":"`+big+`","version":"1.0.0","total_bytes":1,"chunk_bytes":1}`)
	eb := env.decodeErr(w, http.StatusRequestEntityTooLarge)
	if eb.Error.Code != string(apperr.CodeBodyTooLarge) {
		t.Errorf("超大开会话体 code = %s, want BODY_TOO_LARGE", eb.Error.Code)
	}
}

// status 是续传查询的便捷封装。
func (e *testEnv) status(token, id string) uploadStatusOut {
	e.t.Helper()
	w := e.req(http.MethodGet, uploadPath(id), token, nil)
	var out uploadStatusOut
	e.decodeJSON(w, http.StatusOK, &out)
	return out
}
