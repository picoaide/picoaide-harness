package main

// 认证面装配的两个接缝（R21C-02，审计 2026-09-26，P2）。
//
// ## 缺陷形态
//
// 这两行此前只存在于 `main()` 的函数体里，而 `main()` **不在任何用例的执行路径
// 上**（测试走 `buildRouter` / 各自装配）⇒ 整行删掉后 `go test ./cmd/server/`
// 仍绿（审计实测 7 行装配逐条落盘变异全部 `exit=0`）。其中这一行的后果最重：
//
//	for _, b := range authCfg.Browsers { auth.RegisterBrowser(b) }
//
// 删掉它 ⇒ 启动期 `API.browsers` **恒空**（`NewConfiguredAPI` 只把 providers 放进
// `ConfiguredAPI.Browsers`，**不**自己注册到 API 上）⇒ `/api/client/v2/auth/
// {oidc,openid}/login|callback` 恒 404 `NOT_FOUND`「该登录方式未配置或已禁用」
// （全组织 SSO 不可用），而且**只有**管理员进 webadmin 保存一次认证配置
// （触发 `ReloadAuth` → `ReloadProviders` 重建 browsers）才恢复。
//
// 另一行（`ReloadAuth`）删掉 ⇒ 保存认证配置不再热重建 provider
// （`admin.go` 的 `if a.ReloadAuth != nil` 静默跳过）⇒「启用 OIDC/LDAP 立即生效」
// 这条承诺要重启才成立。
//
// ## 收口方式（与 schedulers.go / background_sync.go 同款）
//
//  1. 装配收进**具名函数**（本文件），`main()` 只调用它们 ⇒ 判据可以只调用这两个
//     函数就复刻生产装配，不必执行 `main()`；
//  2. 源码级判据（`main_assembly_ast_test.go`）断言 `main()` **真的无条件调用**了
//     它们 —— 而且是 AST 级"可达性"判定，不再是 `strings.Index` 存在性判定
//     （后者挡不住"挪进 `if false { … }`"，R21C-04）。

import (
	"github.com/picoaide/picoaide/internal/serverauth"
)

// assembleAuthAPI 把 `ConfigureProviders` 解析出来的 browser provider 注册进 API ——
// **唯一实现**：`main()` 与判据共用，不得在别处再写一遍注册循环。
//
// 顺序无关（`RegisterBrowser` 按 Name 落 map），但**必须**在 `Handlers()` 被调用之
// 前完成：`Handlers()` 会按当时的 browsers 快照生成 OIDC 路由
// （`router.Register` 在启动期调用一次），这也是"漏了这一步 ⇒ SSO 恒 404"的机理。
func assembleAuthAPI(cfg *serverauth.ConfiguredAPI) *serverauth.API {
	if cfg == nil {
		return nil
	}
	for _, b := range cfg.Browsers {
		cfg.API.RegisterBrowser(b)
	}
	return cfg.API
}

// wireAuthReload 把"保存认证配置后热重建 provider 集合"接到管理端 API。
//
// 接的必须是**同一个** `*serverauth.API` 实例（路由树里的 handler 闭包持有它），
// 否则重建出来的 provider 集合与请求路径看到的那份不是同一个 —— 表面"配置保存
// 成功"，实际登录方式没变。
func wireAuthReload(admin *serverauth.AdminAPI, api *serverauth.API) {
	if admin == nil || api == nil {
		return
	}
	db := admin.DB
	admin.ReloadAuth = func() error { return api.ReloadProviders(db) }
}
