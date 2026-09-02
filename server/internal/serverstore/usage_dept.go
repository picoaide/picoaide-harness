package serverstore

import (
	"database/sql"
	"sort"
	"strconv"
	"strings"
)

// ---------------------------------------------------------------------------
// 部门维度用量聚合(2026-09 用量中心重构, 设计 docs/decisions/2026-09-02-usage-center-redesign.md)
//
// 口径与部门预算 enforcement 完全一致:部门树内合计 = 成员归属祖先链全部计入,
// 同一用户对同一部门只计一次(去重)。「未归属任何部门的用量」不计入部门视图
// (总览/成员维度仍全额可见)。
// ---------------------------------------------------------------------------

// RegroupByDept 把 group=user 的聚合行按部门树归并为按部门行(树先序排序)。
// rows.Label 为用户名(或已删用户的 user_id 字符串)。
func RegroupByDept(db *sql.DB, rows []UsageAggregateRow) ([]UsageAggregateRow, error) {
	nodes, err := loadGroupTree(db)
	if err != nil {
		return nil, err
	}
	if len(nodes) == 0 {
		return nil, nil
	}
	// 用户(可能多部门) → 所属部门名集合(已祖先展开、去重)
	userDepts, err := userIDToDepts(db, nodes)
	if err != nil {
		return nil, err
	}
	// label → userID:用户名优先,否则按 user_id 字符串解析
	labelToUID := map[string]int64{}
	{ // 填充原用户名(仅对已归属部门用户必要)
		rowsRes, err := db.Query(`SELECT id, username FROM users`)
		if err != nil {
			return nil, err
		}
		defer rowsRes.Close()
		for rowsRes.Next() {
			var id int64
			var name string
			if err := rowsRes.Scan(&id, &name); err != nil {
				return nil, err
			}
			labelToUID[name] = id
		}
		if err := rowsRes.Err(); err != nil {
			return nil, err
		}
	}

	agg := map[string]*UsageAggregateRow{}
	for _, r := range rows {
		uid, ok := labelToUID[r.Label]
		if !ok {
			if n, err := strconv.ParseInt(r.Label, 10, 64); err == nil {
				uid, ok = n, true
			}
		}
		if !ok {
			continue // 未归属部门(或已删且无法解析)
		}
		for _, dept := range userDepts[uid] {
			cur := agg[dept]
			if cur == nil {
				cp := r
				cp.Label = dept // 首行作为种子,label 换成部门名
				cur = &cp
				agg[dept] = cur
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
	}
	out := make([]UsageAggregateRow, 0, len(agg))
	for _, r := range agg {
		out = append(out, *r)
	}
	// 树先序排序:父部门在前,子部门跟随(展示层级感)
	order := map[string]int{}
	for i, n := range preOrderNodes(nodes) {
		order[n.name] = i
	}
	sort.Slice(out, func(i, j int) bool {
		oi, oiOK := order[out[i].Label]
		oj, ojOK := order[out[j].Label]
		if !oiOK || !ojOK {
			return out[i].Label < out[j].Label
		}
		return oi < oj
	})
	return out, nil
}

// DeptUserIDsByName 部门名(含其子树)的成员 user_id 集合——与 DeptMemberIDs 同语义,
// 供 SQL 过滤(WithDept)使用。
func DeptUserIDsByName(db *sql.DB, dept string) ([]int64, error) {
	sub, err := deptSubtreeIDs(db, dept)
	if err != nil {
		return nil, err
	}
	placeholders := strings.Repeat("?,", len(sub))
	placeholders = placeholders[:len(placeholders)-1]
	args := make([]any, 0, len(sub))
	for _, id := range sub {
		args = append(args, id)
	}
	rows, err := db.Query(`SELECT DISTINCT user_id FROM user_groups WHERE group_id IN (`+placeholders+`)`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var uid int64
		if err := rows.Scan(&uid); err != nil {
			return nil, err
		}
		out = append(out, uid)
	}
	return out, rows.Err()
}

// deptSubtreeIDs 返回部门名对应的子树 group id 列表(含自身)。
func deptSubtreeIDs(db *sql.DB, dept string) ([]int64, error) {
	nodes, err := loadGroupTree(db)
	if err != nil {
		return nil, err
	}
	byID := map[int64]groupNode{}
	for _, n := range nodes {
		byID[n.id] = n
	}
	n, ok := findNodeByName(byID, dept)
	if !ok {
		return nil, ErrNotFound
	}
	return subtreeGroupIDs(db, n.id)
}

// userIDToDepts 用户 → 部门名集合(成员归属祖先链展开, 去重)。
func userIDToDepts(db *sql.DB, nodes []groupNode) (map[int64][]string, error) {
	byID := map[int64]groupNode{}
	children := map[int64][]int64{}
	for _, n := range nodes {
		byID[n.id] = n
		children[n.parent] = append(children[n.parent], n.id)
	}
	ancestors := func(id int64) []string {
		out := []string{}
		cur := byID[id]
		for cur.id != 0 {
			out = append(out, cur.name)
			cur = byID[cur.parent]
			if cur.id == 0 {
				break
			}
		}
		return out
	}
	rows, err := db.Query(`SELECT user_id, group_id FROM user_groups`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64][]string{}
	for rows.Next() {
		var uid, gid int64
		if err := rows.Scan(&uid, &gid); err != nil {
			return nil, err
		}
		if _, ok := byID[gid]; !ok {
			continue
		}
		seen := map[string]bool{}
		for _, name := range ancestors(gid) {
			if !seen[name] {
				seen[name] = true
				out[uid] = append(out[uid], name)
			}
		}
	}
	return out, rows.Err()
}

// preOrderNodes 树先序(根在前, 其子按 id)。
func preOrderNodes(nodes []groupNode) []groupNode {
	children := map[int64][]int64{}
	rootID := int64(0)
	for _, n := range nodes {
		children[n.parent] = append(children[n.parent], n.id)
	}
	// 根 = 无父(或父不存在)的节点
	byID := map[int64]groupNode{}
	for _, n := range nodes {
		byID[n.id] = n
		if _, ok := byID[n.parent]; !ok {
			rootID = n.id
		}
	}
	out := []groupNode{}
	stack := []int64{rootID}
	for len(stack) > 0 {
		curID := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if n, ok := byID[curID]; ok {
			out = append(out, n)
			// 逆序压栈保证子部门按 id 正序弹出
			kids := children[curID]
			for i := len(kids) - 1; i >= 0; i-- {
				stack = append(stack, kids[i])
			}
		}
	}
	return out
}
