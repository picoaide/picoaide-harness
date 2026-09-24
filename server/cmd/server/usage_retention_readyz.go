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
	out := make([]byte, 0, len(body)+len(raw)+len(usageRetentionField)+4)
	out = append(out, body[:end]...)
	out = append(out, sep...)
	out = append(out, '"')
	out = append(out, usageRetentionField...)
	out = append(out, '"', ':')
	out = append(out, raw...)
	out = append(out, body[end:]...)
	return out, true
}
