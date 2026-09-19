package main

// 本文件是 2026-09-19 第三轮对抗审计 A-2 / A-6 的**行为级护栏**：
//
//	A-2 环境变量路径零校验：控制台明确拒绝的形态（单标签 `intranet`、`..:8443` 多尾点、
//	    下划线、IP）从 `PICOAI_APPS_BASE_DOMAIN` 进来一律原样生效，运行期只剩一道
//	    漏形态的闸门 ⇒ 服务端 200 + 浏览器零 Cookie（静默死）。
//	A-6 保存路径缺第三条 fail-closed 自检：管理员能存下"基域与对外地址不同域"的组合，
//	    错误只在员工换票时才暴露。
//
// 变异验证（改回旧实现 ⇒ 本文件必红）：
//   - `newBaseDomainHolder` 不再校验 env（回到只 TrimSpace）⇒ 启动期用例红；
//   - `Apply` 去掉第三条自检 ⇒ 不同域那条用例红；
//   - `normalizeBaseDomain` 自己复制一份域名规则（而不是用 session.InspectAppBaseDomain）
//     ⇒ 表驱动一致性用例红。

import (
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/anonlimit"
	"github.com/picoaide/picoaide/internal/wasmapp/session"
)

// startupProbeEnv 标记"本进程是启动期探针的子进程"。
const startupProbeEnv = "PICOAI_BASEDOMAIN_STARTUP_PROBE"

// TestBaseDomainConfigPathsShareOneJudgement 覆盖 P2-2 判据④：
// **同一输入，控制台保存路径、环境变量路径、运行期签发闸门必须给出同一结论**
// （判据单真源 = session.InspectAppBaseDomain）。
func TestBaseDomainConfigPathsShareOneJudgement(t *testing.T) {
	// 形态矩阵（第四轮会拿它打这一区）：**同一输入，控制台保存路径、环境变量路径、
	// 运行期签发闸门必须给出同一结论**（判据单真源 = session.InspectAppBaseDomain）。
	//
	// 组 1 = 域名规则：三条路径逐条同结论（含原因码）。
	longLabel := strings.Repeat("a", 64) + ".example.com" // 单标签 64 字符（上限 63）
	longDomain := strings.Repeat("a", 63) + "." + strings.Repeat("b", 63) + "." +
		strings.Repeat("c", 63) + "." + strings.Repeat("d", 63) + ".com" // 总长 259 > 253
	rules := []struct {
		in     string
		reason string // 空 = 合法（三路径都必须接受）
	}{
		{"harness.example.com", ""},
		{"apps.example.com", ""},
		{"APPS.Example.COM.", ""},                             // 大小写 + 单尾点：归一化后合法
		{"harness.example.com.", ""},                          // 单尾点
		{"a.b.c.example.com", ""},                             // 多级标签
		{"intranet", "single_label"},                          // 单标签（A-2 现场）
		{"localhost", "reserved_host"},                        // 本机保留名
		{"corp.local", "reserved_host"},                       // mDNS 保留后缀
		{"co.uk", "public_suffix"},                            // 公网后缀（多标签）
		{"github.io", "public_suffix"},                        // 公网后缀（私有段）
		{"apps.example.com..", "multiple_trailing_dots"},      // 双尾点（A-1 现场）
		{"apps.example.com..:8443", "multiple_trailing_dots"}, // 双尾点 + 端口（A-1 现场）
		{"10.0.0.7", "ip_not_allowed"},                        // IPv4 字面量
		{"[::1]:8443", "not_a_bare_host"},                     // IPv6 方括号写法
		{"[::1]", "not_a_bare_host"},                          // 同上（无端口）
		{"harness_example.com", "bad_label"},                  // 下划线
		{".apps.example.com", "bad_label"},                    // 前导点（空标签）
		{longLabel, "bad_label"},                              // 单标签超长
		{longDomain, "too_long"},                              // 总长超限
		{"*.apps.example.com", "wildcard_not_allowed"},
		{"apps.example.com/path", "not_a_bare_host"},
		{"harness.example.com:8443/x", "not_a_bare_host"}, // 端口 + 路径：先按"不是裸主机"拒
		// 端口 + 非法主机：控制台只在"域名规则本身通过、只是写法不规范"时才按拼写拒，
		// 因此这四条的**原因码与 env / 运行期完全相同**（比"只断言都拒绝"更强）。
		{"10.0.0.7:8443", "ip_not_allowed"},
		{"intranet:8443", "single_label"},
		{"::1", "empty_host"},   // 裸 IPv6：形状层取不出主机名
		{":8443", "empty_host"}, // 只有端口
	}
	for _, tc := range rules {
		t.Run("domain-rules/"+tc.in, func(t *testing.T) {
			consoleValue, consoleErr := normalizeBaseDomain(tc.in)
			envValue, envErr := normalizeBaseDomainEnv(tc.in)
			capability := session.CheckTicketNonceCapability(tc.in, "")

			if tc.reason == "" {
				if consoleErr != nil {
					t.Fatalf("控制台路径拒绝了合法基域 %q：%v", tc.in, consoleErr)
				}

				if envErr != nil {
					t.Fatalf("环境变量路径拒绝了合法基域 %q：%v", tc.in, envErr)
				}
				if !capability.Usable {
					t.Fatalf("运行期闸门拒绝了合法基域 %q：reason=%s", tc.in, capability.Reason)
				}
				// 归一化结果也必须逐字一致（否则同一份配置在两条路径上生效值不同）。
				if consoleValue != envValue {
					t.Fatalf("控制台归一值 %q ≠ 环境变量归一值 %q", consoleValue, envValue)
				}
				if _, host := session.ParseBaseDomain(envValue); host != capability.CookieDomain {
					t.Fatalf("生效值 %q 的主机名 ≠ 运行期 Cookie Domain %q", envValue, capability.CookieDomain)
				}
				return
			}
			// 拒绝：三路径都必须拒，且原因码一致（控制台 details.reason = env 的原因码
			// = 运行期日志里的原因码）。
			if consoleErr == nil {
				t.Fatalf("控制台路径接受了非法基域 %q（want reason=%s）", tc.in, tc.reason)
			}
			if got, _ := consoleErr.Details["reason"].(string); got != tc.reason {
				t.Fatalf("控制台路径 reason = %q, want %q（details=%v）", got, tc.reason, consoleErr.Details)
			}
			if len(consoleErr.Hints) == 0 {
				t.Fatalf("控制台拒绝 %q 时必须带 hints（管理员要知道怎么改）", tc.in)
			}
			var envReject *baseDomainEnvError
			if !errors.As(envErr, &envReject) {
				t.Fatalf("环境变量路径接受了非法基域 %q（want reason=%s，err=%v）", tc.in, tc.reason, envErr)
			}
			if envReject.Reason != tc.reason {
				t.Fatalf("环境变量路径 reason = %q, want %q", envReject.Reason, tc.reason)
			}
			if envReject.Hint == "" {
				t.Fatalf("环境变量路径拒绝 %q 时必须带可行动作", tc.in)
			}
			if capability.Usable {
				t.Fatalf("运行期闸门接受了非法基域 %q（want 拒绝）", tc.in)
			}
			if !strings.Contains(capability.Reason, tc.reason) {
				t.Fatalf("运行期闸门 reason = %q，未点名原因码 %q", capability.Reason, tc.reason)
			}
		})
	}

	// 组 1b：**结尾点与大小写的归一化契约**（主控裁定：单个结尾点接受、可用性优先）——
	// 每一档同时钉"接受"与"归一化结果"：只钉接受会让"把单个结尾点原样带进 Cookie Domain"
	// 这类回归漏网（那正是 A-1 静默死的形态）。
	for _, tc := range []struct{ in, want string }{
		{"harness.example.com.", "harness.example.com"},         // 单个结尾点 = FQDN 绝对标记
		{"HARNESS.Example.COM.", "harness.example.com"},         // 大小写 + 单个结尾点
		{"https://harness.example.com.", "harness.example.com"}, // 显式 scheme + 单个结尾点
	} {
		t.Run("trailing-dot/"+tc.in, func(t *testing.T) {
			consoleValue, consoleErr := normalizeBaseDomain(tc.in)
			if consoleErr != nil {
				t.Fatalf("单个结尾点/端口是合法写法（归一化后写出规范 Domain），不得拒绝 %q：%v", tc.in, consoleErr)
			}
			envValue, envErr := normalizeBaseDomainEnv(tc.in)
			if envErr != nil {
				t.Fatalf("环境变量路径必须接受 %q：%v", tc.in, envErr)
			}
			capability := session.CheckTicketNonceCapability(tc.in, "")
			if !capability.Usable {
				t.Fatalf("运行期闸门必须可用 %q：reason=%s", tc.in, capability.Reason)
			}
			// 归一化结果三处必须逐字相同（consoleValue 带 http:// 前缀时按主机名比）。
			_, consoleHost := session.ParseBaseDomain(consoleValue)
			if consoleHost != tc.want || envValue != tc.want || capability.CookieDomain != tc.want {
				t.Fatalf("归一化不一致：console=%q(host=%q) env=%q cookieDomain=%q, want %q",
					consoleValue, consoleHost, envValue, capability.CookieDomain, tc.want)
			}
		})
	}

	// 组 2：**拼写**差异 —— 唯一允许的分歧：控制台要求规范写法（不带端口），
	// env / 运行期接受端口写法并归一化掉（存量 .env 里很常见）。判据（能不能承载 Cookie）
	// 不受影响，归一化结果必须相同；否则"同一个部署换个写法就换了一个域"。
	for _, tc := range []struct{ in, want string }{
		{"harness.example.com:8443", "harness.example.com"},  // 端口
		{"harness.example.com.:8443", "harness.example.com"}, // 尾点在端口前（单点）
		{"harness.example.com:8443.", "harness.example.com"}, // 尾点在端口后
		{"HARNESS.Example.Com:8443", "harness.example.com"},  // 大小写 + 端口
	} {
		t.Run("spelling/"+tc.in, func(t *testing.T) {
			if _, consoleErr := normalizeBaseDomain(tc.in); consoleErr == nil {
				t.Fatalf("控制台必须要求规范写法（不带端口）：%q 竟被接受", tc.in)
			} else if got, _ := consoleErr.Details["reason"].(string); got != "not_a_bare_host" {
				t.Fatalf("控制台对 %q 的 reason = %q, want not_a_bare_host", tc.in, got)
			}
			envValue, envErr := normalizeBaseDomainEnv(tc.in)
			if envErr != nil {
				t.Fatalf("环境变量路径必须接受端口写法（存量 .env 常见）%q：%v", tc.in, envErr)
			}
			if envValue != tc.want {
				t.Fatalf("环境变量路径归一化 %q = %q, want %q（端口不参与 Cookie 作用域）", tc.in, envValue, tc.want)
			}
			capability := session.CheckTicketNonceCapability(tc.in, "")
			if !capability.Usable || capability.CookieDomain != tc.want {
				t.Fatalf("运行期闸门对 %q 的判定 = %+v，want 可用且 CookieDomain=%s", tc.in, capability, tc.want)
			}
		})
	}

	// 组 3：空值 = 关闭应用子域（两条配置路径都必须接受；运行期判"未配置"是另一件事）。
	for _, in := range []string{"", "   "} {
		if v, err := normalizeBaseDomain(in); err != nil || v != "" {
			t.Fatalf("控制台路径对空值 %q 应当返回（\"\", nil），得到（%q, %v）", in, v, err)
		}
		if v, err := normalizeBaseDomainEnv(in); err != nil || v != "" {
			t.Fatalf("环境变量路径对空值 %q 应当返回（\"\", nil），得到（%q, %v）", in, v, err)
		}
	}
}

// TestEnvBaseDomainStartupRefusesMalformedValue 覆盖 P2-2 判据①/③：
// 非法基域必须在**启动期**拒绝启动；合法形态（含端口写法）必须正常启动。
//
// 为什么要起子进程：判据本身就是"进程不启动"（装配期 log.Fatalf）。只有真的跑一次装配，
// 才能证伪"只打了一行日志就继续跑"这种退化 —— 子进程里执行的是与 setupWasmPlatform
// 相同的两行（构造持有者 → 检查 StartupError）。
func TestEnvBaseDomainStartupRefusesMalformedValue(t *testing.T) {
	if os.Getenv(startupProbeEnv) == "1" {
		// 子进程分支：复刻 setupWasmPlatform 的启动自检（不连库，只看配置）。
		holder := newBaseDomainHolder(nil, os.Getenv(EnvAppsBaseDomain))
		if err := holder.StartupError(); err != nil {
			log.Fatalf("WASM 应用平台启动自检失败：应用基域配置非法：%v", err)
		}
		fmt.Printf("STARTED value=%q source=%q\n", holder.Get(), holder.Source())
		return
	}

	run := func(value string) (string, error) {
		t.Helper()
		cmd := exec.Command(os.Args[0], "-test.run=^TestEnvBaseDomainStartupRefusesMalformedValue$")
		cmd.Env = append(os.Environ(), startupProbeEnv+"=1", EnvAppsBaseDomain+"="+value)
		out, err := cmd.CombinedOutput()
		return string(out), err
	}

	// ① 非法形态 ⇒ 非零退出 + 点名配置项 + 可执行动作（不是"照常起来，等员工换票时才炸"）。
	bad := []struct {
		value, wantReason string
		wantExtra         []string // 除配置项名/取值/原因码外，文案里还必须出现的可行动作要点
	}{
		{"intranet", "single_label", nil}, // A-2 现场（内网常见）
		// A-1 现场：必须点名"多余的结尾点"并给出正确写法（运维照抄即可）。
		{"apps.example.com..:8443", "multiple_trailing_dots", []string{"结尾点", "apps.example.com"}},
		{"apps.example.com..", "multiple_trailing_dots", []string{"结尾点", "apps.example.com"}},
		{"10.0.0.7", "ip_not_allowed", nil},
		{"harness_example.com", "bad_label", nil},
		{"co.uk", "public_suffix", nil},
		{"localhost", "reserved_host", nil},
	}
	for _, tc := range bad {
		t.Run("refuse/"+tc.value, func(t *testing.T) {
			out, err := run(tc.value)
			if err == nil {
				t.Fatalf("PICOAI_APPS_BASE_DOMAIN=%q 必须拒绝启动，实际正常退出：%s", tc.value, out)
			}
			for _, want := range append([]string{EnvAppsBaseDomain, tc.value, tc.wantReason}, tc.wantExtra...) {
				if !strings.Contains(out, want) {
					t.Fatalf("启动失败信息缺少 %q：%s", want, out)
				}
			}
			if strings.Contains(out, "STARTED ") {
				t.Fatalf("非法基域竟然启动成功（自检没有生效）：%s", out)
			}
		})
	}

	// ③ 合法形态（含端口写法与大小写/单尾点）⇒ 正常启动，且生效值是规范化后的值。
	good := []struct{ value, wantValue string }{
		{"harness.example.com", "harness.example.com"},
		{"harness.example.com:8443", "harness.example.com"},
		{"Harness.Example.COM.", "harness.example.com"},
		{"http://harness.example.com", "http://harness.example.com"},
	}
	for _, tc := range good {
		t.Run("start/"+tc.value, func(t *testing.T) {
			out, err := run(tc.value)
			if err != nil {
				t.Fatalf("合法基域 %q 必须能启动：%s", tc.value, out)
			}
			if want := fmt.Sprintf("STARTED value=%q", tc.wantValue); !strings.Contains(out, want) {
				t.Fatalf("生效值不是规范化后的 %q：%s", tc.wantValue, out)
			}
		})
	}
}

// TestApplyRunsThirdFailClosedSelfCheck 覆盖 P3-6：保存路径必须有第三条自检
// 「基域可承载 Cookie **且**与对外地址同域」，且拒绝时控制台能拿到可行动作。
func TestApplyRunsThirdFailClosedSelfCheck(t *testing.T) {
	db := requireRealDB(t)
	t.Setenv(anonlimit.EnvTrustedProxies, "172.28.0.2")
	t.Setenv(anonlimit.EnvTrustedProxiesExplicit, "1")

	// ① 对外地址与基域**不同域** ⇒ 保存必须被拒（否则管理员能存下"登录可见应用必 500"的组合）。
	withPublicBaseURL(t, "https://other.example.com", "")
	holder := newBaseDomainHolder(db, "")
	err := holder.Apply("apps.example.com")
	if err == nil {
		t.Fatal("基域与对外地址不同域时必须拒绝保存（缺第三条自检 = 能存下一个登录可见应用必 500 的组合）")
	}
	if reason, _ := err.Details["reason"].(string); reason != "main_origin_not_same_domain_as_base:other.example.com" {
		t.Fatalf("拒绝原因 = %q（details=%v），want main_origin_not_same_domain_as_base:other.example.com", reason, err.Details)
	}
	hint := strings.Join(err.Hints, " ")
	for _, want := range []string{"server.base_url", "PICOAI_PUBLIC_BASE_URL", "500"} {
		if !strings.Contains(hint, want) {
			t.Fatalf("拒绝文案缺少可行动作/后果 %q：%q", want, hint)
		}
	}
	if holder.Get() != "" {
		t.Fatalf("被拒之后不得生效：%q", holder.Get())
	}
	if raw, ok, rerr := readBaseDomainSetting(t, db); rerr != nil || ok {
		t.Fatalf("被拒的保存不该落库：ok=%v raw=%q err=%v", ok, raw, rerr)
	}

	// ② 同域 ⇒ 正常保存（第三条自检不能误伤正常部署）。
	withPublicBaseURL(t, "https://apps.example.com", "")
	if err := holder.Apply("apps.example.com"); err != nil {
		t.Fatalf("基域与对外地址同域时应可保存：%v", err)
	}
	if holder.Get() != "apps.example.com" || holder.Source() != "setting" {
		t.Fatalf("保存后未生效：value=%q source=%q", holder.Get(), holder.Source())
	}

	// ③ 控制台设置（server.base_url 走 Resolver，不是 env）同样参与这条判据。
	withPublicBaseURL(t, "", "https://console.example.com")
	if err := holder.Apply("apps.example.com"); err == nil {
		t.Fatal("对外地址来自控制台设置（Resolver）时，不同域同样必须拒绝保存")
	}
}
