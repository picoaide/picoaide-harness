package serverstore

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
)

// R2-L1-3（P2，2026-09-20）：`localZoneName()` 交给 PG 的必须是**PG 认识的时区名**。
//
// 现场：`TZ=:/usr/share/zoneinfo/Asia/Shanghai`（POSIX 允许的"冒号 + 路径"形态）时，
// Go 的 `initLocal` 把**路径本身**当作 `time.Local` 的名字 ⇒ 旧实现原样交给
// `AT TIME ZONE $4` ⇒ `ERROR: time zone "…" not recognized` ⇒ C4 的 ai-usage **500**
// （C1/C2 正常：它们走纯 Go 的 LocalDay）。修法见 localZoneName 的注释。
//
// 三层判据（缺一条都不算闭合）：
//  1. 形态层（纯函数，不依赖宿主）：IANA 名 ✅ / zoneinfo 路径 ⇒ 反解出 IANA 名 ✅ /
//     "Local"、POSIX 串、非法名、越界路径 ⇒ 拒绝（绝不外泄成"名字"）；
//  2. **真实 TZ 形态**（子进程，`time.Local` 只在进程启动时求值 ⇒ 必须在子进程里设 TZ）；
//  3. **PG 接受性**（真库）：把 2 得到的名字真的喂给 `AT TIME ZONE`，并加一条反向对照
//     （裸路径必须**被 PG 拒绝** —— 否则本用例的判据没有牙齿）。
//
// 变异：把 localZoneName 改回 `return time.Local.String()` ⇒ 路径形态用例红（PG 报错）。

const pathFormTZValue = ":/usr/share/zoneinfo/Asia/Shanghai"

// helperEnv 触发子进程里的 helper 分支（只有本文件的两个 Test 会用）。
const helperEnv = "F4_ZONE_NAME_HELPER"

// TestZoneNameHelperProcess 不是用例：它是被父进程用真实 TZ 拉起来的**探针进程**
// （`time.Local` 只在进程启动时求值一次，所以"路径形态 TZ"只能在子进程里复现）。
func TestZoneNameHelperProcess(t *testing.T) {
	if os.Getenv(helperEnv) != "1" {
		t.Skip("不是探针调用（父用例会带 " + helperEnv + "=1 重新执行本二进制）")
	}
	fmt.Printf("ZONE_NAME=%s\n", localZoneName())
}

// zoneNameInSubprocess 用给定 TZ 起一个探针进程，取回 localZoneName() 的返回值。
func zoneNameInSubprocess(t *testing.T, tz string) (string, string) {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestZoneNameHelperProcess$", "-test.v=false")
	env := make([]string, 0, len(os.Environ())+2)
	for _, kv := range os.Environ() {
		// 自带的 TZ 先去干净：同名变量重复时"哪个生效"取决于 libc/Go 的实现细节。
		if strings.HasPrefix(kv, "TZ=") || strings.HasPrefix(kv, helperEnv+"=") {
			continue
		}
		env = append(env, kv)
	}
	env = append(env, helperEnv+"=1", "TZ="+tz)
	cmd.Env = env
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("探针进程失败（TZ=%q）: %v\n%s", tz, err, out)
	}
	for _, line := range strings.Split(string(out), "\n") {
		if value, ok := strings.CutPrefix(strings.TrimSpace(line), "ZONE_NAME="); ok {
			return value, string(out)
		}
	}
	t.Fatalf("探针没有输出 ZONE_NAME（TZ=%q）:\n%s", tz, out)
	return "", ""
}

// TestZoneNameForSQLForms 是形态层判据（不需要 PG，也不依赖宿主 TZ）。
func TestZoneNameForSQLForms(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
		ok   bool
	}{
		{"IANA 名直接用", "Asia/Shanghai", "Asia/Shanghai", true},
		{"UTC", "UTC", "UTC", true},
		{"路径形态（TZ=:…）反解成 IANA 名", "/usr/share/zoneinfo/Asia/Shanghai", "Asia/Shanghai", true},
		{"其它 zoneinfo 根", "/usr/lib/zoneinfo/Europe/Berlin", "Europe/Berlin", true},
		{"未设 TZ（Go 给 \"Local\"）必须拒绝", "Local", "", false},
		{"空名必须拒绝", "", "", false},
		{"POSIX 固定偏移（Go 落回 UTC 之前的形态）必须拒绝", "CST-8", "", false},
		{"非法名必须拒绝", "Not/AZone", "", false},
		{"不存在路径必须拒绝", "/usr/share/zoneinfo/Not/AZone", "", false},
		{"越界路径不得被拼成名字", "/usr/share/zoneinfo/../../../etc/passwd", "", false},
		{"相对路径不得当名字", "usr/share/zoneinfo/Asia/Shanghai", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := zoneNameForSQL(tc.in)
			if ok != tc.ok || got != tc.want {
				t.Fatalf("zoneNameForSQL(%q) = (%q, %v), want (%q, %v)", tc.in, got, ok, tc.want, tc.ok)
			}
			if strings.HasPrefix(got, "/") || strings.Contains(got, "..") {
				t.Fatalf("zoneNameForSQL(%q) 返回了不像时区名的值 %q（路径/越界串不得外泄）", tc.in, got)
			}
		})
	}
}

// TestZoneNameFromLocaltime 钉住"未设 TZ"这条路径（纯函数：localtime 路径由调用方给）。
func TestZoneNameFromLocaltime(t *testing.T) {
	if _, err := os.Stat("/usr/share/zoneinfo/Asia/Shanghai"); err != nil {
		t.Skip("本机没有 tzdata（/usr/share/zoneinfo/Asia/Shanghai 不存在）")
	}
	dir := t.TempDir()
	link := dir + "/localtime"
	if err := os.Symlink("/usr/share/zoneinfo/Asia/Shanghai", link); err != nil {
		t.Fatalf("建符号链接: %v", err)
	}
	if got, ok := zoneNameFromLocaltime(link); !ok || got != "Asia/Shanghai" {
		t.Fatalf("zoneNameFromLocaltime(符号链接) = (%q, %v), want (Asia/Shanghai, true)", got, ok)
	}
	// 普通文件（不是符号链接）/ 不存在的路径 ⇒ 解不出名字（调用方回落 UTC）。
	plain := dir + "/plain"
	if err := os.WriteFile(plain, []byte("TZif2"), 0o600); err != nil {
		t.Fatalf("写普通文件: %v", err)
	}
	if got, ok := zoneNameFromLocaltime(plain); ok {
		t.Fatalf("普通文件不该解出 IANA 名，得到 %q", got)
	}
	if got, ok := zoneNameFromLocaltime(dir + "/missing"); ok {
		t.Fatalf("不存在的路径不该解出 IANA 名，得到 %q", got)
	}
}

// TestLocalZoneNameIsUsableByPostgres 是真实 TZ 形态 + PG 接受性的判据。
func TestLocalZoneNameIsUsableByPostgres(t *testing.T) {
	if _, err := os.Stat("/usr/share/zoneinfo/Asia/Shanghai"); err != nil {
		t.Skip("本机没有 tzdata（/usr/share/zoneinfo/Asia/Shanghai 不存在）")
	}
	db, cleanup := NewTestDB(t)
	defer cleanup()

	dayOf := func(zone string) (string, error) {
		var day string
		err := db.QueryRow(`SELECT (now() AT TIME ZONE $1)::date::text`, zone).Scan(&day)
		return day, err
	}

	for _, tc := range []struct{ tz, want string }{
		{pathFormTZValue, "Asia/Shanghai"}, // 现场形态：修复前这里直接 500
		{"Asia/Shanghai", "Asia/Shanghai"},
		{"Not/AZone", "UTC"}, // 非法 TZ：Go 自己回落 UTC
		{"CST-8", "UTC"},     // POSIX 形态：同上
	} {
		got, raw := zoneNameInSubprocess(t, tc.tz)
		if got != tc.want {
			t.Fatalf("TZ=%q 时 localZoneName() = %q, want %q\n探针输出:\n%s", tc.tz, got, tc.want, raw)
		}
		if strings.HasPrefix(got, "/") {
			t.Fatalf("TZ=%q 时把路径当成了时区名: %q", tc.tz, got)
		}
		day, err := dayOf(got)
		if err != nil {
			t.Fatalf("TZ=%q ⇒ localZoneName()=%q 交给 PG 失败: %v（修复前就是这个 500）", tc.tz, got, err)
		}
		if day == "" {
			t.Fatalf("TZ=%q ⇒ PG 返回了空日期", tc.tz)
		}
	}

	// 反向对照：**裸路径**必须被 PG 拒绝 —— 证明上面那条判据不是空转（PG 真的会拒它）。
	if day, err := dayOf("/usr/share/zoneinfo/Asia/Shanghai"); err == nil {
		t.Fatalf("PG 竟然接受了裸路径（day=%s）⇒ 本用例的前提不成立，必须换一个路径形态", day)
	}

	// 不变量：当前进程的 localZoneName() 也不得是路径形态（本进程 TZ 由跑测试的人决定）。
	if got := localZoneName(); strings.HasPrefix(got, "/") {
		t.Fatalf("localZoneName() = %q 是路径（本进程 TZ=%q）", got, os.Getenv("TZ"))
	}
}
