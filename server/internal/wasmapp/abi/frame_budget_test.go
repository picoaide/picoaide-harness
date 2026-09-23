package abi

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 本文件是 ABI-1（P2，2026-09-23 独立审计）的回归门禁。三条判据：
//
//  1. `ReadFrame` 遇到超限帧必须**排空载荷**（修复前把 n 字节留在流里 ⇒ 读者失同步：
//     下一次读到的是一帧载荷的中段，而不是 RS 帧头）；
//  2. 装不进一帧的 `assets.read` 结果必须归一成 **ASSET_OVERSIZE**（修复前：宿主写出
//     超帧 → guest ReadFrame 报 ErrFrameTooLarge 且失同步 → 宿主那条写因没人读而阻塞到
//     预算用尽 ⇒ 应用拿到 RUNTIME_TIMEOUT，与病因无关）；
//  3. 对外口径（headerspec 的 `response_body_bytes_max`、diag 的提示）必须用**可交付**
//     的数（`MaxResponseBodyBytes`），而不是不可达的 8 MiB。
//
// 变异验证（实跑，见交付报告）：
//   - 删掉 ReadFrame 里的 `io.CopyN(io.Discard, …)` ⇒ TestReadFrameDrainsOversizeAndResyncs 红；
//   - 删掉 RPCResponse.MarshalJSON 的超帧改写 ⇒ TestOversizeAssetResultBecomesAssetOversize 红；
//   - 把 MaxResponseBodyBytes 改回 limits.AppResponseBodyMaxBytes ⇒
//     TestDeclaredResponseBodyBudgetIsDeliverable 红（512 KiB 体量编码后必然 > 1 MiB 帧）。

// TestReadFrameDrainsOversizeAndResyncs 是失同步的判据。
//
// 构造：一条声明 2 MiB 的超限帧（载荷真实写出）+ 紧随其后的一条正常帧。
// 断言：第一条报 ErrFrameTooLarge；**第二条必须能正常读出**。
func TestReadFrameDrainsOversizeAndResyncs(t *testing.T) {
	const payload = 2 << 20 // > MaxFrameBytes, ≤ MaxFrameDrainBytes

	var stream bytes.Buffer
	stream.Write(FrameHeader(payload))
	stream.Write(bytes.Repeat([]byte{'A'}, payload))
	next := EncodeFrame([]byte(`{"status":200}`))
	stream.Write(next)

	r := bufio.NewReader(&stream)
	if _, err := ReadFrame(r); !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("第一条应为 ErrFrameTooLarge，实得 %v", err)
	}
	got, err := ReadFrame(r)
	if err != nil {
		t.Fatalf("排空后必须能读出下一条帧（修复前这里失同步）：%v", err)
	}
	if string(got) != `{"status":200}` {
		t.Fatalf("第二条帧负载 = %q", got)
	}
}

// TestReadFrameOversizeWithoutPayloadStillReportsTooLarge 钉住"排空失败不改主错误"：
// 只有长度前缀、载荷缺失时，错误必须仍是 ErrFrameTooLarge（不是 ErrFrameTruncated）。
func TestReadFrameOversizeWithoutPayload(t *testing.T) {
	r := bufio.NewReader(bytes.NewReader(FrameHeader(MaxFrameBytes + 1)))
	if _, err := ReadFrame(r); !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("err=%v want ErrFrameTooLarge", err)
	}
}

// TestReadFrameBeyondDrainCapDoesNotConsume 钉住排空上界：声明超过 MaxFrameDrainBytes 的
// 帧**不排空**（对端不是本平台实现 ⇒ 调用方必须终止连接，不能为一条畸形帧无限读下去）。
//
// 判据：ReadFrame 之后紧跟的那一字节仍可读回（证明没消费）。
func TestReadFrameBeyondDrainCapDoesNotConsume(t *testing.T) {
	var stream bytes.Buffer
	stream.Write(FrameHeader(MaxFrameDrainBytes + 1))
	stream.Write([]byte("WXYZ"))

	r := bufio.NewReader(&stream)
	if _, err := ReadFrame(r); !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("err=%v want ErrFrameTooLarge", err)
	}
	b, err := r.ReadByte()
	if err != nil {
		t.Fatalf("超出排空上界时不得消费载荷：%v", err)
	}
	if b != 'W' {
		t.Fatalf("流首字节 = %q，want 'W'（说明载荷被消费了）", b)
	}
}

// TestReadFrameDrainCapCoversPlatformWriters 钉住排空上界与平台自身写入量的关系：
// 宿主 → guest 的 RPC 应答最大形态是"响应体上限 + base64 膨胀 + 信封"⇒ 排空上界必须
// 覆盖 limits.AppResponseBodyMaxBytes（否则平台自己的超帧无法重同步）。
func TestReadFrameDrainCapCoversPlatformWriters(t *testing.T) {
	if MaxFrameDrainBytes < limits.AppResponseBodyMaxBytes {
		t.Fatalf("MaxFrameDrainBytes=%d 小于平台响应体上限 %d：平台自己的超帧将无法重同步",
			MaxFrameDrainBytes, limits.AppResponseBodyMaxBytes)
	}
}

// TestOversizeAssetResultBecomesAssetOversize 是 ABI-1 的**错误码归一**判据：
// 4 MiB 随包资源（base64 后 5.3 MiB）经 `assets.read` ⇒ 编码结果必然超过单帧 ⇒
// 必须变成 ASSET_OVERSIZE 的错误信封（同 id、几百字节），guest 能读到且不失同步。
func TestOversizeAssetResultBecomesAssetOversize(t *testing.T) {
	raw := bytes.Repeat([]byte{0xab}, limits.SectionTotalMaxBytes) // 4 MiB 单文件上限
	res := AssetsReadResult{
		ContentType: "application/octet-stream",
		Size:        len(raw),
		Encoding:    EncodingBase64,
		Base64:      base64.StdEncoding.EncodeToString(raw),
	}
	if plain, err := json.Marshal(res); err != nil || len(plain) <= MaxFrameBytes {
		t.Fatalf("前置条件不成立：单个 assets.read 结果应当装不进一帧（len=%d err=%v）", len(plain), err)
	}

	resp := NewRPCResult(json.RawMessage(`7`), res)
	frame, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("编码失败：%v", err)
	}
	if len(frame) > MaxFrameBytes {
		t.Fatalf("编码结果 %d 字节仍超过单帧上限 %d（改写未生效）", len(frame), MaxFrameBytes)
	}

	var back RPCResponse
	if err := json.Unmarshal(frame, &back); err != nil {
		t.Fatalf("改写后的应答不是合法 RPCResponse：%v", err)
	}
	if back.Error == nil {
		t.Fatalf("超帧必须改写成错误信封，实得 result=%v", back.Result)
	}
	if back.Error.Code != string(apperr.CodeAssetOversize) {
		t.Fatalf("错误码 = %q，want %q", back.Error.Code, apperr.CodeAssetOversize)
	}
	if CodeAssetOversize != string(apperr.CodeAssetOversize) {
		t.Fatalf("abi.CodeAssetOversize 字面量 %q 与 apperr 真源 %q 漂移",
			CodeAssetOversize, apperr.CodeAssetOversize)
	}
	if string(back.ID) != "7" {
		t.Fatalf("id 必须保留（guest 靠它配对），实得 %s", back.ID)
	}
	if got, _ := back.Error.Details["asset_bytes"].(float64); int(got) != len(raw) {
		t.Fatalf("details.asset_bytes = %v，want %d", back.Error.Details["asset_bytes"], len(raw))
	}

	// 端到端：这一帧之后紧跟一条正常帧，guest 侧必须两条都能读（不失同步）。
	var stream bytes.Buffer
	stream.Write(EncodeFrame(frame))
	stream.Write(EncodeFrame([]byte(`{"status":204}`)))
	r := bufio.NewReader(&stream)
	first, err := ReadFrame(r)
	if err != nil {
		t.Fatalf("改写后的帧必须可读：%v", err)
	}
	if !bytes.Equal(first, frame) {
		t.Fatal("读回的帧与写入的不一致")
	}
	if second, err := ReadFrame(r); err != nil || string(second) != `{"status":204}` {
		t.Fatalf("下一帧解析失败（失同步）：%q %v", second, err)
	}
}

// TestSmallAssetResultIsNotRewritten 是反向对照：预算内的 assets.read 结果**不得**被改写
// （否则"资源读得到"会被静默降级成"资源超限"）。
func TestSmallAssetResultIsNotRewritten(t *testing.T) {
	res := AssetsReadResult{ContentType: "text/plain", Size: 5, Encoding: EncodingText, Text: "hello"}
	frame, err := json.Marshal(NewRPCResult(json.RawMessage(`1`), res))
	if err != nil {
		t.Fatalf("编码失败：%v", err)
	}
	var back RPCResponse
	if err := json.Unmarshal(frame, &back); err != nil {
		t.Fatalf("解析失败：%v", err)
	}
	if back.Error != nil {
		t.Fatalf("小结果不得被改写：%+v", back.Error)
	}
	if back.Result == nil {
		t.Fatal("小结果必须原样保留")
	}
	// 非 assets.read 的其它结果类型维持原行为（不扩大改写面）。
	other := NewRPCResult(json.RawMessage(`2`), ExecResult{RowsAffected: 1})
	b, err := json.Marshal(other)
	if err != nil || !strings.Contains(string(b), "rows_affected") {
		t.Fatalf("其它结果类型被误改：%s %v", b, err)
	}
}

// TestDeclaredResponseBodyBudgetIsDeliverable 钉住对外口径的**可交付性**：
// 声明为上限的体量（MaxResponseBodyBytes）必须真的能装进一个帧（含响应头与 JSON 信封）。
//
// 变异：把 MaxResponseBodyBytes 改回 limits.AppResponseBodyMaxBytes(8 MiB) ⇒ 本用例红。
func TestDeclaredResponseBodyBudgetIsDeliverable(t *testing.T) {
	if MaxResponseBodyBytes > MaxFrameBytes {
		t.Fatalf("响应体上限 %d 大于单帧上限 %d（不可交付）", MaxResponseBodyBytes, MaxFrameBytes)
	}
	resp := NewRPCResult(json.RawMessage(`1`), Response{
		Status:  200,
		Headers: map[string]string{"content-type": "text/plain; charset=utf-8"},
		Body:    strings.Repeat("a", MaxResponseBodyBytes),
	})
	encoded, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("编码失败：%v", err)
	}
	if len(encoded) > MaxFrameBytes {
		t.Fatalf("声明为可交付的体量（%d B）编码后 %d B 超过单帧上限 %d",
			MaxResponseBodyBytes, len(encoded), MaxFrameBytes)
	}
}
