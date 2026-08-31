BIN := bin/picoaide-server

# 服务端镜像名(GHCR,与仓库同名);TAG 默认 latest
IMAGE ?= ghcr.io/picoaide/picoaide-harness-server
TAG ?= latest
# 注入镜像内 --version 的版本号(默认取 git describe;可显式覆盖 VERSION=0.4.0)
VERSION ?= $(shell git describe --tags --always 2>/dev/null | sed 's/^v//')

# 客户端已下线(2026-08):仓库只保留服务端接口 + webadmin 管理端。
# 测试/构建入口收敛为:test-server / webadmin / build-server / docker-image / check。
.PHONY: test test-server build-server webadmin docker-image release-export check

test:
	go test ./... -count=1

# CI 门禁(审计 2026-08-25 G2):必须覆盖全部业务包——agentshare/sharedskills
# 曾是两个游离于自动化之外的新商城包,其越权/多版本缺陷零拦截。这里显式
# 枚举全部包,避免将来新增包再次漏跑。
# 2026-08-31:加入 updatecheck(版本检查)。
test-server:
	go test ./internal/serverauth/... ./internal/llmgateway/... ./internal/marketplace/... ./internal/serverstore/... ./internal/agentshare/... ./internal/sharedskills/... ./internal/bootstrap/... ./internal/util/... ./internal/updatecheck/... -count=1

# webadmin 是编译进 Go 二进制的临时产物:build-server 自动先构建,不单独编译
build-server: webadmin
	go build -o $(BIN) ./cmd/server

# 两段式构建(2026-09): 先构建前端 dist, 再 go build 嵌入真实产物。
# vite build 会清空 dist 目录, build 后恢复 .gitkeep 占位(go:embed dist/*
# 需要目录非空; 源码仓库只跟踪 .gitkeep)。
webadmin:
	cd webadmin && npm run build
	@touch webadmin/dist/.gitkeep

# 服务端 Docker 镜像(计划 Task 4.6):本地构建单平台,带版本注入(--version 输出 VERSION)
# 用法:make docker-image 或 make docker-image IMAGE=ghcr.io/picoaide/picoaide-harness-server TAG=v0.4.0
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
	@if [ -n "$$(gofmt -l cmd internal)" ]; then echo "gofmt未通过:"; gofmt -l cmd internal; exit 1; fi
	go vet ./cmd/... ./internal/...
	$(MAKE) test-server
	cd webadmin && npm test && npm run build
