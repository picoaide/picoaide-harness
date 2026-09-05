# 测试版 / 正式版两级发布流程（Prerelease Test Channel）

- 日期：2026-09-05
- 状态：定案（master，commit cb4b23f056 之后）
- 范围：桌面客户端 GitHub Releases 发布链（ci.yml）、server Docker 镜像 tag 策略（docker.yml）、版本工具（scripts/version.mjs）

## 背景与目标

历史发布只有「tag push → 三平台构建 → 正式 GitHub Release」一条路：一旦发布，正式客户端
（update-checker/update-download 读 `releases/latest`）立即向全部用户推送更新。用户担心：

1. 想先给测试环境/自己发一个版本随便试，但一发布用户就收到更新；
2. 正式版发布后发现问题想撤回很麻烦（已更新的用户无法远程降级，只能出 hotfix）。

目标：新增「测试版」发布通道——**测试版随时可发、正式用户永远收不到更新提示；测试通过后
再发正式版，正式版才进入用户更新源**。

## 机制原理（零客户端改动）

隔离不是靠客户端逻辑，而是 GitHub Releases 的既有语义：

- 客户端 `update-checker` / `update-download` 只请求
  `GET /repos/picoaide/picoaide-harness/releases/latest`；
- GitHub 该端点**只返回最新且非 draft、非 prerelease** 的 release——所以只要测试版以
  Pre-release 发布，`releases/latest` 不会包含它，正式用户端检查永远返回 up-to-date；
- 双保险：`update-checker` 解析响应时要求严格 stable SemVer（`parseCanonicalStableVersion`
  拒绝任何带 prerelease 段的版本），即便端点行为变化也不会误判。

因此**客户端代码无需任何改动**，改动全部在发布侧：CI 识别测试 tag 并标记 `--prerelease`。

## 客户端更新通道（版本自路由，v2.7.0 起）

为了让装测试版的机器也能收到新测试版（而不用每次手动下载），客户端按**已安装版本**
自动选择更新通道（`updates.ts` → `checkForChannelUpdate`）：

- 已安装版本是稳定版（无 prerelease 段，绝大多数用户）→ **稳定通道**：
  只查 `releases/latest`，永远不会见到 Pre-release —— 正式用户收不到测试版更新；
- 已安装版本带 prerelease 段（如 `2.7.0-rc.1`，测试装机）→ **测试通道**：
  查发布列表 `releases?per_page=30`，取 **SemVer 最大的已发布版本**——同一行内有更新的
  rc（rc.2 > rc.1）先提示；正式版发布（`2.7.0` > `2.7.0-rc.N`）后提示正式版，测试机
  平滑回到正式通道语义；
- 下载侧同规则：稳定版从 `releases/latest` 找资产；测试版从
  `releases/tags/v2.7.0-rc.1` 找该 release 的资产（`update-download.ts` 的
  `releaseMetadataEndpoint`）。资产与 SHA256SUMS 校验逻辑不变；
- 提示历史（`lastPromptedVersion`）接受任一规范 SemVer（含 rc），跨重启只提示一次。

无「推送」概念——一切仍是客户端定期（默认 6h）或手动「拉取」检查。

## 版本号与 tag 规范

- 正式版：纯 SemVer，如 `2.7.0` → tag `v2.7.0`（现有流程不变）。
- 测试版：SemVer prerelease 段，如 `2.7.0-rc.1`、`2.7.0-rc.2`… → tag `v2.7.0-rc.1`。
  同一正式版本可任意多次迭代（rc.1 → rc.2 → …）；正式版 = 去掉 prerelease 段。
- `scripts/version.mjs` 的 `validateVersion` / docker.yml 白名单本就接受 `-后缀`，
  资产名 `PicoAide-Harness-2.7.0-rc.1-mac.dmg` 等自动对齐 tag，无特殊处理。

## 操作流程

### 发布测试版（可随时、任意多次）

```bash
node scripts/version.mjs set 2.7.0-rc.1      # 同步写两处 package.json
git commit -am "chore: bump version to v2.7.0-rc.1"
git tag v2.7.0-rc.1
git push origin master --tags                 # CI 自动构建三平台 + 发布
```

CI 行为（ci.yml）：

- 三平台资产照常构建；mac 资产**照常签名 + 公证**（测试版必须走真实签名链，否则测不到
  Gatekeeper 安装体验）；
- Release job 检测 tag 含 prerelease 段 → `gh release create --prerelease`，GitHub
  Releases 页显示 Pre-release 徽标；
- **正式客户端不会收到该版本的任何更新提示**。

测试者（含自己）获取测试版：GitHub Releases 页 → Pre-release 区块 → 手动下载对应平台资产
安装。正式用户看不到 Pre-release 下载入口（页面主体只展示最新正式版）。

### 发布正式版（测试通过后）

```bash
node scripts/version.mjs set 2.7.0
git commit -am "chore: bump version to v2.7.0"
git tag v2.7.0
git push origin master --tags
```

CI 行为与以前一致：普通 release → `releases/latest` 立即指向它 → 用户收到更新。

## Server Docker 镜像策略（docker.yml）

- 正式 tag：`latest` + `v2.7.0` + `v2.7`（宽 tag，现行为）；
- **测试 tag（含 prerelease 段）：只推 `v2.7.0-rc.1` 具体 tag，不打 `latest` / `v2.7`**——
  测试镜像不得污染生产拉取面（compose 显式引具体版本不受影响）。

## 撤回语义（顺带澄清）

- 正式版已发布、已更新的用户**无法远程降级**：客户端只比较版本高低，没有降级通道；
  线上问题只能发 hotfix 版本覆盖。
- 正式版发布后立即发现问题想「撤回」：删除/隐藏该 release 后，`releases/latest` 回落，
  **尚未更新的用户不再收到该版本的提示**（已更新的不受影响）——因此测试版流程就是
  降低「发布即全员更新」风险的主要手段，正式发布前务必先走 rc 验证。

## 限制与注意事项

1. 每次测试版 tag 仍触发完整三平台构建 + mac 签名公证（约 1～3 小时，含公证队列），
   不是秒级发布；
2. 安装测试版的机器走测试通道自动跟随新 rc（默认每 6h 检查一次，也可手动「检查更新」），
   正式版发布后会自动提示并平滑回到正式版——但**正式用户永远不会收到测试版**；
3. rc 版本进入 git 历史（master 上多一条 bump 提交），正式版 bump 会再产生一条，属预期；
4. 若某正式版本号已被发布过（tag 已存在），不可复用同一 tag 发测试版——测试版号必须
   高于已发布版本（SemVer 语义）。
