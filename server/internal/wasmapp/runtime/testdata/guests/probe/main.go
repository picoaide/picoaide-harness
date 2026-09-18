// Command probe 是沙箱观测探针 guest：把"guest 看得见什么"逐行打到 stdout。
//
// 它**不实现帧协议**：宿主测试直接用执行侧的 ModuleConfig 实例化它并捕获 stdout
// （这正是 §10.2 第 21/22/23 项与零 preopen 的判据）。
//
// 构建：GOOS=wasip1 GOARCH=wasm go build -o probe.wasm ./probe
package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"syscall"
	"time"
)

func main() {
	fmt.Printf("args=%q\n", os.Args)
	fmt.Printf("environ=%q\n", os.Environ())
	b1 := make([]byte, 16)
	_, e1 := rand.Read(b1)
	b2 := make([]byte, 16)
	_, e2 := rand.Read(b2)
	fmt.Printf("rand1=%s err=%v\n", hex.EncodeToString(b1), e1)
	fmt.Printf("rand2=%s err=%v\n", hex.EncodeToString(b2), e2)
	now := time.Now().UTC()
	fmt.Printf("walltime_unix=%d\n", now.Unix())
	fmt.Printf("walltime_rfc3339=%s\n", now.Format(time.RFC3339Nano))

	op("open_etc_passwd", func() error {
		f, err := os.Open("/etc/passwd")
		if err == nil {
			f.Close()
		}
		return err
	})
	op("open_relative", func() error {
		f, err := os.Open("go.mod")
		if err == nil {
			f.Close()
		}
		return err
	})
	op("readdir_root", func() error { _, err := os.ReadDir("/"); return err })
	op("stat_etc", func() error { _, err := os.Stat("/etc"); return err })
	op("mkdir_tmp", func() error { return os.Mkdir("/tmp/wasmapp-probe", 0o755) })
	op("remove", func() error { return os.Remove("/etc/hostname") })
	op("writefile", func() error { return os.WriteFile("/tmp/pwn", []byte("x"), 0o644) })
	op("readlink", func() error { _, err := os.Readlink("/etc/mtab"); return err })
	if d, err := os.Getwd(); err == nil {
		fmt.Printf("cwd=%s\n", d)
	}
}

// op 打印一行机器可读的结果：字段顺序固定，错误详情放最后（测试按前缀解析）。
//
//	op <name> DENIED errno=<n> as_errno=<bool> err="..."
func op(name string, f func() error) {
	err := f()
	if err == nil {
		fmt.Printf("op %s ALLOWED errno=0 as_errno=false err=\"\"\n", name)
		return
	}
	var errno syscall.Errno
	ok := errors.As(err, &errno)
	fmt.Printf("op %s DENIED errno=%d as_errno=%t err=%q\n", name, int(errno), ok, err.Error())
}
