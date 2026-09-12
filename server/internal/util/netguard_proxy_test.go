package util

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// FIX-09(审计 2026-09-12,P1):出站护栏在配置 HTTP(S)_PROXY 的部署里完全空转。
//
// 缺陷形态:SafeOutboundTransport 只设了 DialContext,而**走代理时
// net/http 用 DialContext 去连代理**,目标地址仅出现在请求行(HTTP 形态)或
// CONNECT 目标(HTTPS 形态)里 —— DialContext 里的安全复检永远看不到它。
// 审计实测:HTTP 形态代理收到
// `GET http://169.254.169.254/latest/meta-data/iam/security-credentials/`
// 并回 200;HTTPS 形态代理收到 `CONNECT 169.254.169.254:443`。
//
// 本文件用**真 Transport + 假代理**(真 TCP 监听,自己解析请求行/CONNECT)
// 复现两种形态:修复前假代理会收到 metadata 目标,修复后本地就拦下,假代理
// 一个字节都收不到。
//
// ⚠️ 三个必须避开的"假绿"陷阱:
//  1. 不能用 httptest.NewServer 当黑洞 —— 这里必须能看见**代理实际收到什么**,
//     所以自己 accept + 读请求行。
//  2. `http.ProxyFromEnvironment` 用 sync.Once **把环境变量缓存到进程级**,
//     第一个用例设的值会固化。如果每个用例各起一个假代理(不同端口),后续
//     用例就会去连已关闭的旧地址 → 请求失败 → `requests == 0` 恒成立 →
//     测试**空过**。因此整个测试二进制共用一个假代理(sharedProxy),
//     env 永远指向它,并在每个用例开头 reset 计数;proxyEnvForTest 还会
//     显式断言 ProxyFromEnvironment 选中的就是它。
//  3. 还需要一条**空过哨兵**(TestOutboundGuardProxyStillUsedForAllowedTarget):
//     证明放行的目标真的会把请求送到这个假代理 —— 没有它,上面所有
//     `requests == 0` 都可能只是因为"根本没走代理"而恒真。

type fakeProxy struct {
	ln       net.Listener
	mu       sync.Mutex
	got      []string
	requests atomic.Int64
}

var (
	sharedProxyOnce sync.Once
	sharedProxyVal  *fakeProxy
	sharedProxyErr  error
)

// sharedProxy 返回进程内唯一的假代理(见文件头第 2 条)。
func sharedProxy(t *testing.T) *fakeProxy {
	t.Helper()
	sharedProxyOnce.Do(func() {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			sharedProxyErr = err
			return
		}
		p := &fakeProxy{ln: ln}
		go p.serve()
		sharedProxyVal = p
	})
	if sharedProxyErr != nil {
		t.Fatalf("fake proxy: %v", sharedProxyErr)
	}
	return sharedProxyVal
}

func (p *fakeProxy) serve() {
	for {
		c, err := p.ln.Accept()
		if err != nil {
			return
		}
		go func(c net.Conn) {
			defer c.Close()
			_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
			br := bufio.NewReader(c)
			line, err := br.ReadString('\n')
			if err != nil && line == "" {
				return
			}
			p.mu.Lock()
			p.got = append(p.got, strings.TrimSpace(line))
			p.mu.Unlock()
			p.requests.Add(1)
			// 回一个最简 200,让客户端认为请求成功(与审计里的
			// `200 "metadata-stolen"` 等价)。
			io.WriteString(c, "HTTP/1.1 200 OK\r\nContent-Length: 15\r\nContent-Type: text/plain\r\n\r\nmetadata-stolen")
		}(c)
	}
}

func (p *fakeProxy) url() string { return "http://" + p.ln.Addr().String() }

// reset 清空计数,让每个用例从零开始(共用代理的代价)。
func (p *fakeProxy) reset() {
	p.mu.Lock()
	p.got = nil
	p.mu.Unlock()
	p.requests.Store(0)
}

func (p *fakeProxy) lines() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.got...)
}

// proxyEnvForTest 把代理环境指向共用假代理,并**验证** net/http 最终选中的
// 确实是它 —— 否则后面的断言会空过。
func proxyEnvForTest(t *testing.T) *fakeProxy {
	t.Helper()
	p := sharedProxy(t)
	p.reset()
	u := p.url()
	for _, k := range []string{"HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"} {
		t.Setenv(k, u)
	}
	t.Setenv("NO_PROXY", "")
	t.Setenv("no_proxy", "")

	req, _ := http.NewRequest("GET", "http://169.254.169.254/x", nil)
	got, err := http.ProxyFromEnvironment(req)
	if err != nil || got == nil || got.Host != p.ln.Addr().String() {
		t.Fatalf("ProxyFromEnvironment = %v (err=%v), want %s —— 环境缓存已指向别处,断言会空过",
			got, err, p.ln.Addr().String())
	}
	return p
}

// TestOutboundGuardHTTPProxyBypass 复现 HTTP 形态:目标 http://169.254.169.254/。
func TestOutboundGuardHTTPProxyBypass(t *testing.T) {
	p := proxyEnvForTest(t)

	tr := SafeOutboundTransport()
	if tr.Proxy == nil {
		t.Fatal("SafeOutboundTransport 必须设置 Proxy 包装(否则代理路径无复检)")
	}
	client := &http.Client{Timeout: 5 * time.Second, Transport: tr}

	resp, err := client.Get("http://169.254.169.254/latest/meta-data/iam/security-credentials/")
	if err == nil {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Fatalf("metadata 目标必须被拦,实际 status=%d body=%q", resp.StatusCode, body)
	}
	if !strings.Contains(err.Error(), "link-local/metadata") {
		t.Fatalf("err = %v, want link-local/metadata 拦截错误", err)
	}
	if n := p.requests.Load(); n != 0 {
		t.Fatalf("假代理收到了 %d 个请求(=%v),want 0 —— 护栏在代理路径上仍在空转",
			n, p.lines())
	}
}

// TestOutboundGuardHTTPSProxyBypass 复现 HTTPS 形态:目标 https://169.254.169.254/
// (走代理时表现为 CONNECT 169.254.169.254:443)。
func TestOutboundGuardHTTPSProxyBypass(t *testing.T) {
	p := proxyEnvForTest(t)

	client := &http.Client{Timeout: 5 * time.Second, Transport: SafeOutboundTransport()}
	resp, err := client.Get("https://169.254.169.254/latest/meta-data/")
	if err == nil {
		resp.Body.Close()
		t.Fatalf("metadata 目标必须被拦,实际 status=%d", resp.StatusCode)
	}
	if n := p.requests.Load(); n != 0 {
		t.Fatalf("假代理收到了 %d 个请求(=%v),want 0", n, p.lines())
	}
	for _, l := range p.lines() {
		if strings.Contains(l, "169.254.169.254") {
			t.Fatalf("代理收到了 metadata CONNECT: %q", l)
		}
	}
}

// TestOutboundGuardBlocksMetadataHostname 覆盖主机名与其它 metadata 地址形态。
func TestOutboundGuardBlocksMetadataHostname(t *testing.T) {
	p := proxyEnvForTest(t)

	client := &http.Client{Timeout: 5 * time.Second, Transport: SafeOutboundTransport()}
	for _, target := range []string{
		"http://metadata.google.internal/computeMetadata/v1/",
		"http://169.254.170.2/v2/credentials",
		"http://100.100.100.200/latest/meta-data/",
	} {
		if _, err := client.Get(target); err == nil {
			t.Errorf("%s 必须被拦", target)
		}
	}
	if n := p.requests.Load(); n != 0 {
		t.Fatalf("假代理收到 %d 个请求(=%v),want 0", n, p.lines())
	}
}

// TestOutboundGuardProxyStillUsedForAllowedTarget 是**空过哨兵**:证明这条
// 测试通路里代理是**真的**被使用的 —— 一个被放行的目标必须真的把请求送到
// 假代理。没有这一条,上面那些 `requests == 0` 的断言可能只是因为"根本没走
// 代理"而恒真。
func TestOutboundGuardProxyStillUsedForAllowedTarget(t *testing.T) {
	p := proxyEnvForTest(t)

	client := &http.Client{Timeout: 5 * time.Second, Transport: SafeOutboundTransport()}
	// 8.8.8.8 是公网 IP(放行),假代理会立刻回 200,不需要真出网。
	resp, err := client.Get("http://8.8.8.8/probe")
	if err != nil {
		t.Fatalf("放行的目标应当走代理成功: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "metadata-stolen" {
		t.Fatalf("响应体 = %q, want 来自假代理的响应(说明确实走了代理)", body)
	}
	if n := p.requests.Load(); n != 1 {
		t.Fatalf("假代理收到 %d 个请求, want 1(代理通路未生效)", n)
	}
	if l := p.lines(); len(l) != 1 || !strings.Contains(l[0], "8.8.8.8") {
		t.Fatalf("代理收到的请求行 = %v, want 含 8.8.8.8", l)
	}
}

// TestOutboundGuardAllowsLegitimateTargets 是防误伤:CheckOutboundTarget 的
// 判定必须放行公网 / 私网 / 环回(内网上游是产品主场景),只拦 metadata 段。
func TestOutboundGuardAllowsLegitimateTargets(t *testing.T) {
	ctx := context.Background()
	for _, host := range []string{
		"8.8.8.8",      // 公网
		"10.1.2.3",     // 私网上游(产品主场景)
		"127.0.0.1",    // 环回(内网自建)
		"192.168.1.10", // 私网
		"172.16.5.5",   // 私网
	} {
		if err := CheckOutboundTarget(ctx, host); err != nil {
			t.Errorf("CheckOutboundTarget(%q) = %v, want nil(误伤)", host, err)
		}
	}
	for _, host := range []string{
		"169.254.169.254", "169.254.170.2", "100.100.100.200",
		"metadata.google.internal", "metadata", "fd00:ec2::254", "",
	} {
		if err := CheckOutboundTarget(ctx, host); err == nil {
			t.Errorf("CheckOutboundTarget(%q) = nil, want 拦截", host)
		}
	}
}

// TestSafeOutboundTransportStillChecksDirectPath 是防回归:直连路径
// (DialContext)的安全检查不能被这次修复换掉。
func TestSafeOutboundTransportStillChecksDirectPath(t *testing.T) {
	if _, err := SafeOutboundDialContext(context.Background(), "tcp", "169.254.169.254:80"); err == nil {
		t.Fatal("SafeOutboundDialContext 必须拦截 metadata 地址")
	}
	// 环回应放行(内网自建上游场景)。
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "ok")
	}))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	conn, err := SafeOutboundDialContext(context.Background(), "tcp", u.Host)
	if err != nil {
		t.Fatalf("环回目标被误伤: %v", err)
	}
	conn.Close()
}
