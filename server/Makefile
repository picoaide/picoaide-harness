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
.PHONY: test test-server test-server-fast build-server webadmin webadmin-check-features webadmin-variant-tests docker-image check check-fast check-tags

# 并行测试包的并发数(本地默认 4;CI 的 `go test -p 1` 见 .github/workflows/ci.yml,
# 那里串行是为了 service 容器的 max_connections,不是性能考虑)。
TEST_PARALLEL ?= 4

# ---------------------------------------------------------------------------
# Go 扫描面**唯一真源**(2026-09-23 第六轮审计 R6-C P2-1)
#
# 现场:`gofmt`/`vet`/`test` 三面都只扫 `cmd internal demoapps`,而同一个 Go module 里
# 还有 `webadmin/`(embed.go)与 `scripts/`(mock-upstream.go)两个包 —— CI 的
# `go vet ./...` / `go test ./...` 覆盖它们,本地 `make check` 不覆盖 ⇒ 这两处写坏
# 是"本地绿、CI 红";gofmt 违规更是两边都不查。`:72` 当时自称"与 CI 同义",那是不实陈述。
#
# 现在三面都由这一份目录真源派生;CI 的 gofmt 扫描面由
# `scripts/verify-ci-scripts.mjs` 与本文件逐条对拍(只改一侧 ⇒ 红)。
#
# **为什么不用 `./...`**:`server/temp/**` 下是未跟踪的本地探针(有时是别人正在写的
# 半个包),`make test` 用 `./...` 时会被卷进来。这里显式枚举的是**版本库里的** Go 包;
# 新增 Go 包时把它加进 GO_DIRS(并同步 CI 的 gofmt 扫描面)。
# ---------------------------------------------------------------------------
GO_DIRS := cmd internal demoapps webadmin scripts
GO_PACKAGES := $(addprefix ./,$(addsuffix /...,$(GO_DIRS)))

# ---------------------------------------------------------------------------
# 可选模块的**编译期开关**（2026-10-14，P1 第一片）。唯一真源 = 包
# `internal/features` 的 build tag 文件；本变量只是"构建入口往里传的那串"。
#
#   模块名与渠道契约逐字一致：`skills` / `apps` / `connectors`（渠道配置与客户端组装
#   清单按同一批字面量比对）。缺省**全开** ⇒ 既有行为逐字节不变。本片只做"接线 + 判据"，
#   **不做裁剪**：关掉某模块时它照样被编进来（真正的条件化是第二片的事，见
#   docs/decisions/2026-10-14-server-build-tags.md）。
#
#   覆盖姿势（矩阵判据 scripts/check-go-build-tags.mjs 就是逐组合跑这些命令）：
#     make test-server GO_TAGS=                      # 三个模块全关
#     make test-server GO_TAGS=skills                # 只开技能面
#     make test-server GO_TAGS=apps                  # 只开应用面
#     make check       GO_TAGS=skills,apps,connectors  # 全开（缺省）
#
#   两条硬约束：
#     ① 取值**逗号分隔、不加空格**（Go 的 `-tags` 语法；带空格会被拆成包面参数）。
#     ② `$(GO_TAG_FLAG)` **必须写在包面之前**：`go` 自带 flag 解析在第一个非 flag 词处
#        停止，`go vet ./... -tags=x` 会被当成包模式，报 `malformed import path "-tags=x"`。
#        （`.github/workflows/ci.yml` 的 `go vet` 因此写成 `go vet -tags=… ./...`；那条命令
#        对应的 `ci-go-vet` 载荷口径于 2026-10-14 从"argv[1] 逐字 ./..."改成"第一个不以
#        `-` 开头的词逐字 ./..." —— 缩面照样红，见决策记录 §3。）
# ---------------------------------------------------------------------------
# @generated:module-contract (scripts/gen-module-contract.mjs) — 手改会被 --check 判红
GO_TAGS ?= skills,apps,connectors
# @end:module-contract
GO_TAG_FLAG := -tags=$(GO_TAGS)

# ---------------------------------------------------------------------------
# webadmin 变体（2026-10-14，P3 第二片）：与上面的 `GO_TAGS` 是**同一个串的两种编码**。
#
#   · Go 用空 tag 集表达"三个全关"（`-tags=`），webadmin 用**显式** `none`
#     （空串在 shell/CI 里到处都是"没设置"的歧义 —— 见 webadmin/features.mjs）；
#   · 所以这里做一次机械翻译，**唯一输入仍是 GO_TAGS**：只覆盖一个变量就能同时选对
#     服务端与管理端的变体。两者不一致的后果是"页面在、接口 404"（或反过来）这种
#     半通状态，而且不会有任何红灯 —— 这就是它们必须同源的原因。
#
#   覆盖姿势：
#     make build-server GO_TAGS=apps,connectors     # 关掉技能面（webadmin 同步）
#     make build-server GO_TAGS=                   # 三个全关（webadmin 自动用 none）
#   只覆盖 `FEATURES=` 而**不动 GO_TAGS** 只在**本地产物**这一层说得通
#   （例：`make webadmin FEATURES=apps,connectors` 打一个裁过的管理端）——
#   它正是上面说的半通状态，所以**镜像这一层不再接受它**：`make docker-image FEATURES=…` /
#   `docker build --build-arg FEATURES=…`（不同时传 GO_TAGS）会被 Dockerfile 里那条
#   fail-loud 断言当场拒掉（2026-10-14 独立审计 P2-5 的收口；判据在
#   `scripts/verify-ci-scripts.mjs` 第 19 节）。要打裁过的镜像就走 `GO_TAGS=`。
# ---------------------------------------------------------------------------
FEATURES ?= $(if $(strip $(GO_TAGS)),$(GO_TAGS),none)

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
	go test $(GO_TAG_FLAG) ./... -count=1 -timeout $(TEST_TIMEOUT)

# CI 门禁(审计 2026-08-25 G2):必须覆盖全部业务包——agentshare/sharedskills
# 曾是两个游离于自动化之外的新商城包,其越权/多版本缺陷零拦截。
# 2026-08-31:加入 updatecheck(版本检查)。
# 2026-09-08(P2-49):改为目录通配——此前手工枚举 9 个包,漏跑 10 个含
# _test.go 的包(appstore/archiveutil/brand/capabilities/connectors/reports/
# router/skillmanifest/telemetry/cmd/server),新增包也会再次漏跑。
# 2026-09-23(R6-C P2-1):扫描面改为从 GO_DIRS 派生(含 webadmin/ 与 scripts/)——
# 此前与 CI 的 `go test ./...` 不同义(那两个包只在 CI 上跑)。
test-server:
	go test $(GO_TAG_FLAG) $(GO_PACKAGES) -count=1 -p $(TEST_PARALLEL) -timeout $(TEST_TIMEOUT_PARALLEL)

# 开发循环用的快速测试:不加 -count=1,未改动的包直接命中 go test 结果缓存
# (实测全仓无改动 0.3s;改一个包只重跑那一个包)。发布门禁请用 test-server/check。
test-server-fast:
	go test $(GO_TAG_FLAG) $(GO_PACKAGES) -p $(TEST_PARALLEL)


# webadmin 是编译进 Go 二进制的临时产物:build-server 自动先构建,不单独编译
build-server: webadmin
	go build $(GO_TAG_FLAG) -o $(BIN) ./cmd/server
	@# WASM 应用平台的编译子进程：必须与 server 同目录（compile 按自身路径解析）。
	go build $(GO_TAG_FLAG) -o $(dir $(BIN))picoaide-app-compile ./cmd/picoaide-app-compile

# 两段式构建(2026-09): 先构建前端 dist, 再 go build 嵌入真实产物。
# vite build 会清空 dist 目录, build 后恢复 .gitkeep 占位(go:embed dist/*
# 需要目录非空; 源码仓库只跟踪 .gitkeep)。
#
# `FEATURES=$(FEATURES)` 从 `GO_TAGS` 派生（同一个串的两种编码，见文件上方）⇒ **被关闭
# 模块的页面代码不进 dist**，与 `go build -tags=$(GO_TAGS)` 的裁剪面一致。
webadmin:
	cd webadmin && FEATURES=$(FEATURES) npm run build
	@touch webadmin/dist/.gitkeep

# webadmin 变体的**产物级双侧判据**（P3 第二片）：真跑 5 次 vite build（全开 / 全关 /
# 逐个关闭），断言"关闭的模块其页面代码不进 dist、开启的必须进"（内容 = 哨兵串，
# 结构 = 页面 chunk 名）。它与上面的 `webadmin` 目标**同一条构建链**，因此不受
# "本目标自己传了别的 FEATURES"影响：判据脚本自己按矩阵设置环境。
# 分钟级（约 1 分钟），所以 `check-fast` 不含它；`check`（发布门禁）含。
webadmin-check-features:
	cd webadmin && npm run check:features

# webadmin **变体测试矩阵**（P3 第三片）：非缺省变体各跑一遍完整单测。
#
# 现场（独立审计 P1）：`nav.test.ts` / `routes.test.ts` 是**按变体给期望**的（关掉的模块
# 其侧栏条目 / 路由不得留在产物里），但它们只在有人**手动**设 `FEATURES` 时才会执行 ——
# CI 的 `npm test` 与 `make check` 的缺省都是全开变体。实测（变异 M3：删掉 `nav.ts` 里
# `FEATURE_NAV_ENTRIES.filter(…)` 那行）：`FEATURES=skills,apps npm test` 红，而同一次
# 变异下产物判据与全开门禁全绿 ⇒ 关闭变体会发布一个指向不存在路由的侧栏条目（点进去 404），
# 没有任何自动门禁拦得住。判据有效 ≠ 判据有人跑，所以矩阵本身要有**调度点**。
#
# 调度点 = `check`（本地发布门禁）与 CI 的 server job（同一条命令）。矩阵与实现都在
# `webadmin/scripts/check-feature-variants.mjs`（**唯一真源**；写成仓内脚本而不是本文件里的
# `for` 循环，是因为 `check-integration-tests` 的 CI 执行面闭包读不懂 `@for` 形态，而
# `cd webadmin && npm run …` 与上面的 `webadmin-check-features` 是同一条被闭包认识的形态）。
# 缺省变体不在这里重复（上层已跑过一次 `npm test`），只跑另外 4 个非缺省组合。
# 分钟级（4 × 完整套件），所以 `check-fast` 不含它。
webadmin-variant-tests:
	cd webadmin && npm run check:variant-tests

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
	  --build-arg GO_TAGS=$(GO_TAGS) \
	  --build-arg FEATURES=$(FEATURES) \
	  --build-context clientassets=./client-assets \
	  --build-context channelassets=./channels-context \
	  -t $(IMAGE):$(TAG) .

# 离线镜像导出已移出仓库:发布流程由 CI 在 tag 时产出 tar 上传更新服务器,
# 客户侧按 docs/deploy/AI-DEPLOY.md 从更新服务器下载后 docker load。
# (原 release-export 目标于 2026-09-10 随部署脚本一并移除)

check:
	# gofmt/vet 的扫描面与 test-server 同源（GO_DIRS）：webadmin/ 与 scripts/ 是同一个
	# Go module 里的包，CI 的 `go vet ./...` 覆盖它们而此前的本地门禁不覆盖（R6-C P2-1）。
	# CI 的 gofmt 步骤必须与这里逐字同面（verify-ci-scripts.mjs 对拍），改这里要同步改 CI。
	@if [ -n "$$(gofmt -l $(GO_DIRS))" ]; then echo "gofmt未通过:"; gofmt -l $(GO_DIRS); exit 1; fi
	go vet $(GO_TAG_FLAG) $(GO_PACKAGES)
	$(MAKE) test-server
	# webadmin 四件：单测（按当前变体给期望）→ **非缺省变体测试矩阵** → **变体产物判据**
	# （真跑 5 次构建）→ 正式构建。判据夹在中间：`npm run build` 产出的是 `make build-server`
	# 要嵌入的那份 dist（用同一个 FEATURES），而这两个判据都用各自的独立 outDir，不污染它。
	# 顺序上先跑分钟级的变体测试矩阵、再跑产物判据（前者红得更快、信息更直接）。
	cd webadmin && FEATURES=$(FEATURES) npm test
	$(MAKE) webadmin-variant-tests
	$(MAKE) webadmin-check-features
	cd webadmin && FEATURES=$(FEATURES) npm run build

# 开发循环快速门禁:gofmt + vet + 快速测试(命中 go test 缓存)+ webadmin 单测。
# 与 check 的差异:不跑 webadmin 构建(tsc -b && vite build,~17s)、不带 -count=1。
# 提交前/发布前仍须跑 `make check`(CI 跑的就是它那一套)。
check-fast:
	@if [ -n "$$(gofmt -l $(GO_DIRS))" ]; then echo "gofmt未通过:"; gofmt -l $(GO_DIRS); exit 1; fi
	go vet $(GO_TAG_FLAG) $(GO_PACKAGES)
	$(MAKE) test-server-fast
	# webadmin 侧读的是**同一个变体的另一种编码**（见文件上方 FEATURES 的说明）。不传
	# `FEATURES=$(FEATURES)` 时这一半恒跑全开变体 ⇒ `GO_TAGS` 指向少模块变体时，同一条
	# `make check-fast` 的两半（Go 侧 `-tags=$(GO_TAGS)` / webadmin 侧缺省全开）变体不同，
	# 「关掉的模块其单测期望也要跟着关」这一类回归在这一半判不出来。与 `check` 同形补齐。
	cd webadmin && FEATURES=$(FEATURES) npm test

# 变体矩阵判据（P1 第二片起：**裁剪断言生效**）：三个可选开关的**每一个**子集（8 个组合）
# 各 build（缺省再加 vet）一次，并断言"开着的模块包树在、关掉的模块包树不在"
# （`go list -deps ./cmd/server`）。组合**不是手抄的表**：脚本从渠道契约的
# `channelFeaturesVariant()` 取值域穷尽派生（`node scripts/check-go-build-tags.mjs --list`
# 是矩阵的唯一真源）。2026-10-14 独立审计 P1-2 的现场：这里曾写"4 个 skills/apps 组合 +
# 基线组合"，而漏掉的 3 组里恰好有一组（`connectors`）自己的判据是红的。
#
# ⚠️ **`--expect-cut` 是缺省值**（2026-10-14 P1 第二片翻转）：第一片时"包树消失"还不成立，
# 只能按 PENDING 报告；第二片把三个模块的路由/装配全部接成构建期条件注册之后，
# 关掉某模块它**必须**从依赖图里消失 —— 这条断言从此拦门禁，红了就是条件化被拆了。
# 想临时看"只报账"的形态：`make check-tags TAGS_ARGS=`（显式传空）。详见
# docs/decisions/2026-10-14-server-build-tags.md §4 与脚本头部注释。
#
# 本目标**刻意不进 `check`/`check-fast`**：它跑 8 次全仓 build(+vet)，是分钟级的判据，
# 不该塞进每个人的开发循环；CI 侧由 `.github/workflows/ci.yml` 的 server job 单列一步
# （`node scripts/check-go-build-tags.mjs --expect-cut`；2026-10-14 P1 第三片接入，
# 登记的判据步骤见 `scripts/check-workflows.mjs` 的 `REQUIRED_CI_STEPS`）。
#
# 用法：
#   make check-tags                            # 全部组合：build + vet + 裁剪断言（拦门禁）
#   make check-tags TAGS_ARGS=--no-vet         # 只 build（快）
#   make check-tags TAGS_ARGS=--list           # 只看矩阵（不跑 go）
#   make check-tags TAGS_ARGS=--expect-cut=apps  # 探针：对每个组合都要求"apps 被裁掉"（必红）
TAGS_ARGS ?= --expect-cut
check-tags:
	node scripts/check-go-build-tags.mjs $(TAGS_ARGS)
