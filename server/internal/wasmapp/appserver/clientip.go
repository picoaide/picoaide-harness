package appserver

import (
	"net"
	"net/http"
	"net/netip"
	"strings"
)

// clientIP 解析匿名限流用的客户端地址（§4.6「匿名限流」+ R35）。
//
// # 为什么不能直接用 RemoteAddr，也不能直接信 X-Forwarded-For
//
// 平台生产部署前面一定有反向代理（Caddy）。两个方向都会出事：
//
//   - **只信 RemoteAddr**：所有匿名流量都来自代理那一个地址 ⇒ 每 IP 桶（默认 60 次/分）
//     变成"全组织共用一个桶"，一次爬虫就能让所有匿名应用 429（本仓已有同族事故：
//     OIDC 回调限流用 RemoteAddr 桶，反代下 60 次失败回调即让全员 SSO 429）；
//   - **无条件信 XFF**：任何客户端都能自带 `X-Forwarded-For: 1.2.3.4` 伪造来源，
//     每 IP 限流形同虚设（只剩 3000 次/分的全局桶兜底）。
//
// 因此按**信任边界**解析：只有 TCP 对端本身是可信代理时，才采信它转发的 XFF，
// 并从右往左跳过可信代理，取第一个不可信地址作为客户端。可信代理来自
// `PICOAI_TRUSTED_PROXIES`（与 anonlimit 的启动自检同一个变量名常量；缺省为空=只信
// TCP 对端，这是 fail-closed 的方向：限流只会更严，不会更松）。
func clientIP(r *http.Request, trusted []netip.Prefix) string {
	if r == nil {
		return ""
	}
	remote := hostOnly(r.RemoteAddr)
	remoteAddr, remoteOK := parseAddr(remote)
	if !remoteOK {
		// 对端地址解析不出来（unix socket、测试里的假地址…）：不做 XFF 采信。
		return remote
	}
	if !addrInAny(remoteAddr, trusted) {
		return remoteAddr.String()
	}
	// 对端是可信代理：XFF 是"客户端, 代理1, 代理2"（最左=最原始）。
	for i := len(r.Header.Values("X-Forwarded-For")) - 1; i >= 0; i-- {
		// 多个 XFF 头按 HTTP 语义等价于一个逗号分隔列表；从右往左处理。
		parts := strings.Split(r.Header.Values("X-Forwarded-For")[i], ",")
		for j := len(parts) - 1; j >= 0; j-- {
			addr, ok := parseAddr(strings.TrimSpace(parts[j]))
			if !ok {
				// 出现无法解析的项 ⇒ 链不可信，停在已确认的最后一跳。
				return remoteAddr.String()
			}
			if addrInAny(addr, trusted) {
				continue
			}
			return addr.String()
		}
	}
	// 全是可信代理（或没有 XFF）：用 TCP 对端。
	return remoteAddr.String()
}

// hostOnly 去掉地址里的端口（保留 IPv6 字面量语义）。
func hostOnly(addr string) string {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return ""
	}
	if host, _, err := net.SplitHostPort(addr); err == nil {
		return host
	}
	return strings.Trim(addr, "[]")
}

// parseAddr 解析 IP（容忍 IPv6 的方括号与 zone）。
func parseAddr(s string) (netip.Addr, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return netip.Addr{}, false
	}
	if i := strings.IndexByte(s, '%'); i >= 0 { // fe80::1%eth0
		s = s[:i]
	}
	addr, err := netip.ParseAddr(strings.Trim(s, "[]"))
	if err != nil {
		return netip.Addr{}, false
	}
	return addr.Unmap(), true
}

// addrInAny 判定地址是否落在任一可信前缀内（4-in-6 已归一化）。
func addrInAny(addr netip.Addr, prefixes []netip.Prefix) bool {
	if !addr.IsValid() {
		return false
	}
	for _, p := range prefixes {
		if p.Contains(addr) {
			return true
		}
	}
	return false
}
