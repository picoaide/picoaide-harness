# 客户端/服务端单包分发方案（2026-09-10 拍板版）

> 状态：**方向已全部拍板**，待实施。目标读者：产品/工程/交付。
> 拍板结论：
> 1. 客户服务器可出网（可访问 R2/OSS）→ `upgrade.sh` 主路径 = 自动拉取，离线包作兜底；
> 2. 客户端升级源 = **客户自部署服务端**（不指向我方托管）；
> 3. **客户端随服务端镜像一起分发**，交付形态 = 一个镜像 + 一份部署说明；
> 4. agent 部署先做「人工贴一行命令」，客户端内置远程部署 / webadmin 点按钮留待后续；
> 5. 强制 `client.version == server.version`（CI 断言），配套关系靠版本号结构保证；
> 6. 客户端资产以**文件形式随镜像分发 + `http.ServeFile` 直读**，不改 `go:embed`（§3.2 有实测依据）。

---

## 0. 先说清楚「镜像里直接包含客户端」的两个隐藏代价

这个方向是对的，但和直觉不同的是两件事：

### 0.1 客户端包**不能**在容器内构建

| 平台 | 安装包 | Linux 容器内可构建？ |
|---|---|---|
| linux | AppImage 150MB / deb 115MB | ✅ 可以 |
| win | NSIS `-Setup.exe` | ⚠️ 需 wine，脆弱 |
| mac | universal DMG | ❌ 不可能（electron-builder mac 目标只能在 macOS 上产出） |

→ 客户端资产必须由 **CI 三平台 job 先产出**，再通过 artifact 喂进镜像构建。镜像构建从「独立 workflow」变成「依赖三平台构建的四阶段依赖链」。

### 0.2 体积的账要算对（实测）

| 组合 | tar 体积 | 说明 |
|---|---|---|
| 现在（纯服务端） | **15 MB** | 见 §1 实测 |
| 只带 linux | ~165 MB | AppImage 150MB + 基础 15MB |
| 只带 win / mac | ~200–250 MB | 估计值（NSIS/DMG 与 AppImage 同量级） |
| **三平台全带（推荐默认）** | **~500 MB** | 一个镜像覆盖所有客户端 |

**要澄清的误判**：安装包本身已是压缩产物（zip/xz），再套 zip 收益极小；也不需要把镜像切碎（切碎只增加失败面，分片的唯一理由是断点续传）。**对隔离网客户，这不是 15MB 而是 0.5GB 的 U 盘拷贝 —— 这是真实成本，必须让客户知道并可选更小的形态。**

→ 结论：**默认发 `-all`（500MB，最省心），同时提供按平台裁剪的镜像**：

```bash
ghcr.io/picoaide/picoaide-harness-server:v2.7.0        # = -all，三平台客户端
ghcr.io/picoaide/picoaide-harness-server:v2.7.0-win    # ~200MB，只有 Windows 安装包
ghcr.io/picoaide/picoaide-harness-server:v2.7.0-linux  # ~165MB
```

企业客户通常混合平台（Linux 服务端 + Windows/Mac 员工），所以 `-all` 才是主推；裁剪镜像给「明确单一平台」或弱网客户。

---

## 1. 实测事实（全部本机验证）

| 事实 | 实测值 | 影响 |
|---|---|---|
| 服务端镜像 `docker save` tar | **15 MB**（v2.5.16；v2.4.0=23MB） | 基础镜像极小，加减客户端是唯一变量 |
| 同 tar 过 gzip -6 / zip-19 | 14.1 MB / 15 MB | 压缩算法在此量级无意义 |
| linux AppImage / deb | **150 MB / 115 MB** | 客户端才是体积主体 |
| `/app` 内容 | `picoaide-server` + `entrypoint.sh` | 镜像结构极简，加目录零成本 |
| 服务端 `CGO_ENABLED=0` 静态二进制 | 42 MB（构建产物） | 可退化为「分发二进制」，但见 §4 判断 |
| compose 依赖 | caddy:2-alpine + postgres:18-alpine + server | 离线交付需一并覆盖 |
| 客户端版本协商 | **完全不存在**（grep 核实：服务端不校验客户端版本，客户端不感知服务端版本） | 错配当前只能靠流程纪律 |

---

## 2. 目标架构（2026-09-10 修订：R2 只放镜像，客户端不碰 R2）

```
 ① 服务端更新链路 —— R2 的唯一职责
 ┌──────────────┐   检查最新版本   ┌────────────────┐   拉 tar / pull  ┌──────────┐
 │  R2          │ ←────────────── │  客户服务器     │ ───────────────→ │ 升级完成  │
 │ update.      │  latest.json    │ updatecheck.go │                  │ 新镜像跑  │
 │ picoaide.com │                 │ webadmin 提示   │                  │ 起来      │
 │ 只有镜像 tar │  ─────────────→ └────────────────┘                  └──────────┘
 └──────────────┘   下发 image.tar

 ② 客户端更新链路 —— R2 完全不参与
 ┌────────────────┐  检查更新 + 下载  ┌──────────────┐
 │  客户服务器     │ ←─────────────── │ 员工客户端    │
 │ /api/client/v2 │                  │ 升级源 =     │
 │  /updates/*    │                  │ 它登录的服务器│
 └────────────────┘                  └──────────────┘
   客户端包来自服务端镜像（entrypoint 已落到 /data/releases/<v>/client/）
```

构建侧（发布产物）：

```
  客户端三平台 job（win/mac/linux 各自跑原生 builder）
        ↓ artifacts
  bundle job：把客户端资产塞进镜像 → 一个自包含单包
    image = 服务端二进制
          + /opt/picoaide/client/<平台>/安装包
          + CLIENT-RELEASE.json（资产名 + sha256）
        ↓
  docker save | zip  →  R2（latest.json + image.tar）
                      →  GHCR（在线 pull 路径）
```

**核心性质**：客户端包**物理上存在于服务端镜像里**，客户端包与镜像版本不可能分离。客户端只跟自己的服务端说话 → 员工机器零公网依赖；服务端不升级，客户端就一直是配套旧版；升级了服务端，客户端包自动换新。

R2 上只放镜像的理由：客户端包已经在镜像里，再放一份等于同一份包两个来源，还会制造"客户端绕过服务端"的路径，破坏版本配套。官方渠道客户端继续走 GitHub Release（现有链路不动），企业渠道客户端走客户自己的服务器。


---

## 3. 镜像改造（具体到文件）

### 3.1 Dockerfile 被 COPY 的目录（构建上下文外的开关）

**不要动 `context: server`**（server/ 下没有前导 `../` 权限，容器内也解析不到）——用 `build-contexts` 再挂一个命名上下文：

```yaml
# docker.yml build-push-action
context: server
build-contexts: |
  root=.
  clientassets=./client-assets          # bundle job 从 artifacts 恢复出的目录
```

```dockerfile
# --- Stage 3 追加 ---
COPY --from=clientassets /client /opt/picoaide/client
COPY --from=clientassets /CLIENT-RELEASE.json /opt/picoaide/client/CLIENT-RELEASE.json
```

### 3.2 客户端资产**运行时写盘，不改 embed**

> **实测（2026-09-10，本机真实构建）**：把一个 150MB AppImage `go:embed` 进一个空壳 Go 程序，二进制从 ~1.8MB 变成 **151.8MB**（embed 数据落在 `.noptrdata`，不压缩，与 webadmin 同机制）。三平台全带约 **450MB 二进制**。
>
> 机制上 embed 完全成立 —— 仓库既有先例就是 webadmin（`COPY --from=webadmin /build/dist` → `webadmin/embed.go` → `go:embed`）。**差异只在量级：webadmin dist = 2.4MB / 55 文件**（随二进制走零成本），客户端安装包 = 150MB/平台。450MB 二进制会连带把所有下游放大 10 倍：每次升级重写 450MB、`docker save` tar 仍是 450MB（embed 数据已无压缩余地）、CI artifact 与镜像层膨胀、企业侧杀软/EDR 扫描负担。
>
> 而且卷写盘这条路本来就要走：服务端运行期需要从**持久卷**读（overlayfs 上 `os.ReadFile` 大文件行为不保证），落卷是既定动作；文件已经在镜像里，`http.ServeFile` 直接指过去即可 —— **比 embed 少一层 `fs.Sub`/`embed.FS` 包装，代码更少。**

用卷写盘：

```sh
# entrypoint.sh 追加（首次启动把镜像内资产落到持久卷）
if [ ! -d /data/releases/$(cat /opt/picoaide/VERSION)/client ]; then
  mkdir -p /data/releases/$(cat /opt/picoaide/VERSION)/client
  cp -a /opt/picoaide/client/. /data/releases/$(cat /opt/picoaide/VERSION)/client/
fi
```

- 二进制体积不变（42MB）；
- 客户端资产在持久卷上，升级后仍可查历史版本；
- 服务端从 `PICOAI_CLIENT_RELEASE_DIR` 读目录，**明确不通过镜像层读**（overlayfs 上 `os.ReadFile` 大文件行为不保证）。

### 3.3 服务端新增两个端点

| 端点 | 行为 |
|---|---|
| `GET /api/client/v2/updates/manifest` | 服务自身生成：`server.version`（编译期 `main.version` 注入）+ 客户端版本 + 各平台资产名/size/sha256。`Cache-Control: no-store`。走 `internal/router` 集中声明（仓库硬规则） |
| `GET /updates/client/<asset>` | 静态资产下发。用 `http.ServeFile`（**自动支持 Range/断点续传**，别自己 `c.File()`）。文件名含版本 → `Cache-Control: immutable, max-age=31536000`。**直接从卷上读，不改 go:embed**（理由见 §3.2 实测） |

服务端**不需要**知道 R2/OSS 的存在：资产就在它自己身上。

### 3.4 客户端改源

| 位置 | 现状 | 改为 |
|---|---|---|
| `packages/host/desktop/src/desktop-release.ts` | `DESKTOP_RELEASE_REPOSITORY` + `api.github.com/.../releases/latest` | 由渠道配置 + 运行时 serverURL 派生 base |
| `update-checker.ts` | `checkForStableUpdate` 走 GitHub API | 新增 `manifest` 模式；官方 `github` 模式保留（向后兼容） |
| `update-download.ts` | 资产名模板硬编码 + `SHA256SUMS.txt` | 读 manifest 的 `file` + `sha256`（校验语义不变） |
| `updates.ts:150` | 调用点固定 | 按 `updates.mode` 分派 `manifest`/`github`/`none` |

`bootstrap` 与 `auth/me` 回包增加 `server_version`；客户端启动比对，落后则在 AccountCard/UpdateSection 出「需升级」横幅 + 一键升级。

**base 按渠道配置分派**（客户端代码里不需要知道 R2 存在）：

| 渠道 | 客户端升级源 base | 说明 |
|---|---|---|
| 企业渠道 | **它登录的那台服务器**（默认） | 员工机器零公网依赖；企业内网天然可达 |
| 官方渠道 | `https://release.picoaide.com/official` | 官方客户端没有"自己的服务器"，走 R2 静态面 |

R2 的 `latest.json` 与服务端的 `/api/client/v2/updates/manifest` **用同一份 schema**，所以客户端只需一套解析逻辑，按 `updates.mode` + base 分派即可。

**一个容易漏的坑**：`api.github.com` 匿名限流 60 次/**小时/IP** —— 企业 200 台机器共用一个出口 IP 必然被限流。`manifest` 模式不是优化，是**必要条件**。

---

## 4. 「让 agent 直接部署」可行，但**不能给自由发挥的空间**

方向完全对，AI 项目这是加分项。但必须意识到：agent 拿到 SSH 后如果自己拼命令，`docker compose down -v` 这种脑补（**直接删库**）是大概率事件，而我们整套部署的价值就在「数据不丢」。

正确形态：

- **确定性脚本**：`upgrade.sh` 幂等 + 可回滚 + `--dry-run`（打印将要执行的每一步和影响）+ `--json`（结构化结果，给 agent 判定用）。agent 的职责 = 读说明 → 收集配置 → 调脚本 → 核验证据，**不写裸 docker 命令**。
- **两份文档，不是一份**：
  - `DEPLOY.md` 给人看：前置条件、配置项、升级、回滚、排障；
  - `AGENT-DEPLOY.md` 给 agent 看：结构化步骤 + **判定标准**（什么输出算成功）+ **显式禁止清单**（不许 `down -v` / 不许 `volume prune` / 不许在 healthz 未过的情况下删旧镜像）。
- 成功判定必须是**机器可判定的证据**：加载后 `docker run --entrypoint /app/picoaide-server <img> --version` 输出等于 manifest 的 `server.version` + `/healthz` 返回 200。别让 agent 靠「看起来成功了」下结论。
  > 注意别用镜像 digest 做校验：`image_tar_sha256` 是 **tar 文件的哈希**，与 registry 的 manifest digest 语义不同，混用会永远校验失败。`--version` 输出才是跨平台可靠的权威锚点。

（这条与仓库既有哲学一致：`install-server.sh` 就是 oh-my-zsh 式一条命令安装器，本方案只是把「一键」从安装扩展到升级。）

**远程 agent 的现实约束**：企业生产服务器通常不给 agent 开 SSH。落地方式有三种，成本差很多：
① 客户运维把一行命令贴到服务器（**零建设成本，先做这个**）；
② 给我们自己的客户端加「远程部署」能力（agent 经授权通道执行 `upgrade.sh`）；
③ 纯 webadmin 点按钮部署（工期最长）。
建议 ① 起步，② 作为产品卖点另立规划。

---

## 5. 渠道定制：不新增抽象

沿用既有 `docs/planning/2026-09-04-enterprise-channel-branding.md` 的 `channels/<channel-id>/channel.json`：

| 关注点 | 落点 |
|---|---|
| 运行时品牌 | 已存在（服务端 `/api/client/v2/brand` + 客户端 `brand-sync`），零构建 |
| 编译期品牌（名称/图标/appId/默认服务器地址） | 打包时注入 |
| 升级源 | `updates.mode=manifest`（本方案硬前提），默认指向客户自部署服务端 |
| 交付面 | `release.base_url`，R2（海外/我方托管）或 OSS/COS（国内） |
| 镜像 tag | `<image>:v<version>-<channel_id>`，客户机器上 `docker images` 一眼看出渠道 |
| 归因 | `channel_id` 贯穿产物名 / 镜像 tag / manifest / 遥测 |

官方渠道保持双轨：官方 tag 走 GitHub Release + GHCR 不变，企业渠道走单包 + 客户服务端；共用同一套 bundle 产出脚本，差异只在配置段。

---

## 6. 实施分期

| 阶段 | 内容 | 产出 | 周期 |
|---|---|---|---|
| **P0 打包收敛** | CI 新增 bundle job：三平台 artifacts → 带客户端资产的镜像（`-all`）→ 产出 `docker save` tar + `latest.json` 上传 R2，同时推 GHCR | 一个自包含单包 | 2–3 天 |
| **P1 服务端自建源** | Dockerfile 加 client 目录；entrypoint 落卷；`/api/client/v2/updates/manifest` + `/updates/client/*`（`http.ServeFile`）；bootstrap 加 `server_version` | 服务端成为客户端分发点 | 2–3 天 |
| **P1.5 服务端检查更新接 R2** | `updatecheck.go` 支持 R2 响应格式（按 `schema`/`tag_name` 分流）+ `PICOAI_UPDATE_ENDPOINT` env + Result 增加 `image_tag`/`image_url`；webadmin ServerInfo 提示条补升级命令 | 运维在 webadmin 看到「有新版本」；**能力已存在，只换端点** | 1–2 天 |
| **P2 一键升级** | `upgrade.sh`（`--dry-run`/`--json`/断点续传/校验/`docker pull` 与 `docker load` 双路径/备份/健康检查/自动回滚）+ `DEPLOY.md` + `AGENT-DEPLOY.md` | 客户（或 agent）一条命令 | 3–5 天 |
| **P3 客户端改源** | `update-checker`/`update-download` 泛化 manifest 模式（官方渠道 base=R2，企业渠道 base=自己服务器）；版本不匹配横幅 | 客户端跟着服务端升 | 3–5 天 |
| **P4 渠道化** | 接既有渠道管线（镜像 tag / `PICOAI_UPDATE_ENDPOINT` / 产物名参数化） | 多渠道并存 | 视商务 |

P0–P2 ≈ 1.5 周闭环（客户能自己升），P3 才让客户端自动跟随。P1.5 是最便宜的一环（现有机制只换端点），建议与 P1 并行。

**R2 侧接入已有独立手册**：`docs/planning/2026-09-10-r2-update-server-runbook.md`（桶布局、缓存策略、上传命令、验证脚本）。

---

## 7. 坑清单

1. **客户端包不能在容器内构建**（mac 只能原生）→ CI 依赖链必须重排，别指望单 job 搞定。
2. **别把客户端 `go:embed` 进二进制**（实测：150MB 资产 → 151.8MB 二进制；三平台 ≈450MB）。机制与 webadmin 相同、先例成立，但 webadmin dist 只有 2.4MB —— 量级差 60 倍时下游代价（升级重写体积、tar 无压缩余量、artifact/层膨胀、企业杀软扫描）全部放大 10 倍。走卷 + `http.ServeFile` 反而代码更少。
3. **`docker save` 的 tar 是未压缩的**（15MB 是因为内容本身小，不是压缩）：带客户端后 tar ≈ 500MB，`zip` 能压到 ~480MB，收益有限但别不做。
4. **`latest` tag 不可复现**（`install-server.sh` 自己就警告过）：升级与配套都必须钉死 `vX.Y.Z`。
5. **新增路由必须走 `internal/router` 集中声明**（仓库硬规则），别在各业务包私建前缀。
6. **断点续传靠 `http.ServeFile` 的 Range 支持**，别自己实现。
7. **回滚 ≠ 降级数据库**：PG 迁移不可逆（如 0059），`upgrade.sh` 必须打印本次新增迁移，且明确「有新增迁移则不可回滚」。
8. **旧镜像别自动 prune**：它是回滚锚点；`upgrade.sh` 保留 N-1 并只打印清理命令。
9. **离线客户还需要 caddy + postgres 镜像**：单包只解决了 server 一个，`install-server.sh` 会 `docker pull` 另外两个 → 纯离线交付必须额外带这两个（或提供 `--offline` 模式跳过拉取）。
10. **签名主体**：企业渠道不自签则 macOS Gatekeeper 拒绝未公证包；共享厂商证书是目前唯一低成本路径（既有规划待拍板项）。
11. **同号即配套的前提**：`client.version == server.version` 必须由 CI 强制断言（`scripts/version.mjs check` 同源），否则「镜像里的客户端」和「镜像的版本」会漂移。
12. **R2 上不要放客户端包**：客户端包在镜像里；放 R2 会造成同一份包两个来源，并制造"客户端绕过服务端"的路径，破坏版本配套（详见 R2 手册 §0）。
13. **`image_tar_sha256` ≠ 镜像 digest**：前者是 tar 文件哈希（下载完整性），后者是 registry manifest digest，混用会永远校验失败；加载后的权威校验用 `--version` 输出。
14. **服务端升级是"换镜像"不是"改文件"**：`/app/picoaide-server` 在镜像层里运行时不可写，所以 `upgrade.sh` 必须同时支持 `docker pull`（在线）和 `docker load`（R2 tar，GHCR 不可达时）。

---

## 8. 拍板记录与遗留项

**已拍板**：
| # | 决策 | 落实点 |
|---|---|---|
| 1 | 客户服务器可出网 | `upgrade.sh` 主路径 = 自动从 R2/OSS/GHCR 拉；离线包兜底 |
| 2 | 客户端升级源 = 客户自部署服务端 | `updates.mode=manifest`，base = 登录的 serverURL |
| 3 | 客户端随服务端镜像分发 | Dockerfile 加 client 目录；`/updates/client/*` + manifest 端点 |
| 4 | agent 部署先做「人工贴一行命令」 | `upgrade.sh` + `DEPLOY.md` + `AGENT-DEPLOY.md`（本地确定性脚本优先） |
| 5 | 强制 `client.version == server.version` | CI 用 `scripts/version.mjs check` 同源断言，防「镜像里的客户端」与「镜像版本」漂移 |
| 6 | 客户端资产走文件 + `http.ServeFile`，不 embed | §3.2 实测：150MB 资产 → 151.8MB 二进制，三平台 ≈450MB |
| 7 | **镜像带全部三平台客户端（含 linux 的 deb + AppImage）** | 所有客户端只有一个来源，产品逻辑最干净；代价 +265MB |
| 8 | **默认只发 `-all` tag**（~500MB） | 客户不用选也不会选错；弱网/单平台客户可另选裁剪 tag（按需再加） |

**遗留项（不影响 P0–P2 开工）**：
1. 企业自签 vs 厂商统一签名（既有渠道规划 §9.2 待拍板项）。
2. 远程部署的后续形态（客户端内置远程部署 / webadmin 点按钮）另立规划。
3. 裁剪 tag（`-linux`/`-win` 等）在确有弱网客户时再加，不预先建设。
4. 渠道化（P4）启动时确认：各渠道是否共用同一 `-all` 镜像 + 独立 `channel.json`。
