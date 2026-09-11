#!/usr/bin/env bash
#
# 公开日志里的**品牌串脱敏**(被 ci-channel-transfer.sh 与 ci-publish-update-server.sh source)。
#
# 为什么需要(2026-09-11 v2.7.0 正式 tag 的真实泄漏,下例已按本库规则脱敏):
#   upload failed: client-assets/***/<slug>-2.7.0-x64-Setup.exe to s3://…/ch-3/…
# aws CLI 的失败信息**自身**就会回显源/目标对象键 —— `--only-show-errors` 只压掉
# 成功时的逐对象回显,失败时照样把文件名打出来。而当时的掩码只登记了渠道 id:
# 目录段 `client-assets/<id>/` 被抹成 `***`,文件名用的是渠道包里的 `desktop.slug`
# —— 客户品牌就这样进了公开 Actions 日志(公开仓,任何登录账号可读)。
# 本文件自身也不写真实客户名:注释里同样用 `<slug>` 占位。
#
# 两道防线,缺一不可:
#   1. `::add-mask::` —— 把渠道包里所有品牌串(id / slug / slug 小写 / 显示名 /
#      产品名)与**本渠道产物文件名**都登记成 GitHub 掩码。它只作用于日志,是兜底:
#      任何工具(aws / electron-builder / 未来的新脚本)意外回显时会被自动抹掉;
#   2. 经本库的输出捕获与替换 —— 自己调用的外部命令,输出先捕获、把已登记的品牌串
#      替换成 `***` 再打印。"只靠掩码"不够:掩码依赖调用点记得登记,而漏登记过一次
#      就是一次泄漏。
#
# 用法:
#   . "$(dirname "$0")/ci-brand-mask.sh"
#   brand_mask_init
#   brand_register_channel "$id" "$stage_dir"      # id + 渠道包品牌串 + 产物文件名
#   brand_run_checked aws s3 cp … || { echo "::error::…"; exit 1; }
#
# 约定:所有可能回显路径/文件名的外部命令都走 `brand_run_checked`,不要裸调。

# 已登记的品牌串(每行一条);由 brand_mask_init 创建。
BRAND_MASK_FILE=""

# 建临时文件并挂退出清理。幂等:重复调用不重新建文件(避免丢已登记的模式)。
brand_mask_init() {
  if [ -z "$BRAND_MASK_FILE" ]; then
    BRAND_MASK_FILE="$(mktemp)"
    # shellcheck disable=SC2064  # 展开时机:这里就要当前的路径
    trap 'rm -f "$BRAND_MASK_FILE"' EXIT
  fi
}

# 登记一个品牌串:进 GitHub 掩码 + 进本地脱敏表。
# 太短的串(1–2 字符)会被跳过 —— 它们会把无关文本也抹掉,反而降低日志可用性。
brand_mask_string() {
  [ -n "${1:-}" ] || return 0
  [ "${#1}" -ge 3 ] || return 0
  printf '::add-mask::%s\n' "$1"
  printf '%s\n' "$1" >> "$BRAND_MASK_FILE"
}

# 登记一个渠道的全部品牌串。
# @param $1 渠道 id
# @param $2 该渠道的产物目录(可选;存在时把目录里的文件名也登记 —— 安装包名由
#           slug 派生,任何一个失败信息把它原样带出去都是同一类泄漏)
# 渠道包目录固定为 `channels/<id>/channel.json`(ci-channels.sh 检出的位置)。
brand_register_channel() {
  brand_mask_init
  # 注意:`local a=… b="…/$a"` 里 `$a` **不会**看到同一行刚赋的值 —— local 是内建
  # 命令,所有实参先展开再赋值,`set -u` 下直接 "unbound variable"(踩过)。
  local id="$1"
  local stage="${2:-}"
  local cfg="channels/$id/channel.json"
  brand_mask_string "$id"
  if [ -f "$cfg" ]; then
    # 用 node 解析(两个调用脚本都已依赖 node;不引 jq,渠道包允许任意缩进/键序)。
    while IFS= read -r value; do brand_mask_string "$value"; done < <(CHANNEL_CFG="$cfg" node -e '
      const fs = require("node:fs")
      let cfg = {}
      try { cfg = JSON.parse(fs.readFileSync(process.env.CHANNEL_CFG, "utf8")) } catch { process.exit(0) }
      const slug = cfg?.desktop?.slug
      const values = [
        slug,
        typeof slug === "string" ? slug.toLowerCase() : undefined,
        cfg?.identity?.display_name,
        cfg?.desktop?.product_name,
        cfg?.identity?.short_name,
      ]
      for (const value of values) {
        if (typeof value === "string" && value.trim() !== "") process.stdout.write(`${value.trim()}\n`)
      }
    ')
  fi
  if [ -n "$stage" ] && [ -d "$stage/$id" ]; then
    local file
    for file in "$stage/$id"/*; do
      [ -e "$file" ] || continue
      brand_mask_string "$(basename "$file")"
    done
  fi
}

# stdin → stdout:把已登记的品牌串替换成 `***`。
brand_sanitize() {
  BRAND_MASK_FILE="$BRAND_MASK_FILE" node -e '
    const fs = require("node:fs")
    const patterns = fs.readFileSync(process.env.BRAND_MASK_FILE, "utf8").split("\n").filter(line => line !== "")
    let text = fs.readFileSync(0, "utf8")
    for (const pattern of patterns) text = text.split(pattern).join("***")
    process.stdout.write(text)
  '
}

# 运行一条可能回显路径的外部命令:成功时静默(丢弃输出),失败时把输出**脱敏**后
# 打到 stderr 并返回其退出码(调用方据此决定 fail-loud 的措辞)。
brand_run_checked() {
  local output status
  set +e
  output="$("$@" 2>&1)"
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    printf '%s\n' "$output" | brand_sanitize >&2
  fi
  return "$status"
}

# 同 brand_run_checked,但失败也不返回非 0(用于尽力而为的收尾动作),
# 输出同样脱敏 —— "反正失败了"不是把品牌写进日志的理由。
brand_run_best_effort() {
  brand_run_checked "$@" || true
}
