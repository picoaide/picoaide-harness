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
	AppID  string
	Reason string
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
func (s *Seeder) Seed(ctx context.Context) (Result, error) {
	var res Result
	if s == nil {
		return res, nil
	}
	for _, d := range s.demos {
		appID := registry.NormalizeAppID(d.AppID)
		if appID == "" {
			res.Skipped = append(res.Skipped, SkipReason{d.AppID, "app_id 非法（清单错误）"})
			continue
		}
		if _, err := serverstore.GetWasmApp(ctx, s.opt.DB, appID); err == nil {
			// 存在即跳过：**这是"删了不再回来"的实现**（软删的行仍存在）。
			res.Skipped = append(res.Skipped, SkipReason{appID, "已存在（含已删除/已冻结）"})
			continue
		} else if !errors.Is(err, serverstore.ErrNotFound) {
			res.Skipped = append(res.Skipped, SkipReason{appID, "查询失败: " + err.Error()})
			continue
		}
		if err := s.seedOne(ctx, d, appID); err != nil {
			res.Skipped = append(res.Skipped, SkipReason{appID, "播种失败: " + err.Error()})
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
		return fmt.Errorf("编码应用配置: %w", err)
	}
	if _, perr := appcfg.Parse(raw); perr != nil {
		return fmt.Errorf("应用配置不合规: %v", perr)
	}
	cfgJSON := string(raw)
	app := serverstore.WasmApp{
		AppID:           appID,
		Title:           strings.TrimSpace(d.Title),
		Description:     strings.TrimSpace(d.Description),
		Owner:           s.opt.Owner,
		Channel:         serverstore.AppChannelWasm,
		Enabled:         true,
		Purpose:         cfg.Purpose,
		DataSensitivity: cfg.DataSensitivity,
		ConfigJSON:      cfgJSON,
	}
	if err := serverstore.UpsertWasmApp(ctx, s.opt.DB, app); err != nil {
		return fmt.Errorf("写应用行: %w", err)
	}
	relID, err := serverstore.CreateWasmRelease(ctx, s.opt.DB, serverstore.WasmRelease{
		AppID:       appID,
		Version:     defaultVersion,
		Title:       app.Title,
		Description: app.Description,
		Changelog:   "随安装内置的演示应用",
		Publisher:   s.opt.Owner,
		Checksum:    s.sum,
		Size:        int64(len(s.wasm)),
		Status:      serverstore.ReleaseStatusApproved,
		Wasm:        s.wasm,
		ConfigJSON:  cfgJSON,
	})
	if err != nil {
		return fmt.Errorf("写版本行: %w", err)
	}
	if err := serverstore.SetWasmAppCurrentRelease(ctx, s.opt.DB, appID, relID); err != nil {
		return fmt.Errorf("指向当前版本: %w", err)
	}
	// 资源目录：应用子域管线按 <data_root>/apps/<app_id>/assets/<release_id>/ 推导，
	// **缺了直接 500**（不是可选项）。演示应用把配置写进去（应用自己 assets.read 读它）。
	if err := writeReleaseAssets(s.opt.DataRoot, appID, relID, cfgJSON); err != nil {
		return err
	}
	return nil
}

// writeReleaseAssets 写出版本的资源目录（只放应用配置；演示应用没有额外的静态资源）。
func writeReleaseAssets(dataRoot, appID string, relID int64, cfgJSON string) error {
	dir := filepath.Join(dataRoot, limits.AppsDirName, appID, assets.AssetsDirName, strconv.FormatInt(relID, 10))
	if err := os.MkdirAll(dir, os.FileMode(limits.DataDirMode)); err != nil {
		return fmt.Errorf("创建资源目录: %w", err)
	}
	cfgPath := filepath.Join(dir, limits.AppConfigFileName)
	if err := os.WriteFile(cfgPath, []byte(cfgJSON), 0o644); err != nil {
		return fmt.Errorf("写应用配置: %w", err)
	}
	return nil
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
