package appserver

import (
	"io/fs"
	"os"
	"path/filepath"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// legacyAssetsDirName 是**历史**的"按版本抽取的资源目录"名。
//
// 2026-09-20 起随包资源改为内存直出（决策文档
// docs/decisions/2026-09-20-wasm-assets-in-memory.md）：发布期不再把 wasm 自定义段
// 抽到 `<data_root>/apps/<app_id>/assets/<release_id>/`，运行期也不再读它。
// 这个常量只为下面的一次性清理而存在 —— **不要**在任何请求路径上引用它。
const legacyAssetsDirName = "assets"

// CleanupLegacyAssetDirs 清理历史遗留的抽取资源目录（启动期维护动作）。
//
// # 为什么可以删
//
// 这些目录是**平台派生数据**：应用配置的权威副本在库里（`app_releases.config_json`），
// 其余素材是 wasm 自定义段的一部分（制品字节存 `app_releases.archive`）。也就是说
// 目录内容 100% 可以从库内重建（这正是改内存直出的理由之一）。留着它们的唯一后果是
// "盘上有一份没人读的旧内容"，而排障时最容易被这种状态误导（改了盘上的文件以为生效了）。
//
// # 安全边界（删东西的代码必须自己证明边界）
//
//   - 只处理 `<data_root>/<AppsDirName>/<app_id>/` 的**直接**子项，且名字必须恰好是
//     `assets`；`app.db`、日志、别的任何东西一律不碰；
//   - `<app_id>` 与 `assets` 两层都先 `Lstat`：**符号链接一律跳过**（不跟着链接删到
//     数据根之外 —— 这是"清理工具把宿主清空"这类事故的唯一成因）；
//   - `<data_root>/<AppsDirName>` 这一层也先 `Lstat`：不存在/不是目录/是链接 ⇒ 直接返回
//     （数据根还没建起来没有任何东西可清；`apps` 是指向别处的链接时一律不跟随）。
//
// ⚠️ 边界（如实说明，别把保证范围说过头）：**数据根这一层本身是不是链接不由本函数判断** ——
// 运维完全可以把数据根配成一个符号链接（平台其它模块拼路径时同样会跟着它走），那种情况下
// "按链接指向的真实目录清理"正是正确行为。本函数保证的是"不沿着 `apps/<app_id>`、
// `<app_id>/assets` 这两层的链接删到数据根之外"。
//
// # 失败语义
//
// 全程 best-effort：任何错误只通过 logf 记录，**不影响启动**（清理是维护动作，
// 不是启动前提）。返回值 (删除目录数, 释放字节数) 供调用方打一行汇总日志/断言。
func CleanupLegacyAssetDirs(dataRoot string, logf func(string, ...any)) (removed int, freed int64) {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	root := filepath.Join(dataRoot, limits.AppsDirName)
	st, err := os.Lstat(root)
	if err != nil || !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
		return 0, 0
	}
	apps, err := os.ReadDir(root)
	if err != nil {
		logf("appserver: 清理历史资源目录时读取 %s 失败（跳过）: %v", root, err)
		return 0, 0
	}
	for _, app := range apps {
		if !app.IsDir() || app.Type()&os.ModeSymlink != 0 {
			continue
		}
		dir := filepath.Join(root, app.Name(), legacyAssetsDirName)
		dst, derr := os.Lstat(dir)
		if derr != nil {
			continue // 没有这个目录 = 已经清理过（正常路径）
		}
		if dst.Mode()&os.ModeSymlink != 0 || !dst.IsDir() {
			logf("appserver: 历史资源路径 %s 不是真目录（跳过，不跟随链接）", dir)
			continue
		}
		size := dirSize(dir)
		if rerr := os.RemoveAll(dir); rerr != nil {
			logf("appserver: 删除历史资源目录 %s 失败（跳过）: %v", dir, rerr)
			continue
		}
		removed++
		freed += size
		logf("appserver: 已清理历史资源目录 %s（%d 字节）——随包资源已改为内存直出", dir, size)
	}
	return removed, freed
}

// dirSize 累计目录下普通文件的大小（清理日志用；读不到就按 0 计，不报错）。
func dirSize(dir string) int64 {
	var total int64
	_ = filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil || d == nil || d.IsDir() {
			return nil
		}
		info, ierr := d.Info()
		if ierr != nil {
			return nil
		}
		total += info.Size()
		return nil
	})
	return total
}
