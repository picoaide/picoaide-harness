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
	"fmt"
	"net"
	"net/http"
	"net/url"
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

// SafeOutboundTransport 返回安装了目标复检的 http.Transport(克隆标准库
// 默认参数:代理从环境读取、连接池、TLS 超时等)。
//
// FIX-09(审计 2026-09-12,P1):此前只设了 DialContext,而**配了
// HTTP(S)_PROXY 的部署里 DialContext 拿到的是代理的地址**,复检因此对真正
// 要访问的目标完全空转 —— 代理会照常收到
// `GET http://169.254.169.254/latest/meta-data/...`(HTTP 形态)或
// `CONNECT 169.254.169.254:443`(HTTPS 形态),审计实测双向都绕过。
//
// 修法:t.Proxy 换成代理感知包装,在选择代理**之前**先复检真正要访问的
// 目标主机;没有代理时行为与修复前完全一致(由 DialContext 复检)。
func SafeOutboundTransport() *http.Transport {
	base, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		base = &http.Transport{}
	}
	t := base.Clone()
	t.DialContext = SafeOutboundDialContext
	t.Proxy = SafeOutboundProxyFromEnvironment
	return t
}

// SafeOutboundProxyFromEnvironment 是 http.ProxyFromEnvironment 的代理感知
// 包装。
//
// 为什么必须在**这一层**做:一旦请求走代理,net/http 只会用 DialContext 去连
// **代理**,目标地址仅出现在请求行(HTTP)或 CONNECT 目标(HTTPS)里 ——
// DialContext 里的安全检查永远看不到它。所以代理路径上的目标复检只能发生在
// 这里:http.Transport 在决定使用代理时会调用本函数,拿到 *http.Request,
// 目标主机就在 req.URL 里。
//
// 代理**自身**的地址不在这里拦:netguard 的既定策略是允许私网(企业内网上游
// 是产品主场景),而 SafeOutboundDialContext 仍会对代理地址施加同一套链路
// 本地/metadata 复检 —— 运维若把代理指向 169.254.169.254,连接阶段照样被拒。
func SafeOutboundProxyFromEnvironment(req *http.Request) (*url.URL, error) {
	proxyURL, err := http.ProxyFromEnvironment(req)
	if err != nil || proxyURL == nil {
		return proxyURL, err
	}
	if terr := CheckOutboundTarget(req.Context(), req.URL.Hostname()); terr != nil {
		return nil, terr
	}
	return proxyURL, nil
}

// CheckOutboundTarget 解析主机名并复检**每一个**候选 IP。
//
// 与 SafeOutboundDialContext 的差异是有意的:直连路径会逐个尝试候选 IP、
// 只跳过被拦的那些;代理路径上我们无法逐 IP 重试(代理只给一个地址),因此
// 只要任一候选落在链路本地/metadata 段就整体拒绝。对安全闸门而言
// fail-closed 才是正确方向(混合解析结果正是 DNS rebinding 的形态)。
func CheckOutboundTarget(ctx context.Context, host string) error {
	host = strings.TrimSpace(host)
	if host == "" {
		return errors.New("outbound host is empty")
	}
	if IsBlockedOutboundHost(host) {
		return fmt.Errorf("outbound host %q is a known metadata service and blocked", host)
	}
	if ip := net.ParseIP(host); ip != nil {
		if IsBlockedOutboundIP(ip) {
			return errors.New("outbound address is link-local/metadata and blocked")
		}
		return nil
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return err
	}
	for _, ipa := range ips {
		if IsBlockedOutboundIP(ipa.IP) {
			return errors.New("outbound address is link-local/metadata and blocked")
		}
	}
	return nil
}
