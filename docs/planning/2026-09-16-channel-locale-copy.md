# 渠道包（channel.json）要不要配多语言

**日期**：2026-09-16
**背景**：客户端 i18n 补齐过程中提出的问题——渠道（白标）内容目前是单语言，是否需要支持多语言？
**结论**：**需要，但只需覆盖「散文类」字段；品牌名不翻译。** 另建议补一个可选的默认界面语言。

---

## 1. 现状：渠道文案字段清单

`channel.json` 的品牌文案分两处：`identity.*` 与 `copy.*`（另有 `assets.*` 素材、`defaults.*` 默认值、`desktop.*` 打包参数）。

`packages/host/desktop/src/desktop-channel.ts` 的 `ChannelBrand` 定义了口径，实测四个渠道（official / beta / example-a / example-b）的取值：

| 字段 | example-a / beta 实测值 | 性质 | 需要多语言？ |
|---|---|---|---|
| `identity.display_name` | `Example-A Harness` | 品牌名 | ❌ 不译 |
| `identity.short_name` | `Example-A` | 品牌名 | ❌ 不译 |
| `identity.title` | `Example-A Harness` | 品牌名（页面标题） | ❌ 不译 |
| `copy.login_display_name` | `Example-A` | 品牌名 | ❌ 不译 |
| `copy.client_display_name` | `Example-A Harness` | 品牌名 | ❌ 不译 |
| `copy.login_tagline` | `企业级 AI 办公智能体平台` | **散文** | ✅ **要** |
| `copy.client_tagline` | （四个渠道都留空） | 散文 | ✅ 要（一旦启用） |
| `copy.login_welcome` | （留空） | 散文 | ✅ 要（一旦启用） |
| `copy.portal_welcome` | `欢迎使用 Example-A Harness。企业 AI 能力由管理员统一开通与配置。` | **散文** | ✅ **要** |

**判据**：品牌名是专有名词，跨语言保持同一串（`Example-A Harness` 在英文界面里也是 `Example-A Harness`）；而 tagline / welcome 是**句子**——中文界面的 `企业级 AI 办公智能体平台` 在英文界面下必须换成英文，否则英文用户第一屏看到中文标语。

今天 `official` 与 `beta` 都配了中文 tagline，而产品现在支持英文界面（`login_tagline` 渲染在登录页品牌区），所以**中文标语会直接出现在英文登录页上**——这是一个当前就存在的可见缺陷，不是假设。

---

## 2. 缺口：渠道没有任何语言相关配置

实测 `channel.json` **不存在** `locale` / `language` / `lang` 任何字段（`desktop-channel.ts` 与 `enterprise/channel-content.ts` 均无命中）。

因此两件事今天都做不到：

1. **散文按语言给不同版本** —— 只能给一句，两种界面语言共用。
2. **渠道指定默认界面语言** —— 界面语言当前只来自「用户存过的偏好」→「操作系统/应用语言」（见 `electronLanguages` 修复后的解析链）。若某渠道的客户希望**在英文系统上默认中文界面**（或反之），没有配置位。

第 2 点对白标交付尤其重要：企业客户的员工机器语言分布不受客户控制，而客户往往希望首屏语言与公司内部约定一致。

---

## 3. 建议的 schema（加法式，向后兼容）

### 3.1 散文字段接受「字符串或按语言的映射」

现有字符串形态继续有效（视为语言无关，两种界面都用它），新增映射形态：

```json
"copy": {
  "login_display_name": "Example-A",
  "login_tagline": {
    "zh": "企业级 AI 办公智能体平台",
    "en": "An enterprise AI workspace platform"
  },
  "portal_welcome": {
    "zh": "欢迎使用 Example-A Harness。企业 AI 能力由管理员统一开通与配置。",
    "en": "Welcome to Example-A Harness. Your administrator enables and configures enterprise AI capabilities."
  }
}
```

解析规则（单一实现，放在 `channel-content.ts`，与现有 `nonEmpty` / `mergeChannel` 同一处）：

1. 值若是字符串 → 直接用（现状不变，老渠道包零改动）；
2. 值若是对象 → 取当前语言；缺失时回落到 `zh`（产品默认语言），再缺则回落空串（= 渠道没配这一项，消费方按既有规则处理）。

**只允许 `zh` / `en` 两个键**（其余忽略），与 `LOCALE_IDS` 对齐；非法形状按「没配」处理，不抛错。

### 3.2 新增可选 `defaults.locale`

```json
"defaults": {
  "server_url": "https://harness-a.example.com",
  "telemetry_channel": "example-a",
  "locale": "zh"
}
```

语义：**仅在该用户从未选择过界面语言时**作为初始值（不覆盖用户已存的偏好，也不在用户切换后回写）。取值限 `zh` / `en`。

**不做**的事：不劫持系统语言检测——它只是「未选择时」的默认，用户改过之后以用户为准。

---

## 4. 影响面（实施时要一起改的地方）

| 位置 | 改动 |
|---|---|
| `packages/host/desktop/src/desktop-channel.ts` | `copy.*` 字段类型放宽为 `string \| Partial<Record<HostLocale, string>>`；建议用 `HostLocale`（`dsh-plugin-desktop/host-locale`），避免再定义一套语言 id |
| `packages/host/enterprise/src/channel-content.ts` | 解析/回落规则的**唯一实现**（连同 `nonEmpty`、`mergeChannel`）；服务端下发与随包内容两条路都要走它 |
| `packages/host/desktop/scripts/brand-prepare.mjs`（`stageChannelProfile`） | 随包 `build/channel.json` 的写出形状同步 |
| `scripts/ci-channels.sh` | 校验：语言键只允许 `zh`/`en`；`defaults.locale` 取值合法；映射形态不得为空对象 |
| `server/internal/channel/channel.go` | `Response` 的 `copy.*` 形状（服务端下发给客户端的那份）；`channel_test.go` 覆盖 |
| `packages/host/desktop/tests/desktop-channel.spec.ts`、`packages/host/enterprise/tests/channel-content.spec.ts` | 三种形态（字符串 / 映射 / 缺失）+ 回落 + 非法形状 |

**注意**：`packages/host/enterprise/src/channel-content.ts` 是渠道内容的唯一映射实现（记忆条目：`brandChannel()` / `nonEmpty` 各只允许一份）。多语言解析必须加在那里，不要在下游各消费点各判一次。

---

## 5. 明确不做 / 需要注意

- **品牌名不翻译**：`display_name` / `short_name` / `title` / `login_display_name` / `client_display_name` 保持单值。给它们加语言映射只会让同一家公司出现两个名字。
- **`portal_welcome` 目前消费在服务端门户页**（`server/internal/portal`，Go），而门户页整页是中文、且**本轮明确不在翻译范围内**。所以：schema 现在就该容纳它的映射形态（否则以后再改一次渠道包格式），但**门户真正按语言渲染要等门户 i18n 立项**。
- **素材不涉及语言**：`assets.logo` / `logo_dark` / `favicon` / `accent` 无语言维度；渠道 logo 的几何规则不变（见 `brands/official/logo.svg` 单一真源）。
- **`identity.tagline`**（非 `copy.login_tagline`）在 `desktop-channel.ts` 里作为 `copy.login_tagline` 的回落来源，一并按散文处理。

---

## 6. 建议动作

1. **现在（低成本、修可见缺陷）**：把 `copy.login_tagline` 改成映射形态并给 official / beta 补英文——**今天英文登录页显示中文标语**，这是已存在的缺陷。渠道仓（私有 `picoaide/channels`）同步。
2. **随后**：`defaults.locale` + CI 校验 + 两侧解析实现 + 回归用例。
3. **门户 i18n 立项时**：再接通 `portal_welcome` 的语言选择（服务端需 `Accept-Language` 或渠道默认语言）。

---

## 附：核查方式（可复跑）

```bash
# 渠道文案字段与取值
python3 -c "
import json,glob
for f in sorted(glob.glob('temp/channels-clone/channels/*/channel.json')):
    d=json.load(open(f)); print(f.split('/')[-2], json.dumps(d.get('copy',{}), ensure_ascii=False))
"
# 是否存在语言字段（应为空）
grep -rn 'locale\|language\|lang' packages/host/desktop/src/desktop-channel.ts \
  packages/host/enterprise/src/channel-content.ts
```
