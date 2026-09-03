package serverstore

import (
	"database/sql"
	"time"
)

// Effective groups 解析(金字塔权限继承):
//
//	用户有效组 = 归属部门 + 祖先链(授权给祖先部门 → 覆盖子孙部门成员)
//	             + 该用户任主管的部门及其全部子部门(主管向上兼容)
//
// 实时解析无缓存:组织树/主管/授权变更立即生效。

// groupTreeTTL 组织树缓存时长:部门树低频率变更(管理员操作),30s 内
// 变更可接受;每次全表 SELECT groups 在热路径(每请求配额/授权)代价高。
const groupTreeTTL = 30 * time.Second

var groupTreeCache = newTTLCache(groupTreeTTL)

type groupNode struct {
	id     int64
	parent int64
	leader int64
	name   string
}

func loadGroupTree(db *sql.DB) ([]groupNode, error) {
	if v := groupTreeCache.get(db, "tree"); v != nil {
		return v.([]groupNode), nil
	}
	rows, err := db.Query("SELECT id, name, parent_id, leader_id FROM groups")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var nodes []groupNode
	for rows.Next() {
		var n groupNode
		if err := rows.Scan(&n.id, &n.name, &n.parent, &n.leader); err != nil {
			return nil, err
		}
		nodes = append(nodes, n)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	groupTreeCache.set(db, "tree", nodes)
	return nodes, nil
}

func indexTree(nodes []groupNode) (children map[int64][]groupNode, byID map[int64]groupNode) {
	children = map[int64][]groupNode{}
	byID = map[int64]groupNode{}
	for _, n := range nodes {
		byID[n.id] = n
		children[n.parent] = append(children[n.parent], n)
	}
	return
}

// ancestorsOf walks from groupID up to the root (inclusive); cycle-guarded.
func ancestorsOf(byID map[int64]groupNode, groupID int64) []int64 {
	var out []int64
	seen := map[int64]bool{}
	cur := groupID
	for cur != 0 {
		if seen[cur] {
			break
		}
		seen[cur] = true
		out = append(out, cur)
		n, ok := byID[cur]
		if !ok {
			break
		}
		cur = n.parent
	}
	return out
}

// subtreeOf collects groupID and all descendants (DFS). Cycle-guarded:
// UpdateDepartment 防环,但迁移/手工数据可能造环——环上重复访问直接跳过,
// 保证主管权限解析永不因树损坏而无限循环(B9,2026-09-01 审计;ancestorsOf
// 已有同等保护)。
func subtreeOf(children map[int64][]groupNode, rootID int64) []int64 {
	out := []int64{rootID}
	stack := []int64{rootID}
	seen := map[int64]bool{rootID: true}
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		for _, c := range children[cur] {
			if seen[c.id] {
				continue
			}
			seen[c.id] = true
			out = append(out, c.id)
			stack = append(stack, c.id)
		}
	}
	return out
}

// EveryoneGroupName is the implicit "everyone" department: every user is
// a member without an explicit membership row (公共文档/通用技能授权用)。
const EveryoneGroupName = "全员"

// UserEffectiveGroups returns the group names a user effectively belongs to
// for permission resolution (inheritance-expanded). Plain membership stays
// available via UserGroups for admin display.
//
//  1. 归属部门 + 祖先链:授权给「研发部」→ 前端组/后端组成员可见
//  2. 主管向上:leader_id = user 的部门及其子树,主管自动获得授权
//  3. 隐式全员组:EveryoneGroupName 对所有人生效(单部门模型下无需显式加入)
func UserEffectiveGroups(db *sql.DB, userID int64) ([]string, error) {
	member, err := UserGroups(db, userID)
	if err != nil {
		return nil, err
	}
	nodes, err := loadGroupTree(db)
	if err != nil {
		return nil, err
	}
	children, byID := indexTree(nodes)

	effective := map[int64]bool{}
	for _, name := range member {
		if n, ok := findNodeByName(byID, name); ok {
			for _, a := range ancestorsOf(byID, n.id) {
				effective[a] = true
			}
		}
	}
	for _, n := range nodes {
		if n.leader == userID {
			for _, s := range subtreeOf(children, n.id) {
				effective[s] = true
			}
		}
	}
	// 隐式全员组
	if n, ok := findNodeByName(byID, EveryoneGroupName); ok {
		effective[n.id] = true
	}
	var out []string
	for id := range effective {
		if n, ok := byID[id]; ok {
			out = append(out, n.name)
		}
	}
	return out, nil
}

func findNodeByName(byID map[int64]groupNode, name string) (groupNode, bool) {
	for _, n := range byID {
		if n.name == name {
			return n, true
		}
	}
	return groupNode{}, false
}
