package main

// `/readyz` 的**保留策略可观测字段**（R8-A-3，审计 2026-09-24，P2）。
//
// 缺陷形态：多级布局下的深层后代月分区**永不回收**（R7-A 的取舍），而这件事此前
// 只有一行日志 —— `/readyz` 零命中、没有任何 metric、管理端只显示
// "retention_months 已配置"。于是"保留策略在这个月其实没生效"与"一切正常"在
// 运维面上逐字同形。
//
// 形态选择（为什么是"装配层包一层"而不是改 `internal/wasmapp/readyz`）：
//  1. `readyz.Snapshot` 的每个字段都有它的纪律（取值必须来自运行时自己、阻塞理由
//     必须进 `publishBlockers` 登记表）；保留策略不是发布闸门的维度，不该混进
//     那张表，也不该为它新增一条 reason；
//  2. readyz 包属于**别的泳道**（本次修复的改动面被限定在 serverstore /
//     usageretention / cmd/server），在装配层包一层既能加字段，又不改它的契约与
//     登记表；路由表也不变（`/readyz` 仍在 directRouteAllowList 里，见
//     route_declaration_guard_test.go）；
//  3. 读数来自 **serverstore 自己记的账**（`CurrentUsageRetentionStatus`，与
//     `AuditWriteStats`/`AuditChainStatus` 同形：子系统记账、装配层只读、不推断）。
//
// 兼容性：只在响应体里**增加**一个对象字段 `usage_retention`；解析不了就原样透传
// （探针的既有契约优先于新增字段），状态码与所有既有响应头逐字保留。
//
// # 字段与消费口径（R10-G3 · N3 / R10-H3：给运维脚本/告警规则的可读契约）
//
// `usage_retention` 就是 `serverstore.UsageRetentionStatus` 的 JSON（字段名与语义见
// `serverstore/usage_retention_status.go` 的结构体注释）。运维面最要紧的四组：
//
//	"调度器还活着吗"     rounds / failed_rounds / last_round_at / last_error
//	"这一轮为什么没回收"  skipped / skipped_by_reason / unreclaimed
//	"保留策略还在推进吗"  deferred_stalled（**唯一需要进告警规则的那一位**）
//	                      + stalled_relations（点名）/ deferred_streak（逐关系连续轮数）
//	                      + deferred_stalled_rounds（累计停摆**轮数**，不回退）
//	                      + oldest_unreclaimed_month / _reason / _since / _rounds
//	"哪个月写不进去"      write_blocked_*（当月）+ write_blocked_other_months（非当月）
//	                      + write_error_* / write_error_other_months（未分类瞬时失败）
//
// 为什么"延后"需要单独一面（复审 N3）：`failed_rounds` 表达的是"有没有报错"，而按
// R10-A-03 的契约**锁竞争/语句超时不算失败**（它们让管理端保存保留期回 500 是已修
// 的缺陷）。于是"连续 N 轮都因为超时没回收任何东西"（= 保留策略已经停摆、磁盘按
// 经过的月份单调增长）在 failed_rounds 上**看不见**，而 skipped_by_reason 每轮被
// 覆写、也答不了"连续几轮"。这一面就是那个缺口。
//
// 示例（每 6h 轮询一次即可，调度间隔就是 6h）：
//
//	curl -fsS $SERVER/readyz | jq -e '.usage_retention.deferred_stalled != true' \
//	  || alert "保留策略停摆：$(curl -fsS $SERVER/readyz | jq -c '.usage_retention.stalled_relations')"
//	# 想知道"停摆**轮数**"（同一次停摆持续 N 轮就计 N —— 它不是"发生了几次"这个
//	# 事件计数；即使当前这一轮已经自愈，它也不会回退）：
//	curl -fsS $SERVER/readyz | jq -r '.usage_retention.deferred_stalled_rounds // 0'
//	# "长期没回收"的权威判据（它**单调**：早退轮/无证据轮/失败轮都不动它）：
//	curl -fsS $SERVER/readyz | jq -c '{month:.usage_retention.oldest_unreclaimed_month,
//	  since:.usage_retention.oldest_unreclaimed_since, rounds:.usage_retention.oldest_unreclaimed_rounds,
//	  reason:.usage_retention.oldest_unreclaimed_reason}'
//	# 别的月份（到期月的 [DETACH,DROP] 窗口是唯一能撞上布局阻塞的地方）写不进去：
//	curl -fsS $SERVER/readyz | jq -c '.usage_retention.write_blocked_other_months // []'
//
// 四个语义边界（避免误报/漏报）：
//   - deferred_stalled=true 表示**至少一条**到期关系连续 ≥5 个**调度轮次**（6h/轮
//     ≈30h）既没被回收、也没有真失败。管理端保存保留期会**同步**多跑一轮
//     （llmgateway/admin.go），那些即时轮次**不计入** streak（否则连点几次保存就是
//     一次分钟级假告警）；它会在该关系被回收后的下一轮自动回落 false。
//   - deferred_stalled_rounds 是**累计轮数**（不是"事件次数"），不随回落清零 ——
//     用它做趋势/复盘；
//   - oldest_unreclaimed_month 是"最早那个既没回收也没失败的到期月"（含**真失败**
//     的月）：告警规则只看 deferred_stalled 会被"超时/失败交替"或"改保留期"绕过，
//     这一位不会（它只在那个月真的被回收后前移/清空）；
//   - write_blocked（当月面）的语义与告警口径**不因** write_blocked_other_months
//     改变：前者是"当月每一次对话 503"（处置=分区 DDL），后者是"某个到期月/迟到
//     写入落不了账"（处置同源，但影响面是补写而不是当前对话）。
//   - failed_rounds 不得用来替代上面任何一位：超时按契约不进失败面（见上）。
//
// 键序与结尾换行：本文件**不**重新序列化整个响应体（只在最后一个 `}` 前插入一个
// 成员），所以内层的键序（声明序）与结尾 `\n` 逐字保留；新增字段只出现在
// `usage_retention` **对象内部**，对既有消费者是纯增量的。

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// usageRetentionField 是新增字段名（响应体与测试共用同一份字面量）。
const usageRetentionField = "usage_retention"

// usageRetentionReadyzHandler 把保留清理的过程事实并入 /readyz 响应。
func usageRetentionReadyzHandler(inner http.Handler) http.Handler {
	if inner == nil {
		// 生产装配在 registerProductionRoutes 首段就对 nil Ready panic；这里只做
		// 防御（返回 nil 会让 gin.WrapH 在注册期就崩，比运行期 500 好）。
		return nil
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := &readyzRecorder{header: http.Header{}}
		inner.ServeHTTP(rec, r)
		body := rec.body.Bytes()
		out := body
		if merged, ok := mergeUsageRetentionField(body, serverstore.CurrentUsageRetentionStatus()); ok {
			out = merged
		}
		for name, values := range rec.header {
			for _, v := range values {
				w.Header().Add(name, v)
			}
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(out)))
		w.WriteHeader(rec.statusCode())
		_, _ = w.Write(out)
	})
}

// readyzRecorder 是**只缓冲**的 ResponseWriter（不落真实连接）：/readyz 的响应体
// 很小（单行 JSON），缓冲它换来"能加字段"这件事。
type readyzRecorder struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (r *readyzRecorder) Header() http.Header { return r.header }

func (r *readyzRecorder) WriteHeader(code int) {
	if r.status == 0 {
		r.status = code
	}
}

func (r *readyzRecorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	return r.body.Write(b)
}

// statusCode 返回内层写出的状态码（未显式写 = 200）。
func (r *readyzRecorder) statusCode() int {
	if r.status == 0 {
		return http.StatusOK
	}
	return r.status
}

// mergeUsageRetentionField 把 usage_retention 并入 readyz 的 JSON 对象。
//
// 返回 ok=false 表示**不能合并**（响应体不是 JSON 对象 / 序列化失败）——调用方
// 原样透传：探针的既有契约优先于新增字段，绝不因为加字段而让探针变成坏响应。
//
// R9-D R9D-09（P3）：实现从"map 往返 + 重新 Marshal"改成**在原文里插入一个成员**，
// 因为 map 往返有两个可观察的副作用（都改变了对外的**字节形态**）：
//
//   - 键序从生产内层的**声明序**变成**字典序**（探针/运维脚本按字节对比时全是噪音）；
//   - 生产内层由 `json.NewEncoder(w).Encode` 产出，**结尾带一个 \n**，往返后丢失。
//
// 现在：只在最后一个 `}` 之前插入 `,"usage_retention":<raw>`，其余字节（含尾随空白
// 与换行）逐字保留。仍然先做一次对象合法性检查 —— 不是 JSON 对象就原样透传。
func mergeUsageRetentionField(body []byte, st serverstore.UsageRetentionStatus) ([]byte, bool) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(body, &obj); err != nil || obj == nil {
		return nil, false
	}
	raw, err := json.Marshal(st)
	if err != nil {
		return nil, false
	}
	end := -1
	for i := len(body) - 1; i >= 0; i-- {
		switch body[i] {
		case ' ', '\t', '\r', '\n':
			continue
		case '}':
			end = i
		}
		break
	}
	if end < 0 {
		return nil, false
	}
	open := -1
	for i := 0; i < end; i++ {
		switch body[i] {
		case ' ', '\t', '\r', '\n':
			continue
		case '{':
			open = i
		}
		break
	}
	if open < 0 {
		return nil, false
	}
	sep := ","
	if strings.TrimSpace(string(body[open+1:end])) == "" {
		sep = "" // 空对象：不要多一个逗号
	}
	// 容量提示只取 `len(body)`：结果至少与原文一样长，且**不做长度相加** ——
	// `make([]byte, 0, len(a)+len(b)+c)` 会被 CodeQL 的 go/allocation-size-overflow
	// 判为未检查的整数相加（第九轮 PR 上真实报出 alert #114）。这里多出来的
	// 部分（分隔符 + 字段名 + raw）由 append 自己增长，代价可忽略（探针响应几百字节）。
	out := make([]byte, 0, len(body))
	out = append(out, body[:end]...)
	out = append(out, sep...)
	out = append(out, '"')
	out = append(out, usageRetentionField...)
	out = append(out, '"', ':')
	out = append(out, raw...)
	out = append(out, body[end:]...)
	return out, true
}
