/**
 * 渠道 channel.json 的逐字段校验器。
 *
 * 为什么是独立文件而不是 `ci-channels.sh` 里的 `node -e '…'`（2026-10-13）：
 * 这段代码已经长到 24KB 量级，内联进命令行后在 **Windows** 上会撞
 * `Argument list too long`（CreateProcess 的命令行/环境合计上限）——
 * desktop-windows 打包 job 因此红在 `ci-channels.sh:725`，而 Linux/macOS 照旧绿
 * （它们各自的上限高得多）。抽成文件后命令行只剩一个路径，与长度无关。
 *
 * 用法：`node scripts/lib/check-channel-json.mjs <channel.json 路径>`
 * 需要的环境变量（由 `ci-channels.sh` 导出）：CHANNEL_ID / CHANNEL_LOGO_FILE /
 * CHANNEL_APP_ICON_FILE / CHANNEL_PLATFORM_TOKENS / CHANNEL_TEMPLATE_KEY_LIST /
 * CHANNEL_FEATURE_MODULE_LIST / CHANNEL_REQUIRE_TEMPLATE。
 * 退出码：0 = 通过；1 = 字段不合法或缺失（消息不回显渠道名/取值）。
 */
import fs from "node:fs"
import path from "node:path"

    const dir = path.dirname(process.argv[2])
    const id = process.env.CHANNEL_ID
    const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
    const str = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined)
    const publicChannel = id === "official" || id === "beta"
    // 官方正式版的数据目录名(desktop-home.ts 的 PRODUCT_DSH_HOME_DIR,编译期常量)。
    const OFFICIAL_HOME_DIR = ".picoaide-harness"
    const missing = []
    const invalid = []
    const warnings = []
    // identity.display_name 是客户端**所有**名字的最终兜底(登录页/界面/门户),
    // short_name 是登录页与服务端 applyDefaults 的直接来源:两者缺一,渠道构建
    // 就会在某个可见位置显示中性占位。
    if (str(cfg?.identity?.display_name) === undefined) missing.push("identity.display_name")
    if (str(cfg?.identity?.short_name) === undefined) missing.push("identity.short_name")
    if (!publicChannel) {
      if (str(cfg?.desktop?.slug) === undefined) missing.push("desktop.slug")
      if (str(cfg?.desktop?.app_id) === undefined) missing.push("desktop.app_id")
      if (str(cfg?.desktop?.deep_link_scheme) === undefined) missing.push("desktop.deep_link_scheme")
    }
    // 数据目录(2026-09-11;2026-09-12 两次修订):客户端里官方目录名是编译期常量,
    // 渠道不显式声明就只能共用官方目录 —— 两个渠道共用一个数据根会共享登录
    // token/settings/会话(跨租户),并互相顶掉 Electron 的单实例锁。只能在构建期拦:
    // 装到客户机器上时数据已经共享了。
    // **beta 相反(2026-09-12 用户定案)**:预发版是正式版的前置验证,必须与 official
    // 用同一个数据根,否则装预发版的用户升级后看不到既有会话与登录态 —— 当天早些
    // 时候改成独立目录 `.picoaide-harness-beta` 就是这么炸的(用户报"所有对话都没了":
    // 旧数据留在官方目录,新客户端读的是新目录)。这条**显式且唯一**:写别的目录(含
    // 派生兜底 `.picoaide-harness-<渠道>`)一律 fail-loud,免得哪天又静默漂移。
    if (str(cfg?.desktop?.home_dir) === undefined && id !== "official") missing.push("desktop.home_dir")
    // 数据目录名形状:`~` 下的**单段**目录名(点开头 + 小写字母/数字/连字符)。
    // 允许分隔符等于让渠道包把数据根挪到任意位置;大写会让同一个渠道在 Linux 与
    // Windows/macOS 上落进两个不同目录。
    const homeDir = str(cfg?.desktop?.home_dir)
    if (homeDir !== undefined && !/^\.[a-z0-9][a-z0-9-]{0,62}$/.test(homeDir)) {
      invalid.push("desktop.home_dir(须为点开头的单段小写目录名,如 .acme-harness)")
    }
    if (id === "beta" && homeDir !== OFFICIAL_HOME_DIR) {
      invalid.push("desktop.home_dir(预发布渠道必须与官方正式版一致,写别的目录会让预发版用户升级后看不到既有会话与登录态)")
    }
    // 品牌渠道(official/beta 之外)**不得**等于官方目录:渠道线与 official 的
    // 会话格式世代可能不同,共用会静默分叉数据;不同客户之间更不该共享数据根。
    if (id !== "official" && id !== "beta" && homeDir === OFFICIAL_HOME_DIR) {
      invalid.push("desktop.home_dir(不得与官方渠道共用数据目录:渠道线与 official 的会话格式世代可能不同,共用会静默分叉数据;请用 .picoaide-harness-<渠道>)")
    }
    // 非法字段**只报字段名,不回显取值** —— 渠道包里 slug/app_id/scheme 的值就是
    // 客户品牌(Acme-AI / com.acme.ai / acmeai),而这一步的输出进公开 Actions 日志。
    // 2026-09-10 审计当场发现:早先版本把值打进了错误信息,等于给品牌渠道装了条
    // 泄密通道(`::add-mask::` 只掩码渠道 id,掩不到这些值)。
    const slug = str(cfg?.desktop?.slug)
    if (slug !== undefined && !/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(slug)) invalid.push("desktop.slug(须为 ASCII 字母/数字/连字符)")
    // product_name(2026-09-12 审计 P1-13):它是 Electron userData 目录名
    // (desktop-user-data.ts)与 mac `.app` 目录名(release-mac.ts)的输入,是这批
    // 字段里唯一没有形状校验的。`../evil` 会把数据根挪出 appData;两个渠道取同一个
    // 产品名(acme / acme-staging)会共用 userData(单实例锁互顶 + 状态互相污染)。
    // 与客户端 desktop-channel.ts 的 isSafeProductName 同款(运行时同样校验,
    // 这里只是把事故提前到构建期)。刻意与 slug/app_id 一样**只报字段名不回显取值**。
    const productName = str(cfg?.desktop?.product_name)
    if (productName !== undefined) {
      const safeProductName = /^[^\s/\\:*?"<>|\u0000-\u001F\u007F][^/\\:*?"<>|\u0000-\u001F\u007F]{0,63}$/.test(productName)
        && !/[. ]$/.test(productName)
      if (!safeProductName) invalid.push("desktop.product_name(须为路径安全的产品名:禁路径分隔符/控制字符/Windows 非法字符,不以点或空格结尾,1–64 字符)")
    }
    const appId = str(cfg?.desktop?.app_id)
    if (appId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(appId)) invalid.push("desktop.app_id(须为反向域名形状)")
    const scheme = str(cfg?.desktop?.deep_link_scheme)
    if (scheme !== undefined && !/^[a-z][a-z0-9+.-]{1,31}$/.test(scheme)) invalid.push("desktop.deep_link_scheme(须为小写 RFC 3986 scheme)")
    // app_origin_scheme(2026-09-19 设计 §10/§8.3):WASM 应用的**客户端协议 origin**。
    // 客户端按它注册特权 scheme、在合成请求里写 Origin;服务端按它校验来源。
    //   - **全部渠道必填**(含 official/beta,**不做 publicChannel 豁免**):字段缺失时
    //     两端各自回落(`<deep_link_scheme>-app` 派生值 / 服务端缺配置的中性 fallback),
    //     而"派生缺省"只允许存在于本地开发 —— 发行镜像里两侧取值不一致就是"应用打不开"
    //     且故障现象与配置毫无关系。所以进 missing,fail-loud。
    //   - 跨渠道唯一性**不在这里**判(逐渠道校验看不见别的渠道):见本脚本末尾的
    //     独立扫描 pass。
    const RESERVED_APP_ORIGIN_SCHEMES = new Set(["http", "https", "file", "data", "javascript", "about"])
    const appOriginScheme = str(cfg?.desktop?.app_origin_scheme)
    if (appOriginScheme === undefined) {
      missing.push("desktop.app_origin_scheme")
    } else {
      // 形状:与两端既有实现**逐字一致**的 RFC 3986 scheme 正则(总长 2–32,
      // **有上界**)—— 两端各写一份正则就会漂移,而漂移的后果是"服务端拒绝、客户端
      // 照发"(所有非幂等请求 403)。合法字段只报字段名,不回显取值。
      if (!/^[a-z][a-z0-9+.-]{1,31}$/.test(appOriginScheme)) {
        invalid.push("desktop.app_origin_scheme(须为小写 RFC 3986 scheme:小写字母开头,只含小写字母/数字/加号/点/连字符,2–32 字符)")
      }
      // 与同渠道 deep_link_scheme 同值:两者在客户端里是两个不同的注册项,
      // 同值会让"深链回调"与"应用页 origin"在协议栈层面撞在一起,必须不同。
      if (scheme !== undefined && appOriginScheme === scheme) {
        invalid.push("desktop.app_origin_scheme(不得与 desktop.deep_link_scheme 相同 —— 应用 origin 与深链回调必须用两个不同的 scheme)")
      }
      // 保留 scheme(§10 冻结名单):浏览器/系统已有既定语义,拿去当应用 origin 会让
      // 应用页与它们冲突,也过不了特权 scheme 注册。名单是固定常量,不涉渠道取值。
      if (RESERVED_APP_ORIGIN_SCHEMES.has(appOriginScheme)) {
        invalid.push("desktop.app_origin_scheme(不得使用保留 scheme:http/https/file/data/javascript/about)")
      }
    }
    const serverUrl = str(cfg?.defaults?.server_url)
    if (serverUrl !== undefined) {
      let parsed
      try { parsed = new URL(serverUrl) } catch { invalid.push("defaults.server_url(不是合法 URL)") }
      if (parsed !== undefined && parsed.protocol !== "https:") {
        const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname)
        if (!loopback) invalid.push("defaults.server_url(必须 https,只有回环地址允许 http)")
      }
    }
    // 语音识别模型的部署面(2026-09-29):模型是运行期按需下载的 228MB 权重,走宿主 Node
    // **直连**(客户端默认禁代理),而客户网常常"只有认证代理能出公网"。渠道包可以给
    // 预置目录(零下载)或内网镜像。三项形状**在这里拦**:客户端运行期对形状不符只是
    // "不注入、回落公网下载",于是配错的表现是"语音在客户网里准备不好"—— 而那时
    // 客户端已经发出去了。只报字段名,不回显取值(路径与镜像主机名都属部署身份)。
    const speechModelDir = cfg?.desktop?.speech_model_dir
    const speechVadPath = cfg?.desktop?.speech_vad_path
    const speechOrigin = str(cfg?.desktop?.speech_model_origin)
    // 允许两种写法:字符串(三平台同值)或 {default,darwin,linux,win32} 平台映射。
    const speechPathEntries = (value, field) => {
      if (value === undefined) return []
      if (typeof value === "string") return [[field, value]]
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        invalid.push(field + "(须为绝对路径字符串,或 {default,darwin,linux,win32} 平台映射)")
        return []
      }
      for (const key of Object.keys(value)) {
        if (!["default", "darwin", "linux", "win32"].includes(key)) {
          invalid.push(field + "(平台键只能是 default/darwin/linux/win32)")
          return []
        }
      }
      return Object.entries(value).map(([key, path]) => [field + "." + key, path])
    }
    const speechPaths = [
      ...speechPathEntries(speechModelDir, "desktop.speech_model_dir"),
      ...speechPathEntries(speechVadPath, "desktop.speech_vad_path"),
    ]
    for (const [field, value] of speechPaths) {
      // 绝对路径:上游对 modelDirectory/vadModelPath 就是这条要求(非绝对直接抛),
      // 而相对路径的基准(客户端 cwd、家目录)在不同启动方式下并不一样 —— 构建期
      // 按 POSIX 与 Windows 两种形态都认(一份 channel.json 服务三平台)。
      const absolute = typeof value === "string" && (/^\//.test(value) || /^[A-Za-z]:[\\/]/.test(value))
      if (!absolute) invalid.push(field + "(须为绝对路径,如 /opt/... 或 C:\\...)")
    }
    if (speechOrigin !== undefined && !/^https?:\/\/[^/\s?#@]+\/?$/.test(speechOrigin)) {
      invalid.push("desktop.speech_model_origin(只允许 scheme://host[:port];模型路径由客户端钉死,不能带路径/查询)")
    }
    // 随包语音模型(2026-09-29):**所有渠道默认随包**(230MiB 权重进客户端目录,语音零网络
    // 可用);只有**显式布尔 false** 才关闭(回到"首次使用下载")。字段只认布尔 —— 字符串
    // "false" 在客户端会按缺省(随包)处理,即"以为关了其实没关";在构建期判红才能让拼写错误
    // 现形,而不是让一个渠道的安装包平白多 230MiB(或反过来以为带了其实没带)。只报字段名。
    const speechBundleModel = cfg?.desktop?.speech_bundle_model
    if (speechBundleModel !== undefined && typeof speechBundleModel !== "boolean") {
      invalid.push("desktop.speech_bundle_model(须为布尔;缺省=true 随包,显式 false 关闭)")
    }
    // ---- features:本渠道交付哪些功能模块(2026-10-13)----
    //
    // 语义(契约见 docs/decisions/2026-10-13-channel-feature-modules.md):
    //   · **缺省全开** —— 不写 features = 三个模块都要(基础功能恒开,既有渠道行为
    //     逐字节不变);
    //   · 写了的键才可能关掉,取值必须是布尔。
    // 写错的三种后果都**只在客户机器上**才暴露,且方向都是"多发":
    //   · 未知模块名(拼错 skill→skils)⇒ 构建侧按"未声明"处理,那个模块照样交付;
    //   · 取值是字符串 "false" ⇒ 它在 JS 里是真值,模块照样交付 —— 而写配置的人
    //     以为自己关掉了("以为关了其实没关"是这一族里最贵的一种);
    //   · 不是对象(数组/字符串)⇒ 整份声明没有意义。
    // **取值刻意不回显**(可能是任意字符串),未知键名同样不回显(键名本身就可能是
    // 渠道/品牌标识,与本脚本对素材键的纪律一致) —— 只报字段名、数量与合法集合。
    const KNOWN_FEATURES = (process.env.CHANNEL_FEATURE_MODULE_LIST || "").split(",").filter(Boolean)
    if (KNOWN_FEATURES.length === 0) {
      // 清单为空 ⇒ 下面两条键集合校验会退化成"什么都不查"(未知键一个都认不出来)。
      // 外层 shell 在取常量那一步已经拦过一次;这里拦的是**另一个**失败面:清单存在
      // 但没被 export 到本进程(接线回退) —— 那时 shell 侧的判据看不见,只有这里看得见。
      invalid.push("features(无法校验:功能模块清单没到校验器手里,见 packages/host/desktop/scripts/channel-constants.ts 的 FEATURE_MODULES)")
    }
    const rawFeatures = cfg?.features
    if (rawFeatures !== undefined) {
      if (typeof rawFeatures !== "object" || rawFeatures === null || Array.isArray(rawFeatures)) {
        invalid.push("features(必须是对象,如 {\"skills\": false};不写这个键 = 全部开启)")
      } else {
        const declared = Object.keys(rawFeatures)
        const unknown = declared.filter(key => !KNOWN_FEATURES.includes(key))
        if (unknown.length > 0) {
          // 合法模块名**要打印**（2026-10-13 独立审计 P2）：模块名是公开仓里的常量
          // （skills/apps/connectors），不是渠道身份；而官网《渠道与品牌》页承诺的正是
          // "报错点名字段与合法模块名"。此前只写"见 channel-constants.ts 的
          // FEATURE_MODULES"，读者得自己打开源码文件才拿到这三个名字 —— 承诺比实现对得
          // 宽一档。**取值与未知键名仍然不回显**（那两样才可能是客户品牌）。
          invalid.push("features(有 " + unknown.length + " 个未登记的模块名;合法模块名: " + KNOWN_FEATURES.join(" / ") + ";键名与取值都不回显)")
        }
        const badType = declared.filter(key => KNOWN_FEATURES.includes(key) && typeof rawFeatures[key] !== "boolean")
        if (badType.length > 0) {
          invalid.push("features." + badType.join(",features.") + "(取值必须是布尔 true/false;字符串 \"false\" 不是 false,取值不回显)")
        }
      }
    }
    // ---- desktop.platforms:本渠道交付哪些客户端平台(2026-10-13)----
    //
    // 语义:缺省 = 三端全交付(向后兼容:既有渠道不写这个键,行为逐字节不变);
    // 写了就必须是**合法子集**。写错的两种后果都在客户机器上才暴露:
    //   · 多写一个不存在的 token ⇒ 交付面静默收窄成"没有该平台"(门户少一块、
    //     更新清单少一个键);
    //   · 少写/写错 ⇒ 该平台明明不交付却仍进镜像与更新面。
    // **取值刻意不回显**(可能是任意字符串) —— 只报字段名与合法取值来源。
    const KNOWN_PLATFORMS = (process.env.CHANNEL_PLATFORM_TOKENS || "").split(",").filter(Boolean)
    const rawPlatforms = cfg?.desktop?.platforms
    if (rawPlatforms !== undefined) {
      if (!Array.isArray(rawPlatforms)) {
        invalid.push("desktop.platforms(须是数组,如 [\"win\", \"mac\"])")
      } else {
        const picked = rawPlatforms.map(v => (typeof v === "string" ? v.trim().toLowerCase() : ""))
        if (picked.some(v => v === "")) {
          invalid.push("desktop.platforms(每项必须是非空字符串)")
        } else if (new Set(picked).size !== picked.length) {
          invalid.push("desktop.platforms(不得重复)")
        } else if (!picked.every(v => KNOWN_PLATFORMS.includes(v))) {
          invalid.push("desktop.platforms(含未登记的平台名;合法取值见 packages/host/desktop/scripts/channel-constants.ts 的 CHANNEL_PLATFORMS,取值不回显)")
        }
      }
    }
    // ---- 官方渠道 = 新增渠道的模板:必须逐键显式(2026-10-13 用户定案)----
    //
    // 新增渠道的动作是"拷贝官方目录 → 改身份字段 → 裁剪交付面"。官方配置里缺键,
    // 那几个键就藏在代码兜底值里:复制出来的渠道会带着看不见的继承行为,而且要翻源码
    // 才知道有哪些键存在。所以 CI 取渠道包时带 `--require-template`,对**官方**渠道逐键
    // 检查;键表在 channel-constants.ts 的 CHANNEL_TEMPLATE_KEYS(**故意不含**三个
    // speech_* 覆盖型键:它们是"不写=随包默认",写进模板等于把路径钉死)。
    // 功能模块(2026-10-13)按**叶键**进表(features.skills / features.apps /
    // features.connectors):只写裸 `features` 的话,`"features": {}` 也能过 ——
    // 而拷贝模板的新渠道就看不到有哪几个模块可关,那正是这张表要防的形态。
    // 只对 official 生效:品牌渠道按自己的交付面裁剪,不要求与模板同形。
    const templateMissing = []
    if (id === "official" && process.env.CHANNEL_REQUIRE_TEMPLATE === "1") {
      const templateKeys = (process.env.CHANNEL_TEMPLATE_KEY_LIST || "").split(",").filter(Boolean)
      const pickPath = (obj, path) => path.split(".").reduce((acc, seg) => (acc !== null && typeof acc === "object" ? acc[seg] : undefined), obj)
      for (const key of templateKeys) {
        if (pickPath(cfg, key) === undefined) templateMissing.push(key)
      }
    }
    // 声明的素材文件必须存在(否则客户端/服务端会拿到死链或被忽略的配置)。
    //
    // 只校验**已知的素材字段**:渠道包里允许写 `_note` 这类注解(私有仓实际就这么
    // 用),也允许将来新增字段 —— 拿"所有非 accent 的键都是文件名"去套,
    // 会把注解误判成非法文件名而中止整条发布(2026-09-10 CI 实测踩到)。
    // 未知字段只告警(很可能是把 logo 拼错成 logoo),不拦发布。
    //
    // 2026-09-13 审计 R7(webadmin-branding-1)加严:SVG 素材**禁止脚本特征**。
    // 服务端与客户端都按图片消费素材(<img>),但顶层导航到素材 URL(钓鱼链接)
    // 时浏览器会把它当 SVG 文档执行 —— 内联 <script>/onload= 就在服务端源上跑,
    // 还能带上 HttpOnly 的会话 cookie 读同源管理接口。服务端运行时已按不可信
    // 输入加沙箱 CSP(server/internal/channel/handlers.go),但那只是纵深防御:
    // 内容本身必须在进入镜像**之前**拦掉,这里(渠道包校验)是唯一上游门禁。
    //
    // 2026-09-13 复核(R7-RV-4 / R7-RV-5)修正两处:
    //   - **按结构判定**,不再在整份正文上跑正则:注释、<desc>/文本节点、CDATA 里
    //     写 "导出时不要出现 onload= / javascript: URL" 只是说明文字,旧写法会把
    //     这类合法素材判成脚本素材、把整条渠道发布打回(fail-loud 误伤) 。现在先
    //     跳过注释/CDATA/处理指令,只在**标签内部**看事件处理属性与 URL 属性,只在
    //     元素名位置看 script/foreignObject。
    //   - **按内容嗅探**,不再只看扩展名:素材的 Content-Type 是按文件名定的,把带
    //     脚本的 SVG 命名成 logo.png 就能同时绕过扩展名检查与下发类型,所以凡
    //     "内容像 XML/SVG 文档"(或 UTF-16 编码的同名文档)的素材一律按 SVG 检查,
    //     不管扩展名;.svg 扩展名照旧必查。
    // 命中只报**字段名 + 特征种类**(元素/属性名),不回显文件内容与品牌取值。
    // 不引入第三方依赖:手写扫描器足够。
    const SVG_URL_ATTRS = /^(?:xlink:)?href$|^src$|^data$|^action$|^formaction$|^style$|^(?:values|from|to|by)$/
    // SVG 动画元素能把 script-ish 值"写"进别的属性(`<set attributeName="onload"
    // to="alert(1)"/>` 是已知的 SVG XSS 姿势),这一族按元素名 + attributeName 判定。
    const SVG_ANIM_TAGS = new Set(["set", "animate", "animatetransform", "animatemotion"])
    // XML 数字字符引用会被解析器还原(`&#106;avascript:` = `javascript:`),
    // 判定 URL 属性前先解码,否则换个写法就绕过了。
    const safeCodePoint = (code, fallback) => {
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return fallback
      try { return String.fromCodePoint(code) } catch { return fallback }
    }
    const decodeCharRefs = (v) => v
      .replace(/&#x([0-9a-f]{1,6});?/gi, (whole, hex) => safeCodePoint(parseInt(hex, 16), whole))
      .replace(/&#([0-9]{1,7});?/g, (whole, dec) => safeCodePoint(parseInt(dec, 10), whole))
      .replace(/&colon;/gi, ":")
    // scriptishSvg 返回命中的特征(元素名/属性名);空数组 = 未发现脚本特征。
    const scriptishSvg = (src) => {
      const hits = []
      const n = src.length
      let i = 0
      while (i < n) {
        const lt = src.indexOf("<", i)
        if (lt < 0) break
        // 注释 / CDATA / 处理指令 / DOCTYPE:其中的字样是文本,不是标记。
        if (src.startsWith("<!--", lt)) { const end = src.indexOf("-->", lt + 4); i = end < 0 ? n : end + 3; continue }
        if (src.startsWith("<![CDATA[", lt)) { const end = src.indexOf("]]>", lt + 9); i = end < 0 ? n : end + 3; continue }
        if (src.startsWith("<?", lt) || src.startsWith("<!", lt)) { const end = src.indexOf(">", lt + 2); i = end < 0 ? n : end + 1; continue }
        // 标签体扫到 `>` 为止,但尊重引号(属性值里可以出现 `>`)。
        let j = lt + 1
        let quote = ""
        while (j < n) {
          const ch = src[j]
          if (quote !== "") { if (ch === quote) quote = "" }
          else if (ch === "\"" || ch === "\x27") quote = ch
          else if (ch === ">") break
          j++
        }
        const body = src.slice(lt + 1, j)
        i = j + 1
        if (body.startsWith("/")) continue // 闭合标签
        // 元素名(允许命名空间前缀):只在标签名位置认 script/foreignObject。
        const nameMatch = /^(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)/.exec(body)
        const tag = (nameMatch === null ? "" : nameMatch[1]).toLowerCase()
        if (tag === "script" || tag === "foreignobject") { hits.push("<" + tag + ">"); continue }
        // 属性:事件处理属性(on*=)、动画写事件属性、URL 属性里的 javascript: 协议。
        const attrRe = /([A-Za-z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|\x27([^\x27]*)\x27|([^\s"\x27>]+))/g
        let m
        while ((m = attrRe.exec(body)) !== null) {
          const attr = m[1].toLowerCase()
          if (/^on[a-z]+$/.test(attr)) { hits.push(attr + "="); continue }
          const rawValue = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : (m[4] === undefined ? "" : m[4]))
          if (SVG_ANIM_TAGS.has(tag) && attr === "attributename" && /^on[a-z]+$/i.test(rawValue.trim())) {
            hits.push(tag + "@" + rawValue.trim().toLowerCase())
            continue
          }
          if (SVG_URL_ATTRS.test(attr) && /javascript\s*:/i.test(decodeCharRefs(rawValue))) hits.push(attr + "=javascript:")
        }
      }
      return hits
    }
    // 内容像 XML/SVG 文档?跳过 BOM 与空白后第一个字节是 `<`。
    const looksLikeMarkup = (buf) => {
      let i = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0
      while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0a || buf[i] === 0x0d)) i++
      return i < buf.length && buf[i] === 0x3c
    }
    // 素材文本:UTF-16 BOM 也要能扫(否则同一份恶意 SVG 换个编码就绕过嗅探)。
    const decodeAsset = (buf) => {
      if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le")
      if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff && buf.length % 2 === 0) {
        const swapped = Buffer.from(buf)
        swapped.swap16()
        return swapped.toString("utf16le")
      }
      return buf.toString("utf8")
    }
    const KNOWN_ASSET_KEYS = ["logo", "logo_dark", "favicon"]
    // 打包管线消费的两件素材的文件名（唯一真源 = channel-constants.ts 的 CHANNEL_ASSET_FILES，
    // 由外层 shell 读出来传进来；读不到时脚本已经在上游 fail-loud）。
    const LOGO_FILE_NAME = process.env.CHANNEL_LOGO_FILE
    const APP_ICON_FILE_NAME = process.env.CHANNEL_APP_ICON_FILE
    // 品牌渠道(official/beta 之外)的 logo 素材**必须声明**（2026-09-26 审计 Z3-3）：
    // `assets.logo` 是随包内联（channel-build.ts 的 inlineChannelAssets）与打包期派生
    // （brand-prepare.mjs 的托盘位图 / web-brand/favicon）共同的取值来源。不声明时
    // 随包里没有 `logo_inline` —— 服务端不可达或服务端还是旧版时，登录页/侧边栏只能
    // 回落**编译期内置的厂商花括号 mark**（2026-09-11 在客户线上实测过的形态）。
    // 公共渠道不要求：它们的品牌就是厂商自己的，回落官方是正当的。
    // 报错只报字段名，不回显取值（`assets.logo` 的取值是文件名，不含品牌，
    // 但一律守这条纪律）。
    const declaredLogo = str(cfg?.assets?.logo)
    if (!publicChannel && declaredLogo === undefined) missing.push("assets.logo")
    // 声明的名字与打包侧消费的文件名必须**一致**：托盘位图与随包 favicon 只按
    // LOGO_FILE_NAME 派生，声明别的名字会让同一个包装上两套品牌（登录页是声明的
    // 那个、托盘是另一个/官方几何）。这是把"两个解析口径"收成一个的判据。
    if (declaredLogo !== undefined && LOGO_FILE_NAME && declaredLogo !== LOGO_FILE_NAME) {
      invalid.push("assets.logo(必须是渠道目录里的 " + LOGO_FILE_NAME
        + "：托盘位图与随包 favicon 只按这个文件名派生，声明别的名字会让同一个包装上两套品牌)")
    }
    // 未知素材字段**只计数**（键名不回显，R8-D-14；理由见下面那条 warning）。
    let unknownAssetKeys = 0
    for (const [key, value] of Object.entries(cfg?.assets ?? {})) {
      if (key === "accent" || key.startsWith("_")) continue
      const name = str(value)
      if (name === undefined) continue
      if (!KNOWN_ASSET_KEYS.includes(key)) {
        unknownAssetKeys++
        continue
      }
      if (name.includes("/") || name.includes("\\")) { invalid.push("assets." + key + "(必须是单段文件名)"); continue }
      // 素材必须是渠道目录内的**普通文件**（2026-09-26 审计 W5-01）。
      // 为什么必须在这里拦:`stage_from` 用 `cp -a`、Dockerfile 用 `COPY` —— 两者
      // 都**保留**符号链接、不 dereference,于是一个指向容器内任意可读文件的链接会
      // 原样进镜像;而三个素材端点**未认证**（登录页在未登录时就要拿 logo）⇒ 那就是
      // 一条未认证的任意文件读取。所以用 lstat（不跟随链接）并要求 isFile():
      // 目录/符号链接/设备/FIFO 一律拒。服务端同判见 internal/channel 的 assetRegular。
      const assetStat = fs.lstatSync(path.join(dir, name), { throwIfNoEntry: false })
      if (assetStat === undefined || !assetStat.isFile()) {
        invalid.push("assets." + key + "(素材必须是渠道目录内的普通文件(符号链接一律拒绝),当前不存在或不是普通文件)")
        continue
      }
      // 素材的脚本特征检查:先嗅探内容(不看扩展名),.svg 扩展名照旧必查。
      // 内容不进日志:只报字段名与特征种类(元素/属性名)。
      const assetBuf = fs.readFileSync(path.join(dir, name))
      const utf16 = assetBuf.length >= 2
        && ((assetBuf[0] === 0xff && assetBuf[1] === 0xfe) || (assetBuf[0] === 0xfe && assetBuf[1] === 0xff))
      if (looksLikeMarkup(assetBuf) || utf16 || /\.svg$/i.test(name)) {
        const hits = scriptishSvg(decodeAsset(assetBuf))
        if (hits.length > 0) {
          invalid.push("assets." + key + "(素材是 SVG/XML 文档且含脚本特征:" + [...new Set(hits)].slice(0, 3).join("/")
            + " —— 素材会被原样下发给浏览器,顶层打开即可执行脚本,请用图形工具重新导出为纯图形 SVG)")
        }
      }
    }
    // mac 图标管线要求:1024×1024、RGBA16、带 ICC(见 generate-mac-app-icon.mjs)。
    // 与素材同一条规则(同一个理由,见上面 assets 循环):必须是**普通文件** ——
    // 旧的 `fs.existsSync` 跟随符号链接,链接会随 `cp -a`/`COPY` 进镜像。
    const iconPath = path.join(dir, APP_ICON_FILE_NAME || "app-icon.png")
    const iconStat = fs.lstatSync(iconPath, { throwIfNoEntry: false })
    // 品牌渠道**必须**带安装器图标（2026-09-26 审计 Z3-3）：缺它时 electron-builder
    // 用 buildResources 里上一轮/官方的那份 `app-icon.png` ⇒ 安装器、Dock、任务栏、
    // 窗口图标全是**厂商图标**，而交付物上没有任何信号（2026-09-10 事故形态：
    // "渠道包带着官方图标出厂"）。公共渠道（official/beta）不要求：品牌即厂商。
    if (iconStat === undefined && !publicChannel) missing.push(APP_ICON_FILE_NAME || "app-icon.png")
    if (iconStat !== undefined && !iconStat.isFile()) {
      invalid.push("app-icon.png(素材必须是渠道目录内的普通文件(符号链接一律拒绝),当前不是普通文件)")
    } else if (iconStat !== undefined) {
      const buf = fs.readFileSync(iconPath)
      const png = buf.length > 33 && buf.readUInt32BE(0) === 0x89504e47
      if (!png) invalid.push("app-icon.png(不是 PNG)")
      else {
        const width = buf.readUInt32BE(16)
        const height = buf.readUInt32BE(20)
        const bitDepth = buf[24]
        const colorType = buf[25]
        if (width !== 1024 || height !== 1024) invalid.push("app-icon.png(必须是 1024×1024,实际 " + width + "×" + height + ")")
        if (bitDepth !== 16 || colorType !== 6) invalid.push("app-icon.png(必须是 16 位 RGBA,实际 depth=" + bitDepth + " colorType=" + colorType + ")")
        // iCCP chunk:扫描 PNG 块目录(不引入 sharp 依赖)。
        let offset = 8
        let hasIcc = false
        while (offset + 8 <= buf.length) {
          const length = buf.readUInt32BE(offset)
          const type = buf.toString("ascii", offset + 4, offset + 8)
          if (type === "iCCP") { hasIcc = true; break }
          if (type === "IEND") break
          offset += 12 + length
        }
        if (!hasIcc) invalid.push("app-icon.png(必须内嵌 ICC 色彩配置)")
      }
    }
    if (unknownAssetKeys > 0) {
      // **只报数量,不回显键名**（2026-09-24 第八轮审计 R8-D-14）：键名本身就是渠道包里的
      // 字符串，可能是品牌/渠道标识（实测 `assets.<品牌>_logo` 原样进了公开日志；老写法
      // 只对"非字段名形状"的键做了脱敏，而品牌标识恰好是字段名形状）。拼错的字段名靠
      // "对比私有仓的 assets 键"排查，不靠公开日志。
      console.error("::warning::渠道包里有 " + unknownAssetKeys + " 个未知素材字段(已忽略,可能是拼写错误;键名不回显): assets.<unknown>")
    }
    if (templateMissing.length > 0) {
      // 跨仓顺序（2026-10-13 独立审计 P0）：`features.*` 这类"新加的模板键"会让**非 tag** 的
      // 三个打包 job 在每次 PR/push 上红，直到私有渠道仓补键为止 —— 而补键对**合并前**的
      // harness 完全无害（旧脚本里 features 零命中、未知顶层键不被拒）。所以这条报错要把
      // 补救动作与顺序直接讲出来：看到它的人多半正处在那个红窗里。
      console.error("::error::官方渠道配置缺少模板键: " + templateMissing.join(", ") + " —— 官方渠道是新增渠道的模板(拷贝 → 改身份字段 → 裁剪交付面);缺键意味着那几个键藏在代码兜底值里:复制出来的渠道会带着看不见的继承行为(少写 slug 就回落厂商包名、少写 home_dir 就共用数据根),而且要翻源码才知道有哪些键。请逐键补齐 —— 值取现行兜底值,因此显式化本身不改变任何行为。补齐动作落在私有渠道仓的 channels/official/channel.json,且**可以先行**(对合并前的 harness 无害):顺序是私有仓先补键、再合并引入这些键的 harness 改动,否则三个非 tag 的打包 job 会在每一步 PR/push 上红(契约与顺序见 docs/decisions/2026-10-13-channel-feature-modules.md §4)")
    }
    if (missing.length > 0 || invalid.length > 0 || templateMissing.length > 0) {
      if (missing.length > 0) {
        console.error("::error::渠道包缺少必需字段: " + missing.join(", ") + " —— 品牌字段缺失时客户端登录页/侧边栏在服务端不可达会回落中性占位/厂商名;desktop.app_origin_scheme 缺失时 WASM 应用的协议 origin 没有权威来源(服务端与客户端必须显式一致,派生缺省只允许存在于本地开发)。请补齐后重新发布")
      }
      if (invalid.length > 0) {
        console.error("::error::渠道包字段不合法: " + invalid.join(", "))
      }
      console.error("::error::这些字段错在客户机器上才发现就晚了,因此构建期硬拦(字段清单见 docs/planning/2026-09-10-channel-package-reference.md)")
      process.exit(1)
    }
  
