// Package upload 实现 WASM 应用平台的**分片上传会话**：存储、增量校验与组装
// （设计基线 §4.2「.wasm ≤ 32 MiB / 上传体 ≤ 48 MiB / >8 MiB 走分片 + 续传」）。
//
// # 为什么必须有这一层
//
// §7.3 的计时序是硬约束：**客户端 90 s > 服务端 ReadTimeout 60 s > 编译 60 s**。
// 32 MiB 的载荷一次 POST 必然撞上 60 s 的 ReadTimeout（§10.5 第 58 项），所以大
// 载荷只能分片；而"断线后能只补缺失的片"意味着服务端必须**持久记住收到了哪些片**
// —— 本包就是这个会话存储。
//
// # 四条不变量（都是安全边界，不是优化）
//
//  1. **总量上限不因分片而放宽**：total_bytes ≤ limits.WasmMaxBytes，且每次 PUT 都做
//     **增量**校验（累计不得越过 total_bytes）——"等拼完再判"等于把 32 MiB 的账留到
//     最后一刻，超限的字节早已落盘（§4.2/R21/R33）。
//  2. **会话绑定发起者**：upload_id 只在**同一用户名**下可用，跨用户一律 404，
//     且错误与"不存在"逐字相同（不泄露存在性）。
//  3. **磁盘只有一处驻留**：`<DataRoot>/apps/_uploads/<upload_id>/`（0700）。
//     成功即删（§4.2「抽完立即释放原始字节」的同一条精神）、过期即回收
//     （惰性 + CleanupScheduler 周期回收）。
//  4. **upload_id 是 32 字节 crypto/rand 的 hex（64 字符）**：路径拼接**之前**必须过
//     形态闸（ValidID）—— 它直接进文件系统，不可枚举与不可穿越是同一个要求。
//
// # 并发模型
//
//   - **会话级互斥**（Store.lockSession）：同一 upload_id 的 PUT 串行 ⇒ meta.json
//     不会丢更新；complete 与 PUT 互斥（complete 全程持锁，见 Complete 的注释）；
//   - 不同会话之间**不共享锁**（32 MiB 的拼装不该挡住另一个用户的一片上传）；
//   - 锁表按"当前在用"回收，不会随会话总数单调增长。
//
// 本包**不做** HTTP（不 import gin/net/http）、**不做**发布（发布链路的唯一实现在
// api.publishFromBytes）。它只回答两个问题：这一片收不收，以及"整包拼出来了吗"。
package upload

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/registry"
)

const (
	// DirName 是分片上传会话根目录名：`<DataRoot>/apps/_uploads/`。
	//
	// 与 `_tmp` / `_compile-cache` 同处 `apps/` 之下：`_` 开头不是合法的 app_id
	// （§4.1 的规则要求首字符是字母或数字），因此不会与任何应用目录撞名，
	// 也不会被"按 app_id 取目录"的既有代码扫描到。
	DirName = "_uploads"

	// UploadIDBytes 是 upload_id 的随机字节数（§4.2：32 字节 crypto/rand）。
	UploadIDBytes = 32
	// UploadIDHexLen 是 upload_id 的十六进制长度（32 字节 ⇒ 64 个字符）。
	UploadIDHexLen = UploadIDBytes * 2

	// metaFileName 是会话元数据文件名（§4.2 指定的布局）。
	metaFileName = "meta.json"
	// chunkPrefix 是片文件名前缀：`chunk-<index>`（index 从 0 开始）。
	chunkPrefix = "chunk-"
	// tmpSuffix 是原子写的临时名后缀（写它再 rename：崩溃不会留下"看似收到、
	// 实则截断"的片或元数据）。
	tmpSuffix = ".tmp"

	// completedCacheMax 是"已完成的 upload_id → 成功响应体"缓存的条数上限。
	//
	// 这是**实现参数**（不是 §4 的上限数值）：缓存只为幂等重放服务，条目 ~1 KiB，
	// 512 条 ≈ 0.5 MiB。超出按插入顺序淘汰最旧的一条。
	completedCacheMax = 512
)

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

// Session 是一个分片上传会话（meta.json 的序列化形态 + 两个内存字段）。
type Session struct {
	UploadID string `json:"upload_id"`
	// AppID / Version 在**创建会话时**定死：complete 不接受这两个字段的"新值"，
	// 否则"用 A 的会话发布 B"就只需要在 complete 时改一个字符串（§8 身份语义）。
	AppID     string `json:"app_id"`
	Version   string `json:"version"`
	Publisher string `json:"publisher"`
	// TotalBytes 是客户端声明的整包体积：**必须恰好等于**各片之和（§4.2）。
	TotalBytes int64 `json:"total_bytes"`
	// ChunkBytes 是客户端的切分大小（服务端只用它算片数上界与片序，不要求各片等长）。
	ChunkBytes int64 `json:"chunk_bytes"`
	// Received 是已收到的片序号（升序、去重）。它同时写进 meta.json，但**磁盘才是
	// 真源**：读取时会与目录里的 `chunk-<i>` 取并集（见 scanChunks）。
	Received  []int     `json:"received"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at"`

	// receivedBytes 是已收片的总字节（由 Store 在读取时按磁盘大小填），
	// 不写进 meta.json：它是派生的，落地会让"文件与元数据谁说了算"变成两个答案。
	receivedBytes int64
}

// ChunkCount 返回该会话的片数：`ceil(total_bytes / chunk_bytes)`。
//
// 片数是**推导量**（客户端不声明）：最后由 index = 片数-1 的那一片允许小于
// limits.UploadChunkMinBytes（否则 32 MiB 的尾片永远传不上去），其余片必须落在
// [UploadChunkMinBytes, UploadChunkMaxBytes] 里。
func (s *Session) ChunkCount() int { return chunkCount(s.TotalBytes, s.ChunkBytes) }

// ReceivedBytes 返回已收到片的字节数（磁盘实测，见 Session.receivedBytes）。
func (s *Session) ReceivedBytes() int64 {
	if s == nil {
		return 0
	}
	return s.receivedBytes
}

// Expired 报告会话是否已过期（到点即失效：ExpiresAt 是**闭区间右端**）。
func (s *Session) Expired(now time.Time) bool { return !now.Before(s.ExpiresAt) }

// chunkCount 是片数推导的唯一实现（`total ≤ 0` / `chunk ≤ 0` 时返回 0：调用方已校验）。
func chunkCount(total, chunk int64) int {
	if total <= 0 || chunk <= 0 {
		return 0
	}
	n := int((total + chunk - 1) / chunk)
	if n < 1 {
		n = 1
	}
	return n
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

// Options 是 Store 的依赖（全部由调用方注入：本包不读环境变量）。
type Options struct {
	// DataRoot 是平台数据根（会话目录落在 `<DataRoot>/apps/_uploads/`）。
	DataRoot string
	// Now 可注入时钟（过期判定与 TTL；测试用它造"过期会话"）。
	Now func() time.Time
	// AppIDExtraReserved 是部署期注入的企业既有主机名（§4.1，转交 registry）。
	AppIDExtraReserved []string
	// Logger 是内部告警出口（缺省 log.Printf）。
	Logger func(format string, args ...any)
}

// Store 是分片上传会话的存储（进程内单例即可：R20 单实例部署）。
type Store struct {
	opt  Options
	root string

	// lockMu 保护 locks 表本身；每个会话一把独立的 mutex（见 lockSession）。
	lockMu sync.Mutex
	locks  map[string]*sessionLock

	// doneMu 保护"已完成会话 → 成功响应体"的幂等重放缓存。
	doneMu    sync.Mutex
	done      map[string]completedEntry
	doneOrder []string
}

// sessionLock 是会话级互斥。
//
// waiters 在 lockMu 之下维护，语义是"正在持有 + 正在等待"的协程数：
// 它同时承担两件事 —— 让锁表项在无人使用时被回收（否则随会话总数单调增长），
// 以及给 Cleanup 一个"这个会话正忙，先别删"的判据（见 Store.busy）。
type sessionLock struct {
	mu      sync.Mutex
	waiters int
}

// completedEntry 是一次已完成会话的**成功响应体**（幂等重放用）。
type completedEntry struct {
	body    []byte
	expires time.Time
}

// New 构造 Store。opt.Logger 缺省 log.Printf（缺省**不能**是静默：回收失败与目录
// 删除失败都必须可见，否则"磁盘在涨"会变成一个查不出来的悬案）。
func New(opt Options) *Store {
	if opt.Now == nil {
		opt.Now = time.Now
	}
	if opt.Logger == nil {
		opt.Logger = log.Printf
	}
	return &Store{
		opt:   opt,
		root:  filepath.Join(opt.DataRoot, limits.AppsDirName, DirName),
		locks: map[string]*sessionLock{},
		done:  map[string]completedEntry{},
	}
}

// Root 返回会话根目录（观测/测试口径）。
func (s *Store) Root() string { return s.root }

func (s *Store) now() time.Time {
	if s.opt.Now == nil {
		return time.Now().UTC()
	}
	return s.opt.Now().UTC()
}

func (s *Store) logf(format string, args ...any) {
	if s.opt.Logger == nil {
		return
	}
	s.opt.Logger(format, args...)
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

// NotFoundError 是"会话不存在/已过期/不属于你"的**唯一**错误。
//
// 三种情况必须逐字相同（跨用户不得泄露存在性）：调用方（api 层）在形态闸失败时
// 也用它，于是"upload_id 是垃圾串"与"upload_id 是别人的会话"连响应体都一样。
// 导出它的原因是**只有一份实现**：两处各写一句文案，迟早会漂移出可探测的差异。
func NotFoundError() *apperr.Error {
	return apperr.New(apperr.CodeNotFound, "上传会话不存在或已过期").
		WithHint("upload_id 来自 POST /api/client/v2/apps/wasm/uploads 的响应（" +
			strconv.Itoa(UploadIDHexLen) + " 位十六进制随机串）").
		WithHint("会话有效期 " + limits.UploadSessionTTL.String() + "：过期后需重新开启会话（已收到的片作废）").
		WithHint("会话只在**发起者本人**手里可见：换一个账号访问得到的是同一个 404")
}

// IndexParamError 是片序号**不是十进制整数**时的错误（形态问题，400）。
//
// 与 indexErr（越界）分开：两者的可操作修法不同（改格式 vs 改取值），而 path 参数
// 是外部入参 ⇒ 回显时必须**截断**（一个 10 KiB 的垃圾段落不能被原样回显）。
func IndexParamError(raw string) *apperr.Error {
	return apperr.Newf(apperr.CodeValidation, "片序号 %q 不是十进制整数", clipParam(raw)).
		WithDetail("index", clipParam(raw)).
		WithHint("片序号从 0 开始、是十进制整数（如 0、1、2）；片数 = ceil(total_bytes / chunk_bytes)")
}

// clipParam 把外部入参截到回显长度上限（错误体不该成为反射放大器）。
func clipParam(raw string) string {
	const max = 32
	if len(raw) <= max {
		return raw
	}
	return raw[:max] + "…"
}

// indexErr 是片序号越界（负数 / 超出片数上界）：§4.2 明写 400。
func indexErr(index int, count int) *apperr.Error {
	e := apperr.Newf(apperr.CodeValidation, "片序号 %d 越界（本会话共 %d 片，序号从 0 开始）", index, count).
		WithDetail("index", index).
		WithDetail("chunk_count", count).
		WithDetail("max_chunks", limits.UploadMaxChunks).
		WithHint("片序号必须在 [0, 片数-1] 内；片数 = ceil(total_bytes / chunk_bytes)")
	if index < 0 {
		e.WithDetail("reason", "negative")
	}
	return e
}

// ChunkTooLargeError 是单片超限的 413（**唯一实现**）。
//
// 导出它的原因：api 层必须"**先查 Content-Length** 再读体"（§4.2 原话），而尺寸
// 不变量的归属在本包 —— 两处各写一份文案迟早会漂移出"同一个错误两种说法"。
func ChunkTooLargeError(got, max int64) *apperr.Error { return chunkTooLargeErr(got, max) }

// chunkTooLargeErr 是单片超限（§4.2：单片 ≤ limits.UploadChunkMaxBytes）：413。
//
// 用 CodeBodyTooLarge（BODY_TOO_LARGE，413）而不是新造一个码：对客户端来说
// "这个请求体太大"就是它的语义，修法也只有一个 —— 切小。
func chunkTooLargeErr(got, max int64) *apperr.Error {
	return apperr.Newf(apperr.CodeBodyTooLarge, "单片 %s 超过上限 %s", humanBytes(got), humanBytes(max)).
		WithDetail("chunk_bytes", got).
		WithDetail("max_chunk_bytes", max).
		WithDetail("upload_chunk_min_bytes", int64(limits.UploadChunkMinBytes)).
		WithHint("单片上限就是 " + humanBytes(limits.UploadChunkMaxBytes) +
			"：把载荷切成更多片（客户端在 POST /uploads 时声明的 chunk_bytes 就是单片大小）").
		WithHint("超限的片**不会落盘**：服务端先判大小再写文件，重传该片即可（同序号上传是覆盖语义）")
}

// chunkTooSmallErr 是非尾片过小（§4.2：除最后一片外 ≥ limits.UploadChunkMinBytes）。
func chunkTooSmallErr(index, got int64) *apperr.Error {
	return apperr.Newf(apperr.CodeValidation, "第 %d 片只有 %s，低于单片下限 %s",
		index, humanBytes(got), humanBytes(limits.UploadChunkMinBytes)).
		WithDetail("index", index).
		WithDetail("chunk_bytes", got).
		WithDetail("min_chunk_bytes", int64(limits.UploadChunkMinBytes)).
		WithHint("除**最后一片**外每片都不得小于 " + humanBytes(limits.UploadChunkMinBytes) +
			"（片数本身是有界资源：下限防的是把载荷切成海量碎片）")
}

// totalOverflowErr 是"这一片会让累计超过 total_bytes"（增量拒，§4.2）：400。
func totalOverflowErr(received, incoming, total int64) *apperr.Error {
	return apperr.Newf(apperr.CodeValidation,
		"这一片会让累计达到 %s，超过会话声明的 total_bytes %s",
		humanBytes(received+incoming), humanBytes(total)).
		WithDetail("received_bytes", received).
		WithDetail("chunk_bytes", incoming).
		WithDetail("total_bytes", total).
		WithDetail("wasm_max_bytes", int64(limits.WasmMaxBytes)).
		WithHint("total_bytes 必须**恰好等于**各片之和：请核对切分逻辑（最后一片可以是余数）").
		WithHint("总量上限不因分片而放宽：整包仍受 " + humanBytes(limits.WasmMaxBytes) + " 约束；" +
			"若确实要传更大的模块，请精简资源（字体子集化、去掉调试符号）")
}

// internalErr 是"不该发生的错误"的统一出口（不外泄内部细节，只留 cause 给日志）。
func internalErr(msg string, cause error) *apperr.Error {
	return apperr.New(apperr.CodeInternal, msg).WithCause(cause)
}

// humanBytes 把字节数渲染成 MiB/KiB（错误文案用；数值来源仍是 limits 常量本身）。
func humanBytes(n int64) string {
	switch {
	case n >= 1<<20:
		return strconv.FormatFloat(float64(n)/(1<<20), 'f', 1, 64) + " MiB"
	case n >= 1<<10:
		return strconv.FormatFloat(float64(n)/(1<<10), 'f', 1, 64) + " KiB"
	default:
		return strconv.FormatInt(n, 10) + " B"
	}
}

// ---------------------------------------------------------------------------
// 路径与形态（路径穿越的第一道闸）
// ---------------------------------------------------------------------------

// ValidID 报告 upload_id 是否是规范形态（64 位小写十六进制）。
//
// 严格的全量校验（长度 + 字符集）是**路径安全**的前提：upload_id 会直接成为目录名，
// 任何"先拼接后校验"的写法都能被 `../` 或绝对路径穿过会话根。
func ValidID(id string) bool {
	if len(id) != UploadIDHexLen {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// dirChecked 校验 upload_id 并返回会话目录，**断言它仍在会话根之下**。
//
// 双保险的第二道：ValidID 已经排除了分隔符与 `..`，这里再断言一次父目录相等 ——
// 万一将来有人放宽了 ValidID（或把 root 配成了相对路径），越界会在第一层就炸成
// INTERNAL，而不是把某个无辜目录删掉。
//
// 2026-09-21（CodeQL #76-#90 `go/path-injection`）：再加一道**标准库判据**
// `filepath.IsLocal`。ValidID 的字符白名单比它更严，但那是本仓自写的循环，静态分析
// 不认；`filepath.IsLocal` 是 Go 官方对"该相对路径不会逃出根目录"的判据（拒绝绝对
// 路径、盘符与 `..` 逃逸），既让这条路径污染面在源码层可判定，也把防御叠在**唯一**
// 的会话目录入口上（所有会话目录都只经这一个函数产生）。
func (s *Store) dirChecked(id string) (string, *apperr.Error) {
	if !ValidID(id) || !filepath.IsLocal(id) {
		return "", NotFoundError()
	}
	dir := filepath.Join(s.root, id)
	if filepath.Dir(dir) != filepath.Clean(s.root) {
		return "", internalErr("上传会话路径越界（平台缺陷）", nil)
	}
	return dir, nil
}

func (s *Store) metaPath(dir string) string         { return filepath.Join(dir, metaFileName) }
func (s *Store) chunkName(i int) string             { return chunkPrefix + strconv.Itoa(i) }
func (s *Store) chunkPath(dir string, i int) string { return filepath.Join(dir, s.chunkName(i)) }

// newID 生成 upload_id（32 字节 crypto/rand ⇒ 不可枚举）。
func newID() (string, error) {
	var b [UploadIDBytes]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// ---------------------------------------------------------------------------
// 会话级互斥
// ---------------------------------------------------------------------------

// lockSession 取得某会话的互斥锁，返回释放函数（必须 defer 调用）。
//
// 非法 id 直接返回 no-op 释放函数：调用方（api 层）已经用 ValidID 挡过一道，
// 这里再挡一次是为了让"锁表"永远不会被垃圾 id 撑大。
func (s *Store) lockSession(id string) func() {
	if !ValidID(id) {
		return func() {}
	}
	s.lockMu.Lock()
	lk := s.locks[id]
	if lk == nil {
		lk = &sessionLock{}
		s.locks[id] = lk
	}
	lk.waiters++
	s.lockMu.Unlock()

	lk.mu.Lock()
	return func() {
		lk.mu.Unlock()
		s.lockMu.Lock()
		lk.waiters--
		// 无人持有且无人在等 ⇒ 回收表项（锁表因此只与"同时在用的会话数"同阶）。
		// 回收与新建都在 lockMu 之下，且等待者计数在加锁**之前**已 +1 ⇒
		// 不存在"新来的拿到新锁、旧的等待者拿到旧锁"的双持有窗口。
		if lk.waiters <= 0 {
			delete(s.locks, id)
		}
		s.lockMu.Unlock()
	}
}

// busy 报告某会话当前是否有协程在用（持有或等待会话锁）。
func (s *Store) busy(id string) bool {
	s.lockMu.Lock()
	defer s.lockMu.Unlock()
	lk := s.locks[id]
	return lk != nil && lk.waiters > 0
}

// ---------------------------------------------------------------------------
// 创建会话
// ---------------------------------------------------------------------------

// CreateInput 是开会话的输入（api 层从请求体映射）。
type CreateInput struct {
	AppID      string
	Version    string
	TotalBytes int64
	ChunkBytes int64
}

// Create 开启一个上传会话（§4.2）。
//
// 校验顺序有意：**身份与标识 → 体积 → 切分 → 配额**。前面的都是"请求本身不成立"
// （400/413），后面的才是"平台现在装不下"（429/413 配额）——让客户端先改对参数，
// 再去想要不要清掉旧会话。
func (s *Store) Create(publisher string, in CreateInput) (*Session, *apperr.Error) {
	if strings.TrimSpace(s.root) == "" || strings.TrimSpace(s.opt.DataRoot) == "" {
		return nil, internalErr("平台数据根未配置", nil)
	}
	publisher = strings.TrimSpace(publisher)
	if publisher == "" {
		// 平台缺陷：身份只能由调用方（api 层）从已认证会话取，绝不能来自请求体。
		return nil, internalErr("上传会话缺少发起者身份", nil)
	}
	appID := strings.TrimSpace(in.AppID)
	// §4.1/§10.5 第 52/53/53b：app_id 规则由 registry 唯一实现（含保留字与
	// 企业既有主机名）；这里**不做**静默小写（大写必须被拒，见 registry 注释）。
	if aerr := registry.ValidateAppID(appID, s.opt.AppIDExtraReserved); aerr != nil {
		return nil, aerr
	}
	version := strings.TrimSpace(in.Version)
	if verr := registry.ValidateVersion(version); verr != nil {
		return nil, verr
	}
	if in.TotalBytes <= 0 {
		return nil, apperr.New(apperr.CodeValidation, "total_bytes 必须为正整数").
			WithDetail("total_bytes", in.TotalBytes).
			WithHint("total_bytes 是 .wasm 的**确切**字节数（各片之和必须等于它）")
	}
	// R33：分片不改变总量上限（这是本包存在的意义之一）。
	if in.TotalBytes > limits.WasmMaxBytes {
		return nil, apperr.Newf(apperr.CodeWasmTooLarge,
			"模块体积 %s 超过上限 %s", humanBytes(in.TotalBytes), humanBytes(limits.WasmMaxBytes)).
			WithDetail("total_bytes", in.TotalBytes).
			WithDetail("max_wasm_bytes", int64(limits.WasmMaxBytes)).
			WithHint("分片解决的是**单次请求超时**（>8 MiB 必须分片），不是体积上限：" +
				"整包仍受 " + humanBytes(limits.WasmMaxBytes) + " 约束").
			WithHint("请压缩资源：字体做子集化、图片换 webp、去掉调试符号（Go: -ldflags=\"-s -w\"）")
	}
	if in.ChunkBytes < limits.UploadChunkMinBytes || in.ChunkBytes > limits.UploadChunkMaxBytes {
		return nil, apperr.Newf(apperr.CodeValidation,
			"chunk_bytes 必须在 [%s, %s] 之间", humanBytes(limits.UploadChunkMinBytes), humanBytes(limits.UploadChunkMaxBytes)).
			WithDetail("chunk_bytes", in.ChunkBytes).
			WithDetail("min_chunk_bytes", int64(limits.UploadChunkMinBytes)).
			WithDetail("max_chunk_bytes", int64(limits.UploadChunkMaxBytes)).
			WithHint("chunk_bytes 是客户端的切分大小；超过 " + humanBytes(limits.UploadChunkMaxBytes) +
				" 的片服务端会拒（单片即请求体），小于 " + humanBytes(limits.UploadChunkMinBytes) +
				" 会把 32 MiB 切成海量元数据")
	}
	count := chunkCount(in.TotalBytes, in.ChunkBytes)
	// 纵深防御：这条闸门在当前数值下**不可达**（32 MiB / 64 KiB 下限 = 512 片 ≤ 1024），
	// 但片数是"每次请求 + 一份元数据"的有界资源，未来一旦放宽 WasmMaxBytes 或
	// 调小片下限，它必须已经在位（§5.5「护栏不能只写在文档里」）。
	if count > limits.UploadMaxChunks {
		return nil, apperr.Newf(apperr.CodeValidation,
			"片数 %d 超过上限 %d", count, limits.UploadMaxChunks).
			WithDetail("chunk_count", count).
			WithDetail("max_chunks", limits.UploadMaxChunks).
			WithHint("请增大 chunk_bytes（每片 ≤ " + humanBytes(limits.UploadChunkMaxBytes) + "）")
	}

	now := s.now()
	// 每用户并发会话数与磁盘配额：先回收该用户**已过期**的会话，再判定。
	// 顺序有语义：过期会话不该继续占着槽位（那会让"等 30 分钟"变成唯一的自救方式）。
	live, reserved, disk, uerr := s.userUsage(publisher, now)
	if uerr != nil {
		return nil, internalErr("上传会话目录不可读", uerr)
	}
	if live >= limits.UploadSessionsPerUser {
		e := apperr.Newf(apperr.CodeRateLimited,
			"未完成的上传会话已达上限（每用户 %d 个）", limits.UploadSessionsPerUser).
			WithDetail("sessions", live).
			WithDetail("max_sessions", limits.UploadSessionsPerUser).
			WithDetail("retry_after_seconds", int(limits.RetryAfterSeconds)).
			WithHint("先 DELETE 不再需要的会话（它只回收磁盘，不影响已发布的版本），" +
				"或等待它们过期（有效期 " + limits.UploadSessionTTL.String() + " 后自动回收）")
		return nil, e
	}
	// 每用户磁盘配额（审计 FIX-44；§6「单应用无法拖垮平台」的磁盘那一笔）。
	//
	// 判据 = **该用户未过期会话的声明总量之和（预留）+ 本次声明的 total_bytes** ≤
	// limits.UploadBodyMaxBytes（48 MiB）。三个决定连着看：
	//
	//  1. **为什么判据是"声明量"而不是"已落盘字节"**：声明量是**预留**，而 Put 的增量闸门
	//     保证每个会话的实际字节 ≤ 它的 total_bytes ⇒ `Σ实际 ≤ Σ声明 ≤ 配额` 在**任何时刻**
	//     都成立 —— 这是一条真正的上界，且不需要在热路径上做任何统计。
	//     反过来，把 `used` 换成"实际字节"就**不再是上界**：客户端可以先把 4 个会话都开出来
	//     （各声明 32 MiB、实际 0 字节，逐个都满足 `0 + 32 MiB ≤ 48 MiB`），再慢慢把它们
	//     填满 ⇒ 实际 128 MiB > 配额 48 MiB（那样得到的是一条"看着像闸门、其实只管住开会话
	//     那一刻"的装饰）。真要按实际字节拦，判据就必须落在 Put 上（每片一次全根目录扫描 +
	//     一个用户级锁才不会有并发窗口），代价与收益不成比例，而"预留"严格强于"实际"。
	//
	//  2. **为什么上限是 48 MiB，而不是"会话数上限 × WasmMaxBytes"（128 MiB）**：后者在算术上
	//     **永远打不到** —— 取得上界的那组输入恰好等于上界（严格 `>` 恒假），审计 P2-1 记的就是
	//     这条"永远为假的守卫"。取 48 MiB 之后**两条闸门各自都能触发**、谁都不是摆设：
	//     大会话（已声明 32 MiB，再开一个 32 MiB）先撞配额；小会话（4 × 8 MiB = 32 MiB）
	//     先撞会话数。它同时是平台对"一次上传最多占多少字节"的既有口径（同一个 limits 常量），
	//     语义自洽："一个人的未完成上传不超过一次上传的体量"。
	//
	//  3. **真实每用户磁盘上界** = min(配额, 会话数上限 × WasmMaxBytes) = **48 MiB**
	//     （错误明细同时给出两个口径：reserved_bytes = 预留，used_bytes = 实际落盘，
	//     后者任何时候都不超过前者）。
	//     代价：4 个"各 32 MiB"的会话不再可能（最大 = 32 MiB + 16 MiB，或 4 个 12 MiB）。
	//     这是刻意的取舍：单人 128 MiB 的未完成上传驻留换不来任何产品能力（§4.2 只要求
	//     ">8 MiB 走分片 + 续传"，而每个用户的编译并发恒为 1 ⇒ 大会话本来就是串行用的），
	//     而一条真的会触发的闸门能防住"循环开会话占盘"。
	//
	// 已知边界（如实记录）：Create 不是原子的（两个并发 Create 可能各读到旧值，都通过判定），
	// 瞬时上界因此最多超出一笔（+WasmMaxBytes）。会话数闸门有同样的性质。
	quota := int64(limits.UploadDiskQuotaPerUserBytes)
	if reserved+in.TotalBytes > quota {
		return nil, apperr.Newf(apperr.CodeBodyTooLarge,
			"未完成会话已预留 %s（实际已落盘 %s），新增声明 %s 会超过每用户上传配额 %s",
			humanBytes(reserved), humanBytes(disk), humanBytes(in.TotalBytes), humanBytes(quota)).
			WithDetail("quota_bytes", quota).
			WithDetail("reserved_bytes", reserved).
			WithDetail("used_bytes", disk).
			WithDetail("incoming_bytes", in.TotalBytes).
			WithDetail("max_sessions", limits.UploadSessionsPerUser).
			WithHint("先完成或 DELETE 不再需要的会话再开新的（每用户同时最多 " +
				strconv.Itoa(limits.UploadSessionsPerUser) + " 个会话，合计预留 " + humanBytes(quota) + "）").
			WithHint("配额按**声明总量**计：开会话声明的 total_bytes 立即占用额度，" +
				"完成/DELETE/过期后释放；实际落盘不会超过预留")
	}

	id, gerr := newID()
	if gerr != nil {
		return nil, internalErr("生成上传会话标识失败", gerr)
	}
	dir := filepath.Join(s.root, id)
	if err := os.MkdirAll(dir, os.FileMode(limits.DataDirMode)); err != nil {
		return nil, internalErr("上传会话目录创建失败", err)
	}
	// MkdirAll 的权限会被 umask 削（进程 umask 可能是 022）⇒ 显式 chmod。
	if err := os.Chmod(dir, os.FileMode(limits.DataDirMode)); err != nil {
		_ = os.RemoveAll(dir)
		return nil, internalErr("上传会话目录权限设置失败", err)
	}
	sess := &Session{
		UploadID:   id,
		AppID:      appID,
		Version:    version,
		Publisher:  publisher,
		TotalBytes: in.TotalBytes,
		ChunkBytes: in.ChunkBytes,
		Received:   []int{},
		CreatedAt:  now,
		ExpiresAt:  now.Add(limits.UploadSessionTTL),
	}
	if werr := s.writeMeta(dir, sess); werr != nil {
		_ = os.RemoveAll(dir) // 半成品目录不留：它没有任何可续传的价值
		return nil, internalErr("上传会话元数据写入失败", werr)
	}
	return sess, nil
}

// ---------------------------------------------------------------------------
// 写入一片
// ---------------------------------------------------------------------------

// Put 写入第 index 片（**乱序到达是常态**：片文件按序号命名，complete 时按序拼装）。
//
// 幂等：同一 index 重复上传是**覆盖**该片（续传的自然语义 —— 客户端不知道上一次
// 那片到底落盘了没有，重传必须能修好一个截断的片）。
//
// body 已经在内存里（api 层读体时已按 Content-Length + MaxBytesReader 限过一次）。
// 这里再判一次尺寸是**唯一权威**：本包的调用者不止 HTTP 层，不变量的归属必须是本包。
//
// 关键顺序（§4.2「单片超限 ⇒ 413 且不落盘」）：**全部尺寸/累计判定都在写文件之前**。
func (s *Store) Put(publisher, id string, index int, body []byte) (*Session, *apperr.Error) {
	dir, derr := s.dirChecked(id)
	if derr != nil {
		return nil, derr
	}
	release := s.lockSession(id)
	defer release()

	sess, oerr := s.openLocked(dir, publisher, id, s.now())
	if oerr != nil {
		return nil, oerr
	}
	count := sess.ChunkCount()
	if index < 0 || index >= count {
		return nil, indexErr(index, count)
	}
	if serr := checkChunkSize(index, count, int64(len(body))); serr != nil {
		return nil, serr
	}
	// 增量闸门：累计（不含本片旧内容）加上这一片不得越过 total_bytes。
	// 必须先扣掉"本片已收到的旧尺寸"，否则重传一片会被自己上一次的字节挤爆。
	incoming := int64(len(body))
	if prev, ok := s.chunkSize(dir, index); ok {
		sess.receivedBytes -= prev
	}
	if sess.receivedBytes+incoming > sess.TotalBytes {
		return nil, totalOverflowErr(sess.receivedBytes, incoming, sess.TotalBytes)
	}
	// 纵深防御：total_bytes 已在 Create 卡过 32 MiB，这里再按实际累计判一次
	// （meta.json 若被外部改坏，也不能让内存分配越过 WasmMaxBytes）。
	if sess.receivedBytes+incoming > limits.WasmMaxBytes {
		return nil, chunkTooLargeErr(sess.receivedBytes+incoming, limits.WasmMaxBytes)
	}

	// 原子落盘：写 `<dir>/chunk-<i>.tmp` 再 rename（崩溃不会留下截断的片）。
	tmp := s.chunkPath(dir, index) + tmpSuffix
	if err := os.WriteFile(tmp, body, 0o600); err != nil {
		_ = os.Remove(tmp)
		return nil, internalErr("分片写入失败", err)
	}
	if err := os.Rename(tmp, s.chunkPath(dir, index)); err != nil {
		_ = os.Remove(tmp)
		return nil, internalErr("分片落位失败", err)
	}
	sess.Received = mergeIndex(sess.Received, index)
	sess.receivedBytes += incoming
	// meta.json 是**持久镜像**（磁盘目录才是真源）：崩在 rename 与 writeMeta 之间时，
	// 下一次读取会用目录扫描把这一片补回来（见 openLocked）—— 这正是"续传不丢片"。
	if werr := s.writeMeta(dir, sess); werr != nil {
		return nil, internalErr("上传会话元数据更新失败", werr)
	}
	return sess, nil
}

// checkChunkSize 是单片尺寸规则（PUT 与 complete 的**同一份**判据）。
func checkChunkSize(index, count int, size int64) *apperr.Error {
	switch {
	case size <= 0:
		return apperr.New(apperr.CodeValidation, "空片不予接受").
			WithDetail("index", index).
			WithDetail("chunk_bytes", size).
			WithHint("每片都必须有内容：整包体积由 total_bytes 声明，空片只会让累计永远对不上")
	case size > limits.UploadChunkMaxBytes:
		return chunkTooLargeErr(size, limits.UploadChunkMaxBytes)
	case index < count-1 && size < limits.UploadChunkMinBytes:
		return chunkTooSmallErr(int64(index), size)
	}
	return nil
}

// mergeIndex 把 index 并入升序去重的序号表（已存在则原样返回）。
func mergeIndex(in []int, index int) []int {
	out := make([]int, 0, len(in)+1)
	inserted := false
	for _, v := range in {
		switch {
		case v == index:
			inserted = true
			out = append(out, v)
		case v > index && !inserted:
			out = append(out, index, v)
			inserted = true
		default:
			out = append(out, v)
		}
	}
	if !inserted {
		out = append(out, index)
	}
	return out
}

// ---------------------------------------------------------------------------
// 查询 / 放弃
// ---------------------------------------------------------------------------

// Open 读取会话（**续传查询**与 PUT 的前置检查共用）。
//
// 过期会话在这里被**回收**（惰性 GC）：客户端拿到 404 的同时，磁盘上的目录也已经
// 没了 —— "过期"是一个可以被任意客户端触发的状态，回收不能只等调度器那一轮。
func (s *Store) Open(publisher, id string) (*Session, *apperr.Error) {
	dir, derr := s.dirChecked(id)
	if derr != nil {
		return nil, derr
	}
	release := s.lockSession(id)
	defer release()
	return s.openLocked(dir, publisher, id, s.now())
}

// Discard 主动放弃一个会话（DELETE 端点；<c>回收磁盘</c>）。
func (s *Store) Discard(publisher, id string) *apperr.Error {
	dir, derr := s.dirChecked(id)
	if derr != nil {
		return derr
	}
	release := s.lockSession(id)
	defer release()
	if _, oerr := s.openLocked(dir, publisher, id, s.now()); oerr != nil {
		return oerr
	}
	if err := os.RemoveAll(dir); err != nil {
		return internalErr("上传会话目录删除失败", err)
	}
	return nil
}

// openLocked 在**已持有会话锁**的前提下读取会话（调用方负责加锁）。
func (s *Store) openLocked(dir, publisher, id string, now time.Time) (*Session, *apperr.Error) {
	sess, err := s.readMeta(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, NotFoundError()
		}
		// 元数据损坏（磁盘错误/外部改写）：对客户端与"不存在"同解 —— 这个会话
		// 没有任何可续传的状态了，报一个能读懂的 404 比漏内部路径的 500 有用。
		s.logf("wasm: 上传会话元数据不可读 id=%s: %v", id, err)
		return nil, NotFoundError()
	}
	sess.UploadID = id // 目录名是权威（meta 里的副本只用于自描述）
	// 跨用户访问一律 404：这里与"不存在"共用同一个错误对象（含 hints），
	// 连响应体都逐字相同（§4.2：不泄露存在性）。
	if sess.Publisher != publisher {
		return nil, NotFoundError()
	}
	if sess.Expired(now) {
		_ = os.RemoveAll(dir) // 过期即回收（磁盘不驻留）
		return nil, NotFoundError()
	}
	// 与磁盘对齐：`received` 只保留**文件确实存在**的序号，并顺手补上"文件在、
	// meta 里没有"的片（崩在 rename 与 writeMeta 之间的那一瞬间）。
	idx, sizes, cerr := s.scanChunks(dir, sess.ChunkCount())
	if cerr != nil {
		return nil, internalErr("上传会话目录读取失败", cerr)
	}
	sess.Received = idx
	sess.receivedBytes = 0
	for _, i := range idx {
		sess.receivedBytes += sizes[i]
	}
	return sess, nil
}

// readMeta 读并解析 meta.json（不做任何业务判定）。
func (s *Store) readMeta(dir string) (*Session, error) {
	raw, err := os.ReadFile(s.metaPath(dir))
	if err != nil {
		return nil, err
	}
	var sess Session
	if err := json.Unmarshal(raw, &sess); err != nil {
		return nil, fmt.Errorf("解析 meta.json 失败: %w", err)
	}
	if sess.TotalBytes <= 0 || sess.ChunkBytes <= 0 {
		return nil, fmt.Errorf("meta.json 缺 total_bytes/chunk_bytes")
	}
	if sess.Publisher == "" {
		return nil, fmt.Errorf("meta.json 缺 publisher")
	}
	return &sess, nil
}

// writeMeta 原子写 meta.json（tmp + rename）。
//
// 不 fsync：崩掉一个未完成的上传会话是客户端**可恢复**的（重开一个即可），
// 而在同步发布路径上等一次磁盘落盘是纯成本。
func (s *Store) writeMeta(dir string, sess *Session) error {
	if sess.Received == nil {
		sess.Received = []int{} // JSON 里必须是 `[]`：`null` 会让客户端多一层判空
	}
	raw, err := json.Marshal(sess)
	if err != nil {
		return err
	}
	tmp := s.metaPath(dir) + tmpSuffix
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.metaPath(dir))
}

// scanChunks 扫描会话目录，返回**实际存在**的片序号（升序）与各片大小。
//
// 它是"磁盘是真源"这条口径的实现：只认无后缀的 `chunk-<数字>`（临时文件与
// 任何别的文件都不算），越界序号（内部结构损坏时）直接忽略。
func (s *Store) scanChunks(dir string, count int) ([]int, map[int]int64, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, nil, err
	}
	sizes := make(map[int]int64, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasPrefix(name, chunkPrefix) {
			continue
		}
		idx, cerr := strconv.Atoi(strings.TrimPrefix(name, chunkPrefix))
		if cerr != nil || idx < 0 || idx >= count {
			continue
		}
		fi, ferr := e.Info()
		if ferr != nil {
			continue
		}
		sizes[idx] = fi.Size()
	}
	out := make([]int, 0, len(sizes))
	for i := range sizes {
		out = append(out, i)
	}
	sort.Ints(out)
	return out, sizes, nil
}

// chunkSize 返回某片当前的大小（不存在返回 false）。
func (s *Store) chunkSize(dir string, index int) (int64, bool) {
	fi, err := os.Stat(s.chunkPath(dir, index))
	if err != nil {
		return 0, false
	}
	return fi.Size(), true
}

// ---------------------------------------------------------------------------
// 拼装 + 交给发布链路
// ---------------------------------------------------------------------------

// Complete 在**会话锁内**拼装整包字节并把它交给 publish 回调（发布链路的唯一实现
// 在 api 包，本包不复制任何发布逻辑）。
//
// 锁的粒度是"整个 complete"：重放判定 + 拼装 + 发布 + 删除会话是一个整体（§4.2：
// complete 与 PUT 互斥）。代价是同一会话的 PUT 要等一次发布（最长 60 s 编译预算），
// 收益是"拼到一半有人 PUT 了一片"这种状态**结构上不存在**。
//
// 成功（publish 返回 nil 错误）：
//   - 成功响应体进**幂等重放缓存**（同一用户重复 complete 拿到逐字相同的 201 体，
//     不重新编译、不重复落库 —— 客户端在丢响应后有确定的恢复路径）；
//   - 会话目录**立即删除**（磁盘不驻留）。
//
// 失败：会话**原样保留**（客户端可以只补缺失的片后重试 —— 这是续传的意义）。
//
// 重放判定在锁内（审计 FIX-45）：第二次调用若发现该会话已有成功体，直接回放而**不再**
// 调用 publish 回调 —— 首次仍在进行中时，第二次调用会先在会话锁上等待，然后拿到回放。
//
// 这是**完整的单调用入口**（= BeginComplete 租约 + 租约内发布）。api 层需要把"发布水位
// 闸门/请求体解析"也放进同一个临界区时，用 BeginComplete + CompleteLease.Complete。
func (s *Store) Complete(publisher, id string, publish func(wasm []byte, sess *Session) ([]byte, *apperr.Error)) ([]byte, *apperr.Error) {
	lease, replay, lerr := s.BeginComplete(publisher, id)
	if lerr != nil {
		return nil, lerr
	}
	defer lease.Release()
	if replay != nil {
		return replay, nil
	}
	return lease.Complete(publish)
}

// ---------------------------------------------------------------------------
// complete 单飞（同会话同时只允许一次发布尝试）
// ---------------------------------------------------------------------------

// CompleteLease 是一次"同会话 complete"的租约（BeginComplete 的返回值）。
//
// 它存在的唯一理由（审计 FIX-45）：**重放缓的查/写必须与本次发布处在同一个临界区**。
// 旧实现里重放缓只在 api 层、会话锁**之外**查：首次仍在编译时到达的重复 complete
// 在锁外查不到缓存，于是被"同时 1 次编译"的并发闸门拦成 429 —— 而契约要求的是
// "等待首次结束、回放逐字相同的 201"。
//
// 租约就是**会话锁本身**（不新增锁层，也就没有第二套顺序问题）：持租约期间同会话的
// PUT / Open / Discard / 另一个 complete 全部排队 —— 与既有语义一致（complete 与 PUT
// 互斥），只是临界区从"拼装 + 发布"扩到"整次请求"（闸门与请求体解析也在其中）。
type CompleteLease struct {
	store     *Store
	id        string
	publisher string
	release   func()
}

// Release 释放租约（幂等；**回放命中时返回的租约是 no-op**，因此调用方可以无条件 defer）。
func (l *CompleteLease) Release() {
	if l == nil || l.release == nil {
		return
	}
	l.release()
	l.release = nil
}

// Complete 在租约内完成一次发布：拼装 → publish 回调 → 成功即删目录 + 记重放缓存。
//
// 这个方法的 Receiver 只能来自 BeginComplete（没有别的构造入口），所以"没拿租约就发布"
// 在类型上就写不出来。
func (l *CompleteLease) Complete(publish func(wasm []byte, sess *Session) ([]byte, *apperr.Error)) ([]byte, *apperr.Error) {
	if l == nil || l.store == nil {
		// 回放命中时返回的那个 no-op 租约被误用：回放体已经给出去了，这里再发布一次
		// 会变成重复发布 ⇒ 明确报错，绝不静默重放第二遍。
		return nil, internalErr("complete 租约不可用于发布（该会话已成功发布过，应直接回放）", nil)
	}
	return l.store.completeLocked(l.publisher, l.id, publish)
}

// BeginComplete 取得某会话的 complete 租约（**会话锁 + 锁内重放判定**）。
//
// 语义：
//   - 该会话已经有成功体（可能是刚刚在这里等到的）⇒ 返回 `replay != nil`：直接回放这份
//     字节，**不要**调用租约的 Complete（它是 no-op，Release 也是 no-op）；
//   - 否则 ⇒ 返回 `replay == nil`：调用者是唯一的"首个"（其余并发者都排在这把锁上），
//     必须 `defer lease.Release()` 并在闸门/解析之后用 `lease.Complete(...)` 发布。
//
// 两条返回路径都是"拿到锁之后才判定"，所以并发/交错的重复 complete 一定表现为
// "等待首个结束 → 回放"，而不是并发闸门 429（审计 FIX-45 的判据）。
func (s *Store) BeginComplete(publisher, id string) (*CompleteLease, []byte, *apperr.Error) {
	if !ValidID(id) {
		return nil, nil, NotFoundError()
	}
	release := s.lockSession(id)
	if body, ok := s.Completed(id, publisher); ok {
		release()
		return &CompleteLease{}, body, nil
	}
	return &CompleteLease{store: s, id: id, publisher: publisher, release: release}, nil, nil
}

// completeLocked 在**已持租约**（= 会话锁）的前提下完成一次发布（BeginComplete 之后的
// 唯一发布路径；直接调用而不先 BeginComplete 是编程错误）。
func (s *Store) completeLocked(publisher, id string, publish func(wasm []byte, sess *Session) ([]byte, *apperr.Error)) ([]byte, *apperr.Error) {
	dir, derr := s.dirChecked(id)
	if derr != nil {
		return nil, derr
	}
	if publish == nil {
		return nil, internalErr("发布回调未配置", nil)
	}
	sess, oerr := s.openLocked(dir, publisher, id, s.now())
	if oerr != nil {
		return nil, oerr
	}
	wasm, aerr := s.assemble(dir, sess)
	if aerr != nil {
		return nil, aerr
	}
	body, perr := publish(wasm, sess)
	if perr != nil {
		return nil, perr
	}
	s.markCompleted(id, publisher, body)
	if err := os.RemoveAll(dir); err != nil {
		// 删不掉不是本次发布的失败（版本已经生效）：记一行，等 Cleanup 过期回收。
		s.logf("wasm: 上传会话目录删除失败（已计入过期回收）id=%s: %v", id, err)
	}
	return body, nil
}

// assemble 按序号拼装整包（先判后读：缺片与体积不符都在**分配内存之前**判掉）。
func (s *Store) assemble(dir string, sess *Session) ([]byte, *apperr.Error) {
	count := sess.ChunkCount()
	sizes := make([]int64, count)
	missing := make([]int, 0)
	var sum int64
	for i := 0; i < count; i++ {
		size, ok := s.chunkSize(dir, i)
		if !ok {
			missing = append(missing, i)
			continue
		}
		if serr := checkChunkSize(i, count, size); serr != nil {
			// 落到盘上的片尺寸不合规（外部改写/半截写入）：与 PUT 同一份判据，
			// 提示客户端重传该片（覆盖语义）。
			return nil, serr.WithDetail("phase", "assemble")
		}
		sizes[i] = size
		sum += size
	}
	if len(missing) > 0 {
		return nil, apperr.Newf(apperr.CodeValidation, "还有 %d 片没有收到，无法拼装", len(missing)).
			WithDetail("missing_chunks", missing).
			WithDetail("received", sess.Received).
			WithDetail("chunk_count", count).
			WithHint("先 PUT 缺失的片（序号从 0 开始）再 complete；" +
				"GET /uploads/:upload_id 可以随时查询已收到哪些片（断线续传就靠它）")
	}
	// §4.2：「sum(片) 必须**恰好等于** total_bytes（否则 complete 拒）」。
	// 这一条与"缺片"不同：所有片都在，但总量对不上（客户端切分逻辑把总量算错了）。
	if sum != sess.TotalBytes {
		return nil, apperr.Newf(apperr.CodeValidation,
			"各片之和 %s 与会话声明的 total_bytes %s 不符", humanBytes(sum), humanBytes(sess.TotalBytes)).
			WithDetail("received_bytes", sum).
			WithDetail("total_bytes", sess.TotalBytes).
			WithDetail("diff_bytes", sum-sess.TotalBytes).
			WithHint("total_bytes 必须是各片之和：最常见的成因是最后一片多算了（余数算错）或漏算了")
	}
	if sum > limits.WasmMaxBytes {
		// 纵深防御：Create 已卡过 total_bytes，这里按实际字节再判一次。
		return nil, apperr.Newf(apperr.CodeWasmTooLarge,
			"拼装体积 %s 超过上限 %s", humanBytes(sum), humanBytes(limits.WasmMaxBytes)).
			WithDetail("total_bytes", sum).
			WithDetail("max_wasm_bytes", int64(limits.WasmMaxBytes))
	}

	// 一次性按确切体积分配（≤ 32 MiB），再逐片读满：避免 bytes.Buffer 的反复扩容，
	// 也让"拼出来的字节数"由 total_bytes 这一个数决定。
	buf := make([]byte, sum)
	off := int64(0)
	for i := 0; i < count; i++ {
		n, rerr := readFullAt(s.chunkPath(dir, i), buf[off:off+sizes[i]])
		if rerr != nil || int64(n) != sizes[i] {
			return nil, internalErr("分片读取失败", rerr).
				WithDetail("index", i).
				WithHint("该片在拼装期间发生了变化（外部改动？）：请重传这一片后再 complete")
		}
		off += sizes[i]
	}
	return buf, nil
}

// readFullAt 把 path 的**前 len(dst) 字节**读满（返回实际读到的字节数）。
func readFullAt(path string, dst []byte) (int, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer func() { _ = f.Close() }()
	n, err := io.ReadFull(f, dst)
	if errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, io.EOF) {
		return n, fmt.Errorf("片文件比预期短（读到 %d 字节，期望 %d）", n, len(dst))
	}
	return n, err
}

// ---------------------------------------------------------------------------
// 幂等重放缓存
// ---------------------------------------------------------------------------

// Completed 返回某会话已成功发布的响应体（幂等重放；不存在/过期/跨用户 ⇒ false）。
func (s *Store) Completed(id, publisher string) ([]byte, bool) {
	if !ValidID(id) {
		return nil, false
	}
	key := doneKey(id, publisher)
	s.doneMu.Lock()
	defer s.doneMu.Unlock()
	ent, ok := s.done[key]
	if !ok {
		return nil, false
	}
	if !s.now().Before(ent.expires) {
		s.dropDoneLocked(key)
		return nil, false
	}
	return ent.body, true
}

// markCompleted 记录一次成功发布（TTL 与会话有效期同源，容量有界）。
func (s *Store) markCompleted(id, publisher string, body []byte) {
	if len(body) == 0 {
		return
	}
	key := doneKey(id, publisher)
	s.doneMu.Lock()
	defer s.doneMu.Unlock()
	if _, ok := s.done[key]; !ok {
		s.doneOrder = append(s.doneOrder, key)
	}
	s.done[key] = completedEntry{body: body, expires: s.now().Add(limits.UploadSessionTTL)}
	for len(s.doneOrder) > completedCacheMax {
		s.dropDoneLocked(s.doneOrder[0])
	}
}

// dropDoneLocked 删除一条缓存（调用方必须持有 doneMu）。
func (s *Store) dropDoneLocked(key string) {
	delete(s.done, key)
	for i, k := range s.doneOrder {
		if k == key {
			s.doneOrder = append(s.doneOrder[:i], s.doneOrder[i+1:]...)
			return
		}
	}
}

// doneKey 把会话与**发起者**绑在一起：别人的 upload_id 即使猜中，也读不到这一条
// （与文件系统那条路径同一个判据）。
func doneKey(id, publisher string) string { return id + "\x00" + publisher }

// pruneCompleted 清掉过期的重放条目（Cleanup 与查询路径都会顺手调）。
func (s *Store) pruneCompleted(now time.Time) int {
	s.doneMu.Lock()
	defer s.doneMu.Unlock()
	removed := 0
	for _, key := range append([]string(nil), s.doneOrder...) {
		if !now.Before(s.done[key].expires) {
			s.dropDoneLocked(key)
			removed++
		}
	}
	return removed
}

// ---------------------------------------------------------------------------
// 配额与回收
// ---------------------------------------------------------------------------

// userUsage 统计某用户**当前未过期**的会话数、声明总量与实际落盘字节，并顺手回收其
// 已过期会话。
//
// 两个口径都要（审计 FIX-44）：**判定用声明量**（预留，恒 ≥ 实际；见 Create 的注释），
// 而实际字节要进错误明细与测试断言 —— "配额是不是真的管住了磁盘"只有把两个数都摆出来
// 才是可验证的（而不是靠注释自称）。实际字节的扫描只覆盖该用户自己的会话目录
// （≤ 会话数上限个），且 Create 本来就要扫一遍根目录，因此不引入热路径成本。
func (s *Store) userUsage(publisher string, now time.Time) (live int, reserved int64, disk int64, err error) {
	entries, rerr := os.ReadDir(s.root)
	if rerr != nil {
		if errors.Is(rerr, os.ErrNotExist) {
			return 0, 0, 0, nil
		}
		return 0, 0, 0, rerr
	}
	for _, e := range entries {
		if !e.IsDir() || !ValidID(e.Name()) {
			continue
		}
		id := e.Name()
		dir := filepath.Join(s.root, id)
		sess, merr := s.readMeta(dir)
		if merr != nil || sess == nil || sess.Publisher != publisher {
			continue
		}
		if sess.Expired(now) {
			s.reclaimExpired(id, now)
			continue
		}
		live++
		reserved += sess.TotalBytes
		// 实际字节是**派生量**（磁盘才是真源）：读不到就按 0 计（它只影响错误明细，
		// 不影响判定），不因为一个读不了的目录把一次正常的开会话变成 500。
		if _, sizes, cerr := s.scanChunks(dir, sess.ChunkCount()); cerr == nil {
			for _, n := range sizes {
				disk += n
			}
		}
	}
	return live, reserved, disk, nil
}

// reclaimExpired 回收一个**已确认过期**的会话（拿锁后复查，避免删掉正在写的会话）。
func (s *Store) reclaimExpired(id string, now time.Time) bool {
	if !ValidID(id) {
		return false
	}
	release := s.lockSession(id)
	defer release()
	sess, err := s.readMeta(filepath.Join(s.root, id))
	if err != nil || sess == nil || !sess.Expired(now) {
		return false
	}
	if rerr := os.RemoveAll(filepath.Join(s.root, id)); rerr != nil {
		s.logf("wasm: 过期上传会话回收失败 id=%s: %v", id, rerr)
		return false
	}
	return true
}

// Cleanup 回收全部已过期会话（CleanupScheduler 的调用面，§4.2 的 30 分钟有效期）。
//
// 两条纪律：
//   - **不阻塞在飞请求**：正在被使用的会话（busy）这一轮跳过 —— 一个 complete 可能
//     持锁几十秒（同步编译），调度器没有理由陪它等；它自己的代码路径会处理过期
//     （openLocked 看到过期即删）。
//   - **不认识的东西不乱删**：会话根下非 `chunk-*` 的残留只按目录 mtime 判（超过
//     TTL 才删），因为"目录刚建好、meta 还没写"是 Create 的正常瞬间形态。
func (s *Store) Cleanup(ctx context.Context, now time.Time) (int, error) {
	s.pruneCompleted(now)
	entries, err := os.ReadDir(s.root)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return 0, nil
		}
		return 0, err
	}
	removed := 0
	for _, e := range entries {
		if ctx != nil && ctx.Err() != nil {
			// 进程退出中：本轮到此为止（下一轮的"启动即清一次"会补上）。
			return removed, nil
		}
		if !e.IsDir() || !ValidID(e.Name()) {
			continue
		}
		id := e.Name()
		if s.busy(id) {
			continue
		}
		dir := filepath.Join(s.root, id)
		sess, merr := s.readMeta(dir)
		if merr != nil {
			// 半成品/损坏目录：只在它明显"停在那里"（mtime 超过 TTL）时删。
			if staleDir(dir, now) {
				if rerr := os.RemoveAll(dir); rerr == nil {
					removed++
				}
			}
			continue
		}
		if sess.Expired(now) {
			if rerr := os.RemoveAll(dir); rerr == nil {
				removed++
			}
			continue
		}
		// 未过期但残留了临时文件（进程崩在 rename 之前）：清掉，别让它占盘。
		_ = removeStaleTemps(dir, now)
	}
	return removed, nil
}

// staleDir 报告目录的最后修改时间是否已超过会话有效期。
func staleDir(dir string, now time.Time) bool {
	fi, err := os.Stat(dir)
	if err != nil {
		return false
	}
	return now.Sub(fi.ModTime()) > limits.UploadSessionTTL
}

// removeStaleTemps 清掉会话目录里超期的 `*.tmp`（返回删除个数）。
func removeStaleTemps(dir string, now time.Time) int {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	removed := 0
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), tmpSuffix) {
			continue
		}
		fi, ierr := e.Info()
		if ierr != nil || now.Sub(fi.ModTime()) <= limits.UploadSessionTTL {
			continue
		}
		if rerr := os.Remove(filepath.Join(dir, e.Name())); rerr == nil {
			removed++
		}
	}
	return removed
}
