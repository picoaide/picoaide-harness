package runtime

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"syscall"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 本文件是**编译缓存目录被外部删除/改名**时的执行侧自愈（审计 R5-A-2，P1）。
//
// 缺陷形态（现场行为，PROBE-4 复现）：wazero 的 `fileCache` 在**构造期**把分片目录
// （`<缓存根>/<分代>/wazero-<版本>-<arch>-<os>`）记成字符串路径，并且**只在那一次**
// 建目录（wazero v1.12.0 `cache.go` 的 `ensuresFileCache`；其文档原话是
// "the embedder must safeguard this directory from external changes"）。
// 而 `filecache.Add` 是 `os.CreateTemp(dirPath, …)` —— 目录不在就 ENOENT，**不重建**，
// 且这个错误是 `CompileModule` 的返回值（`internal/engine/wazevo/engine_cache.go`
// 的 `addCompiledModule` 直接把 `Add` 的错误交出去）。
//
// 于是"运维按旧文案把缓存目录删掉"的后果不是"慢一点"，而是**所有冷编译失败到重启**：
//
//	open …/_compile-cache/<分代>/wazero-dev-amd64-linux/<key>.<rand>.tmp: no such file or directory
//
// 自愈为什么可行：wazero 的 `fileCache` 只持**路径**（`fileCache.dirPath`），没有打开的
// 目录 fd —— 把同名目录重新建出来，那个已经绑定的 fileCache 立刻恢复可用，**不需要**
// 重建 Runtime（RuntimeConfig 不可变，重建代价是丢掉整个进程内状态）。
//
// 两层动作：
//  1. **每次编译前**补齐目录（`ensureDiskCacheDirs`）：绝大多数情况下这一次就够了；
//  2. 真的撞上"分片目录不存在"的错误 ⇒ 补齐后**重试一次**；仍失败 ⇒ 把驱动级谜语
//     换成可行动文案（点名"目录被外部删除、请重启或走回收入口、不要手工删目录"）。

// cacheShardDirs 返回缓存目录下 wazero 建立的版本分片目录名（构造期观测，唯一真源）。
//
// 为什么是"观测"而不是"按规则算一份"：分片名由 wazero 自己拼
// （`"wazero-" + version.GetWazeroVersion() + "-" + GOARCH + "-" + GOOS`），
// 我们算一份就是第二个判断 —— 它一旦与 wazero 的实际命名分叉，自愈会静默失效
// （建了一个没人用的目录）。观测到的名字只可能是 wazero 真的在用的那个。
func cacheShardDirs(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if e.IsDir() && strings.HasPrefix(e.Name(), "wazero-") {
			out = append(out, e.Name())
		}
	}
	return out
}

// wazeroShardDirName 是"没有观测值时的回落"：按 wazero 的命名规则算一个候选名。
//
// 只在构造期观测为空时使用（理论上不该发生：`NewCompilationCacheWithDir` 成功就说明
// 分片目录已建）。保留它是因为"观测为空"也可能来自"目录被删得只剩父目录"。
func wazeroShardDirName() string {
	return "wazero-" + wazeroVersion() + "-" + goruntime.GOARCH + "-" + goruntime.GOOS
}

// ensureDiskCacheDirs 重建磁盘缓存目录（父目录 + wazero 的版本分片目录）。
//
// 幂等且廉价（`MkdirAll` 已存在时只是一次 stat）；只在"本运行时自己按 DataRoot 建了
// 磁盘缓存"时有意义（`cacheDir == ""` ⇒ 注入缓存或进程内缓存 ⇒ no-op）。
func (r *Runtime) ensureDiskCacheDirs() error {
	if r == nil || r.cacheDir == "" {
		return nil
	}
	mode := os.FileMode(limits.DataDirMode)
	if err := os.MkdirAll(r.cacheDir, mode); err != nil {
		return err
	}
	shards := r.cacheShards
	if len(shards) == 0 {
		shards = []string{wazeroShardDirName()}
	}
	for _, name := range shards {
		if err := os.MkdirAll(filepath.Join(r.cacheDir, name), mode); err != nil {
			return err
		}
	}
	return nil
}

// cacheDirFailure 判定"这次失败是不是发生在缓存目录里"。
//
// 判据的主口径是**路径归属**而不是 errno：`os.CreateTemp` / `os.Open` / `os.Rename` 的失败
// 都是 `*fs.PathError`，`Path` 就是我们绑定的那棵树 —— 只要失败路径落在缓存目录内，它就是
// 缓存目录本身的问题（被删、被改名、被普通文件占住、权限、只读挂载都会走到这里），
// 与具体是 ENOENT 还是 ENOTDIR 无关（把 errno 白名单写死会漏掉一半形态）。
//
// 反向的边界同样重要：`CompileModule` 的输入是**内存字节**，因此"失败的路径不在缓存目录里"
// 说明是别的子系统（例如应用自己的宿主调用），那种错误必须原样透出，不许被我们改写成缓存文案。
func cacheDirFailure(err error, cacheDir string) bool {
	if err == nil || cacheDir == "" {
		return false
	}
	var pe *fs.PathError
	if errors.As(err, &pe) && strings.Contains(pe.Path, cacheDir) {
		return true
	}
	// 兜底：错误链里没有 PathError 的形态（例如被上游包装过），用"消息里点名了这棵树 +
	// 是一个文件系统级失败"两条同时成立来判定。
	if !strings.Contains(err.Error(), cacheDir) {
		return false
	}
	return errors.Is(err, fs.ErrNotExist) || errors.Is(err, fs.ErrPermission) ||
		errors.Is(err, syscall.ENOTDIR) || errors.Is(err, syscall.ENOSPC) || errors.Is(err, syscall.EROFS)
}

// cacheDirMissingError 把缓存目录级的失败包成**可行动**文案。
//
// 要求（审计 R5-A-2 的补判据③）：不得把 `no such file or directory` / `not a directory`
// 这种驱动级谜语直接留给运维/作者。原文用 `%w` 保留在链上（排障仍能 grep 到驱动级细节），
// 但用户可见的首句必须回答"发生了什么 + 现在该做什么"。
func cacheDirMissingError(err error, cacheDir string) error {
	if err == nil {
		return nil
	}
	where := cacheDir
	if where == "" {
		where = "<数据根>/" + limits.CompileCacheDirName
	}
	return fmt.Errorf("编译缓存目录不可用（被外部删除/改名，或路径被占）：%s 下的 wazero 分片目录"+
		"在进程启动时被绑定、执行侧不会自行重建 —— 请重启服务端，或改用进程内回收入口"+
		"（ReclaimCache / CleanCache）；**不要手工删除或改名缓存目录**：%w", where, err)
}
