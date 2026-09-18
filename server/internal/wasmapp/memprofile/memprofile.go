// Package memprofile 是「这次部署愿意为 WASM 应用平台花多少内存」的**唯一声明处**。
//
// 为什么需要它（2026-09-18 用户要求「更低内存占用、更快释放，可能有几百个应用」）：
// §4.3 的「内存四笔账」过去把「32 并发 × 64 MiB 实例」写死成编译期常量，于是任何
// 小于约 4 GB 的机器都过不了启动自检（实测 2 GB 测试机：理论峰值 2550 MiB >
// 70% × 可用 992 MiB = 694 MiB），而唯一的出路被写成「重新构建镜像」。
//
// 现在改为**部署声明的档位**：
//   - 数值仍以 limits 包的常量为默认值（单一真源不变）；
//   - 档位只做缩放，且**同一份数值同时驱动启动自检与运行期强制**——队列并发、
//     实例线性内存上限、进程内编译模块缓存上限、应用库句柄上限，全部取自这里，
//     因此「声明」与「执行」不会各有一套数（这正是过去"自检按 32 并发算、
//     实际也按 32 跑"的那种一致性，只是现在可以按部署缩小）。
//
// 与"降低全局并发实例数"不是一回事：那是把唯一的旋钮拧小；这里是**先**把
// 常驻内存降下来（模块缓存与磁盘缓存解耦、空闲淘汰、淘汰即归还 OS、句柄瘦身），
// 再让部署可以按机器大小声明一个诚实的档位。
//
// 档位表（每一项都是"理论峰值"口径，供 readyz 的四笔账使用）：
//
//	档位      并发  单实例  模块缓存  合计（含编译峰值 256 + 上传峰值 118）
//	default    32   64 MiB  128 MiB   2550 MiB   ← 与历史行为逐字节一致（默认档）
//	small       3   64 MiB   64 MiB    630 MiB   ← 2 GB 级机器（测试环境用这档）
//	large      64   64 MiB  256 MiB   4726 MiB   ← 大机器
package memprofile

import (
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// EnvMemoryProfile 是选择档位的环境变量名（空 = 默认档）。
const EnvMemoryProfile = "PICOAI_WASM_MEMORY_PROFILE"

// Profile 是一个内存档位的全部数值（**运行期强制的唯一输入**）。
type Profile struct {
	// Name 是档位名（default / small / large）。
	Name string
	// Instances 是全局并发实例上限：同时驱动请求队列的 GlobalRunning 与应用库
	// 句柄池容量（后者取同值，理由见 limits.AppDBHandleMax 的注释）。
	Instances int
	// InstanceMemoryPages 是单实例线性内存页上限（wazero WithMemoryLimitPages）。
	InstanceMemoryPages uint32
	// ModuleCacheBytes 是**进程内**编译模块缓存的记账上限（与磁盘编译缓存解耦）。
	ModuleCacheBytes int64
}

// InstanceMemoryBytes 返回单实例内存上限的字节数。
func (p Profile) InstanceMemoryBytes() int64 {
	return int64(p.InstanceMemoryPages) * int64(limits.WasmPageSize)
}

// InstancePoolBytes 返回实例池这一笔账（并发 × 单实例上限）。
func (p Profile) InstancePoolBytes() int64 { return int64(p.Instances) * p.InstanceMemoryBytes() }

// Report 返回给启动日志看的一行说明（不含时间戳，便于日志聚类）。
func (p Profile) Report() string {
	return fmt.Sprintf("profile=%s instances=%d instance_memory=%dMiB module_cache=%dMiB",
		p.Name, p.Instances, p.InstanceMemoryBytes()>>20, p.ModuleCacheBytes>>20)
}

// Default 返回默认档：与历史（2026-09-18 之前）的编译期常量**逐值一致**，
// 因此不设环境变量的部署行为不变。
func Default() Profile {
	return Profile{
		Name:                "default",
		Instances:           limits.GlobalInstances,
		InstanceMemoryPages: limits.InstanceMemoryPages,
		ModuleCacheBytes:    limits.ModuleCacheMaxBytes,
	}
}

// Small 返回小内存档（2 GB 级机器；测试环境用这档）。
//
// 数值依据：实例池 3 × 64 MiB = 192 MiB；加上编译峰值 256 MiB（= 8 × 32 MiB 模块上限）、
// 上传峰值 118 MiB、模块缓存 64 MiB ⇒ 630 MiB，在 992 MiB 可用内存的机器上通过
// 「理论峰值 ≤ 70% 可用」自检（694 MiB）且留有余量。
//
// **单实例上限保持 64 MiB 不变**（R22 的平台承诺）：降的是**并发数**（3），
// 不是每个应用能用的内存 —— 把上限压到 32 MiB 会让某些应用在平台承诺之内却跑不起来。
func Small() Profile {
	return Profile{
		Name:                "small",
		Instances:           3,
		InstanceMemoryPages: limits.InstanceMemoryPages, // 64 MiB
		ModuleCacheBytes:    64 << 20,
	}
}

// Large 返回大机器档（并发回到 64，模块缓存放宽到 256 MiB）。
func Large() Profile {
	return Profile{
		Name:                "large",
		Instances:           64,
		InstanceMemoryPages: limits.InstanceMemoryPages,
		ModuleCacheBytes:    256 << 20,
	}
}

// All 返回全部档位（按名字排序，供错误提示与文档使用）。
func All() []Profile {
	out := []Profile{Default(), Small(), Large()}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Names 返回可用档位名（逗号分隔），用于错误提示。
func Names() string {
	all := All()
	names := make([]string, 0, len(all))
	for _, p := range all {
		names = append(names, p.Name)
	}
	return strings.Join(names, ", ")
}

// Parse 解析档位名（大小写不敏感；空 = 默认档）。
//
// 未知名字**报错而不是回落默认**：内存档位写错时静默回落默认，会让一台小机器
// 在"以为已经降到 small"的状态下按 default 的账本启动（或反过来让大机器按
// small 限流），两种都是无声的容量事故。
func Parse(name string) (Profile, error) {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "":
		return Default(), nil
	case "default":
		return Default(), nil
	case "small":
		return Small(), nil
	case "large":
		return Large(), nil
	default:
		return Profile{}, fmt.Errorf("未知的 %s=%q（可用：%s）", EnvMemoryProfile, name, Names())
	}
}

// FromEnv 从环境变量解析档位（getenv 便于测试注入）。
func FromEnv(getenv func(string) string) (Profile, error) {
	if getenv == nil {
		return Default(), nil
	}
	return Parse(getenv(EnvMemoryProfile))
}

var (
	currentOnce sync.Once
	current     Profile
	currentErr  error
)

// Current 返回本进程生效的档位（解析一次并缓存；解析失败 ⇒ 默认档 + 错误可由
// CurrentError 取回）。装配期应当用 FromEnv 显式解析并在失败时**拒绝启动**
// （fail-loud），Current 只是给不便传参的调用点一个一致的兜底。
func Current() Profile {
	currentOnce.Do(func() {
		current, currentErr = FromEnv(os.Getenv)
		if currentErr != nil {
			current = Default()
		}
	})
	return current
}

// CurrentError 返回 Current 解析时的错误（nil = 正常）。
func CurrentError() error { return currentErr }
