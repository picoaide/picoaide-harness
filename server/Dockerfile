# 注意:本文件**不写 `# syntax=docker/dockerfile:1`**。
# 那条指令会让每次构建都先去 Docker Hub 解析前端镜像 —— 2026-09-10 实测
# Docker Hub 不可达时整条发布链直接死在这里(ERROR: failed to resolve source
# metadata for docker.io/docker/dockerfile:1),而本文件用到的特性(命名构建
# 上下文 `COPY --from=<name>`、通配 COPY)在当前 BuildKit 的内置前端里都支持。
# 去掉它 = 发布链少一个外部单点。
#

# PicoAide 服务端多阶段构建(架构设计 §2 目录、计划 Task 4.6)
# 运行镜像含 /data 挂载卷;密钥/数据库落在 /data,部署时以 volume 持久化。
#
# ⚠️ 本文件依赖**两个命名构建上下文**(缺了 BuildKit 会把名字当镜像引用去拉取,
# 报错完全不指向真实原因 —— 本项目历史上正是被 Docker Hub 可达性坑过):
#   clientassets   客户端安装包 + CLIENT-RELEASE.json(随镜像分发;目录必须存在,可为空)
#   channelassets  渠道内容目录(内含 <CHANNEL>/;目录必须存在,可为空)
#
# 构建(本地单平台;`make docker-image` 就是这条,CHANNEL 缺省 official):
#   mkdir -p client-assets/client channels-context/official   # 空目录合法
#   docker build --build-arg VERSION=0.4.0 --build-arg CHANNEL=official \
#     --build-context clientassets=./client-assets \
#     --build-context channelassets=./channels-context \
#     -t picoaide-harness-server:v0.4.0 .
# 构建(单平台 amd64,CI 用;渠道内容只放本渠道一个目录):
#   docker buildx build --platform linux/amd64 \
#     --build-arg VERSION=0.4.0 --build-arg CHANNEL=<channel-id> \
#     --build-context clientassets=./client-assets \
#     --build-context channelassets=./channels-context \
#     -t picoaide-harness-server:v0.4.0 --load .
# 发布镜像不经任何镜像仓库:CI 在 tag 时逐渠道构建 → docker save → zip → 更新服务器
# (scripts/ci-build-channel-images.sh);客户侧 docker load,见 docs/deploy/AI-DEPLOY.md。

# --- Stage 1: webadmin(go:embed dist 需要预构建产物) ---
FROM node:24-alpine AS webadmin
WORKDIR /build
# webadmin 不再编译期注入任何品牌素材:logo/名称全部来自渠道内容
# (GET /api/client/v2/channel,镜像内 /opt/picoaide/channel/)。仓库里不留
# 品牌描述,因此这里也不需要 root 构建上下文(2026-09-10 审计)。
#
# 功能模块变体（2026-10-14，P3 第二片）：**必须与 Stage 2 的 GO_TAGS 是同一个串**，
# 否则会出现"服务端裁了接口、管理端还留着页面"（点进去全是 404）或反过来的半通状态。
# 两种编码：webadmin 用显式 `none` 表示三个全关，Go 用空 tag 集。
#   变体标识   skills,apps,connectors / apps,connectors / … / none
#   不传这个 build-arg ⇒ 缺省全开（与本次改造之前的产物同源）。
# 判据：webadmin 侧的产物双侧断言 = `server/webadmin/scripts/check-feature-chunks.mjs`
#       （`make -C server webadmin-check-features`）；Go 侧 = `make -C server check-tags`。
ARG FEATURES=skills,apps,connectors
# 用 ENV 而不是把变量写进 RUN：`npm run build`（tsc -b && vite build）整条链路都要能读到
# 同一个值（vite.config.ts 与 vitest.config.ts 都从环境读，真源解析在 webadmin/features.mjs）。
ENV FEATURES=$FEATURES
COPY webadmin/package.json webadmin/package-lock.json ./
RUN npm ci
COPY webadmin/ ./
RUN npm run build

# --- Stage 2: 服务端静态编译(CGO_ENABLED=0,modernc sqlite 纯 Go) ---
FROM golang:1.26-alpine AS build
WORKDIR /src
ARG TARGETOS=linux
ARG TARGETARCH=amd64
# VERSION 由构建方注入(CI 传 git tag 去掉 v 前缀;本地默认 dev):
#   cmd/server/main.go 的 var version = "dev",用 -X main.version=$VERSION 覆盖
ARG VERSION=dev
# 可选模块的编译期开关（2026-10-14，P1 第一片）：唯一真源 = `internal/features` 的
# build tag 文件，模块名与渠道契约逐字一致（skills / apps / connectors）。**缺省全开** ⇒
# 不传这个 build-arg 时镜像内容与本改造之前同源（本片只接线、不裁剪）。
# 取值逗号分隔、不加空格；`--build-arg GO_TAGS=`（空）= 三个模块全关的变体。
# `make docker-image` 会把自己的 `GO_TAGS`（同一份缺省值）透传过来；**必须写在包面
# 之前**（`go` 的 flag 解析在第一个非 flag 词处停止）。
ARG GO_TAGS=skills,apps,connectors
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ ./cmd/
COPY internal/ ./internal/
# 内置演示应用（员工自建应用平台，见 internal/wasmapp/appseed）：
# 一份 wasm + 一份清单，播种成 public/login/whitelist 三个演示应用。
COPY demoapps/ ./demoapps/
COPY --from=webadmin /build/dist ./webadmin/dist/
COPY webadmin/embed.go ./webadmin/
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -tags=$GO_TAGS -trimpath -ldflags "-s -w -X main.version=$VERSION" -o /out/picoaide-server ./cmd/server
# WASM 应用平台的编译子进程（R19/R31）：**必须**与 server 二进制同目录 ——
# compile.resolveChildBinary 按"自身可执行文件所在目录 + picoaide-app-compile"解析。
# 缺它的后果：发布链路 fail-closed（启动不再 Fatal，但功能不可用）。
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -tags=$GO_TAGS -trimpath -ldflags "-s -w" -o /out/picoaide-app-compile ./cmd/picoaide-app-compile
# 演示应用：目标是 **wasm32-wasip1**（不是宿主平台）。
# 2026-09-20 起是**三个功能不同**的演示（能力全集 / 内部小论坛 / 留言板），各一份
# 制品，清单逐条指出用哪一份（`wasm` 字段）以及窗口比例（`window`）。共用运行时
# 底座在 `demoapps/internal/demoapp`（帧协议 + 宿主能力包装）。
RUN mkdir -p /out/demo-apps \
 && for app in showcase forum board; do \
      CGO_ENABLED=0 GOOS=wasip1 GOARCH=wasm \
        go build -tags=$GO_TAGS -trimpath -ldflags "-s -w" -o /out/demo-apps/$app.wasm ./demoapps/$app; \
    done \
 && cp demoapps/demos.json /out/demo-apps/demos.json

# 前端资源打进 wasm 自定义段（宿主按路径直出 `/static/*`，入口 `/` 由 wasm 读
# `index.html` 返回 —— 这样"先判名单再给页面"才成立）。这一步需要 Node，而 Go
# 构建阶段没有它 ⇒ 单独一个 node 阶段接力；用的打包脚本与随技能分发的那一份
# **是同一个文件**（`demoapps/scripts/pack-assets.mjs` —— 打包器已经与技能源码
# 目录解耦，唯一实现放在**中性位置**，本阶段与技能目录都从这**同一个源** COPY）。
FROM node:24-alpine AS demoassets
WORKDIR /demo
COPY --from=build /out/demo-apps /demo/apps
COPY demoapps/showcase/web /demo/web/showcase
COPY demoapps/forum/web /demo/web/forum
COPY demoapps/board/web /demo/web/board
# 落点 1/2：本阶段的工作目录（打包三个演示应用时用）。
COPY demoapps/scripts/pack-assets.mjs /demo/pack-assets.mjs
RUN set -eu; mkdir -p /demo/packed \
 && for app in showcase forum board; do \
      node pack-assets.mjs --in apps/$app.wasm --out packed/$app.wasm \
        web/$app/index.html=index.html \
        web/$app/app.css=static/app.css \
        web/$app/app.js=static/app.js; \
    done \
 && cp apps/demos.json packed/demos.json \
 && chmod -R a+rX /demo/packed

# --- Stage 3: 运行镜像(CA 证书用于 HTTPS 上游/LDAPS;entrypoint 降权;数据卷 0700) ---
FROM alpine:3.21
# bubblewrap：WASM 应用平台编译子进程的 OS 级隔离（R31 / §15.1 第 14 条，
# 唯一"读不可信字节且可能写宿主"的进程）。**读到的是白名单**：沙箱内 / 是空 tmpfs，
# 只放行系统目录 + 模块目录 + 缓存目录（唯一可写），因此它读不到 master key、
# 也读不到别的应用的 SQLite 库。
# ⚠️ 容器里 bwrap 需要非特权 user namespace 或 `--cap-add SYS_ADMIN`（见部署文档）；
# 不可用时 compile.New 按 PICOAI_COMPILE_ISOLATION 决定回落还是拒绝启动。
RUN apk add --no-cache ca-certificates tzdata su-exec bubblewrap && \
    adduser -D -u 10001 -h /app picoaide
WORKDIR /app
COPY --from=demoassets /demo/packed /opt/picoaide/demo-apps
COPY --from=build /out/picoaide-server /app/picoaide-server
COPY --from=build /out/picoaide-app-compile /app/picoaide-app-compile
COPY docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# --- 交付面自包含:镜像内自带整套部署栈文件 ---
# 客户侧不需要仓库、不需要外网拉配置:一个 docker run 就能把
# compose + Caddyfile + .env.example + VERSION 导到部署目录。
# (这些是编排文件,只被 entrypoint 拷出,与 webadmin 的 go:embed 无关。)
COPY docker-compose.yml Caddyfile.internal Caddyfile.autocert Caddyfile.manual .env.example /opt/picoaide/deploy/
# 编译期注入的版本号:entrypoint 落客户端资产路径、updatecheck 比对、运维核对三处共用
# 注意:ARG 不跨 stage 继承,必须在 Stage 3 重新声明(否则此处 VERSION 为空,写出空 VERSION 文件)
ARG VERSION=dev
RUN echo "$VERSION" > /opt/picoaide/VERSION

# 本镜像所属渠道:官方镜像构建时为 official。服务端 updatecheck 据此校验清单的
# channel_id(PICOAI_CHANNEL 可在部署 .env 覆盖为品牌渠道)。
# 三者必须自洽:渠道、PICOAI_UPDATE_ENDPOINT 指向的目录、清单里的 channel_id ——
# 不一致会被 updatecheck 判为"检查不可用"(fail-loud,不静默跨渠道升级)。
ARG CHANNEL=official
RUN echo "$CHANNEL" > /opt/picoaide/CHANNEL
ENV PICOAI_CHANNEL=$CHANNEL

# --- 客户端安装包随镜像分发(单包交付的核心) ---
# 客户端资产由 CI 三平台 job 产出后经命名上下文 clientassets 输入,目录里直接是
# CLIENT-RELEASE.json(资产清单)+ 各平台安装包。服务端把 /opt/picoaide/client
# 这个目录对外提供(GET /api/client/v2/updates/manifest 与 /updates/client/<file>),
# 于是客户端从**它登录的这台服务端**取包、版本天然与服务端配套。
#
# 构建上下文契约:
#   clientassets/client/               目录必须**存在**(可为空 → 镜像不带客户端)
#   clientassets/CLIENT-RELEASE.json*  可选(本地构建没有)
# 实测:必须用**目录形式** `client/` —— 写成 `client/*` 通配时源目录为空会直接
# 构建失败("lstat /client: no such file or directory"),目录形式对空目录是允许的。
COPY --from=clientassets client/ /opt/picoaide/client/
# 清单必须放进**资产目录内**:服务端从 PICOAI_CLIENT_RELEASE_DIR 里读它
# (internal/clientrelease 的 LoadInfo 读 <dir>/CLIENT-RELEASE.json)。
# 2026-09-10 实测:原先 COPY 到 /opt/picoaide/(上一级),LoadInfo 永远返回 nil,
# 于是 /api/client/v2/updates/manifest 里没有 client 段、门户下载区全空 ——
# "客户端随镜像分发"这条链路整个是死的,而且没有任何报错。
COPY --from=clientassets CLIENT-RELEASE.json* /opt/picoaide/client/
RUN rm -f /opt/picoaide/client/.keep
# 目录位置固定,服务端直接读(无需 entrypoint 落盘:镜像层里读文件是只读、
# 一次性、随镜像升级而更新,正是我们要的语义)。
ENV PICOAI_CLIENT_RELEASE_DIR=/opt/picoaide/client
# 下载地址来源:客户端只接受**绝对 https** 地址(见 packages/host/desktop 的
# desktop-release.ts)。反代(Caddy)设了 X-Forwarded-Proto: https 就无需配置;
# 否则在此显式声明对外地址(如 PICOAI_PUBLIC_BASE_URL=https://ai.example.com,
# 允许带子路径),否则清单不下发 client 段并给出 client_unavailable 原因。
# ENV PICOAI_PUBLIC_BASE_URL=https://ai.example.com

# --- 内置技能随镜像分发（"技能内置到服务端、客户端按需安装"） ---
# 平台自带技能（当前是 WASM 应用作者手册 app-builder）放在镜像层里，服务端把
# /opt/picoaide/skills 直接对外提供：
#   GET /api/client/v2/skills/builtin                 清单（name/version/sha256/size…）
#   GET /api/client/v2/skills/builtin/:name/archive   tar.gz 包（响应头带 sha256/version）
# 客户端在能力中心**按需安装**（下载 → sha256 对照 → 整树解包 → <dshHome>/skills），
# 不自动安装、不需要管理员。技能内容随镜像升级而更新，正是"内置"要的语义。
#
# ⚠️ 技能源在**服务端仓库内的 `server/skills/`**（就是本 Dockerfile 的构建上下文），
# 随镜像分发、客户端按需安装 —— 不再依赖客户端 vendored 包（历史上曾用
# `--build-context skillassets=<仓库根>/packages/vendor/memory-evolve` 从
# dsh-memory-evolve 插件的 skills/ 目录取，2026-09-19 把作者手册搬进服务端并
# 去掉了那个构建上下文）。源只有这一份：不要在别处再放副本，两边漂移会让
# "员工装到的技能"与"仓库里评审过的技能"不是同一份。
# 客户端插件 `dsh-memory-evolve` 自己的 skills/（kimi/codex/grok/hermes-cli-calling、
# memory-consolidate）与本目录无关：它们是插件的 COI 同步资产，不是平台内置技能。
#
# **逐个列出，不用 `skills/*/` 通配**：通配会把误放进来的非技能目录（或将来某个
# 没有平台必需 frontmatter 的目录）一起 COPY 进镜像，而 skillseed 只会把它们记成
# "被跳过的坏资产"，把真正的告警淹掉。
#
# **新增一个平台内置技能 = 三处一起改**（缺一处就红）：判据是
# server/internal/wasmapp/skillseed/builtin_skills_test.go 的
# TestBuiltinSkillInventoryMatchesDiskDockerfileAndDigests —— 它把
# 「磁盘上的 server/skills/*/」「本节的 COPY 清单」「builtinSkillRegistry +
# seededSkillDigests 的技能集合」三方**双向**对拍（真解析本文件的 COPY 指令；
# 注释或字符串里出现过不算数）：
#   ① 磁盘：skills/<name>/SKILL.md，带齐平台 frontmatter
#      （version/title/description/author/category 缺一不可，且目录名必须等于
#      frontmatter 的 name —— 不一致会被 skillmanifest 校验拒掉、整条技能被静默跳过，
#      只能在启动日志里看到）；
#   ② 本文件：加一行 `COPY skills/<name>/ /opt/picoaide/skills/<name>/`
#      （目标必须逐字是 <PICOAI_SKILL_SEED_DIR>/<name>/，否则服务端扫不到）；
#   ③ 登记：skillseed 的 builtinSkillRegistry 加一条 + skill_version_test.go 的
#      seededSkillDigests 加一组摘要（否则技能不受「内容变 ⇒ 版本必须变」的纪律约束，
#      R1-pm-8 那类"装过的员工永远拿不到新版"会静默复发）。
# 只想把某个目录留在仓库里而**不**随镜像下发 ⇒ 在 builtinSkillRegistry 里登记
# {Shipped: false, Reason: …}（豁免逐条显式，不接受通配/整目录豁免）。
#
# ⚠️ 技能目录里**不由 skills/ 提供**的文件（唯一实现在中性位置、构建期注入）不是"第四处"，
# 而是登记在 skillseed 的 `skillFileInjections`（技能 / 目录内落点 / 中性源 / 落点数）：
# 本文件里凡把**非 skills/ 源**COPY 进 <PICOAI_SKILL_SEED_DIR> 的指令，都必须在那张表里
# 逐条登记，否则判据 Fatal（"读不出清单"不等于"清单是空的"）。
#
# ⚠️ 两条位置纪律（判据硬判，不是约定）：
#   ① 凡落进 <PICOAI_SKILL_SEED_DIR> 的 COPY/ADD 必须在**最后一个构建阶段** —— 中间阶段
#     不进入最终镜像，文件到不了 /opt/picoaide/skills（dest 写对、落点数对、摘要模型对，
#     员工装到的技能却缺这个文件）；
#   ② **最终阶段的 RUN 不许出现技能目录的路径**（含 `$PICOAI_SKILL_SEED_DIR`）—— 判据只
#     解析 COPY/ADD，RUN 能在技能目录里写出判据看不见的字节（那样"镜像字节 == 中性源字节"
#     就不成立，而摘要登记的仍是中性源的那一份）。技能目录的内容只能由 COPY/ADD 决定。
#     要断言镜像里技能文件存在，请写进 scripts/ci-build-channel-images.sh 的 verify_image。
COPY skills/app-builder/ /opt/picoaide/skills/app-builder/
# 落点 2/2：把打包器从**同一个中性源**注入技能目录，镜像内布局与解耦前逐字节一致
# （`/opt/picoaide/skills/app-builder/scripts/pack-assets.mjs` 仍在，技能文档里的
# `scripts/pack-assets.mjs` 相对路径照旧可用）。
# ⚠️ 这一条不是"随手补的副本"：源树里只有 `demoapps/scripts/pack-assets.mjs` 这一份
# 实现（技能目录下**不再有**该文件），两个落点同源 ⇒ 规则不可能漂。注入关系登记在
# skillseed 的 `skillFileInjections`，判据会核对"同源 + 两个落点 + 摘要一致"。
COPY demoapps/scripts/pack-assets.mjs /opt/picoaide/skills/app-builder/scripts/pack-assets.mjs
# 目录位置固定，服务端直接读（无需 entrypoint 落盘）。可用该 env 覆盖成
# 别的路径（如挂载宿主机目录做现场排查），照 clientrelease 的
# PICOAI_CLIENT_RELEASE_DIR 风格。
ENV PICOAI_SKILL_SEED_DIR=/opt/picoaide/skills

# --- 渠道配置随镜像分发(服务端对外内容的唯一来源) ---
# CI 构建前把仓库 channels/<channel-id>/ (配置 + logo 等素材)复制成
# channels-context/channel/,这里直接放进镜像。服务端读它下发
# GET /api/client/v2/channel:门户页、客户端登录页与界面用的是**同一份**内容,
# 因此改渠道内容 = 改配置 → 重新构建镜像,内容始终可审计、可追溯。
# 本地构建不带该上下文时源目录为空 → 渠道目录缺文件,服务端回落内置文案
# (channel.Load 的兜底),不影响启动。
# 渠道由构建参数选定(CI 传 --build-arg CHANNEL=<id>;本地默认 official),
# 构建上下文 channels-context/<id>/ 由 CI 从私有渠道仓检出后暂存。
# 渠道化因此发生在**构建期**:同一个 Dockerfile,参数不同 → 不同渠道的镜像。
COPY --from=channelassets ${CHANNEL}/ /opt/picoaide/channel/
ENV PICOAI_CHANNEL_DIR=/opt/picoaide/channel
# 以 root 启动 entrypoint(修正挂载卷所有权)→ su-exec 降权到 picoaide 运行
USER root
VOLUME ["/data"]
EXPOSE 8080
# 健康检查元数据:与 docker-compose.yml 中的 healthcheck 同源
# /healthz 无需认证返回 200;busybox wget 退出码 0=healthy(连接失败/非200=unhealthy)
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/app/entrypoint.sh"]
CMD []
