// Command wasiprobe 是**只用于生成导入白名单**的探测程序：把 Go wasip1 运行时可能落到 WASI 的
// 调用面尽量全面地触碰一遍，让链接器把相应的 WASI 导入带进产物。
//
// 为什么需要它（模块 C 实测的功能缺陷）：
// 参考实现 refapp 只做帧协议 + 内存分配，它的导入面**恰好只有 16 个符号**；
// 而任何一行 `os.Stat` / `os.ReadDir` 都会额外引入 `path_filestat_get` / `fd_readdir` 等导入。
// 如果白名单 = refapp 的导入面，那么"用了 os.Stat 的合法 Go 应用"会被 IMPORT_NOT_ALLOWED 直接拒 ——
// 而 Go 是 R39/§9.1 的 Tier 1 官方支持语言。这是功能缺陷，不是安全取舍。
//
// 白名单的正确语义 = **Go 运行时可能发出的全部 `wasi_snapshot_preview1` 导入（保守超集）**：
//   - 红线 5（不能读宿主文件）由**零 preopen** 保证（§4.3 / §15.1 第 1 条）：允许导入 path_open，
//     但没有任何 preopen 时 guest 拿不到任何可用 fd。⚠️ 措辞更正（审计实测，2026-09-18）：
//     errno **不是** `ENOSYS`——Go 的 `os.Open/Stat/ReadDir` 拿到 `EBADF(8)`（Go 先查
//     `fd_prestat_get`）、原生 `path_open(fd, "/abs")` 拿到 `EPERM(63)`（wazero 先否决前导 `/`）、
//     相对路径 `EBADF(8)`、stdio fd 上 `ENOTDIR(54)`；`ENOSYS(52)` / `ENOTCAPABLE(76)` 一次都没出现；
//   - 红线 4（不能出站）由"**没有任何途径得到一个 socket fd**"保证：preview1 **有**
//     `sock_accept` / `sock_recv` / `sock_send` / `sock_shutdown`，但**没有** `sock_open` /
//     `sock_bind` / `sock_listen` / `sock_connect` ⇒ 自造不出 socket fd（实测 `sock_accept(0..10)`、
//     `sock_shutdown(3)` 全 `EBADF(8)`；`syscall.Socket` 在 wasip1 上不可用）。白名单在这里的职责是
//     "只放行不造 fd 的那两个 socket 符号 + 拒绝任何非 `wasi_snapshot_preview1` 的模块"
//     （imports_gen_test.go 里有正反断言）。
//
// ⚠️ 本程序**不是教学样例**（教学样例是 refapp）：这里故意写满文件系统操作。
// 单独成程序正是为了不把 refapp 变成"文件操作教学样例"（§9.3 的 examples/ 蓝本要保持干净）。
//
// ⚠️ 平台永远不会运行本程序（白名单生成只编译、不执行）；本机 `go run` 也安全：
//   - 文件操作全部落在自建的临时目录里，跑完清理；
//   - 会阻塞（读 stdin）或会终止进程（os.Exit）的探测放在**不可达守卫**后面：条件永假但编译器
//     无法证明，因此调用会进产物（导入被保留），真跑时又不会执行。
package main

import (
	"crypto/rand"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

// guarded 是不可达守卫：条件永假（正常进程的 argv 不可能有上百万个），但编译器无法静态证明，
// 所以分支内的调用不会被死代码消除 ⇒ 对应的 WASI 导入会留在产物里，而真跑时不会执行。
func guarded() bool { return len(os.Args) > 1<<20 }

func main() {
	dir, err := os.MkdirTemp("", "wasiprobe-")
	if err != nil {
		fmt.Fprintln(os.Stderr, "wasiprobe: mkdirtemp:", err)
		os.Exit(1) // 只有本机原生跑才可能走到这里（平台上本程序不会被运行）
	}
	defer func() { _ = os.RemoveAll(dir) }()

	ok, failed := 0, 0
	for _, p := range probes(dir) {
		if err := p.run(); err != nil {
			// 平台侧（零 preopen）所有文件操作都会失败，这是**预期**的；本机原生跑则应当成功。
			fmt.Fprintf(os.Stderr, "wasiprobe: %s: %v\n", p.name, err)
			failed++
			continue
		}
		ok++
	}
	fmt.Fprintf(os.Stdout, "wasiprobe: %d 个探测成功 / %d 个失败（平台侧文件操作应当全部失败）\n", ok, failed)
}

type probe struct {
	name string
	run  func() error
}

// probes 覆盖 Go wasip1 std 会落到 WASI 的主要路径。
// 每一项都对应一个（或几个）WASI 导入：path_open / fd_readdir / path_filestat_get / path_unlink_file /
// path_create_directory / path_remove_directory / path_rename / path_readlink / path_symlink /
// path_filestat_set_times / fd_seek / fd_read / fd_write / fd_sync / fd_filestat_get / fd_close …
func probes(dir string) []probe {
	file := filepath.Join(dir, "a.txt")
	renamed := filepath.Join(dir, "b.txt")
	link := filepath.Join(dir, "link.txt")
	sub := filepath.Join(dir, "sub")

	return []probe{
		{"os.Mkdir", func() error { return os.Mkdir(sub, 0o700) }},
		{"os.MkdirAll", func() error { return os.MkdirAll(filepath.Join(sub, "x", "y"), 0o700) }},

		{"os.Create", func() error {
			f, err := os.Create(file)
			if err != nil {
				return err
			}
			return f.Close()
		}},
		{"os.WriteFile", func() error { return os.WriteFile(file, []byte("hello wasi"), 0o600) }},
		{"os.ReadFile", func() error {
			_, err := os.ReadFile(file)
			return err
		}},
		{"os.Open", func() error {
			f, err := os.Open(file)
			if err != nil {
				return err
			}
			return f.Close()
		}},
		{"os.OpenFile(O_APPEND)", func() error {
			f, err := os.OpenFile(file, os.O_APPEND|os.O_WRONLY, 0o600)
			if err != nil {
				return err
			}
			if _, err := f.Write([]byte("!")); err != nil {
				_ = f.Close()
				return err
			}
			return f.Close()
		}},
		{"(*os.File).Seek", func() error {
			f, err := os.Open(file)
			if err != nil {
				return err
			}
			defer f.Close()
			if _, err := f.Seek(1, io.SeekStart); err != nil {
				return err
			}
			buf := make([]byte, 2)
			_, err = f.Read(buf) // fd_read
			return err
		}},
		{"(*os.File).Sync", func() error {
			f, err := os.OpenFile(file, os.O_WRONLY, 0o600)
			if err != nil {
				return err
			}
			defer f.Close()
			return f.Sync()
		}},
		{"(*os.File).Truncate", func() error {
			f, err := os.OpenFile(file, os.O_WRONLY, 0o600)
			if err != nil {
				return err
			}
			defer f.Close()
			return f.Truncate(1)
		}},
		{"(*os.File).Stat", func() error {
			f, err := os.Open(file)
			if err != nil {
				return err
			}
			defer f.Close()
			_, err = f.Stat()
			return err
		}},

		{"os.Stat", func() error {
			_, err := os.Stat(file)
			return err
		}},
		{"os.Lstat", func() error {
			_, err := os.Lstat(file)
			return err
		}},
		{"os.ReadDir", func() error {
			_, err := os.ReadDir(dir)
			return err
		}},
		{"filepath.WalkDir", func() error {
			return filepath.WalkDir(dir, func(string, os.DirEntry, error) error { return nil })
		}},

		{"os.Chmod", func() error { return os.Chmod(file, 0o644) }},
		{"os.Chtimes", func() error {
			now := time.Now()
			return os.Chtimes(file, now, now)
		}},
		{"os.Rename", func() error { return os.Rename(file, renamed) }},
		{"os.Symlink", func() error { return os.Symlink(renamed, link) }},
		{"os.Readlink", func() error {
			_, err := os.Readlink(link)
			return err
		}},
		{"os.Remove", func() error { return os.Remove(link) }},
		{"os.RemoveAll", func() error { return os.RemoveAll(sub) }},

		{"os.Getwd", func() error {
			_, err := os.Getwd()
			return err
		}},
		{"os.TempDir", func() error {
			if os.TempDir() == "" {
				return fmt.Errorf("空 TempDir")
			}
			return nil
		}},
		{"os.UserHomeDir", func() error {
			_, err := os.UserHomeDir()
			return err
		}},

		// ---- 以下探测在正常执行时不会发生（不可达守卫）----
		{"os.Stdin.Read(guarded)", func() error {
			if !guarded() {
				return nil
			}
			buf := make([]byte, 1)
			_, err := os.Stdin.Read(buf)
			return err
		}},
		{"os.Exit(guarded)", func() error {
			if !guarded() {
				return nil
			}
			os.Exit(3)
			return nil
		}},
		{"os.Stderr.Write(guarded)", func() error {
			if !guarded() {
				return nil
			}
			_, err := os.Stderr.WriteString("probe\n")
			return err
		}},
		{"os.Stdout.Seek(guarded)", func() error {
			if !guarded() {
				return nil
			}
			_, err := os.Stdout.Seek(0, io.SeekCurrent)
			return err
		}},
	}
}

// 下面这些调用只为"确保链接器保留对应路径"而存在（放在包级变量里，避免被内联消除）。
var (
	// 时间与随机源：clock_time_get / poll_oneoff / random_get（§15.1 第 1 条的取证面）。
	_ = func() int64 {
		start := time.Now()
		time.Sleep(time.Millisecond)
		var b [8]byte
		_, _ = rand.Read(b[:])
		return time.Since(start).Nanoseconds() + int64(b[0])
	}
	// 环境与参数：args_get / args_sizes_get / environ_get / environ_sizes_get（§10.2 第 23 项）。
	_ = func() int {
		n := len(os.Args)
		for _, kv := range os.Environ() {
			n += len(kv)
		}
		return n
	}
)
