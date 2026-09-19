package readyz

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// 本文件是**可用内存读取的唯一实现**（P0-1，2026-09-19 评审 R1-rt-1）。
//
// 旧的 `readMemAvailable`（cmd/server/wasmapp.go）与 `memAvailable`（本包内，死代码）
// 都只看 `/proc/meminfo`：在容器里读到的 MemAvailable 是**宿主**的可用内存，
// 与 cgroup 限额无关 ⇒ `mem_limit: 2g` 的容器上默认档（需 3.6 GiB 可用）自检通过，
// 之后由内核 OOM-kill。因此这里改成 cgroup 感知，并把"数值来自哪里"作为返回值的一部分
// 暴露出来（来源与数值都必须能被日志与 `/readyz` 看见）。
//
// 取值规则（min(宿主可用, cgroup 剩余)）：
//
//  1. cgroup v2：`memory.max` + `memory.current`（`max` 字面量 = 无限制）；
//  2. cgroup v1：`memory/memory.limit_in_bytes` + `memory/memory.usage_in_bytes`
//     （v1 的"无限制"是一个巨大的哨兵值 ≈ 9.22e18 ⇒ 超过阈值即视为无限制）；
//  3. 两个来源都读不到 ⇒ Source=none（调用方**必须大声说出来并跳过自检**，
//     而不是把它当成"内存充足"）。
//
// 已知边界（如实认账，不静默扩张语义）：
//   - 只读容器**自己那一层**的 cgroup 文件。若限额挂在祖先 cgroup（例如 v1 的
//     systemd slice、或宿主在容器内再分层），这里读不到 ⇒ 退化为宿主值；
//   - 只读文件、不遍历 `/proc/self/cgroup`（多层级路径解析属后续增量，不在本次范围）。

// MemorySource 是可用内存数值的来源。
type MemorySource string

const (
	// MemorySourceHost：数值来自宿主 `/proc/meminfo` 的 MemAvailable（没有生效的 cgroup 限额）。
	MemorySourceHost MemorySource = "host"
	// MemorySourceCgroup：数值是 min(宿主可用, cgroup 剩余)，即 cgroup 限额参与了判定。
	MemorySourceCgroup MemorySource = "cgroup"
	// MemorySourceNone：两个来源都读不到。**不等于"内存充足"** —— 它表示"无法判定"。
	MemorySourceNone MemorySource = "none"
)

// MemoryUnknown 是"读不到可用内存"的哨兵值（传给四笔账判定用）。
//
// 为什么必须有它：预算函数过去把 `availableBytes <= 0` 一律当作"读不到 ⇒ 不判定"，
// 于是"读不到"与"可用内存真的是 0"不可区分（fail-open）。现在语义拆开：
//
//	availableBytes < 0  ⇒ 未知（跳过判定，但调用方必须显式说明）
//	availableBytes == 0 ⇒ 真的没有可用内存 ⇒ 判定失败（fail-loud）
const MemoryUnknown int64 = -1

// cgroupV1Unlimited 是 cgroup v1 `memory.limit_in_bytes` 表示"无限制"的哨兵阈值。
//
// v1 用 `0x7FFFFFFFFFFFF000`（≈ 9.22e18）表示无限制，而不是字面量 `max`。
// 取 1<<62（≈ 4.6e18）作为阈值：真实机器内存不可能到这个量级，而哨兵值远大于它。
const cgroupV1Unlimited = int64(1) << 62

// MemoryAvailability 是一次可用内存读取的结果（数值 + 来源 + 可读说明）。
type MemoryAvailability struct {
	// Bytes 是可用内存字节数：Source=host/cgroup 时是**实际读数**（可能为 0），
	// Source=none 时无意义（调用方应看 BudgetBytes）。
	Bytes int64
	// Source 是取值来源（host / cgroup / none）。
	Source MemorySource
	// Detail 是给日志/探针看的一句话（读到了什么、cgroup 限额与用量、为什么回落）。
	// ⚠️ 不含敏感信息（都是容量数字与固定路径），可以进 `/readyz`（未认证端点）。
	Detail string
}

// Known 报告本次是否真的取到了可用内存。
func (m MemoryAvailability) Known() bool {
	return m.Source == MemorySourceHost || m.Source == MemorySourceCgroup
}

// BudgetBytes 把读取结果折算成四笔账判定用的入参：未知 ⇒ MemoryUnknown（跳过判定），
// 已知 ⇒ 实际读数（0 就是 0，会判定失败）。
func (m MemoryAvailability) BudgetBytes() int64 {
	if !m.Known() {
		return MemoryUnknown
	}
	return m.Bytes
}

// String 渲染成日志形态（来源 + 数值），让"读到了什么"永远和数值一起出现。
func (m MemoryAvailability) String() string {
	if !m.Known() {
		return fmt.Sprintf("来源=%s（未取到）", m.Source)
	}
	return fmt.Sprintf("来源=%s %d MiB", m.Source, m.Bytes>>20)
}

// MemoryPaths 是可用内存四个来源的文件路径（**可注入**：单测用临时文件覆盖
// v2 有上限 / v2=max / v1 / 全读不到 四种形态，不依赖真实文件系统）。
type MemoryPaths struct {
	ProcMeminfo     string
	CgroupV2Max     string
	CgroupV2Current string
	CgroupV1Limit   string
	CgroupV1Usage   string
}

// DefaultMemoryPaths 返回生产路径。
func DefaultMemoryPaths() MemoryPaths {
	return MemoryPaths{
		ProcMeminfo:     "/proc/meminfo",
		CgroupV2Max:     "/sys/fs/cgroup/memory.max",
		CgroupV2Current: "/sys/fs/cgroup/memory.current",
		CgroupV1Limit:   "/sys/fs/cgroup/memory/memory.limit_in_bytes",
		CgroupV1Usage:   "/sys/fs/cgroup/memory/memory.usage_in_bytes",
	}
}

// ReadMemoryAvailability 读可用内存（生产路径）。
func ReadMemoryAvailability() MemoryAvailability {
	return ReadMemoryAvailabilityAt(DefaultMemoryPaths())
}

// ReadMemoryAvailabilityAt 按给定路径读可用内存（min(宿主可用, cgroup 剩余)）。
func ReadMemoryAvailabilityAt(p MemoryPaths) MemoryAvailability {
	host, hostErr := readMeminfoAvailable(p.ProcMeminfo)
	cgRemaining, cgLimit, cgUsage, cgErr := readCgroupRemaining(p)

	switch {
	case cgErr == nil:
		// cgroup 有限额：取 min(宿主可用, 剩余)，并在说明里把两个数都写出来。
		bytes := cgRemaining
		detail := fmt.Sprintf("cgroup 限额 %d MiB − 用量 %d MiB = 剩余 %d MiB", cgLimit>>20, cgUsage>>20, cgRemaining>>20)
		if hostErr == nil {
			detail += fmt.Sprintf("；宿主 MemAvailable %d MiB", host>>20)
			if host < bytes {
				bytes = host
				detail += "（取较小者：宿主可用）"
			} else {
				detail += "（取较小者：cgroup 剩余）"
			}
		} else {
			detail += "；宿主 MemAvailable 不可读（" + hostErr.Error() + "），只用 cgroup 剩余"
		}
		return MemoryAvailability{Bytes: bytes, Source: MemorySourceCgroup, Detail: detail}
	case hostErr == nil:
		return MemoryAvailability{
			Bytes:  host,
			Source: MemorySourceHost,
			Detail: fmt.Sprintf("宿主 MemAvailable %d MiB；%s", host>>20, cgErr.Error()),
		}
	default:
		return MemoryAvailability{
			Bytes:  0,
			Source: MemorySourceNone,
			Detail: hostErr.Error() + "；" + cgErr.Error(),
		}
	}
}

// readMeminfoAvailable 读 `/proc/meminfo` 的 MemAvailable（字节）。
func readMeminfoAvailable(path string) (int64, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, fmt.Errorf("读 %s 失败: %w", path, err)
	}
	for _, line := range strings.Split(string(b), "\n") {
		if !strings.HasPrefix(line, "MemAvailable:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			break
		}
		kb, perr := strconv.ParseInt(fields[1], 10, 64)
		if perr != nil {
			return 0, fmt.Errorf("%s 的 MemAvailable 不可解析: %w", path, perr)
		}
		return kb * 1024, nil
	}
	return 0, fmt.Errorf("%s 缺少 MemAvailable 行", path)
}

// readCgroupRemaining 返回 (剩余字节, 限额, 用量, error)。error != nil 表示
// "没有生效的 cgroup 内存限额"（文件不存在 / 有上限语义但读不出用量 / 字面量 max）。
// 先 v2 后 v1（v2 主机上 v1 路径不存在，反之亦然；两者都在时以 v2 为准）。
func readCgroupRemaining(p MemoryPaths) (int64, int64, int64, error) {
	if remaining, limit, usage, ok := readCgroupV2(p); ok {
		return remaining, limit, usage, nil
	}
	if remaining, limit, usage, ok := readCgroupV1(p); ok {
		return remaining, limit, usage, nil
	}
	return 0, 0, 0, fmt.Errorf("没有生效的 cgroup 内存限额（v2 %s / v1 %s 都读不到）", p.CgroupV2Max, p.CgroupV1Limit)
}

// readCgroupV2 读 cgroup v2 的 memory.max / memory.current。ok=false ⇒ 无（可用的）限额。
func readCgroupV2(p MemoryPaths) (remaining, limit, usage int64, ok bool) {
	raw, err := os.ReadFile(p.CgroupV2Max)
	if err != nil {
		return 0, 0, 0, false
	}
	text := strings.TrimSpace(string(raw))
	if text == "max" || text == "" {
		// 字面量 `max` = 本层无限制（⚠️ 祖先层可能仍有，见文件头"已知边界"）。
		return 0, 0, 0, false
	}
	limit, perr := strconv.ParseInt(text, 10, 64)
	if perr != nil || limit <= 0 {
		return 0, 0, 0, false
	}
	usageRaw, uerr := os.ReadFile(p.CgroupV2Current)
	if uerr != nil {
		// 有上限但读不出用量 ⇒ 算不出剩余。**不猜**（猜 0 会把可用内存算成限额，
		// 猜限额会把可用内存算成 0）⇒ 视为"本层没有可用限额"，由调用方回落宿主值。
		return 0, 0, 0, false
	}
	usage, perr = strconv.ParseInt(strings.TrimSpace(string(usageRaw)), 10, 64)
	if perr != nil || usage < 0 {
		return 0, 0, 0, false
	}
	return clampRemaining(limit, usage), limit, usage, true
}

// readCgroupV1 读 cgroup v1 的 memory.limit_in_bytes / memory.usage_in_bytes。
func readCgroupV1(p MemoryPaths) (remaining, limit, usage int64, ok bool) {
	raw, err := os.ReadFile(p.CgroupV1Limit)
	if err != nil {
		return 0, 0, 0, false
	}
	limit, perr := strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64)
	// v1 的无限制哨兵值 ≈ 9.22e18（0x7FFFFFFFFFFFF000）。
	if perr != nil || limit <= 0 || limit >= cgroupV1Unlimited {
		return 0, 0, 0, false
	}
	usageRaw, uerr := os.ReadFile(p.CgroupV1Usage)
	if uerr != nil {
		return 0, 0, 0, false
	}
	usage, perr = strconv.ParseInt(strings.TrimSpace(string(usageRaw)), 10, 64)
	if perr != nil || usage < 0 {
		return 0, 0, 0, false
	}
	return clampRemaining(limit, usage), limit, usage, true
}

// clampRemaining 返回 max(limit−usage, 0)：用量超过限额（正在被 OOM 进程）时报 0，
// 而不是负数 —— 0 会被判定成"没有可用内存"（fail-loud），负数会被误读成"未知"。
func clampRemaining(limit, usage int64) int64 {
	if usage >= limit {
		return 0
	}
	return limit - usage
}
