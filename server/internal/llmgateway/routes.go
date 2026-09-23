package llmgateway

import (
	"database/sql"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
)

// routeMirrorClients 返回包内测试镜像要用的两个出站 client。
//
// 存在的意义 = 让"镜像与生产同源"这条不变量**可被断言**(而不是只写在注释里):
// 判据 routes_transport_test.go 直接把它的 transport 与生产 newUpstreamTransport()
// 的 guard 钩子对拍(Proxy 必须是 util.SafeOutboundProxyFromEnvironment、
// DialContext 必须非 nil、ResponseHeaderTimeout 必须同值),并有一条源码级接线守卫
// 防止 RegisterRoutes 又自己新建裸 transport(R4-C-7)。
func routeMirrorClients() (client, sse *http.Client) {
	return upstreamHTTPClient(), upstreamHTTPClient()
}

// RegisterRoutes mounts the DeepSeek-compatible gateway endpoints behind
// bearer-token auth. Production routes are declared centrally by
// internal/router (registerGatewayV1); this helper keeps the full endpoint
// set for in-package tests (llmgateway cannot import router due to cycle).
func RegisterRoutes(r *gin.Engine, db *sql.DB) {
	mirrorClient, mirrorSSE := routeMirrorClients()
	a := &API{
		DB: db,
		// R4-C-7(审计 2026-09-23,P3):镜像的出站 client 必须与生产装配**同源**
		// (routeMirrorClients → upstreamHTTPClient → newUpstreamTransport)。此前这里
		// 自建裸 transport(只有 ResponseHeaderTimeout),**不带 netguard** —— 经由本
		// 镜像跑的用例对"出站被拦住"的行为因此与生产不等价(安全面差异)。
		client: mirrorClient,
		// streaming client: headers (first byte) must arrive within the same
		// window as the non-stream client, but the body streams unbounded.
		sse:  mirrorSSE,
		rl:   newRateLimiter(),
		conc: newConcurrencyMeter(),
	}
	// OpenAI/Anthropic 兼容形态(/v1/*)。
	v1 := r.Group("/v1", serverauth.BearerAuth(db), InFlightGuard())
	v1.POST("/chat/completions", a.handleChatCompletions)
	v1.POST("/embeddings", a.handleEmbeddings)
	v1.POST("/messages", a.handleMessages)
	v1.POST("/completions", a.handleCompletions)
	v1.POST("/responses", a.handleResponses)
	v1.GET("/models", a.handleModels)
	// Files API(2026-09-22):与生产树(internal/router.registerGatewayV1)逐条对齐。
	v1.POST("/files", a.handleFilesUpload)
	v1.GET("/files", a.handleFilesList)
	v1.GET("/files/:file_id", a.handleFilesRetrieve)
	v1.DELETE("/files/:file_id", a.handleFilesDelete)
	// 官方原生形态(无 /v1 前缀)。
	gw := r.Group("", serverauth.BearerAuth(db), InFlightGuard())
	gw.POST("/chat/completions", a.handleChatCompletions)
	gw.POST("/embeddings", a.handleEmbeddings)
	gw.POST("/completions", a.handleCompletions)
	gw.POST("/responses", a.handleResponses)
	gw.GET("/models", a.handleModels)
	gw.POST("/messages", a.handleMessages)
	gw.POST("/files", a.handleFilesUpload)
	gw.GET("/files", a.handleFilesList)
	gw.GET("/files/:file_id", a.handleFilesRetrieve)
	gw.DELETE("/files/:file_id", a.handleFilesDelete)
}
