package main

import (
	"database/sql"
	"log"
	"os"
	"strings"
	"sync/atomic"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/applimits"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/memprofile"
	"github.com/picoaide/picoaide/internal/wasmapp/readyz"
)

// 本文件是「平台限制项」的运行期持有者（2026-09-19 用户要求：并发应用数量与应用
// 内存占用等要能在后台配置）。
//
// 解析优先级（与 baseDomainHolder 同一套纪律）：
//
//		控制台保存的设置（wasm.limits）> 部署档位（PICOAI_WASM_MEMORY_PROFILE）> 编译期默认
//
//	  - 读路径：Get 走原子指针（每请求/每次渲染都要读，必须无锁）；
//	  - 写路径：只有控制台（Apply），落库 + 下发运行中组件；
//	  - 保存判据与启动自检**同一份**：四笔账（并发×单实例上限 + 编译峰值 + 上传峰值 +
//	    模块缓存驻留）不许超过可用内存的 70% —— 否则"先在控制台把并发拉到 64"就能
//	    绕过启动自检，这正是审计里反复出现的那类"护栏只在启动时有效"的漏洞。
const SettingWasmLimits = "wasm.limits"

// wasmLimitsHolder 持有当前生效的限制项。
type wasmLimitsHolder struct {
	db      *sql.DB
	profile memprofile.Profile
	// applied 记录部署档位是否来自显式环境变量（决定"清空设置"回到哪里）。
	profileExplicit bool

	// apply 是下发钩子（appserver 构造后注入）；nil ⇒ 只改设置不碰运行态。
	apply func(applimits.Limits) []string

	value   atomic.Pointer[applimits.Limits]
	source  atomic.Pointer[string]
	restart atomic.Pointer[[]string]
}

// newWasmLimitsHolder 解析初始值：设置 > 档位 > 默认。读设置失败不算致命
// （回落档位 + 大声记日志）—— 限制项读不出来不该让整个服务端起不来。
func newWasmLimitsHolder(db *sql.DB, profile memprofile.Profile) *wasmLimitsHolder {
	h := &wasmLimitsHolder{
		db:              db,
		profile:         profile,
		profileExplicit: strings.TrimSpace(os.Getenv(memprofile.EnvMemoryProfile)) != "",
	}
	value, source := h.profileLimits(), h.profileSource()
	if db != nil {
		raw, ok, err := serverstore.GetSetting(db, SettingWasmLimits)
		switch {
		case err != nil:
			log.Printf("wasm: 读平台限制项设置失败（回落部署档位 %s）：%v", profile.Name, err)
		case ok && strings.TrimSpace(raw) != "":
			// 读取用 ParseStored（前向兼容：缺字段补默认、未知字段忽略）——
			// 严格 Parse 只服务控制台 PUT。理由见 applimits.ParseStored 的注释：
			// 用严格模式读旧设置会让"升级 = 管理员已保存的整份设置被判非法并回落档位"。
			if l, aerr := applimits.ParseStored(raw); aerr != nil {
				// 坏设置**不阻塞启动**（与"设置读不出来"同一条降级路径），但必须点名。
				log.Printf("wasm: ⚠️ 已保存的平台限制项不合法，已回落到部署档位 %s：%v", profile.Name, aerr)
			} else if b := l.Budget(readMemoryAvailability().BudgetBytes()); !b.OK {
				// 保存时是合法的，但**后来**机器变忙/内存变小 ⇒ 现在超水位。
				//
				// 这里刻意**不让服务端起不来**：保存路径已经 fail-loud（改的时候就被拒），
				// 而"存进去之后环境变了"如果也拒绝启动，运维会被一条设置锁死在启动失败上
				// ——那时连控制台都进不去，只能改库。因此回落档位 + 大声记日志。
				log.Printf("wasm: ⚠️ 已保存的平台限制项当前超出内存水位（total=%dMiB > limit=%dMiB，可用 %dMiB），"+
					"本次启动回落到部署档位 %s；请调小并发/实例内存/模块缓存/页缓存后重新保存",
					b.Total>>20, b.Limit>>20, b.Available>>20, profile.Name)
			} else {
				value, source = l, "setting"
			}
		case ok:
			// 显式清空（控制台 `{"limits":null}` 真的删了行）⇒ 回落部署档位
			// （保留运维在 .env 里的部署档位语义）。
			value, source = h.profileLimits(), h.profileSource()
		}
	}
	h.set(value, source, nil)
	return h
}

// profileLimits 返回部署档位折算的限制项；档位未显式设置时给编译期默认。
func (h *wasmLimitsHolder) profileLimits() applimits.Limits {
	if h.profileConfigured() {
		return applimits.FromProfile(h.profile)
	}
	return applimits.Defaults()
}

// profileConfigured 表示"部署侧真的配了档位"（而不是回落编译期默认）。
func (h *wasmLimitsHolder) profileConfigured() bool {
	return h.profileExplicit || (h.profile.Name != "" && h.profile.Name != "default")
}

// profileSource 返回"档位路径"下当前值的来源标识：
//
//	"profile" —— 部署侧显式配置了 PICOAI_WASM_MEMORY_PROFILE（值真的来自档位）；
//	"default" —— 未配置（值是编译期默认）。
//
// 为什么要与 Value 一起区分（AUD-2，2026-09-20）：控制台的 `source`/`source_label`
// 是运维判断"我改的档位到底生效没有"的唯一入口。清空设置之后如果仍报 "profile"
// 而实际上用的是编译期默认，标签会把"没配档位"说成"档位生效"——两种都不是 setting，
// 但排查方向完全不同。`limitsSourceLabel("default", …)` 已经会渲染成「编译期默认」。
func (h *wasmLimitsHolder) profileSource() string {
	if h.profileConfigured() {
		return "profile"
	}
	return "default"
}

// set 原子写入（value/source/restart 成对更新）。
func (h *wasmLimitsHolder) set(value applimits.Limits, source string, restart []string) {
	v, s, r := value, source, append([]string(nil), restart...)
	h.value.Store(&v)
	h.source.Store(&s)
	h.restart.Store(&r)
}

// Get 返回当前生效的限制项（无锁）。
func (h *wasmLimitsHolder) Get() applimits.Limits {
	if p := h.value.Load(); p != nil {
		return *p
	}
	return applimits.Defaults()
}

// Source 返回当前值来源（"setting" / "profile"）。
func (h *wasmLimitsHolder) Source() string {
	if p := h.source.Load(); p != nil {
		return *p
	}
	return "default"
}

// RestartPending 返回最近一次保存后**仍待重启生效**的字段。
func (h *wasmLimitsHolder) RestartPending() []string {
	if p := h.restart.Load(); p != nil {
		return *p
	}
	return nil
}

// SetApplier 注入下发钩子（appserver 构造完成后调用一次）。
func (h *wasmLimitsHolder) SetApplier(fn func(applimits.Limits) []string) { h.apply = fn }

// ProfileLabel 返回"当前这些数值来自哪里"的可读标签。
//
// 形态：`limits/setting`（控制台保存）/ `limits/profile:small`（部署档位）/
// `limits/profile:default`（未显式配置档位 = 编译期默认）。
// 为什么不止回 Source()：Source 只说"设置还是档位"，而**哪个档位**才是排查时真正
// 要看的（同一台机器上 small 与 large 的四笔账差一倍）。启动自检日志、控制台的四笔账
// 预览共用这一个标签，避免两处口径分叉。
func (h *wasmLimitsHolder) ProfileLabel() string {
	if h.Source() == "setting" {
		return "limits/setting"
	}
	return "limits/profile:" + h.profile.Name
}

// ProfileName 返回部署档位名（memprofile.Name；"default" = 未显式配置）。
func (h *wasmLimitsHolder) ProfileName() string { return h.profile.Name }

// ApplyStartup 把**装配期**的下发结果回写进持有者（restart = 仍需重启才生效的字段）。
//
// 为什么必须有它（P0-2）：装配期 `appSrv.ApplyLimits(...)` 的返回值原先只打了一行
// 日志，持有者里的 restart_pending 仍是 nil ⇒ 重启之后界面显示"无需重启"，而实际
// 生效值与设置值可能仍然不一致（旧实现里 instance_memory_mb 永远不一致）。
// 回写之后，"重启后仍不一致"这种状态会如实显示出来，而不是被静默抹平。
// 值/来源不变，只更新 restart（三者的原子对更新仍是 set 的职责）。
func (h *wasmLimitsHolder) ApplyStartup(restart []string) {
	h.set(h.Get(), h.Source(), restart)
}

// Plan 把当前限制项折算成启动自检用的四笔账计划。
//
// 三个输入对应四笔账里"随限制项变化"的部分：实例池 = Instances × InstanceMemoryBytes，
// 缓存驻留 = ModuleCacheBytes（编译峰值与上传峰值是常量，见 readyz.MemoryPlan）。
//
// ⚠️ app_db_readers / appdb_cache_kib **现在也在这笔账里**（R1-rt-8，2026-09-19）：
// 这两个字段决定"每应用库句柄页缓存"的单价，而句柄数 ≤ max_instances ⇒ 这一笔
// = 单价 × Instances，与实例池那笔账同一个乘数。此前它不在账里，控制台可以把组合
// 配到 272 GiB（17 条连接 × 64 MiB × 256 句柄）而保存判据一字不变。
func (h *wasmLimitsHolder) Plan() readyz.MemoryPlan {
	l := h.Get()
	return readyz.MemoryPlan{
		Profile:                      h.ProfileLabel(),
		Instances:                    l.MaxInstances,
		InstanceMemoryBytes:          int64(l.InstanceMemoryMB) << 20,
		ModuleCacheBytes:             int64(l.ModuleCacheMB) << 20,
		AppDBPageCachePerHandleBytes: l.AppDBPageCachePerHandleBytes(),
	}
}

// Preview 返回四笔账预览（控制台展示；availableBytes ≤ 0 ⇒ 只算不判定）。
func (h *wasmLimitsHolder) Preview(availableBytes int64) readyz.MemoryBudget {
	return h.Get().BudgetFor(availableBytes, h.ProfileLabel())
}

// Apply 保存并生效：校验 → 四笔账 → 落库 → 下发。
//
// raw 为空表示"清空设置、回到部署档位/默认"：这条路径**真的删掉 `settings.wasm.limits`
// 行**（AUD-2，2026-09-20）。
//
// 为什么"删行"而不是"把档位值写回设置"（旧实现，是审计判定的"承诺不成立"）：
// 写回之后库里的行仍在、`source` 仍报 `setting`、label 仍显示「控制台保存」——
// 运维**事实上无法回落档位**：此后即使改 `PICOAI_WASM_MEMORY_PROFILE` 也会被那条
// 钉死的设置覆盖，而界面上看不出任何异常。删行之后 `source`/`source_label` 如实回到
// 部署档位（或编译期默认），下一次启动按同一条优先级重新解析。
//
// 返回需要重启才生效的字段名。
func (h *wasmLimitsHolder) Apply(raw string) ([]string, *apperr.Error) {
	clearing := strings.TrimSpace(raw) == ""
	next := applimits.Limits{}
	// 保存路径复用启动自检的判据（fail-loud：不给"先跑起来再说"的口子）。
	// 来源标签按**本次保存之后**的归属取：raw 为空 = 回到档位/默认。
	label, source := "limits/setting", "setting"
	if clearing {
		next, source = h.profileLimits(), h.profileSource()
		label = "limits/profile:" + h.profile.Name
	} else {
		parsed, aerr := applimits.Parse(raw)
		if aerr != nil {
			return nil, aerr
		}
		next = parsed
	}
	avail := readMemoryAvailability()
	if !avail.Known() {
		// 读不到可用内存 ⇒ 只算不判（与启动自检同一条降级路径），但**必须留痕**：
		// 否则控制台会看到"保存成功"而不知道这次没有过水位判定。
		log.Printf("wasm: ⚠️ 未取到可用内存（来源=%s：%s），本次保存跳过四笔账水位判定", avail.Source, avail.Detail)
	}
	budget := next.BudgetFor(avail.BudgetBytes(), label)
	if !budget.OK {
		return nil, apperr.New(apperr.CodeValidation, "这组限制项的理论内存峰值超过可用内存的安全水位").
			WithDetail("total_bytes", budget.Total).
			WithDetail("appdb_cache_bytes", budget.AppDBCache).
			WithDetail("limit_bytes", budget.Limit).
			WithDetail("available_bytes", budget.Available).
			WithDetail("guard_percent", limits.MemoryPeakGuardPercent).
			WithHint("§4.3 的内存账 = 并发 × 单实例上限 + 编译峰值 + 上传峰值 + 模块缓存驻留 + " +
				"应用库页缓存（(1 + app_db_readers) × appdb_cache_kib × max_instances）；" +
				"调小全局并发、单实例内存上限、模块缓存上限或 appdb_cache_kib，或扩容机器内存")
	}
	if h.db != nil {
		var werr error
		if clearing {
			// 真删行（键不存在不算错：重复清空是幂等的）。
			if _, werr = serverstore.DeleteSetting(h.db, SettingWasmLimits); werr == nil {
				log.Printf("wasm: 平台限制项设置已清空（删除 settings.%s 行）", SettingWasmLimits)
			}
		} else {
			werr = serverstore.SetSetting(h.db, SettingWasmLimits, next.Encode())
		}
		if werr != nil {
			return nil, apperr.New(apperr.CodeInternal, "保存平台限制项失败").
				WithDetail("reason", werr.Error()).
				WithHint("数据库写入失败；重试一次，仍失败请查看服务端日志")
		}
	}
	var restart []string
	if h.apply != nil {
		restart = h.apply(next)
	}
	h.set(next, source, restart)
	if clearing {
		log.Printf("wasm: 平台限制项已回落到部署档位（来源=%s）%s", source, next.Encode())
	} else {
		log.Printf("wasm: 平台限制项已更新（来源=控制台）%s", next.Encode())
	}
	return restart, nil
}
