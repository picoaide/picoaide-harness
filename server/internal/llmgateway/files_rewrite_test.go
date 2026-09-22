package llmgateway

import (
	"bytes"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"strconv"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// Files 上传体重写：M15（重复字段）/ M18（整对象 JSON）/ 字节保真
// ---------------------------------------------------------------------------
//
// 出站体的**规范不变量**（本文件的判据）：
//   - 扁平形态：`expires_after[anchor]` 与 `expires_after[seconds]` 各**恰好一份**；
//   - 整对象形态：`expires_after` 恰好一份，anchor=created_at、seconds 已收敛；
//   - 两种形态不混用；seconds = min(客户端合法值, 平台上限)，缺省/不可解析 ⇒ 上限；
//   - 其它字段与顺序、文件字节、文件名、part 头一律逐字节保留。
//
// 判据必须按**出现次数**断言（不是 map 去重后的存在性）—— 重复字段正是旧实现的缺陷，
// 用 map 解析会把"四份过期字段"读成两份而假绿。辅助函数统一带 lane2 前缀，避免与
// 其它泳道在同一 Go 包内新增的测试 helper 重名。

// lane2Part 是上游收到的 multipart 里的一个部分（按出现顺序）。
type lane2Part struct {
	name     string
	filename string
	value    []byte
	header   textproto.MIMEHeader
}

// lane2ParseParts 解析上游收到的 multipart，**保留出现顺序与重复**。
func lane2ParseParts(t *testing.T, raw, ct string) []lane2Part {
	t.Helper()
	_, params, err := mime.ParseMediaType(ct)
	if err != nil {
		t.Fatalf("上游 Content-Type 不可解析: %q (%v)", ct, err)
	}
	if params["boundary"] == "" {
		t.Fatalf("上游 Content-Type 缺 boundary: %q", ct)
	}
	mr := multipart.NewReader(strings.NewReader(raw), params["boundary"])
	var out []lane2Part
	for {
		part, err := mr.NextPart()
		if err != nil {
			break
		}
		b, err := io.ReadAll(part)
		if err != nil {
			t.Fatalf("读上游 part 失败: %v", err)
		}
		rec := lane2Part{name: part.FormName(), filename: part.FileName(), value: b, header: textproto.MIMEHeader{}}
		for k, vs := range part.Header {
			rec.header[k] = append([]string(nil), vs...)
		}
		out = append(out, rec)
	}
	return out
}

// lane2Names 返回所有部分的名字（按出现顺序；文件部分记作 "file:<filename>"）。
func lane2Names(parts []lane2Part) []string {
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p.filename != "" {
			out = append(out, "file:"+p.filename)
			continue
		}
		out = append(out, p.name)
	}
	return out
}

// lane2Count 数某个字段名出现的次数（只数字段，不算文件部分）。
func lane2Count(parts []lane2Part, name string) int {
	n := 0
	for _, p := range parts {
		if p.filename == "" && p.name == name {
			n++
		}
	}
	return n
}

// lane2Values 返回某字段名的所有值（按出现顺序）。
func lane2Values(parts []lane2Part, name string) []string {
	var out []string
	for _, p := range parts {
		if p.filename == "" && p.name == name {
			out = append(out, string(p.value))
		}
	}
	return out
}

// lane2Upload 走一次真实上传，返回上游收到的 (体, Content-Type, 解析后的部分)。
func lane2Upload(t *testing.T, gw *filesGateway, up *fakeFilesUpstream, build func(mw *multipart.Writer)) ([]byte, string, []lane2Part) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	build(mw)
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	w := doFilesReq(t, gw.r, http.MethodPost, "/v1/files", bytes.NewReader(buf.Bytes()), gw.tokenA, mw.FormDataContentType())
	if w.Code != http.StatusOK {
		t.Fatalf("上传失败: %d %s", w.Code, w.Body.String())
	}
	raw, _ := up.body.Load().(string)
	ct, _ := up.ctype.Load().(string)
	return []byte(raw), ct, lane2ParseParts(t, raw, ct)
}

// lane2CapSeconds 是当前生效的文件保留上限（秒）。
func lane2CapSeconds(gw *filesGateway) int64 {
	return int64(gatewayLimitsFor(gw.db).fileExpiry.Seconds())
}

func lane2Equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// TestFilesUploadExpiryCanonicalFieldsExactlyOnce（M15）：七种客户端形态下，
// 上游收到的过期字段都必须**各恰好一份**、anchor 恒 created_at、seconds 收敛。
func TestFilesUploadExpiryCanonicalFieldsExactlyOnce(t *testing.T) {
	resetBodyParseGate(t)
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")
	capStr := strconv.FormatInt(lane2CapSeconds(gw), 10)

	// 真实客户端形态（llm-deepseek/common/files-api.ts）：purpose→anchor→seconds→file
	t.Run("真实客户端形态", func(t *testing.T) {
		_, _, parts := lane2Upload(t, gw, up, func(mw *multipart.Writer) {
			_ = mw.WriteField("purpose", "user_data")
			_ = mw.WriteField(expiryAnchorField, "created_at")
			_ = mw.WriteField(expirySecondsField, "2592000") // 30 天 ⇒ 收敛
			fw, _ := mw.CreateFormFile("file", "image.webp")
			_, _ = fw.Write([]byte("IMG"))
		})
		if got := lane2Values(parts, expiryAnchorField); len(got) != 1 || got[0] != uploadExpiryAnchor {
			t.Fatalf("anchor 必须恰好一份且为 %s: %v", uploadExpiryAnchor, got)
		}
		if got := lane2Values(parts, expirySecondsField); len(got) != 1 || got[0] != capStr {
			t.Fatalf("seconds 必须恰好一份且收敛到上限 %s: %v", capStr, got)
		}
		if want := []string{"purpose", expiryAnchorField, expirySecondsField, "file:image.webp"}; !lane2Equal(lane2Names(parts), want) {
			t.Fatalf("部分顺序 = %v, want %v", lane2Names(parts), want)
		}
	})

	// 客户端发了两份 anchor + 两份 seconds ⇒ 各收敛成一份（取**更小**的保留期）。
	t.Run("重复字段", func(t *testing.T) {
		_, _, parts := lane2Upload(t, gw, up, func(mw *multipart.Writer) {
			_ = mw.WriteField("purpose", "user_data")
			_ = mw.WriteField(expiryAnchorField, "created_at")
			_ = mw.WriteField(expiryAnchorField, "created_at")
			_ = mw.WriteField(expirySecondsField, "86400")
			_ = mw.WriteField(expirySecondsField, "3600")
			fw, _ := mw.CreateFormFile("file", "a.bin")
			_, _ = fw.Write([]byte("x"))
		})
		if got := lane2Values(parts, expiryAnchorField); len(got) != 1 {
			t.Fatalf("重复 anchor 未被收敛成一份: %v", got)
		}
		if got := lane2Values(parts, expirySecondsField); len(got) != 1 || got[0] != "3600" {
			t.Fatalf("重复 seconds 应取更小的一份(3600): %v", got)
		}
	})

	// 只给 anchor（缺 seconds）：seconds 必须补上限 —— 否则上游按默认/永久保存，
	// 平台上限只落在台账里（回收失效时对象永不消失）。
	t.Run("只给 anchor", func(t *testing.T) {
		_, _, parts := lane2Upload(t, gw, up, func(mw *multipart.Writer) {
			_ = mw.WriteField(expiryAnchorField, "created_at")
			fw, _ := mw.CreateFormFile("file", "b.bin")
			_, _ = fw.Write([]byte("x"))
		})
		if got := lane2Values(parts, expirySecondsField); len(got) != 1 || got[0] != capStr {
			t.Fatalf("只给 anchor 时必须补上限 seconds: %v", got)
		}
		if got := lane2Values(parts, expiryAnchorField); len(got) != 1 {
			t.Fatalf("anchor 数量不对: %v", got)
		}
	})

	// 只给 seconds（缺 anchor）：补 anchor=created_at，且不得出现第二份 seconds。
	t.Run("只给 seconds", func(t *testing.T) {
		_, _, parts := lane2Upload(t, gw, up, func(mw *multipart.Writer) {
			_ = mw.WriteField(expirySecondsField, "7200")
			fw, _ := mw.CreateFormFile("file", "c.bin")
			_, _ = fw.Write([]byte("x"))
		})
		if got := lane2Values(parts, expiryAnchorField); len(got) != 1 || got[0] != uploadExpiryAnchor {
			t.Fatalf("只给 seconds 时必须补 anchor: %v", got)
		}
		if got := lane2Values(parts, expirySecondsField); len(got) != 1 || got[0] != "7200" {
			t.Fatalf("seconds 应恰好一份且保留客户端的 7200: %v", got)
		}
	})

	// 整对象 JSON 写法：只出这一份，不混发扁平字段（旧实现会额外补一个 anchor）。
	t.Run("整对象JSON", func(t *testing.T) {
		_, _, parts := lane2Upload(t, gw, up, func(mw *multipart.Writer) {
			_ = mw.WriteField(expiryJSONField, `{"anchor":"created_at","seconds":43200}`)
			fw, _ := mw.CreateFormFile("file", "d.bin")
			_, _ = fw.Write([]byte("x"))
		})
		if n := lane2Count(parts, expiryJSONField); n != 1 {
			t.Fatalf("整对象写法应恰好一份: %d", n)
		}
		if n := lane2Count(parts, expiryAnchorField) + lane2Count(parts, expirySecondsField); n != 0 {
			t.Fatalf("整对象写法不得混发扁平过期字段（旧实现会追加 anchor）: %d 份", n)
		}
		var obj map[string]any
		if err := json.Unmarshal([]byte(lane2Values(parts, expiryJSONField)[0]), &obj); err != nil {
			t.Fatalf("expires_after 不是 JSON 对象: %v", err)
		}
		if obj["anchor"] != uploadExpiryAnchor || obj["seconds"].(float64) != 43200 {
			t.Fatalf("整对象内容不对: %v", obj)
		}
	})

	// file 部分在过期字段**之前**（合法 multipart；旧实现会插入上限 + 透传客户端那份
	// ⇒ seconds 两份）。
	t.Run("file在前", func(t *testing.T) {
		_, _, parts := lane2Upload(t, gw, up, func(mw *multipart.Writer) {
			fw, _ := mw.CreateFormFile("file", "e.bin")
			_, _ = fw.Write([]byte("x"))
			_ = mw.WriteField("purpose", "user_data")
			_ = mw.WriteField(expirySecondsField, "86400")
		})
		if got := lane2Values(parts, expirySecondsField); len(got) != 1 || got[0] != "86400" {
			t.Fatalf("file 在前的形态下 seconds 必须恰好一份: %v", got)
		}
		if got := lane2Values(parts, expiryAnchorField); len(got) != 1 {
			t.Fatalf("file 在前的形态下 anchor 数量不对: %v", got)
		}
		if got := lane2Names(parts); len(got) != 4 ||
			got[0] != expiryAnchorField || got[1] != expirySecondsField ||
			got[2] != "file:e.bin" || got[3] != "purpose" {
			t.Fatalf("规范字段必须写在第一个过期字段处、其它顺序保持: %v", got)
		}
	})

	// 混发两种形态：只保留**先出现**的那种（不产生两套过期语义），后出现的更小值仍收紧。
	t.Run("两种形态混发", func(t *testing.T) {
		_, _, parts := lane2Upload(t, gw, up, func(mw *multipart.Writer) {
			_ = mw.WriteField(expiryJSONField, `{"anchor":"created_at","seconds":86400}`)
			_ = mw.WriteField(expirySecondsField, "3600")
			fw, _ := mw.CreateFormFile("file", "f.bin")
			_, _ = fw.Write([]byte("x"))
		})
		if n := lane2Count(parts, expiryJSONField); n != 1 {
			t.Fatalf("应以先出现的整对象形态为准: %d 份", n)
		}
		if n := lane2Count(parts, expiryAnchorField) + lane2Count(parts, expirySecondsField); n != 0 {
			t.Fatalf("混发时不得再出扁平字段: %d 份", n)
		}
		var obj map[string]any
		if err := json.Unmarshal([]byte(lane2Values(parts, expiryJSONField)[0]), &obj); err != nil {
			t.Fatal(err)
		}
		if obj["seconds"].(float64) != 3600 {
			t.Fatalf("后出现的更小 seconds 应收紧生效值: %v", obj["seconds"])
		}
	})

	// 没有任何过期字段：在 file 之前补两个（元数据在前）。
	t.Run("完全没带", func(t *testing.T) {
		_, _, parts := lane2Upload(t, gw, up, func(mw *multipart.Writer) {
			_ = mw.WriteField("purpose", "user_data")
			fw, _ := mw.CreateFormFile("file", "g.bin")
			_, _ = fw.Write([]byte("x"))
		})
		if got := lane2Values(parts, expirySecondsField); len(got) != 1 || got[0] != capStr {
			t.Fatalf("缺省应补上限 seconds: %v", got)
		}
		if got := lane2Values(parts, expiryAnchorField); len(got) != 1 {
			t.Fatalf("缺省应补 anchor: %v", got)
		}
		if got := lane2Names(parts); len(got) != 4 || got[0] != "purpose" || got[3] != "file:g.bin" {
			t.Fatalf("规范字段应写在 file 之前: %v", got)
		}
	})
}

// TestFilesUploadExpiryJSONBoundaries（M18）：整对象写法的四个边界。
func TestFilesUploadExpiryJSONBoundaries(t *testing.T) {
	resetBodyParseGate(t)
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")
	capSeconds := lane2CapSeconds(gw)
	capStr := strconv.FormatInt(capSeconds, 10)

	t.Run("合法JSON收敛上限", func(t *testing.T) {
		_, _, parts := lane2Upload(t, gw, up, func(mw *multipart.Writer) {
			_ = mw.WriteField(expiryJSONField, `{"anchor":"created_at","seconds":1e300}`)
			fw, _ := mw.CreateFormFile("file", "a.bin")
			_, _ = fw.Write([]byte("x"))
		})
		var obj map[string]any
		if err := json.Unmarshal([]byte(lane2Values(parts, expiryJSONField)[0]), &obj); err != nil {
			t.Fatal(err)
		}
		if int64(obj["seconds"].(float64)) != capSeconds {
			t.Fatalf("1e300 必须收敛到上限: %v", obj["seconds"])
		}
	})

	t.Run("seconds字符串", func(t *testing.T) {
		// 形态漂移（字符串而不是 number）：按"读不懂 ⇒ 上限"处理，与扁平的
		// "seconds 解析失败即按没带来处理" 同口径 —— 绝不静默放过。
		_, _, parts := lane2Upload(t, gw, up, func(mw *multipart.Writer) {
			_ = mw.WriteField(expiryJSONField, `{"anchor":"created_at","seconds":"86400"}`)
			fw, _ := mw.CreateFormFile("file", "b.bin")
			_, _ = fw.Write([]byte("x"))
		})
		var obj map[string]any
		if err := json.Unmarshal([]byte(lane2Values(parts, expiryJSONField)[0]), &obj); err != nil {
			t.Fatal(err)
		}
		if int64(obj["seconds"].(float64)) != capSeconds {
			t.Fatalf("字符串 seconds 应收敛到上限: %v", obj["seconds"])
		}
	})

	t.Run("非法JSON退化成规范扁平字段", func(t *testing.T) {
		// 小体积的不可解析值：读得全、也改得起 ⇒ 用规范扁平字段取代它（否则上游会
		// 收到一份我们读不懂的垃圾，而且没有 seconds ⇒ 上游按默认保留期存）。
		_, _, parts := lane2Upload(t, gw, up, func(mw *multipart.Writer) {
			_ = mw.WriteField(expiryJSONField, `{not json`)
			fw, _ := mw.CreateFormFile("file", "c.bin")
			_, _ = fw.Write([]byte("x"))
		})
		if n := lane2Count(parts, expiryJSONField); n != 0 {
			t.Fatalf("不可解析的整对象值不得原样透传: %d 份", n)
		}
		if got := lane2Values(parts, expirySecondsField); len(got) != 1 || got[0] != capStr {
			t.Fatalf("非法 JSON 应收敛成上限扁平字段: %v", got)
		}
		if got := lane2Values(parts, expiryAnchorField); len(got) != 1 {
			t.Fatalf("非法 JSON 应补 anchor: %v", got)
		}
	})

	t.Run("超过4KiB整段原样转发", func(t *testing.T) {
		big := `{"anchor":"created_at","seconds":2592000,"pad":"` + strings.Repeat("x", maxExpiryJSONBytes+10) + `"}`
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		_ = mw.WriteField(expiryJSONField, big)
		fw, _ := mw.CreateFormFile("file", "d.bin")
		_, _ = fw.Write([]byte("payload"))
		_ = mw.Close()
		ct := mw.FormDataContentType()
		w := doFilesReq(t, gw.r, http.MethodPost, "/v1/files", bytes.NewReader(buf.Bytes()), gw.tokenA, ct)
		if w.Code != http.StatusOK {
			t.Fatalf("上传失败: %d %s", w.Code, w.Body.String())
		}
		if got, _ := up.body.Load().(string); got != buf.String() {
			t.Fatalf("超长整对象必须整段原样转发（不得截断改写）: len=%d want=%d", len(got), buf.Len())
		}
		if got, _ := up.ctype.Load().(string); got != ct {
			t.Fatalf("Content-Type/boundary 被改写: %q want %q", got, ct)
		}
	})
}

// TestFilesUploadPreservesBytesAndPartHeaders：重写的**字节保真**判据 ——
// 文件内容（CRLF、形似 boundary 的串、NUL、非 UTF-8 字节）、文件名、part 自定义头、
// 其它字段的值与相对顺序都必须逐字节保留。
func TestFilesUploadPreservesBytesAndPartHeaders(t *testing.T) {
	resetBodyParseGate(t)
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	// 先建一个 multipart 拿到 boundary，再把它（含 CRLF）塞进文件内容 —— 这正是
	// "客户端 boundary 出现在内容里"的形态：重写换了新 boundary，内容必须一字不改。
	var seed bytes.Buffer
	seedW := multipart.NewWriter(&seed)
	clientBoundary := seedW.Boundary()
	_ = seedW.Close()
	const messyName = "im age\r\n.webp"

	payload := []byte("head\r\n--" + clientBoundary + "\r\nmid\x00\xff\xfe\r\n\r\n--tail\r\n")
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	_ = mw.WriteField("purpose", "user_data")
	_ = mw.WriteField(expiryAnchorField, "created_at")
	_ = mw.WriteField(expirySecondsField, "2592000")
	fw, err := mw.CreatePart(map[string][]string{
		"Content-Disposition": {`form-data; name="file"; filename="` + strings.ReplaceAll(messyName, "\r\n", "%0D%0A") + `"`},
		"Content-Type":        {"image/webp"},
		"X-Client-Trace":      {"trace-1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fw.Write(payload); err != nil {
		t.Fatal(err)
	}
	_ = mw.WriteField("after_file", "kept-after-file")
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	w := doFilesReq(t, gw.r, http.MethodPost, "/v1/files", bytes.NewReader(buf.Bytes()), gw.tokenA, mw.FormDataContentType())
	if w.Code != http.StatusOK {
		t.Fatalf("上传失败: %d %s", w.Code, w.Body.String())
	}
	rawUp, _ := up.body.Load().(string)
	ctUp, _ := up.ctype.Load().(string)
	parts := lane2ParseParts(t, rawUp, ctUp)

	var file *lane2Part
	for i := range parts {
		if parts[i].filename != "" {
			file = &parts[i]
		}
	}
	if file == nil {
		t.Fatal("上游没收到文件部分")
	}
	if !bytes.Equal(file.value, payload) {
		t.Fatalf("文件字节被破坏:\n got=%q\nwant=%q", file.value, payload)
	}
	if file.filename != strings.ReplaceAll(messyName, "\r\n", "%0D%0A") {
		t.Fatalf("文件名被改写: %q", file.filename)
	}
	if got := file.header.Get("Content-Type"); got != "image/webp" {
		t.Fatalf("file part 的 Content-Type 丢失/被覆写: %q", got)
	}
	if got := file.header.Get("X-Client-Trace"); got != "trace-1" {
		t.Fatalf("file part 的自定义头丢失: %q", got)
	}
	if got := lane2Values(parts, "purpose"); len(got) != 1 || got[0] != "user_data" {
		t.Fatalf("其它字段被破坏: %v", got)
	}
	// 其它字段的相对顺序保持（after_file 原本在 file 之后）。
	names := lane2Names(parts)
	if len(names) != 5 || names[3] != "file:"+file.filename || names[4] != "after_file" {
		t.Fatalf("部分顺序被改动: %v", names)
	}
}

// TestFilesUploadStructuralDamageForwardedUnchanged：multipart **结构损坏**（缺终止
// boundary）⇒ 整段原样转发（boundary/Content-Type 都不动），由上游去拒绝。
func TestFilesUploadStructuralDamageForwardedUnchanged(t *testing.T) {
	resetBodyParseGate(t)
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	body, ct := multipartBytes(t, "truncated")
	// 切掉终止 boundary（最后一行 `--<boundary>--\r\n`）。
	cut := bytes.LastIndex(body, []byte("--"))
	if cut <= 0 {
		t.Fatalf("夹具没找到终止 boundary: %q", ct)
	}
	truncated := body[:cut]

	w := doFilesReq(t, gw.r, http.MethodPost, "/v1/files", bytes.NewReader(truncated), gw.tokenA, ct)
	if w.Code != http.StatusOK {
		t.Fatalf("结构损坏的体应原样转发（由上游拒绝），实得 %d (%s)", w.Code, w.Body.String())
	}
	if got, _ := up.body.Load().(string); got != string(truncated) {
		t.Fatalf("结构损坏的体被改动了（%d → %d 字节）", len(truncated), len(got))
	}
	if got, _ := up.ctype.Load().(string); got != ct {
		t.Fatalf("Content-Type 被改写: %q want %q", got, ct)
	}
}
