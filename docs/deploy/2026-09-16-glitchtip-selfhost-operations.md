# GlitchTip 自托管运维手册：DSN 域名（`GLITCHTIP_DOMAIN`）与自检

- 日期：2026-09-16 ｜ 适用对象：`https://glitchtip.example.com/`（自托管 GlitchTip **6.2.6**，org `picoaide`，project `picoaide-web`）
- 关联：决策 D9（[决策记录](../decisions/2026-09-16-glitchtip-error-collection.md)）· 验收标准 AC11 / AC15
- **本文档是给人类运维的操作手册。** 仓库里的任何自动化（含 AI 代理、CI、脚本）**都不得执行本文的生产写操作**；
  代理对生产主机与 GlitchTip 实例只允许**只读**勘察（`SELECT` / `docker logs` / `docker inspect` / HTTP GET）。
- 只读辅助脚本：`scripts/glitchtip-ops-check.mjs`（只读；`--base-url` 必填，输出当前 DSN、是否 loopback、容器 env、期望 DSN）。

> **一段话结论**：GlitchTip 收到的错误事件本身是好的（收包链路健康），但后台**展示**给运维的 DSN
> 是 `http://…@localhost:8000/1`，而 issue 永久链接也是 `http://localhost:8000/...`。
> 根因是 `glitchtip-web-1` 容器**没有设置 `GLITCHTIP_DOMAIN`**（只有 `MAIN_URL`）。
> 谁照抄后台「客户端密钥」页的 DSN 去配置客户端，谁就会配出一个**永远不可能工作**的上报地址。

---

## 1. `GLITCHTIP_DOMAIN` 与 `MAIN_URL` 的区别（先搞清这两个变量）

> **修订（2026-09-16 复核后，修复轮 1）**：本节此前写"`GLITCHTIP_DOMAIN` 与 `MAIN_URL`
> 职责不同、必须两个都配"。**这是错的** —— 现场只读实测（`grep -rn MAIN_URL /code --include=*.py`）
> 在部署版 6.2.6 的容器里**零命中**：`MAIN_URL` 在 GlitchTip 6.2.x 里是**零效果变量**。
> 真实生效的是下面这一条链（`/code/glitchtip/settings.py` 逐字）：
>
> ```python
> # Used in email and DSN generation. Set to full domain such as https://glitchtip.example.com
> default_url = env.str("APP_URL", env.str("GLITCHTIP_DOMAIN", "http://localhost:8000"))
> GLITCHTIP_URL = env.url("GLITCHTIP_URL", default_url)
> ```
>
> 即：`GLITCHTIP_URL`（或旧名 `APP_URL` / `GLITCHTIP_DOMAIN`）**同时**决定
> 邮件与绝对链接**和** DSN/permalink 的主机。**只需配这一个**。

| 变量 | GlitchTip 6.2.x 实际行为 |
| --- | --- |
| **`GLITCHTIP_DOMAIN`**（读取顺序里的旧名，等价于 `APP_URL`） | **决定对外站点 URL**：邮件/绝对链接**以及**「客户端密钥」页展示的 DSN 主机与 issue permalink。**本项目只需要配它** |
| `APP_URL` / `GLITCHTIP_URL` | 同一链条上的**现名**（优先级更高）。若部署里已经设了它们，配 `GLITCHTIP_DOMAIN` **不会**生效 —— 请改设 `GLITCHTIP_URL` |
| **`MAIN_URL`** | **在本版本里没有任何代码读取（零效果）**。历史文档说它管邮件，实测 6.2.6 不成立 |

**最容易踩的坑**：只配了 `MAIN_URL`（一个没人读的变量）时，后台页面看着一切正常、
邮件里的链接也可能因为反代而看起来对，**但 DSN 与 permalink 会退化成
`http://localhost:8000/...`**。

**判定现场到底该改哪个**：进容器 `docker exec glitchtip-web-1 env | grep -E 'APP_URL|GLITCHTIP_URL|GLITCHTIP_DOMAIN|MAIN_URL'`：
只看到 `MAIN_URL` ⇒ 补 `GLITCHTIP_DOMAIN`（本文 §4）；已经看到 `APP_URL` 或 `GLITCHTIP_URL`
⇒ 用 `GLITCHTIP_URL` 覆盖成正确域名（现名优先，旧名改了不起作用）。

### 1.1 现场实际观测到的缺陷（2026-09-16 只读复核）

`glitchtip-web-1` 容器的环境变量（`docker inspect` 实测，节选）：

```
MAIN_URL=https://glitchtip.example.com      ← 有
GLITCHTIP_DOMAIN=...                      ← ★ 没有这一项
ALLOWED_HOSTS=glitchtip.example.com,127.0.0.1,localhost
GLITCHTIP_EMBED_WORKER=true
```

后果一：后台 API 返回的 DSN 主机是 `localhost:8000`（管理员 cookie 只读 GET 实测）：

```
GET https://glitchtip.example.com/api/0/projects/picoaide/picoaide-web/keys/
→ "dsn": { "public": "http://<glitchtip-public-key>@localhost:8000/1", ... }
```

后果二：每条 issue 的 permalink 也是 `http://localhost:8000/...` —— 运维点开后台里的链接会被带到本机。

```
issue 详情 → "permalink": "http://localhost:8000/picoaide-web/issues/14"
```

> 这两个都是**展示层缺陷**：已经入库的事件没有丢，收包链路（`POST /api/1/store/`）本身是好的。
> 但只要有一个人照着后台的 DSN 去配置客户端，就会配出一个必然失败的地址 —— 这是**持续误导源**，必须修。

---

## 2. 为什么 `localhost:8000` 的 DSN **永远不可能**工作

DSN 不是拿来"给服务器自己用"的，它是**下发给终端用户桌面客户端**的上报地址。

```
DSN = http://<public-key>@localhost:8000/1
                  ▲
                  └── 每台员工电脑都把它解析成「我自己这台机器」

员工电脑 A ──── POST http://localhost:8000/api/1/store/ ──▶ ✗ 连自己的 8000 端口 → connection refused
员工电脑 B ──── POST http://localhost:8000/api/1/store/ ──▶ ✗ 同上
员工电脑 C ──── POST http://localhost:8000/api/1/store/ ──▶ ✗ 同上
                                    （GlitchTip 服务器上一条都不收到）
```

- `localhost` 在**每台客户端**上都指向**客户端自己**，不是 GlitchTip 服务器；
- 员工电脑上通常没有任何进程监听 8000 端口 ⇒ 每次上报都是 `ECONNREFUSED`；
- 客户端 SDK 是**失败即丢**语义：错误事件被静默丢弃，**界面上不会有任何提示**；
- 因此这条 DSN 的表现是「后台永远空空如也」，而**现象和"本来就没有错误"完全一样**（见 §6）。

> 实测（2026-09-16，客户端探针）：用该 DSN 初始化，上层显示 `initSentry returned`（毫无察觉），
> 底层报 `Error: connect ECONNREFUSED 127.0.0.1:8000`，GlitchTip 零新增 issue。

---

## 3. 正确的生产 DSN 全文

**必须**在 webadmin 里填这一串（主机是 `glitchtip.example.com`，不是 `localhost`）：

```
https://<glitchtip-public-key>@glitchtip.example.com/1
```

拆解说明（便于核对，不要凭记忆手打）：

| 片段 | 值 | 说明 |
| --- | --- | --- |
| 协议 | `https://` | 公网域名必须走 TLS；`http://` 仅在内网自建无证书时才是合法选择 |
| public key | `<glitchtip-public-key>` | 项目 `picoaide-web` 的公开 key（非机密，可对外展示） |
| 主机 | `glitchtip.example.com` | **`GLITCHTIP_DOMAIN` 修好之后**后台会自己显示出这个主机 |
| 项目 id | `/1` | `picoaide-web` 的 project id |

> **重要**：`GLITCHTIP_DOMAIN` 修正**不会**改变 public key 与 project id —— 只会把主机从
> `localhost:8000` 变成 `glitchtip.example.com`。所以修复动作是「先修容器 → 再从后台抄一次 DSN →
> 更新 webadmin」，而**不是**在 GlitchTip 里重新生成 key。
>
> 生产地址只允许出现在 `docs/`（本手册）。**不得**写进 `packages/**` 或 `server/**` 源码 ——
> 源码中的上报地址一律由服务端下发。

---

## 4. 现场修法（**人工执行**，4 步）

> 前置：能 ssh 到生产主机、有 `docker` 权限、有 GlitchTip 管理员后台与 webadmin 的管理员权限。
> 全程**不要** `docker compose down -v`（会删数据卷）；只重启 `web` 一个服务。
>
> **⚠️ 本节不含任何真实凭据（红线：公开仓不得出现生产密钥）。** 下面的 compose 片段里
> `DATABASE_URL` 的口令与 `SECRET_KEY` 是**占位符**；执行时请从生产主机自己的
> `/data/glitchtip/compose.yml` 里读取原值（`sed -n '1,20p' /data/glitchtip/compose.yml`），
> 只**新增** `GLITCHTIP_DOMAIN` 一行，**不要**照抄本文的值覆盖生产配置。

### 第 1 步：备份 compose 文件（30 秒，先做）

GlitchTip 部署目录 = `/data/glitchtip`，编排文件 = `/data/glitchtip/compose.yml`（现场 `docker inspect`
的 `com.docker.compose.project.config_files` 标签实测值；目录下**没有** `.env`，取值都写在 compose 里）。

```bash
cd /data/glitchtip
cp -a compose.yml "compose.yml.bak-$(date +%Y%m%d-%H%M%S)"
ls -la
```

### 第 2 步：在 `web` 服务的 `environment:` 下补 `GLITCHTIP_DOMAIN`

编辑 `/data/glitchtip/compose.yml`，在 `services.web.environment` 里加一行。取值 = 对外访问
域名（**必须带协议**）。下面只列出**与本次修改相关**的键，其余键（数据库口令、`SECRET_KEY`
等）保持生产现值不动：

```yaml
    environment:
      # …（生产现值，勿改）…
      GLITCHTIP_DOMAIN: https://glitchtip.example.com      # ← ★ 新增这一行
```

> 若现场已经设了 **`APP_URL`** 或 **`GLITCHTIP_URL`**，请改**它们**（现名优先级更高，
> `GLITCHTIP_DOMAIN` 会被忽略，见 §1）；只设了 `MAIN_URL`（零效果变量）的部署才补
> `GLITCHTIP_DOMAIN`。`MAIN_URL` 留着不动即可 —— 它不参与任何计算。

- 取值**必须带协议**（`https://glitchtip.example.com`），不要只写域名；
- 只加在 `web` 服务上（`db` / `valkey` 不需要）；
- 不要顺手改动 `ports` / `ALLOWED_HOSTS` / `GLITCHTIP_EMBED_WORKER`。

### 第 3 步：重启 `web` 服务并核对环境变量

```bash
cd /data/glitchtip
docker compose up -d web          # 只重建/重启 web 一个服务；端口与数据卷不变

# 核对变量确实进容器了（应看到 GLITCHTIP_DOMAIN=https://glitchtip.example.com；
# 若现场用的是 APP_URL/GLITCHTIP_URL，把下面 grep 的模式换成它们）
docker inspect glitchtip-web-1 --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -E 'GLITCHTIP_DOMAIN|GLITCHTIP_URL|APP_URL'

# 看启动是否健康（无报错、worker 起来了）
docker compose ps
docker logs --tail 60 glitchtip-web-1
```

> 为什么必须重启：`GLITCHTIP_DOMAIN` / `APP_URL` / `GLITCHTIP_URL` 都是**进程启动时**
> 读取的环境变量（`settings.py` 里的 `env.str/env.url`），运行中改 compose 不生效。

### 第 4 步：核对后台 DSN，并更新 webadmin 里的 DSN

```bash
# 用管理员会话（或直接在浏览器里打开 project 的「客户端密钥 / Client Keys」页）
curl -s -b <你的管理员 cookie jar> \
  'https://glitchtip.example.com/api/0/projects/picoaide/picoaide-web/keys/'
```

期望看到（AC15）：

```
"dsn": { "public": "https://<glitchtip-public-key>@glitchtip.example.com/1", ... }
```

同时任取一条 issue，其 `permalink` 也应是 `https://glitchtip.example.com/picoaide-web/issues/...`。

然后登录 **webadmin → 错误监控**，把「错误上报 DSN」更新为 §3 的完整字符串并保存：

- 保存时**不要**使用 `localhost` / `127.0.0.1` / `::1` / `169.254.169.254` / `0.0.0.0` ——
  客户端侧的准入校验会直接拒绝（这是本轮新加的防线，见决策 D2）；
- 指向私网地址（`10.` / `172.16-31.` / `192.168.`）或 `http://` 时只会有**黄色告警**，
  内网自建场景合法，确认员工电脑能访问该地址即可保存；
- 保存成功后，新配置经 `GET /api/client/v2/config/bootstrap` 在客户端**下次登录/启动**时生效。

**回滚**：把第 1 步的备份复制回 `compose.yml` → `docker compose up -d web`；
webadmin 里把 DSN 改回旧值。**注意**：回滚 `GLITCHTIP_DOMAIN` 会让后台 DSN 重新退化成
`localhost:8000`，所以回滚只在确认修复引入新问题（例如反向代理或 `ALLOWED_HOSTS` 不匹配导致 400）时才做。

---

## 5. 管理员自检清单（修完之后怎么确认真的好了）

按顺序做，**每一步证明的东西不同**，不要跳过第 2 步就宣布"好了"。

| # | 动作 | 证明了什么 | **不能**证明什么 |
| --- | --- | --- | --- |
| 1 | webadmin →「发送测试事件」 | **服务端**能连上上报端点并成功写入一条测试 issue，返回 `event_id` / HTTP 状态 | 员工桌面能否连通——**这一条是服务端视角** |
| 2 | 看 webadmin 的「客户端上报状态」卡片 | 真实客户端**自己**报告的状态：已启用 N / 失败 M / 配置不可用 K，以及**最近一次上报时间** | 不能替代第 1 步：卡片空也可能是服务端侧坏了 |
| 3 | （可选）打开心跳开关 `web.error_reporting_heartbeat` | 正向的**端到端**信号：链路活着时后台**必定**有痕迹 | —— |
| 4 | 若第 2 步为空、第 1 步成功 | 定位到**客户端侧**：员工电脑出口/DNS/代理/证书，或客户端上报开关未开 | —— |

**第 1 步务必这样理解**：「发送测试事件」是**服务端代发**（决策 D3），它从服务器进程出发去
POST 上报端点。所以：

> ✅ 成功 = **服务器**能到达上报端点（DNS、TLS、HTTP 全通，配置本身可用）。
> ❌ 它**不能**证明某台员工电脑能到达 —— 员工电脑可能有不同的出口防火墙、内网 DNS 或代理。

因此 UI 与返回体都会标注「**服务端视角**」；**客户端视角的正面证据只能来自第 2 步的状态上报或第 3 步的心跳**。

**第 3 步（心跳开关）细节** —— `web.error_reporting_heartbeat`（默认 **off**）：

- 打开后，**每个客户端在每次启动时发一条 `info` 等级的「链路心跳」事件**，带固定 tag
  `picoaide.heartbeat`；
- 这条心跳**故意豁免** `error_reporting_level` 阈值：因为默认等级是 `error`，若不豁免，
  `info` 心跳会被客户端的 `beforeSend` 过滤掉，链路健康时后台照样一片空白（这正是缺陷藏了 20 天的机制，见 §6）；
- 它**纯粹用于证明链路活着**，不是错误、不计入错误问题列表的语义；
- **默认关闭**，因为它是可选的端到端探针：开启后每个客户端每次启动都会新增一条 issue。

**第 2 步（客户端上报状态卡片）怎么读**：

| 卡片显示 | 含义 | 下一步 |
| --- | --- | --- |
| 已启用 N（最近上报时间很新） | N 台客户端**成功**初始化了上报，链路在客户端侧是通的 | 若仍无错误 issue，多半是「本来就没有 error 级错误」 |
| 失败 M（附最近原因） | 客户端 init 失败或 bootstrap 拿不到配置 | 看原因字段（DNS / 连接 / 证书 / 配置为空） |
| 配置不可用 K | 客户端拿到了配置但**上报开关未开或 DSN 为空** | 回 webadmin 检查 `web.error_reporting_enabled` 与 DSN |
| 卡片全空 | 没有任何客户端上报过状态 | 客户端可能是旧版本；或客户端根本连不上服务端 |

---

## 6. 为什么后台看起来空了 20 天（三个原因叠加）

用户看到的现象是「收集不到内容，最新一条还是 20 天前（搭建当天）」。复盘后不是单一原因，
而是**三件事同时成立**，互相掩盖：

**(a) 只采集了主进程，界面里的真实错误一条都没被采集。**
客户端只初始化了主进程（`@sentry/node`：未捕获异常与未处理 Promise 拒绝）；
**渲染进程**（界面里的 React 渲染异常、IPC 失败、前端未捕获 JS 错误）**从未接入采集**。
员工日常遇到的报错绝大多数发生在界面上，所以它们**结构上就不会进 GlitchTip**。
（渲染进程最小可用采集已列入本轮修复范围，见决策 D8 / AC14。）

**(b) `error_reporting_level=error` 把唯一的自检心跳过滤掉了 ⇒ 健康与坏掉长得一模一样。**
客户端初始化成功后会发一条 `info` 等级的自检消息；但默认等级是 `error`，
`beforeSend` 的等级阈值把它丢掉了。实测复现：`level=error` 下 `captureMessage(info)` **查无此 issue**，
`captureMessage(error)` 正常到达。
⇒ 结论：**"链路完全健康"与"链路彻底坏掉"在后台都是空白**，运维没有任何正向信号可用于区分。
这就是"没人发现"的直接机制。

**(c) 一个永远不可能工作的 DSN 被接受并存进了配置，且保存时没有任何校验。**
后台「客户端密钥」页展示的是 `http://…@localhost:8000/1`（缺 `GLITCHTIP_DOMAIN`），
而 webadmin 当时只校验"是不是以 `http(s)://` 开头"，于是这个**必然失败**的 DSN 被正常保存并提示"已保存"。
客户端拿到它以后每次都 `ECONNREFUSED`，且**失败是静默的**（界面无提示、日志是无人查看的 `console.warn`）。

三者叠加的结果：**没有可采的（a）+ 有也看不出来（b）+ 配错了也能存进去（c）**，
于是后台空了 20 天而无人察觉（搭建当天那几条全是人工联调探针，不是真实客户端错误）。

---

## 7. 边界与红线（给自动化 / 代理读者）

1. **本手册是给人执行的 runbook。** 仓库里的脚本、CI、AI 代理**不得**执行 §4 的任何写操作
   （改 compose、重启容器、改 webadmin 配置），也**不得**对 GlitchTip 发出写请求。
2. 代理对生产只允许**只读**：`docker logs` / `docker inspect` / `psql SELECT` / HTTP **GET**。
3. 只读核查可以这样跑（不产生任何变更）：

   ```bash
   # --base-url 必填（脚本不含任何生产地址默认值；无参数运行会打印用法并 exit 2）
   node scripts/glitchtip-ops-check.mjs \
     --base-url https://<你的 GlitchTip 域名> --ssh <user@生产主机> \
     --cookies <管理员 cookie jar>   # 只读：打印当前 DSN、是否 loopback、容器 env、期望 DSN
   node scripts/glitchtip-ops-check.mjs --help     # 全部参数
   ```

   只给 `--base-url` 时脚本**只核查 API 侧**并明确标注容器 env 未核查（不冒充完整核查）；
   给了 `--ssh` 却连不上则按契约以 **exit 2** 退出（"核查无法完成"，不是"一切正常"）。
   jar 文件里域列不匹配目标主机的 cookie 不会被发送（避免把别的站点会话带给被核查主机）。

   脚本的 `--apply` 模式**只打印**建议命令（不代执行），且必须额外给 `--yes` 才肯继续。

4. 生产 DSN 字面量**只允许出现在本手册**（`docs/`）。源码 `packages/**`、`server/**` 中
   一律不得出现真实 GlitchTip 域名或 public key —— 客户端的上报地址永远由服务端下发。

---

## 8. 相关文档

- 决策记录（D1–D9 / AC1–AC15）：[docs/decisions/2026-09-16-glitchtip-error-collection.md](../decisions/2026-09-16-glitchtip-error-collection.md)
- 设计蓝图：[docs/planning/2026-09-16-glitchtip-error-collection-design.md](../planning/2026-09-16-glitchtip-error-collection-design.md)
- 实施计划：[docs/planning/2026-09-16-glitchtip-error-collection-implementation.md](../planning/2026-09-16-glitchtip-error-collection-implementation.md)
- 服务端部署与升级总则：[docs/deploy/AI-DEPLOY.md](AI-DEPLOY.md)
- 只读核查脚本：`scripts/glitchtip-ops-check.mjs`
