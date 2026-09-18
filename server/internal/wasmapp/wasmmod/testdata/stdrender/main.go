// Command stdrender 是**导入面覆盖性门禁**用的最小程序（FIX-31 / 审计 P0-1），
// **不进白名单生成的来源清单** —— 这一点是刻意的：
//
//	来源程序（refapp / wasiprobe / stdprobe）决定白名单**生成**成什么；
//	本程序是一份**独立的判据**，决定"白名单够不够用"。
//
// 如果两者是同一份代码，"把 template 段从来源程序里删掉再重跑生成器"会让白名单与判据一起变小，
// 门禁仍然全绿（自洽但错误）。本程序固定表达"应用真的会写的代码"，独立于生成来源：
//
//	html/template 或 text/template 的 **Execute（渲染）** → sock_accept / sock_shutdown
//	(*os.File).ReadAt / WriteAt                     → fd_pread  / fd_pwrite
//
// 这四条缺失时的真实后果（审计复现）：任何用 html/template 渲染页面的应用——本平台最主要的
// 用法（§4.2 R8：HTML 编译进 wasm）——都会在上传期被 `IMPORT_NOT_ALLOWED` 拒。
//
// 构建：GOOS=wasip1 GOARCH=wasm go build ./internal/wasmmod/testdata/stdrender
// （由 wasmmod 的覆盖性门禁现场编译；本机原生跑也安全：只动自建临时目录）。
package main

import (
	"bytes"
	"html/template"
	"os"
	"path/filepath"
)

var page = template.Must(template.New("page").Parse(`<h1>{{.User}}</h1><p>{{.Note}}</p>`))

func main() {
	// ① 模板渲染（触发 sock_accept / sock_shutdown）。
	var body bytes.Buffer
	if err := page.Execute(&body, map[string]string{"User": "gate", "Note": "覆盖性门禁"}); err != nil {
		os.Exit(3)
	}

	// ② (*os.File).ReadAt / WriteAt（触发 fd_pread / fd_pwrite）。
	dir, err := os.MkdirTemp("", "stdrender-")
	if err != nil {
		os.Exit(4)
	}
	defer func() { _ = os.RemoveAll(dir) }()

	f, err := os.Create(filepath.Join(dir, "page.html"))
	if err != nil {
		os.Exit(4)
	}
	defer f.Close()
	if _, err := f.WriteAt(body.Bytes(), 0); err != nil {
		os.Exit(4)
	}
	buf := make([]byte, body.Len())
	if _, err := f.ReadAt(buf, 0); err != nil {
		os.Exit(4)
	}
	if !bytes.Equal(buf, body.Bytes()) {
		os.Exit(5)
	}
	if _, err := os.Stdout.Write(buf); err != nil {
		os.Exit(6)
	}
}
