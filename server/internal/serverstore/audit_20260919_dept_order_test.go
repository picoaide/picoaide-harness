package serverstore

import (
	"fmt"
	"testing"
)

// 2026-09-19(服务端审计收尾):RegroupByDept 尾部排序的比较器不满足严格弱序。
//
// 旧实现:
//
//	order := map[string]int{}          // 树先序序号
//	sort.Slice(out, func(i, j int) bool {
//	    oi, oiOK := order[out[i].Label]
//	    oj, ojOK := order[out[j].Label]
//	    if !oiOK || !ojOK { return out[i].Label < out[j].Label }
//	    return oi < oj
//	})
//
// 只要有一个 label 不在 order 里,混合比较就退化成纯字典序,而"两个已知 label
// 之间"按先序序号 —— 两把尺子可以拼成环:
//
//	已知 z(先序 0)、已知 a(先序 1)、未知 b
//	  z < a(先序)、a < b(字典序)、b < z(字典序)⇒ 环
//
// sort.Slice 在环下输出未定义,且 out 由 map 遍历构造(Go 每次迭代起点随机)
// ⇒ 排序结果的输入顺序每次不同:同一份数据可能给出不同的部门顺序、不同的
// "前 n 个部门"。
//
// 未知 label 的真实来源(不是构造出来的):userIDToDepts 沿 ancestors() 展开
// 用户所属部门的祖先链,而 ancestors() 自带 seen 环保护 —— 说明"部门树带环"
// 是被承认的输入形态(迁移/手工数据)。preOrderNodes 只能从 roots 出发,环内
// 节点既不是 root 也不会被遍历到 ⇒ order 里没有它们的名字,但 agg 里有。
func TestAudit20260919RegroupByDeptUnknownLabelTotalOrder(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()

	insertGroup := func(name string, parent int64) int64 {
		t.Helper()
		var id int64
		if err := db.QueryRow(`INSERT INTO groups (name, parent_id) VALUES (?, ?) RETURNING id`, name, parent).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	// 正常部门:z(根)→ a(子)
	zID := insertGroup("z", 0)
	aID := insertGroup("a", zID)
	// 环部门:b ↔ d(直接改父,绕过 UpdateDepartment 的环检测,与
	// balance_test.go 的 TestSubtreeGroupIDsCycleGuard 同一构造方式)。
	bID := insertGroup("b", 0)
	dID := insertGroup("d", bID)
	if _, err := db.Exec(`UPDATE groups SET parent_id = ? WHERE id = ?`, dID, bID); err != nil {
		t.Fatal(err)
	}
	InvalidateGroupTree()

	mkUser := func(name string, groupID int64) {
		t.Helper()
		uid, err := CreateUser(db, &User{Username: name, Source: "local", Status: 1})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT INTO user_groups (user_id, group_id) VALUES (?, ?)`, uid, groupID); err != nil {
			t.Fatal(err)
		}
	}
	mkUser("zuser", aID) // 归属 a ⇒ 祖先链 z,a(两个已知部门)
	mkUser("cuser", bID) // 归属 b ⇒ 祖先链 b,d(两个环内部门,均不在先序里)

	rows := []UsageAggregateRow{
		{Label: "zuser", PromptTokens: 10, Requests: 1, Cost: 1},
		{Label: "cuser", PromptTokens: 20, Requests: 1, Cost: 2},
	}

	// 先确认前提成立:先序序号只有 z/a,b 与 d 确实是"未知 label"。
	nodes, err := loadGroupTree(db)
	if err != nil {
		t.Fatal(err)
	}
	order := map[string]int{}
	for i, n := range preOrderNodes(nodes) {
		order[n.name] = i
	}
	if _, ok := order["b"]; ok {
		t.Fatalf("前提不成立:环内部门 b 竟进入先序 %v", order)
	}
	if _, ok := order["d"]; ok {
		t.Fatalf("前提不成立:环内部门 d 竟进入先序 %v", order)
	}

	var first []string
	for i := range 200 {
		out, err := RegroupByDept(db, rows)
		if err != nil {
			t.Fatal(err)
		}
		got := make([]string, 0, len(out))
		for _, r := range out {
			got = append(got, r.Label)
		}
		if len(out) != 4 {
			t.Fatalf("第 %d 次:归并行数 = %d, want 4(z/a/b/d): %v", i, len(out), got)
		}
		if i == 0 {
			first = got
		} else if fmt.Sprint(got) != fmt.Sprint(first) {
			t.Fatalf("同一份数据两次归并顺序不同(比较器不是全序):首次 %v,第 %d 次 %v", first, i, got)
		}
	}
	// 期望的全序:已知部门按树先序(z → a),未知部门在后按 Label 升序(b → d)。
	want := []string{"z", "a", "b", "d"}
	for i := range want {
		if first[i] != want[i] {
			t.Fatalf("部门顺序 = %v, want %v(已知在先按先序,未知在后按 Label)", first, want)
		}
	}
}

// TestAudit20260919LessByDeptPreOrderIsStrictWeakOrder 直接对比较器本身做全量
// 枚举验证(不依赖 PG,也不依赖 sort 的内部实现):自反性 / 反对称性 / 传递性 /
// 可比性(标签互异时恰有一个方向成立)。旧比较器在 {z, a, b} 上传递性即失败:
// z<a(先序)、a<b(字典序)、b<z(字典序)成环。
func TestAudit20260919LessByDeptPreOrderIsStrictWeakOrder(t *testing.T) {
	// 已知(树先序):z → a → m;未知(环内/游离):b、d
	order := map[string]int{"z": 0, "a": 1, "m": 2}
	labels := []string{"z", "a", "m", "b", "d"}

	for _, x := range labels {
		if lessByDeptPreOrder(order, x, x) {
			t.Fatalf("自反性: %q < %q 为真", x, x)
		}
	}
	for _, x := range labels {
		for _, y := range labels {
			if x == y {
				continue
			}
			if lessByDeptPreOrder(order, x, y) == lessByDeptPreOrder(order, y, x) {
				t.Fatalf("反对称性/可比性: %q 与 %q 的关系 = %v/%v, want 恰有一个方向成立",
					x, y, lessByDeptPreOrder(order, x, y), lessByDeptPreOrder(order, y, x))
			}
		}
	}
	for _, x := range labels {
		for _, y := range labels {
			for _, z := range labels {
				if lessByDeptPreOrder(order, x, y) && lessByDeptPreOrder(order, y, z) && !lessByDeptPreOrder(order, x, z) {
					t.Fatalf("传递性: %q<%q 且 %q<%q,但 %q<%q 为假(环)", x, y, y, z, x, z)
				}
			}
		}
	}

	// 语义:已知按先序(z<a<m),未知一律排在已知之后,未知之间按名字(b<d)。
	for _, pair := range [][2]string{{"z", "a"}, {"a", "m"}, {"z", "m"}, {"z", "b"}, {"m", "b"}, {"b", "d"}} {
		if !lessByDeptPreOrder(order, pair[0], pair[1]) {
			t.Fatalf("%q 应排在 %q 之前", pair[0], pair[1])
		}
	}
	if lessByDeptPreOrder(order, "b", "z") {
		t.Fatal("未知部门不得排在已知部门之前")
	}
}
