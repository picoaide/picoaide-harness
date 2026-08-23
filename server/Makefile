BIN := bin/picoaide-server

# 服务端镜像名(GHCR,与仓库同名);TAG 默认 latest
IMAGE ?= ghcr.io/picoaide/picoaide-server
TAG ?= latest
# 注入镜像内 --version 的版本号(默认取 git describe;可显式覆盖 VERSION=0.4.0)
VERSION ?= $(shell git describe --tags --always 2>/dev/null | sed 's/^v//')

# 客户端已下线(2026-08):仓库只保留服务端接口 + webadmin 管理端。
# 测试/构建入口收敛为:test-server / webadmin / build-server / docker-image / check。
.PHONY: test test-server build-server webadmin docker-image release-export check

test:
	go test ./... -count=1

test-server:
	go test ./internal/serverauth/... ./internal/llmgateway/... ./internal/marketplace/... ./internal/serverstore/... -count=1

# webadmin 是编译进 Go 二进制的临时产物:build-server 自动先构建,不单独编译
build-server: webadmin
	go build -o $(BIN) ./cmd/server

webadmin:
	cd webadmin && npm run build

# 服务端 Docker 镜像(计划 Task 4.6):本地构建单平台,带版本注入(--version 输出 VERSION)
# 用法:make docker-image 或 make docker-image IMAGE=ghcr.io/picoaide/picoaide-server TAG=v0.4.0
docker-image:
	@echo "  构建镜像 $(IMAGE):$(TAG) (VERSION=$(VERSION))"
	docker build --build-arg VERSION=$(VERSION) -t $(IMAGE):$(TAG) .

# 离线导出镜像 tar(内网无 registry 部署用):docker load < picoaide-server-<TAG>.tar
# 用法:make release-export TAG=v0.4.0(默认导出 ./dist/picoaide-server-latest.tar)
RELEASE_EXPORT ?= dist/picoaide-server-$(TAG).tar
release-export:
	@echo "  导出离线镜像 $(IMAGE):$(TAG) → $(RELEASE_EXPORT)"
	docker build --build-arg VERSION=$(VERSION) -t $(IMAGE):$(TAG) .
	docker image save $(IMAGE):$(TAG) -o $(RELEASE_EXPORT)
	@echo "  已导出: $(RELEASE_EXPORT)"
	@echo "  目标机导入: docker load < $(RELEASE_EXPORT)"

check:
	gofmt -l cmd internal | grep -v '^$$' && exit 1 || true
	go vet ./cmd/... ./internal/...
	$(MAKE) test-server
	cd webadmin && npm test && npm run build
