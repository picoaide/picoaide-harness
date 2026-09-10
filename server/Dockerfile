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
# 构建(本地单平台):
#   docker build -t ghcr.io/picoaide/picoaide-harness-server:<tag> .
# 构建(带版本号,--version 输出一致):
#   docker build --build-arg VERSION=0.4.0 -t ghcr.io/picoaide/picoaide-harness-server:v0.4.0 .
# 构建(单平台 amd64,CI 用):
#   docker buildx build --platform linux/amd64 \
#     --build-arg VERSION=0.4.0 -t ghcr.io/picoaide/picoaide-harness-server:v0.4.0 --push .

# --- Stage 1: webadmin(go:embed dist 需要预构建产物) ---
FROM node:24-alpine AS webadmin
WORKDIR /build
# webadmin 不再编译期注入任何品牌素材:logo/名称全部来自渠道内容
# (GET /api/client/v2/channel,镜像内 /opt/picoaide/channel/)。仓库里不留
# 品牌描述,因此这里也不需要 root 构建上下文(2026-09-10 审计)。
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
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ ./cmd/
COPY internal/ ./internal/
COPY --from=webadmin /build/dist ./webadmin/dist/
COPY webadmin/embed.go ./webadmin/
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o /out/picoaide-server ./cmd/server

# --- Stage 3: 运行镜像(CA 证书用于 HTTPS 上游/LDAPS;entrypoint 降权;数据卷 0700) ---
FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata su-exec && \
    adduser -D -u 10001 -h /app picoaide
WORKDIR /app
COPY --from=build /out/picoaide-server /app/picoaide-server
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
