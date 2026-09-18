package upload

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 本文件用**真文件系统**钉住分片上传会话的全部边界（§4.2）。
//
// 纪律：
//   - 不 mock os：会话存储的正确性一半在"哪个文件在什么时候落盘"，mock 掉就等于
//     把被测对象换成 mock 的假设；
//   - 时钟**注入**（不看真实时间）：过期与回收是 TTL 语义，等 30 分钟不是测试；
//   - 每条安全闸门至少一条用例，且**变异后必红**（下面逐条写明变异方式）。
//
// 变异方式（改回危险实现时哪条必红 —— 全部**已实测**，见交付说明）：
//   - 去掉 dirChecked 的形态闸（或把 ValidID 挪到拼路径之后）⇒
//     TestPathTraversalCannotEscapeRoot 红（受害目录被写入；只删这一道时父目录断言
//     会把 404 变成 500，同样红）；
//   - 把跨用户判据（sess.Publisher != publisher）删掉 ⇒
//     TestCrossUserIsIndistinguishableFromUnknown 红；
//   - 把过期回收（openLocked 里的 RemoveAll）删掉 ⇒
//     TestExpiredSessionIsReclaimed 红（目录还在）；
//   - 把增量闸门（receivedBytes+incoming > TotalBytes）删掉 ⇒
//     TestIncrementalOverflowDoesNotTouchDisk 红；
//   - 把 min/max 片尺寸判据删掉 ⇒ TestChunkSizeRules 红；
//   - 把会话锁（lockSession）删掉 ⇒ TestPutConcurrentChunksKeepBoth 红
//     （meta.json 丢更新：received 少一片）；
//   - 把"成功后删目录"删掉 ⇒ TestCompleteSuccessDeletesSessionAndCachesBody 红；
//   - 把"失败保留会话"改成失败也删 ⇒ TestCompleteFailureKeepsSession 红。

// testStore 是带注入时钟的 Store 夹具（时钟可前后拨动）。
type testStore struct {
	t    *testing.T
	s    *Store
	root string
	now  time.Time
	mu   sync.Mutex // 保护 now（并发用例里时钟只读，但读也要有可见性保证）
}

func newTestStore(t *testing.T) *testStore {
	t.Helper()
	ts := &testStore{t: t, now: time.Unix(1_700_000_000, 0).UTC()}
	ts.s = New(Options{
		DataRoot: t.TempDir(),
		Now:      func() time.Time { return ts.clock() },
		Logger:   func(string, ...any) {}, // 用例里静音（回收失败另有专门用例断言）
	})
	ts.root = ts.s.Root()
	return ts
}

func (ts *testStore) clock() time.Time {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	return ts.now
}

func (ts *testStore) advance(d time.Duration) {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	ts.now = ts.now.Add(d)
}

// create 开一个会话（默认 3 片）。
func (ts *testStore) create(publisher string, total, chunk int64) *Session {
	ts.t.Helper()
	sess, err := ts.s.Create(publisher, CreateInput{
		AppID: "demo-app", Version: "1.0.0", TotalBytes: total, ChunkBytes: chunk,
	})
	if err != nil {
		ts.t.Fatalf("开会话失败: %v", err)
	}
	return sess
}

// mustErr 断言错误码与 HTTP 状态（§7.4 表 + §8 信封）。
func mustErr(t *testing.T, err *apperr.Error, code apperr.Code, status int) *apperr.Error {
	t.Helper()
	if err == nil {
		t.Fatalf("期望错误 %s/%d，实际成功", code, status)
	}
	if err.Code != code {
		t.Fatalf("错误码 = %s, want %s（message=%s）", err.Code, code, err.Message)
	}
	if err.Status() != status {
		t.Fatalf("HTTP 状态 = %d, want %d（code=%s message=%s）", err.Status(), status, err.Code, err.Message)
	}
	return err
}

// blob 生成可辨识的载荷（第 i 字节 = seed+i，便于断言"拼装顺序正确"）。
func blob(n int, seed byte) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = seed + byte(i%251)
	}
	return out
}

// split 按 chunk 大小切分（最后一片是余数）。
func split(payload []byte, chunk int) [][]byte {
	var out [][]byte
	for off := 0; off < len(payload); off += chunk {
		end := off + chunk
		if end > len(payload) {
			end = len(payload)
		}
		out = append(out, payload[off:end])
	}
	if len(out) == 0 {
		out = append(out, nil)
	}
	return out
}

// ---------------------------------------------------------------------------
// 1. 创建：布局与不可枚举
// ---------------------------------------------------------------------------

func TestCreateSessionLayout(t *testing.T) {
	ts := newTestStore(t)
	sess := ts.create("alice", 3*64<<10, 64<<10)

	if !ValidID(sess.UploadID) {
		t.Fatalf("upload_id 形态非法: %q", sess.UploadID)
	}
	if strings.ToLower(sess.UploadID) != sess.UploadID {
		t.Fatalf("upload_id 必须小写十六进制: %q", sess.UploadID)
	}
	dir := filepath.Join(ts.root, sess.UploadID)
	fi, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("会话目录不存在: %v", err)
	}
	if fi.Mode().Perm() != os.FileMode(limits.DataDirMode) {
		t.Fatalf("会话目录权限 = %o, want %o", fi.Mode().Perm(), limits.DataDirMode)
	}
	if sess.ExpiresAt.Sub(sess.CreatedAt) != limits.UploadSessionTTL {
		t.Fatalf("有效期 = %s, want %s", sess.ExpiresAt.Sub(sess.CreatedAt), limits.UploadSessionTTL)
	}
	// meta.json 必须存在且自描述（§4.2 的布局就是契约的一部分）。
	raw, rerr := os.ReadFile(filepath.Join(dir, metaFileName))
	if rerr != nil {
		t.Fatalf("meta.json 不存在: %v", rerr)
	}
	var meta map[string]any
	if uerr := json.Unmarshal(raw, &meta); uerr != nil {
		t.Fatalf("meta.json 不是 JSON: %v", uerr)
	}
	for _, key := range []string{"app_id", "version", "publisher", "total_bytes", "chunk_bytes", "received", "created_at", "expires_at"} {
		if _, ok := meta[key]; !ok {
			t.Errorf("meta.json 缺字段 %s（§4.2 指定了字段集）", key)
		}
	}
	// received 必须是 `[]` 而不是 `null`（客户端不该多一层判空）。
	if !strings.Contains(string(raw), `"received":[]`) {
		t.Errorf("created 会话的 received 应为空数组: %s", raw)
	}
	if sess.ChunkCount() != 3 {
		t.Fatalf("片数 = %d, want 3", sess.ChunkCount())
	}
	// 32 字节 crypto/rand 的另一个判据：两次创建的 id 必须不同。
	if other := ts.create("alice", 64<<10, 64<<10); other.UploadID == sess.UploadID {
		t.Fatalf("两次创建拿到同一个 upload_id: %s", other.UploadID)
	}
}

func TestCreateRejectsBadInput(t *testing.T) {
	ts := newTestStore(t)
	base := CreateInput{AppID: "demo-app", Version: "1.0.0", TotalBytes: 64 << 10, ChunkBytes: 64 << 10}
	cases := []struct {
		name   string
		mutate func(*CreateInput)
		code   apperr.Code
		status int
	}{
		{"app_id 含大写（§10.5 第 52 项）", func(in *CreateInput) { in.AppID = "Demo-App" }, apperr.CodeInvalidAppID, 400},
		{"app_id 是保留字（§10.5 第 53b 项）", func(in *CreateInput) { in.AppID = "www" }, apperr.CodeInvalidAppID, 400},
		{"app_id 纯数字（IP 形态）", func(in *CreateInput) { in.AppID = "12345" }, apperr.CodeInvalidAppID, 400},
		{"app_id 以 xn-- 开头", func(in *CreateInput) { in.AppID = "xn--fiq" }, apperr.CodeInvalidAppID, 400},
		{"version 非 x.y.z（§10.5 第 54 项）", func(in *CreateInput) { in.Version = "1.0" }, apperr.CodeVersionInvalid, 400},
		{"total_bytes 为 0", func(in *CreateInput) { in.TotalBytes = 0 }, apperr.CodeValidation, 400},
		{"total_bytes 为负", func(in *CreateInput) { in.TotalBytes = -1 }, apperr.CodeValidation, 400},
		{"total_bytes 超 32 MiB（R33）", func(in *CreateInput) { in.TotalBytes = limits.WasmMaxBytes + 1 }, apperr.CodeWasmTooLarge, 413},
		{"chunk_bytes 低于下限", func(in *CreateInput) { in.ChunkBytes = limits.UploadChunkMinBytes - 1 }, apperr.CodeValidation, 400},
		{"chunk_bytes 超上限", func(in *CreateInput) { in.ChunkBytes = limits.UploadChunkMaxBytes + 1 }, apperr.CodeValidation, 400},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := base
			tc.mutate(&in)
			_, err := ts.s.Create("alice", in)
			mustErr(t, err, tc.code, tc.status)
			// 被拒的创建不得留下任何目录。
			entries, _ := os.ReadDir(ts.root)
			if len(entries) != 0 {
				t.Fatalf("被拒的创建留下了目录: %v", entries)
			}
		})
	}
}

// TestCapGatesAreStructurallyBounded 记录"纵深防御闸门"与"真的可达的闸门"的分界。
//
// 片数上限（UploadMaxChunks）在当前数值下**不可达**（32 MiB / 64 KiB 下限 = 512 片），
// 保留它是为了未来放宽 WasmMaxBytes 或调小片下限时它已经在位 —— 这条"不可达"本身写成
// 断言，一旦有人改了数值让它变成唯一防线，这里会先红。
//
// 每用户磁盘配额则相反：它**必须可达**（审计 FIX-44）。可达性判据（含变异说明）在
// TestPerUserDiskQuotaGateIsReachableAndPrecedesSessionCap，这里只钉住它的**数值前提** ——
// 配额必须严格小于"会话数上限 × 整包上限"，否则任何实现都只能写出永远为假的守卫。
//
// 变异方式（改 limits 数值 ⇒ 本用例必红，已实测）：把 UploadBodyMaxBytes 抬到
// ≥ WasmMaxBytes × UploadSessionsPerUser（例如 256 MiB）⇒ 下面那条断言先红。它拦的是
// "只改数字、不改设计"：那种改法会让配额闸门重新变成装饰，必须重新设计闸门而不是调参。
func TestCapGatesAreStructurallyBounded(t *testing.T) {
	maxChunks := chunkCount(limits.WasmMaxBytes, limits.UploadChunkMinBytes)
	if maxChunks > limits.UploadMaxChunks {
		t.Fatalf("最坏情况下片数 %d 超过上传片数上限 %d：UploadMaxChunks 已不是纵深防御而是必需闸门", maxChunks, limits.UploadMaxChunks)
	}
	maxDeclared := int64(limits.WasmMaxBytes) * int64(limits.UploadSessionsPerUser)
	if int64(limits.UploadBodyMaxBytes) >= maxDeclared {
		t.Fatalf("每用户配额 %d ≥ 会话数上限 × 整包上限 %d：配额闸门会退化成不可达的装饰"+
			"（审计 P2-1 的原始缺陷形态）", int64(limits.UploadBodyMaxBytes), maxDeclared)
	}
	t.Logf("结构分界：片数闸门是纵深防御（可达上界 %d ≤ %d）；磁盘配额闸门必须可达"+
		"（%d < %d ⇒ 大会话先撞配额、小会话先撞会话数）",
		maxChunks, limits.UploadMaxChunks, int64(limits.UploadBodyMaxBytes), maxDeclared)
}

// TestPerUserDiskQuotaGateIsReachableAndPrecedesSessionCap：审计 FIX-44 的核心判据。
//
// 旧实现的配额闸门是 `UploadBodyMaxBytes × UploadSessionsPerUser`（192 MiB），而单会话
// 声明量上界只有 WasmMaxBytes（32 MiB）：取到上界的那组输入恰好等于上界，严格 `>` 恒假
// ⇒ **对任何会话数上限都永远打不到**（审计实测：第 5 个会话被拒的是会话数闸门）。
// 现在配额 = **每用户未完成上传的预留总量 ≤ limits.UploadBodyMaxBytes（48 MiB）**。
//
// 三段断言（缺一不可）：
//  1. **可达且先于会话数闸门**：已有一个 32 MiB 的会话（live=1 < 4）时再开一个 32 MiB 的
//     会话 ⇒ 必须是配额闸门 413（不是会话数闸门 429），且拒绝时 live < 上限；
//  2. **两条闸门都不是摆设**：4 个 8 MiB 的声明（合计 32 MiB ≤ 配额）全都开得出来，
//     第 5 个由**会话数**闸门拒绝（RATE_LIMITED + max_sessions）—— 谁先撞取决于输入；
//  3. **结构条件**：配额 < 会话数上限 × 整包上限（见 TestCapGatesAreStructurallyBounded）。
//
// 变异方式（改回缺陷实现 ⇒ 本用例必红，已实测）：
//   - 配额改回 `UploadBodyMaxBytes × UploadSessionsPerUser`（或任何 ≥ 128 MiB 的值）⇒
//     第 1 段红（第二个 32 MiB 会话被接受）；
//   - 删掉配额闸门 ⇒ 第 1 段红（第二个会话被接受）。
func TestPerUserDiskQuotaGateIsReachableAndPrecedesSessionCap(t *testing.T) {
	ts := newTestStore(t)
	quota := int64(limits.UploadBodyMaxBytes)

	// --- 1. 可达且先于会话数闸门 ---
	if _, err := ts.s.Create("alice", CreateInput{
		AppID: "demo-app", Version: "1.0.0",
		TotalBytes: limits.WasmMaxBytes, ChunkBytes: limits.UploadChunkMaxBytes,
	}); err != nil {
		t.Fatalf("第一个 32 MiB 会话（配额内）不该被拒: %v", err)
	}
	_, err := ts.s.Create("alice", CreateInput{
		AppID: "demo-app", Version: "1.0.0",
		TotalBytes: limits.WasmMaxBytes, ChunkBytes: limits.UploadChunkMaxBytes,
	})
	e := mustErr(t, err, apperr.CodeBodyTooLarge, 413)
	if e.Details["quota_bytes"] != quota {
		t.Errorf("配额 413 的 quota_bytes = %v, want %d（%s）",
			e.Details["quota_bytes"], quota, humanBytes(quota))
	}
	for _, k := range []string{"reserved_bytes", "used_bytes", "incoming_bytes", "max_sessions"} {
		if e.Details[k] == nil {
			t.Errorf("配额 413 缺明细 %q: %s", k, e.JSON())
		}
	}
	if len(e.Hints) == 0 {
		t.Errorf("配额 413 必须有 hints（§8：第一消费者是 AI）: %s", e.JSON())
	}
	// **先于会话数闸门**的判据：拒绝那一刻 live 还没到上限 ⇒ 会话数闸门不可能参与。
	live, reserved, disk, uerr := ts.s.userUsage("alice", ts.clock())
	if uerr != nil {
		t.Fatalf("统计失败: %v", uerr)
	}
	if live >= limits.UploadSessionsPerUser {
		t.Fatalf("拒绝时活会话数 = %d ≥ 上限 %d：无法证明配额先拒（本判据失效）",
			live, limits.UploadSessionsPerUser)
	}
	if reserved != int64(limits.WasmMaxBytes) {
		t.Fatalf("预留统计 = %d, want %d", reserved, limits.WasmMaxBytes)
	}
	if disk != 0 {
		t.Fatalf("一片都没 PUT 过，实际落盘应为 0，实际 %d", disk)
	}
	t.Logf("配额闸门可达且先于会话数闸门：live=%d(<%d) reserved=%s disk=%s quota=%s",
		live, limits.UploadSessionsPerUser,
		humanBytes(reserved), humanBytes(disk), humanBytes(quota))

	// --- 2. 会话数闸门仍然可达（小会话：合计声明量留在配额之内）---
	ts2 := newTestStore(t)
	const each = int64(limits.UploadChunkMaxBytes) // 8 MiB/会话 ⇒ 4 个共 32 MiB < 48 MiB
	if each*int64(limits.UploadSessionsPerUser) >= quota {
		t.Fatalf("用例前提被破坏：%d × %d = %d 必须严格小于配额 %d",
			limits.UploadSessionsPerUser, each, each*int64(limits.UploadSessionsPerUser), quota)
	}
	for i := 0; i < limits.UploadSessionsPerUser; i++ {
		if _, cerr := ts2.s.Create("alice", CreateInput{
			AppID: "demo-app", Version: "1.0.0", TotalBytes: each, ChunkBytes: each,
		}); cerr != nil {
			t.Fatalf("第 %d 个 %s 的会话（合计 %s ≤ 配额 %s）不该被拒: %v",
				i+1, humanBytes(each), humanBytes(each*int64(i+1)), humanBytes(quota), cerr)
		}
	}
	_, serr := ts2.s.Create("alice", CreateInput{
		AppID: "demo-app", Version: "1.0.0", TotalBytes: each, ChunkBytes: each,
	})
	se := mustErr(t, serr, apperr.CodeRateLimited, 429)
	if se.Details["max_sessions"] == nil {
		t.Errorf("会话数 429 必须带 max_sessions 明细: %s", se.JSON())
	}
	t.Logf("会话数闸门同样可达：%d × %s = %s ≤ 配额 %s，第 %d 个由会话数闸门拒绝",
		limits.UploadSessionsPerUser, humanBytes(each),
		humanBytes(each*int64(limits.UploadSessionsPerUser)), humanBytes(quota),
		limits.UploadSessionsPerUser+1)
}

// TestPerUserDiskAccountingIsReservationBounded：配额判定用"声明量（预留）"，
// 本用例把"预留 ≥ 实际落盘"这条不变量写成可执行断言（审计 FIX-44 的口径）。
//
// 为什么必须有这条：判定若改用"实际落盘字节"就**不再是上界** —— 客户端先把 4 个会话
// 都开出来（各声明 32 MiB、实际 0 字节，逐个都满足"0 + 32 MiB ≤ 48 MiB"），再慢慢填满
// 就能到 128 MiB。判定落在预留上时 `Σ实际 ≤ Σ声明 ≤ 配额` 恒成立，而这条断言就是
// 关系本身的证据（顺带证明错误明细里的 used_bytes 是真的从磁盘数出来的）。
func TestPerUserDiskAccountingIsReservationBounded(t *testing.T) {
	ts := newTestStore(t)
	const chunk = 64 << 10
	total := int64(chunk) * 3
	sess := ts.create("alice", total, chunk)
	for i, part := range split(blob(int(total), 7), chunk) {
		if _, err := ts.s.Put("alice", sess.UploadID, i, part); err != nil {
			t.Fatalf("PUT 第 %d 片失败: %v", i, err)
		}
	}
	other := ts.create("alice", chunk, chunk)
	if _, err := ts.s.Put("alice", other.UploadID, 0, blob(chunk, 9)); err != nil {
		t.Fatalf("PUT 失败: %v", err)
	}
	live, reserved, disk, err := ts.s.userUsage("alice", ts.clock())
	if err != nil {
		t.Fatalf("统计失败: %v", err)
	}
	if live != 2 {
		t.Fatalf("活会话数 = %d, want 2", live)
	}
	if want := total + chunk; reserved != want {
		t.Fatalf("预留 = %d, want %d（各会话声明之和）", reserved, want)
	}
	if disk != reserved {
		t.Fatalf("实际落盘 = %d, want %d（本用例把每一片都写满了）", disk, reserved)
	}
	if disk > int64(limits.UploadBodyMaxBytes) {
		t.Fatalf("实际落盘 %d 超过每用户配额 %d", disk, limits.UploadBodyMaxBytes)
	}
	// 配额是**每用户**的：别人的会话不进来。
	if live2, res2, disk2, uerr := ts.s.userUsage("bob", ts.clock()); uerr != nil || live2 != 0 || res2 != 0 || disk2 != 0 {
		t.Fatalf("bob 的统计被 alice 的会话污染: live=%d reserved=%d disk=%d err=%v",
			live2, res2, disk2, uerr)
	}
}

// ---------------------------------------------------------------------------
// 2. 写片：乱序 / 幂等 / 尺寸 / 增量
// ---------------------------------------------------------------------------

func TestPutOutOfOrderAndResume(t *testing.T) {
	ts := newTestStore(t)
	payload := blob(3*64<<10, 7)
	parts := split(payload, 64<<10)
	sess := ts.create("alice", int64(len(payload)), 64<<10)

	// 乱序：先 2 再 0（断线续传的常态）。
	for _, i := range []int{2, 0} {
		got, err := ts.s.Put("alice", sess.UploadID, i, parts[i])
		if err != nil {
			t.Fatalf("PUT 第 %d 片失败: %v", i, err)
		}
		if !containsInt(got.Received, i) {
			t.Fatalf("received 未包含 %d: %v", i, got.Received)
		}
	}
	// 续传查询：断在第 2 片时客户端看到的正是这一份。
	view, err := ts.s.Open("alice", sess.UploadID)
	if err != nil {
		t.Fatalf("Open 失败: %v", err)
	}
	if !equalInts(view.Received, []int{0, 2}) {
		t.Fatalf("received = %v, want [0 2]", view.Received)
	}
	if view.ReceivedBytes() != int64(len(parts[0])+len(parts[2])) {
		t.Fatalf("received_bytes = %d, want %d", view.ReceivedBytes(), len(parts[0])+len(parts[2]))
	}
	// 只补缺失的片（1），然后 complete 必须拿到与原始载荷逐字节相同的模块。
	if _, err := ts.s.Put("alice", sess.UploadID, 1, parts[1]); err != nil {
		t.Fatalf("补第 1 片失败: %v", err)
	}
	got := ts.completeOK("alice", sess.UploadID)
	if !bytes.Equal(got, payload) {
		t.Fatalf("拼装结果与原始载荷不一致（顺序错？）: len=%d want %d", len(got), len(payload))
	}
}

func TestPutIdempotentOverwrite(t *testing.T) {
	ts := newTestStore(t)
	payload := blob(2*64<<10, 3)
	sess := ts.create("alice", int64(len(payload)), 64<<10)

	first := blob(64<<10, 1)
	if _, err := ts.s.Put("alice", sess.UploadID, 0, first); err != nil {
		t.Fatalf("首次 PUT 失败: %v", err)
	}
	// 重复 PUT 同一片：覆盖（续传的自然语义），received 不得重复计数。
	second := blob(64<<10, 2)
	got, err := ts.s.Put("alice", sess.UploadID, 0, second)
	if err != nil {
		t.Fatalf("重复 PUT 失败: %v", err)
	}
	if !equalInts(got.Received, []int{0}) {
		t.Fatalf("received = %v, want [0]（重复片不得重复计数）", got.Received)
	}
	if got.ReceivedBytes() != 64<<10 {
		t.Fatalf("received_bytes = %d, want %d（覆盖不得累加）", got.ReceivedBytes(), 64<<10)
	}
	if _, err := ts.s.Put("alice", sess.UploadID, 1, payload[64<<10:]); err != nil {
		t.Fatalf("PUT 第 1 片失败: %v", err)
	}
	assembled := ts.completeOK("alice", sess.UploadID)
	want := append(append([]byte{}, second...), payload[64<<10:]...)
	if !bytes.Equal(assembled, want) {
		t.Fatalf("拼装结果用的是第一次的字节（覆盖没生效）")
	}
}

func TestChunkSizeRules(t *testing.T) {
	ts := newTestStore(t)
	total := int64(3 * 64 << 10)
	ts.create("alice", total, 64<<10)
	sess, _ := ts.s.Open("alice", firstSessionID(t, ts))

	// 过大：单片 > UploadChunkMaxBytes ⇒ 413。
	_, err := ts.s.Put("alice", sess.UploadID, 0, blob(limits.UploadChunkMaxBytes+1, 1))
	mustErr(t, err, apperr.CodeBodyTooLarge, 413)
	// 过小：非尾片 < UploadChunkMinBytes ⇒ 400。
	_, err = ts.s.Put("alice", sess.UploadID, 0, blob(limits.UploadChunkMinBytes-1, 1))
	mustErr(t, err, apperr.CodeValidation, 400)
	// 空片 ⇒ 400（空片只会让累计永远对不上）。
	_, err = ts.s.Put("alice", sess.UploadID, 0, nil)
	mustErr(t, err, apperr.CodeValidation, 400)
	// 尾片允许小于下限（否则 32 MiB 的余数永远传不上去）。
	if _, err := ts.s.Put("alice", sess.UploadID, 2, blob(1, 1)); err != nil {
		t.Fatalf("尾片小于下限应被接受: %v", err)
	}
	// 尾片仍不得超上限。
	_, err = ts.s.Put("alice", sess.UploadID, 2, blob(limits.UploadChunkMaxBytes+1, 1))
	mustErr(t, err, apperr.CodeBodyTooLarge, 413)
}

func TestChunkTooLargeDoesNotTouchDisk(t *testing.T) {
	ts := newTestStore(t)
	sess := ts.create("alice", 2*64<<10, 64<<10)

	_, err := ts.s.Put("alice", sess.UploadID, 0, blob(limits.UploadChunkMaxBytes+1, 1))
	mustErr(t, err, apperr.CodeBodyTooLarge, 413)
	// §4.2：超限直接 413 且**不落盘**（不能先写后判）。
	dir := filepath.Join(ts.root, sess.UploadID)
	if _, serr := os.Stat(filepath.Join(dir, chunkPrefix+"0")); !errors.Is(serr, os.ErrNotExist) {
		t.Fatalf("超限的片落了盘（stat err=%v）", serr)
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.Name() != metaFileName {
			t.Fatalf("超限请求留下了多余文件: %s", e.Name())
		}
	}
	view, _ := ts.s.Open("alice", sess.UploadID)
	if len(view.Received) != 0 || view.ReceivedBytes() != 0 {
		t.Fatalf("超限请求改了会话状态: received=%v bytes=%d", view.Received, view.ReceivedBytes())
	}
}

func TestIncrementalOverflowDoesNotTouchDisk(t *testing.T) {
	ts := newTestStore(t)
	// 2 个整片 + 1000 字节尾片 ⇒ 3 片。
	total := int64(2*(64<<10) + 1000)
	sess := ts.create("alice", total, 64<<10)

	if _, err := ts.s.Put("alice", sess.UploadID, 0, blob(64<<10, 1)); err != nil {
		t.Fatalf("PUT 0 失败: %v", err)
	}
	if _, err := ts.s.Put("alice", sess.UploadID, 1, blob(64<<10, 2)); err != nil {
		t.Fatalf("PUT 1 失败: %v", err)
	}
	// 尾片 2000 字节（> 余数 1000）会让累计 132072 > total ⇒ 增量拒（400）。
	_, err := ts.s.Put("alice", sess.UploadID, 2, blob(2000, 3))
	mustErr(t, err, apperr.CodeValidation, 400)
	if _, serr := os.Stat(filepath.Join(ts.root, sess.UploadID, chunkPrefix+"2")); !errors.Is(serr, os.ErrNotExist) {
		t.Fatalf("超总量的片落了盘（stat err=%v）", serr)
	}
	// 重传一片（覆盖）不得被自己上一次的字节挤爆：第 1 片原样重传必须成功。
	if _, err := ts.s.Put("alice", sess.UploadID, 1, blob(64<<10, 9)); err != nil {
		t.Fatalf("同尺寸重传被误拒（累计没扣掉旧内容？）: %v", err)
	}
	// 余数正确的那一片必须成功。
	if _, err := ts.s.Put("alice", sess.UploadID, 2, blob(1000, 3)); err != nil {
		t.Fatalf("正确的尾片被拒: %v", err)
	}
}

func TestPutIndexOutOfRange(t *testing.T) {
	ts := newTestStore(t)
	sess := ts.create("alice", 2*64<<10, 64<<10) // 2 片：合法序号 0/1
	for _, index := range []int{-1, 2, 3, limits.UploadMaxChunks, 1 << 30} {
		_, err := ts.s.Put("alice", sess.UploadID, index, blob(64<<10, 1))
		e := mustErr(t, err, apperr.CodeValidation, 400)
		if got := e.Details["index"]; fmt.Sprint(got) != fmt.Sprint(index) {
			t.Errorf("details.index = %v, want %d", got, index)
		}
	}
	// 越界请求不得落盘。
	entries, _ := os.ReadDir(filepath.Join(ts.root, sess.UploadID))
	if len(entries) != 1 {
		t.Fatalf("越界请求留下了文件: %v", entries)
	}
}

func TestPutConcurrentChunksKeepBoth(t *testing.T) {
	ts := newTestStore(t)
	const n = 8
	total := int64(n * 64 << 10)
	sess := ts.create("alice", total, 64<<10)
	payload := blob(int(total), 5)
	parts := split(payload, 64<<10)

	// 两片同时写同一会话：会话级互斥保证 meta.json 不丢更新（收到一片就改一次 meta）。
	start := make(chan struct{})
	var wg sync.WaitGroup
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			if _, err := ts.s.Put("alice", sess.UploadID, i, parts[i]); err != nil {
				errs[i] = err
			}
		}(i)
	}
	close(start)
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("并发 PUT 第 %d 片失败: %v", i, err)
		}
	}
	view, oerr := ts.s.Open("alice", sess.UploadID)
	if oerr != nil {
		t.Fatalf("Open 失败: %v", oerr)
	}
	if len(view.Received) != n {
		t.Fatalf("received = %v（丢了片：meta.json 更新丢失）", view.Received)
	}
	if view.ReceivedBytes() != total {
		t.Fatalf("received_bytes = %d, want %d", view.ReceivedBytes(), total)
	}
	if got := ts.completeOK("alice", sess.UploadID); !bytes.Equal(got, payload) {
		t.Fatalf("并发写入后拼装结果不一致")
	}
}

// ---------------------------------------------------------------------------
// 3. 归属与存在性
// ---------------------------------------------------------------------------

func TestCrossUserIsIndistinguishableFromUnknown(t *testing.T) {
	ts := newTestStore(t)
	sess := ts.create("alice", 64<<10, 64<<10)

	_, crossErr := ts.s.Open("bob", sess.UploadID)
	unknownID := strings.Repeat("ab", UploadIDBytes) // 形态合法但不存在
	if unknownID == sess.UploadID {
		unknownID = strings.Repeat("cd", UploadIDBytes)
	}
	_, unknownErr := ts.s.Open("bob", unknownID)
	if crossErr == nil || unknownErr == nil {
		t.Fatalf("跨用户/不存在都必须 404：cross=%v unknown=%v", crossErr, unknownErr)
	}
	// 判据：**响应体逐字相同**（连 hints 也不能有差异 —— 那本身就是存在性泄漏）。
	if crossErr.JSON() != unknownErr.JSON() {
		t.Fatalf("跨用户与不存在的响应体不同（可探测存在性）:\n cross=%s\nunknown=%s",
			crossErr.JSON(), unknownErr.JSON())
	}
	if crossErr.Status() != 404 {
		t.Fatalf("跨用户状态码 = %d, want 404", crossErr.Status())
	}
	// 别人的 404 不得顺手删掉发起者的会话。
	if _, err := os.Stat(filepath.Join(ts.root, sess.UploadID)); err != nil {
		t.Fatalf("跨用户访问删掉了会话目录: %v", err)
	}
	// 跨用户的 PUT / Discard / Complete 同样是 404。
	if _, err := ts.s.Put("bob", sess.UploadID, 0, blob(64<<10, 1)); err == nil || err.Status() != 404 {
		t.Fatalf("跨用户 PUT 未被拒: %v", err)
	}
	if err := ts.s.Discard("bob", sess.UploadID); err == nil || err.Status() != 404 {
		t.Fatalf("跨用户 Discard 未被拒: %v", err)
	}
	if _, err := ts.s.Complete("bob", sess.UploadID, ts.okPublisher()); err == nil || err.Status() != 404 {
		t.Fatalf("跨用户 Complete 未被拒: %v", err)
	}
}

// TestPathTraversalCannotEscapeRoot 是一条**真正的**穿越证明（不是"垃圾 id 得到 404"）。
//
// 手法：在会话根**之外**放一个"看起来完全合法"的会话目录（meta.json 齐全、发起者也是
// alice），然后用相对路径形态的 upload_id 去打它 —— 唯一能拦住它的就是"拼路径**之前**
// 的形态闸"。
//
// 变异方式：去掉 dirChecked 里的 ValidID（或把它挪到拼接之后）⇒ 受害目录会被写入
// chunk-0（最后一条断言红）；只去掉形态闸但保留"父目录必须等于 root"的断言 ⇒ 变异后
// 得到 500 INTERNAL 而不是 404（前面的断言红）。
func TestPathTraversalCannotEscapeRoot(t *testing.T) {
	ts := newTestStore(t)
	// 受害目录：<DataRoot>/apps/victim（与会话根 <DataRoot>/apps/_uploads 同级）。
	victim := filepath.Join(filepath.Dir(ts.root), "victim")
	if err := os.MkdirAll(victim, 0o700); err != nil {
		t.Fatalf("建受害目录失败: %v", err)
	}
	meta := `{"upload_id":"victim","app_id":"demo-app","version":"1.0.0","publisher":"alice",` +
		`"total_bytes":65536,"chunk_bytes":65536,"received":[],` +
		`"created_at":"2023-11-14T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}`
	if err := os.WriteFile(filepath.Join(victim, metaFileName), []byte(meta), 0o600); err != nil {
		t.Fatalf("写受害元数据失败: %v", err)
	}
	for _, id := range []string{"../victim", "../../apps/victim", victim, "./victim"} {
		if _, err := ts.s.Put("alice", id, 0, blob(64<<10, 1)); err == nil || err.Status() != 404 {
			t.Fatalf("Put(%q) 未被拒: %v", id, err)
		}
		if err := ts.s.Discard("alice", id); err == nil || err.Status() != 404 {
			t.Fatalf("Discard(%q) 未被拒（会删掉受害目录！）: %v", id, err)
		}
		if _, err := ts.s.Complete("alice", id, ts.okPublisher()); err == nil || err.Status() != 404 {
			t.Fatalf("Complete(%q) 未被拒: %v", id, err)
		}
		if _, err := ts.s.Open("alice", id); err == nil || err.Status() != 404 {
			t.Fatalf("Open(%q) 未被拒: %v", id, err)
		}
	}
	entries, err := os.ReadDir(victim)
	if err != nil {
		t.Fatalf("受害目录被删掉了: %v", err)
	}
	if len(entries) != 1 || entries[0].Name() != metaFileName {
		t.Fatalf("受害目录被写入/改动: %v", entries)
	}
}

func TestExpiredSessionIsReclaimed(t *testing.T) {
	ts := newTestStore(t)
	sess := ts.create("alice", 64<<10, 64<<10)
	if _, err := ts.s.Put("alice", sess.UploadID, 0, blob(64<<10, 1)); err != nil {
		t.Fatalf("PUT 失败: %v", err)
	}

	ts.advance(limits.UploadSessionTTL + time.Second)
	_, err := ts.s.Open("alice", sess.UploadID)
	mustErr(t, err, apperr.CodeNotFound, 404)
	// 过期即回收：目录必须已经没了（§4.2 的磁盘不驻留）。
	if _, serr := os.Stat(filepath.Join(ts.root, sess.UploadID)); !errors.Is(serr, os.ErrNotExist) {
		t.Fatalf("过期会话目录仍在（惰性回收没生效）: %v", serr)
	}
	if _, perr := ts.s.Put("alice", sess.UploadID, 0, blob(64<<10, 1)); perr == nil || perr.Status() != 404 {
		t.Fatalf("过期会话仍可写入: %v", perr)
	}
}

func TestPathTraversalIsRejected(t *testing.T) {
	ts := newTestStore(t)
	// 全部非法形态：长度/字符集/穿越意图。它们必须在**拼路径之前**被拒。
	bad := []string{
		"", "..", "../..", "../../etc/passwd", "/etc/passwd", "abc",
		strings.Repeat("a", UploadIDHexLen-1), strings.Repeat("a", UploadIDHexLen+1),
		strings.ToUpper(strings.Repeat("a", UploadIDHexLen)), // 大写十六进制不收（规范形态只有一种）
		strings.Repeat("z", UploadIDHexLen),
		strings.Repeat("a", UploadIDHexLen-2) + "/x",
		strings.Repeat("a", UploadIDHexLen-2) + "\\x",
	}
	for _, id := range bad {
		if ValidID(id) {
			t.Fatalf("ValidID(%q) = true，形态闸失效", id)
		}
		if _, err := ts.s.Open("alice", id); err == nil || err.Status() != 404 {
			t.Fatalf("Open(%q) 未被拒: %v", id, err)
		}
		if _, err := ts.s.Put("alice", id, 0, blob(64<<10, 1)); err == nil || err.Status() != 404 {
			t.Fatalf("Put(%q) 未被拒: %v", id, err)
		}
		if err := ts.s.Discard("alice", id); err == nil || err.Status() != 404 {
			t.Fatalf("Discard(%q) 未被拒: %v", id, err)
		}
		if _, err := ts.s.Complete("alice", id, ts.okPublisher()); err == nil || err.Status() != 404 {
			t.Fatalf("Complete(%q) 未被拒: %v", id, err)
		}
	}
	// 会话根之外不得出现任何文件：DataRoot 下只应有 apps/_uploads（这里全被拒了，
	// 所以连 apps 都不该存在）。
	dataRoot := filepath.Dir(filepath.Dir(ts.root)) // <DataRoot>/apps/_uploads → <DataRoot>
	if entries, err := os.ReadDir(dataRoot); err != nil {
		t.Fatalf("DataRoot 不可读: %v", err)
	} else {
		for _, e := range entries {
			if e.Name() != limits.AppsDirName {
				t.Fatalf("DataRoot 下出现了意外条目: %s", e.Name())
			}
		}
	}
}

// ---------------------------------------------------------------------------
// 4. 拼装与 complete
// ---------------------------------------------------------------------------

func TestCompleteAssemblesInIndexOrder(t *testing.T) {
	ts := newTestStore(t)
	payload := blob(3*(64<<10)+123, 11)
	parts := split(payload, 64<<10)
	sess := ts.create("alice", int64(len(payload)), 64<<10)
	// 倒序上传：拼装必须按 index，而不是按到达顺序。
	for i := len(parts) - 1; i >= 0; i-- {
		if _, err := ts.s.Put("alice", sess.UploadID, i, parts[i]); err != nil {
			t.Fatalf("PUT %d 失败: %v", i, err)
		}
	}
	got := ts.completeOK("alice", sess.UploadID)
	if !bytes.Equal(got, payload) {
		t.Fatalf("拼装结果与原始载荷不一致")
	}
}

func TestCompleteMissingChunksKeepsSession(t *testing.T) {
	ts := newTestStore(t)
	sess := ts.create("alice", 3*64<<10, 64<<10)
	if _, err := ts.s.Put("alice", sess.UploadID, 0, blob(64<<10, 1)); err != nil {
		t.Fatalf("PUT 失败: %v", err)
	}
	_, err := ts.s.Complete("alice", sess.UploadID, ts.okPublisher())
	e := mustErr(t, err, apperr.CodeValidation, 400)
	if e.Details["missing_chunks"] == nil {
		t.Errorf("缺片错误必须带 missing_chunks 明细（AI 是第一个消费者）: %s", e.JSON())
	}
	// 失败保留会话（客户端补片后重试），且回调根本没被调用（缺片时不该发布）。
	if _, serr := os.Stat(filepath.Join(ts.root, sess.UploadID)); serr != nil {
		t.Fatalf("失败的 complete 删掉了会话: %v", serr)
	}
	// 补齐后可以成功。
	for i := 1; i < 3; i++ {
		if _, err := ts.s.Put("alice", sess.UploadID, i, blob(64<<10, byte(i))); err != nil {
			t.Fatalf("补第 %d 片失败: %v", i, err)
		}
	}
	ts.completeOK("alice", sess.UploadID)
}

func TestCompleteTotalMismatch(t *testing.T) {
	ts := newTestStore(t)
	// 声明 2 片（最后一片余数 1000 字节），实际尾片只传 900 字节 ⇒ 各片之和 < total。
	total := int64(64<<10 + 1000)
	sess := ts.create("alice", total, 64<<10)
	if _, err := ts.s.Put("alice", sess.UploadID, 0, blob(64<<10, 1)); err != nil {
		t.Fatalf("PUT 0 失败: %v", err)
	}
	if _, err := ts.s.Put("alice", sess.UploadID, 1, blob(900, 2)); err != nil {
		t.Fatalf("PUT 尾片失败: %v", err)
	}
	_, err := ts.s.Complete("alice", sess.UploadID, ts.okPublisher())
	e := mustErr(t, err, apperr.CodeValidation, 400)
	if e.Details["diff_bytes"] == nil {
		t.Errorf("总量不符必须带 diff_bytes 明细: %s", e.JSON())
	}
	if _, serr := os.Stat(filepath.Join(ts.root, sess.UploadID)); serr != nil {
		t.Fatalf("总量不符时不该删会话: %v", serr)
	}
}

func TestCompleteSuccessDeletesSessionAndCachesBody(t *testing.T) {
	ts := newTestStore(t)
	sess := ts.create("alice", 64<<10, 64<<10)
	if _, err := ts.s.Put("alice", sess.UploadID, 0, blob(64<<10, 1)); err != nil {
		t.Fatalf("PUT 失败: %v", err)
	}
	// 回调里断言拿到的是**拼装好的整包**（发布链路复用点）。
	var seen []byte
	body := []byte(`{"release":{"id":1}}`)
	got, err := ts.s.Complete("alice", sess.UploadID, func(wasm []byte, s *Session) ([]byte, *apperr.Error) {
		seen = wasm
		if s.UploadID != sess.UploadID || s.AppID != "demo-app" {
			t.Errorf("回调拿到的会话不对: %+v", s)
		}
		return body, nil
	})
	if err != nil {
		t.Fatalf("complete 失败: %v", err)
	}
	if !bytes.Equal(got, body) {
		t.Fatalf("complete 未把回调的成功体透传出来")
	}
	if len(seen) != 64<<10 {
		t.Fatalf("回调拿到的模块长度 = %d, want %d", len(seen), 64<<10)
	}
	// 成功 ⇒ 目录立即删除（磁盘不驻留）。
	if _, serr := os.Stat(filepath.Join(ts.root, sess.UploadID)); !errors.Is(serr, os.ErrNotExist) {
		t.Fatalf("成功后会话目录仍在: %v", serr)
	}
	// 幂等重放缓存：同一用户命中、别人不命中、TTL 后失效。
	if b, ok := ts.s.Completed(sess.UploadID, "alice"); !ok || !bytes.Equal(b, body) {
		t.Fatalf("幂等重放缓存未命中: ok=%v body=%s", ok, b)
	}
	if _, ok := ts.s.Completed(sess.UploadID, "bob"); ok {
		t.Fatalf("重放缓存未绑定发起者（跨用户可读）")
	}
	ts.advance(limits.UploadSessionTTL + time.Second)
	if _, ok := ts.s.Completed(sess.UploadID, "alice"); ok {
		t.Fatalf("重放缓存过了 TTL 仍命中")
	}
}

// TestCompleteReplaysFromInsideTheLease：审计 FIX-45 的**存储层**判据。
//
// 旧实现里重放判定只在 api 层、会话锁**之外**做：Store.Complete 自己不查缓存，于是
// "首次已完成"之后再调 Complete 得到的是 404（目录已删），而"首次仍在进行中"的第二个
// 请求会先撞上并发编译位拿到 429。现在判定的查/写都在 **complete 租约（= 会话锁）内**：
//
//  1. 重复 Complete ⇒ 逐字回放，发布回调**只被调用一次**（不重新发布、不再落库）；
//  2. 跨用户仍拿不到回放（缓存键含发起者，与文件系统那条判据同源）；
//  3. 并发形态：首个仍在回调里（= 持租约）时，第二个 Complete **必须等待**，
//     首个结束后拿到回放 —— 而不是被拒。
//
// 变异方式（把判定移出租约/锁 ⇒ 本用例必红，已实测）：
//   - 去掉 BeginComplete 里的 Completed 查询（判定交回调用方）⇒ 第 1 段变 404、第 3 段红；
//   - api 层改回"锁外查缓存 + 闸门在租约之前"⇒ api 包的
//     TestUploadConcurrentDuplicateCompleteReplays 红（429）。
func TestCompleteReplaysFromInsideTheLease(t *testing.T) {
	ts := newTestStore(t)
	sess := ts.create("alice", 64<<10, 64<<10)
	if _, err := ts.s.Put("alice", sess.UploadID, 0, blob(64<<10, 1)); err != nil {
		t.Fatalf("PUT 失败: %v", err)
	}
	body := []byte(`{"release":{"id":1}}`)
	calls := 0
	publish := func([]byte, *Session) ([]byte, *apperr.Error) {
		calls++
		return body, nil
	}
	first, err := ts.s.Complete("alice", sess.UploadID, publish)
	if err != nil {
		t.Fatalf("首次 complete 失败: %v", err)
	}
	if calls != 1 {
		t.Fatalf("发布回调被调用 %d 次, want 1", calls)
	}
	// 1. 重复 Complete = 回放（旧实现这里是 404）。
	second, err := ts.s.Complete("alice", sess.UploadID, publish)
	if err != nil {
		t.Fatalf("重复 complete 必须回放（不再是 404）: %v", err)
	}
	if !bytes.Equal(second, first) {
		t.Fatalf("回放体不同:\n first=%s\nsecond=%s", first, second)
	}
	if calls != 1 {
		t.Fatalf("回放又调了一次发布回调（重复落库）: calls=%d", calls)
	}
	// 2. 跨用户不命中回放缓存（判据与文件系统同源）。
	if _, err := ts.s.Complete("bob", sess.UploadID, publish); err == nil || err.Status() != 404 {
		t.Fatalf("跨用户 complete 未回 404: %v", err)
	}
	if calls != 1 {
		t.Fatalf("跨用户请求触发了发布回调: calls=%d", calls)
	}

	// 3. 并发：首个持租约阻塞在回调里，第二个必须等待并以回放收场。
	sess2 := ts.create("alice", 64<<10, 64<<10)
	if _, err := ts.s.Put("alice", sess2.UploadID, 0, blob(64<<10, 2)); err != nil {
		t.Fatalf("PUT 失败: %v", err)
	}
	body2 := []byte(`{"release":{"id":2}}`)
	entered := make(chan struct{})
	unblock := make(chan struct{})
	firstErr := make(chan *apperr.Error, 1)
	go func() {
		_, cerr := ts.s.Complete("alice", sess2.UploadID, func([]byte, *Session) ([]byte, *apperr.Error) {
			close(entered)
			<-unblock // 模拟"首次仍在编译"
			return body2, nil
		})
		firstErr <- cerr
	}()
	<-entered
	secondDone := make(chan []byte, 1)
	secondErr := make(chan *apperr.Error, 1)
	go func() {
		// 这次调用**必须**在会话锁上等首个结束，然后命中回放；它不该走到发布回调。
		b, cerr := ts.s.Complete("alice", sess2.UploadID, func([]byte, *Session) ([]byte, *apperr.Error) {
			return nil, apperr.New(apperr.CodeInternal, "并发重复 complete 不该重新发布")
		})
		secondErr <- cerr
		secondDone <- b
	}()
	select {
	case <-secondDone:
		t.Fatalf("第二个 complete 在首个结束前就返回了（租约没有序列化同会话的发布）")
	case <-time.After(100 * time.Millisecond):
	}
	close(unblock)
	if cerr := <-firstErr; cerr != nil {
		t.Fatalf("首个 complete 失败: %v", cerr)
	}
	select {
	case cerr := <-secondErr:
		if cerr != nil {
			t.Fatalf("第二个 complete 应回放 201 体，实际错误: %v", cerr)
		}
		if b := <-secondDone; !bytes.Equal(b, body2) {
			t.Fatalf("第二个 complete 的回放体不同:\n want=%s\ngot =%s", body2, b)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("第二个 complete 没有在首个结束后返回（可能死锁在会话锁上）")
	}
}

func TestCompleteFailureKeepsSession(t *testing.T) {
	ts := newTestStore(t)
	sess := ts.create("alice", 64<<10, 64<<10)
	if _, err := ts.s.Put("alice", sess.UploadID, 0, blob(64<<10, 1)); err != nil {
		t.Fatalf("PUT 失败: %v", err)
	}
	boom := apperr.New(apperr.CodeVersionNotNewer, "版本号必须严格递增")
	if _, err := ts.s.Complete("alice", sess.UploadID, func([]byte, *Session) ([]byte, *apperr.Error) {
		return nil, boom
	}); err != boom {
		t.Fatalf("complete 未把发布错误原样透出: %v", err)
	}
	// 失败保留会话 + 不缓存成功体（否则客户端会以为发布成功了）。
	if _, serr := os.Stat(filepath.Join(ts.root, sess.UploadID)); serr != nil {
		t.Fatalf("失败的 complete 删掉了会话（无法续传重试）: %v", serr)
	}
	if _, ok := ts.s.Completed(sess.UploadID, "alice"); ok {
		t.Fatalf("失败的 complete 写了重放缓存")
	}
	// 同一个会话可以再 complete（幂等重试）。
	if _, err := ts.s.Complete("alice", sess.UploadID, func([]byte, *Session) ([]byte, *apperr.Error) {
		return []byte(`{"ok":true}`), nil
	}); err != nil {
		t.Fatalf("重试 complete 失败: %v", err)
	}
}

func TestDiscard(t *testing.T) {
	ts := newTestStore(t)
	sess := ts.create("alice", 64<<10, 64<<10)
	if err := ts.s.Discard("alice", sess.UploadID); err != nil {
		t.Fatalf("Discard 失败: %v", err)
	}
	if _, serr := os.Stat(filepath.Join(ts.root, sess.UploadID)); !errors.Is(serr, os.ErrNotExist) {
		t.Fatalf("Discard 未回收目录: %v", serr)
	}
	// 再删一次 → 404（会话已不存在，与"不存在"同解）。
	if err := ts.s.Discard("alice", sess.UploadID); err == nil || err.Status() != 404 {
		t.Fatalf("重复 Discard 未被拒: %v", err)
	}
}

// TestMetaMirrorsDisk 覆盖"崩在 rename 与 writeMeta 之间"的那一刻：
// 片文件已经在盘上、meta.json 还没写上 —— 磁盘是真源，续传查询必须把它算进去。
func TestMetaMirrorsDisk(t *testing.T) {
	ts := newTestStore(t)
	sess := ts.create("alice", 2*64<<10, 64<<10)
	dir := filepath.Join(ts.root, sess.UploadID)
	// 直接落一个片文件（绕过 Put 的 meta 更新，模拟崩溃窗口）。
	if err := os.WriteFile(filepath.Join(dir, chunkPrefix+"1"), blob(64<<10, 1), 0o600); err != nil {
		t.Fatalf("写片失败: %v", err)
	}
	view, err := ts.s.Open("alice", sess.UploadID)
	if err != nil {
		t.Fatalf("Open 失败: %v", err)
	}
	if !equalInts(view.Received, []int{1}) {
		t.Fatalf("received = %v, want [1]（磁盘上的片必须被认到）", view.Received)
	}
	if view.ReceivedBytes() != 64<<10 {
		t.Fatalf("received_bytes = %d, want %d", view.ReceivedBytes(), 64<<10)
	}
	// 反方向：meta 说有、盘上没有 ⇒ 不算收到（客户端会重传，覆盖语义保证一致）。
	ts2 := newTestStore(t)
	sess2 := ts2.create("alice", 2*64<<10, 64<<10)
	if _, err := ts2.s.Put("alice", sess2.UploadID, 0, blob(64<<10, 1)); err != nil {
		t.Fatalf("PUT 失败: %v", err)
	}
	if err := os.Remove(filepath.Join(ts2.root, sess2.UploadID, chunkPrefix+"0")); err != nil {
		t.Fatalf("删片失败: %v", err)
	}
	view2, _ := ts2.s.Open("alice", sess2.UploadID)
	if len(view2.Received) != 0 {
		t.Fatalf("meta 里的幽灵片被认成已收到: %v", view2.Received)
	}
}

// ---------------------------------------------------------------------------
// 5. 每用户会话数上限
// ---------------------------------------------------------------------------

func TestSessionsPerUserLimit(t *testing.T) {
	ts := newTestStore(t)
	for i := 0; i < limits.UploadSessionsPerUser; i++ {
		ts.create("alice", 64<<10, 64<<10)
	}
	_, err := ts.s.Create("alice", CreateInput{AppID: "demo-app", Version: "1.0.0", TotalBytes: 64 << 10, ChunkBytes: 64 << 10})
	e := mustErr(t, err, apperr.CodeRateLimited, 429)
	if e.Details["max_sessions"] == nil {
		t.Errorf("429 必须带 max_sessions 明细: %s", e.JSON())
	}
	// 别的用户不受影响（配额是**每用户**的）。
	if _, err := ts.s.Create("bob", CreateInput{AppID: "demo-app", Version: "1.0.0", TotalBytes: 64 << 10, ChunkBytes: 64 << 10}); err != nil {
		t.Fatalf("其他用户被误伤: %v", err)
	}
	// 过期后自动腾出槽位（回收已过期会话，而不是让用户等调度器）。
	ts.advance(limits.UploadSessionTTL + time.Second)
	if _, err := ts.s.Create("alice", CreateInput{AppID: "demo-app", Version: "1.0.0", TotalBytes: 64 << 10, ChunkBytes: 64 << 10}); err != nil {
		t.Fatalf("过期会话未腾出槽位: %v", err)
	}
}

// ---------------------------------------------------------------------------
// 6. Cleanup：只删该删的
// ---------------------------------------------------------------------------

func TestCleanupRemovesOnlyExpired(t *testing.T) {
	ts := newTestStore(t)
	old := ts.create("alice", 64<<10, 64<<10)
	ts.advance(limits.UploadSessionTTL / 2)
	fresh := ts.create("bob", 64<<10, 64<<10)
	ts.advance(limits.UploadSessionTTL/2 + time.Second) // 此刻 old 过期、fresh 还有 TTL/2

	removed, err := ts.s.Cleanup(context.Background(), ts.clock())
	if err != nil {
		t.Fatalf("Cleanup 失败: %v", err)
	}
	if removed != 1 {
		t.Fatalf("回收数 = %d, want 1", removed)
	}
	if _, serr := os.Stat(filepath.Join(ts.root, old.UploadID)); !errors.Is(serr, os.ErrNotExist) {
		t.Fatalf("过期会话未被回收: %v", serr)
	}
	if _, serr := os.Stat(filepath.Join(ts.root, fresh.UploadID)); serr != nil {
		t.Fatalf("未过期会话被误删: %v", serr)
	}
	// 幂等：再跑一轮不再删任何东西。
	if again, _ := ts.s.Cleanup(context.Background(), ts.clock()); again != 0 {
		t.Fatalf("第二轮回收数 = %d, want 0", again)
	}
}

func TestCleanupSkipsBusySessionAndJunk(t *testing.T) {
	ts := newTestStore(t)
	sess := ts.create("alice", 64<<10, 64<<10)
	// 半成品目录（Create 的瞬间形态：目录在、meta 还没写）+ 新鲜 mtime 不得被删。
	half := filepath.Join(ts.root, strings.Repeat("f", UploadIDHexLen))
	if err := os.MkdirAll(half, 0o700); err != nil {
		t.Fatalf("建半成品目录失败: %v", err)
	}
	ts.advance(limits.UploadSessionTTL + time.Second)
	removed, err := ts.s.Cleanup(context.Background(), ts.clock())
	if err != nil {
		t.Fatalf("Cleanup 失败: %v", err)
	}
	// half 的 mtime 是"刚才"（相对注入的 now 只过了 1 秒）⇒ 不能删；sess 过期 ⇒ 删。
	if removed != 1 {
		t.Fatalf("回收数 = %d, want 1（半成品目录不得被误删）", removed)
	}
	if _, serr := os.Stat(half); serr != nil {
		t.Fatalf("半成品目录被误删: %v", serr)
	}
	if _, serr := os.Stat(filepath.Join(ts.root, sess.UploadID)); !errors.Is(serr, os.ErrNotExist) {
		t.Fatalf("过期会话未被回收: %v", serr)
	}
	// 让半成品目录也变"陈旧"（把 mtime 拨到 TTL 之前），下一轮必须清掉它。
	old := ts.clock().Add(-2 * limits.UploadSessionTTL)
	if err := os.Chtimes(half, old, old); err != nil {
		t.Fatalf("改 mtime 失败: %v", err)
	}
	if n, _ := ts.s.Cleanup(context.Background(), ts.clock()); n != 1 {
		t.Fatalf("陈旧半成品目录未被清掉: n=%d", n)
	}
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

// okPublisher 是"只负责把整包原样记下来"的发布回调（拼装类用例用它）。
func (ts *testStore) okPublisher() func([]byte, *Session) ([]byte, *apperr.Error) {
	return func(wasm []byte, _ *Session) ([]byte, *apperr.Error) {
		return []byte(fmt.Sprintf(`{"len":%d}`, len(wasm))), nil
	}
}

// completeOK 执行一次 complete 并断言成功，返回拼装出的整包。
func (ts *testStore) completeOK(publisher, id string) []byte {
	ts.t.Helper()
	var out []byte
	if _, err := ts.s.Complete(publisher, id, func(wasm []byte, _ *Session) ([]byte, *apperr.Error) {
		out = wasm
		return []byte(`{"ok":true}`), nil
	}); err != nil {
		ts.t.Fatalf("complete 失败: %v", err)
	}
	return out
}

// firstSessionID 返回会话根下唯一的会话 id（单会话用例的便捷取法）。
func firstSessionID(t *testing.T, ts *testStore) string {
	t.Helper()
	entries, err := os.ReadDir(ts.root)
	if err != nil || len(entries) != 1 {
		t.Fatalf("会话根下应有 1 个会话: %v (err=%v)", entries, err)
	}
	return entries[0].Name()
}

func containsInt(in []int, want int) bool {
	for _, v := range in {
		if v == want {
			return true
		}
	}
	return false
}

func equalInts(a, b []int) bool {
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
