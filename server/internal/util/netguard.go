// Package util — 出站地址安全护栏(F10,审计 2026-09-11)。
//
// 网关上游(provider base_url)、模型同步与余额查询都会由服务端携带凭据
// 发起 HTTP 请求。管理员可控地址 + 运行期 DNS 变化时必须拦截云 metadata /
// 链路本地目标,同时**允许私网**(企业内网自建 LLM 网关是产品主要场景)。
//
// 保存时的静态校验无法覆盖 DNS rebinding(保存时公网、请求时解析到
// 169.254.169.254),因此所有出站 client 统一安装本文件的 Dial 复检。
package util

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strings"
	"time"
)

// blockedOutboundIPv4 已知云 metadata 的 IPv4 地址。
var blockedOutboundIPv4 = []string{"169.254.169.254", "169.254.170.2", "100.100.100.200"}

// blockedOutboundHosts 已知 metadata 主机名(解析后仍走 IP 检查,双保险)。
var blockedOutboundHosts = map[string]bool{
	"metadata": true, "metadata.google.internal": true, "metadata.goog": true,
	"instance-data": true, "metadata.azure.com": true,
}

// IsBlockedOutboundHost 报告主机名是否属于已知 metadata 服务。
func IsBlockedOutboundHost(host string) bool {
	return blockedOutboundHosts[strings.ToLower(strings.TrimSpace(host))]
}

// IsBlockedOutboundIP 报告一个解析结果是否属于链路本地/云 metadata/未指定地址。
// 环回与私网**不**在此列(内网上游允许;由调用方按场景另行限制)。
func IsBlockedOutboundIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() {
		return true
	}
	for _, s := range blockedOutboundIPv4 {
		if m := net.ParseIP(s); m != nil && m.Equal(ip) {
			return true
		}
	}
	// AWS IPv6 实例元数据前缀 fd00:ec2::/64。
	if ip.To16() != nil && ip.To4() == nil {
		if _, cidr, err := net.ParseCIDR("fd00:ec2::/64"); err == nil && cidr.Contains(ip) {
			return true
		}
	}
	return false
}

// SafeOutboundDialContext 在连接阶段复检解析出的每个候选 IP,拦截
// 链路本地/云 metadata(DNS rebinding 防护)。
func SafeOutboundDialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	var lastErr error
	for _, ipa := range ips {
		if IsBlockedOutboundIP(ipa.IP) {
			lastErr = errors.New("outbound address is link-local/metadata and blocked")
			continue
		}
		d := &net.Dialer{Timeout: 30 * time.Second}
		conn, derr := d.DialContext(ctx, network, net.JoinHostPort(ipa.IP.String(), port))
		if derr == nil {
			return conn, nil
		}
		lastErr = derr
	}
	if lastErr == nil {
		lastErr = errors.New("outbound host has no usable address")
	}
	return nil, lastErr
}

// SafeOutboundTransport 返回安装了 Dial 复检的 http.Transport(克隆标准库
// 默认参数:代理从环境读取、连接池、TLS 超时等)。
func SafeOutboundTransport() *http.Transport {
	base, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		base = &http.Transport{}
	}
	t := base.Clone()
	t.DialContext = SafeOutboundDialContext
	return t
}
