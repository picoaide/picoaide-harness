BIN := bin/picoaide-server

# 服务端镜像名(GHCR,与仓库同名);TAG 默认 latest
IMAGE ?= ghcr.io/picoaide/picoaide-harness-server
TAG ?= latest
# 注入镜像内 --version 的版本号(默认取 git describe;可显式覆盖 VERSION=0.4.0)
VERSION ?= $(shell git describe --tags --always 2>/dev/null | sed 's/^v//')

# 客户端已下线(2026-08):仓库只保留服务端接口 + webadmin 管理端。
# 测试/构建入口收敛为:test-server / webadmin / build-server / docker-image / check。
#
# 2026-09-10 性能:测试临时库改为从模板库克隆(internal/serverstore/dbtest.go 的
# NewTestDB)→ 每个 DB 用例不再重放 52 个迁移,单用例固定开销从 ~1.5s 降到 ~0.1s。
# 模板库叫 picoaide_tmpl_<迁移哈希>(按迁移内容/分区窗口自动换名),由首个用例
# 建一次并留在 PG 实例里;要强制重建就手工 DROP DATABASE picoaide_tmpl_*。
# 另:go test 结果会被缓存,`make test-server-fast` 在无改动时整轮秒级返回;
# `make check` 仍带 -count=1(发布门禁,永远真跑)。
.PHONY: test test-server test-server-fast build-server webadmin docker-image check check-fast

# 并行测试包的并发数(本地默认 4;CI 的 `go test -p 1` 见 .github/workflows/ci.yml,
# 那里串行是为了 service 容器的 max_connections,不是性能考虑)。
TEST_PARALLEL ?= 4

test:
	go test ./... -count=1

# CI 门禁(审计 2026-08-25 G2):必须覆盖全部业务包——agentshare/sharedskills
# 曾是两个游离于自动化之外的新商城包,其越权/多版本缺陷零拦截。
# 2026-08-31:加入 updatecheck(版本检查)。
# 2026-09-08(P2-49):改为目录通配——此前手工枚举 9 个包,漏跑 10 个含
# _test.go 的包(appstore/archiveutil/brand/capabilities/connectors/reports/
# router/skillmanifest/telemetry/cmd/server),新增包也会再次漏跑。
# 与 CI 的 `go test ./...` 同义(internal/ + cmd/ 即全部业务包;scripts/ 无测试)。
test-server:
	go test ./internal/... ./cmd/... -count=1 -p $(TEST_PARALLEL)

# 开发循环用的快速测试:不加 -count=1,未改动的包直接命中 go test 结果缓存
# (实测全仓无改动 0.3s;改一个包只重跑那一个包)。发布门禁请用 test-server/check。
test-server-fast:
	go test ./internal/... ./cmd/... -p $(TEST_PARALLEL)


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

# 离线镜像导出已移出仓库:发布流程由 CI 在 tag 时产出 tar 上传更新服务器,
# 客户侧按 docs/deploy/AI-DEPLOY.md 从更新服务器下载后 docker load。
# (原 release-export 目标于 2026-09-10 随部署脚本一并移除)

check:
	@if [ -n "$$(gofmt -l cmd internal)" ]; then echo "gofmt未通过:"; gofmt -l cmd internal; exit 1; fi
	go vet ./cmd/... ./internal/...
	$(MAKE) test-server
	cd webadmin && npm test && npm run build

# 开发循环快速门禁:gofmt + vet + 快速测试(命中 go test 缓存)+ webadmin 单测。
# 与 check 的差异:不跑 webadmin 构建(tsc -b && vite build,~17s)、不带 -count=1。
# 提交前/发布前仍须跑 `make check`(CI 跑的就是它那一套)。
check-fast:
	@if [ -n "$$(gofmt -l cmd internal)" ]; then echo "gofmt未通过:"; gofmt -l cmd internal; exit 1; fi
	go vet ./cmd/... ./internal/...
	$(MAKE) test-server-fast
	cd webadmin && npm test
