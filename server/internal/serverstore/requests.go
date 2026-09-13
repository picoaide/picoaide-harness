package serverstore

import (
	"database/sql"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// 请求级用量明细(2026-09 用量中心重构):补上"只有聚合面、没有明细面"的缺口。
// 数据源 = usage 分区表(每请求一行)。
// ---------------------------------------------------------------------------

// UsageRequestRow 一条请求级调用记录(不含对话内容,只含计量字段)。
type UsageRequestRow struct {
	ID               int64   `json:"id"`
	Time             string  `json:"time"` // RFC3339
	UserID           int64   `json:"user_id"`
	Username         string  `json:"username"`
	Model            string  `json:"model"`
	Kind             string  `json:"kind"` // chat | completions | responses | embedding | search
	PromptTokens     int64   `json:"prompt_tokens"`
	CompletionTokens int64   `json:"completion_tokens"`
	CacheTokens      int64   `json:"cache_tokens"`
	Cost             float64 `json:"cost"`
	// Estimated(0063)= 该行至少有一侧 token 是服务端按字节估算的(上游没报
	// 用量时的兜底),不是上游上报值 —— 对账/排障必须能一眼区分(P2,审计 r5 §1)。
	Estimated bool `json:"estimated"`
}

// UsageRequestKind 请求类型白名单(空 = 全部)。
//
// kind 是**端点标识**(2026-09-13 P3,审计 r5 §1):chat=/v1/chat/completions、
// completions=/v1/completions(FIM)、responses=/v1/responses、search=/v1/messages
// (Anthropic 兼容 + web_search 服务端路径)、embedding=/v1/embeddings。此前
// completions/responses 都硬编码成 "chat",按端点对账时分不开。
var UsageRequestKind = map[string]bool{
	"chat":        true,
	"completions": true,
	"responses":   true,
	"embedding":   true,
	"search":      true,
}

// UsageKindPendingCleanup 是 CleanupPendingUsage 会清理的 kind 集合:只有**流式
// 请求**会插入 0-token pending 行(beginStreamUsage),中断残留需要启动期兜底
// 清理;embedding/非流式行是真实请求计数,不得被清理。
// 每次新增流式端点(如 completions/responses)必须同步加进来,否则残留行会
// 长期留在 usage 表里被当成 0 token 的请求计数。
var UsageKindPendingCleanup = []string{"chat", "completions", "responses", "search"}

// ListUsageRequests 分页返回请求级明细(按 id 倒序)。
// from/to 为闭开区间 [from, to);username/model/kind 为空 = 不过滤。
// 边界是北京日边界的**绝对瞬时**(显式 UTC 偏移),与 PG 会话时区/进程 TZ 无关
// (旧实现传裸墙钟字符串,会话时区为 UTC 时整窗口偏 8 小时)。
func ListUsageRequests(db *sql.DB, from, to time.Time, username, model, kind string, page, size int) ([]UsageRequestRow, int64, error) {
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 100 {
		size = 20
	}
	var where []string
	var args []any
	if !from.IsZero() {
		where = append(where, "u.created_at >= ?::timestamptz")
		args = append(args, dayStartArg(from))
	}
	if !to.IsZero() {
		where = append(where, "u.created_at < ?::timestamptz")
		args = append(args, dayStartArg(to))
	}
	if username != "" {
		where = append(where, "u.user_id = (SELECT id FROM users WHERE username = ?)")
		args = append(args, username)
	}
	if model != "" {
		where = append(where, "u.model = ?")
		args = append(args, model)
	}
	if kind != "" {
		where = append(where, "u.kind = ?")
		args = append(args, kind)
	}
	cond := ""
	if len(where) > 0 {
		cond = " WHERE " + strings.Join(where, " AND ")
	}

	var total int64
	if err := db.QueryRow(`SELECT COUNT(*) FROM usage u`+cond, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	qargs := make([]any, 0, len(args)+2)
	qargs = append(qargs, args...)
	qargs = append(qargs, size, (page-1)*size)
	rows, err := db.Query(`SELECT u.id, u.created_at, u.user_id, u.model, u.kind,
		u.prompt_tokens, u.completion_tokens, u.cache_prompt_tokens, u.cost, u.estimated,
		COALESCE(us.username, '')
		FROM usage u LEFT JOIN users us ON us.id = u.user_id`+cond+`
		ORDER BY u.id DESC LIMIT ? OFFSET ?`, qargs...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []UsageRequestRow{}
	for rows.Next() {
		var r UsageRequestRow
		if err := rows.Scan(&r.ID, &r.Time, &r.UserID, &r.Model, &r.Kind,
			&r.PromptTokens, &r.CompletionTokens, &r.CacheTokens, &r.Cost, &r.Estimated, &r.Username); err != nil {
			return nil, 0, err
		}
		out = append(out, r)
	}
	return out, total, rows.Err()
}
