package readyz_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/readyz"
)

// 本文件是 R1-rt-1（内存四笔账不感知 cgroup）的回归护栏。
//
// 复现的现场（评审实测）：`--memory=256m` 的容器里 `/proc/meminfo` 报的是**宿主**的
// 可用内存（实测 7 GB）⇒ 默认档（需 3.6 GiB 可用）启动自检通过，之后被内核 OOM-kill。
//
// 判据（四形态 + 取 min）：
//  1. cgroup v2 有上限 ⇒ 数值 = min(宿主可用, 剩余)，来源 = cgroup；
//  2. cgroup v2 `max` 字面量（无限制）⇒ 回落宿主，来源 = host；
//  3. cgroup v1 有上限 ⇒ 同上（v1 用巨大哨兵值表示无限制，也必须回落）；
//  4. 两个来源都读不到 ⇒ 来源 = none，且**判定入参是"未知"而不是 0/充足**。
//
// 变异验证（实测：改回"只读 /proc/meminfo"的实现时哪条必红）：
//   - 去掉 cgroup 分支（回到宿主单来源）⇒ TestMemoryAvailability_CgroupV2Limit、
//     TestMemoryAvailability_CgroupV1Limit、TestStartupSelfCheckRejectsCgroupLimitedBox 必红；
//   - 只取 cgroup 而不与宿主取 min ⇒ TestMemoryAvailability_TakesMinOfHostAndCgroup 必红；
//   - 把 v2 的 `max` 当成数字解析 ⇒ TestMemoryAvailability_CgroupV2UnlimitedFallsBackToHost 必红；
//   - 读不到时返回 0（而不是 MemoryUnknown）⇒ TestMemoryAvailability_NoSourceIsUnknownNotZero 必红。

// memInfo 生成一份最小可用的 /proc/meminfo（只有 MemAvailable 一行是读取实现关心的）。
func memInfo(available int64) []byte {
	return []byte("MemTotal:       16384000 kB\nMemFree:         1000000 kB\nMemAvailable:   " +
		itoa(available/1024) + " kB\n")
}

func itoa(v int64) string {
	if v == 0 {
		return "0"
	}
	var buf [32]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	return string(buf[i:])
}

// memPaths 在临时目录里铺出四个来源文件（不写 = 该文件不存在）。
type memPaths struct {
	dir string
	t   *testing.T
}

func newMemPaths(t *testing.T) *memPaths {
	t.Helper()
	return &memPaths{dir: t.TempDir(), t: t}
}

func (m *memPaths) write(name, content string) {
	m.t.Helper()
	if err := os.WriteFile(filepath.Join(m.dir, name), []byte(content), 0o600); err != nil {
		m.t.Fatalf("写 %s: %v", name, err)
	}
}

// paths 返回注入用的路径集合（全部落在临时目录里，不依赖真实文件系统）。
func (m *memPaths) paths() readyz.MemoryPaths {
	p := readyz.MemoryPaths{
		ProcMeminfo:     filepath.Join(m.dir, "meminfo"),
		CgroupV2Max:     filepath.Join(m.dir, "cgroup.v2.max"),
		CgroupV2Current: filepath.Join(m.dir, "cgroup.v2.current"),
		CgroupV1Limit:   filepath.Join(m.dir, "cgroup.v1.limit"),
		CgroupV1Usage:   filepath.Join(m.dir, "cgroup.v1.usage"),
	}
	return p
}

// TestMemoryAvailability_CgroupV2Limit：v2 有上限 ⇒ 取 cgroup 剩余（宿主再大也不放行）。
func TestMemoryAvailability_CgroupV2Limit(t *testing.T) {
	m := newMemPaths(t)
	m.write("meminfo", string(memInfo(7<<30))) // 宿主 7 GiB 可用（旧实现只看这个）
	m.write("cgroup.v2.max", itoa(256<<20))    // 容器限额 256 MiB
	m.write("cgroup.v2.current", itoa(64<<20)) // 已用 64 MiB

	got := readyz.ReadMemoryAvailabilityAt(m.paths())
	if got.Source != readyz.MemorySourceCgroup {
		t.Fatalf("来源必须是 cgroup（容器限额生效），得到 %s（%s）", got.Source, got.Detail)
	}
	if want := int64(192 << 20); got.Bytes != want {
		t.Fatalf("可用内存 = 限额 − 用量 = %d MiB，得到 %d MiB（%s）", want>>20, got.Bytes>>20, got.Detail)
	}
	if !got.Known() || got.BudgetBytes() != got.Bytes {
		t.Fatalf("已知来源必须给出真实读数：%+v", got)
	}
}

// TestMemoryAvailability_CgroupV2UnlimitedFallsBackToHost：`max` 字面量 = 无限制 ⇒ 回落宿主。
func TestMemoryAvailability_CgroupV2UnlimitedFallsBackToHost(t *testing.T) {
	m := newMemPaths(t)
	m.write("meminfo", string(memInfo(3<<30)))
	m.write("cgroup.v2.max", "max\n")
	m.write("cgroup.v2.current", itoa(1<<30))

	got := readyz.ReadMemoryAvailabilityAt(m.paths())
	if got.Source != readyz.MemorySourceHost {
		t.Fatalf("cgroup 无限制时必须回落宿主，得到来源 %s（%s）", got.Source, got.Detail)
	}
	if want := int64(3 << 30); got.Bytes != want {
		t.Fatalf("宿主可用 = %d GiB，得到 %d GiB", want>>30, got.Bytes>>30)
	}
}

// TestMemoryAvailability_CgroupV1Limit：v1（limit_in_bytes + usage_in_bytes）同样生效。
func TestMemoryAvailability_CgroupV1Limit(t *testing.T) {
	m := newMemPaths(t)
	m.write("meminfo", string(memInfo(7<<30)))
	m.write("cgroup.v1.limit", itoa(1<<30))
	m.write("cgroup.v1.usage", itoa(256<<20))

	got := readyz.ReadMemoryAvailabilityAt(m.paths())
	if got.Source != readyz.MemorySourceCgroup {
		t.Fatalf("v1 有限额时必须用 cgroup，得到 %s（%s）", got.Source, got.Detail)
	}
	if want := int64(768 << 20); got.Bytes != want {
		t.Fatalf("可用内存 = 1 GiB − 256 MiB = %d MiB，得到 %d MiB", want>>20, got.Bytes>>20)
	}
}

// TestMemoryAvailability_CgroupV1UnlimitedFallsBackToHost：v1 的"无限制"是巨大哨兵值。
func TestMemoryAvailability_CgroupV1UnlimitedFallsBackToHost(t *testing.T) {
	m := newMemPaths(t)
	m.write("meminfo", string(memInfo(2<<30)))
	m.write("cgroup.v1.limit", "9223372036854771712\n") // 0x7FFFFFFFFFFFF000 = v1 的无限制
	m.write("cgroup.v1.usage", itoa(1<<30))

	got := readyz.ReadMemoryAvailabilityAt(m.paths())
	if got.Source != readyz.MemorySourceHost {
		t.Fatalf("v1 无限制（哨兵值）时必须回落宿主，得到 %s（%s）", got.Source, got.Detail)
	}
}

// TestMemoryAvailability_TakesMinOfHostAndCgroup：**取 min**，不是"有 cgroup 就只用 cgroup"。
func TestMemoryAvailability_TakesMinOfHostAndCgroup(t *testing.T) {
	m := newMemPaths(t)
	m.write("meminfo", string(memInfo(1<<30))) // 宿主只剩 1 GiB
	m.write("cgroup.v2.max", itoa(8<<30))      // 限额 8 GiB
	m.write("cgroup.v2.current", itoa(1<<30))  // 已用 1 GiB ⇒ 剩余 7 GiB

	got := readyz.ReadMemoryAvailabilityAt(m.paths())
	if want := int64(1 << 30); got.Bytes != want {
		t.Fatalf("必须取 min(宿主 1 GiB, cgroup 剩余 7 GiB) = %d GiB，得到 %d GiB（%s）",
			want>>30, got.Bytes>>30, got.Detail)
	}
	if got.Source != readyz.MemorySourceCgroup {
		t.Fatalf("cgroup 参与判定时来源标 cgroup（便于排障），得到 %s", got.Source)
	}
}

// TestMemoryAvailability_LimitReachedIsZeroNotUnknown：限额已用满 ⇒ 0 且 **Known**。
//
// 0 与"读不到"必须区分：前者是"真的没有可用内存"（判定失败），后者是"未知"（跳过判定）。
func TestMemoryAvailability_LimitReachedIsZeroNotUnknown(t *testing.T) {
	m := newMemPaths(t)
	m.write("meminfo", string(memInfo(7<<30)))
	m.write("cgroup.v2.max", itoa(256<<20))
	m.write("cgroup.v2.current", itoa(300<<20)) // 超过限额（进程正在被 OOM）

	got := readyz.ReadMemoryAvailabilityAt(m.paths())
	if got.Bytes != 0 {
		t.Fatalf("用量超过限额时可用内存是 0，得到 %d", got.Bytes)
	}
	if !got.Known() {
		t.Fatal("限额已用满是**已知的 0**，不是未知")
	}
	if got.BudgetBytes() != 0 {
		t.Fatalf("判定入参必须是 0（会把账判失败），得到 %d", got.BudgetBytes())
	}
}

// TestMemoryAvailability_NoSourceIsUnknownNotZero：两个来源都读不到 ⇒ Source=none
// 且判定入参是 MemoryUnknown（**不是 0**，也不是"充足"）。
func TestMemoryAvailability_NoSourceIsUnknownNotZero(t *testing.T) {
	m := newMemPaths(t) // 一个文件都不写
	got := readyz.ReadMemoryAvailabilityAt(m.paths())
	if got.Source != readyz.MemorySourceNone {
		t.Fatalf("读不到任何来源时 Source 必须是 none，得到 %s", got.Source)
	}
	if got.Known() {
		t.Fatal("读不到时 Known 必须为 false")
	}
	if got.BudgetBytes() != readyz.MemoryUnknown {
		t.Fatalf("读不到时判定入参必须是 MemoryUnknown(%d)，得到 %d（0 会被当成'真的没有'）",
			readyz.MemoryUnknown, got.BudgetBytes())
	}
	if got.Detail == "" {
		t.Fatal("必须留下可读原因（日志与 /readyz 都要用）")
	}
}

// TestMemoryAvailability_V2LimitWithoutUsageFallsBackToHost：有上限但读不出用量 ⇒ 不猜，回落宿主。
func TestMemoryAvailability_V2LimitWithoutUsageFallsBackToHost(t *testing.T) {
	m := newMemPaths(t)
	m.write("meminfo", string(memInfo(5<<30)))
	m.write("cgroup.v2.max", itoa(256<<20)) // 没有 current

	got := readyz.ReadMemoryAvailabilityAt(m.paths())
	if got.Source != readyz.MemorySourceHost {
		t.Fatalf("算不出剩余时不得猜（猜 0 会把可用内存算成限额、猜限额会算成 0），应回落宿主，得到 %s", got.Source)
	}
}

// TestStartupSelfCheckRejectsCgroupLimitedBox 是本条 P0 的**端到端判据**：
// 宿主 7 GiB 可用 + 容器限额 256 MiB 的部署必须**拒绝启动**（默认档需 3.6 GiB）。
//
// 变异：把 ReadMemoryAvailability 换回"只读 /proc/meminfo" ⇒ 本用例必红（旧实现读到 7 GiB
// ⇒ 自检放行 ⇒ 之后被 OOM-kill，这正是评审 H-3 的现场）。
func TestStartupSelfCheckRejectsCgroupLimitedBox(t *testing.T) {
	m := newMemPaths(t)
	m.write("meminfo", string(memInfo(7<<30)))
	m.write("cgroup.v2.max", itoa(256<<20))
	m.write("cgroup.v2.current", itoa(0))

	avail := readyz.ReadMemoryAvailabilityAt(m.paths())
	if _, err := readyz.CheckStartupMemoryFor(avail.BudgetBytes(), readyz.DefaultMemoryPlan()); err == nil {
		t.Fatal("256 MiB 容器 + 默认档（需 3.6 GiB）必须拒绝启动：cgroup 限额没被算进四笔账")
	}
	// 对照：同一份文件若**没有** cgroup 限额（v2=max），同一台宿主必须放行 —— 证明拒绝
	// 来自 cgroup 那一笔，而不是判据被整体收紧了。
	m.write("cgroup.v2.max", "max\n")
	avail = readyz.ReadMemoryAvailabilityAt(m.paths())
	if _, err := readyz.CheckStartupMemoryFor(avail.BudgetBytes(), readyz.DefaultMemoryPlan()); err != nil {
		t.Fatalf("宿主 7 GiB + 无 cgroup 限额应放行：%v", err)
	}
}

// TestDefaultMemoryPathsAreTheContainerPaths：生产路径常量必须指向 cgroup v2/v1 的标准位置
// （写错路径的失败形态是静默回落宿主 —— 正是本条 P0）。
func TestDefaultMemoryPathsAreTheContainerPaths(t *testing.T) {
	p := readyz.DefaultMemoryPaths()
	if p.ProcMeminfo != "/proc/meminfo" {
		t.Fatalf("ProcMeminfo=%q", p.ProcMeminfo)
	}
	if p.CgroupV2Max != "/sys/fs/cgroup/memory.max" || p.CgroupV2Current != "/sys/fs/cgroup/memory.current" {
		t.Fatalf("cgroup v2 路径不对：%+v", p)
	}
	if p.CgroupV1Limit != "/sys/fs/cgroup/memory/memory.limit_in_bytes" ||
		p.CgroupV1Usage != "/sys/fs/cgroup/memory/memory.usage_in_bytes" {
		t.Fatalf("cgroup v1 路径不对：%+v", p)
	}
	_ = limits.InstanceMemoryPages // 保持与 limits 包的显式关联（本文件的账都以它为单位）
}
