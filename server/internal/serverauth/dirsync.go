package serverauth

import (
	"database/sql"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// 目录全量同步(LDAP 用户/组自动同步):
//
// 需求:ldap 配置后自动同步用户和组,每隔 1 小时同步一次。此前仅登录时
// 逐用户同步(provisionUser),未登录用户/离职用户/组变化不会反映到本地
// users/user_groups,组授权/部门因此滞后甚至永久失效。
//
// 同步语义(与登录时一致):
//   - users.source='external' 的行全量对齐:目录存在的 → 核对显示名/邮箱、
//     组全量替换(SyncUserGroups);目录不存在的 → 停用(status=0)并吊销全部
//     token(离职立即失效,保留审计行)。
//   - **启用方向是单向的**:目录同步只自动**停用**,永不自动**启用**
//     (第五轮审计 R5-B-8,2026-09-23 定案)。目录里存在但账号已停用的一律
//     **跳过**并记审计 `directory_enable_skipped` —— 停用是一个显式决定,
//     只有管理员显式恢复(webadmin 用户管理里把状态改回启用)才能撤销它。
//
//     依据:此前「仍在目录里 ⇒ Status=1」这条判据把「曾因离职被同步停用、
//     现在又回到目录」与「管理员手工停用」合成了同一个条件,于是管理员为
//     安全事件(账号疑似被盗/违规)按下的禁用会被下一轮同步**静默撤销**
//     (≤1h、零审计,管理端此前显示的"已禁用"与事实相反)。两种意图在库里
//     没有任何区分标记,而任何新增标记对**存量行**都只能记"未知":按"目录
//     管理"解释 ⇒ 存量禁用行继续暴露在旧缺陷里;按"人工"解释 ⇒ 其行为恰好
//     等于本规则。所以直接采用规则本身,不引入新状态(也就不需要迁移与
//     相应的文档同步)。
//
//     代价(认账):因目录抖动或离职后重新入职而"消失又出现"的账号不再自动
//     恢复,需要管理员启用一次;它每轮都会被点名(审计 + 日志),不是静默的。
//   - 外部身份绝不接管本地账号(与 provisionUser 同一安全边界)。
//   - 组:目录组名经 GetOrCreateGroup 落 groups 表(大小写不敏感);
//     用户组关系全量替换,空组自动回收。
//   - 空目录(0 用户)拒绝执行:极可能是过滤器写错,停用全部外部用户
//     风险过大(与网关 SyncProvider 空模型列表不清空目录同理)。
//
// 审计:两个方向都留痕(此前 dirsync 全文零 AuditLog)——
//   · `directory_enable_skipped`:本轮被跳过的已停用账号(每轮最多一条,点名);
//   · `directory_user_disabled`:因目录中消失而被停用的账号(逐人一条)。
//
// 周期:启动后每 LDAPSyncInterval(1h)一轮;配置保存后立即触发一轮
// (setAuthConfig → SyncDirectoryOnce)。失败仅记日志,绝不影响登录。

// LDAPSyncInterval 是全量目录同步周期(用户要求:每隔 1 小时)。
const LDAPSyncInterval = time.Hour

// dirSyncAuditActor 是目录同步写审计时的操作者名(无真人发起者;与
// internal/balance 调度器的 "system" 同一约定)。
const dirSyncAuditActor = "system"

// dirSyncSkipAuditLimit 限制单条「跳过自动启用」审计里点名的用户数
// (审计详情要可读;超出部分只报总数)。
const dirSyncSkipAuditLimit = 20

// DirSyncResult 描述一轮目录同步的结果(日志 / 测试断言)。
type DirSyncResult struct {
	Added   int `json:"added"`
	Updated int `json:"updated"`
	Deact   int `json:"deactivated"`
	Groups  int `json:"groups"`
	// SkippedDisabled 是本轮因「账号已停用」而被跳过的目录用户数
	// (目录同步不自动启用,见文件头策略注释)。
	SkippedDisabled int `json:"skipped_disabled"`
}

// DirectorySyncRunner 执行一轮目录同步(接口便于测试注入)。
type DirectorySyncRunner interface {
	Run(db *sql.DB) (*DirSyncResult, error)
}

// LDAPDirectorySync 是默认目录同步器:读 ldap.* 配置,全量扫描目录并
// 对账本地 users/user_groups。
type LDAPDirectorySync struct {
	// Dial 是测试注入钩子(与 LDAPProvider.dial 同构);生产为 nil 走真实连接。
	Dial func(url string) (ldapConn, error)
}

// NewDirectorySync returns the directory sync runner (LDAP only).
func NewDirectorySync() DirectorySyncRunner { return LDAPDirectorySync{} }

// Run 执行一轮 LDAP 目录全量同步。LDAP 未启用/未配置时 no-op。
func (s LDAPDirectorySync) Run(db *sql.DB) (*DirSyncResult, error) {
	settings, err := serverstore.GetAllSettings(db)
	if err != nil {
		return nil, err
	}
	if !ldapEnabled(settings) {
		return &DirSyncResult{}, nil
	}
	prov := ldapFromSettings(settings)
	ld, ok := prov.(*LDAPProvider)
	if !ok {
		return nil, errors.New("ldap: config incomplete")
	}
	if s.Dial != nil {
		ld.dial = s.Dial
	}
	return SyncDirectoryRun(db, ld)
}

// ldapEnabled 判断 auth.enabled(或兼容 auth.mode)是否启用 ldap。
func ldapEnabled(settings map[string]string) bool {
	for _, m := range strings.Split(settings["auth.enabled"], ",") {
		if strings.TrimSpace(m) == "ldap" {
			return true
		}
	}
	mode := settings["auth.mode"]
	return mode == "ldap" || mode == "both"
}

// SyncDirectoryRun 用给定 provider 执行一轮同步(测试可注入 fake)。
// 单个连接完成:bind 一次 → 全量用户扫描 → 逐用户组查询(按条目 DN,
// 与 Authenticate 的 group_filter 语义一致),避免 N 用户 N 连接。
func SyncDirectoryRun(db *sql.DB, prov *LDAPProvider) (*DirSyncResult, error) {
	conn, err := prov.dialConn()
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	if err := conn.Bind(prov.BindDN, prov.BindPassword); err != nil {
		return nil, errors.New("ldap bind failed")
	}
	entries, err := prov.scanEntries(conn, prov.userScanFilter(), uniqAttrs([]string{prov.UserAttr, "cn", "sn", "mail", prov.GroupAttr}))
	if err != nil {
		return nil, err
	}
	if len(entries) == 0 {
		// 空目录可能是过滤器写错(匹配 0 用户)或目录被清空。全量对账
		// 会把所有外部用户停用——风险过大,拒绝在空结果上执行。
		return nil, errors.New("ldap: directory search returned 0 users; refusing to deactivate all")
	}
	res := &DirSyncResult{}
	seen := make(map[string]bool, len(entries))
	groupSeen := make(map[string]bool)
	// skipped:目录里存在、但账号已停用的用户名(本轮跳过自动启用的人员)。
	skipped := []string{}
	// deactivated:因目录中消失而被停用的用户名(逐人写审计)。
	deactivated := []string{}
	for _, e := range entries {
		username := prov.usernameOf(e)
		if username == "" {
			continue // 无 user_attr/cn/mail 的条目不是可登录用户(组织单元/组对象等)
		}
		seen[username] = true
		// 显示名:sn(真实姓名,如 某些企业目录)→ cn 兜底
		// (cn 可能是登录名,如 alice;显示名取 sn 更人性化)。
		displayName := e.GetAttributeValue("sn")
		if displayName == "" {
			displayName = e.GetAttributeValue("cn")
		}
		email := e.GetAttributeValue("mail")

		u, err := serverstore.GetUserByUsername(db, username)
		if errors.Is(err, serverstore.ErrNotFound) {
			id, err := serverstore.CreateUser(db, &serverstore.User{
				Username:    username,
				DisplayName: displayName,
				Email:       email,
				Source:      "external",
				Status:      1,
			})
			if err != nil {
				if !errors.Is(err, serverstore.ErrDuplicate) {
					return res, err
				}
				// 并发窗口:另一个同步/登录建了行,re-fetch
				u, err = serverstore.GetUserByUsername(db, username)
				if err != nil {
					return res, err
				}
			} else {
				res.Added++
				u, err = serverstore.GetUserByID(db, id)
				if err != nil {
					return res, err
				}
			}
		} else if err != nil {
			return res, err
		}
		// 外部身份绝不接管本地账号(与 provisionUser 同一安全边界)
		if u.Source != "external" {
			continue
		}
		// 组同步(与登录路径一致:group_filter 按该用户 DN 查询)。
		// group_filter 缺失时不清空已有组(与登录行为一致)。
		if prov.GroupFilter != "" {
			groups, gerr := prov.groupsOfEntry(conn, e.DN)
			if gerr != nil {
				return res, gerr
			}
			if err := serverstore.SyncUserGroups(db, u.ID, groups); err != nil {
				return res, err
			}
			for _, g := range groups {
				groupSeen[g] = true
			}
		}
		// 更新显示名/邮箱(外部行仅此两字段可同步;密码/配额/角色/状态不动)。
		//
		// **状态不在同步面内**(第五轮审计 R5-B-8):已停用的账号一律跳过自动
		// 启用(记入 skipped,本轮结束写审计)。upd.Status 保持 u.Status 原值。
		if u.Status != 1 {
			skipped = append(skipped, username)
		}
		if u.DisplayName != displayName || u.Email != email {
			upd := *u
			upd.DisplayName = displayName
			upd.Email = email
			if err := serverstore.UpdateUser(db, &upd); err != nil {
				return res, err
			}
			res.Updated++
		}
	}
	res.Groups = len(groupSeen)
	res.SkippedDisabled = len(skipped)
	// 审计①:本轮被跳过的已停用账号(每轮最多一条,点名到上限;不写会让
	// "管理员禁用被同步无视"这件事在审计里彻底不可见,而它恰恰是安全事件
	// 的处置动作)。
	if len(skipped) > 0 {
		log.Printf("ldap directory sync: %d disabled account(s) present in directory; not re-enabling (admin action required): %s",
			len(skipped), strings.Join(capNames(skipped, dirSyncSkipAuditLimit), ","))
		if err := serverstore.AuditLog(db, dirSyncAuditActor, "directory_enable_skipped",
			dirSyncSkipAuditDetail(skipped)); err != nil {
			log.Printf("ldap directory sync: audit directory_enable_skipped failed: %v", err)
		}
	}
	// 2026-09-08 P1-4:记录本轮目录"见过"的用户名,停用对账只针对这些用户名
	// (OIDC 用户同为 Source=external,不得被 LDAP 同步误停用)。
	syncedNames := make([]string, 0, len(seen))
	for name := range seen {
		syncedNames = append(syncedNames, name)
	}
	if err := serverstore.MarkLDAPSynced(db, syncedNames); err != nil {
		return res, err
	}
	// 目录中已不存在的外部用户:停用 + 吊销令牌(离职即失效)。
	// 逐人写审计 `directory_user_disabled`(此前这一步没有任何审计行:
	// "账号在企业里已经不存在了"这种自动化收紧动作必须可追溯)。
	deactivated, err = deactivateMissingExternalUsers(db, seen)
	if err != nil {
		return res, err
	}
	res.Deact = len(deactivated)
	for _, name := range deactivated {
		if err := serverstore.AuditLog(db, dirSyncAuditActor, "directory_user_disabled",
			name+" (目录中已不存在，自动停用并吊销全部令牌)"); err != nil {
			log.Printf("ldap directory sync: audit directory_user_disabled failed: %v", err)
		}
	}
	return res, nil
}

// dirSyncSkipAuditDetail 组装「跳过自动启用」的审计详情:人 + 规则。
// 上限 dirSyncSkipAuditLimit 个名字(审计详情要可读),超出只报总数。
func dirSyncSkipAuditDetail(names []string) string {
	detail := fmt.Sprintf("跳过自动启用 %d 个已停用账号(停用只由管理员显式恢复,目录同步不自动启用): %s",
		len(names), strings.Join(capNames(names, dirSyncSkipAuditLimit), ","))
	if len(names) > dirSyncSkipAuditLimit {
		detail += fmt.Sprintf(" 等 %d 个", len(names))
	}
	return detail
}

// capNames 返回最多 limit 个名字(超限时只取前 limit 个)。
func capNames(names []string, limit int) []string {
	if limit <= 0 || len(names) <= limit {
		return names
	}
	return names[:limit]
}

// deactivateMissingExternalUsers 停用 keep 中不存在的外部用户并吊销其
// 全部 token,返回被停用的用户名(调用方据此逐人写审计)。本地账号/管理员
// 不受影响。
// 2026-09-08 P1-4:只停用**曾由 LDAP 同步见过**的用户名(ldap_synced_users),
// 否则同为 Source=external 的 OIDC 用户会被 LDAP 对账每小时误停用一次。
func deactivateMissingExternalUsers(db *sql.DB, keep map[string]bool) ([]string, error) {
	synced, err := serverstore.LDAPSyncedUsers(db)
	if err != nil {
		return nil, err
	}
	// F18(审计 2026-09-11):分页拉取全部用户(旧实现硬上限 10 万,超出部分
	// 永远不会被停用 —— 大规模目录的离职用户 token 不会吊销)。
	const pageSize = 1000
	var users []serverstore.User
	for offset := 0; ; offset += pageSize {
		batch, total, err := serverstore.ListUsers(db, offset, pageSize, "")
		if err != nil {
			return nil, err
		}
		users = append(users, batch...)
		if len(batch) == 0 || int64(len(users)) >= total {
			break
		}
	}
	if err != nil {
		return nil, err
	}
	deactivated := []string{}
	for _, u := range users {
		if u.Source != "external" || keep[u.Username] || u.Status != 1 || !synced[u.Username] {
			continue
		}
		upd := u
		upd.Status = 0
		if err := serverstore.UpdateUserRevokingTokens(db, &upd); err != nil {
			return deactivated, err
		}
		if err := serverstore.UnmarkLDAPSynced(db, u.Username); err != nil {
			return deactivated, err
		}
		deactivated = append(deactivated, u.Username)
	}
	return deactivated, nil
}

// SyncDirectoryLoop 定时执行目录同步(启动后立即一轮,然后固定间隔)。
func SyncDirectoryLoop(db *sql.DB, interval time.Duration, runner DirectorySyncRunner) {
	if interval <= 0 {
		interval = LDAPSyncInterval
	}
	if runner == nil {
		runner = LDAPDirectorySync{}
	}
	for {
		if res, err := runner.Run(db); err != nil {
			log.Printf("ldap directory sync: %v", err)
		} else if res.Added > 0 || res.Deact > 0 || res.Updated > 0 {
			log.Printf("ldap directory sync: +%d updated=%d deactivated=%d", res.Added, res.Updated, res.Deact)
		}
		time.Sleep(interval)
	}
}

// SyncDirectoryOnce 立即执行一轮(配置保存后同步调用)。
func SyncDirectoryOnce(db *sql.DB, runner DirectorySyncRunner) (*DirSyncResult, error) {
	if runner == nil {
		runner = LDAPDirectorySync{}
	}
	return runner.Run(db)
}
