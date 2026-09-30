# 决策：语音输入默认开启（2026-09-29）

**状态**：已实施（分支 `chore/client-size-compression`，未提交）
**影响面**：`packages/host/desktop`（profile 装配 / 客户端补位 / 权限处理器 / macOS 打包 / 打包必需清单）
**依据**：上游 `@deepseek-ai/dsh-experimental-voice-input-bundle`（pin `0.1.7-rc.2`）；调研见 `docs/planning/2026-09-29-dsh-0.2.0-rc.2-assessment-and-voice-input.md` §6

## 1. 决策

桌面客户端**默认开启语音输入**：profile 装配上游 `voice-input-bundle`，输入框出现麦克风按钮；
录音在**本机**识别（SenseVoiceSmall + Silero VAD，`sherpa-onnx`，音频不出机器），
模型按需下载（int8 约 228MiB，落 `$DSH_HOME/speech-to-text/sensevoice`）。

同时放行麦克风：主窗口 permission request/check 两条通道**只对本窗口主框架的纯 audio 请求**放行，
macOS 追加 `NSMicrophoneUsageDescription` 与 `com.apple.security.device.audio-input`
（`entitlements` 与 `entitlementsInherit` 同一个 plist）。

## 2. 为什么上游那一行单独不够（四处缺口）

| # | 缺口 | 现象（缺了会怎样） | 本仓补法 |
|---|---|---|---|
| 1 | **没装配** | 上游把该 bundle 作为 `@deepseek-ai/dsh` 的依赖随包分发，但默认不装配 ⇒ 什么都没有 | `src/profile.ts` 的 `REQUIRED_BUNDLES` 加一行 |
| 2 | **`pluginNavigation` 没有提供者** | 语音 UI 插件 `inject = ['remote','slots','locale','pluginNavigation']`，唯一提供者是 `ui-plugin-manager`，而那行被我们禁用（占 `main`+`panellist`，与自研面板接管不互通）⇒ client fiber 永久 pending，**麦克风按钮根本不出现且无任何报错** | `src/client/voice-setup.tsx` 补一个最小实现（唯一方法 `openBundle`）；`ctx.get('pluginNavigation')` 已在场则不抢（重复 provide 会让整棵树 fail-loud） |
| 3 | **麦克风必被拒** | 权限处理器此前只放行剪贴板两个权限名；macOS 还缺 usage description/entitlement ⇒ `getUserMedia({audio})` 被拒，macOS 连系统弹窗都没有 | `src/electron-runtime.ts` 的 request/check 两条通道 + `build.mac.extendInfo`/`entitlements` |
| 4 | **没有模型准备面** | 上游的准备/进度卡片挂在 `plugins.bundle.activation|config` 槽位（同样属 ui-plugin-manager）；未准备时点麦克风弹出的对话框里「前往安装」是唯一的下载入口 | 自持对话框：`pluginNavigation.openBundle(voice bundle)` → `shell.overlay` 里的准备面（显示阶段/进度/失败原因，按钮=下载并启用/取消/重试），1s 轮询 `remote.speech.catalog()` |

### 2.1 `remote.speech` 只能经 `ctx.get()` 读（实施中踩到的坑，判据已补）

命名空间服务 `remote.speech` 由 **`remote` 服务的持有者**（api-gateway client 在 `$mount` 时）
`provide`，而 Cordis 的**属性代理只在"自己 `inject` 了 `remote`"的 fiber 里成立** ——
桌面 client 插件的 `inject` 是 `['slots','sessions','theme','locale']`（也不该为一个可选能力
加一条硬依赖），所以在它里面 `ctx.remote` 直接抛
`cannot get property "remote" without inject`。正确读法是 `ctx.get('remote.speech')`
（读全局服务表，与拓扑无关；`packages/AGENTS.md` 的"可选服务用 `ctx.get(name)`"）。

**这个坑的代价不是"读不到"，而是"读不到还看不见"**：解析抛出的异常被
`void refresh()` 吞掉，准备面只剩「语音服务尚未就绪：语音插件未装配或正在启动」且没有
任何按钮（打包版真机实测），把装配缺陷伪装成"再等等"。因此同时收两处：
`speechRemoteOf` 走 `ctx.get`；store 把"取服务本身抛错"与"服务缺席"分开 —— 前者把原因写进
`error` 显示出来。

### 2.2 文案里的两个数字不能混

上游 `setupEstimate.recommendedDiskBytes` 是**预留磁盘**建议（int8 恒 1e9 字节 = 954MiB），
实际下载是 `runtime/assets.json` 的 int8 模型（239,233,841 B = 228MiB，与上游进度条的
`totalBytes` 同口径）+ `tokens.txt` + `silero_vad.onnx`（合计 231MiB 落盘）。
打包版实测：准备面初版把前者当"首次下载"，界面显示 954MB，与实际差 4 倍；
现在准备面把两个数分开说（`voice.estimate` 的 `{download}` / `{disk}`），
`VOICE_INT8_DOWNLOAD_BYTES` 由 `tests/voice-setup.spec.ts` 对着随包 assets.json 对拍。

真机全链路（2026-09-29，打包版 + mock gateway）：点麦克风 → 前往安装 → 「下载并启用」→
`94.9 MB / 228 MB` → `228 MB / 228 MB` → **已就绪**（约 30 秒，模型落在
`$DSH_HOME/speech-to-text/sensevoice/models/`，三个文件字节数与上游清单逐字相同）。

## 3. 麦克风放行的判据（收紧面，逐条有测试）

放行需要**同时**满足（`tests/electron-runtime.spec.ts` 的「grants the microphone to the app UI main frame only」）：

1. `contents === 本窗口`（默认 session 里只有本应用窗口；比"看 URL"多一道身份判据）；
2. `details.isMainFrame === true`；
3. 来源是本安装回环源（`requestingUrl` / `securityOrigin` / `embeddingOrigin` 按通道取第一个非空）；
4. `media` 是**纯 audio**（request 通道看 `mediaTypes == ['audio']`，check 通道看 `mediaType === 'audio'`；camera 与混合一律拒）；
5. macOS：check 通道要求 `getMediaAccessStatus('microphone') === 'granted'`；request 通道先 `askForMediaAccess('microphone')`（TCC 弹窗），拒绝或抛错都按拒绝处理，且**前置闸门不过时不弹 TCC**。

内嵌浏览器与应用窗口跑在各自 partition（有自己的 guard），不受影响。

## 4. macOS 打包

`build.mac` 新增 `entitlements` / `entitlementsInherit`（都指向 `scripts/macos-entitlements.plist`）
与 `extendInfo.NSMicrophoneUsageDescription`。**显式 entitlements 会替换 electron-builder 在
hardened runtime 下的缺省集**，所以 plist 里必须同时保留 `allow-jit` /
`allow-unsigned-executable-memory` / `disable-library-validation`（判据：
`tests/package.spec.ts` 逐条断言这四个 key 存在，含 usage description 非空）。

## 5. 打包与升级的连带影响

- `package.json` 的 `dependencies` 显式声明 voice-input-bundle 与其三个同伴包（`speech-to-text-sensevoice`、`client-ui-voice-input`、`api-speech-to-text`）——它们此前来得及只是传递依赖。
- `REQUIRED_PACKAGED_RUNTIME_ENTRIES` +7 条（bundle 的 `cordis.patch.yml` 与 lib、三条宿主行入口、客户端 bundle），总条数下限 122 → 129；bundle 补丁文件缺失时**四条行一行都不会插**，属静默失效。
- **原生面**：`sherpa-onnx-node` 的平台包（`sherpa-onnx-{linux-x64,linux-arm64,darwin-arm64,win-x64}`）目前随包进 `app.asar.unpacked`（asarUnpack 的 `*.node`/`*.so*`/`*.dylib`/`*.dll` glob）。实测 Linux 包内两份（x64 32MB + arm64 39MB）都在——**这是当前体积压缩课题里最大的一笔可裁项，但裁掉就等于关掉语音**（二选一，见 §8）。
- **升级**：`@deepseek-ai/dsh` 若不再依赖该 bundle，装配行会在启动期报"bundle 解析不到"；`tests/voice-setup.spec.ts` 另有两条上游契约对拍（bundle 的四条行 id、`remote.speech` 的方法名），改名即红。

## 6. 部署面（2026-09-29 追加）：模型怎么进到客户网

模型下载走宿主 Node **直连**（客户端默认禁代理），而企业网常常"只有认证代理能出公网"
—— 那种网络里语音永远准备不好。两条**互补**的路，都只用上游的官方配置项
（`speech-to-text-sensevoice` 的 `modelDirectory` / `vadModelPath` / `modelOrigin`），
我们这边只多一条**组装期 patch**，没有释放器、没有标记文件、没有把 230MiB 往数据根再拷一份。
（2026-09-29 讨论中否掉的两条：①模型编进 Go 二进制 —— 每次构建都要拉 230MiB、二进制与每次
更新都变大、模型升级必须重发服务端；②客户端"首次运行释放到数据根" —— 多一份 230MiB 磁盘、
多一次复制与哈希、还要维护标记与自愈，而官方配置本来就能直接读客户端目录里的文件。）

### 6.1 随客户端分发（**所有渠道默认打开**；2026-09-29 用户定案）

**缺省即随包**：没有渠道包（official）与所有渠道构建都会走这一步；只有渠道显式写
`desktop.speech_bundle_model: false` 才关闭（回到"首次使用下载"，适合确实在意安装包体积的
部署）。因此**每个安装包大约 +230MiB**，换来的是"装上就能用、零网络、离线可用"。

打包前 `prepareChannelPackaging()` 用
`scripts/fetch-speech-model.mjs` 把权重拉进 `build/speech-model/`（按随包的上游清单校验
大小 + sha256，幂等），electron-builder 的 `extraResources` 把它放进**客户端自己的目录**
（`<resources>/speech-model/`，安装时就已在那里 —— 没有"首次运行释放"这一步）；客户端
**装配期**把那一行指过去：

```
modelDirectory = <客户端目录>/speech-model/sensevoice-onnx
vadModelPath   = <客户端目录>/speech-model/silero/silero_vad.onnx
```

上游语义 = "文件已存在 ⇒ 不下载"，于是语音**零网络**可用，且因为走的是显式来源，
上游连 230MiB 的启动期哈希都不做。解析在 `src/speech-model-bundle.ts`：
**载荷齐、大小对才注入**；任一不符（缺文件、截断、清单坏）就**不注入**，回落下载路径 ——
显式来源会关掉这一行

### 6.2 渠道级三个可选字段（本机没随包载荷时的出口）

`channels/<id>/channel.json` 的 `desktop` 段另有三个字段（注入点 = `channelProfilePatches`）：

| 字段 | 作用 | 取值 |
|---|---|---|
| `desktop.speech_model_dir` | 预置的模型目录（**零下载**） | 绝对路径，或 `{default,darwin,linux,win32}` 平台映射（一份 channel.json 服务三平台） |
| `desktop.speech_vad_path` | 预置的 Silero VAD 文件 | 同上 |
| `desktop.speech_model_origin` | 内网镜像源（HuggingFace 兼容，路径与文件名不变） | `https?://host[:port]`（形状与上游 Config schema 逐字一致） |

三个都未配置 = 现状（公网直连下载），官方构建逐字节不变。几条必须记住的语义：

- **`config` 是整键替换**：注入时必须重述上游 bundle 自己给的 `dataRoot`
  （`<DSH_HOME>/speech-to-text/sensevoice` 的字面量）。漏了它那一行会因为 `dataRoot`
  必填而加载失败 —— 表现是语音整个消失。`tests/channel-speech-patch.spec.ts` 的
  "上游 config 键超集"判据把这条钉住（上游给该行新增必填键时当场红）。
- **与随包载荷的关系**：两者都碰这一行，顺序上随包载荷在渠道 patch **之后**（"本机装的东西"
  比网络配置更确定）；渠道要覆盖它就别开 `speech_bundle_model`。
- **预置路径不做哈希校验**：上游此时只查可访问性（`access`），版本匹配由部署方负责；
  配错的表现是准备阶段明确报 `Speech model verification failed`，不会静默降级。
- **只配 `speech_model_dir` 时 VAD 仍会下载**（1.8MB）：要完全零下载得两个都配。
- **配了 `modelOrigin` 就不再回落公网源**（上游语义：显式源 = 显式意图）。
- 形状不符（相对路径、非法的平台键、带路径的镜像源）时**不注入**并回落下载 ——
  可选字段写错不该让语音整个不可用；但**构建期**在 `scripts/ci-channels.sh` 里
  fail-loud（只报字段名、不回显取值），免得配错一路发到客户机器上。

## 7. 判据与验证

| 判据 | 抓什么 |
|---|---|
| `tests/voice-setup.spec.ts`（17 例） | 上游 bundle 行 id/提供者 id/Remote 方法名契约；**下载量 vs 预留磁盘量两个数**（对着随包 `runtime/assets.json` 对拍，上游换模型即红）；store 轮询/准备/取消/失败分级（`error` 与 `actionError` 分开）/Remote 缺席降级/解析抛错必须可见；`pluginNavigation` 只对语音 bundle 开面；**真 Cordis 拓扑**一组用真框架搭"provider / mount / 消费者三棵兄弟 fiber"，把 `speechRemoteOf` 改回属性读法即红（实测：`cannot get property "remote" without inject`） |
| `tests/electron-runtime.spec.ts`（+1 例，含 darwin 分支） | 麦克风五道闸 + TCC 三个分支 + "前置不过不弹 TCC" |
| `tests/profile.spec.ts` / `tests/package.spec.ts` / `tests/verify-packaged-runtime.spec.ts` | bundle 进 profile 必需清单；mac entitlements + usage description；voice 链七条在打包必需清单里且有磁盘证据 |
| `tests/channel-speech-patch.spec.ts`（8 例） | 渠道模型部署面（§6.2）的注入：行不存在时不注入；上游 config 键**超集**对拍（读随包 `cordis.patch.yml`）；**真组合器**跑一遍"bundle 插行 + 渠道覆盖"（漏掉 `dataRoot` 重述即红，变异已验证）；平台映射取值；相对路径/带路径镜像源一律不注入；渠道 config 不含厂商名 |
| `tests/channel-prepare.spec.ts`（+3 例） | 载荷就位：**缺省所有渠道都材料化**（含 official）；只有显式 `false` 才清掉残留（客户端只看载荷在不在，残留会被 extraResources 打进产物）。真实现要联网拉 230MiB ⇒ 用例经 `ChannelPrepareOptions.speechModel` 注入替身 |
| `tests/speech-model-bundle.spec.ts`（7 例） | 随包模型（§6.1）的路径解析：齐且大小对 ⇒ 注入绝对路径；缺文件/截断/清单坏 ⇒ **不注入**（显式来源会关掉下载，指过去而文件不在就是硬故障）；生产只认 `process.resourcesPath`（开发运行读源树会让"本机碰巧拉过载荷"改变装配结果）；渠道那条路互不干扰 |
| `scripts/verify-packaged-runtime.ts` 的 `assertBundledSpeechModelPackaged`（+4 例） | **源树声明 → 产物必须齐**：`extraResources` 的源目录缺失时 electron-builder 只打 warning，所以"开了随包模型但 CI 忘了拉取/路径写错/构造机被清"会得到空手安装包而门禁全绿 —— 这里按大小逐条判红。期望的来源树是**显式实参**（自建树的单测传 `null`，否则开发机上的载荷会让整套单测变红；注意缺省参数在显式传 `undefined` 时仍生效） |
| `scripts/ci-channels.sh` 的 `speech_bundle_model` 形状检查（4 个正反例实跑） | 只认严格布尔：字符串 `"true"` / `1` 在客户端按"没配"处理，构建期就点名该字段（只报字段名，不回显取值） |
| `scripts/e2e-client.mjs` 两条新断言 | 插件图里有 voice 客户端 bundle（**装配面的存在性**）；该 bundle 已物化 —— 它的 CSS module 进了 `<style data-plugin-css>`（**代码真的执行过**，装配失效即红）。**口径**：`conversation.input.activity` 只在会话内的输入栏渲染，而 e2e 全程不建会话，所以"麦克风按钮可见"这条只能在真机探针里断言 |
| `temp/voice-mic-probe.mjs`（真机探针，非门禁） | 打包版 + 预填工作区 + 新会话 → 点麦克风 → 上游对话框 → 前往安装 → 准备面真的取到 `catalog()`（显示提供者与阶段、出现「下载并启用」按钮）；`VOICE_PROBE_DOWNLOAD=1` 时真下载到终态（见 §2.2），载荷随包时直接进「已就绪」（见 §6.1 实测）。**探针口径**：CDP 端口与 `XDG_CONFIG_HOME` 每次都要换 —— 残留实例（在命令沙箱外，`pkill`/`ps` 看不见）会同时占住端口与单实例锁：新实例静默退出，而旧实例的 CDP HTTP 已不响应，于是无超时的 `fetch` 会一直等下去（本次踩过；探针已给每次 HTTP 探测加 3s 超时）。收尾必须**关掉 CDP 的 WebSocket** 再显式退出：不关它 Node 的事件循环不空，探针会把活干完却永不退出，被外层 `timeout` 收尸成 `EXIT=124`（看起来像失败，其实每一条输出都已打印；本次第一版日志就是这样，见 `temp/voice-download-probe2.log` 与修好后的 `…-probe3.log` EXIT=0） |

**已实测**（打包版 Linux + mock gateway，2026-09-29；探针日志 `temp/voice-download-probe3.log`，EXIT=0）：麦克风按钮出现 → 上游「使用语音输入前需要安装」→ 我们的准备面（228 MB 下载 / 954 MB 预留两个数）→「下载并启用」→ `109 MB / 228 MB` →「正在校验模型文件…」→ **已就绪**（约 20 秒；三个模型文件字节数与上游清单逐字相同）。模型就绪后按钮变成「开始录音」，点下去走到采集层才失败（`语音识别失败：Requested device not found` = Chromium 的 `NotFoundError`，Xvfb 里没有麦克风设备）—— **不是权限拒绝**：若权限处理器拦下，报的会是 `NotAllowedError`。

未做（已知边界）：
- **录音与识别本身未验**：本机（Xvfb）没有麦克风设备，`getUserMedia` 之后的采集/转写链路要在有麦克风的机器上验；macOS 的 TCC 弹窗与 entitlement 只有在真 Mac + 正式签名的包上才算验过（mac CI job 只验打包与结构）。
- 下载源选择器（用 provider 默认策略）；把准备进度做成系统通知；
`sherpa` 平台包"只装本平台"的裁剪（要动 yarn 的 `supportedArchitectures` 或 `build.files` 排除规则）。

## 8. 与"客户端体积压缩"的关系（待拍板）

同一个决策的另一面：语音不启用时，这两份 sherpa 原生库（Linux 双架构 71MB unpacked）是纯死重。
本决策**选择"用起来"而不是"裁掉"**。若日后改主意：
`build.files` 加排除 + `REQUIRED_PACKAGED_RUNTIME_ENTRIES` 撤条 + `verify:closure` 同步，
并同时撤掉 `REQUIRED_BUNDLES` 里的装配行（否则运行期报模块缺失）。
