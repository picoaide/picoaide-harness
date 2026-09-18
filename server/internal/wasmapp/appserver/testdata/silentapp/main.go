// Command silentapp 是"**读掉请求帧、然后正常退出但不返回响应帧**"的应用
// （§7.4 RUNTIME_NO_RESPONSE / §10.3 第 24 项的反面）。
//
// 它读掉请求帧就返回：guest 以 proc_exit(0) 结束、stdout 上什么都没有。
// 宿主必须把它判成 RUNTIME_NO_RESPONSE(502) —— 绝不允许"Call 返回 err=nil 就当成功"
// （§7.4 硬断言：err=nil 但响应帧缺失时必须映射为失败，绝不返回 200）。
package main

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
)

const frameMagic = 0x1e

func main() {
	in := bufio.NewReader(os.Stdin)
	if err := readFrame(in); err != nil {
		// stderr 不参与帧协议：宿主只把它当诊断尾巴捕获（§4.9 StderrTailBytes）。
		fmt.Fprintf(os.Stderr, "silentapp: read frame: %v\n", err)
		os.Exit(3)
	}
	// 刻意什么都不写：不写协议帧、不写日志、不写响应信封。
}

// readFrame 读一个完整帧（§7.1：长度前缀 + 一次读满）。
func readFrame(in *bufio.Reader) error {
	first, err := in.ReadByte()
	if err != nil {
		return err
	}
	if first != frameMagic {
		return fmt.Errorf("首字节 0x%02x 不是帧魔数", first)
	}
	var digits []byte
	for {
		b, err := in.ReadByte()
		if err != nil {
			return err
		}
		if b == '\n' {
			break
		}
		if b < '0' || b > '9' {
			return fmt.Errorf("长度前缀非法")
		}
		digits = append(digits, b)
	}
	n, err := strconv.Atoi(string(digits))
	if err != nil {
		return err
	}
	buf := make([]byte, n)
	total := 0
	for total < n {
		read, err := in.Read(buf[total:])
		total += read
		if err != nil {
			return err
		}
	}
	return nil
}
