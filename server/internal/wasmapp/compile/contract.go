package compile

import (
	"fmt"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 本文件是编译侧用到的**平台契约的薄封装**：错误码别名、上限值转发、字节数渲染。
//
// 铁律（§4 / §5.5）：数值唯一真源 = limits，错误码唯一真源 = apperr。
// 这里**只做转发**，不新增任何字面量；不在这里再声明一份常量枚举。
//
// 历史说明：本文件曾有一组 `CodeXxx()` 错误码转发函数（为"子进程不 import 本包"而设），
// 但 cmd 侧一直是直接 import apperr 用 `apperr.CodeX`；静态校验切到 wasmmod 之后那些
// 转发函数全部失去调用点，已删除。父子之间的错误码一致性由**协议层**保证
//（proto.go 的 protocolErrorCode 做白名单归并），不靠 Go 层的间接。

// Code 是平台错误码的别名（编译侧只用到 §7.4 的子集）。
//
// 保留它是因为 cmd 与 api 侧用它写 `apperr.New(compile.Code…)` 之类的中性代码；
// 本包内部一律直接用 `apperr.CodeX`（少一层间接）。
type Code = apperr.Code

// MaxModuleBytes 是上传模块体积上限（转发 §4.2 的 32 MiB）。
func MaxModuleBytes() int64 { return int64(limits.WasmMaxBytes) }

// SectionTotalMaxBytes 是自定义段总量上限（转发 §4.2 的 4 MiB）。
func SectionTotalMaxBytes() int64 { return int64(limits.SectionTotalMaxBytes) }

// 导入面白名单与签名表**不在本包**：唯一真源是 wasmmod 的生成产物
// （internal/wasmapp/wasmmod/imports_gen.go，构建期由参考实现 dump，手写即门禁红）。
// 静态校验的全部接线见 staticvalidate.go。

// describeInt 把 int64 渲染成人类可读的字节数（错误文案与水位日志用）。
//
// 分档到 KiB/MiB/GiB：缓存水位是 /readyz 的读数，全用字节数会让"512.0 MiB"
// 这种对比变得要靠人眼数零。
func describeInt(n int64) string {
	switch {
	case n >= 1<<30:
		return fmt.Sprintf("%.1f GiB", float64(n)/(1<<30))
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MiB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1f KiB", float64(n)/(1<<10))
	default:
		return fmt.Sprintf("%d B", n)
	}
}
