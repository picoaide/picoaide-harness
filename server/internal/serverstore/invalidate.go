package serverstore

// 缓存失效回调机制(包依赖方向:llmgateway 依赖 serverstore,
// serverstore 无法直接 import llmgateway 的 InvalidateUpstreams)。
//
// 使用:llmgateway 包在初始化时注册回调(如 main.go 或包 init),
// serverstore 的模型/上游写路径(DeleteGatewayProvider/SyncProviderModels/
// DeleteModel 等)提交后调用 InvalidateModelsChanged() 触发。
//
// 未注册时为 no-op(不阻塞任何调用方)。

var modelsChangedHooks []func()

// RegisterModelsChangedHook 注册"模型/上游已变更"回调(幂等:同名只注册一次
// 由调用方保证;允许多个监听者)。
func RegisterModelsChangedHook(fn func()) {
	modelsChangedHooks = append(modelsChangedHooks, fn)
}

// InvalidateModelsChanged 通知模型/上游配置已变更(webadmin 或同步循环写入后)。
func InvalidateModelsChanged() {
	for _, fn := range modelsChangedHooks {
		fn()
	}
}
