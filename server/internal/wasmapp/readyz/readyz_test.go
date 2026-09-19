package readyz

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/queue"
)

// 变异验证：
//   - Snapshot 去掉磁盘水位判断 ⇒ TestSnapshotDiskWatermark 必红；
//   - AllowPublish 不再过滤 ⇒ TestAllowPublishFailClosed 必红；
//   - AcquireInstanceLock 去掉 flock ⇒ TestInstanceLockExclusive 必红；
//   - ComputeMemoryBudget 去掉 70% 判定 ⇒ TestMemoryBudget 必红；
//   - CompileAvailability 恒置 Available=true（或不读它）⇒
//     TestSnapshotCompileUnavailableIsDistinguishable、
//     TestAllowPublishBlocksOnCompileUnavailable 必红；
//   - Snapshot 不再暴露 events 计数 ⇒ TestSnapshotExposesEventCounters 必红；
//   - AllowPublish 去掉 e.HTTP=503 ⇒ TestAllowPublishStatusIsServiceUnavailable 必红。

func fixedOpts(free int64, cs *CompilerStatsSnapshot) Options {
	o := Options{
		DataRoot: "/tmp",
		Now:      func() time.Time { return time.Unix(1_700_000_000, 0) },
		DiskFree: func(string) (int64, error) { return free, nil },
		MemAvailable: func() MemoryAvailability {
			return MemoryAvailability{Bytes: 8 << 30, Source: MemorySourceHost}
		},
	}
	if cs != nil {
		c := *cs
		o.Compiler = func() CompilerStatsSnapshot { return c }
	}
	return o
}

// TestSnapshotDiskWatermark：§4.9 —— 磁盘低于阈值必须红灯
// （现网 healthz 只 db.Ping，磁盘满仍 healthy 正是本探针要补的洞）。
func TestSnapshotDiskWatermark(t *testing.T) {
	c := New(fixedOpts(MinDiskFreeBytes-1, nil))
	s := c.Snapshot()
	if s.OK {
		t.Fatal("磁盘余量低于红线必须 NOT OK")
	}
	if len(s.Reasons) == 0 {
		t.Fatal("必须给出原因")
	}
	// 恰好等于红线 ⇒ 通过。
	c = New(fixedOpts(MinDiskFreeBytes, nil))
	if s := c.Snapshot(); !s.OK {
		t.Fatalf("恰好等于红线应通过，got %v", s.Reasons)
	}
}

func TestSnapshotCompilerWatermarks(t *testing.T) {
	// 队列满 ⇒ 红灯。
	c := New(fixedOpts(MinDiskFreeBytes, &CompilerStatsSnapshot{QueueDepth: limits.CompileQueueDepth}))
	if s := c.Snapshot(); s.OK {
		t.Fatal("编译队列满必须红灯")
	}
	// 缓存超上限 ⇒ 红灯。
	c = New(fixedOpts(MinDiskFreeBytes, &CompilerStatsSnapshot{CacheBytes: int64(limits.CompileCacheMaxBytes) + 1}))
	if s := c.Snapshot(); s.OK {
		t.Fatal("编译缓存超上限必须红灯")
	}
	// 正常 ⇒ 绿灯，且水位被如实上报。
	c = New(fixedOpts(MinDiskFreeBytes, &CompilerStatsSnapshot{QueueDepth: 2, CacheBytes: 1 << 20, CacheFiles: 7, InFlight: 1}))
	s := c.Snapshot()
	if !s.OK {
		t.Fatalf("正常水位应绿灯，got %v", s.Reasons)
	}
	if s.CompileQueue != 2 || s.CacheFiles != 7 || !s.CompileBusy {
		t.Fatalf("水位字段不对：%+v", s)
	}
}

func TestSnapshotDBPing(t *testing.T) {
	o := fixedOpts(MinDiskFreeBytes, nil)
	o.Ping = func() error { return errors.New("boom") }
	s := New(o).Snapshot()
	if s.OK || s.DBOK {
		t.Fatalf("DB 不可达必须红灯：%+v", s)
	}
}

func TestSnapshotExecutorFull(t *testing.T) {
	o := fixedOpts(MinDiskFreeBytes, nil)
	sch := queue.New(queue.DefaultOptions())
	o.Scheduler = sch
	// 占满全局槽。
	var tickets []*queue.Ticket
	// 占满全局槽要用不同应用：同应用的并发另有上限（app_running，默认 4），
	// 用它占槽会让"全局满载"与"单应用满载"混淆。
	for i := 0; i < limits.GlobalInstances; i++ {
		tk, err := sch.Acquire(t.Context(), "app-"+strconv.Itoa(i), int64(i+1))
		if err != nil {
			t.Fatalf("acquire: %v", err)
		}
		tickets = append(tickets, tk)
	}
	defer func() {
		for _, tk := range tickets {
			tk.Release()
		}
	}()
	s := New(o).Snapshot()
	for _, r := range s.Reasons {
		if len(r) > 0 && r[:len("执行槽已满")] == "执行槽已满" {
			return
		}
	}
	t.Fatalf("执行槽满应在 reasons 里可见（且不改变 OK，满载是有界设计的正常态）：%+v", s)
}

func TestHandlerStatus(t *testing.T) {
	// 不达标 ⇒ 503 + JSON。
	c := New(fixedOpts(1, nil))
	rec := httptest.NewRecorder()
	c.Handler()(rec, httptest.NewRequest("GET", "/readyz", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("code=%d want 503", rec.Code)
	}
	var s Snapshot
	if err := json.Unmarshal(rec.Body.Bytes(), &s); err != nil {
		t.Fatalf("响应必须是 JSON：%v body=%q", err, rec.Body.String())
	}
	// 达标 ⇒ 200。
	c = New(fixedOpts(MinDiskFreeBytes, nil))
	rec = httptest.NewRecorder()
	c.Handler()(rec, httptest.NewRequest("GET", "/readyz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d want 200", rec.Code)
	}
}

// TestAllowPublishFailClosed：§4.9 —— 低于阈值**拒绝发布**。
func TestAllowPublishFailClosed(t *testing.T) {
	c := New(fixedOpts(1, nil))
	err := c.AllowPublish()
	if err == nil {
		t.Fatal("磁盘不足时必须拒绝发布（fail-closed）")
	}
	if err.Details["reasons"] == nil {
		t.Fatal("错误必须带上具体原因")
	}
	// 正常 ⇒ 放行。
	c = New(fixedOpts(MinDiskFreeBytes, nil))
	if err := c.AllowPublish(); err != nil {
		t.Fatalf("正常水位应放行：%v", err)
	}
	// 编译队列满 ⇒ 拒绝发布。
	c = New(fixedOpts(MinDiskFreeBytes, &CompilerStatsSnapshot{QueueDepth: limits.CompileQueueDepth}))
	if err := c.AllowPublish(); err == nil {
		t.Fatal("编译队列满时应拒绝发布")
	}
}

// TestAllowPublishIgnoresExecutorFull：执行槽满不阻止发布
// （发布不占执行槽；若把两者绑死，满载时会连发布都做不了，反而无法排障）。
func TestAllowPublishIgnoresExecutorFull(t *testing.T) {
	o := fixedOpts(MinDiskFreeBytes, nil)
	sch := queue.New(queue.DefaultOptions())
	o.Scheduler = sch
	var tickets []*queue.Ticket
	for i := 0; i < limits.GlobalInstances; i++ {
		tk, err := sch.Acquire(t.Context(), "app-"+strconv.Itoa(i), int64(i+1))
		if err != nil {
			t.Fatalf("acquire: %v", err)
		}
		tickets = append(tickets, tk)
	}
	defer func() {
		for _, tk := range tickets {
			tk.Release()
		}
	}()
	if err := New(o).AllowPublish(); err != nil {
		t.Fatalf("执行槽满不应阻止发布：%v", err)
	}
}

// TestMemoryBudget：§4.3「理论峰值 > 可用内存 70% ⇒ 拒绝启动」。
func TestMemoryBudget(t *testing.T) {
	plan := DefaultMemoryPlan()
	need := int64(InstancePoolBytes+CompilePeakBytes+limits.UploadPeakPerUploadBytes+CacheResidentBytes) +
		int64(plan.Instances)*plan.AppDBPageCachePerHandleBytes
	// 恰好卡在 70% 边界：available × 70% >= need ⇒ 通过。
	// 用向上取整，否则整数除法会让 limit 差 1 字节而误判（这正是本用例要钉的边界）。
	avail := (need*100 + int64(limits.MemoryPeakGuardPercent) - 1) / int64(limits.MemoryPeakGuardPercent)
	if b, err := CheckStartupMemory(avail); err != nil {
		t.Fatalf("恰好等于水位应通过：%v（budget=%+v）", err, b)
	}
	// 少 1 字节 ⇒ 拒绝启动。
	if _, err := CheckStartupMemory(avail - 1); err == nil {
		t.Fatal("超过水位必须拒绝启动（§4.3：拒绝启动而不是等 OOM）")
	}
	// 读不到可用内存（MemoryUnknown）⇒ 不判定，避免容器里无法部署；但**必须**标成
	// "没有判定"（Known=false），不许与"判定通过"同形（R1-rt-1 的 fail-open）。
	b, err := CheckStartupMemory(MemoryUnknown)
	if err != nil || !b.OK {
		t.Fatalf("读不到内存时不应拒绝启动：%v %+v", err, b)
	}
	if b.Known {
		t.Fatal("读不到可用内存时 Known 必须为 false（'没有判定' ≠ '判定通过'）")
	}
	// 真的是 0 可用内存 ⇒ 判定失败（fail-loud）。旧实现把 0 与"读不到"混为一谈，是 fail-open。
	if _, err := CheckStartupMemory(0); err == nil {
		t.Fatal("可用内存为 0 必须拒绝启动（0 ≠ 未知）")
	}
	// 各笔账都要在分解里可见（不能只算一笔）。
	b = ComputeMemoryBudget(64 << 30)
	if b.Instances == 0 || b.CompilePeak == 0 || b.UploadPeak == 0 || b.CacheResident == 0 || b.AppDBCache == 0 {
		t.Fatalf("各笔账必须各自可见（含应用库页缓存）：%+v", b)
	}
	if !b.Known {
		t.Fatal("给出了可用内存就必须标成已知")
	}
	if b.Instances != int64(limits.GlobalInstances)*int64(limits.InstanceMemoryPages)*int64(limits.WasmPageSize) {
		t.Fatalf("实例池这笔账算错：%d", b.Instances)
	}
}

// TestInstanceLockExclusive：R20 / §15.1 第 9 条 —— 第二个实例必须拒绝启动。
func TestInstanceLockExclusive(t *testing.T) {
	dir := t.TempDir()
	l1, err := AcquireInstanceLock(dir)
	if err != nil {
		t.Fatalf("第一个实例应拿到锁：%v", err)
	}
	if _, err := AcquireInstanceLock(dir); err == nil {
		t.Fatal("第二个实例必须被拒绝（多副本的失败形态是静默的）")
	}
	l1.Release()
	// 释放后可以重新取。
	l2, err := AcquireInstanceLock(dir)
	if err != nil {
		t.Fatalf("释放后应能重新取锁：%v", err)
	}
	l2.Release()
	l2.Release() // 幂等
	// 锁文件里应有 pid（便于运维判断占用者）。
	b, err := os.ReadFile(filepath.Join(dir, "instance.lock"))
	if err != nil {
		t.Fatalf("锁文件应存在：%v", err)
	}
	if len(b) == 0 {
		t.Fatal("锁文件应写入 pid")
	}
}

func TestAcquireInstanceLockRequiresRoot(t *testing.T) {
	if _, err := AcquireInstanceLock(""); err == nil {
		t.Fatal("空数据根必须报错")
	}
}

// TestComputeMemoryBudgetExportedConstants：自检系数必须与 limits 同源，
// 不允许在别处悄悄写死（§5.5「数值单一真源」的精神）。
func TestComputeMemoryBudgetExportedConstants(t *testing.T) {
	if InstancePoolBytes != limits.GlobalInstances*limits.InstanceMemoryPages*limits.WasmPageSize {
		t.Fatal("InstancePoolBytes 必须由 limits 推导")
	}
	if CompilePeakBytes%limits.WasmMaxBytes != 0 {
		t.Fatal("CompilePeakBytes 必须是 wasm 上限的整数倍（保守估算口径）")
	}
	if CacheResidentBytes > limits.CompileCacheMaxBytes {
		t.Fatal("缓存驻留估算不得超过缓存上限")
	}
}

// ===== 审计修复回归（P2-2 / P2-7）=====

// TestSnapshotCompileUnavailableIsDistinguishable：审计 P2-2 —— 编译子系统不可用时
// `/readyz` 的 JSON 必须与健康态**可区分**（此前逐字段同形，编排发现不了"发布已禁用"）。
//
// 语义（本包已写进 Snapshot 的注释）：ok 说的是**执行面**（能不能服务应用请求），
// compile_available 说的是**发布面**；两者都不许静默。
func TestSnapshotCompileUnavailableIsDistinguishable(t *testing.T) {
	healthy := New(fixedOpts(MinDiskFreeBytes, nil))
	hs := healthy.Snapshot()
	if !hs.CompileAvailable {
		t.Fatal("未注入可用性提供者时应视为可用（不判）")
	}
	hb, _ := json.Marshal(hs)

	o := fixedOpts(MinDiskFreeBytes, nil)
	o.CompileAvailability = func() CompileAvailability {
		return CompileAvailability{Available: false, Detail: "编译子系统缺失（测试注入）"}
	}
	bad := New(o).Snapshot()
	if !bad.OK {
		t.Fatalf("编译不可用**不**该把 ok 打成 false（ok = 执行面；编排不该摘掉还在服务请求的实例）：%v", bad.Reasons)
	}
	if bad.CompileAvailable {
		t.Fatal("compile_available 必须为 false（这正是与健康态可区分的字段）")
	}
	bb, _ := json.Marshal(bad)
	if string(hb) == string(bb) {
		t.Fatalf("不可用态与健康态 JSON 同形（审计 P2-2 复现）：%s", bb)
	}
	if !strings.Contains(string(bb), `"compile_available":false`) {
		t.Fatalf("响应体必须显式带 compile_available:false：%s", bb)
	}
	// 必须在 reasons 里有**可读**的说明项（只靠 bool 字段不够运维用）。
	found := false
	for _, r := range bad.Reasons {
		if strings.HasPrefix(r, reasonCompileUnavailable) {
			found = true
		}
	}
	if !found {
		t.Fatalf("reasons 必须含编译不可用说明项：%v", bad.Reasons)
	}
}

// TestAllowPublishBlocksOnCompileUnavailable：没有编译器就没有发布 —— 可用性缺失
// 必须**阻止发布**（与"执行槽已满"这条非阻塞说明项区别对待）。
func TestAllowPublishBlocksOnCompileUnavailable(t *testing.T) {
	o := fixedOpts(MinDiskFreeBytes, nil)
	o.CompileAvailability = func() CompileAvailability {
		return CompileAvailability{Available: false, Detail: "编译子系统缺失（测试注入）"}
	}
	err := New(o).AllowPublish()
	if err == nil {
		t.Fatal("编译子系统不可用时必须拒绝发布（审计 P2-2：AllowPublish 必须把它当阻塞理由）")
	}
	reasons, _ := err.Details["reasons"].([]string)
	if len(reasons) == 0 {
		t.Fatalf("拒绝发布必须带具体原因：%+v", err.Details)
	}
	if err.Details["compile_available"] != false {
		t.Fatalf("明细应带 compile_available=false：%+v", err.Details)
	}
}

// TestAllowPublishStatusIsServiceUnavailable：HTTP 必须体现"暂时不可用"（503），
// 而不是 500（会被当成服务端 bug）或 429（会被当成客户端限流并诱导立刻重试）。
func TestAllowPublishStatusIsServiceUnavailable(t *testing.T) {
	e := New(fixedOpts(1, nil)).AllowPublish()
	if e == nil {
		t.Fatal("磁盘不足时必须拒绝发布")
	}
	if got := e.Status(); got != http.StatusServiceUnavailable {
		t.Fatalf("status=%d want 503（服务暂时不可用）", got)
	}
	if e.Code != apperr.CodeInternal {
		t.Fatalf("code=%s want INTERNAL（复用既有码，不新增 §7.4 之外的码）", e.Code)
	}
}

// TestSnapshotExposesEventCounters：审计 P2-7 —— "丢最旧并计数"的计数必须有人看得见。
func TestSnapshotExposesEventCounters(t *testing.T) {
	o := fixedOpts(MinDiskFreeBytes, nil)
	o.Events = func() EventsStats {
		return EventsStats{Dropped: 92, Failed: 5, Written: 1000}
	}
	s := New(o).Snapshot()
	if s.EventsDropped != 92 || s.EventsFailed != 5 || s.EventsWritten != 1000 {
		t.Fatalf("事件计数未如实暴露：%+v", s)
	}
	if !s.OK {
		t.Fatal("事件计数是观测项，不该改变 ok（丢弃是设计的一部分）")
	}
	// 计数必须真的出现在 JSON 里（字段名是运维/编排的读取契约）。
	b, _ := json.Marshal(s)
	for _, want := range []string{`"events_dropped":92`, `"events_failed":5`, `"events_written":1000`} {
		if !strings.Contains(string(b), want) {
			t.Fatalf("响应体缺 %s：%s", want, b)
		}
	}
	// 未注入时必须仍然是 0 而不是缺字段（响应体形状稳定）。
	s2 := New(fixedOpts(MinDiskFreeBytes, nil)).Snapshot()
	if s2.EventsDropped != 0 || s2.EventsFailed != 0 || s2.EventsWritten != 0 {
		t.Fatalf("未注入时计数应为 0：%+v", s2)
	}
}

// TestSnapshotExecutorFullIsNonBlockingReason：审计 P2-6 —— 注释与行为必须一致：
// 执行槽满只做**非阻塞**说明项（不置 OK=false），且 AllowPublish 明确忽略它。
func TestSnapshotExecutorFullIsNonBlockingReason(t *testing.T) {
	o := fixedOpts(MinDiskFreeBytes, nil)
	sch := queue.New(queue.DefaultOptions())
	o.Scheduler = sch
	var tickets []*queue.Ticket
	for i := 0; i < limits.GlobalInstances; i++ {
		tk, err := sch.Acquire(t.Context(), "app-"+strconv.Itoa(i), int64(i+1))
		if err != nil {
			t.Fatalf("acquire: %v", err)
		}
		tickets = append(tickets, tk)
	}
	defer func() {
		for _, tk := range tickets {
			tk.Release()
		}
	}()
	s := New(o).Snapshot()
	if !s.OK {
		t.Fatalf("执行槽满不是不健康（有界即设计目标）：%+v", s.Reasons)
	}
	found := false
	for _, r := range s.Reasons {
		if strings.HasPrefix(r, reasonExecutorFull) {
			found = true
		}
	}
	if !found {
		t.Fatalf("执行槽满必须在 reasons 里可见：%v", s.Reasons)
	}
}

// TestSnapshotExposesMemSource：R1-rt-1 —— `/readyz` 必须回答"这笔账的可用内存是从哪读的"。
//
// 变异：把 Snapshot 里的 MemSource/MemAvailableByte 赋值删掉 ⇒ 本用例必红
// （旧实现里内存这一维在 /readyz 上根本不存在，排障只能靠猜）。
func TestSnapshotExposesMemSource(t *testing.T) {
	o := fixedOpts(MinDiskFreeBytes, nil)
	o.MemAvailable = func() MemoryAvailability {
		return MemoryAvailability{Bytes: 192 << 20, Source: MemorySourceCgroup, Detail: "cgroup 限额 256 MiB − 用量 64 MiB"}
	}
	s := New(o).Snapshot()
	if s.MemSource != string(MemorySourceCgroup) {
		t.Fatalf("mem_source 必须暴露来源，得到 %q", s.MemSource)
	}
	if s.MemAvailableByte != 192<<20 {
		t.Fatalf("mem_available_bytes=%d，期望 %d", s.MemAvailableByte, int64(192<<20))
	}
	if !s.OK {
		t.Fatalf("内存维不是阻塞项（ok 讲的是执行面）：%v", s.Reasons)
	}
	// JSON 契约：字段名是 webadmin/运维脚本读的（改名字必须同步两端）。
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, want := range []string{`"mem_source":"cgroup"`, `"mem_available_bytes":201326592`} {
		if !strings.Contains(string(b), want) {
			t.Fatalf("响应体缺少 %s：%s", want, b)
		}
	}
}

// TestSnapshotMemUnavailableIsSaidOutLoud：读不到可用内存时必须**显式说出来**
// （"未取到可用内存（跳过内存自检）"），且这条说明**不阻塞**发布。
//
// 这一条正是 R1-rt-1 要求的那半：保留可部署性（不拒绝启动/不拒绝发布），
// 但"跳过"必须可见 —— 旧实现里它与"内存充足"逐字段同形（fail-open）。
func TestSnapshotMemUnavailableIsSaidOutLoud(t *testing.T) {
	o := fixedOpts(MinDiskFreeBytes, nil)
	o.MemAvailable = func() MemoryAvailability {
		return MemoryAvailability{Source: MemorySourceNone, Detail: "读 /proc/meminfo 失败: 文件不存在"}
	}
	c := New(o)
	s := c.Snapshot()
	if s.MemSource != string(MemorySourceNone) {
		t.Fatalf("mem_source 必须如实写 none，得到 %q", s.MemSource)
	}
	found := false
	for _, r := range s.Reasons {
		if strings.HasPrefix(r, reasonMemUnavailable) {
			found = true
		}
	}
	if !found {
		t.Fatalf("读不到可用内存必须在 reasons 里显式说明（不许静默）：%v", s.Reasons)
	}
	// 可部署性：读不到不把实例判成不健康，也不阻止发布。
	if !s.OK {
		t.Fatalf("读不到可用内存不该让 ok=false（那是部署环境问题，不是执行面故障）：%v", s.Reasons)
	}
	if err := c.AllowPublish(); err != nil {
		t.Fatalf("读不到可用内存不该阻止发布（否则受限环境完全不可用）：%v", err)
	}
}
