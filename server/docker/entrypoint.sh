#!/bin/sh
# 容器入口:解析并补全 -addr/-data 默认值,以 root 修正数据目录所有权
# (bind mount 时镜像内 chown 不生效),再用 su-exec 降权到 picoaide 运行。
# 用户可 docker run <镜像> <任意服务端参数>,缺省 addr/data 自动补齐。
set -e

# 用 set -- 重建参数,避免手工引号拼接被二次展开破坏
DATA_DIR=/data
HAS_ADDR=0
HAS_DATA=0
prev=""
for arg in "$@"; do
  case "$prev" in
    -data) DATA_DIR=$arg; HAS_DATA=1 ;;
    -addr) HAS_ADDR=1 ;;
  esac
  prev=$arg
done

set -- "$@"
[ "$HAS_ADDR" = 1 ] || set -- "$@" -addr :8080
[ "$HAS_DATA" = 1 ] || set -- "$@" -data /data

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR" 2>/dev/null || true
  chown -R picoaide:picoaide "$DATA_DIR" 2>/dev/null || true
fi

# ---- 部署栈文件导出(交付面无外网/无仓库时的唯一来源) ----
# 用法:
#   docker run --rm -v /opt/picoaide:/out -e PICOAI_UNPACK_STACK=/out <image>
# 把镜像内的 compose + Caddyfile + .env.example + VERSION 落到宿主目录,
# 使「一个镜像」自包含整套部署所需文件——部署说明(AI 文档)只需引用它们。
UNPACK="${PICOAI_UNPACK_STACK:-}"
if [ -n "$UNPACK" ]; then
  if [ ! -d /opt/picoaide/deploy ]; then
    echo "错误: 镜像内缺少 /opt/picoaide/deploy" >&2; exit 1
  fi
  mkdir -p "$UNPACK" 2>/dev/null || true
  # 先清掉**上一次导出**的生成物:cp -a 是合并语义,不清就会把旧版本一起留下——
  # 2026-09-10 升级实测:client/ 里同时存在两个版本的 dmg/exe/AppImage 与已下架的
  # deb(服务端会把它们当普通文件对外提供,虽然不在清单里)。
  # 只清本产品导出的**固定名字**,绝不碰用户数据与证书:
  #   .env / picoaide-data / pg-data / caddy-data / caddy-config / certs
  rm -rf "$UNPACK/client" 2>/dev/null || true
  rm -f "$UNPACK/VERSION" "$UNPACK/docker-compose.yml" "$UNPACK/.env.example" 2>/dev/null || true
  rm -f "$UNPACK"/Caddyfile.* 2>/dev/null || true
  cp -a /opt/picoaide/deploy/. "$UNPACK"/ 2>/dev/null || true
  cp -a /opt/picoaide/VERSION "$UNPACK"/VERSION 2>/dev/null || true
  # 客户端资产(镜像内已含,服务端直接对外提供;这里只是给离线部署顺手导出)
  if [ -d /opt/picoaide/client ]; then
    mkdir -p "$UNPACK/client" 2>/dev/null || true
    cp -a /opt/picoaide/client/. "$UNPACK"/client/ 2>/dev/null || true
  fi
  # 导出目录可能由 root 拥有(宿主挂载),显式放开读权限便于后续 compose 读取
  chmod -R a+rX "$UNPACK" 2>/dev/null || true
  echo "已导出部署栈 → $UNPACK"
  ls -1 "$UNPACK" 2>/dev/null | sed 's/^/  /'
  exit 0
fi

if [ "$(id -u)" = "0" ]; then
  exec su-exec picoaide /app/picoaide-server "$@"
fi
exec /app/picoaide-server "$@"
