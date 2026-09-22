package llmgateway

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// ---------------------------------------------------------------------------
// Files 上传的内存闸门：4 种形态 × 拒绝语义 + **记账精确性**
// ---------------------------------------------------------------------------
//
// 背景（审计 2026-09-22 复审 P1-N1）：额度申请留在 handleFilesUpload（已知长度分支）、
// 释放留在两处 defer ⇒ 同一份额度被归还两遍，池内计数被多减（下溢后夹到 0），
// 闸门对后续请求形同虚设。所以判据不能只看"503 + 零触达上游"（那在超发下也绿），
// 必须钉**账**：一次上传前后"在飞字节"必须回到基线，且超预算的申请必须被拒。

// lane2CountReader 统计被读走的字节数（"读前拒绝"的判据）。
type lane2CountReader struct {
	inner io.Reader
	reads int
}

func (r *lane2CountReader) Read(p []byte) (int, error) {
	n, err := r.inner.Read(p)
	r.reads += n
	return n, err
}

// TestFilesUploadGateRejectsEveryShape：闸门占满时，四种形态都必须 503 + SERVER、
// 零字节触达上游；已知长度时连请求体都不许读。
func TestFilesUploadGateRejectsEveryShape(t *testing.T) {
	cases := []struct {
		name         string
		chunked      bool
		expectNoRead bool
		build        func(t *testing.T) ([]byte, string)
	}{
		{
			name: "multipart-已知长度", expectNoRead: true,
			build: func(t *testing.T) ([]byte, string) { b, ct := multipartBytes(t, "x"); return b, ct },
		},
		{
			name: "multipart-chunked", chunked: true,
			build: func(t *testing.T) ([]byte, string) { b, ct := multipartBytes(t, "x"); return b, ct },
		},
		{
			name: "非multipart-已知长度", expectNoRead: true,
			build: func(t *testing.T) ([]byte, string) { return []byte(`{"a":1}`), "application/json" },
		},
		{
			name: "非multipart-chunked", chunked: true,
			build: func(t *testing.T) ([]byte, string) { return []byte(`{"a":1}`), "application/json" },
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resetBodyParseGate(t)
			up := newFakeFilesUpstream(t)
			gw := newFilesGateway(t, up.srv.URL, "deepseek-official")
			if err := serverstore.SetSetting(gw.db, SettingBodyParseBudgetMB, "64"); err != nil {
				t.Fatal(err)
			}
			InvalidateGatewayLimits()
			budget := int64(MinBodyParseBudgetMB) << 20
			rel, ok := globalBodyParseGate.acquire(budget, budget) // 占满闸门
			if !ok {
				t.Fatal("占满闸门失败（夹具问题）")
			}
			defer rel()

			body, ct := tc.build(t)
			counter := &lane2CountReader{inner: bytes.NewReader(body)}
			req := httptest.NewRequest(http.MethodPost, "/v1/files", counter)
			if tc.chunked {
				req.ContentLength = -1 // 模拟 chunked：读前无法预知体量
			} else {
				req.ContentLength = int64(len(body))
			}
			req.Header.Set("Content-Type", ct)
			req.Header.Set("Authorization", "Bearer "+gw.tokenA)
			w := httptest.NewRecorder()
			gw.r.ServeHTTP(w, req)

			if w.Code != http.StatusServiceUnavailable {
				t.Fatalf("闸门占满时应 503，实得 %d (%s)", w.Code, w.Body.String())
			}
			if !strings.Contains(w.Body.String(), `"code":"SERVER"`) {
				t.Fatalf("503 必须带 code SERVER（可重试）: %s", w.Body.String())
			}
			if up.hits.Load() != 0 {
				t.Fatalf("被闸门拒绝的上传不得触达上游（%d 次）", up.hits.Load())
			}
			if tc.expectNoRead && counter.reads > 0 {
				t.Fatalf("已知 Content-Length 时必须在读体之前拒绝，实读 %d 字节", counter.reads)
			}
		})
	}
}

// TestFilesUploadGateAccountingIsExact（P1-N1 判据）：另一请求持有 40MiB（预算 64MiB）时，
// 完成一次小上传后闸门在飞字节必须**仍等于 40MiB**，且此时申请 25MiB 必须失败
// （40+25 > 64）。
//
// 旧实现（重复 defer）：同一份额度归还两遍 ⇒ 归还后只剩 32MiB，25MiB 申请被放行（超发）。
func TestFilesUploadGateAccountingIsExact(t *testing.T) {
	resetBodyParseGate(t)
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")
	if err := serverstore.SetSetting(gw.db, SettingBodyParseBudgetMB, "64"); err != nil {
		t.Fatal(err)
	}
	InvalidateGatewayLimits()
	budget := int64(64) << 20

	// 另一条在飞请求：40MiB。
	const held = int64(40) << 20
	releaseHeld, ok := globalBodyParseGate.acquire(budget, held)
	if !ok {
		t.Fatal("占住 40MiB 失败（夹具问题）")
	}
	defer releaseHeld()

	// 一次 4MiB 的上传（峰值 40 + 2×4 + 2×4 = 56MiB ≤ 64MiB，能通过）。
	payload := strings.Repeat("z", 4<<20)
	body, ct := multipartBytes(t, payload)
	if w := doFilesReq(t, gw.r, http.MethodPost, "/v1/files", bytes.NewReader(body), gw.tokenA, ct); w.Code != http.StatusOK {
		t.Fatalf("上传失败: %d %s", w.Code, w.Body.String())
	}

	if got := globalBodyParseGate.inFlightBytes(); got != held {
		t.Fatalf("闸门记账不平衡：占住 %d 字节，上传后变成 %d（同一份额度被多释放了 %d 字节）",
			held, got, held-got)
	}
	// 40 + 25 > 64 ⇒ 必须被拒；被放行就是超发。
	if rel, ok := globalBodyParseGate.acquire(budget, 25<<20); ok {
		rel()
		t.Fatalf("在飞 40MiB 时申请 25MiB 被放行（预算 64MiB）—— 闸门已超发")
	}
}

// TestFilesUploadReadFailureIsNotBlamedOnUpstream：请求体**读取失败**（读错误被包装成
// io.EOF 时 filesBodyTracker 记不到）不得被归成"上游请求失败"502 —— 客户端侧读失败
// 说成上游故障会把排查方向带偏。
func TestFilesUploadReadFailureIsNotBlamedOnUpstream(t *testing.T) {
	resetBodyParseGate(t)
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	body, ct := multipartBytes(t, "x")
	w := doFilesReq(t, gw.r, http.MethodPost, "/v1/files", &lane2WrappedEOFReader{raw: body, cut: len(body) / 2}, gw.tokenA, ct)

	if w.Code == http.StatusBadGateway {
		t.Fatalf("客户端读失败被误报成上游失败：%d %s", w.Code, w.Body.String())
	}
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d (%s), want 400", w.Code, w.Body.String())
	}
	if up.hits.Load() != 0 {
		t.Fatalf("体都没读完就不得触达上游（%d 次）", up.hits.Load())
	}
}

// lane2WrappedEOFReader 在读出一半后返回**被包装的** io.EOF（errors.Is(err, io.EOF) 为真，
// 但 err != io.EOF）—— 模拟中间层把读失败包装后再抛出的形态（filesBodyTracker 只按
// errors.Is 判 EOF，于是记不到错误；分类必须靠 ReadAll 自己的错误兜底）。
type lane2WrappedEOFReader struct {
	raw []byte
	cut int
	pos int
}

func (r *lane2WrappedEOFReader) Read(p []byte) (int, error) {
	if r.pos >= r.cut {
		return 0, fmt.Errorf("upstream read aborted: %w", io.EOF)
	}
	n := copy(p, r.raw[r.pos:r.cut])
	r.pos += n
	return n, nil
}
