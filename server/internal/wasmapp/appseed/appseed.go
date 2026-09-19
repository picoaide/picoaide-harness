// Package appseed 把随镜像分发的**内置演示应用**播种进平台（2026-09-19 用户要求：
// 「代码仓库里也要有几个 demo，各种权限模式的，安装以后就能给客户演示。这个应该是
// 系统安装以后直接带的展示，可以删除的」）。
//
// 设计要点（三条都来自那句话）：
//
//  1. **装在镜像里、装完即用**：演示制品由 Dockerfile 构建进
//     `/opt/picoaide/demo-apps/`（`app.wasm` + `demos.json` 清单），服务端启动时播种；
//     没有目录 ⇒ 静默跳过（源码构建/自定义镜像可以不带演示）。
//  2. **各种权限模式**：同一份 wasm 按清单播种成 public / login / whitelist 三个应用
//     （准入模式是平台侧配置；whitelist 的名单比对按 R24 由**应用自己**读配置完成）。
//  3. **可删除，且删除后不再重建**：播种判据是"库里是否**存在**这个 app_id"——
//     软删的行仍在（R37 保留期），因此管理员删掉演示应用后，重启服务端也不会把它塞回来。
//
// 播种**不走 HTTP 发布链路**（那条路要 gin 上下文、上传配额与客户端身份），而是直接落
// `apps` + `app_releases`（status=approved，与"发布即上架"同形）。代价是不做编译期
// 校验，因此这里补一道**结构性校验**（魔数 + 必须导出 _start/memory），把"拿错文件"
// 这类失败挡在播种之前；真正的编译由执行侧首次请求时完成（磁盘编译缓存会持久化）。
package appseed

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/appcfg"
	"github.com/picoaide/picoaide/internal/wasmapp/assets"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/registry"
)

// ManifestFileName 是演示清单文件名（与 app.wasm 同在演示目录）。
const ManifestFileName = "demos.json"

// defaultVersion 是演示应用的版本号（演示不涉及升级，固定 1.0.0）。
const defaultVersion = "1.0.0"

// Demo 是清单里的一条演示定义。
type Demo struct {
	// AppID 是域名标签（<app_id>.<基域>），必须符合 registry 的规则。
	AppID string `json:"app_id"`
	// Title 是应用中心显示名。
	Title string `json:"title"`
	// Description 是列表里的说明。
	Description string `json:"description"`
	// Access 是准入模式：public / login / whitelist。
	Access string `json:"access"`
	// Whitelist 只在 access=whitelist 时有意义；播种时会补上归属人账号
	// （否则连管理员自己都进不去，演示没法开场）。
	Whitelist []string `json:"whitelist,omitempty"`
	// Purpose / DataSensitivity 走应用元数据（列表与审计里可见）。
	Purpose         string `json:"purpose,omitempty"`
	DataSensitivity string `json:"data_sensitivity,omitempty"`
}

// manifest 是 demos.json 的结构。
type manifest struct {
	Demos []Demo `json:"demos"`
}

// Options 是播种参数。
type Options struct {
	DB *sql.DB
	// DataRoot 是平台数据根（资源目录 = <DataRoot>/<AppsDirName>/<app_id>/<AssetsDirName>/<release_id>/）。
	// 必填：应用子域管线要求**每个版本都有资源目录**（缺了会在请求时 500），
	// 演示应用至少要能读到自己的 picoaide.app.json。
	DataRoot string
	Dir      string
	// Owner 是演示应用的归属账号（必须是已存在的用户；生产装配传超管用户名）。
	// 归属决定"谁能删它"：管理员可删任意应用，普通账号只能删自己的。
	Owner string
	// Logger 记录播种结果（nil ⇒ 不记）。
	Logger func(format string, args ...any)
	// Audit 写审计（nil ⇒ 只记日志）。动作名与客户端面同一套。
	Audit func(username, action, detail string)
}

// Seeder 是加载好的播种器。
type Seeder struct {
	opt    Options
	demos  []Demo
	wasm   []byte
	sum    string
	logger func(format string, args ...any)
}

// SkipReason 说明某个演示为什么没有播种。
type SkipReason struct {
	AppID string
	// Reason 是**给人看的**如实理由（"已存在但资源目录不完整（…）⇒ 已重写"这类）。
	Reason string
	// Healed 表示这次"跳过"之前其实**动了手**（半成品自愈：重写资源目录 / 补版本行 /
	// 指向生效版本）。
	//
	// 为什么要有这个机器可读的布尔（第三轮审计 P3-4）：理由文案是诊断面的一部分、会随
	// 措辞演进，而"自愈是否幂等""完好文件是否被动过"这类断言不该靠匹配中文措辞 ——
	// 它们要的是"这一趟到底写没写字节"这一事实。
	Healed bool
}

// Result 是一次播种的结果。
type Result struct {
	Seeded  []string
	Skipped []SkipReason
}

// New 读取演示目录（缺失 ⇒ 返回 (nil, nil)，调用方据此跳过播种）。
func New(opt Options) (*Seeder, error) {
	if opt.DB == nil {
		return nil, errors.New("appseed: Options.DB 必填")
	}
	if strings.TrimSpace(opt.DataRoot) == "" {
		return nil, errors.New("appseed: Options.DataRoot 必填（要写版本资源目录）")
	}
	dir := strings.TrimSpace(opt.Dir)
	if dir == "" {
		return nil, nil
	}
	raw, err := os.ReadFile(filepath.Join(dir, ManifestFileName))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil // 镜像里没有演示：正常情况（源码构建）
		}
		return nil, fmt.Errorf("appseed: 读清单失败: %w", err)
	}
	var m manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("appseed: 清单不是合法 JSON: %w", err)
	}
	if len(m.Demos) == 0 {
		return nil, nil
	}
	wasm, err := os.ReadFile(filepath.Join(dir, "app.wasm"))
	if err != nil {
		return nil, fmt.Errorf("appseed: 读演示制品失败: %w", err)
	}
	if berr := validateWasm(wasm); berr != nil {
		return nil, berr
	}
	sum := sha256.Sum256(wasm)
	logger := opt.Logger
	if logger == nil {
		logger = func(string, ...any) {}
	}
	return &Seeder{opt: opt, demos: m.Demos, wasm: wasm, sum: hex.EncodeToString(sum[:]), logger: logger}, nil
}

// Demos 返回清单里的演示定义（诊断/测试用）。
func (s *Seeder) Demos() []Demo {
	if s == nil {
		return nil
	}
	return append([]Demo(nil), s.demos...)
}

// Seed 播种全部缺失的演示应用；已存在（含已删除/已冻结）的一律跳过。
//
// 唯一的例外是**半成品**（库里已存在、但资源目录或生效版本缺一项）：那是上一次播种
// 中途失败的残留，只跳过就会永久留着（重启不自愈）⇒ 这里补齐（见 healIncomplete）。
// 已软删/已冻结的演示**不补**（"删了不再回来"是产品语义）。
//
// W4-7（2026-09-19「客户端专属」改造）：演示应用**保留 app_id**（历史行里有既存数据：
// 归属、版本行、资源目录，改名等于把客户场上已有的演示再塞一份），清单口径的变更
// （access 由 public 收敛为 login、标题去掉"匿名可达"）**只对新建行生效** ——
// 已存在的行一律跳过，heal 也**不覆盖标题/配置**（标题以库里既有行为准，见 seedOne）。
// 已存在行的 access 归迁移 0074 改、磁盘资产归 RewritePublicAccessAssets 改，
// 都不是播种的职责（播种只负责"缺失的那些"）。
func (s *Seeder) Seed(ctx context.Context) (Result, error) {
	var res Result
	if s == nil {
		return res, nil
	}
	for _, d := range s.demos {
		appID := registry.NormalizeAppID(d.AppID)
		if appID == "" {
			res.Skipped = append(res.Skipped, SkipReason{AppID: d.AppID, Reason: "app_id 非法（清单错误）"})
			continue
		}
		existing, err := serverstore.GetWasmApp(ctx, s.opt.DB, appID)
		switch {
		case err == nil:
			// 存在即跳过：**这是"删了不再回来"的实现**（软删的行仍存在）。
			//
			// 但"跳过"的理由必须与真实行为一致（第三轮审计 P3-4）：库里存在**不等于**
			// 交付面完整 —— 半分片的配置（存在但是坏 JSON）此前会被笼统记成"已存在"，
			// 而线上每请求 500、重启也不自愈。因此理由由 healIncomplete 逐态给出。
			out, herr := s.healIncomplete(ctx, appID, existing, d)
			if herr != nil {
				// 补齐失败如实记录（与播种失败同一处置：不阻断其它演示）。
				res.Skipped = append(res.Skipped, SkipReason{AppID: appID, Reason: "补齐半成品失败: " + herr.Error()})
				continue
			}
			if out.Healed {
				s.logger("appseed: 已修复内置演示应用 %s 的半成品（%s）", appID, out.Reason)
			}
			res.Skipped = append(res.Skipped, SkipReason{AppID: appID, Reason: out.Reason, Healed: out.Healed})
			continue
		case !errors.Is(err, serverstore.ErrNotFound):
			res.Skipped = append(res.Skipped, SkipReason{AppID: appID, Reason: "查询失败: " + err.Error()})
			continue
		}
		if err := s.seedOne(ctx, d, appID); err != nil {
			res.Skipped = append(res.Skipped, SkipReason{AppID: appID, Reason: "播种失败: " + err.Error()})
			continue
		}
		res.Seeded = append(res.Seeded, appID)
		s.logger("appseed: 已播种内置演示应用 %s（access=%s，owner=%s）", appID, d.Access, s.opt.Owner)
		if s.opt.Audit != nil {
			s.opt.Audit(s.opt.Owner, "wasm_app_seed",
				fmt.Sprintf("内置演示应用 %s（%s，access=%s）随安装播种", appID, d.Title, d.Access))
		}
	}
	return res, nil
}

// seedOne 播种单个演示：apps 行 + 一个 approved 版本 + 指向它 + 上架。
func (s *Seeder) seedOne(ctx context.Context, d Demo, appID string) error {
	cfgJSON, err := s.demoConfigJSON(d)
	if err != nil {
		return err
	}
	purpose, sensitivity := d.Purpose, d.DataSensitivity
	app := serverstore.WasmApp{
		AppID: appID,
		// ⚠️ 只有**新建行**才写清单里的标题/描述（W4-7）：已存在的行走 healIncomplete，
		// 它一个字节都不改标题（改清单文案不得把客户场上已有演示的标题覆盖掉）。
		Title:           strings.TrimSpace(d.Title),
		Description:     strings.TrimSpace(d.Description),
		Owner:           s.opt.Owner,
		Channel:         serverstore.AppChannelWasm,
		Enabled:         true,
		Purpose:         purpose,
		DataSensitivity: sensitivity,
		ConfigJSON:      cfgJSON,
	}
	if err := serverstore.UpsertWasmApp(ctx, s.opt.DB, app); err != nil {
		return fmt.Errorf("写应用行: %w", err)
	}
	relID, err := s.createSeedRelease(ctx, appID, app.Title, app.Description, cfgJSON)
	if err != nil {
		return err
	}
	// 资源目录：应用子域管线按 <data_root>/apps/<app_id>/assets/<release_id>/ 推导，
	// **缺了直接 500**（不是可选项）。演示应用把配置写进去（应用自己 assets.read 读它）。
	//
	// ⚠️ 顺序是不变量（R1-rt-19）：**资源目录先写、失败则不置当前版本** —— 与
	// api/publish.go 的同一条顺序一致（"否则会有一个窗口让应用指向一个资源目录还不存在的
	// 版本"）。反过来写会留下指向不存在目录的应用：子域每请求 500，而且播种判据是
	// "库里是否已有该 app_id" ⇒ 重启也不自愈。
	//
	// 两个写动作都不建新版本：资源目录写失败 ⇒ 应用行/版本行已在，下次播种由
	// healIncomplete 补齐（幂等，不需要人工删行）。
	if err := writeReleaseAssets(s.opt.DataRoot, appID, relID, cfgJSON); err != nil {
		return err
	}
	if err := serverstore.SetWasmAppCurrentRelease(ctx, s.opt.DB, appID, relID); err != nil {
		return fmt.Errorf("指向当前版本: %w", err)
	}
	return nil
}

// demoConfigJSON 把一条演示定义折算成应用配置 JSON（播种的唯一一份实现）。
//
// 抽取的理由：播种（seedOne）与"补齐缺版本行的半成品"（healMissingRelease）必须写出
// **逐字节相同**的配置 —— 后者还要拿它当"这个 app_id 是不是我们播的"的判据
// （两处各拼一份，判据迟早与播种产物漂移，于是半成品永远补不上）。
func (s *Seeder) demoConfigJSON(d Demo) (string, error) {
	cfg := appcfg.Config{
		Access:          appcfg.Access(strings.TrimSpace(d.Access)),
		Purpose:         d.Purpose,
		DataSensitivity: d.DataSensitivity,
		Owner:           s.opt.Owner,
	}
	if cfg.Access == "" {
		cfg.Access = appcfg.AccessDefault
	}
	// whitelist：清单里的名单 + 归属人自己（否则演示开场就 403）。
	if cfg.Access == appcfg.AccessWhitelist {
		seen := map[string]bool{}
		var list []string
		for _, n := range append([]string{s.opt.Owner}, d.Whitelist...) {
			n = strings.TrimSpace(n)
			if n == "" || seen[strings.ToLower(n)] {
				continue
			}
			seen[strings.ToLower(n)] = true
			list = append(list, n)
		}
		cfg.Whitelist = list
	}
	// 配置 JSON 的形态与作者手写的一致（appcfg 负责解析/校验；写出用标准 json）。
	raw, err := json.Marshal(cfg)
	if err != nil {
		return "", fmt.Errorf("编码应用配置: %w", err)
	}
	if _, perr := appcfg.Parse(raw); perr != nil {
		return "", fmt.Errorf("应用配置不合规: %v", perr)
	}
	return string(raw), nil
}

// createSeedRelease 写下一个内置版本行（approved，带随安装的制品字节）。
//
// 抽取同一份实现的两个调用点：首次播种（seedOne）与"补齐缺版本行"（healMissingRelease）。
// 版本号固定 defaultVersion、publisher 固定归属人、changelog 同一句话 —— 三处若各写一份，
// "补齐出来的版本行"就会与真实播种产物不是同一形态（审计面/归属都会漂移）。
func (s *Seeder) createSeedRelease(ctx context.Context, appID, title, description, cfgJSON string) (int64, error) {
	return serverstore.CreateWasmRelease(ctx, s.opt.DB, serverstore.WasmRelease{
		AppID:       appID,
		Version:     defaultVersion,
		Title:       title,
		Description: description,
		Changelog:   "随安装内置的演示应用",
		Publisher:   s.opt.Owner,
		Checksum:    s.sum,
		Size:        int64(len(s.wasm)),
		Status:      serverstore.ReleaseStatusApproved,
		Wasm:        s.wasm,
		ConfigJSON:  cfgJSON,
	})
}

// healOutcome 说明自愈这一趟**做了什么、或为什么没做**。
//
// 为什么不是一个 bool（第三轮审计 P3-4）：播种日志/SkipReason 里的"已存在"是**误导性**的
// 笼统理由 —— 库里存在不等于交付面完整（配置半写、目录缺失都能让子域每请求 500）。理由必须
// 与真实行为一致，所以由判定处逐态给出（既要能说"已存在但内容不完整 ⇒ 重写"，
// 也要能说"已存在且内容完整（幂等跳过）"）。
type healOutcome struct {
	// Healed 表示这一趟真的写了字节（日志按它决定是否记"已修复"）。
	Healed bool
	// Reason 是**如实**的处置理由（进日志与 SkipReason）。
	Reason string
}

// healIncomplete 补齐"库里已存在、但处于半成品"的演示应用（R1-rt-19 的自愈那一半）。
//
// 半成品只有三种形态（其余一律不碰）：
//
//	A. 没有生效版本（current_release_id = 0），但**有** approved 版本行：旧顺序在"置当前
//	   版本"之后写资源目录失败 ⇒ 库里留着应用行 + 版本行，却没有指向它的当前版本。旧实现
//	   按"存在即跳过"会把这份半成品永久留着（子域 404/500，重启也不变）。
//	A2. 有应用行但**一个版本行都没有**：seedOne 的 CreateWasmRelease 失败（PG 抖动/磁盘满/
//	   连接中断）就会留下这个状态。旧实现把它当"同名应用不是我们播的"跳过 ⇒ 应用永久没有
//	   可交付版本，日志还说"已存在"（R2-DG-4）。判据只认内容：归属人 + 配置与本次清单
//	   逐字节相同（版本行不存在时没有 checksum 可对）。
//	B. 有生效版本，但资源目录（或目录里的 picoaide.app.json）**不在或内容不完整**：
//	   应用子域按"最新 approved 版本"推导目录 ⇒ 每请求 500。数据盘被换过、目录被手工
//	   删掉、写盘中途被打断（半写配置）都会落到这一支。
//
// ⚠️ "完整"的判据必须是**内容级**（第三轮审计 P3-4）：旧判据 `os.Stat` 成功即完整，
// 于是"存在但被截断"的配置永不修复、日志还说"已存在"，线上每请求 500 —— 只有人工删掉
// 文件才触发补齐。现在的判据是：文件在 **且** 能过 `appcfg.Parse`（合法 JSON + 必需字段
// 齐备）**且** 归属人与随安装清单一致 **且** 与生效版本的配置快照逐字节相同。
//
// 补齐动作为什么安全（幂等、只碰自己的东西）：
//   - 只认 checksum 与**本次随安装的演示制品逐字节相同**的版本行（s.sum）——app_id 被别人
//     占用/被重新发布的情况下一律不碰（判断依据是内容，不是名字；A2 没有版本行时退化为
//     对应用行做同一口径的内容比对）；
//   - 只做三件事：写回资源目录（应用配置来自该版本行的快照）+ 在没有生效版本时把它指过去 +
//     A2 补一条内容与 seedOne 逐字节相同的版本行，不改配置、不改标题、不写审计；
//   - 资源目录**内容完整**就一个字节都不写（idempotent：二次播种只跳过，且是原子替换，
//     不存在"半写"窗口）。
//
// 三种处置态**一律不补**（软删 / 冻结 / 下架）：它们表达的都是"不要再服务它"
// （子域分别返回 404 / 404 / 410），此时把资源目录写回来与产品语义相反（R2-DG-5）。
//
// 返回值：out 说明处置与理由；err 只在 IO/DB 失败时非 nil。
func (s *Seeder) healIncomplete(ctx context.Context, appID string, app *serverstore.WasmApp, d Demo) (healOutcome, error) {
	if app == nil || app.DeletedAt != nil || app.FrozenAt != nil || !app.Enabled {
		// 软删 = "删了不再回来"；冻结 = 管理员的只读处置；**下架（enabled=false）也算
		// "不要再服务它"**（子域对下架应用直接 410，见 appserver.serveWasm）。
		// 三者都不是"半成品"，不补 —— 否则管理员"下架 + 腾磁盘"之后，重启会把资源
		// 目录悄悄写回来，与"删了不再回来"的产品语义相反（R2-DG-5）。
		// 代价认账：下架期间不补；管理员重新上架后，下一次重启/重新播种会把资源目录
		// 补齐（下架态永远不服务，所以这个窗口不会让用户看到 500）。
		return healOutcome{Reason: "已存在且处于软删/冻结/下架态（按产品语义不补）"}, nil
	}
	relID := app.CurrentReleaseID
	if relID <= 0 {
		// A：找我们这一版（演示版本号固定 defaultVersion），并核对制品指纹与审核态。
		rel, err := serverstore.GetWasmRelease(ctx, s.opt.DB, appID, defaultVersion)
		switch {
		case errors.Is(err, serverstore.ErrNotFound):
			// A2（第三种半成品，R2-DG-4）：apps 行已落，但**一个版本行都没有** ——
			// seedOne 的 CreateWasmRelease 失败（PG 抖动/磁盘满/连接中断）就会留下这个
			// 状态。旧实现把它当"同名应用不是我们播的"跳过 ⇒ 该应用永久没有可交付版本
			//（子域 404/500），而日志给的理由是误导性的"已存在"。
			return s.healMissingRelease(ctx, appID, app, d)
		case err != nil:
			return healOutcome{}, fmt.Errorf("查演示版本行: %w", err)
		}
		if rel.Status != serverstore.ReleaseStatusApproved || rel.Checksum != s.sum {
			// 状态/制品不是随安装的这一份：不碰（理由如实给出，别笼统说"已存在"）。
			return healOutcome{Reason: "已存在但版本行不是随安装播种的那一份（不碰）"}, nil
		}
		relID = rel.ID
		if why := s.releaseAssetsIncompleteReason(appID, relID, rel.ConfigJSON); why != "" {
			if err := writeReleaseAssets(s.opt.DataRoot, appID, relID, rel.ConfigJSON); err != nil {
				return healOutcome{}, err
			}
			healed := healOutcome{Healed: true, Reason: "已存在但资源目录不完整（" + why + "）⇒ 已重写"}
			if err := serverstore.SetWasmAppCurrentRelease(ctx, s.opt.DB, appID, relID); err != nil {
				return healOutcome{}, fmt.Errorf("指向当前版本: %w", err)
			}
			return healed, nil
		}
		// 资源目录内容完整：只把生效版本指过去（没有写盘）。
		if err := serverstore.SetWasmAppCurrentRelease(ctx, s.opt.DB, appID, relID); err != nil {
			return healOutcome{}, fmt.Errorf("指向当前版本: %w", err)
		}
		return healOutcome{Healed: true, Reason: "已存在但缺生效版本（资源目录完整）⇒ 已指向该版本"}, nil
	}

	// B：有生效版本时先确认"生效的那一版"确实是我们的制品（判据 = 最新 approved 版本
	// 既是当前版本、checksum 又与随安装的演示一致）。
	rel, err := serverstore.LatestApprovedWasmReleaseMeta(ctx, s.opt.DB, appID)
	if err != nil || rel == nil || rel.ID != relID || rel.Checksum != s.sum {
		return healOutcome{Reason: "已存在但生效版本不是随安装播种的那一份（不碰）"}, nil
	}
	if why := s.releaseAssetsIncompleteReason(appID, relID, rel.ConfigJSON); why != "" {
		if err := writeReleaseAssets(s.opt.DataRoot, appID, relID, rel.ConfigJSON); err != nil {
			return healOutcome{}, err
		}
		return healOutcome{Healed: true, Reason: "已存在但资源目录不完整（" + why + "）⇒ 已重写"}, nil
	}
	return healOutcome{Reason: "已存在且资源目录内容完整（幂等跳过）"}, nil
}

// healMissingRelease 补上"apps 行已落但没有任何版本行"的半成品（R2-DG-4）。
//
// 身份判据只认**内容**（与 healIncomplete 其余分支同一精神）：app 行的归属人与配置必须与
// 本次清单要播的那一份逐字节相同 —— 同名但由别人发布/配置不同的应用一律不碰。版本行
// 不存在时没有 checksum 可对，配置就是唯一可用的"这是我们播的"锚点。
//
// 只做三件事：补版本行（内容与 seedOne 逐字节相同）、写资源目录、置生效版本；不新建
// app 行、不改标题/配置、不写审计。
func (s *Seeder) healMissingRelease(ctx context.Context, appID string, app *serverstore.WasmApp, d Demo) (healOutcome, error) {
	cfgJSON, err := s.demoConfigJSON(d)
	if err != nil {
		return healOutcome{}, err
	}
	if app.Owner != s.opt.Owner || app.ConfigJSON != cfgJSON {
		// 不是随安装播种出来的那一份：不碰（理由如实给出）。
		return healOutcome{Reason: "已存在但不是随安装播种的那一份（归属人或配置不同，不碰）"}, nil
	}
	// 有任何版本行（含软删）就说明这不是"版本行没落"的形态 ⇒ 交给别处的处置，不在这里补。
	rels, err := serverstore.ListWasmReleases(ctx, s.opt.DB, appID, true)
	if err != nil {
		return healOutcome{}, fmt.Errorf("查版本行: %w", err)
	}
	if len(rels) > 0 {
		return healOutcome{Reason: "已存在且已有版本行（不是本次能补的半成品形态）"}, nil
	}
	relID, err := s.createSeedRelease(ctx, appID, app.Title, app.Description, cfgJSON)
	if err != nil {
		return healOutcome{}, fmt.Errorf("重建版本行: %w", err)
	}
	if err := writeReleaseAssets(s.opt.DataRoot, appID, relID, cfgJSON); err != nil {
		return healOutcome{}, err
	}
	if err := serverstore.SetWasmAppCurrentRelease(ctx, s.opt.DB, appID, relID); err != nil {
		return healOutcome{}, fmt.Errorf("指向当前版本: %w", err)
	}
	return healOutcome{Healed: true, Reason: "已存在但一个版本行都没有（上次播种中断）⇒ 已重建版本行与资源目录"}, nil
}

// releaseAssetsIncompleteReason 判断版本的资源目录里那份应用配置**是否完整**：
// 完整返回 ""，不完整返回**如实的原因**（它会进日志与 SkipReason）。
//
// 判据是**内容级**的四个条件（第三轮审计 P3-4，旧实现只做 os.Stat —— "存在"不等于"完整"）：
//
//  1. 文件在且可读（不存在/不可读 ⇒ 不完整；目录存在但没有配置同样是每请求 500）；
//  2. 能过 `appcfg.Parse`：合法 JSON 对象 + 必需字段齐备 + 取值合规
//     （半写/截断的配置在这里被抓住）；
//  3. **归属人一致**（与 healMissingRelease 的"这是我们播的"同一口径）：配置里的 owner
//     必须等于本次播种的归属人，防止把别人发布的同名应用当成自家半成品改写；
//  4. 与生效版本的配置快照**逐字节相同**（wantCfgJSON 非空时才比）——资源目录里的这份是
//     请求路径真正读的那一份，与库里那份不一致时，导出/准入会各说各话。
//
// 判据取**内容**而不是"文件在不在"，正是为了让"存在但被截断"的半写形态可自愈：
// 写盘被打断（崩溃/磁盘满/断电）会留下坏配置，而请求路径（loadAppConfig）对坏配置是
// fail-loud 500 —— 不修的话线上每请求 500，且重启也不自愈，只能人工删文件。
func (s *Seeder) releaseAssetsIncompleteReason(appID string, relID int64, wantCfgJSON string) string {
	cfgPath := releaseAssetsConfigPath(s.opt.DataRoot, appID, relID)
	raw, err := os.ReadFile(cfgPath)
	switch {
	case os.IsNotExist(err):
		return "资源目录里没有应用配置"
	case err != nil:
		return "应用配置不可读: " + err.Error()
	}
	cfg, perr := appcfg.Parse(raw)
	if perr != nil {
		return "应用配置内容不完整（" + perr.Message + "）"
	}
	if cfg.Owner != s.opt.Owner {
		return "应用配置的归属人与随安装清单不一致（" + cfg.Owner + " ≠ " + s.opt.Owner + "）"
	}
	if wantCfgJSON != "" && string(raw) != wantCfgJSON {
		return "应用配置与生效版本的配置快照不一致"
	}
	return ""
}

// releaseAssetsConfigPath 返回版本资源目录里应用配置的路径（唯一推导点，写与判据共用）。
func releaseAssetsConfigPath(dataRoot, appID string, relID int64) string {
	return filepath.Join(dataRoot, limits.AppsDirName, appID, assets.AssetsDirName,
		strconv.FormatInt(relID, 10), limits.AppConfigFileName)
}

// writeReleaseAssets 写出版本的资源目录（只放应用配置；演示应用没有额外的静态资源）。
//
// 写盘是**原子替换**：先写同目录的隐藏临时文件、fsync、再 rename。为什么必须原子
// （第三轮审计 P3-4 的成因）：`os.WriteFile` 是 O_TRUNC 后写，崩溃/磁盘满/断电落在中间
// 就留下"存在但被截断"的配置 —— 请求路径对它是 500，而"存在即完整"的自愈判据又不会修，
// 症状比"文件缺失"隐蔽得多（文件缺失至少能触发补齐）。rename 之后读到的永远是旧内容或
// 新内容，不会读到半写。
func writeReleaseAssets(dataRoot, appID string, relID int64, cfgJSON string) error {
	cfgPath := releaseAssetsConfigPath(dataRoot, appID, relID)
	dir := filepath.Dir(cfgPath)
	if err := os.MkdirAll(dir, os.FileMode(limits.DataDirMode)); err != nil {
		return fmt.Errorf("创建资源目录: %w", err)
	}
	tmp, err := os.CreateTemp(dir, "."+limits.AppConfigFileName+".tmp*")
	if err != nil {
		return fmt.Errorf("创建应用配置临时文件: %w", err)
	}
	tmpName := tmp.Name()
	// rename 成功后这次 Remove 是 no-op（ENOENT）；失败路径则由它清掉临时文件。
	defer func() { _ = os.Remove(tmpName) }()
	if _, err := tmp.WriteString(cfgJSON); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("写应用配置: %w", err)
	}
	// 先落盘再 rename：否则断电后可能留下"名字是对的、内容是空的"文件（比缺文件更难查）。
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("落盘应用配置: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("关闭应用配置临时文件: %w", err)
	}
	// CreateTemp 的权限是 0600，改成与其他资源文件一致的 0644（内容本来就是交付给应用的）。
	if err := os.Chmod(tmpName, 0o644); err != nil {
		return fmt.Errorf("设置应用配置权限: %w", err)
	}
	if err := os.Rename(tmpName, cfgPath); err != nil {
		return fmt.Errorf("替换应用配置: %w", err)
	}
	return nil
}

// ===== W4：磁盘资产里的 access=public 归一化（设计 §9 的 A 方案）=====

// AssetRewriteProblem 描述一个**被跳过**的磁盘资产（诊断用：为什么没改成）。
type AssetRewriteProblem struct {
	AppID     string
	ReleaseID int64
	Path      string
	Reason    string
}

// AssetRewriteResult 是一次磁盘资产改写的统计。
type AssetRewriteResult struct {
	// Apps / Releases 是扫过的应用数与版本数（含已软删的应用与版本：目录可能还在，
	// 留着 public 就是"口径没有退场"）。
	Apps     int
	Releases int
	// Files 是成功解析的应用配置数（真正能判定 access 的那些）。
	Files int
	// Rewritten 是命中**历史公开档位**并已原子改写的文件数。
	Rewritten int
	// Missing 是资源目录里没有配置的版本（未播种 / 制品已回收）—— **不是失败**，
	// 单独计数以免把"本来就没有"混进"改不动"。
	Missing int
	// Skipped 是读不到 / 坏 JSON / 写失败的文件数（单个失败不中断整轮）。
	Skipped int
	// Problems 逐个列出被跳过的文件（Skipped 的明细，调用方记日志用）。
	Problems []AssetRewriteProblem
}

// RewritePublicAccessAssets 把**磁盘资产**里 `access=public` 的应用配置一次性改写为
// `login`（设计 §9 的 A 方案；与迁移 0074 的 DB 侧配套）。
//
// 为什么磁盘侧也必须改（§9 事实订正 ②）：运行期权威在磁盘资产
// （`<data_root>/apps/<app_id>/assets/<release_id>/picoaide.app.json`，应用自己
// `assets.read` 读它），而读侧早已把历史 public 映射成 login（appcfg.AuthMode）。
// 因此改写的真实意义**不是"改权限"**（权限早已不生效），而是让应用自读配置时
// **不再看到 public**、口径彻底退场 —— 否则应用可能照着配置自行实现一套"匿名可用"
// 行为。只改 DB 不改磁盘 ⇒ 磁盘上永久残留 public，验收 SQL 之外的这一面永远不干净。
//
// 语义：
//   - 遍历库里**全部** wasm 应用（含软删）的全部版本（含软删版本），路径推导走
//     releaseAssetsConfigPath（唯一实现，与写入/自愈共用同一份）；
//   - 只改 `"access"` 这一个键的值（public ⇒ login），其余键**逐字保留**（见
//     rewritePublicAccessJSON：不做整体 re-marshal）；
//   - 命中才写，且走 writeReleaseAssets 的 temp + fsync + rename 原子替换
//     （权限 0644、临时文件由 defer 清理）；
//   - 幂等：第二次调用 0 命中（login 不再是 public），不产生任何字节变化。
//
// 失败语义（设计 §9 + W4-6）：单个文件读不到 / 坏 JSON / 写失败 ⇒ **跳过并计数**，
// 不 panic、不中断整轮；跳过数量由返回值给出（Skipped + Problems 逐条原因），
// 调用方必须记日志。只有"枚举应用/版本"这类 DB 失败才返回 error —— 那意味着这一轮
// 根本没跑起来（全体都没扫），不能伪装成"跳过了几个文件"。
func RewritePublicAccessAssets(ctx context.Context, db *sql.DB, dataRoot string, logger func(format string, args ...any)) (AssetRewriteResult, error) {
	var res AssetRewriteResult
	if db == nil {
		return res, errors.New("appseed: 磁盘资产改写需要 DB（要枚举 wasm 应用与版本）")
	}
	if strings.TrimSpace(dataRoot) == "" {
		return res, errors.New("appseed: 磁盘资产改写需要 DataRoot（磁盘资产的落点）")
	}
	if logger == nil {
		logger = func(string, ...any) {}
	}
	// 含软删：目录可能还在（资源回收与行退役不是同一时刻），残留的 public 同样要退场。
	apps, err := serverstore.ListWasmApps(ctx, db, serverstore.WasmAppFilter{IncludeDeleted: true})
	if err != nil {
		return res, fmt.Errorf("appseed: 列 wasm 应用: %w", err)
	}
	res.Apps = len(apps)
	skip := func(appID string, relID int64, path, reason string) {
		res.Skipped++
		res.Problems = append(res.Problems, AssetRewriteProblem{AppID: appID, ReleaseID: relID, Path: path, Reason: reason})
		if path == "" {
			logger("appseed: 跳过磁盘资产改写（应用 %s）：%s", appID, reason)
			return
		}
		logger("appseed: 跳过磁盘资产 %s（%s）", path, reason)
	}
	for _, app := range apps {
		rels, lerr := serverstore.ListWasmReleases(ctx, db, app.AppID, true)
		if lerr != nil {
			// 单个应用的版本枚举失败也**不中断整轮**：其余应用照常扫（这一轮是运维
			// 兜底动作，不是"全有或全无"的事务）。
			skip(app.AppID, 0, "", "列版本行失败: "+lerr.Error())
			continue
		}
		for _, rel := range rels {
			res.Releases++
			path := releaseAssetsConfigPath(dataRoot, app.AppID, rel.ID)
			raw, rerr := os.ReadFile(path)
			switch {
			case os.IsNotExist(rerr):
				res.Missing++
				continue
			case rerr != nil:
				skip(app.AppID, rel.ID, path, "读不到: "+rerr.Error())
				continue
			}
			next, changed, perr := rewritePublicAccessJSON(raw)
			if perr != nil {
				skip(app.AppID, rel.ID, path, "配置不可解析: "+perr.Error())
				continue
			}
			res.Files++
			if !changed {
				continue
			}
			if werr := writeReleaseAssets(dataRoot, app.AppID, rel.ID, string(next)); werr != nil {
				skip(app.AppID, rel.ID, path, "改写落盘失败: "+werr.Error())
				continue
			}
			res.Rewritten++
			logger("appseed: 磁盘资产 access 已由 public 收敛为 login：%s", path)
		}
	}
	if res.Skipped > 0 {
		logger("appseed: ⚠️ 磁盘资产改写跳过 %d 个文件（原因见上；其余 %d 个已处理）", res.Skipped, res.Rewritten)
	}
	return res, nil
}

// LegacyDemoTitleMarker 是历史演示标题里的字样 —— 用来识别"这一行的标题还是旧口径"。
//
// 为什么按**字样**而不是按"与清单不一致"判定（W4-7）：管理员有权改演示应用的标题
// （它是他自己库里的普通应用）。按"不一致就刷回清单"会让管理员每改一次、下次启动就被
// 回滚成清单值 —— 那正是本文件反复强调"heal 不覆盖标题"要避免的形态。
// 因此这条**一次性**改写只在标题仍带历史字样时才动手，改完就再也不会命中（幂等）。
const LegacyDemoTitleMarker = "匿名可达"

// DemoTitlesResult 是一次演示标题改写的统计。
type DemoTitlesResult struct {
	// Examined 是清单里的条目数（含库里没有的那些）。
	Examined int
	// Rewritten 是标题仍是历史口径、已改成清单值的行数。
	Rewritten int
	// Kept 是**刻意不动**的行数：管理员自己改过的标题（不含历史字样）。
	Kept int
	// Missing 是库里没有这一行（演示未播种 / 已被删除 —— "删了不再回来"是产品语义）。
	Missing int
	// Problems 是逐行失败的原因（读行 / 写回失败），单个失败不中断整轮。
	Problems []AssetRewriteProblem
}

// RewriteLegacyDemoTitles 把**存量**演示应用的标题从历史口径改成清单口径（设计 §9）。
//
// 为什么需要它：`demos.json` 是清单真源，但它只影响**新播种**的行；`Seed` 对已存在的
// 行一律跳过，`healIncomplete` 也按口径**不覆盖标题**（否则管理员改过的标题每次启动
// 都会被回滚）。于是"清单改了标题"对存量部署完全无效 —— 演示应用点开还是
// 「演示 · 公开应用（匿名可达）」，而这条口径早已下线（设计 §9：「需一次性改写
// DB 行 + 磁盘资产 + 标题」；磁盘资产那一半见 RewritePublicAccessAssets）。
//
// 语义（三条硬约束）：
//   - 只处理**清单里声明的 app_id**（保留 app_id：历史行有既存数据，不能按标题猜）；
//   - 只有标题**仍含 LegacyDemoTitleMarker** 时才改写（title + description 一起换成
//     清单值）—— 管理员改过的标题一个字节都不动（Kept 计数）；
//   - **只改 `apps` 行**，不动 `app_releases`：版本行是每版不可变快照（§4.2「改配置 =
//     发新版」），为了让历史版本列表好看去改它，等于把"当时发布的标题"从审计面抹掉。
//     `apps` 才是目录/应用中心读的投影（serverstore.SetWasmAppDisplay 的注释）。
//
// 幂等：改写后标题不再含历史字样 ⇒ 第二次调用 Rewritten = 0。
// 参数是 `*Seeder` 而不是 `(db, demos)`：清单与 DB 都住在它里面，两处各传一次会让
// "改写用的清单"与"播种用的清单"有机会不是同一份（同一份数据只允许一个入口）。
func RewriteLegacyDemoTitles(ctx context.Context, s *Seeder, logger func(format string, args ...any)) (DemoTitlesResult, error) {
	var res DemoTitlesResult
	if s == nil || s.opt.DB == nil {
		return res, errors.New("appseed: 演示标题改写需要已装载的 Seeder（含 DB 与清单）")
	}
	if logger == nil {
		logger = func(string, ...any) {}
	}
	db := s.opt.DB
	demos := s.demos
	res.Examined = len(demos)
	for _, d := range demos {
		appID := strings.TrimSpace(d.AppID)
		title := strings.TrimSpace(d.Title)
		if appID == "" || title == "" {
			continue
		}
		app, err := serverstore.GetWasmApp(ctx, db, appID)
		if errors.Is(err, serverstore.ErrNotFound) {
			res.Missing++
			continue
		}
		if err != nil {
			res.Problems = append(res.Problems, AssetRewriteProblem{AppID: appID, Reason: "读应用行失败: " + err.Error()})
			logger("appseed: 跳过演示标题改写（应用 %s）：%v", appID, err)
			continue
		}
		if app == nil {
			res.Missing++
			continue
		}
		if !strings.Contains(app.Title, LegacyDemoTitleMarker) {
			// 管理员自己命名的标题（或已经改过）：**一个字节都不动**。
			res.Kept++
			continue
		}
		if app.Title == title && app.Description == strings.TrimSpace(d.Description) {
			// 已经是清单口径（理论上不会走到：新标题不含历史字样）。
			res.Kept++
			continue
		}
		if uerr := serverstore.SetWasmAppDisplay(ctx, db, appID, title, strings.TrimSpace(d.Description)); uerr != nil {
			res.Problems = append(res.Problems, AssetRewriteProblem{AppID: appID, Reason: "写标题失败: " + uerr.Error()})
			logger("appseed: 演示标题改写失败（应用 %s）：%v", appID, uerr)
			continue
		}
		res.Rewritten++
		logger("appseed: 演示标题已由历史口径改写为清单值：%s（%q → %q）", appID, app.Title, title)
	}
	if len(res.Problems) > 0 {
		logger("appseed: ⚠️ 演示标题改写有 %d 行失败（其余 %d 行已改写 / %d 行刻意不动）",
			len(res.Problems), res.Rewritten, res.Kept)
	}
	return res, nil
}

// rewritePublicAccessJSON 把一份应用配置 JSON 里 `"access"` 的值由 "public" 改成 "login"。
//
// 返回：改写后的字节、是否改动、以及错误（不是合法 JSON 对象 ⇒ 错误，调用方按"跳过"处理）。
//
// 为什么用 Decoder 的偏移量做**精确切片**，而不是 `map[string]json.RawMessage` + Marshal：
// 需求是"其余字段逐字保留"，而 map+Marshal 会把键按字典序重排、重写转义与空白 ——
// 那等于重写整份配置（应用读到的字节与它自己写下的不一样，diff 里看不出"只动了一个值"）。
// 这里只替换 access **值**那一段字节 [start,end)，其余（键序、缩进、转义、嵌套对象里
// 同名的 access）一个字节都不动。
//
// 取**最后一个** access 键（与 jsonb / Go map 的"后写覆盖"同口径）：PG 侧判定用的
// `config_json::jsonb ->> 'access'` 同样是最后者胜，两侧判定必须一致，否则会出现
// "DB 改了、磁盘没改"或反过来的分叉。
func rewritePublicAccessJSON(raw []byte) ([]byte, bool, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	tok, err := dec.Token()
	if err != nil {
		return nil, false, err
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return nil, false, errors.New("不是 JSON 对象")
	}
	valueStart, valueEnd := int64(-1), int64(-1)
	var value json.RawMessage
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, false, err
		}
		key, _ := keyTok.(string)
		var val json.RawMessage
		if err := dec.Decode(&val); err != nil {
			return nil, false, err
		}
		if key != "access" {
			continue
		}
		// Decode 只消费值本身（值后的空白留给下一次 Token），RawMessage 逐字节保留该值
		// ⇒ 值的起点 = 终点 - 长度。
		valueEnd = dec.InputOffset()
		valueStart = valueEnd - int64(len(val))
		value = val
	}
	// 收尾的 '}' 必须读出来：截断的配置（只有开头、缺收尾大括号）在 More() 里只会静默
	// 返回 false，不补这一步就会被当成"没有 access 键"而静默放过一份坏配置。
	if _, err := dec.Token(); err != nil {
		return nil, false, err
	}
	if valueStart < 0 {
		return raw, false, nil // 没有 access 键：读取侧按缺省 login，不必写
	}
	var cur string
	// ⚠️ 判定走 appcfg 的**读侧口径唯一实现**（不在本包拼 `"public"` 字面量，也不直接
	// 引用那个历史取值常量）：本包只负责"看到历史取值就改写成 login"，语义归 appcfg。
	if err := json.Unmarshal(value, &cur); err != nil || !appcfg.IsLegacyPublicAccess(cur) {
		return raw, false, nil // 已经不是历史 public（含 login/whitelist/非字符串）：不动
	}
	replacement := []byte(strconv.Quote(string(appcfg.AccessLogin)))
	out := make([]byte, 0, len(raw)-int(valueEnd-valueStart)+len(replacement))
	out = append(out, raw[:int(valueStart)]...)
	out = append(out, replacement...)
	out = append(out, raw[int(valueEnd):]...)
	return out, true, nil
}

// ===== 结构性校验（不做编译）=====

// validateWasm 校验制品"像不像一个能跑的应用"：
//   - wasm 魔数（\0asm）与版本 1；
//   - 导出段里必须同时出现 _start 与 memory（§4.2 的导出面要求）。
//
// 为什么不做完整编译校验：播种发生在启动路径上，编译三个应用会给启动加数秒；
// 而这些制品是**随镜像构建出来的**（构建期已经真编译过一次），运行期首次请求
// 也会走完整的编译路径，编译失败会以 COMPILE_* 错误如实报给使用者。
func validateWasm(bin []byte) error {
	if len(bin) < 8 {
		return errors.New("appseed: 制品太小，不是合法 wasm")
	}
	if bin[0] != 0x00 || bin[1] != 0x61 || bin[2] != 0x73 || bin[3] != 0x6d {
		return errors.New("appseed: 制品缺少 wasm 魔数（\\0asm）")
	}
	if bin[4] != 0x01 || bin[5] != 0x00 || bin[6] != 0x00 || bin[7] != 0x00 {
		return errors.New("appseed: 制品 wasm 版本不是 1")
	}
	// 导出段（section id = 7）：只做存在性判断，不解析条目（解析放在执行侧）。
	hasStart, hasMemory := false, false
	// 极简扫描：在字节里找 "_start" / "memory" 的名字串。wasm 的名字串就是
	// 长度前缀 + 字节，直接搜子串对"我们自己的制品"足够；误判的代价只是
	// 放行一个会在首次请求时报编译错误的模块（fail-loud 在执行侧）。
	if containsBytes(bin, []byte("_start")) {
		hasStart = true
	}
	if containsBytes(bin, []byte("memory")) {
		hasMemory = true
	}
	if !hasStart || !hasMemory {
		return fmt.Errorf("appseed: 制品导出面不完整（_start=%v memory=%v）", hasStart, hasMemory)
	}
	return nil
}

func containsBytes(haystack, needle []byte) bool {
	return len(needle) > 0 && strings.Contains(string(haystack), string(needle))
}
