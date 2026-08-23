BIN := bin/picoaide-server

# 服务端镜像名(GHCR,与仓库同名);TAG 默认 latest
IMAGE ?= ghcr.io/picoaide/picoaide-server
TAG ?= latest

# 客户端已下线(2026-08):仓库只保留服务端接口 + webadmin 管理端。
# 测试/构建入口收敛为:test-server / webadmin / build-server / docker-image / check。
.PHONY: test test-server build-server webadmin docker-image check

test:
	go test ./... -count=1

test-server:
	go test ./internal/serverauth/... ./internal/llmgateway/... ./internal/marketplace/... ./internal/serverstore/... -count=1

# webadmin 是编译进 Go 二进制的临时产物:build-server 自动先构建,不单独编译
build-server: webadmin
	go build -o $(BIN) ./cmd/server

webadmin:
	cd webadmin && npm run build

# 服务端 Docker 镜像(计划 Task 4.6):本地验证单平台;CI 用 buildx 出 amd64
# 用法:make docker-image 或 make docker-image IMAGE=ghcr.io/picoaide/picoaide-server TAG=v0.4.0
docker-image:
	docker build -t $(IMAGE):$(TAG) .

check:
	gofmt -l cmd internal | grep -v '^$$' && exit 1 || true
	go vet ./cmd/... ./internal/...
	$(MAKE) test-server
	cd webadmin && npm test && npm run build
