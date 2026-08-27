# syntax=docker/dockerfile:1

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
