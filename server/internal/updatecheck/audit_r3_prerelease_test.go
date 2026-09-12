package updatecheck

import "testing"

// 审计 r3 回归锁:FIX-23 只修一半 —— 「同 core 预发布递增」永不提示更新。
//
// 上一轮 FIX-23 把 Check 的准入从 ParseCanonicalStableValid 换成
// NormalizeVersion(接受预发布),但比较仍走 CompareSemVer 的 **core-only**
// 语义(注释原话:「预发布不影响'是否值得升级'的判定」)。于是 beta 渠道最
// 常见的升级形态 —— 2.7.2-beta.7 → 2.7.2-beta.8(core 不变)—— 恒为
// UpdateAvailable=false:预发布当前版本能提示跨 core 升级,却提示不了自己
// 渠道内的下一次预发布,beta 升级提示在常规发布节奏下永久失效。
//
// 复核证据(2026-09-13,evidence/server-rest/probes/zz_probe_srvrest_updatecheck_test.go):
//
//	CompareSemVer("2.7.2-beta.8","2.7.2-beta.7")=0  (0 = 不提示)
//	cur=2.7.2-beta.7 latest=2.7.2-beta.8 UpdateAvailable=false
//
// 本文件是**真实运行时**回归:真 httptest 更新服务器 + Checker.Check 全链路
// (直接驱动生产路径,不 mock CompareSemVer),断言:
//   - beta/rc/alpha 数字递增正确排序(含两位数,防字典序陷阱);
//   - 稳定版 > 同 core 预发布(不提示"降级"到预发布);
//   - 预发布 → 同 core 稳定版要提示(beta 渠道转正式发布);
//   - 跨 core 的原有行为与稳定版行为逐条不变。

func TestAuditR3CheckPrereleaseOrdering(t *testing.T) {
	cases := []struct {
		name            string
		current, latest string
		want            bool
	}{
		// —— 缺陷本体:同 core 预发布递增 ——
		{"beta_同core递增", "2.7.2-beta.7", "2.7.2-beta.8", true},
		{"beta_同core递增两位数", "2.7.2-beta.9", "2.7.2-beta.10", true},
		{"rc_同core递增", "2.7.2-rc.1", "2.7.2-rc.2", true},
		{"alpha_同core递增", "2.7.2-alpha.1", "2.7.2-alpha.2", true},
		{"带v前缀_同core递增", "v2.7.2-beta.7", "v2.7.2-beta.8", true},
		{"build元数据不影响排序", "2.7.2-beta.7", "2.7.2-beta.8+build.5", true},
		{"段数更多者更大", "2.7.2-beta", "2.7.2-beta.1", true},
		{"alpha低于beta", "2.7.2-alpha.9", "2.7.2-beta.1", true},
		{"beta低于rc", "2.7.2-beta.3", "2.7.2-rc.1", true},

		// —— 不得提示降级 ——
		{"同版本不提示", "2.7.2-beta.7", "2.7.2-beta.7", false},
		{"同core预发布降级不提示", "2.7.2-beta.8", "2.7.2-beta.7", false},
		{"beta比rc新时不提示(字典序反向)", "2.7.2-rc.1", "2.7.2-beta.9", false},
		{"稳定版_不提示降级到同core预发布", "2.7.2", "2.7.2-beta.8", false},
		{"core更小不提示", "2.8.0", "2.7.2-beta.7", false},

		// —— 预发布当前版本的跨 core 行为(上一轮 FIX-23 的成果,不得回退)——
		{"预发布_core更大要提示", "2.7.2-beta.7", "2.8.0", true},
		{"预发布_同core转正要提示", "2.7.2-beta.7", "2.7.2", true},
		{"rc_同core转正要提示", "2.7.2-rc.1", "2.7.2", true},

		// —— 稳定版原有行为逐条不变 ——
		{"稳定版_更高core提示", "2.5.1", "2.6.0", true},
		{"稳定版_同版本不提示", "2.5.1", "2.5.1", false},
		{"稳定版_更低core不提示", "2.6.0", "2.5.1", false},
		{"稳定版_带v前缀提示", "v2.5.1", "2.6.0", true},
		{"稳定版_最新是预发布更高core要提示", "2.6.0", "2.7.0-rc.1", true},

		// —— 不可解析保持静默(安全方向)——
		{"dev构建保持静默", "dev", "2.8.0", false},
		{"空版本保持静默", "", "2.8.0", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := checkWithCurrent(t, manifestWith(tc.latest), tc.current)
			if res.UpdateAvailable != tc.want {
				t.Fatalf("cur=%s latest=%s → UpdateAvailable=%v, want %v (Latest=%q Current=%q)",
					tc.current, tc.latest, res.UpdateAvailable, tc.want, res.Latest, res.Current)
			}
			if res.Latest != NormalizeVersion(tc.latest) {
				t.Errorf("Latest = %q, want %q", res.Latest, NormalizeVersion(tc.latest))
			}
		})
	}
}

// TestAuditR3CompareSemVerPrecedence 直接钉住比较器本身:SemVer 2.0.0 §11
// 的预发布优先级(数字标识符按数值、字母标识符按 ASCII、数字 < 字母、
// 段数多者更大、有预发布 < 无预发布),以及 core 比较必须保持"按位数比数值"
// 的原有语义(避免字典序陷阱)。
func TestAuditR3CompareSemVerPrecedence(t *testing.T) {
	cases := []struct {
		left, right string
		want        int
	}{
		// 缺陷本体
		{"2.7.2-beta.8", "2.7.2-beta.7", 1},
		{"2.7.2-beta.7", "2.7.2-beta.8", -1},
		{"2.7.2-beta.999", "2.7.2-beta.1000", -1}, // 数值比较,非字典序
		{"2.7.2-beta.7", "2.7.2-beta.7", 0},
		// 稳定版 > 同 core 预发布
		{"2.7.2", "2.7.2-beta.8", 1},
		{"2.7.2-beta.8", "2.7.2", -1},
		{"2.8.0", "2.8.0-beta.1", 1},
		// 字母标识符按 ASCII
		{"2.7.2-rc.1", "2.7.2-beta.99", 1},
		{"2.7.2-beta.1", "2.7.2-alpha.99", 1},
		// 数字 < 字母
		{"2.7.2-beta.2", "2.7.2-beta.alpha", -1},
		// 段数多者更大
		{"2.7.2-beta.1", "2.7.2-beta", 1},
		{"2.7.2-beta", "2.7.2-beta.0", -1},
		// build 元数据忽略
		{"2.7.2-beta.8+build.5", "2.7.2-beta.8", 0},
		// core 优先
		{"2.8.0-beta.1", "2.7.9", 1},
		{"2.7.9", "2.8.0-beta.1", -1},
		// core 数值比较(原有语义不变)
		{"2.10.0", "2.9.0", 1},
		{"10.0.0", "9.99.99", 1},
		{"2.5.1", "2.5.2", -1},
		// 非法输入视为相等(原有语义不变)
		{"dev", "2.0.0", 0},
		{"2.5.1", "not-a-version", 0},
	}
	for _, tc := range cases {
		if got := CompareSemVer(tc.left, tc.right); got != tc.want {
			t.Errorf("CompareSemVer(%q, %q) = %d, want %d", tc.left, tc.right, got, tc.want)
		}
		// 反对称性:反向必须给出相反符号(0 保持 0)。
		if got := CompareSemVer(tc.right, tc.left); got != -tc.want {
			t.Errorf("CompareSemVer(%q, %q) = %d, want %d (反对称性)", tc.right, tc.left, got, -tc.want)
		}
	}
}
