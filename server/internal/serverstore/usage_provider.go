package serverstore

import (
	"database/sql"
	"sort"
)

// ---------------------------------------------------------------------------
// Provider(渠道)维度用量归并(2026-09 用量中心重构)。
//
// usage 明细只按 model 记账(无 provider 列,成本按记录时模型定价折算),
// 归并口径 = 当前 models 表的 模型→provider 映射(近似:同名模型多 provider
// 时以 models 表首个 provider 归属——路由本身对同名多源是流量分发,历史
// 明细无法精确回指)。
// ---------------------------------------------------------------------------

// ModelProviderName 模型名 → provider 名(首个匹配)。
type ModelProviderName struct {
	Model    string
	Provider string
}

// ModelProviderMap 返回当前 模型名 → provider 名 映射(models 表)。
func ModelProviderMap(db *sql.DB) (map[string]string, error) {
	rows, err := db.Query(`SELECT m.name, COALESCE(p.name, '') FROM models m
		LEFT JOIN gateway_providers p ON p.id = m.provider_id ORDER BY m.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var m, p string
		if err := rows.Scan(&m, &p); err != nil {
			return nil, err
		}
		if _, seen := out[m]; !seen {
			out[m] = p
		}
	}
	return out, rows.Err()
}

// RegroupByProvider 把 group=model 的聚合行按 provider 归并。
// 未在 models 表登记的模型归入「未配置渠道」。
const UnassignedProvider = "(未配置渠道)"

func RegroupByProvider(rows []UsageAggregateRow, modelProvider map[string]string) []UsageAggregateRow {
	agg := map[string]*UsageAggregateRow{}
	for _, r := range rows {
		p := modelProvider[r.Label]
		if p == "" {
			p = UnassignedProvider
		}
		cur := agg[p]
		if cur == nil {
			cp := r
			cp.Label = p
			cur = &cp
			agg[p] = cur
		} else {
			cur.PromptTokens += r.PromptTokens
			cur.CompletionTokens += r.CompletionTokens
			cur.Requests += r.Requests
			cur.EmbedRequests += r.EmbedRequests
			cur.EmbedTokens += r.EmbedTokens
			cur.CacheTokens += r.CacheTokens
			cur.Cost += r.Cost
		}
	}
	out := make([]UsageAggregateRow, 0, len(agg))
	for _, r := range agg {
		out = append(out, *r)
	}
	// 费用降序(与模型 TOP 展示同序)
	sort.Slice(out, func(i, j int) bool { return out[i].Cost > out[j].Cost })
	return out
}
