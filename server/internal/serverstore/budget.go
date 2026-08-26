package serverstore

import (
	"database/sql"
	"strings"
	"time"
)

// 部门月度金额预算(0024)。
//
// 语义:员工预算链 = 归属部门 + 祖先链(不含主管子树 —— 主管向上兼容是
// 授权/知识库语义,预算只约束归属链,否则部门预算可被主管绕过)。
// 链上每个配置了预算的部门都约束该员工(多级预算全部生效,任一超限即拦截);
// 同一预算部门覆盖其全部子部门成员(树内合计)。
//
// 费用口径与 usage.cost(0022 记录时定价)一致:按部门聚合 SUM(cost)。

// DeptBudget 一条部门预算。
type DeptBudget struct {
	GroupID int64
	Name    string
	Budget  float64 // 元/月;>0 生效
}

// SetDeptBudget 设置/清除部门预算(budget <= 0 = 清除,恢复不限)。
func SetDeptBudget(db *sql.DB, groupID int64, budget float64) error {
	if _, err := GroupByID(db, groupID); err != nil {
		return err
	}
	if budget <= 0 {
		_, err := db.Exec("UPDATE groups SET budget_money = NULL WHERE id = ?", groupID)
		return err
	}
	_, err := db.Exec("UPDATE groups SET budget_money = ? WHERE id = ?", budget, groupID)
	return err
}

// GetDeptBudget 返回部门预算(0 = 未配置)。
func GetDeptBudget(db *sql.DB, groupID int64) (float64, error) {
	var b sql.NullFloat64
	if err := db.QueryRow("SELECT budget_money FROM groups WHERE id = ?", groupID).Scan(&b); err != nil {
		if err == sql.ErrNoRows {
			return 0, ErrNotFound
		}
		return 0, err
	}
	if !b.Valid {
		return 0, nil
	}
	return b.Float64, nil
}

// EffectiveDeptBudget 返回用户生效的部门预算链(归属部门 + 祖先链 +
// 隐式「全员」组——审计修复 2026-P (M6):全员组预算对所有人都应生效,
// 否则 UI 显示生效但网关永不 enforcement)。
// 每级只返回配置了预算的部门,按祖先 → 自己排序。
func EffectiveDeptBudget(db *sql.DB, userID int64) ([]DeptBudget, error) {
	member, err := UserGroups(db, userID)
	if err != nil {
		return nil, err
	}
	nodes, err := loadGroupTree(db)
	if err != nil {
		return nil, err
	}
	_, byID := indexTree(nodes)

	// 归属部门 id(单部门模型下通常 1 个)
	var memberIDs []int64
	for _, name := range member {
		if n, ok := findNodeByName(byID, name); ok {
			memberIDs = append(memberIDs, n.id)
		}
	}
	// 预算链:ancestorsOf 返回 [self, parent, ..., root],反转成
	// [root, ..., parent, self](祖先在前,展示与语义都自然)。
	// 去重:同部门多路径(不应发生,单部门归属)取一次。
	// 隐式「全员」组并入链首(与 UserEffectiveGroups 授权语义一致)。
	seen := map[int64]bool{}
	var chain []int64
	if n, ok := findNodeByName(byID, EveryoneGroupName); ok && !seen[n.id] {
		seen[n.id] = true
		chain = append(chain, n.id)
	}
	for _, mid := range memberIDs {
		for _, a := range ancestorsOf(byID, mid) {
			if !seen[a] {
				seen[a] = true
				chain = append(chain, a)
			}
		}
	}
	for i, j := 0, len(chain)-1; i < j; i, j = i+1, j-1 {
		chain[i], chain[j] = chain[j], chain[i]
	}
	// 读取预算
	out := []DeptBudget{}
	if len(chain) == 0 {
		return out, nil
	}
	placeholders := strings.Repeat("?,", len(chain))
	placeholders = placeholders[:len(placeholders)-1]
	args := make([]any, 0, len(chain))
	for _, id := range chain {
		args = append(args, id)
	}
	rows, err := db.Query(`SELECT id, name, COALESCE(budget_money, 0) FROM groups
		WHERE id IN (`+placeholders+`)`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byIDVal := map[int64]DeptBudget{}
	for rows.Next() {
		var b DeptBudget
		if err := rows.Scan(&b.GroupID, &b.Name, &b.Budget); err != nil {
			return nil, err
		}
		byIDVal[b.GroupID] = b
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// 按链序输出,只留配置了预算(>0)的
	for _, id := range chain {
		if b, ok := byIDVal[id]; ok && b.Budget > 0 {
			out = append(out, b)
		}
	}
	return out, nil
}

// DeptMemberIDs 返回部门树(含全部子部门)内的成员 user_id 集合。
// 成员 = user_groups 直接归属(部门归属是单部门模型,但兼容多组)。
func DeptMemberIDs(db *sql.DB, groupID int64) ([]int64, error) {
	sub, err := subtreeGroupIDs(db, groupID)
	if err != nil {
		return nil, err
	}
	if len(sub) == 0 {
		return nil, nil
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

// DeptMonthlyCost 返回部门树(含子部门)当月累计费用 SUM(cost)(元)。
func DeptMonthlyCost(db *sql.DB, groupID int64) (float64, error) {
	ids, err := DeptMemberIDs(db, groupID)
	if err != nil {
		return 0, err
	}
	if len(ids) == 0 {
		return 0, nil
	}
	placeholders := strings.Repeat("?,", len(ids))
	placeholders = placeholders[:len(placeholders)-1]
	args := make([]any, 0, len(ids)+1)
	args = append(args, monthStart(time.Now()).Format(sqliteTimeFmt))
	for _, id := range ids {
		args = append(args, id)
	}
	var total float64
	err = db.QueryRow(`SELECT COALESCE(SUM(cost),0) FROM usage
		WHERE created_at >= ? AND user_id IN (`+placeholders+`)`, args...).Scan(&total)
	return total, err
}

// DeptMonthlyCostBatch 批量部门费用(map groupID → 元),部门列表页 N+1 防护。
func DeptMonthlyCostBatch(db *sql.DB, groupIDs []int64) (map[int64]float64, error) {
	out := map[int64]float64{}
	for _, id := range groupIDs {
		out[id] = 0
	}
	if len(groupIDs) == 0 {
		return out, nil
	}
	// 一个查询拿到全部部门树成员映射
	membersByDept := map[int64][]int64{}
	for _, id := range groupIDs {
		ids, err := DeptMemberIDs(db, id)
		if err != nil {
			return nil, err
		}
		membersByDept[id] = ids
	}
	// 全量当月费用一次取,避免逐部门查询
	ids := []int64{}
	for _, list := range membersByDept {
		ids = append(ids, list...)
	}
	if len(ids) == 0 {
		return out, nil
	}
	placeholders := strings.Repeat("?,", len(ids))
	placeholders = placeholders[:len(placeholders)-1]
	args := make([]any, 0, len(ids)+1)
	args = append(args, monthStart(time.Now()).Format(sqliteTimeFmt))
	for _, id := range ids {
		args = append(args, id)
	}
	rows, err := db.Query(`SELECT user_id, COALESCE(SUM(cost),0) FROM usage
		WHERE created_at >= ? AND user_id IN (`+placeholders+`) GROUP BY user_id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	userCost := map[int64]float64{}
	for rows.Next() {
		var uid int64
		var c float64
		if err := rows.Scan(&uid, &c); err != nil {
			return nil, err
		}
		userCost[uid] = c
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for deptID, list := range membersByDept {
		for _, uid := range list {
			out[deptID] += userCost[uid]
		}
	}
	return out, nil
}
