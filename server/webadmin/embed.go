// Package webadmin embeds the built admin UI for static serving.
//
// 构建契约(2026-09): dist/ 是 vite 构建产物,不做版本控制存储——源码仓库
// 仅提交 dist/.gitkeep 占位(保证 go:embed 目录非空);正式构建时由
// `make build-server` 两段式先跑 `webadmin`(npm run build 生成 dist),
// 再 `go build` 将真实产物嵌入二进制。直接 `go build ./...` 时 dist 为空,
// 仅嵌入占位文件,ServeHTTP 对缺失的 index.html 走错误信封降级。
package webadmin

import "embed"

//go:embed dist/*
var FS embed.FS
