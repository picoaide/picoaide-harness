// Package appstore implements the unified publish kernel over the App /
// Release model (决策 docs/decisions/2026-09-01-skill-app-management.md P2)。
//
// 它是**唯一的内容写入口**:管理后台上架、客户端能力中心上传、客户端智能体
// 预设上传三条路径最终都调用 Publish,因此严格校验、版本语义、锁定与配额只
// 需实现一次。各域的 HTTP handler 只负责鉴权与参数搬运。
package appstore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/skillmanifest"
)

// 冲突类错误码(包内校验类错误码定义在 skillmanifest)。
const (
	CodeVersionExists        = "VERSION_EXISTS"
	CodeVersionNotIncreasing = "VERSION_NOT_INCREASING"
	CodeContentUnchanged     = "CONTENT_UNCHANGED"
	CodeAppLocked            = "APP_LOCKED"
	CodeOfficialLocked       = "OFFICIAL_LOCKED"
	CodeNameTaken            = "NAME_TAKEN"
	CodePendingLimit         = "PENDING_LIMIT"
	// CodeAppDelisted:该 App 已下架(apps.enabled=0),下架期间内容冻结 ——
	// 不接收新版本、也不允许把待审版本置为 approved。管理员显式重新上架是
	// 唯一出口(第五轮审计 R5-B-1)。
	CodeAppDelisted = "APP_DELISTED"
	// CodePublishBusy:同名发布排队超时(抢锁预算用尽),请调用方重试。
	CodePublishBusy = "PUBLISH_BUSY"
)

// 发布串行化的抢锁参数(F2-N2):总预算 + 退避间隔。等待者不占连接,
// 因此退避间隔只影响锁释放后的接续延迟,不影响连接池。
const (
	publishLockWait = 10 * time.Second
	publishLockPoll = 20 * time.Millisecond
	// publishTxBudget 是「抢锁 + 落库」整个事务的墙钟上界(含大归档的
	// INSERT)。它比抢锁预算宽得多:抢锁超时应回 503 让调用方重试,而落库
	// 慢只说明这次写确实要那么久 —— 两者不能共用一个预算,否则一个大归档
	// 会被误判成「同名排队超时」。
	publishTxBudget = 60 * time.Second
)

// Error 是发布失败的结构化结果:HTTP 状态 + 稳定错误码 + 面向用户的中文说明。
type Error struct {
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func newErr(status int, code, format string, args ...any) *Error {
	return &Error{Status: status, Code: code, Message: fmt.Sprintf(format, args...)}
}

// PublishRequest 描述一次发布。元数据一律由服务端从包内解析(「包内即真相」),
// 调用方只提供身份、渠道与归档字节。
type PublishRequest struct {
	Kind    string // skill | agent
	AppID   string
	Channel string // market | org
	Archive []byte
	// Publisher 是发布账号(登录态),不可由请求体伪造。
	Publisher string
	// AdminPublish=true 时跳过锁定检查与待审配额,且发布即 approved
	// (管理后台上架等价于已审核)。
	AdminPublish bool
	// PendingCap 为 0 表示不限;仅对非管理员发布生效。
	PendingCap int
	// DeclaredVersion 非空时必须与包内版本一致(管理后台表单是显式意图)。
	DeclaredVersion string
	// Manifest 由调用方预先解析好(技能走 skillmanifest;智能体没有 SKILL.md,
	// 由各自域构造一个等价清单)。
	Manifest Manifest
	// Checksum 是归档的 sha256(由调用方在安全校验时算出,避免重复哈希)。
	Checksum string
}

// Manifest 是发布所需的元数据集合(技能来自 SKILL.md frontmatter)。
type Manifest struct {
	Version     string
	Title       string
	Description string
	Changelog   string
	Category    string
	Author      string
	Tags        []string
}

// FromSkillManifest 把技能清单转成发布内核的通用清单。
func FromSkillManifest(m *skillmanifest.Manifest) Manifest {
	return Manifest{
		Version: m.Version, Title: m.Title, Description: m.Description,
		Changelog: m.Changelog, Category: m.Category, Author: m.Author, Tags: m.Tags,
	}
}

// Result 是一次成功发布的结果。
type Result struct {
	Version  string
	Status   string
	Checksum string
}

// ErrOfficialLocked 官方内容锁定(0059): 非管理员发布官方 App 被拒。
var ErrOfficialLocked = errors.New("OFFICIAL_LOCKED")

// Publish 执行一次发布:锁定检查 → 版本语义 → 落库。
//
// 版本语义(决策 D1/D3),三条规则都以「该 App 的全部历史版本」为依据,
// 被拒与软删的版本同样占位——版本号一经使用即永久不可复用:
//  1. 同版本号已存在 → VERSION_EXISTS;
//  2. 内容与本人已提交过的某版本完全相同 → CONTENT_UNCHANGED;
//  3. 新版本号必须严格大于现有最高版本 → VERSION_NOT_INCREASING
//     (首次发布、即该 App 尚无任何版本时不适用)。
func Publish(db *sql.DB, req PublishRequest) (*Result, error) {
	if !skillmanifest.IsAppID(req.AppID) {
		return nil, newErr(http.StatusBadRequest, skillmanifest.CodeInvalidAppID,
			"名称不合法:必须是小写 kebab-case(如 my-skill)")
	}
	if req.Manifest.Version == "" || !skillmanifest.IsVersion(req.Manifest.Version) {
		return nil, newErr(http.StatusUnprocessableEntity, skillmanifest.CodeInvalidVersion,
			"版本号不合法:必须是 x.y.z")
	}
	if req.DeclaredVersion != "" && req.DeclaredVersion != req.Manifest.Version {
		return nil, newErr(http.StatusUnprocessableEntity, skillmanifest.CodeManifestMismatch,
			"表单版本(%s)与包内 version(%s)不一致,请以包内版本为准",
			req.DeclaredVersion, req.Manifest.Version)
	}

	// agentshare-4 / marketplace-4:把同一 (kind, app_id) 的发布串行化。
	//
	// 下面这一整段是「读归属/渠道/历史版本 → 写」的 check-then-act,跨多次
	// DB 往返;两个员工同时首次发布同一个新名字时,双方都能通过全部检查
	// (复核实测 18/20,本仓并发用例 20/20 双 201),后写者还会用无守卫
	// 的 `ON CONFLICT DO UPDATE SET title/description = excluded.*` 覆写赢家
	// 的展示名(owner 有 COALESCE 守卫,title/description 没有)。
	//
	// 按名字哈希取的事务级咨询锁把同名发布串行化:第二个请求等第一个提交后
	// 再读,于是看到赢家的 owner/版本并返回 409 NAME_TAKEN —— 落败的那次发布
	// 整体不落库,不存在「并入对手 App」或覆写元数据的窗口。
	//
	// N-2(2026-09-13 三轮,生产级死锁的真正修复):锁与落库**同一条连接、
	// 同一个事务**。
	//   - R2 的会话级锁虽然让「等锁者不占连接」,但**持锁者需要两条连接**
	//     (一条 hold 锁直到 Publish 结束,一条给落库事务)。池里同时坐着 N 个
	//     **不同名**的持锁者时池被占满且无人推进 —— 而不同名并发上传在生产里
	//     是正常负载(多人/多任务同时上传),不需要攻击者刻意制造同名竞争。
	//     实测 pool=2 两个不同名 → 3/3 轮死锁;pool=90 conc=100 → 20s 只完成
	//     10/100。
	//   - 现在用 `pg_advisory_xact_lock` 变体:锁属于**事务**,提交/回滚即释放
	//     (连 unlock 都不需要,也不可能把锁泄漏给池里的下一位使用者),而
	//     事务的每条读/写都在同一条连接上 ⇒ 连接需求恒为 1。
	//   - 等待者仍然**不占连接**:抢不到锁就立刻回滚(连接还回池)再退避重试,
	//     与 R2 的改进一致。抢锁总预算 10s,超时明确 503 而不是永久挂起;
	//     全部 DB 调用都带 ctx 超时(此前是 context.Background(),请求断开
	//     也不会取消)。
	// 锁定:被锁定的名字只能由管理员发布,员工命中即明确拒绝并回显理由。
	// 这一读必须在**取发布锁之前**完成:持锁期间连接需求必须恒为 1(任何
	// 走 db 池的读都要第二条连接,pool=1 时直接死锁 —— 见 beginPublishTx)。
	// 它与发布串行化无关:管理员加锁与发布之间本来也没有互斥。
	if !req.AdminPublish {
		if lock, err := serverstore.GetCapabilityLock(db, req.Kind, req.AppID); err == nil {
			msg := "该能力已被管理员锁定,仅管理员可发布"
			if lock.Reason != "" {
				msg += ":" + lock.Reason
			}
			return nil, newErr(http.StatusForbidden, CodeAppLocked, "%s", msg)
		} else if !errors.Is(err, serverstore.ErrNotFound) {
			return nil, newErr(http.StatusInternalServerError, "INTERNAL", "查询失败")
		}
	}

	// 说明:整个事务(含落库)受 publishTxBudget 约束,而「抢锁」另受
	// publishLockWait 约束 —— 两者分开,见 beginPublishTx。
	ctx, cancel := context.WithTimeout(context.Background(), publishTxBudget)
	defer cancel()
	tx, lerr := beginPublishTx(ctx, publishLockWait, db, req.Kind, req.AppID)
	if lerr != nil {
		// 抢锁超时不是「查询失败」:同名发布排队过久,应让调用方稍后重试,
		// 而不是回一个语义不明、也无法自助恢复的 500。
		if errors.Is(lerr, context.DeadlineExceeded) || errors.Is(lerr, context.Canceled) {
			return nil, newErr(http.StatusServiceUnavailable, CodePublishBusy,
				"同名内容正在发布,排队超时,请稍后重试")
		}
		return nil, newErr(http.StatusInternalServerError, "INTERNAL", "查询失败")
	}
	defer func() { _ = tx.Rollback() }()

	existingApp, appErr := serverstore.GetAppOn(tx, req.Kind, req.AppID)
	if appErr != nil && !errors.Is(appErr, serverstore.ErrNotFound) {
		return nil, newErr(http.StatusInternalServerError, "INTERNAL", "查询失败")
	}
	if appErr == nil && existingApp.Channel != req.Channel {
		return nil, newErr(http.StatusConflict, CodeNameTaken,
			"名称已被%s占用,请换个名字或联系管理员", channelLabel(existingApp.Channel))
	}
	// 下架冻结(第五轮审计 R5-B-1,2026-09-23):下架(apps.enabled=0)期间的
	// 内容**冻结** —— 不再接收新版本,直到管理员显式重新上架。
	//
	// 判据唯一实现在 serverstore.Distribution.Writable()(见 distribution.go
	// 的语义权威),本函数不再自己写 enabled 判断。为什么必须在这里拦:
	// 放行上传会产出「已批准但任何人(含作者)都看不见」的版本 —— 作者反复
	// 提交、管理员反复批准,而使用者永远看不到;而审批时自动上架又会让一位
	// 管理员静默撤销另一位管理员的下架动作。管理员重新上架(内部端点
	// PUT …/:name/enabled)才是唯一出口,且该动作本身有审计。
	//
	// 对管理员直发(AdminPublish)同样生效:规则没有角色例外,否则管理端仍能
	// 造出不可见版本。
	dist, derr := serverstore.AppDistributionOn(tx, req.Kind, req.AppID)
	if derr != nil {
		return nil, newErr(http.StatusInternalServerError, "INTERNAL", "查询失败")
	}
	if !dist.Writable() {
		return nil, newErr(http.StatusConflict, CodeAppDelisted,
			"该%s已下架，暂不能发布新版本：请先联系管理员重新上架", kindLabelOf(req.Kind))
	}
	// 官方内容锁定(0059): 归属官方的内容仅管理员可发布新版。
	if appErr == nil && existingApp.Official == 1 && !req.AdminPublish {
		return nil, newErr(http.StatusForbidden, CodeOfficialLocked,
			"官方%s仅管理员可上传", kindLabelOf(req.Kind))
	}
	// 归属保护(2026-09-02 收紧):他人的 App(任意状态,含空 owner 的历史
	// 行——空 owner 一律视同占名,杜绝员工「接管」成新 owner)不允许被其他
	// 非管理员接管发布。冲突语义 409 NAME_TAKEN + 明确「已被占用」提示
	// (2026-09-02 用户拍板:明确告知占用关系——注意不泄露「是谁/什么内容」,
	// 只告知该名称不可用;跨渠道同名互斥与归属保护同码同语义)。
	//
	// 判据同源(第五轮审计 R5-B-2):归属判定的唯一实现在
	// serverstore.AppOwnedByOwner —— 员工面「我的」分区读的是同一个函数,
	// 归属转移后两面立即一致(旧作者不再看到、也传不了;新归属人既看得到也
	// 传得了)。
	if appErr == nil && !req.AdminPublish && !serverstore.AppOwnedBy(*existingApp, req.Publisher) {
		return nil, newErr(http.StatusConflict, CodeNameTaken,
			"名称已被占用，无法上传：请更换名称或联系管理员")
	}

	history, err := serverstore.ListReleasesOn(tx, req.Kind, req.AppID)
	if err != nil {
		return nil, newErr(http.StatusInternalServerError, "INTERNAL", "查询失败")
	}
	newest := ""
	for _, h := range history {
		if h.Version == req.Manifest.Version {
			return nil, newErr(http.StatusConflict, CodeVersionExists,
				"版本 %s 已存在(每个版本都是不可修改的快照),请升版本号后重试", req.Manifest.Version)
		}
		if h.Checksum != "" && h.Checksum == req.Checksum && h.Publisher == req.Publisher {
			return nil, newErr(http.StatusConflict, CodeContentUnchanged,
				"内容与你已提交的 v%s 完全一致,无需重复上传", h.Version)
		}
		if newest == "" || skillmanifest.CompareVersions(h.Version, newest) > 0 {
			newest = h.Version
		}
	}
	if newest != "" && skillmanifest.CompareVersions(req.Manifest.Version, newest) <= 0 {
		return nil, newErr(http.StatusConflict, CodeVersionNotIncreasing,
			"版本号必须大于当前最高版本 v%s(当前包内为 %s)", newest, req.Manifest.Version)
	}
	// 非首个版本必须写更新说明(决策 §5.2):审核人与使用者据此判断该不该升级。
	// 该规则依赖「是否已有历史版本」,因此只能在发布内核里判定。
	if len(history) > 0 && strings.TrimSpace(req.Manifest.Changelog) == "" {
		return nil, newErr(http.StatusUnprocessableEntity, skillmanifest.CodeMissingField,
			"非首个版本必须填写 changelog(本版改了什么)")
	}

	// 待审配额(仅员工发布)。
	if !req.AdminPublish && req.PendingCap > 0 {
		n, err := serverstore.PendingReleaseCountOn(tx, req.Publisher)
		if err != nil {
			return nil, newErr(http.StatusInternalServerError, "INTERNAL", "查询失败")
		}
		if n >= req.PendingCap {
			return nil, newErr(http.StatusTooManyRequests, CodePendingLimit,
				"待审核数量已达上限(%d),请等待审核", req.PendingCap)
		}
	}

	owner := req.Publisher
	if appErr == nil {
		switch {
		case existingApp.Official == 1:
			// P2-21:官方归属恒为「官方」(owner=''),管理员给官方 App 发版
			// 不得把归属改写成发布者(否则蓝标消失、员工端变成个人维护)。
			owner = ""
		case existingApp.Owner != "":
			owner = existingApp.Owner
		}
	}
	enabled := 1
	if appErr == nil {
		enabled = existingApp.Enabled
	}
	status := serverstore.ReleaseStatusPending
	if req.AdminPublish {
		// 管理后台上架 = 已审核(与旧市场语义一致:上架即可分发)。
		status = serverstore.ReleaseStatusApproved
	}
	// 投影(审计 2026-09-23 G-P2-3):apps 行是**目录对全员下发的投影**
	// (title/description 直接来自这一行),而 app_releases 才是真相。
	// **待审版本没有生效,投影就必须一字不动** —— 否则作者提交一个"改名成
	// IT 密码重置"的待审版本,全公司立刻在目录里看到它(审核只剩"卡制品"),
	// 而它被拒绝后还会永久留在投影行上(没有任何自愈路径)。
	//
	// 这里刻意**显式传现值**(而不是靠 upsertApp 的冲突分支"恰好"不写这两列):
	// 不变量必须在调用方成立,与 DAO 的列集改动无关。取值与 WASM 面
	// (wasmapp/api/publish.go 的 projTitle/projDescription)逐条同形:
	//   - approved(管理员直发):投影就是本版元数据;
	//   - pending 且已有行    :投影保持现有值(读到的现值);
	//   - pending 且首版      :app_id 占位(空标题不是可接受的终态)。
	projTitle, projDescription := req.Manifest.Title, req.Manifest.Description
	if status == serverstore.ReleaseStatusPending {
		projTitle, projDescription = req.AppID, ""
		if appErr == nil {
			projTitle, projDescription = existingApp.Title, existingApp.Description
			if strings.TrimSpace(projTitle) == "" {
				projTitle = req.AppID
			}
		}
	}
	// P2-3:占名 + 建版本在同一事务内完成,CreateRelease 失败不会留下
	// 「占名无版本」的悬挂 App(名称被永久占用却无任何版本)。
	if _, err := serverstore.UpsertAppAndCreateReleaseOn(tx, &serverstore.App{
		Kind: req.Kind, AppID: req.AppID, Title: projTitle,
		Description: projDescription, Owner: owner, Channel: req.Channel, Enabled: enabled,
	}, &serverstore.Release{
		Kind: req.Kind, AppID: req.AppID, Version: req.Manifest.Version,
		Title: req.Manifest.Title, Description: req.Manifest.Description,
		Changelog: req.Manifest.Changelog, Category: req.Manifest.Category,
		Tags: req.Manifest.Tags, Author: req.Manifest.Author, Publisher: req.Publisher,
		Checksum: req.Checksum, Archive: req.Archive, Status: status,
	}); err != nil {
		// B7(2026-09-01):并发窗口内 (kind,app_id,version) 唯一约束兜底,
		// 映射为语义正确的 409 VERSION_EXISTS 而非 500。
		if errors.Is(err, serverstore.ErrDuplicate) {
			return nil, newErr(http.StatusConflict, CodeVersionExists,
				"版本 %s 已存在(每个版本都是不可修改的快照),请升版本号后重试", req.Manifest.Version)
		}
		return nil, newErr(http.StatusInternalServerError, "INTERNAL", "保存失败")
	}
	// 提交即释放事务级咨询锁(N-2);提交失败时 defer 的 Rollback 兜底。
	if err := tx.Commit(); err != nil {
		return nil, newErr(http.StatusInternalServerError, "INTERNAL", "保存失败")
	}
	return &Result{Version: req.Manifest.Version, Status: status, Checksum: req.Checksum}, nil
}

// beginPublishTx 取「发布串行化锁 + 落库」共用的那个事务(N-2)。
//
// 语义:成功返回的事务**已持有**该 (kind, app_id) 的事务级咨询锁,调用方在
// 同一事务里读归属/历史版本、写 app + release,提交时锁自动释放;失败返回
// nil + 错误(调用方据 context.DeadlineExceeded 回 503 PUBLISH_BUSY)。
//
// 为什么是事务级而不是会话级(这是 R2 → R3 的关键差别):
//   - 会话级锁必须由持锁连接显式 unlock,持锁者因此需要**两条**连接(锁一条、
//     落库一条):池里 N 个不同名的持锁者就把池占满且无人推进(实测 pool=2
//     两个不同名 → 3/3 轮死锁;pool=90 conc=100 → 20s 只完成 10/100)。
//   - 事务级锁连接需求恒为 1,提交/回滚即释放,也**不可能**把锁泄漏回池。
//
// 为什么等待者要「回滚 + 退避重试」而不是阻塞在锁上:阻塞等待会占着连接
// (同名风暴时池会被等待者坐满),而回滚后连接立刻还回池 —— 等待者零占用。
func beginPublishTx(ctx context.Context, lockBudget time.Duration, db *sql.DB, kind, appID string) (*sql.Tx, error) {
	key := publishLockKey(kind, appID)
	lockDeadline := time.Now().Add(lockBudget)
	for {
		// ctx 有比 lockBudget 更宽的预算(publishTxBudget):它同时约束
		// 「等池里放出连接」与「拿到事务后的一整段读写」。
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return nil, err
		}
		var locked bool
		if err := tx.QueryRowContext(ctx,
			`SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0))`, key).Scan(&locked); err != nil {
			_ = tx.Rollback()
			return nil, err
		}
		if locked {
			return tx, nil
		}
		// 关键:等待期间不占连接(否则同名风暴会把池坐满)。
		_ = tx.Rollback()
		if !time.Now().Before(lockDeadline) {
			return nil, context.DeadlineExceeded
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(publishLockPoll):
		}
	}
}

// publishLockKey 是咨询锁的键。
//
// F2-N9:此前锁键是 `pg_advisory_xact_lock(hashtext($1), hashtext($2))` ——
// 两段 32 位 hashtext 碰撞是真实存在的(实测 "app-1481649" 与 "app-16327"
// 同键),无关的发布会被互相串行(叠加 F2-N2 时还会拉高死锁概率)。整键交给
// 64 位的 hashtextextended,碰撞概率降到可忽略。
func publishLockKey(kind, appID string) string {
	return "picoaide:publish:" + kind + "/" + appID
}

// channelLabel 把分发渠道渲染成人类可读的名字（用于"名称已被 X 占用"这类提示）。
//
// ⚠️ §11 第 4 项明确要求：**两个未知值回落点都要加 wasm 分支** —— 否则
// wasm 应用撞名时会显示"名称已被组织共享库占用"，而它根本不在组织共享库里，
// 会把发布者（以及替他排查的 AI）引向完全错误的方向。
func channelLabel(channel string) string {
	switch channel {
	case serverstore.AppChannelMarket:
		return "市场"
	case serverstore.AppChannelWasm:
		return "应用（WASM）"
	}
	return "组织共享库"
}

// kindLabelOf 官方锁定提示用(与 channelLabel 同风格)。
func kindLabelOf(kind string) string {
	switch kind {
	case "agent":
		return "智能体"
	case serverstore.AppKindWasmApp:
		return "应用"
	}
	return "技能"
}
