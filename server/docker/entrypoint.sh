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
  exec su-exec picoaide /app/picoaide-server "$@"
fi
exec /app/picoaide-server "$@"
