package llmgateway

// R24-X4-2（审计 2026-09-26，P2）回归：`/v1/files` 上传的内存闸门**对同一份字节
// 收两次 2×**（读体 2× + `rewriteUploadExpiry` 再 2× = 4×）⇒ 声明的 64MiB 上限
// 实际只有 `largeTier/4 = 24MiB`（缺省 128MiB 预算），超出后回**可重试**的
// 503「网关繁忙」，而 413 才对（“上传文件超过上限”）。
//
// 判据（本文件）：
//  1. 边界：24MiB / 24MiB+1 / 64MiB 全部 200（声明上限真的可达），64MiB+1 → 413
//     VALIDATION 且文案指向“上传文件超过上限”（不是“网关繁忙”、不是“请求体过大”）；
//  2. 并发约束仍在：另一个在飞请求占住 1MiB 时 64MiB 上传仍 200（只计一次），
//     占住 33MiB 时 64MiB 上传 503（33+64 > 大体池 96MiB）—— 一次计数不得放大并发；
//  3. 源码级：上传路径的内存闸门申请只有两处（都在读体 helper 内）、且按**体字节**
//     记一次（出现 `*2` 即红）。

import (
	"bytes"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"strings"
	"testing"
)

// r24MultipartOfTotal 造一个**总体积恰为 total** 的 multipart 体（不足的部分补在
// file 部分的字节里）—— 边界判据要按请求体总长而不是 payload 长度说话。
func r24MultipartOfTotal(t *testing.T, total int64) ([]byte, string) {
	t.Helper()
	build := func(payload int) ([]byte, string) {
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		_ = mw.WriteField("purpose", "user_data")
		_ = mw.WriteField("expires_after[seconds]", "86400")
		fw, err := mw.CreateFormFile("file", "image.webp")
		if err != nil {
			t.Fatal(err)
		}
		if payload > 0 {
			if _, err := fw.Write(bytes.Repeat([]byte("x"), payload)); err != nil {
				t.Fatal(err)
			}
		}
		if err := mw.Close(); err != nil {
			t.Fatal(err)
		}
		return buf.Bytes(), mw.FormDataContentType()
	}
	overhead, _ := build(0)
	payload := total - int64(len(overhead))
	if payload < 0 {
		t.Fatalf("total=%d 装不下 multipart 头（overhead=%d）", total, len(overhead))
	}
	body, ct := build(int(payload))
	if int64(len(body)) != total {
		t.Fatalf("夹具体积 = %d, want %d", len(body), total)
	}
	return body, ct
}

// r24NewFilesGWForBudget 建一套 /files 网关（真 handler + 假上游 + 真 PG 夹具）。
func r24NewFilesGWForBudget(t *testing.T) (*filesGateway, *fakeFilesUpstream) {
	t.Helper()
	resetBodyParseGate(t)
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")
	return gw, up
}

func TestR24FilesUploadDeclaredLimitReachable(t *testing.T) {
	gw, up := r24NewFilesGWForBudget(t)

	cases := []struct {
		name string
		size int64
		want int
	}{
		{"24MiB（旧实现的实际上限）", 24 << 20, http.StatusOK},
		{"24MiB+1（旧实现 503）", 24<<20 + 1, http.StatusOK},
		{"64MiB（声明上限）", 64 << 20, http.StatusOK},
		{"64MiB+1（超声明上限）", 64<<20 + 1, http.StatusRequestEntityTooLarge},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body, ct := r24MultipartOfTotal(t, tc.size)
			hits := up.hits.Load()
			w := doFilesReq(t, gw.r, http.MethodPost, "/v1/files", bytes.NewReader(body), gw.tokenA, ct)
			if w.Code != tc.want {
				t.Fatalf("size=%d status = %d (%s), want %d", tc.size, w.Code, w.Body.String(), tc.want)
			}
			if tc.want == http.StatusOK {
				if up.hits.Load() != hits+1 {
					t.Fatalf("size=%d 未转发到上游（hits=%d→%d）", tc.size, hits, up.hits.Load())
				}
				return
			}
			// 超限：不可重试的分类 + 指向真实原因的文案。
			got := w.Body.String()
			if !strings.Contains(got, "VALIDATION") {
				t.Fatalf("超限信封 code 不是 VALIDATION（客户端会当可重试）：%s", got)
			}
			if !strings.Contains(got, "上传文件超过上限") {
				t.Fatalf("超限文案未指向真实原因（期望含「上传文件超过上限」）：%s", got)
			}
			if strings.Contains(got, "网关繁忙") {
				t.Fatalf("超限被说成「网关繁忙」（可重试 ⇒ 客户端重试死循环）：%s", got)
			}
			if up.hits.Load() != hits {
				t.Fatalf("超限请求不应触达上游（hits=%d→%d）", hits, up.hits.Load())
			}
		})
	}
}

// TestR24FilesUploadBudgetStillConstrainsConcurrency：只计一次 ≠ 放开并发。
//
// 用真闸门预占（模拟另一个在飞请求），再发同一个 64MiB 上传：
//   - 占 1MiB  ⇒ 1+64 = 65MiB ≤ 大体池 96MiB ⇒ 必须 200（旧实现按 4× 记 ⇒ 503）；
//   - 占 33MiB ⇒ 33+64 = 97MiB > 96MiB       ⇒ 必须 503（预算仍然拦得住）。
func TestR24FilesUploadBudgetStillConstrainsConcurrency(t *testing.T) {
	budget := int64(DefaultBodyParseBudgetMB) << 20
	_, largeCap := bodyParseTiers(budget)
	if largeCap != 96<<20 {
		t.Fatalf("夹具前提不成立：缺省预算下大体池 = %dMiB, want 96MiB", largeCap>>20)
	}
	cases := []struct {
		name string
		hold int64
		want int
	}{
		{"另一请求在飞 1MiB", 1 << 20, http.StatusOK},
		{"另一请求在飞 33MiB", 33 << 20, http.StatusServiceUnavailable},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gw, up := r24NewFilesGWForBudget(t)
			rel, ok := globalBodyParseGate.acquire(budget, tc.hold)
			if !ok {
				t.Fatalf("预占 %dMiB 失败（夹具问题）", tc.hold>>20)
			}
			defer rel()

			body, ct := r24MultipartOfTotal(t, 64<<20)
			w := doFilesReq(t, gw.r, http.MethodPost, "/v1/files", bytes.NewReader(body), gw.tokenA, ct)
			if w.Code != tc.want {
				t.Fatalf("在飞 %dMiB + 64MiB 上传 status = %d (%s), want %d",
					tc.hold>>20, w.Code, w.Body.String(), tc.want)
			}
			if tc.want == http.StatusOK && up.hits.Load() != 1 {
				t.Fatalf("64MiB 上传未转发到上游（hits=%d）", up.hits.Load())
			}
			if tc.want == http.StatusServiceUnavailable {
				if !strings.Contains(w.Body.String(), "网关繁忙") {
					t.Fatalf("预算打满的信封不是「网关繁忙」（可重试语义）：%s", w.Body.String())
				}
				// 闸门拒绝**已经写过响应**：调用方不得再写第二个信封
				// （旧实现接着走 writeFilesTransportError(nil) ⇒ 追加一个 502
				// 「上游请求失败」，拼出来的 body 不是合法 JSON）。
				if n := strings.Count(w.Body.String(), `"error"`); n != 1 {
					t.Fatalf("预算打满的响应里有 %d 个信封（want 1）：%s", n, w.Body.String())
				}
				if strings.Contains(w.Body.String(), "上游请求失败") {
					t.Fatalf("闸门拒绝对被追加成「上游请求失败」：%s", w.Body.String())
				}
				if up.hits.Load() != 0 {
					t.Fatalf("预算打满仍转发到上游（hits=%d）", up.hits.Load())
				}
			}
		})
	}
}

// TestR24UploadBudgetCountsEachBodyOnce 源码级护栏：上传路径的内存闸门申请必须
// 只有两处（都在读体 helper 内）、且按**体字节**记一次。回退（读体 2× 或
// rewriteUploadExpiry 再记一次）会让它变红。
func TestR24UploadBudgetCountsEachBodyOnce(t *testing.T) {
	raw, err := os.ReadFile("files.go")
	if err != nil {
		t.Fatal(err)
	}
	src := string(raw)
	if n := strings.Count(src, "globalBodyParseGate.acquire"); n != 2 {
		t.Fatalf("files.go 的内存闸门申请点 = %d, want 2（都必须在 readUploadBodyBudgeted 内）", n)
	}
	if strings.Contains(src, "acquire(budget, cl*2)") || strings.Contains(src, "acquire(budget, int64(len(raw))*2)") {
		t.Fatal("上传路径又按 2× 记费了：同一份字节只允许记一次（R24-X4-2）")
	}
	if !strings.Contains(src, "acquire(budget, cl)") || !strings.Contains(src, "acquire(budget, int64(len(raw)))") {
		t.Fatal("上传路径的内存闸门不再按体字节申请")
	}
}

// TestR24FilesUploadChunkedDeclaredLimitReachable：**未知长度**（chunked）的上传
// 同样必须能用满声明的 64MiB（旧实现读完按 2× 补记、rewrite 再 2× ⇒ 24MiB 起
// 就 503），且超过声明上限仍是 413「上传文件超过上限」。
func TestR24FilesUploadChunkedDeclaredLimitReachable(t *testing.T) {
	gw, _ := r24NewFilesGWForBudget(t)
	cases := []struct {
		name string
		size int64
		want int
	}{
		{"chunked 24MiB+1（旧实现 503）", 24<<20 + 1, http.StatusOK},
		{"chunked 64MiB（声明上限）", 64 << 20, http.StatusOK},
		{"chunked 64MiB+1（超声明上限）", 64<<20 + 1, http.StatusRequestEntityTooLarge},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body, ct := r24MultipartOfTotal(t, tc.size)
			// 用一层不识别的 wrapper 隐藏长度 ⇒ 传输层走 chunked，ContentLength 未知。
			w := doFilesReq(t, gw.r, http.MethodPost, "/v1/files",
				struct{ io.Reader }{bytes.NewReader(body)}, gw.tokenA, ct)
			if w.Code != tc.want {
				t.Fatalf("size=%d status = %d (%s), want %d", tc.size, w.Code, w.Body.String(), tc.want)
			}
			if tc.want == http.StatusRequestEntityTooLarge && !strings.Contains(w.Body.String(), "上传文件超过上限") {
				t.Fatalf("chunked 超限文案未指向真实原因：%s", w.Body.String())
			}
		})
	}
}
