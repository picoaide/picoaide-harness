BIN := bin/picoaide-server

# 服务端镜像名(GHCR,与仓库同名);TAG 默认 latest
IMAGE ?= ghcr.io/picoaide/picoaide-harness-server
TAG ?= latest
# 渠道(镜像内容的一部分):Dockerfile 的 channelassets 上下文取
# channels-context/<CHANNEL>/(CI 从私有渠道仓检出;本地为空目录 = 不带渠道内容)。
CHANNEL ?= official
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

# 单包测试超时——**必须按上下文（-p）分别取值，余量结论不可跨上下文搬运**。
#
# 2026-09-19 第三轮审计 F3-5 实测（同一台 4 vCPU 机器，与 CI runner 同规格；
# 全部 52 包 EXIT=0，`go test -json` 逐包耗时；两个上下文各一行）：
#   【-p 1】CI 的 `go test ./... -p 1` 与 `make test`
#        WALL 1471.8s；最慢 llmgateway 250.4s、serverstore 140.2s、wasmapp/api 232.2s
#        ⇒ 对 600s 有 2.4× 余量、对 900s 有 3.6× 余量 ⇒ 适用值 15m（TEST_TIMEOUT）。
#   【-p 4】`make test-server`（默认 TEST_PARALLEL=4）
#        WALL 787s；最慢 llmgateway **625.0s**（比 -p 1 涨 2.5×）、serverstore 513.9s
#        （涨 3.7×）、wasmapp/api 321.3s
#        ⇒ 对 900s 只剩 1.44× 余量、**对旧的 600s 默认已经撞穿**（625 > 600）
#        ⇒ 适用值 25m（TEST_TIMEOUT_PARALLEL）。
#
# ⚠️ 两个已犯过的错，下一个人不要再犯：
#   ① "Go 默认 10m 有 ≥2× 余量" **只对 -p 1 成立**。本仓历史上那两次
#      `panic: test timed out after 10m0s` 曾被归因为"并发跑多套重型测试的负载假象"，
#      现在看**不是假象**：`-p 4` 这条路径的最慢包实测 625s，本来就会撞穿 600s。
#      -p 1 的 250s 数据**不能**用来论证 -p 4 的余量（并行争抢让单包 wall 涨 2.5–3.7×）。
#   ② 因此**不要**把某一上下文的实测余量搬到另一个上下文，也不要让两个入口共用一个
#      超时变量：`test`（-p 1）与 `test-server`（-p 4）各自钉自己的值。
#
# 25m 的推导：p1 最坏一轮 llmgateway 298.9s × 2.5（并行膨胀）≈ 750s，再乘 2× 单包抖动
# ≈ 1500s < 25m；同时远小于 CI job 的 45min，真挂时仍打得完 goroutine dump 与用例名。
# `make check` 走 test-server ⇒ 也拿到 25m。CI 的 `go test -p 1 -timeout 15m` 是
# .github/workflows/ci.yml 里写死的字面量（**不受本文件任何变量影响**），口径未变。
# 注意：放宽单包超时不能替代 CI 的 job 预算——两者必须满足
# 「job timeout > 单包超时 + 其余包耗时」，否则真挂时 job 先被整体取消，
# 诊断反而比默认 10m 更差（见 .github/workflows/ci.yml 的 server job 与
# `scripts/check-workflows.mjs` 的 SK-7b 策略：它静态核对 2×timeout+5 ≤ job 预算）。
TEST_TIMEOUT ?= 15m

# `make test-server` 是 `-p $(TEST_PARALLEL)`（默认 4），沿用 -p 1 论证出的 15m 会让
# 最慢包只剩 1.44× 余量（见上）。可用 `make test-server TEST_TIMEOUT_PARALLEL=15m`
# 显式退回旧口径（例如要复现旧行为）。
TEST_TIMEOUT_PARALLEL ?= 25m

test:
	go test ./... -count=1 -timeout $(TEST_TIMEOUT)

# CI 门禁(审计 2026-08-25 G2):必须覆盖全部业务包——agentshare/sharedskills
# 曾是两个游离于自动化之外的新商城包,其越权/多版本缺陷零拦截。
# 2026-08-31:加入 updatecheck(版本检查)。
# 2026-09-08(P2-49):改为目录通配——此前手工枚举 9 个包,漏跑 10 个含
# _test.go 的包(appstore/archiveutil/brand/capabilities/connectors/reports/
# router/skillmanifest/telemetry/cmd/server),新增包也会再次漏跑。
# 与 CI 的 `go test ./...` 同义(internal/ + cmd/ 即全部业务包;scripts/ 无测试)。
test-server:
	go test ./internal/... ./cmd/... -count=1 -p $(TEST_PARALLEL) -timeout $(TEST_TIMEOUT_PARALLEL)

# 开发循环用的快速测试:不加 -count=1,未改动的包直接命中 go test 结果缓存
# (实测全仓无改动 0.3s;改一个包只重跑那一个包)。发布门禁请用 test-server/check。
test-server-fast:
	go test ./internal/... ./cmd/... -p $(TEST_PARALLEL)


# webadmin 是编译进 Go 二进制的临时产物:build-server 自动先构建,不单独编译
build-server: webadmin
	go build -o $(BIN) ./cmd/server
	@# WASM 应用平台的编译子进程：必须与 server 同目录（compile 按自身路径解析）。
	go build -o $(dir $(BIN))picoaide-app-compile ./cmd/picoaide-app-compile

# 两段式构建(2026-09): 先构建前端 dist, 再 go build 嵌入真实产物。
# vite build 会清空 dist 目录, build 后恢复 .gitkeep 占位(go:embed dist/*
# 需要目录非空; 源码仓库只跟踪 .gitkeep)。
webadmin:
	cd webadmin && npm run build
	@touch webadmin/dist/.gitkeep

# 服务端 Docker 镜像(计划 Task 4.6):本地构建单平台,带版本注入(--version 输出 VERSION)
# 用法:make docker-image 或 make docker-image IMAGE=ghcr.io/picoaide/picoaide-harness-server TAG=v0.4.0
#      CHANNEL=<渠道 id>(缺省 official;渠道内容取 channels-context/<id>/)
#
# **两个命名构建上下文是必需的**(2026-09-23 审计 K-05):Dockerfile 里
# `COPY --from=clientassets …`(客户端安装包随镜像分发)与
# `COPY --from=channelassets …`(渠道内容)。`COPY --from=<name>` 的 <name> 若不是
# stage、也不是用户命名上下文,BuildKit 会把它当**镜像引用**去拉取 —— 于是
# `docker build .` 会停在"拉取 clientassets"上(报错完全不指向真实原因,本项目历史上
# 正是被 Docker Hub 可达性坑过)。两个目录**允许为空**(语义 = 本地镜像不带客户端/渠道
# 内容,服务端回落内置文案),但目录必须存在:目录形式的 COPY 对空目录合法,对**不存在**
# 的目录直接构建失败。
docker-image:
	@echo "  构建镜像 $(IMAGE):$(TAG) (VERSION=$(VERSION) CHANNEL=$(CHANNEL))"
	@# 内置技能资产（镜像内 /opt/picoaide/skills）就在本构建上下文里：
	@# server/skills/<name>/ —— 随镜像分发，客户端在能力中心按需安装。
	@# 曾经用 --build-context skillassets=../packages/vendor/memory-evolve 从
	@# 客户端 vendored 插件包取，2026-09-19 起源头归位服务端，不再需要该上下文。
	@mkdir -p client-assets/client "channels-context/$(CHANNEL)"
	docker build --build-arg VERSION=$(VERSION) --build-arg CHANNEL=$(CHANNEL) \
	  --build-context clientassets=./client-assets \
	  --build-context channelassets=./channels-context \
	  -t $(IMAGE):$(TAG) .

# 离线镜像导出已移出仓库:发布流程由 CI 在 tag 时产出 tar 上传更新服务器,
# 客户侧按 docs/deploy/AI-DEPLOY.md 从更新服务器下载后 docker load。
# (原 release-export 目标于 2026-09-10 随部署脚本一并移除)

check:
	# demoapps 也进闸：内置演示应用的 Go 源码随镜像分发，此前不在任何本地门禁里 ——
	# 写坏一个只能等 CI 构建镜像（或服务端启动播种）才发现。
	@if [ -n "$$(gofmt -l cmd internal demoapps)" ]; then echo "gofmt未通过:"; gofmt -l cmd internal demoapps; exit 1; fi
	go vet ./cmd/... ./internal/... ./demoapps/...
	$(MAKE) test-server
	cd webadmin && npm test && npm run build

# 开发循环快速门禁:gofmt + vet + 快速测试(命中 go test 缓存)+ webadmin 单测。
# 与 check 的差异:不跑 webadmin 构建(tsc -b && vite build,~17s)、不带 -count=1。
# 提交前/发布前仍须跑 `make check`(CI 跑的就是它那一套)。
check-fast:
	# demoapps 也进闸：内置演示应用的 Go 源码随镜像分发，此前不在任何本地门禁里 ——
	# 写坏一个只能等 CI 构建镜像（或服务端启动播种）才发现。
	@if [ -n "$$(gofmt -l cmd internal demoapps)" ]; then echo "gofmt未通过:"; gofmt -l cmd internal demoapps; exit 1; fi
	go vet ./cmd/... ./internal/... ./demoapps/...
	$(MAKE) test-server-fast
	cd webadmin && npm test
