---
title: 快速开始
description: 10 分钟上手 PicoAide Harness：拿到客户端、首次启动、登录与四个核心入口。
---

## 先选择你的路径

| 你是 | 怎么拿到产品 |
|---|---|
| **企业员工** | 向管理员要企业访问地址，打开 `https://<企业域名>/` 下载对应平台安装包（或直接向同事拷安装包） |
| **企业管理员** | 先按[私有化部署](/deployment/)部署服务端；客户端安装包随服务端镜像发布，部署完成后由这台服务器对员工提供 |
| **想先试用** | 官方渠道的客户端安装包在**服务端镜像**里：取官方镜像包后一条命令即可导出三平台安装包（见下） |

## 客户端安装包

| 平台 | 安装包 | 说明 |
|---|---|---|
| Windows x64 | `.exe`（NSIS 安装程序） | 未签名，SmartScreen 可能提示「未知发布者」 |
| macOS（Apple 芯片 / arm64） | `.dmg` | 正式发布版已签名 + 公证 |
| Linux x64 | `.AppImage` | 授予执行权限后运行 |

客户端安装包**随服务端镜像发布**（而不是单独挂在某个下载站），所以只有两个来源：

1. **企业服务器**（推荐）：部署完成后打开 `https://<企业域名>/`，门户页直接列出三平台下载入口；
2. **官方镜像包**（试用 / 单机）：从更新服务器或
   [GitHub Release](https://github.com/picoaide/picoaide-harness/releases) 取官方镜像包，解出安装包：

```bash
VER=2.7.0        # 以 latest.json 里的 server.version 为准
# 正式渠道是 official，预发布渠道是 beta，按需替换
curl -fL -O "https://release.picoaide.com/official/releases/${VER}/picoaide-server-${VER}-amd64.zip"
curl -fL -O "https://release.picoaide.com/official/releases/${VER}/SHA256SUMS"
sha256sum -c SHA256SUMS
unzip -p picoaide-server-${VER}-amd64.zip image.tar | docker load
mkdir -p ./picoaide-stack
docker run --rm -v "$PWD/picoaide-stack:/out" -e PICOAI_UNPACK_STACK=/out \
  picoaide-harness-server:${VER}
ls -1 ./picoaide-stack/client    # 三平台安装包 + CLIENT-RELEASE.json
```

完整说明见[容器化部署](/deployment/compose/)与[离线部署](/deployment/offline/)。

## 首次启动

- 首次启动会创建默认 `desktop` profile，并在本机启动官方 DSH Web 界面；
- 安装包已经包含 Electron、Node.js、pnpm 与固定版本 DSH 依赖——**不需要**另行安装 Node.js、pnpm 或 DSH；
- 关闭窗口默认隐藏到托盘；从托盘选择**退出**才会结束应用与本地服务。

## 本地 Web 端口

Desktop 默认让系统随机分配本地 Web 端口（`dsh-desktop.port: 0`），避免与其他服务冲突；服务只监听 `127.0.0.1`。若某个界面插件依赖稳定 origin（`localStorage` 按 origin 隔离），可在设置中固定端口：

```yaml
dsh-desktop:
  port: 43189
```

端口必须是 `0` 到 `65535` 之间的整数。修改后应用会有序重启。固定端口已被占用时 Desktop 无法启动——释放端口，或把设置改回 `0` 或另一个空闲端口。

## 登录

- **企业版（服务端模式）**：填写服务端地址（企业管理员提供，如 `https://ai.example.com`）与账号密码登录（local / LDAP / OIDC，登录方式由服务端配置）；账号由管理员在管理后台创建，配额与余额由服务端决定；
- **客户端升级源就是这台服务端**：登录后客户端会定期向它检查新版本（见[客户端分发与升级](/deployment/client-delivery/)）；未连接服务端时不做任何外发更新检查；
- `internal`（内网自签）模式下首次连接需要信任本部署的 Caddy 本地 CA；
- 退出登录即解除全部会话（连接器、浏览器、定时任务令牌）。

## 开始使用：四个核心入口

1. **新会话**：选择工作区（项目目录）开始对话；模型可调用的工具按权限门控审批；
2. **能力中心**：安装市场技能/智能体（需管理员授权）、查看「我的」本地创作与上传审核状态；
3. **定时任务**：把高频工作交给 Agent 到点自动执行（cron + 提示词 + 工作区 + 权限），执行详情随时可查；
4. **连接器 / 浏览器**：OAuth 授权连接销售易、Moka 等 MCP 服务；让 Agent 接管浏览器执行操作。

## 下一步

- 想理解产品设计理念，读[产品哲学](/philosophy/)；
- 想深入每个界面，读[桌面客户端](/desktop/)；
- 企业管理员请读[管理后台](/admin/)与[私有化部署](/deployment/)。
