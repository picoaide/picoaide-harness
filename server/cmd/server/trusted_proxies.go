package main

// 可信反向代理列表的解析（审计 2026-08-25 F-02；R15C-03，审计 2026-09-25，
// **复核仍开的旧项**）。
//
// 为什么需要它：gin 的 `ClientIP()` 只在"TCP 对端 ∈ SetTrustedProxies"时才采信
// `X-Forwarded-For`。修前 compose 的 `services.caddy.networks.ipv4_address` 是
// **可配**的（`${CADDY_IP:-172.28.0.2}`，NETWORK_SUBNET 冲突时运维会一起改），
// 而 `services.server.environment.PICOAI_TRUSTED_PROXIES` 的缺省**硬编码**
// 同一个字面量 172.28.0.2 ⇒ 改网段部署后服务端不认 Caddy 的地址、
// XFF 被忽略，`ClientIP()` 退化成代理 IP：登录 / MFA 第二步 / OIDC 回调的
// 限流桶全部坍缩成"全组织共桶"（60 次失败登录即可锁死全员登录，5 分钟自我锁死），
// 且**完全静默** —— 没有日志、没有指标、服务照常 200。
//
// 修法（两条一起，缺一条就复发）：
//  1. **缺省从 CADDY_IP 派生**：compose 把同一个 `${CADDY_IP:-172.28.0.2}` 也传进
//     server 容器，这里在未显式配置 PICOAI_TRUSTED_PROXIES 时用它 ⇒ 网段与信任
//     列表不可能漂移（判据：trusted_proxies_test.go 的 compose 对拍）；
//  2. 显式配置仍然优先（共享 Caddy/nginx 部署要指向别的地址，例如 docker 网桥
//     网关 172.20.0.1），但当显式值**不包含** CADDY_IP 时启动期打一行 WARNING ——
//     那正是"改了网段却忘了一起改"的形态，让它不再静默。

import (
	"fmt"
	"strings"
)

// loopbackProxies 是恒被信任的本机地址（宿主探针 / 本机 nginx / systemd 直连）。
var loopbackProxies = []string{"127.0.0.1", "::1"}

// trustedProxies 返回 gin 的可信代理列表与来源标签（日志用）。
//
// 顺序（唯一真源，判据 trusted_proxies_test.go）：
//  1. 恒含环回；
//  2. `PICOAI_TRUSTED_PROXIES` 非空 ⇒ 以它为准（逗号分隔；空段忽略）；
//  3. 未显式配置 ⇒ 从 `CADDY_IP` 派生（compose 里前端 Caddy 的固定 IP 是同一个
//     变量的同一份取值）；
//  4. 两个都没有 ⇒ 只有环回（无 Caddy 的本地直连部署）。
func trustedProxies(getenv func(string) string) (proxies []string, source string) {
	proxies = append(proxies, loopbackProxies...)
	if v := strings.TrimSpace(getenv("PICOAI_TRUSTED_PROXIES")); v != "" {
		return append(proxies, splitHostList(v)...), "env:PICOAI_TRUSTED_PROXIES"
	}
	if v := strings.TrimSpace(getenv("CADDY_IP")); v != "" {
		return append(proxies, splitHostList(v)...), "derived:CADDY_IP"
	}
	return proxies, "loopback-only"
}

// splitHostList 按逗号切分并丢弃空段（"172.28.0.2, ,10.0.0.1" ⇒ 两项）。
func splitHostList(v string) []string {
	out := make([]string, 0, 2)
	for _, p := range strings.Split(v, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// trustedProxyMismatchWarning 在"显式配置了 PICOAI_TRUSTED_PROXIES，但它不包含
// CADDY_IP"时返回一行告警（空串 = 无需告警）。
//
// 为什么是 WARNING 而不是 Fatal：共享反代部署（宿主机自己的 Caddy/nginx 连过来）
// 下显式指向别的地址是**正确配置**，fail-loud 会把合法部署打红。但那条路径也正是
// "改了 CADDY_IP 忘了改这里"的样子，所以必须吵一声：XFF 失效是静默的。
func trustedProxyMismatchWarning(getenv func(string) string) string {
	explicit := strings.TrimSpace(getenv("PICOAI_TRUSTED_PROXIES"))
	caddyIP := strings.TrimSpace(getenv("CADDY_IP"))
	if explicit == "" || caddyIP == "" {
		return ""
	}
	for _, p := range splitHostList(explicit) {
		if p == caddyIP {
			return ""
		}
	}
	return fmt.Sprintf("PICOAI_TRUSTED_PROXIES=%q 里没有 CADDY_IP=%q —— 若这不是"+
		"「宿主机另有反代」的有意配置，说明改网段时两者只改了一个：服务端会忽略 "+
		"X-Forwarded-For，登录/MFA/OIDC 限流桶将坍缩成代理 IP（全组织共桶，60 次"+
		"失败登录即锁死全员登录）", explicit, caddyIP)
}
