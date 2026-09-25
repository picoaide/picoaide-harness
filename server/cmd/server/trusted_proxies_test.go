package main

// R15C-03（审计 2026-09-25，**复核仍开的旧项**）的判据：
// 「改网段部署不得静默失去 X-Forwarded-For」。
//
// 缺陷形态：`docker-compose.yml` 让 `CADDY_IP` 可配（`${CADDY_IP:-172.28.0.2}`，
// NETWORK_SUBNET 冲突时运维会一起改），而 `services.server.environment` 里
// `PICOAI_TRUSTED_PROXIES` 的缺省**硬编码**同一个字面量，`main.go` 也只从 env
// 追加、不派生 ⇒ 只改 CADDY_IP 时 gin 不认 Caddy 的地址、忽略 XFF，`ClientIP()`
// 退化成代理 IP：登录 / MFA / OIDC 限流桶坍缩成全组织共桶（60 次失败登录锁死
// 全员），且完全静默。
//
// 两组判据：
//  1. 执行级（trustedProxies）：派生、显式优先、两者皆空三条路径 + 不一致告警；
//  2. 编排级（compose 对拍）：server 容器必须拿到 CADDY_IP，且它与 caddy 容器的
//     `ipv4_address` **同一个变量、同一份缺省** —— 只要这两处还能各自漂移，
//     缺陷就能以"换个地方"的方式复发。
//
// 判据读的是文件本身（compose 的解析结果），不跑 docker：CI 的 Go job 里没有
// docker compose，而"两处引用的是不是同一个变量"是纯文本事实。

import (
	"strings"
	"testing"
)

func envFrom(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

// TestTrustedProxiesDerivedFromCaddyIP 钉住"未显式配置时从 CADDY_IP 派生"。
// 变异：把派生那一段删掉（退回"只读 PICOAI_TRUSTED_PROXIES"）⇒ 本用例红。
func TestTrustedProxiesDerivedFromCaddyIP(t *testing.T) {
	got, source := trustedProxies(envFrom(map[string]string{"CADDY_IP": "172.30.0.2"}))
	if source != "derived:CADDY_IP" {
		t.Fatalf("source = %q, want derived:CADDY_IP（未显式配置时必须从 CADDY_IP 派生）", source)
	}
	if !containsStr(got, "172.30.0.2") {
		t.Fatalf("可信代理列表 %v 不含改过的 CADDY_IP 172.30.0.2 —— 改网段后 XFF 会静默失效、"+
			"限流桶坍缩成全组织共桶", got)
	}
	// 环回恒在（本机 nginx/宿主探针）。
	for _, lo := range []string{"127.0.0.1", "::1"} {
		if !containsStr(got, lo) {
			t.Fatalf("可信代理列表 %v 丢了环回 %s", got, lo)
		}
	}
}

// TestTrustedProxiesExplicitWins：显式配置优先（共享 Caddy/nginx 部署），
// 且**不会**再把 CADDY_IP 悄悄加进去（避免"以为改了就生效"的误判）。
func TestTrustedProxiesExplicitWins(t *testing.T) {
	got, source := trustedProxies(envFrom(map[string]string{
		"PICOAI_TRUSTED_PROXIES": "172.20.0.1, 10.0.0.7 ,, ",
		"CADDY_IP":               "172.30.0.2",
	}))
	if source != "env:PICOAI_TRUSTED_PROXIES" {
		t.Fatalf("source = %q, want env:PICOAI_TRUSTED_PROXIES", source)
	}
	for _, want := range []string{"172.20.0.1", "10.0.0.7"} {
		if !containsStr(got, want) {
			t.Fatalf("显式配置的 %s 丢了：%v", want, got)
		}
	}
	if containsStr(got, "172.30.0.2") {
		t.Fatalf("显式配置时不该自动附加 CADDY_IP：%v", got)
	}
	// 空段不得变成空字符串项（SetTrustedProxies 会对空项报错 ⇒ 启动即 Fatal，
	// 而这是运维写多了一个逗号就会踩到的形态）。
	for _, p := range got {
		if strings.TrimSpace(p) == "" {
			t.Fatalf("可信代理列表里有空项：%v", got)
		}
	}
}

// TestTrustedProxiesLoopbackOnlyWhenNothingConfigured：两个都没配 ⇒ 只有环回
// （无 Caddy 的本地直连部署；与修前"env 为空"时的行为一致）。
func TestTrustedProxiesLoopbackOnlyWhenNothingConfigured(t *testing.T) {
	got, source := trustedProxies(envFrom(nil))
	if source != "loopback-only" {
		t.Fatalf("source = %q, want loopback-only", source)
	}
	if len(got) != 2 || !containsStr(got, "127.0.0.1") || !containsStr(got, "::1") {
		t.Fatalf("列表 = %v, want [127.0.0.1 ::1]", got)
	}
}

// TestTrustedProxyMismatchWarns：显式值与 CADDY_IP 不一致时必须吵一声
// （改网段只改了一个正是这个形态）；一致或任一为空时不得吵。
func TestTrustedProxyMismatchWarns(t *testing.T) {
	if w := trustedProxyMismatchWarning(envFrom(map[string]string{
		"PICOAI_TRUSTED_PROXIES": "172.20.0.1", "CADDY_IP": "172.30.0.2",
	})); w == "" {
		t.Fatal("显式值与 CADDY_IP 不一致时没有告警 —— 改网段漏改一个会静默失效")
	}
	for _, m := range []map[string]string{
		{"PICOAI_TRUSTED_PROXIES": "172.30.0.2", "CADDY_IP": "172.30.0.2"},
		{"PICOAI_TRUSTED_PROXIES": "172.30.0.2"},
		{"CADDY_IP": "172.30.0.2"},
		{},
	} {
		if w := trustedProxyMismatchWarning(envFrom(m)); w != "" {
			t.Fatalf("不该告警的形态 %v 却告警了：%s", m, w)
		}
	}
	// 多值显式列表里含 CADDY_IP ⇒ 一致（不算漂移）。
	if w := trustedProxyMismatchWarning(envFrom(map[string]string{
		"PICOAI_TRUSTED_PROXIES": "172.20.0.1,172.30.0.2", "CADDY_IP": "172.30.0.2",
	})); w != "" {
		t.Fatalf("显式列表已包含 CADDY_IP，不该告警：%s", w)
	}
}

// TestComposeTrustedProxiesShareCaddyIPDefault 是编排级对拍：server 容器必须拿到
// CADDY_IP，且它与 caddy 容器的固定 IP 引用**同一个变量、同一份缺省**。
//
// 变异：把 server.environment 的 CADDY_IP 删掉 / 把 PICOAI_TRUSTED_PROXIES 的缺省
// 换回硬编码 IP ⇒ 本用例红。
func TestComposeTrustedProxiesShareCaddyIPDefault(t *testing.T) {
	env := composeServerEnvironment(t)

	// ① server 容器必须拿到 CADDY_IP（否则 trustedProxies 派生不出来，退回"只有环回"）。
	caddyIPValue, ok := env["CADDY_IP"]
	if !ok {
		t.Fatal("services.server.environment 里没有 CADDY_IP —— 服务端无法从 CADDY_IP 派生" +
			"可信代理，改网段后 XFF 静默失效（R15C-03）")
	}
	if caddyIPValue == "" || caddyIPValue == "<nil>" {
		t.Fatalf("CADDY_IP 的取值是 %q（必须写成 ${CADDY_IP:-172.28.0.2} 才能与 caddy 容器同源）", caddyIPValue)
	}

	// ② 与 caddy 容器的 ipv4_address 同源：两边引用的变量名与缺省都必须一致。
	caddyDefault := composeCaddyIPv4Address(t)
	if !strings.Contains(caddyIPValue, "${CADDY_IP") || !strings.Contains(caddyDefault, "${CADDY_IP") {
		t.Fatalf("两处引用必须都是 ${CADDY_IP:-…}：server.CADDY_IP=%q, caddy.ipv4_address=%q", caddyIPValue, caddyDefault)
	}
	if defaultOf(caddyIPValue) != defaultOf(caddyDefault) {
		t.Fatalf("两处缺省不一致：server.CADDY_IP=%q（缺省 %q）vs caddy.ipv4_address=%q（缺省 %q）"+
			"—— 缺省不同意味着只改 CADDY_IP 时其中一处会漂移",
			caddyIPValue, defaultOf(caddyIPValue), caddyDefault, defaultOf(caddyDefault))
	}
	// ③ 信任列表的缺省**不得**再是硬编码 IP（那正是本条的缺陷形态）：留空即派生。
	tp, ok := env["PICOAI_TRUSTED_PROXIES"]
	if !ok {
		t.Fatal("services.server.environment 里没有 PICOAI_TRUSTED_PROXIES")
	}
	if !strings.Contains(tp, "${PICOAI_TRUSTED_PROXIES") {
		t.Fatalf("PICOAI_TRUSTED_PROXIES 的取值是 %q —— 必须写成 ${PICOAI_TRUSTED_PROXIES:-}"+
			"（留空 = 从 CADDY_IP 派生），硬编码 IP 会让改网段部署静默失去 XFF", tp)
	}
	if def := defaultOf(tp); def != "" {
		t.Fatalf("PICOAI_TRUSTED_PROXIES 的缺省是 %q，want 空（空 = 派生自 CADDY_IP）", def)
	}
}

// TestMainDerivesTrustedProxiesFromSources 源码级：main() 必须真的走
// trustedProxies（而不是把那段逻辑留在原地或另写一遍）。
func TestMainDerivesTrustedProxiesFromSources(t *testing.T) {
	text := mainGoCodeOnly(t)
	if !strings.Contains(text, "trustedProxies(os.Getenv)") {
		t.Fatal("main() 没有调用 trustedProxies(os.Getenv) —— 派生逻辑没有接线（R15C-03 会复发）")
	}
	if !strings.Contains(text, "r.SetTrustedProxies(trusted)") {
		t.Fatal("main() 没有把解析结果交给 r.SetTrustedProxies")
	}
}

// composeCaddyIPv4Address 从 compose 里取 services.caddy.networks.ipv4_address 原文。
func composeCaddyIPv4Address(t *testing.T) string {
	t.Helper()
	doc := composeDoc(t)
	services, _ := doc["services"].(map[string]any)
	caddy, ok := services["caddy"].(map[string]any)
	if !ok {
		t.Fatalf("%s 里没有 services.caddy（判据锚点漂移）", composePath)
	}
	nets, ok := caddy["networks"].(map[string]any)
	if !ok {
		t.Fatalf("%s 的 services.caddy.networks 不是映射（判据锚点漂移）", composePath)
	}
	net, ok := nets["picoaide-net"].(map[string]any)
	if !ok {
		t.Fatalf("%s 的 services.caddy.networks.picoaide-net 不是映射（判据锚点漂移）", composePath)
	}
	ip, _ := net["ipv4_address"].(string)
	if ip == "" {
		t.Fatalf("%s 的 services.caddy.networks.picoaide-net.ipv4_address 为空（判据锚点漂移）", composePath)
	}
	return ip
}

// defaultOf 从 compose 插值表达式 `${VAR:-default}` 里取出 default（无该形态时返回原文）。
func defaultOf(expr string) string {
	expr = strings.TrimSpace(expr)
	if strings.HasPrefix(expr, "${") && strings.HasSuffix(expr, "}") {
		inner := expr[2 : len(expr)-1]
		if i := strings.Index(inner, ":-"); i >= 0 {
			return inner[i+2:]
		}
		return ""
	}
	return expr
}
