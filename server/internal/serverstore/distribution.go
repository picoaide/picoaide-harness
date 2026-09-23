package serverstore

import (
	"database/sql"
	"errors"
)

// ============================================================================
// 分发状态（apps.enabled = 上架/下架）与归属判据的**唯一权威**
//
// 为什么需要这个文件（第五轮审计 R5-B-1 / R5-B-2 / R5-B-5，2026-09-23）：
// `apps.enabled` 这一个事实此前被三条路径各写了一遍判据，而且方向互相矛盾 ——
//
//  1. 员工可见性把 `enabled` 过滤放在「作者自己的行」分支**之前**
//     （旧的 ListVisibleSharedSkills），于是管理员按下「下架」之后，连作者
//     本人的「我的」也空了：员工面**无法表达**「已下架」这个状态，作者只会
//     一遍遍重传，管理员一遍遍批准，而使用者永远看不到（R5-B-1）。
//  2. 「我的」的成员判据是 app_releases.publisher（上传者），而发布权判据是
//     apps.owner（归属人）。归属一转移，两面就朝相反方向走：旧作者永久看到
//     一行自己已无权续传的内容（续传 409「名称已被占用」），新归属人——唯一
//     有权续传的人——在「我的」里什么都看不到（R5-B-2）。
//  3. 发布内核（appstore.Publish）与审核路径（sharedskills.decide）根本不看
//     `enabled`：下架期间上传照旧 201、审批照旧 200，产出一批「已批准但任何
//     人都看不见」的版本。
//
// 本文件把语义收敛成**一处定义**（下面的 Distribution 与它的三个方法）。
// 三处消费者只允许调用方法，不得再就地写 `enabled` / `!enabled` 判断：
//
//	可见性：ListVisibleSharedSkills / ListVisibleAgentPresets / capabilities
//	        聚合面 / sharedskills.listVisible / sharedskills.download
//	                                    → Delivered() / AuthorVisible()
//	上传：appstore.Publish（三条上传路径共用的唯一发布内核）
//	                                    → Writable()
//	审批：sharedskills.decide（审核通过 = 让该版本对员工生效）
//	                                    → Writable()
//
// 语义定案（三处一致，2026-09-23）：
//
//	下架 = **该内容不得分发**，但它既不删除数据、也不隐藏作者自己的视图：
//
//	  · 分发面（非归属人的可见性、归档下载、市场/组织目录）：与「不存在」同
//	    语义（不列出 + 404 同形，不泄露存在性）；
//	  · 作者面（归属人的「我的」分区）：**照旧可见**，并带 `delisted=true`
//	    —— 作者必须知道「我上传的东西现在什么状态」，否则管控动作在作者面
//	    没有任何反馈闭环；
//	  · 写入面（发布新版本 / 审核通过）：**一律拒绝**（409 APP_DELISTED），
//	    内容在下架期间冻结。
//
//	写入面为什么是「拒绝」而不是「自动上架」：下架表达的是「不得分发」，放行
//	上传/审批会产出「已批准但无人可见」的版本（旧缺陷）；而审批时自动上架会让
//	一位管理员**静默撤销**另一位管理员的下架动作（隐性副作用）。唯一出口是
//	管理员**显式重新上架**（`PUT /api/server/admin/shared-skills/:name/enabled`
//	或市场对应端点），动作本身有审计。
//
//	归属判据同样只有一份（AppOwnedByOwner / Distribution.OwnedBy）：发布权、
//	「我的」分区、下载豁免必须同源，否则就会出现「看得到却传不了 / 传得了却
//	看不到」的两面相反。**空 owner 不属于任何人**（官方内容与 2026-09-02 之前
//	的历史行）：与 appstore.Publish 的既有规则一致（空 owner 一律视同占名，
//	非管理员不得接管发布），因此它也不出现在任何人的「我的」里。
// ============================================================================

// Distribution 是「一个 App 当前处于什么分发状态」的快照，也是唯一判据的载体。
//
// 构造只允许经 DistributionStates / AppDistribution（或 DistributionMap.Of），
// 不要手搓字面量：`Enabled` 的零值是 false，会被读成「已下架」。
type Distribution struct {
	AppID string
	// Owner 是 apps.owner（归属人；官方内容与历史行为 ''）。归属转移后立即
	// 生效——发布权与「我的」分区都读它。
	Owner string
	// Enabled 是 apps.enabled。**App 行不存在时视同上架**（还没有任何下架
	// 约束，首版发布必须放行），由 Exists 区分。
	Enabled bool
	// Exists 是 apps 行是否存在。delivered 判定需要它为真（「不存在」不该被
	// 当成「可分发」），writable 判定不需要（首版发布时行还不存在）。
	Exists bool
}

// Delivered 回答「分发面是否放行」：只有**存在且上架**的 App 可以分发给
// 非归属人（列出 / 安装 / 下载）。App 行不存在 ⇒ 不可分发（与「不存在」同形）。
func (d Distribution) Delivered() bool { return d.Exists && d.Enabled }

// Writable 回答「写入面是否放行」：发布新版本与审核通过共用它。
// App 行不存在 = 首版发布 ⇒ 放行；已存在则必须处于上架态（下架期间冻结）。
func (d Distribution) Writable() bool { return !d.Exists || d.Enabled }

// AuthorVisible 回答「归属人自己的视图是否放行」。它**恒为真**：下架不影响
// 作者自查（`delisted=true` 才是要展示的状态）。写成具名方法而不是让调用方
// 省略判断，是为了让这条语义有一个可被变异验证打坏的落点：任何把作者面也
// 按 Delivered() 过滤的改动都必须在这里改，并会立刻打红 R5-B-1 的回归用例。
func (d Distribution) AuthorVisible() bool { return true }

// OwnedBy 回答「viewer 是否为该 App 的归属人」（发布权的同一个判据）。
func (d Distribution) OwnedBy(viewer string) bool { return AppOwnedByOwner(d.Owner, viewer) }

// Delisted 是 delisted 投影（作者面用）：App 存在且处于下架态。
func (d Distribution) Delisted() bool { return d.Exists && !d.Enabled }

// AppOwnedByOwner 是归属判据的**唯一实现**：发布权（appstore.Publish 的
// `existingApp.Owner != publisher` 冲突判定）、上架/下架、「我的」分区、
// 下载豁免全部走它。空 owner（官方内容 / 历史行）不属于任何人，也与
// publish.go 的既有规则逐字同义（空 owner 一律视同占名，非管理员不得接管）。
func AppOwnedByOwner(owner, viewer string) bool {
	return owner != "" && viewer != "" && owner == viewer
}

// AppOwnedBy 是 AppOwnedByOwner 的 App 版本（发布内核里读的是整行）。
func AppOwnedBy(app App, viewer string) bool { return AppOwnedByOwner(app.Owner, viewer) }

// DistributionMap 是 appID → Distribution 的批量视图（列表路径一次查库，
// 不逐行查 apps）。
type DistributionMap map[string]Distribution

// Of 取某 App 的分发状态；**行不存在**时返回「未下架、无归属」的快照
// （Enabled=false 但 Exists=false ⇒ Delivered()=false、Writable()=true）。
func (m DistributionMap) Of(appID string) Distribution {
	if d, ok := m[appID]; ok {
		return d
	}
	return Distribution{AppID: appID}
}

// DistributionStates 一次取某 kind 全部 App 的分发状态（含归属）。
// 列表路径的唯一入口；单行路径用 AppDistribution。
func DistributionStates(db *sql.DB, kind string) (DistributionMap, error) {
	return distributionStatesOn(db, kind)
}

// DistributionStatesOn 是 DistributionStates 的 executor 版本（可在 *sql.Tx 上执行）。
func DistributionStatesOn(ex Queryer, kind string) (DistributionMap, error) {
	return distributionStatesOn(ex, kind)
}

func distributionStatesOn(ex Queryer, kind string) (DistributionMap, error) {
	rows, err := ex.Query(`SELECT app_id, owner, enabled FROM apps WHERE kind = ?`, kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := DistributionMap{}
	for rows.Next() {
		var (
			id      string
			owner   sql.NullString
			enabled int
		)
		if err := rows.Scan(&id, &owner, &enabled); err != nil {
			return nil, err
		}
		out[id] = Distribution{AppID: id, Owner: owner.String, Enabled: enabled == 1, Exists: true}
	}
	return out, rows.Err()
}

// AppDistribution 取单个 App 的分发状态（单行路径：下载闸门 / 审批闸门）。
func AppDistribution(db *sql.DB, kind, appID string) (Distribution, error) {
	return appDistributionOn(db, kind, appID)
}

// AppDistributionOn 是 AppDistribution 的 executor 版本（发布内核在事务里读）。
func AppDistributionOn(ex Queryer, kind, appID string) (Distribution, error) {
	return appDistributionOn(ex, kind, appID)
}

func appDistributionOn(ex Queryer, kind, appID string) (Distribution, error) {
	var (
		owner   sql.NullString
		enabled int
	)
	err := ex.QueryRow(`SELECT owner, enabled FROM apps WHERE kind = ? AND app_id = ?`,
		kind, appID).Scan(&owner, &enabled)
	if errors.Is(err, sql.ErrNoRows) {
		// 行不存在 ≠ 下架：首版发布与「未创建」都必须放行写入面。
		return Distribution{AppID: appID}, nil
	}
	if err != nil {
		return Distribution{}, err
	}
	return Distribution{AppID: appID, Owner: owner.String, Enabled: enabled == 1, Exists: true}, nil
}
