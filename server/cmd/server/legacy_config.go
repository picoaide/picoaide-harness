package main

// 已废除配置的**启动期提示**（R15C-R-03，审计 2026-09-25，P2）。
//
// 设计承诺（明文）：`docs/planning/2026-09-19-wasm-client-only-design.md` §12 ——
// 「`.env`/`settings` 里残留的 `PICOAI_APPS_BASE_DOMAIN`/`wasm.apps_base_domain`
// 现在**静默失效**，**启动要 warn 并给清理命令**」；`docs/deploy/AI-DEPLOY.md`
// 的"存量部署清理"节把这两条列成升级必做项，并写着「启动期会打一条 warn 提醒」。
//
// 实测（修复前）：三条废除项（两条 env + 一条 settings 键）**同时存在**时，37 行启动
// 日志里相关关键词命中 **0** 次，服务照常启动。这正是"改了配置但没生效的静默降级"：
// 老部署按旧文档配了通配 DNS/证书/反代通配块与限流键，升级后这些取值不再被读取，
// 而运维看到的是"配置还在 `.env` 里、服务启动正常"。同一轮审计已把另外两条 env
// （未知内存档位 / 非法 `PICOAI_TRUSTED_PROXIES`）改成 fail-loud，这里补上同一口径的
// 第三个成员 —— 区别只是这三条**不阻断启动**（配置本身无害，只是无效），但必须
// 每次都吵。
//
// 两条工程纪律：
//  1. **不打印取值**：这些键里可能含对外主机名/网段，提示只需要键名（公开仓的日志
//     面纪律与 `.env` 取值不进版本库同源）；
//  2. **"读不到" ≠ "没设置"**：settings 读取失败（库不可用/表缺失/权限）时
//     必须打一条**不同的** error 行说明"本次检查没跑成"，绝不能静默当作"没有残留"
//     —— 否则守卫本身会变成假绿来源（这正是 R15C-R-03 要修的形态）。

import (
	"database/sql"
	"log"
	"os"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// legacyConfigEntry 登记一条已废除的配置项。
//
// EnvKey / SettingKey 二选一（env 变量与 settings 键各占一条，便于日志逐条点名）；
// Replacement 写"现在该用什么"，Doc 指向唯一的权威文档，Cleanup 是**可直接复制执行**
// 的清理命令（设计承诺里的"给清理命令"）。
type legacyConfigEntry struct {
	// EnvKey 是已废除的环境变量名（空 = 本条不是 env）。
	EnvKey string
	// SettingKey 是已废除的 settings 键（空 = 本条不是 settings）。
	SettingKey string
	// Why 是一句话说明"什么时候废除的、为什么不生效"。
	Why string
	// Replacement 是替代项（没有替代项时写明"无替代项"）。
	Replacement string
	// Doc 是权威文档路径（唯一的"在哪份文档"口径）。
	Doc string
	// Cleanup 是可直接执行的清理命令。
	Cleanup string
}

// legacyConfigEntries 是已废除配置的**登记表**（新增废除项时在这里加一行即可，
// 检测与日志渲染都按这张表走，不允许在别处再写一份键名清单）。
var legacyConfigEntries = []legacyConfigEntry{
	{
		EnvKey:      "PICOAI_APPS_BASE_DOMAIN",
		Why:         "WASM 应用平台改为「客户端专属」后，对外应用子域与换票 Cookie 一并下线（2026-09-19 设计总纲 §12）",
		Replacement: "无替代项；保留的是 PICOAI_APPS_EXTRA_RESERVED（应用名保留字）",
		Doc:         "docs/planning/2026-09-19-wasm-client-only-design.md §12 / docs/deploy/AI-DEPLOY.md 存量部署清理",
		Cleanup:     "sed -i '/^PICOAI_APPS_BASE_DOMAIN=/d' .env",
	},
	{
		SettingKey:  "wasm.apps_base_domain",
		Why:         "同上：控制台「应用基域」设置项已随 W4 删除波次下线，行留在库里不生效",
		Replacement: "无替代项（该值已不被任何代码读取）",
		Doc:         "docs/planning/2026-09-19-wasm-client-only-design.md §12 / docs/deploy/AI-DEPLOY.md 存量部署清理",
		Cleanup:     `psql "$PG_DSN" -c "DELETE FROM settings WHERE key='wasm.apps_base_domain'"`,
	},
	{
		EnvKey:      "PICOAI_TRUSTED_PROXIES_EXPLICIT",
		Why:         "匿名限流键不再需要该开关；可信代理只由 PICOAI_TRUSTED_PROXIES 声明（2026-09-19 设计总纲 §12）",
		Replacement: "PICOAI_TRUSTED_PROXIES（客户端 IP 归属，继续有效）",
		Doc:         "docs/planning/2026-09-19-wasm-client-only-design.md §12 / docs/deploy/AI-DEPLOY.md 存量部署清理",
		Cleanup:     "sed -i '/^PICOAI_TRUSTED_PROXIES_EXPLICIT=/d' .env",
	},
}

// legacyConfigEnvPresent 判定 env 键是否存在（**用 LookupEnv**：显式设为空串也算残留，
// `os.Getenv` 会把"设为空"和"没设置"混为一谈 —— 那正是本条要避免的"读不到当没设置"）。
// 抽成变量只为让测试能构造"env 不可读"以外的形态；生产恒为 os.LookupEnv。
var legacyConfigEnvPresent = os.LookupEnv

// legacyConfigSettingReader 读 settings 键，返回 (值, 是否存在, 错误)。
// 生产恒为 serverstore.GetSetting；抽成变量便于测试注入读取失败（"读不到"路径）。
var legacyConfigSettingReader = serverstore.GetSetting

// warnLegacyConfig 在启动期检测已废除配置并逐条打印可检索告警（不阻断启动）。
//
// 返回命中的条目数（判据用）；读取失败不返回命中，但会打一条 **error 行**说明
// "本次检查未完成"，绝不静默。
func warnLegacyConfig(db *sql.DB) int {
	hits := 0
	for _, e := range legacyConfigEntries {
		switch {
		case e.EnvKey != "":
			if _, ok := legacyConfigEnvPresent(e.EnvKey); ok {
				hits++
				log.Printf("WARNING: deprecated configuration still set: env %s is no longer read (removed: %s). "+
					"Replacement: %s. Docs: %s. Cleanup: %s",
					e.EnvKey, e.Why, e.Replacement, e.Doc, e.Cleanup)
			}
		case e.SettingKey != "":
			if db == nil {
				// 没有库句柄（测试路由树/无 DB 启动）：与读取失败同口径，明确说"没查"。
				log.Printf("WARNING: deprecated configuration check skipped: no database handle "+
					"(settings key %s NOT verified)", e.SettingKey)
				continue
			}
			_, ok, err := legacyConfigSettingReader(db, e.SettingKey)
			if err != nil {
				// **读不到 ≠ 没设置**：单独一条 error 行，点名"哪些键没被验证"。
				log.Printf("ERROR: deprecated configuration check could not read settings key %s: %v "+
					"(the key was NOT verified — this is not the same as 'not set')", e.SettingKey, err)
				continue
			}
			if ok {
				hits++
				log.Printf("WARNING: deprecated configuration still set: settings key %s is no longer read (removed: %s). "+
					"Replacement: %s. Docs: %s. Cleanup: %s",
					e.SettingKey, e.Why, e.Replacement, e.Doc, e.Cleanup)
			}
		}
	}
	return hits
}
