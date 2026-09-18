package main

import (
	"strings"
	"testing"
)

// 本文件保证探测程序"真的是代码"而不是被优化掉的死路径 ——
// 如果 wasiprobe 退化成空壳，白名单会**静默变窄**（又回到"用了 os.Stat 就被拒"的缺陷），
// 而那种退化在"能编译"这一点上是看不出来的。
//
// 变异验证（§5.5）：
//   - 把 guarded() 改成 return true            → 本用例会以 exit 3 直接死掉（os.Exit 探测真的执行）；
//   - 删掉任何一组探测（例如 os.ReadDir）        → TestProbesRunNatively 的计数与导入面断言会红
//     （导入面由 wasmmod/imports_gen_test.go 覆盖，这里守住"本机真的执行成功"）。

func TestGuardedReturnsFalse(t *testing.T) {
	// guarded() 是"不可达守卫"：它必须永假，否则 os.Exit / os.Stdin.Read 的探测会真的执行。
	if guarded() {
		t.Fatalf("guarded() 必须为假（它只是为了让链接器保留调用，见包注释）")
	}
}

func TestProbesRunNatively(t *testing.T) {
	dir := t.TempDir()
	list := probes(dir)
	if len(list) < 25 {
		t.Fatalf("探测项只有 %d 个，覆盖面可能被削掉了（见包注释里的目标清单）", len(list))
	}

	succeeded := 0
	for _, p := range list {
		err := p.run()
		if err == nil {
			succeeded++
			continue
		}
		// os.UserHomeDir 是唯一一条依赖宿主环境（$HOME）的探测；其余在本机必须成功。
		if strings.HasPrefix(p.name, "os.UserHomeDir") {
			t.Logf("跳过环境相关失败：%s: %v", p.name, err)
			continue
		}
		t.Errorf("本机原生探测失败：%s: %v", p.name, err)
	}
	if succeeded < 25 {
		t.Fatalf("只有 %d 个探测成功，探测程序可能退化成死代码（白名单会静默变窄）", succeeded)
	}
	// 走到这里就说明 os.Exit 探测没有真的执行（执行了进程早已以 3 退出）。
}

func TestProbeNamesAreUnique(t *testing.T) {
	seen := map[string]bool{}
	for _, p := range probes(t.TempDir()) {
		if seen[p.name] {
			t.Fatalf("探测名重复：%s", p.name)
		}
		seen[p.name] = true
	}
}
