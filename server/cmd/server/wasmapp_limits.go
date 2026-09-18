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
	value, source := h.profileLimits(), "profile"
	if db != nil {
		raw, ok, err := serverstore.GetSetting(db, SettingWasmLimits)
		switch {
		case err != nil:
			log.Printf("wasm: 读平台限制项设置失败（回落部署档位 %s）：%v", profile.Name, err)
		case ok && strings.TrimSpace(raw) != "":
			if l, aerr := applimits.Parse(raw); aerr != nil {
				// 坏设置**不阻塞启动**（与"设置读不出来"同一条降级路径），但必须点名。
				log.Printf("wasm: ⚠️ 已保存的平台限制项不合法，已回落到部署档位 %s：%v", profile.Name, aerr)
			} else if b := l.Budget(readMemAvailable()); !b.OK {
				// 保存时是合法的，但**后来**机器变忙/内存变小 ⇒ 现在超水位。
				//
				// 这里刻意**不让服务端起不来**：保存路径已经 fail-loud（改的时候就被拒），
				// 而"存进去之后环境变了"如果也拒绝启动，运维会被一条设置锁死在启动失败上
				// ——那时连控制台都进不去，只能改库。因此回落档位 + 大声记日志。
				log.Printf("wasm: ⚠️ 已保存的平台限制项当前超出内存水位（total=%dMiB > limit=%dMiB，可用 %dMiB），"+
					"本次启动回落到部署档位 %s；请调小并发/实例内存/模块缓存后重新保存",
					b.Total>>20, b.Limit>>20, b.Available>>20, profile.Name)
			} else {
				value, source = l, "setting"
			}
		case ok:
			// 显式清空 ⇒ 回落档位（保留运维在 .env 里的部署档位语义）。
			value, source = h.profileLimits(), "profile"
		}
	}
	h.set(value, source, nil)
	return h
}

// profileLimits 返回部署档位折算的限制项；档位未显式设置时给编译期默认。
func (h *wasmLimitsHolder) profileLimits() applimits.Limits {
	if h.profileExplicit || h.profile.Name != "" && h.profile.Name != "default" {
		return applimits.FromProfile(h.profile)
	}
	return applimits.Defaults()
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

// Plan 把当前限制项折算成启动自检用的四笔账计划。
func (h *wasmLimitsHolder) Plan() readyz.MemoryPlan {
	l := h.Get()
	return readyz.MemoryPlan{
		Profile:             "limits/" + h.Source(),
		Instances:           l.MaxInstances,
		InstanceMemoryBytes: int64(l.InstanceMemoryMB) << 20,
		ModuleCacheBytes:    int64(l.ModuleCacheMB) << 20,
	}
}

// Preview 返回四笔账预览（控制台展示；availableBytes ≤ 0 ⇒ 只算不判定）。
func (h *wasmLimitsHolder) Preview(availableBytes int64) readyz.MemoryBudget {
	return h.Get().Budget(availableBytes)
}

// Apply 保存并生效：校验 → 四笔账 → 落库 → 下发。
//
// raw 为空表示"清空设置、回到部署档位/默认"。返回需要重启才生效的字段名。
func (h *wasmLimitsHolder) Apply(raw string) ([]string, *apperr.Error) {
	next := applimits.Limits{}
	if strings.TrimSpace(raw) == "" {
		next = h.profileLimits()
	} else {
		parsed, aerr := applimits.Parse(raw)
		if aerr != nil {
			return nil, aerr
		}
		next = parsed
	}
	// 保存路径复用启动自检的判据（fail-loud：不给"先跑起来再说"的口子）。
	budget := next.Budget(readMemAvailable())
	if !budget.OK {
		return nil, apperr.New(apperr.CodeValidation, "这组限制项的理论内存峰值超过可用内存的安全水位").
			WithDetail("total_bytes", budget.Total).
			WithDetail("limit_bytes", budget.Limit).
			WithDetail("available_bytes", budget.Available).
			WithDetail("guard_percent", limits.MemoryPeakGuardPercent).
			WithHint("§4.3 四笔账 = 并发 × 单实例上限 + 编译峰值 + 上传峰值 + 模块缓存驻留；" +
				"调小全局并发、单实例内存上限或模块缓存上限，或扩容机器内存")
	}
	if h.db != nil {
		if err := serverstore.SetSetting(h.db, SettingWasmLimits, next.Encode()); err != nil {
			return nil, apperr.New(apperr.CodeInternal, "保存平台限制项失败").
				WithDetail("reason", err.Error()).
				WithHint("数据库写入失败；重试一次，仍失败请查看服务端日志")
		}
	}
	var restart []string
	if h.apply != nil {
		restart = h.apply(next)
	}
	h.set(next, "setting", restart)
	log.Printf("wasm: 平台限制项已更新（来源=控制台）%s", next.Encode())
	return restart, nil
}
