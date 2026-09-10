# R2 → release.picoaide.com 更新服务器接入手册

> 2026-09-10 修订（**架构纠正版**）。上游方案：`docs/planning/2026-09-10-client-server-bundled-release.md`。
> 目标：把已创建的 R2 存储桶变成 `https://release.picoaide.com` —— **服务端镜像的更新分发面**。

---

## 0. 架构：三条链路，R2 是服务端升级源 + 官方客户端分发面

**核心事实**：客户端包已经在服务端镜像里（见上游方案 §3）—— 所以**企业渠道**的客户端分发
完全不需要 R2；**官方渠道**客户端没有"自己的服务器"可问，它的分发面就是 R2 的官方目录。

```
 ① 服务端更新链路（R2 的职责）
 ┌──────────────┐   检查更新    ┌────────────────┐   拉镜像   ┌──────────┐
 │     R2       │ ←─────────── │  客户服务器     │ ────────→ │ 客户服务器│
 │ latest.json  │              │ updatecheck    │  tar或     │ 升级完成  │
 │ image.tar│              │ webadmin 提示   │  docker pull└──────────┘
 └──────────────┘              └────────────────┘

 ② 企业渠道客户端链路（R2 不参与）
 ┌────────────────┐  检查+下载   ┌──────────────┐
 │  客户服务器     │ ←────────── │ 员工客户端    │
 │ /api/client/v2 │             │ 升级源=       │
 │  /updates/*    │             │ 它登录的服务器 │
 └────────────────┘             └──────────────┘
        客户端包来自服务端镜像（entrypoint 已落到 /data/releases/<v>/client/）

 ③ 官方渠道（R2 上唯一的"额外"内容：官方镜像压缩包）
 ┌──────────────┐
 │ official/    │  与 acme/ 等渠道目录**结构完全相同、只有镜像 tar**
 │ releases/<v>/│  官方版客户端安装包随镜像走（镜像里就带着），不单独放 R2
 └──────────────┘
```

**为什么这样才对**：

- **企业客户端的版本配对是结构性的**：客户不升级服务端，客户端就一直是旧版；升级了服务端，客户端包自动跟着换新。不存在"客户端升了服务端没升"；
- **企业侧员工机器零公网依赖**，跨境链路压力为零；
- **R2 上一个渠道一个目录、内容完全同构（只有镜像 tar）**，"官方"只是渠道 id 为 `official` 的普通目录 —— 新增渠道零结构差异。

**客户端安装包不进 R2**（2026-09-10 澄清）：客户端包在服务端镜像里，由**客户自己的服务器**下发；
官方渠道的客户端同样从官方镜像里取，不额外放一份到 R2（放了就是同一份包两个来源）。

---

## 0.1 与 GitHub Release 的分工（2026-09-10 定案）

GitHub Release **仍然发布**，但内容物变了，两者定位不同：

| | R2 `release.picoaide.com` | GitHub Release |
|---|---|---|
| 发布物 | **镜像 tar 压缩包**（所有渠道一致）+ `latest.json` | **镜像 tar 压缩包**（同一个文件，长期存档） |
| 版本范围 | **只留最近 3 个版本**（§3） | **全部历史版本永久保留** |
| 变更说明 | 不承载 | 发布说明（`docs/releases/<tag>.md`） |
| 谁读它 | 机器：服务端 `updatecheck`、客户端升级、部署下载 | 人：审计、查变更、取旧版本镜像 |
| 为什么需要 | 升级与回滚要快、要稳定 | R2 只留 3 版 → 更老的镜像只能从这里取；同时保留人类可读的版本历史 |

**这两条不能互相替代**：R2 是"热"分发面（有保留窗口），GitHub Release 是"冷"存档 + 变更记录。
删掉 GitHub Release 会导致老版本镜像永久失传、版本历史无处可查。

---

## 1. 服务端"检查更新"的能力**已经存在**，只需换端点

这是本方案最省力的一点 —— 不用新建任何东西：

| 现有组件 | 位置 | 现状 | 改动 |
|---|---|---|---|
| 检查器 | `server/internal/updatecheck/updatecheck.go` | 硬编码 `api.github.com/repos/picoaide/picoaide-harness/releases/latest`，解析 `tag_name` | 支持 R2 响应格式；端点可由 env 覆盖 |
| 缓存 | `updatecheck.CachedChecker` | 6 小时 TTL + singleflight，失败静默降级 | 不动 |
| API | `server/internal/serverauth/sysinfo.go` | `sysinfo.Version` 里带 `update_check`（`current/latest/update_available/release_url/checked_at`） | 结果增加 `image_tag` / `image_url` |
| 界面 | `server/webadmin/src/pages/ServerInfo.tsx:110` | **已有**「发现新版本 {latest}（当前 v{version}）」提示条 | 文案补一条升级命令 |

**这意味着**：运维打开 webadmin 系统信息页就能看到"有新版本"，不需要任何新代码路径。我们只是把"版本从哪来"从 GitHub 换成 R2。

配置方式（新增一个 env，官方/渠道各自指向自己的目录）：

```bash
PICOAI_UPDATE_ENDPOINT=https://release.picoaide.com/official/latest.json
# 不设置时保持现状（GitHub API），向后兼容
```

**响应格式判定**：R2 返回的对象有 `schema` 字段，GitHub 返回的有 `tag_name`。按字段存在性分流即可，两种格式**共存于同一个 Checker**，不需要两套代码。

---

## 2. 渠道隔离：三种渠道类型，互不升级

**这是正确性要求，不是配置问题。** 渠道混用的后果是最严重的一类：品牌客户端接受官方清单
→ 升级后被"洗"成官方客户端、品牌与渠道配置一起丢失；官方客户端接受品牌清单 → 装到别人的定制版。

| 渠道类型 | 渠道 id | 谁用 | 更新面目录 |
|---|---|---|---|
| **预发** | `beta` | 我们自己内测 | `release.picoaide.com/beta/` |
| **官方** | `official` | 正式发布 | `release.picoaide.com/official/` |
| **品牌** | `<brand-id>` | 企业定制交付 | `release.picoaide.com/<brand-id>/` |

渠道 id 形状统一为 `^[a-z0-9][a-z0-9-]{0,31}$`，三处实现同源：

| 位置 | 实现 |
|---|---|
| 客户端 | `CHANNEL_ID_PATTERN` + `channelBaseURL()`（`desktop-release.ts`） |
| 服务端 | `IsChannelID()` + `ResolveChannel()`（`internal/updatecheck`） |
| CI | `Resolve release channel` 步骤的 grep 校验 |

### 隔离靠什么保证（三处强制校验，缺一不可）

1. **清单必须声明 `channel_id`**，且**必填**：缺失即拒绝。缺字段不能当作"默认官方"——那正好是
   品牌场景下最危险的静默降级。
2. **客户端**：`parseReleaseManifest(value, expectedChannel)` 要求两者精确相等；不相等一律当作
   "检查失败"（不提示更新），**绝不提示跨渠道升级**。`expectedChannel` 来自安装渠道
   （`DSH_CHANNEL` → 适配器 `channel`，缺省官方）。
3. **服务端**：`updatecheck` 同样校验清单渠道 == 本部署渠道。不一致时报
   `ErrUnavailable`（**不是**"无更新"）——这通常意味着 `PICOAI_UPDATE_ENDPOINT`
   指到了别的渠道目录，必须让人看见并修，不能静默跨渠道升级。

### 三处配置必须自洽（最容易配错）

```
PICOAI_CHANNEL=acme                                   # 本部署属于哪个渠道
PICOAI_UPDATE_ENDPOINT=https://release.picoaide.com/acme/latest.json   # 从哪个目录取
清单里的 "channel_id": "acme"                          # 目录里的内容声明自己是哪个渠道
```

三者不一致会被校验拦下（fail-loud）。为降低配错概率，`PICOAI_UPDATE_ENDPOINT` 留空时
`ResolveChannel()` 会**从端点路径首段推导渠道**；`PICOAI_CHANNEL` 也留空时则由端点推导，
两者都不给才回落官方渠道。

### 客户端渠道的来源：**不是客户端清单，而是它登录的服务端**

企业部署里，客户端的包与版本都由服务端下发（见 §8），所以"渠道"天然由**服务端**决定 ——
服务端属于哪个渠道，它的员工客户端就属于哪个渠道。客户端不需要内置品牌渠道信息，
也就不存在"客户端渠道与服务端渠道不一致"这种状态。

官方渠道是唯一的例外：官方客户端没有"自己的服务器"，它的渠道由构建期 `DSH_CHANNEL` 决定
（官方构建为 `official`）。

### 尚未支持：品牌渠道发布（故意 fail-loud）

CI 目前**只支持 `beta` 与 `official`**：渠道由 tag 形态推导（含 `-` 且为
`beta`/`rc`/`alpha` 段 → `beta`，纯 `vX.Y.Z` → `official`）。任何其他形态的 tag 会
**直接失败并提示原因**，而不是静默按官方发布。

品牌渠道发布依赖尚未实施的渠道配置包与渠道化打包管线
（`docs/planning/2026-09-04-enterprise-channel-branding.md`：品牌名/图标/appId/
默认服务器地址/更新源 + 按渠道矩阵化打包）。**在它落地前，品牌渠道不能发版** ——
这是有意的：静默发成官方是比"发不出去"严重得多的错误。

---

## 3. 保留策略：R2 只留最近 3 个版本

**定案（2026-09-10）**：每个渠道目录只保留**最近 3 个版本**的 `releases/<v>/`，更旧的整目录删除。
`latest.json` 始终指向最新版，不受影响。

理由：单版本镜像 tar ~500MB（**内含客户端包**），3 版 ≈ 1.5GB/渠道 —— 可接受；
不设上限的话一年下来单渠道就是上百 GB。3 个版本足够覆盖"回滚一级 / 灰度观察"的实际需要。

**旧版本下不到怎么办 —— GitHub Release 是长期存档（见 §11）**：
R2 存**热版本**（升级与回滚用，快），GitHub Release 存**全部历史版本的镜像包**（审计与旧版本
回滚用，永久）。两者内容一致，定位不同：

| 需求 | 取哪边 |
|---|---|
| 客户检查更新 / 升级 | R2 `latest.json` + `releases/<最新v>/` |
| 回滚到上一个版本 | R2（在 3 个热版本窗口内，直接下 tar） |
| 回滚到更老的版本 / 审计 | GitHub Release 附件（永久，同一个镜像 tar） |

**清理方法**（发布时执行，删"第 4 新及更早"的目录）：

```bash
CH=official
# 列出该渠道所有版本目录（按版本号倒序），保留前 3 个
KEEP=3
$aws s3 ls "s3://$R2_BUCKET/$CH/releases/" | awk '{print $2}' | sed 's#/##' \
  | sort -rV | tail -n +$((KEEP+1)) | while read -r old; do
      echo "清理旧版本: $CH/releases/$old"
      $aws s3 rm "s3://$R2_BUCKET/$CH/releases/$old/" --recursive
    done
```

**注意**：`sort -V` 必须用版本序（`-V`），不能用字典序（`2.10.0` 会排在 `2.9.0` 前面 —— 同一个
坑在 §2 讲 `latest.json` 必要性时也出现过）。清完跑一次 `temp/r2-verify.sh` 确认最新版仍完整。

**不要用 R2 生命周期规则自动删**：生命周期规则按**对象年龄**过期，会同时删掉"最新的旧对象"
（客户端包与镜像 tar 是一起传的，但规则不知道版本边界），可能把当前版本的资产删掉。版本级
保留只能用上面这种按目录的显式清理。

---

## 4. 桶布局：R2 只承载镜像 tar（官方与渠道同构）

```
r2://<bucket>/
  official/                                       # 官方渠道（渠道 id = official）
    latest.json                                   # ← 服务端检查更新的唯一入口（可覆盖）
    releases/
      2.7.0/
        picoaide-server-2.7.0-amd64.zip       # ~500MB，内含客户端包的服务端镜像
        SHA256SUMS                                # 上面这个 tar 的哈希（离线交付手工校验）
  acme/                                           # 定制渠道：与官方**结构完全相同**
    latest.json
    releases/2.7.0/picoaide-server-2.7.0-acme.zip
```

**tar 文件名带版本号** → 天然 cache key，可设 `immutable` 长缓存，永不复用同一 URL 的不同内容。

**为什么用路径前缀而不是「每渠道一个桶/子域」**：

- 一个桶、一个域名、一套证书、一套上传凭证 → 新增渠道零基础设施动作（符合主仓 `brands/<channel-id>/` 的既定结构）；
- 服务端只认一个 env（`PICOAI_UPDATE_ENDPOINT`），渠道差异就是 URL 里那一段；
- 以后整体迁到 OSS/COS 或换域名，**改一个 env / 一个常量**即可，不需要任何 redirect（正好绕开 §3.1 的禁令）；
- 私有渠道可对单个前缀加 presigned URL / Cloudflare Access，不影响其他渠道。

**为什么 `latest.json` 必须是固定 URL 的可覆盖对象**：

- 服务端要发请求，**必须先知道一个 URL** ——"固定 URL 的内容指向最新版"是唯一不需要列桶的设计；
- R2 的 ListObjects 按 key 字典序，`2.10.0` 会排在 `2.9.0` **前面**，**不能**用来判断最新版；
- 也**不要**用对象上传时间推最新版（一次发布多对象，时间几乎相同，判定不稳定）。

→ 接受"发布时必须原子地覆盖它"这个代价，用 §5 的验证挡住漏更新。

---

## 5. 三条硬约束（都来自现有代码，先看）

### 3.1 检查请求**不接受任何 3xx**

| 位置 | 现状 |
|---|---|
| `server/internal/updatecheck/updatecheck.go` | Go `http.Client` 默认跟随重定向，但失败即 `ErrUnavailable` **静默降级** |
| `packages/host/desktop/src/update-checker.ts:194` | `redirect: 'error'` |
| `packages/host/desktop/src/update-download.ts:438` | `redirect: 'error'` |

→ **禁止**用 Cloudflare Rules / Worker / Bulk Redirect 做「`latest.json` 转发到当前版本」。检查 URL 必须返回 `200` 静态内容。

失败方式很恶劣：服务端会静默降级（`update_check: null`），webadmin 什么都不显示；客户端则永远看不到更新且零报错。

**这反而是 R2 的优势**：对象存储永远返回 200，不会跳转。

### 3.2 客户端检查接口的 GitHub schema 兼容

`update-checker.ts:249` 期望 `{tag_name}`。**R2 不可能产出 GitHub schema**。

→ 必须「加新模式」而不是「换地址」，`github` 模式保留（官方渠道客户端继续读 GitHub）。企业渠道客户端读自己服务端（上一版方案已定）。

### 3.3 服务端已经跑在容器里 —— 升级是"换镜像"，不是"改文件"

`/app/picoaide-server` 在镜像层里，**运行时不可写**。所以服务端升级只有两条路，`upgrade.sh` 两条都要支持：

| 路径 | 命令 | 适用 |
|---|---|---|
| 在线 | `docker pull <image>:<tag>`（GHCR，或客户自己的 registry） | 客户服务器能出网且 GHCR 可达 |
| 离线 | `curl` 下 R2 的 tar → `zip -d \| docker load` | GHCR 不可达（国内常见），或客户用客户自建 registry |

R2 的 tar 是**离线路径的权威来源**，也是"镜像分发"的真正答案。

---

## 6. 缓存策略（不显式设置会出事）

Cloudflare 对**未知扩展名**的 200 响应有默认边缘缓存（数小时量级）。`latest.json` 被缓存住 → "明明传了新版本，服务端几小时还是报老版本" —— 又是静默故障。

| 对象 | Content-Type | Cache-Control | 理由 |
|---|---|---|---|
| `latest.json` | `application/json` | `no-cache` | 有 ETag，可缓存但每次回源校验 → 新版本立即可见；别用 `no-store`（丢掉条件请求） |
| `*.zip` | `application/zip` | `public, max-age=31536000, immutable` | 文件名含版本号，天然 cache key |
| `SHA256SUMS` | `text/plain` | 同上 | — |

叠加效应：`updatecheck.go` 自身还有 **6 小时 TTL** 缓存。所以最坏情况是"发布后最多 6 小时 webadmin 才提示"——这对运维属可接受；若想更快，把 `CacheTTL` 调小即可（`updatecheck.go` 常量）。

**不要用 `aws s3 sync` 一把梭**：它只支持统一 `--cache-control`，会把两类对象的策略弄成一样。

---

## 6.1 客户端资产要不要也传 R2？（结论：不传）

**所有渠道（含官方）都只传镜像 tar。** 客户端安装包**在镜像里**，服务端启动后由 entrypoint
落到 `/data/releases/<v>/client/`，再由服务端自己对外下发（企业渠道给员工，官方渠道同理）——
R2 上再放一份客户端包 = 同一份包两个来源，且制造"客户端绕过服务端"的路径，破坏版本配套。

**一个镜像就够**：镜像里同时有服务端与三平台客户端，所以：

- 客户从 R2 只取一个文件（镜像 tar）就能完成"服务端升级 + 拿到新客户端"；
- `latest.json` 的 `client.assets` 段对**所有渠道都可省略**（协议保留该字段是为了兼容
  将来"客户端与服务端分开分发"的可能，当前实现不填）；
- 客户端实际从服务端接口 `GET /api/client/v2/updates/manifest` 取包（见 §8）。

---

## 7. 上传（R2 S3 兼容 API）

环境（CI secrets / 本地 env，**不要写进仓库**）：

```bash
R2_ACCOUNT_ID=<cf account id>
R2_BUCKET=<你已创建的桶名>
R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
AWS_ACCESS_KEY_ID=<R2 access key id>
AWS_SECRET_ACCESS_KEY=<R2 secret>
AWS_DEFAULT_REGION=auto                          # R2 要求 auto
aws="aws --endpoint-url $R2_ENDPOINT"
```

逐类上传（`--cache-control` 与 `--content-type` 必须显式给）：

```bash
CH=official ; VER=2.7.0 ; DIR=release-bundle/

# 1) 镜像（不可变、长缓存）
$aws s3 cp "$DIR/picoaide-server-$VER-amd64.zip" \
  "s3://$R2_BUCKET/$CH/releases/$VER/picoaide-server-$VER-amd64.zip" \
  --content-type application/zip \
  --cache-control 'public, max-age=31536000, immutable'

$aws s3 cp "$DIR/SHA256SUMS" "s3://$R2_BUCKET/$CH/releases/$VER/SHA256SUMS" \
  --content-type text/plain --cache-control 'public, max-age=31536000, immutable'

# 2) 版本检查指针（放最后！且必须短缓存）
$aws s3 cp "$DIR/latest.json" "s3://$R2_BUCKET/$CH/latest.json" \
  --content-type application/json --cache-control 'no-cache'

# 3) 清理到只剩最近 3 个版本（见 §3；用版本序 sort -V，不能用字典序）
KEEP=3
$aws s3 ls "s3://$R2_BUCKET/$CH/releases/" | awk '{print $2}' | sed 's#/##' \
  | sort -rV | tail -n +$((KEEP+1)) | while read -r old; do
      echo "清理旧版本: $CH/releases/$old"
      $aws s3 rm "s3://$R2_BUCKET/$CH/releases/$old/" --recursive
    done
```

**顺序不可颠倒**：先把 `releases/<v>/` 传完，**再**清旧版本，**最后**才覆盖 `latest.json`。
反过来会让服务端先看到新版本、却下不到 tar。

> **清理必须在 `latest.json` 覆盖之前**：如果先覆盖指针再清理，中间窗口里 `latest.json` 指向新版本、
> 而新版本的资产可能还没传完。先传齐 → 清旧 → 最后指新，任何时刻指针都指向完整可用的版本。

> 500MB 的 tar 会触发 aws cli 的 multipart upload（默认阈值 8MB），这是正常路径，无需手工 `create-multipart-upload`。

---

## 8. `latest.json` schema

**这是权威定义**（服务端 `updatecheck` 与服务端下发给客户端的 manifest 共用同一份结构）：

```jsonc
{
  "schema": 1,                      // 协议版本;不匹配即拒绝(旧客户端不会误读新结构)
  "channel_id": "official",         // 渠道归因;与 URL 路径段必须一致
  "server": {
    "version": "2.7.0",             // ← 服务端 updatecheck 只读这一个字段做版本比较
    "image_tag": "v2.7.0",          // webadmin 展示的升级目标
    "image_ref": "ghcr.io/picoaide/picoaide-harness-server:v2.7.0",
    // 离线部署路径的镜像 tar（AI-DEPLOY.md §6.4 的 curl 目标）
    "image_asset": "https://release.picoaide.com/official/releases/2.7.0/picoaide-server-2.7.0-amd64.zip"
  },
  "client": {
    // 镜像内配套的客户端版本。R2 只放服务端镜像,**不承担客户端分发**;
    // 这一段只用于展示与支持排查(客户端升级走它登录的那台服务器)。
    "version": "2.7.0",
    // 协议保留该字段,但**当前所有渠道都不填**:客户端包在镜像里,
    // 由服务端接口下发(见 §6.1/§8)。仅为将来"客户端与服务端分开分发"预留。
    "assets": {
      "mac-universal": { "url": "https://release.picoaide.com/official/releases/2.7.0/PicoAide-Harness-2.7.0-mac.dmg", "sha256": "…", "size": 0 },
      "win-x64":       { "url": "…/PicoAide-Harness-2.7.0-x64-Setup.exe", "sha256": "…", "size": 0 },
      "linux-x64":     { "url": "…/PicoAide-Harness-2.7.0-x86_64.AppImage", "sha256": "…", "size": 0 }
    }
  },
  "published_at": "2026-09-10T00:00:00Z"
}
```

**实现已对齐（2026-09-10 实测）**：

- 服务端 `updatecheck` 用 `NormalizeVersion` 解析 `server.version`（接受 `2.7.0-rc.1` 这类预发布，**发布渠道由清单内容决定**），比较按核心 `M.m.p` 进行；
- 缺 `server.version` 或值非法 → 返回 `ErrUnavailable`（**不**当作"无更新"），避免把配置错误伪装成"已是最新"；
- 客户端清单解析器（`packages/host/desktop/src/desktop-release.ts`）额外强制：资产 `url` 必须是**绝对 https**、`sha256` 必须匹配 `^[0-9a-f]{64}$`，否则整体拒绝 —— 清单是安全边界，缺失哈希等于放弃完整性校验；
- **镜像 tar 的哈希不放这里**，放在 `releases/<v>/SHA256SUMS`：`latest.json` 只回答"最新版本是多少"，一个版本一个哈希文件，职责不重叠（`image_tar_sha256` 这个字段已废弃）。

**校验锚点**：`image_ref` / `image_tag` 是 registry 的 tag，**不是**镜像 digest；离线 tar 加载后的权威校验是 `docker run --entrypoint /app/picoaide-server <img> --version` 输出等于 `server.version`（见 AI-DEPLOY.md §6.6）。


---

## 9. 上传后验证（必须，别省）

指针漏更新是这套方案唯一的单点故障。脚本 `temp/r2-verify.sh`（curl + jq，**不需要上传凭证**）：

```bash
./temp/r2-verify.sh official 2.7.0                          # 快速检查
DOWNLOAD=1 ./temp/r2-verify.sh official 2.7.0               # 真下 tar 并校验 sha256（500MB，慢）
BASE_URL=https://release.picoaide.com ./temp/r2-verify.sh acme 2.7.0
```

六项断言：

1. **HTTP 200 且无重定向**（3xx = 更新通道静默死掉）；
2. `schema=1`、`channel_id` 与路径一致（防渠道串包）；
3. **`latest.json` 指向期望版本**（发布时漏覆盖的主要故障）；
4. `server.version == client.version`（同包发版约束，防版本漂移）；
5. **镜像 tar 可下载且 sha256 匹配**；
6. **缓存头正确**（`latest.json` 短缓存、tar `immutable`）。

已在本地 mock 服务端实测 4 个故障场景全部被正确抓住：正常路径、指针漏更新、资产被篡改、指针先于资产上传。

**发布门禁建议**：CI 的上传 job 跑完就调它，失败即 release 失败 —— 否则会出现"包发出去了、客户收不到更新"。

---

## 10. 客户端那条链路（与 R2 无关，但要知道出口在哪）

> ✅ **实现状态（2026-09-10 晚复核）：已上线。**
> 镜像里的客户端资产（Dockerfile `COPY --from=clientassets` → `/opt/picoaide/client/`）
> 与两条路由均已实现：`GET /api/client/v2/updates/manifest`（`internal/clientrelease`
> 的 `Manifest`）与 `GET /updates/client/<file>`（同包的 `File`，公开、自带 Range）。
> 早期"清单放错目录 → 这条链整条是死的"那个坑已修（`d9b511a230`），现在由
> `scripts/ci-build-channel-images.sh` 的 `verify_image()` 在镜像内断言
> `/opt/picoaide/client/CLIENT-RELEASE.json` 存在。

服务端升级完成后，客户端怎么拿到新包：**镜像里的客户端资产直接对外提供**（不落持久卷，镜像层本身就是版本锚点）：

```
GET /api/client/v2/updates/manifest   → { client.version, assets{ url, sha256, size } }
GET /updates/client/<asset>           → http.ServeFile（自带 Range 断点续传）
```

`url` 由服务端**按请求来源重写**（`PICOAI_PUBLIC_BASE_URL` 优先，其次
`X-Forwarded-Proto` / TLS；只接受 https 与回环 http）——镜像内清单里那串
`https://release.picoaide.com/<channel>/…` 只是占位。客户端强制 https，因此服务端
推不出安全地址时**不下发 client 段**并给出原因，而不是发一个会被客户端静默丢弃的
http 链接（那会表现为"永远显示已是最新"）。

客户端把 base 换成**它登录的服务器**（官方渠道和企业渠道一致）——所以客户端代码里不需要知道 R2 存在，也就没有"R2 挂了客户端就升不了级"的风险。

### 10.1 品牌渠道的安装包怎么进镜像（R2 私密中转）

tag 运行时三平台 job 各自产出安装包，release job 汇总后构建镜像。**品牌渠道的
安装包不经公开 GitHub artifact**（artifact 对任何登录账号可下载，而渠道目录名、
文件名与包内 `defaults.server_url` 都是客户身份）：它们由
`scripts/ci-channel-transfer.sh` 经 R2 临时前缀
`_transfer/<run-id>-<HMAC(R2 密钥, run-id)>/ch-<index>/` 中转，release job 取回后
由 `clean` 步骤立即销毁。官方/beta 照旧走 artifact（品牌本来就公开）。

由此有一条硬约束：**R2 凭据缺失 + 本次含品牌渠道 = 流水线直接失败**（中转与发布
脚本都会拦），因为 R2 是品牌渠道唯一的分发面；静默跳过等于"客户零交付而全绿"。

---

## 11. 域名与 DNS

1. R2 控制台 → 桶 → Settings → **Custom Domains** → 添加 `release.picoaide.com`；
2. 该域名须在 **Cloudflare DNS** 下（R2 自定义域要求），CF 会自动加 CNAME；
3. 等证书签发，然后 `curl -sSI https://release.picoaide.com/official/latest.json` 确认 200。

**不要用 `*.r2.dev` 开发域名做生产**：有限速、无 CDN 行为、随时可能变。

### 国内可达性（必须实测，不要推断）

`release.picoaide.com` 走 Cloudflare 网络 → 大陆访问默认路由**境外节点**。

- **压力比想象小得多**：全公司 200 台员工机器**不碰 R2**（只跟自己的服务端说话），碰 R2 的只有**客户那一台服务器**、且只在升级时。所以跨境链路只承担"一次 500MB"。
- **仍需实测**：从国内典型办公网络 `curl -o /dev/null -w '%{time_total} %{speed_download}'` 拉一次 tar，确认可接受。**这是上线前必须做的实测。**
- **ICP**：域名解析到境外节点，**不需要**备案；若日后走 CF 中国网络（需企业版 + 备案域名）或迁 OSS/COS，**只改一个 env**。
- **已明确不做**：CF 自选优选 IP 之类的"玄学加速"——违反 CF 条款，用在交付链路上会变成事故。

---

## 12. 坑清单

1. **3xx 是静默杀手**（§3.1）：R2 前面不能有任何跳转。
2. **R2 上别放客户端包**：客户端包在镜像里，放 R2 = 同一份包两个来源，且制造"客户端绕过服务端"的路径，破坏版本配套。
3. **`latest.json` 被边缘缓存**：不设 `no-cache` 会几小时不生效。
4. **上传顺序**：先镜像后指针；反过来 = 服务端看到新版本却下不到 tar。
5. **`image_tar_sha256` ≠ 镜像 digest**：前者是 tar 文件哈希，后者是 registry manifest digest，混用会永远校验失败。
6. **`aws s3 sync` 会毁掉缓存策略**：逐类 `cp`。
7. **`s3api list-objects` 不能判最新版**（字典序 + 同批上传时间相近）。
8. **旧 schema 兼容**：客户端侧换地址不改 schema = 静默断更（§3.2）。
9. **`--endpoint-url` + `AWS_DEFAULT_REGION=auto` 缺一不可**，否则 aws cli 会去连真 AWS S3。
10. **HEAD 成功 ≠ GET 成功**：multipart 未 complete 时 HEAD 可能通过，验证必须真下文件（`DOWNLOAD=1`）。
11. **`updatecheck` 自身 6 小时 TTL**：发布后 webadmin 不会立刻提示，属预期行为，别当 bug 排查。
12. **`*.r2.dev` 不做生产**。
