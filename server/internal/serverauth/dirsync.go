package serverauth

import (
	"database/sql"
	"errors"
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
//     组全量替换(SyncUserGroups)、曾停用则重新启用;目录不存在的 →
//     停用(status=0)并吊销全部 token(离职立即失效,保留审计行)。
//   - 外部身份绝不接管本地账号(与 provisionUser 同一安全边界)。
//   - 组:目录组名经 GetOrCreateGroup 落 groups 表(大小写不敏感);
//     用户组关系全量替换,空组自动回收。
//   - 空目录(0 用户)拒绝执行:极可能是过滤器写错,停用全部外部用户
//     风险过大(与网关 SyncProvider 空模型列表不清空目录同理)。
//
// 周期:启动后每 LDAPSyncInterval(1h)一轮;配置保存后立即触发一轮
// (setAuthConfig → SyncDirectoryOnce)。失败仅记日志,绝不影响登录。

// LDAPSyncInterval 是全量目录同步周期(用户要求:每隔 1 小时)。
const LDAPSyncInterval = time.Hour

// DirSyncResult 描述一轮目录同步的结果(日志 / 测试断言)。
type DirSyncResult struct {
	Added   int `json:"added"`
	Updated int `json:"updated"`
	Deact   int `json:"deactivated"`
	Groups  int `json:"groups"`
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
	entries, err := prov.scanEntries(conn, prov.userScanFilter(), []string{"uid", "cn", "mail", prov.GroupAttr})
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
	for _, e := range entries {
		username := entryUserName(e, "")
		if username == "" {
			continue // 无 uid 的条目不是可登录用户(组织单元/组对象等)
		}
		seen[username] = true
		displayName := e.GetAttributeValue("cn")
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
		// 更新显示名/邮箱(外部行仅此两字段可同步;密码/配额/角色不动)
		if u.DisplayName != displayName || u.Email != email || u.Status != 1 {
			upd := *u
			upd.DisplayName = displayName
			upd.Email = email
			upd.Status = 1 // 曾停用的外部用户回到目录 → 重新启用
			if err := serverstore.UpdateUser(db, &upd); err != nil {
				return res, err
			}
			res.Updated++
		}
	}
	res.Groups = len(groupSeen)
	// 目录中已不存在的外部用户:停用 + 吊销令牌(离职即失效)
	deact, err := deactivateMissingExternalUsers(db, seen)
	if err != nil {
		return res, err
	}
	res.Deact = deact
	return res, nil
}

// deactivateMissingExternalUsers 停用 keep 中不存在的外部用户并吊销其
// 全部 token,返回停用数量。本地账号/管理员不受影响。
func deactivateMissingExternalUsers(db *sql.DB, keep map[string]bool) (int, error) {
	users, _, err := serverstore.ListUsers(db, 0, 100000, "")
	if err != nil {
		return 0, err
	}
	count := 0
	for _, u := range users {
		if u.Source != "external" || keep[u.Username] || u.Status != 1 {
			continue
		}
		upd := u
		upd.Status = 0
		if err := serverstore.UpdateUserRevokingTokens(db, &upd); err != nil {
			return count, err
		}
		count++
	}
	return count, nil
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
