# 随包 agent 运行时（node + pnpm + python）

- **日期**：2026-10-08
- **状态**：已实施（分支 `chore/client-size-compression`）
- **触发**：客户现场「创造模式不能用 / agent 写的代码跑不起来」。根因有两条：① 桌面客户端
  **不带任何包管理器**，而上游创造模式的作者化路径是「把能力打成 bundle → `plugin_manager`
  `install_bundle`」⇒ 必然 `ENOENT`；② agent 要写代码时没有 `node`/`python` 可用。
  另外 0.1.6/0.1.7 线的 `cordis` preset 曾因缺少 `profileContext` 挂不起来（issue #130，
  已在 v2.8.2-beta.1 修复），本轮把「作者化链路」整条补齐。

## 一、决策

**把三套官方预编译运行时随客户端分发**，并让 agent 与 `plugin_manager` 都能直接用：

| 运行时 | 版本 | 形态 | 用途 |
|---|---|---|---|
| Node.js | 24.21.0（Krypton LTS） | 官方 `node-v24.21.0-<platform>` 发行包 | agent 写/跑 JS、`plugin_manager` 跑 pnpm 的宿主 |
| pnpm | 11.7.0 | npm 发行包（`bin/pnpm.mjs`，用随包 node 执行） | `plugin_manager` 的 `install_bundle`/`remove_bundle`；agent 直接可用 |
| CPython | 3.12.15（python-build-standalone `20261003`，`install_only_stripped`） | 官方预编译包（自带 pip） | agent 写/跑 Python、`pip install` |

选 pnpm **JS 形态**而不是 `@pnpm/exe` 单文件（后者三平台 40–54 MiB）：JS 形态只要 4.6 MiB
制品、19 MiB 展开，且与上游桌面端自带的 pnpm 同版本（`plugin_manager` 解析 pnpm 输出，
版本对齐少一类意外）。本机实测：随包 node 直接执行 `bin/pnpm.mjs` 可以真的装包
（`pnpm add is-number` → 下载并落 `node_modules`）。

## 二、交付形态

```
packages/host/desktop/runtimes.json          # 钉死清单：版本/制品名/字节/sha256（唯一真源）
packages/host/desktop/scripts/fetch-bundled-runtimes.mjs   # 下载→校验→解包→裁剪→shim→清单
packages/host/desktop/build/runtimes/        # 打包输入（gitignored；展开 180–240 MiB / 3840–5792 文件，见第三节）
packages/host/desktop/build/runtimes-cache/  # 制品缓存（gitignored；CI 用 PICOAI_RUNTIME_CACHE 外移）
   ↓ electron-builder extraResources
<app>/resources/runtimes/                    # **不进 asar**：裸 node/python 没有扩展名，
                                             # asarUnpack 的显式 glob 匹配不到 ⇒ 进了归档就不可执行
```

载荷内布局（`manifest.json` 是它的自述）：

```
runtimes/
├── node/{bin,lib,LICENSE}          # 官方发行包，裁掉 include/ share/doc corepack
├── pnpm/{bin/pnpm.mjs,dist,LICENSE}  # npm 发行包
├── python/{bin,lib,include,pip.conf,lib/python3.12/LICENSE.txt}
├── bin/{node,npm,npx,pnpm,python,python3,pip3}[.cmd]   # 生成的 shim（PATH 只前置这一个目录）
└── manifest.json                   # 目标平台 / 版本 / 三个入口 / 树摘要 / 许可文本 / 关键文件哈希
```

三处接线（客户端侧 `src/bundled-runtimes.ts`）：

1. **PATH 前置**：`<resources>/runtimes/bin` 插到 `process.env.PATH` 最前，发生在
   `src/main.ts` 的 `start()` 里（`applyInstallDshHome()` 之后、`boot()` 之前）。这是唯一
   接缝：agent 的 bash/pwsh、MCP stdio 服务、`plugin_manager` 的 pnpm 都从
   `process.env.PATH` 继承（上游 `scrubbedParentEnv()` 明确保留 PATH）。
2. **`ProfileContext.packageManager`**：指向随包 pnpm（`command` = 随包 node、
   `args` = `pnpm.mjs`）。上游 `runProfilePnpm` 用 `[...args, ...pnpmArgs]` 调 execa，
   于是 `install_bundle`/`remove_bundle`/`pnpm view` 全部走随包 pnpm —— 这是"作者化路径
   从 ENOENT 变可用"的那一处。载荷缺席时**仍然不提供**（回落 PATH，不编造入口）。
3. **python 的两件事**：`PYTHONPYCACHEPREFIX=<home>/python-cache`（`.pyc` 不写进已签名的
   应用包）、`PYTHONUSERBASE=<home>/python-user` + 载荷自带 `pip.conf`（`user = yes`）⇒
   `pip install X` 落在数据根、命令行工具落在 `<home>/python-user/bin`（已接进 PATH 末尾）。
   实测：`pip3 install six` 落到 `~/.local`（本机 `PYTHONUSERBASE` 缺省时）而不是应用包。

## 三、体积（三平台实测 + 预算门禁）

三个目标各自**完整就位一次**后量出来的载荷（未压缩；`manifest.json` 的 `tree`）：

| 项 | linux-x64 | darwin-arm64 | win-x64 |
|---|---|---|---|
| 制品下载（node / pnpm / python） | 58.1 + 4.6 + 34.3 MB | 52.9 + 4.6 + 25.0 MB | 37.6 + 4.6 + 22.0 MB |
| 载荷展开 | **240.4 MiB / 3840 文件** | **206.5 MiB / 3840 文件** | **180.0 MiB / 5792 文件** |
| 载荷 `xz -9` 压缩 | **55.8 MB**（≈ AppImage 增量；AppImage 用 `-comp xz`） | 未量（DMG 用 bzip2） | 不适用（NSIS 恒 `-mx=9`） |

Linux 的构成：`node` 140 / `python` 95 / `pnpm` 19 MiB（剪裁后）。Windows 文件数多出 1952 个
是 node 与 CPython 的 Windows 发行包本来就更碎（`.exe`/`.dll`/`.pdb` 之外还有 `Scripts/`、
`tcl/`），字节数反而最小。

**体积预算门禁（棘轮）**：`runtimes.json` 的 `budget.targets.<target>` 记下上表每行的
bytes/files 上限，判据取 `≤`（只允许变小）：

- 就位/校验路径（`fetch-bundled-runtimes.mjs` 的 `verifyRuntimePayload`，含 CI 用的 `--check`）——
  载荷超限即**整份拒绝**，不会产出"悄悄胖一圈"的包；
- afterPack 门禁（`assertBundledRuntimesPackaged`，判的是**产物**里的那份载荷）——用户拿到的
  安装包背的就是它；
- `readRuntimePin` 要求**每个目标都必须有预算**（缺一条即拒）：否则"新增一个目标"或
  "换一份清单"可以结构性地把门禁关掉；
- 回归网还判"预算既打得到又打不烂"：`≤ 384 MiB / 16384 文件` 的硬顶（防有人把红门禁改绿成
  10 GiB）、`> 三份压缩制品之和` 的下界（防"永远红"）、以及本机已就位载荷时
  **预算必须贴着实测值（≤ 实测 × 1.02）**——载荷缩了也要把数字收紧回去。

升级运行时（或改剪裁清单、加 shim）必然撞红，作者必须在 `runtimes.json` 这一处显式改写
数字并说明理由 —— 这是"每个平台的安装包都背这份成本"这一事实的可见化。

认账：这是一次**明确用体积换能力**的决策（安装包预计 +50–60 MB）。已做的减法：node 去掉
`include/`、`share/doc`、`share/man`、`corepack`；python 去掉 `test`、`idlelib`、`turtledemo`、
`lib2to3`、静态库与 `share/`、`bin/p2to3|idle3|pydoc3`；Linux 侧把 `build/runtimes/**` 从 asar
里显式排除（Linux 的应用根匹配器会落回兜底全匹配，不排除就是"归档一份、resources 再一份"）。

### 顺带修掉的一处既有双份（实测 −230.2 MiB asar）

同一条 Linux 兜底匹配此前也把**语音模型载荷**（231 MiB）收进了 asar，而它本来就在
`resources/speech-model/`（`extraResources`）里 —— 本机 `--dir` 产物实测：asar 里确有 7 个
`build/speech-model/*` 条目。加一行 `!build/speech-model/**` 后：

| | asar 字节 | asar 里的 runtimes / speech-model 条目 |
|---|---|---|
| 修前（本机 2026-10-08 `--dir`） | 376,755,514 | 0 / **7** |
| 修后（同一命令） | **135,392,765** | 0 / 0 |

差值 241,362,749 B = 语音模型三文件之和 ⇒ 这一处**净省约 230 MiB asar**（对应 AppImage 约
−40~80 MB，按 mksquashfs xz 的实测压缩比推算；交付件口径待下一次 CI 产物量）。

## 四、判据（六层，各自能被打坏）

1. **客户端解析**（`tests/bundled-runtimes.spec.ts`）：载荷缺席/清单坏/目标平台不符/入口不在
   ⇒ 返回 `undefined`；命中时 PATH 前置**幂等**、python 两个变量落位、`packageManager`
   指向随包 pnpm；`src/main.ts` 的接线在 **boot 之前**且不内联字面量。
2. **afterPack 门禁**（`scripts/verify-packaged-runtime.ts` 的 `assertBundledRuntimesPackaged`）：
   声明了就必须在（**没有"本次构建不含该能力"这一档**）；产物树摘要 == 打包输入树摘要；
   三个 shim **各真跑一次**（`node -v` / `pnpm -v` / `python3 -V`）且逐字等于清单版本；
   node 自报 `platform-arch` == 清单 target（拿错平台的载荷当场现形）；三份许可文本必须在；
   **载荷不得超出体积预算**。
3. **打包配置**：`extraResources` 带载荷、全局正向清单**不得**收载荷进 asar、Linux 的
   `build.linux.files` 显式排除 `build/runtimes` 与 `build/runtimes-cache`、`.gitignore`
   两行（公开仓 `git add -A` 不能提交 GB 级第三方二进制）。
4. **合规**：`verify-licenses.mjs` 的三条随包通告（版本从 `runtimes.json` 读，不手抄）+
   `THIRD_PARTY_NOTICES.md` 重生成 + 载荷内自带 `node/LICENSE`、`pnpm/LICENSE`、
   `python/lib/python3.12/LICENSE.txt`（由 afterPack 门禁断言）。
5. **macOS 发布判据**（`scripts/verify-mac-release.ts` 的 `assertBundledRuntimesSigned`）：
   `codesign --verify --deep --strict <app>` **不保证** `Contents/Resources` 下的嵌套 Mach-O
   被重签过（PBS 出厂只有 ad-hoc 签名，而公证逐字排除 ad hoc），也不保证它们**跑得起来**
   （丢可执行位、被 Gatekeeper 拦都不会让 `--deep` 变红）——所以发布路径逐个入口验签 +
   真跑三个 shim + 逐字比版本 + 清单必须在。`tests/verify-mac-release.spec.ts` 用真
   `.app` 夹具（自洽 `Info.plist`/`.icns`/`app.asar` + 合成运行时载荷）驱动，六个负向
   用例分别打"清单缺失 / schema 不符 / 命令数不符 / 入口不在 / shim 不在 / 版本不符"。
6. **体积预算**：见第三节（就位路径 + afterPack 双接线，`readRuntimePin` 强制每个目标都有
   预算，回归网判"打得到也打不烂"）。

### 变异验证（本机 2026-10-08，隔离副本 `temp/mut-budget/`）

| 变异 | 结果 |
|---|---|
| 删掉 `verifyMacRelease` 里的 `assertBundledRuntimesSigned` 调用点 | 红 2 条（验签/真跑 + 版本不符） |
| 版本比对改成"只要跑起来就算过"（`if (false)`） | 红 2 条（发布路径 + 直接判据） |
| 删掉 `verifyRuntimePayload` 里的体积预算调用 | 红 1 条（`--check` 接线） |
| 删掉 afterPack 里的体积预算调用 | 红 1 条（产物侧接线） |
| 预算放宽到 10 GiB | 红 1 条（"打不烂"硬顶） |
| 删掉 `readRuntimePin` 的预算必填校验 | 红 1 条（预算缺席即拒） |

### 实施中踩到并固化的两条"本地绿、打包红"

- **打包器按名字跳过 `.gitkeep`/`.DS_Store`**（`builder-util/out/fs.js:68`）：留在载荷里会让
  产物比清单少一个文件，门禁读成"拷贝截断"。处置：摘要两边都跳过这两个名字 **且** 载荷里
  删掉它们 —— 不是让门禁容忍少文件（那会连真正的截断一起放过）。
- **载荷是只读交付物**：CPython 运行期会写 `__pycache__/*.pyc`（内嵌源文件 mtime/size ⇒
  字节数变化）。一次不带 `PYTHONDONTWRITEBYTECODE=1` 的探测就让下一次打包判"载荷不一致"
  并整份重新解包（实测 123 字节差异）。afterPack 门禁的探测已带该变量；客户端侧由
  `PYTHONPYCACHEPREFIX` 兜底。

## 五、平台代价与下限（随包哪些运行时就要认哪些账）

- **Linux**：Node 官方 `linux-x64` 制品要求 **glibc ≥ 2.28 / kernel ≥ 4.18**（Ubuntu 20.04+、
  Debian 10+、RHEL 8+；**不覆盖** CentOS 7 / Ubuntu 18.04 / Amazon Linux 2）。CPython 只要
  glibc 2.17，不是瓶颈。
- **Windows**：整包下限由 Node 决定 = **Windows 10 / Server 2016+**（PBS 只要求 8.1）。两边
  都不需要装 VC++ 可再发行包（PBS 随包带 `vcruntime140*.dll`；Node 静态链接 CRT）。
- **macOS**：下限由 Node 的 `minos` 决定（13.5+）；arm64 一条产线。PBS 的 Mach-O **只有
  ad-hoc 签名**，必须由我们对整树重签 —— `@electron/osx-sign` 会递归遍历 `Contents/` 并
  只挑 Mach-O 逐个签（无扩展名的 `node`/`python3` 也认），所以载荷放
  `Contents/Resources/` 即自动重签；**绝不能进 asar**（asar 不支持符号链接，会把 10 个
  Mach-O 实体变 12 个、白胖 ~36 MB）。`bin/python3`/`bin/python` 是指向 `python3.12` 的
  符号链接，`bin/pip*` 是 234 B 包装脚本（依赖 `bin/` 内相对位置，不可移动解释器）。
- **装包仍需出网**：随包只解决"没有包管理器"。`pnpm install` 要 registry（客户网只有认证
  代理时按本产品"默认禁代理"的既有口径处理）；离线场景仍可用 `install_bundle` 装**本地
  目录** bundle（skill 的示例就是工作区里的绝对路径）。

## 六、验证链（本机 2026-10-08 实跑）

| 判据 | 结果 |
|---|---|
| `fetch-bundled-runtimes.mjs`（真下载 + 校验 + 解包 + shim + 清单） | 就位 3840 文件 / 240.4 MiB；`--check` 通过；重复调用走幂等快路径 |
| 另外两个目标各**完整就位一次**（`--target darwin-arm64` / `win-x64`，落到 `temp/runtimes-verify/`） | darwin-arm64 3840 文件 / 206.5 MiB（`node` 是 Mach-O `cffaedfe`、`bin/python3` 符号链接 → `python3.12`）；win-x64 5792 文件 / 180.0 MiB（`node.exe`/`python.exe` 为 MZ、shim 为 `.cmd`）；两者 `--check` 均通过 |
| 三个 shim 真跑（本机 linux-x64 载荷） | `node -v`=v24.21.0、`pnpm -v`=11.7.0、`python3 -V`=3.12.15（`pnpm add is-number` 真装包成功） |
| `vitest`（desktop 全量） | 125 文件 / 1531 用例全绿（含 `tests/bundled-runtimes.spec.ts` 25 例、`tests/verify-mac-release.spec.ts` 16 例） |
| `tsc -p tsconfig.json` / `tsconfig.tests.json` | 0 error |
| `verify:licenses` / `verify:notices` | 通过（通告新增"Bundled agent runtimes"一节） |
| `yarn workspace dsh-plugin-desktop package:dir`（真打包） | EXIT=0；afterPack 打印 `bundled agent runtimes verified … (linux-x64; node 24.21.0 / pnpm 11.7.0 / python 3.12.15; 240.4 MiB, budget 240.4 MiB)` |
| 打包产物体内探针（`temp/agent-preset-debug/probe-packaged-path.mjs`） | 客户端日志出现 `bundled runtimes: … → resources/runtimes/bin prepended to PATH`；产物内三个命令各自 `-v` 正确 |
| 体积预算门禁的六个变异（隔离副本） | 全部按预期变红（见第四节的变异表） |
| `check-root-guards`（17 条，含 `check:workflows` / `check:layout` / `check:doc-claims` / `check:licenses` / `check:no-real-domains`） | `VERDICT PASS guards=17` |

仍未闭环：

- **macOS / Windows 真机**：mac 的"重签 + 能 spawn"判据已在发布路径上（第四节第 5 层），但
  **尚未在真 Mac 上跑过一次**（CI 的 `desktop-macos-release` job 覆盖）；Windows 侧的运行时
  可执行性由本机解包 + afterPack 判据覆盖，还没有在真 Windows 上打包验证过。
- **交付件体积数字待回填**：AppImage/DMG/Setup 的实际增量要等下一次 CI 产物量（本机
  `--dir` 产物只能给包内数字，不是交付件口径）。
- **`plugin_manager` 的 pnpm store** 仍在用户目录（`~/.local/share/pnpm/store` 等），
  没有重定向到数据根 —— 需要"自包含卸载"时再定。
- **README/官网文案**未提"客户端随包 node/pnpm/python"（改 README 要同提交更新
  `README.i18n.yaml` 的记录哈希，见 `verify-layout.mjs`）。
