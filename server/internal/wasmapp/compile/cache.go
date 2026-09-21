package compile

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime/debug"
	"sort"
	"strings"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 本文件是**父侧**的缓存目录推导、度量与回收（§4.3.1 / §10.3 第 35 项）。
//
// 分工的理由（§4.3.1-d 信任边界）：子进程只**写**缓存（wazero 的
// NewCompilationCacheWithDir 只提供 put/get），删除只能由父侧做——父侧同时是
// 缓存目录的属主与执行进程的只读对象，删谁不删谁这件事必须有一处统一裁决。
//
// 回收判据**同时**满足两个维度（设计原文："磁盘缓存按上限回收" + limits 里的
// CompileCacheMaxBytes / CompileCacheMaxEntries）：先按 mtime 从旧到新删，
// 直到体积与条目数都在阈值内。为什么是 mtime 而不是访问时间：wazero 的条目
// 在命中时不会更新 mtime（它只读），所以 mtime ≈ "写入时间" = "什么时候编译的"，
// 对"最近用过的模块"是合理近似；真按 atime 会被 noatime 挂载选项打回原形。
//
// ⚠️ **回收的唯一实现在这里**（FIX-37 / 审计 P2-3）：runtime 侧原有的
// PruneCompilationCache 与本文件重复、且在生产路径零调用点，已删除。执行进程只读缓存、
// 不做回收（§4.3.1-d 的分工）。
//
// ⚠️ 回收/度量扫的是**缓存根**（`_compile-cache/`，含**所有分代**），不是当前分代目录
// （FIX-36 / 审计 P2-2）：升级 wazero（或分代回落常量 +1）后旧一代永远不会再被命中，
// 但仍占磁盘；只在当前分代里 WalkDir 会让"缓存有界"（§10.3 第 35 项）只在单代内成立。

// ===== §4.3.1 / FIX-34：缓存目录与分代（与 runtime 逐字同算法的第二份实现）=====

// CompileCacheDir 返回编译侧的缓存目录，**必须与 runtime.CompileCacheDir 逐字相同**
// （§4.3.1-a：两侧不一致 ⇒ 发布期编译暖不到执行进程，失败形态是静默的）。
//
// 为什么本文件再写一份而不是 import runtime：依赖方向（见 runtimeconfig.go 的长注释）——
// compile 与 runtime 是同层能力实现，横向 import 会成环。两份实现由**交叉断言用例**钉住：
// runtime 包的 TestCompileCacheDirMatchesCompileSide（外部测试包，同时 import 两侧），
// 以及生产装配点 appserver.Options 的校验（opt.Compiler.CacheDir() == runtime.CompileCacheDir）。
func CompileCacheDir(dataRoot string) string {
	return filepath.Join(dataRoot, limits.CompileCacheDirName, cacheNamespace())
}

// cacheNamespace 返回分代命名空间（与 runtime.cacheNamespace 同算法）。
func cacheNamespace() string { return cacheNamespaceFor(wazeroVersion()) }

// cacheNamespaceFor 是分代规则的纯函数形态：拿得到 wazero 真实版本就用它，
// 拿不到（test 二进制里是 "" / "dev" / "(devel)"）才回落到 limits.CompileCacheRevision。
func cacheNamespaceFor(v string) string {
	v = strings.TrimSpace(v)
	if v != "" && v != "dev" && v != "(devel)" {
		return v
	}
	return limits.CompileCacheRevision
}

// wazeroVersion 是 wazero `internal/version.GetWazeroVersion()` 的**逐行镜像**
// （那个包在别的模块的 internal 下，Go 禁止 import）。
//
// 事实依据（审计 P1-3，2026-09-18）：**只有 `go test` 二进制拿不到版本**（Deps 里没有 wazero、
// Main.Version=(devel)）；`go build` 出来的 main 二进制（本编译子进程与服务端进程）Deps 里有
// wazero ⇒ 返回真实版本（实测 v1.12.0）⇒ 与 runtime 侧、与 wazero 自己的目录分片三者一致。
func wazeroVersion() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "dev"
	}
	ret := ""
	for _, dep := range info.Deps {
		if strings.Contains(dep.Path, "github.com/tetratelabs/wazero") {
			ret = dep.Version
		}
	}
	if ret == "" || ret == "(devel)" {
		ret = info.Main.Version
	}
	if ret == "" || ret == "(devel)" {
		return "dev"
	}
	return ret
}

// cacheEntry 是一条缓存条目的度量（内部形态）。
type cacheEntry struct {
	path  string
	size  int64
	mtime int64 // UnixNano
}

// CacheEntry 是缓存条目的对外视图（CacheEntries / /readyz）。
type CacheEntry struct {
	Path            string
	Size            int64
	ModTimeUnixNano int64
}

// cacheLayoutDepth* 是"条目文件"相对扫描根的最大深度（用于识别"比已知布局更深的目录"）：
//
//	缓存根（_compile-cache）  <root>/<分代>/wazero-v<ver>-<os>-<arch>/<条目>   ⇒ 3
//	当前分代目录              <root>/wazero-v<ver>-<os>-<arch>/<条目>          ⇒ 2
const (
	cacheLayoutDepthAll        = 3
	cacheLayoutDepthGeneration = 2
)

// listCacheEntries 列出缓存目录下的全部条目（含 wazero 的版本分片子目录）。
//
// 目录布局（§4.3.1）：<cacheDir>/wazero-v<ver>-<os>-<arch>/<sha256 条目名>；
// 以缓存根为扫描根时外面还套一层分代目录（见 FIX-36）。
// layoutDepth 决定"哪一层是条目文件"：这里不假设子目录名（wazero 换版本会换分片名），
// 只按深度收集；比已知布局更深的目录**不静默**——把它自己当成一条条目计入。
func listCacheEntries(dir string, layoutDepth int) ([]cacheEntry, error) {
	var out []cacheEntry
	root := filepath.Clean(dir)
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			// 单条不可读不中断整体统计（否则一个坏条目让缓存水位永远读不出来）。
			if path == root {
				return err
			}
			return nil
		}
		if path == root {
			return nil
		}
		// 深度：root 之下最多 layoutDepth 层（wazero 的布局是 <root>/<version-shard>/<entry>，
		// 缓存根还要多一层分代）。用相对路径的段数判定，而不是写死分片名。
		rel, rerr := filepath.Rel(root, path)
		if rerr != nil {
			return nil
		}
		depth := len(strings.Split(rel, string(filepath.Separator)))
		if d.IsDir() {
			if depth >= layoutDepth {
				// 更深的目录不展开（当前布局没有）；但**不静默**：把它自己当成一条
				// 条目计入，避免"统计说没超、磁盘却在涨"。
				if info, ierr := d.Info(); ierr == nil {
					out = append(out, cacheEntry{path: path, size: info.Size(), mtime: info.ModTime().UnixNano()})
				}
				return fs.SkipDir
			}
			return nil
		}
		info, ierr := d.Info()
		if ierr != nil {
			return nil
		}
		// 符号链接：按链接自身的大小/时间计入（**不追**目标，避免统计到目录外，
		// 也避免 os.Remove 删到链接背后别的东西）。
		out = append(out, cacheEntry{path: path, size: info.Size(), mtime: info.ModTime().UnixNano()})
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// cacheScanRoot 是**回收与度量**的扫描根：缓存根 `_compile-cache/`（含所有分代）。
//
// 为什么不是 c.cache（当前分代，见 FIX-36 / 审计 P2-2）：升级 wazero（或分代回落常量 +1）后
// 旧一代目录永远不会再被命中，却仍占磁盘；只在当前分代里统计/删除会让"缓存有界"
// （§10.3 第 35 项）只在单代内成立。
//
// ⚠️ 但**必须跟着"子进程真正在用的那个根"走**（2026-09-21 六轮审计 P2-②）：缓存不可信时
// 子进程改用临时目录（`childCacheDir`），而回收/水位/度量此前一律只看**配置目录** ⇒
// 那条分支上 512 MiB / 4096 条的预算与 `/readyz` 告警全部静默失效（临时目录常落在
// tmpfs 上 ⇒ 直接吃内存）。
//
// 两个分支的**根不是一回事**（六轮审计实测：直接把 `filepath.Dir(childCacheDir)` 当根会让
// 扫描落到 `/tmp` 上，把别的测试目录当"分代目录"删掉）：
//   - 配置分支：根 = `_compile-cache/`（**含所有分代**中的当前与历史分代）；
//   - 临时分支：临时目录**本身就是根**（wazero 会在它下面建一个分代目录），
//     不存在"历史分代"这回事，也没有别人的目录。
func (c *Compiler) cacheScanRoot() string {
	if c.childCacheTemp != "" {
		return c.childCacheDir
	}
	return filepath.Dir(c.cache)
}

// scanCacheEntries 返回"在用的那棵树"里的全部条目。
//
// **根与深度必须成对选**（六轮审计实测：只换根不换深度会扫错层）：
//   - 配置分支：根 = `_compile-cache/`（含所有分代），深度 3（分代/分片/条目）；
//   - 临时分支：临时目录本身就是"分代目录"（wazero 在它下面建分片），深度 2。
func (c *Compiler) scanCacheEntries() ([]cacheEntry, error) {
	if c.childCacheTemp != "" {
		return listCacheEntries(c.childCacheDir, cacheLayoutDepthGeneration)
	}
	return listCacheEntries(c.cacheScanRoot(), cacheLayoutDepthAll)
}

// cacheUsage 返回缓存（**所有分代**）的体积与条目数。
func (c *Compiler) cacheUsage() (bytes int64, entries int, err error) {
	es, err := c.scanCacheEntries()
	if err != nil {
		return 0, 0, err
	}
	for _, e := range es {
		bytes += e.size
	}
	return bytes, len(es), nil
}

// newestCacheMtime 返回最新条目的写入时间（UnixNano，无条目为 0）与条目数。
//
// ⚠️ 这里**只看当前分代**（`c.childCacheDir` —— 与回收同源），与回收/水位的
// "全部分代"口径刻意不同：
// 它的用途是命中判定（见 compileOne）——"本次编译有没有写入新条目"。把别的分代算进来会
// 让一个**不会**被命中的旧目录把"最新 mtime"顶到未来，命中判定就不再成立。
func (c *Compiler) newestCacheMtime() (int64, int) {
	es, err := listCacheEntries(c.childCacheDir, cacheLayoutDepthGeneration)
	if err != nil || len(es) == 0 {
		return 0, 0
	}
	var newest int64
	for _, e := range es {
		if e.mtime > newest {
			newest = e.mtime
		}
	}
	return newest, len(es)
}

// newestCacheEntry 返回最近写入的缓存条目路径（命中判定与诊断用；口径同 newestCacheMtime）。
func (c *Compiler) newestCacheEntry() string {
	es, err := listCacheEntries(c.childCacheDir, cacheLayoutDepthGeneration)
	if err != nil || len(es) == 0 {
		return ""
	}
	best := es[0]
	for _, e := range es[1:] {
		if e.mtime > best.mtime {
			best = e
		}
	}
	return best.path
}

// CacheUsage 是缓存目录的对外度量（/readyz 水位）。
func (c *Compiler) CacheUsage() (bytes int64, entries int) {
	b, e, _ := c.cacheUsage()
	return b, e
}

// ReclaimCache 回收缓存，使体积与条目数**同时**降到阈值内（§10.3 第 35 项）。
//
// 返回 (删除条目数, 释放字节数, 错误)。回收顺序：mtime 从旧到新，
// 每删一条就重新判断两个维度是否都已满足（不是"删到体积达标再看条目数"——
// 那会多删）。
//
// ⚠️ 与并发编译的关系：wazero 的条目在写入未完成时被删会让那次编译的缓存写入
// 失败（表现为下次 miss，不是错误）。因此回收只在两次编译**之间**由父侧调用
// （编译 worker 是单线程，回收在 runJob 里同步执行 ⇒ 不与编译重入）。
func (c *Compiler) ReclaimCache() (removed int, freed int64, err error) {
	es, err := c.scanCacheEntries()
	if err != nil {
		return 0, 0, err
	}
	var total int64
	for _, e := range es {
		total += e.size
	}
	count := len(es)
	if total <= c.opt.CacheMaxBytes && count <= c.opt.CacheMaxEntries {
		return 0, 0, nil
	}
	sort.Slice(es, func(i, j int) bool {
		if es[i].mtime != es[j].mtime {
			return es[i].mtime < es[j].mtime
		}
		return es[i].path < es[j].path // 稳定序（同 mtime 时行为可复现）
	})
	for _, e := range es {
		if total <= c.opt.CacheMaxBytes && count <= c.opt.CacheMaxEntries {
			break
		}
		if rerr := os.Remove(e.path); rerr != nil {
			// 单条删除失败不中断整体回收：继续删后面的（否则一条权限异常
			// 就让整个目录永远超限）。
			if !os.IsNotExist(rerr) {
				err = fmt.Errorf("删除缓存条目 %s 失败: %w", filepath.Base(e.path), rerr)
			}
			continue
		}
		removed++
		freed += e.size
		total -= e.size
		count--
	}
	return removed, freed, err
}

// CleanCache 清空缓存目录（运维/排障用；不动目录本身，权限与属主保持）。
//
// 用途：§4.3.1-b 的"换 wazero 版本或换 CPU ⇒ 旧条目永不复用却仍占空间"。
// 版本分片会让旧条目**永远不会被命中**，而回收只看 mtime ⇒ 它们会被优先删掉，
// 所以本方法不是必需品，只是给运维一个确定的清空入口。
func (c *Compiler) CleanCache() (removed int, freed int64, err error) {
	es, err := c.scanCacheEntries()
	if err != nil {
		return 0, 0, err
	}
	for _, e := range es {
		if rerr := os.Remove(e.path); rerr != nil && !os.IsNotExist(rerr) {
			err = rerr
			continue
		}
		removed++
		freed += e.size
	}
	return removed, freed, err
}

// CacheEntryCountForLog 返回可读的缓存水位描述（启动日志与 /readyz 用）。
func (c *Compiler) CacheEntryCountForLog() string {
	b, e, err := c.cacheUsage()
	if err != nil {
		return fmt.Sprintf("不可读(%v)", err)
	}
	return fmt.Sprintf("%s / %d 条（上限 %s / %d 条）",
		describeInt(b), e, describeInt(c.opt.CacheMaxBytes), c.opt.CacheMaxEntries)
}

// cacheDirIsTrustBoundary 返回缓存目录在文件系统上的权限描述（验收用）。
//
// §4.3.1-d 要求"目录属主=编译进程、执行进程只读"。Go 无法可靠的"只读挂载"，
// 但可以断言 **目录权限不含 group/other 写位**——这是本机能给出的最强证据，
// 剩下的（执行进程以只读方式打开）由部署面（挂载选项/用户隔离）保证。
func cacheDirIsTrustBoundary(dir string) (string, error) {
	fi, err := os.Stat(dir)
	if err != nil {
		return "", err
	}
	mode := fi.Mode().Perm()
	desc := fmt.Sprintf("mode=%#o", mode)
	if mode&0o022 != 0 {
		return desc, fmt.Errorf("缓存目录 %s 允许 group/other 写（mode=%#o）——违反 §4.3.1-d", dir, mode)
	}
	if mode&0o400 == 0 {
		return desc, fmt.Errorf("缓存目录 %s 属主不可读（mode=%#o）", dir, mode)
	}
	return desc, nil
}

// cacheShardHint 返回 wazero 的缓存分片名（诊断：说明"换版本/换 CPU 会复制条目"，§4.3.1-b）。
func cacheShardHint(dir string) string {
	tops, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	var names []string
	for _, t := range tops {
		if t.IsDir() && strings.HasPrefix(t.Name(), "wazero-") {
			names = append(names, t.Name())
		}
	}
	sort.Strings(names)
	return strings.Join(names, ",")
}

// moduleNameOf 返回缓存条目的文件名（测试与日志用：条目名即内容寻址的键）。
func moduleNameOf(path string) string {
	if i := strings.LastIndexByte(path, '/'); i >= 0 {
		return path[i+1:]
	}
	return path
}
