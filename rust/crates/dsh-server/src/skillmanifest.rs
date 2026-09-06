//! Skill manifest 解析与严格校验（Go `server/internal/skillmanifest` 等价移植）。
//!
//! 决策 2026-09-01「包内即真相」：发布接口不接受元数据参数，名称/版本/标题/
//! 描述/作者/分类一律从包内 SKILL.md frontmatter 解析，任何一项不合规即拒绝。
//! 为什么必须严格：上游 @deepseek-ai/dsh-skill-filesystem 以 frontmatter 的
//! `name` 作为技能的运行时唯一身份且强制 kebab-case，不合规的 SKILL.md 会被
//! 运行时静默忽略。本模块每条规则都对应上游的一条硬约束。

use serde_yaml::{Mapping, Value};

// ---------------------------------------------------------------------------
// 稳定错误码：直接进错误信封（Go serverauth.WriteError 的 envelope 等价）。
// ---------------------------------------------------------------------------

pub const CODE_MISSING_FIELD: &str = "MISSING_FIELD";
pub const CODE_INVALID_APP_ID: &str = "INVALID_APP_ID";
pub const CODE_INVALID_VERSION: &str = "INVALID_VERSION";
pub const CODE_FIELD_TOO_LONG: &str = "FIELD_TOO_LONG";
pub const CODE_FIELD_TOO_SHORT: &str = "FIELD_TOO_SHORT";
pub const CODE_INVALID_TYPE: &str = "INVALID_TYPE";
pub const CODE_IDENTITY_MISMATCH: &str = "IDENTITY_MISMATCH";
pub const CODE_BOM_DETECTED: &str = "BOM_DETECTED";
pub const CODE_FRONTMATTER_INVALID: &str = "FRONTMATTER_INVALID";
pub const CODE_BODY_EMPTY: &str = "BODY_EMPTY";
pub const CODE_INVOCATION_INVALID: &str = "INVOCATION_INVALID";
pub const CODE_PROVENANCE_FORBIDDEN: &str = "PROVENANCE_FORBIDDEN";
pub const CODE_MANIFEST_MISMATCH: &str = "MANIFEST_MISMATCH";

// ---------------------------------------------------------------------------
// 字段长度与数量上限（决策文档 5.1/5.2）。
// ---------------------------------------------------------------------------

pub const MIN_APP_ID_LEN: usize = 2;
pub const MAX_APP_ID_LEN: usize = 64;
pub const MAX_TITLE_RUNES: usize = 100;
pub const MIN_DESCRIPTION_RUNES: usize = 10;
/// description 是模型侧的触发文本（上游对其长度无限制），上限仅防滥用。
pub const MAX_DESCRIPTION_RUNES: usize = 2000;
pub const MAX_AUTHOR_RUNES: usize = 64;
pub const MAX_CATEGORY_RUNES: usize = 32;
pub const MAX_CHANGELOG_RUNES: usize = 500;
pub const MAX_TAGS: usize = 30;
pub const MAX_TAG_RUNES: usize = 32;
pub const MIN_BODY_RUNES: usize = 50;

/// 安装器写入的溯源块键名；包内自带即视为伪造归属。
pub const PROVENANCE_KEY: &str = "picoaide";
/// 安装器写入的溯源目录（归档内出现即拒）。
pub const PROVENANCE_DIR: &str = ".picoaide/";
/// 智能体预设的展示元数据文件（上游约定，与功能文件 agent.cordis.yml 分离）。
pub const PRESET_META_FILE: &str = "preset.yml";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/// Manifest 是发布链路的唯一元数据来源（Go `Manifest` 等价）。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Manifest {
    pub app_id: String,
    pub title: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub category: String,
    pub changelog: String,
    pub tags: Vec<String>,
}

/// ManifestError 校验失败：稳定错误码 + 出错字段 + 面向用户的中文报文。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestError {
    pub code: String,
    pub field: Option<String>,
    pub message: String,
}

impl ManifestError {
    pub fn new(code: impl Into<String>, field: Option<impl Into<String>>, message: impl Into<String>) -> Self {
        ManifestError {
            code: code.into(),
            field: field.map(Into::into),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ManifestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.field {
            Some(field) => write!(f, "{}[{}]: {}", self.code, field, self.message),
            None => write!(f, "{}: {}", self.code, self.message),
        }
    }
}

impl std::error::Error for ManifestError {}

fn new_err(code: &str, field: &str, message: String) -> ManifestError {
    ManifestError::new(code, if field.is_empty() { None } else { Some(field) }, message)
}

// ---------------------------------------------------------------------------
// 状态码映射与基础谓词
// ---------------------------------------------------------------------------

/// status_for 把校验错误码映射为 HTTP 状态。全部包内校验失败都是 422
/// （语义正确但内容不合规）；冲突类（版本已存在等）由调用方按 409 处理。
pub fn status_for(code: &str) -> u16 {
    match code {
        CODE_MISSING_FIELD | CODE_INVALID_APP_ID | CODE_INVALID_VERSION | CODE_FIELD_TOO_LONG
        | CODE_FIELD_TOO_SHORT | CODE_INVALID_TYPE | CODE_IDENTITY_MISMATCH | CODE_BOM_DETECTED
        | CODE_FRONTMATTER_INVALID | CODE_BODY_EMPTY | CODE_INVOCATION_INVALID
        | CODE_PROVENANCE_FORBIDDEN | CODE_MANIFEST_MISMATCH => 422,
        _ => 422,
    }
}

/// is_app_id 报告 s 是否为合法 app id（= 上游 skill name 文法）。
/// 上游正则 `^[a-z0-9]+(?:-[a-z0-9]+)*$`：不允许大写、点、下划线、连续横线与首尾横线。
pub fn is_app_id(s: &str) -> bool {
    if s.len() < MIN_APP_ID_LEN || s.len() > MAX_APP_ID_LEN {
        return false;
    }
    if !s.is_ascii() {
        return false;
    }
    let b = s.as_bytes();
    if b.first() == Some(&b'-') || b.last() == Some(&b'-') {
        return false;
    }
    let mut prev_dash = false;
    for &c in b {
        match c {
            b'a'..=b'z' | b'0'..=b'9' => prev_dash = false,
            b'-' => {
                if prev_dash {
                    return false;
                }
                prev_dash = true;
            }
            _ => return false,
        }
    }
    true
}

/// is_version 报告 s 是否为严格 semver（可带预发布后缀）。
/// 正则 `^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$`。
pub fn is_version(s: &str) -> bool {
    let (core, pre) = match s.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (s, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3 {
        return false;
    }
    for p in &parts {
        if p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
    }
    if let Some(pre) = pre {
        if pre.is_empty() || !pre.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.') {
            return false;
        }
    }
    true
}

/// compare_versions 数值比较两个 semver：a<b 为负，相等为 0，a>b 为正。
/// 预发布版排在同号正式版之前（1.2.0-rc.1 < 1.2.0），供「版本必须递增」校验使用。
///
/// 注意：这里是 Go CompareVersions 的逐行等价（含长度优先、永不溢出的数字
/// 标识符比较），**不是** `picoaide_dsh_util::compare_semver`——后者以 i64 解析
/// 数字标识符，超长数字会被吞成 0，与 Go 测试断言不一致。
pub fn compare_versions(a: &str, b: &str) -> i32 {
    use std::cmp::Ordering;
    let (a_core, a_pre) = match a.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (a, None),
    };
    let (b_core, b_pre) = match b.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (b, None),
    };
    let a_parts: Vec<&str> = a_core.split('.').collect();
    let b_parts: Vec<&str> = b_core.split('.').collect();
    for i in 0..3 {
        let av = a_parts.get(i).and_then(|p| p.parse::<i64>().ok()).unwrap_or(0);
        let bv = b_parts.get(i).and_then(|p| p.parse::<i64>().ok()).unwrap_or(0);
        if av != bv {
            return match av.cmp(&bv) {
                Ordering::Less => -1,
                Ordering::Greater => 1,
                Ordering::Equal => 0,
            };
        }
    }
    match (a_pre, b_pre) {
        (None, None) => 0,
        (None, Some(_)) => 1,  // 正式版 > 预发布版
        (Some(_), None) => -1,
        (Some(x), Some(y)) => compare_prerelease(x, y),
    }
}

/// compare_prerelease 实现 SemVer §11 预发布优先级：点分段逐段比较，数字段按
/// 数值比较且排在字母段之下；共享标识符全等时，标识符列表更长者更大。
fn compare_prerelease(a: &str, b: &str) -> i32 {
    use std::cmp::Ordering;
    let ap: Vec<&str> = a.split('.').collect();
    let bp: Vec<&str> = b.split('.').collect();
    let n = ap.len().max(bp.len());
    for i in 0..n {
        let x = match ap.get(i) {
            Some(x) => x,
            None => return -1, // b 还有标识符 → b 更大
        };
        let y = match bp.get(i) {
            Some(y) => y,
            None => return 1,
        };
        let x_num = is_numeric_string(x);
        let y_num = is_numeric_string(y);
        match (x_num, y_num) {
            (true, true) => {
                let c = compare_numeric_strings(x, y);
                if c != 0 {
                    return c;
                }
            }
            (true, false) => return -1, // 数字标识符 < 字母数字标识符
            (false, true) => return 1,
            (false, false) => match x.cmp(y) {
                Ordering::Less => return -1,
                Ordering::Greater => return 1,
                Ordering::Equal => {}
            },
        }
    }
    0
}

/// is_numeric_string 报告 s 是否仅由 ASCII 数字组成（非空）。
fn is_numeric_string(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// compare_numeric_strings 不解析即比较两个数字串（长度优先，避免超长数字溢出；
/// 等长时字节序即数值序）。
fn compare_numeric_strings(a: &str, b: &str) -> i32 {
    use std::cmp::Ordering;
    match a.len().cmp(&b.len()) {
        Ordering::Less => -1,
        Ordering::Greater => 1,
        Ordering::Equal => match a.cmp(b) {
            Ordering::Less => -1,
            Ordering::Greater => 1,
            Ordering::Equal => 0,
        },
    }
}

// ---------------------------------------------------------------------------
// Parse：SKILL.md 校验
// ---------------------------------------------------------------------------

/// parse 校验一个技能包并返回其 manifest。
///
/// `entries` 是归档内的规范化条目路径（Go archiveutil.ListContents 第一个
/// 返回值等价）；`skill_md` 是顶层 SKILL.md 的原始内容（**不要预先剥 BOM**，
/// BOM 检测依赖它）；`declared_app_id` 为空表示以包内 name 为准，非空时要求与
/// 包内 name 完全一致。校验顺序遵循决策文档 5.5（先便宜后昂贵），只返回第一条
/// 错误，便于客户端预检与服务端给出同一个错误码。
pub fn parse<S: AsRef<str>>(
    entries: &[S],
    skill_md: &str,
    declared_app_id: &str,
) -> Result<Manifest, ManifestError> {
    // BOM 与 frontmatter。
    if skill_md.starts_with('\u{feff}') {
        return Err(new_err(
            CODE_BOM_DETECTED,
            "",
            "SKILL.md 含 UTF-8 BOM,会导致技能被运行时忽略;请另存为「UTF-8 无 BOM」".to_string(),
        ));
    }
    if skill_md.trim().is_empty() {
        return Err(new_err(
            CODE_FRONTMATTER_INVALID,
            "",
            "无法读取 SKILL.md(文件为空或超出预览上限)".to_string(),
        ));
    }
    let (front, body) = split_frontmatter(skill_md)?;
    let data = parse_yaml_mapping(
        &front,
        "SKILL.md 的 frontmatter 不是合法 YAML 映射",
    )?;

    // 必填字段与格式。
    let mut m = Manifest::default();
    m.app_id = required_string(&data, "name", MAX_APP_ID_LEN)?;
    if !is_app_id(&m.app_id) {
        return Err(new_err(
            CODE_INVALID_APP_ID,
            "name",
            format!(
                "技能名 {:?} 不合法:必须是小写 kebab-case(如 my-skill),不允许大写、点、下划线、连续或首尾横线",
                m.app_id
            ),
        ));
    }
    m.version = required_version(&data)?;
    m.title = required_string(&data, "title", MAX_TITLE_RUNES)?;
    m.description = required_string(&data, "description", MAX_DESCRIPTION_RUNES)?;
    if m.description.chars().count() < MIN_DESCRIPTION_RUNES {
        return Err(new_err(
            CODE_FIELD_TOO_SHORT,
            "description",
            format!(
                "description 过短(至少 {} 字),它决定模型何时加载本技能",
                MIN_DESCRIPTION_RUNES
            ),
        ));
    }
    m.author = required_string(&data, "author", MAX_AUTHOR_RUNES)?;
    m.category = required_string(&data, "category", MAX_CATEGORY_RUNES)?;
    m.changelog = optional_string(&data, "changelog", MAX_CHANGELOG_RUNES)?;
    m.tags = optional_tags(&data)?;
    if body.trim().chars().count() < MIN_BODY_RUNES {
        return Err(new_err(
            CODE_BODY_EMPTY,
            "",
            format!(
                "技能正文过短(至少 {} 字):只有 frontmatter 的空壳技能对模型没有价值",
                MIN_BODY_RUNES
            ),
        ));
    }
    check_invocation(&data)?;

    // 身份一致性。
    if !declared_app_id.is_empty() && declared_app_id != m.app_id {
        return Err(new_err(
            CODE_IDENTITY_MISMATCH,
            "name",
            format!(
                "SKILL.md 的 name({:?})必须等于应用 ID({:?});中文展示名请写在 title 字段",
                m.app_id, declared_app_id
            ),
        ));
    }

    // 溯源禁止项（安装器专用，包内自带即可伪造归属）。
    check_provenance(entries, &data)?;
    Ok(m)
}

/// split_frontmatter 镜像上游解析器：frontmatter 必须在首个字节以 `---` 打开、
/// 在第一个 `\n---` 关闭。CRLF 归一后再匹配（上游同样支持 CRLF）。
fn split_frontmatter(raw: &str) -> Result<(String, String), ManifestError> {
    let s = raw.replace("\r\n", "\n");
    if !s.starts_with("---\n") {
        return Err(new_err(
            CODE_FRONTMATTER_INVALID,
            "",
            "SKILL.md 缺少 YAML frontmatter:文件必须以 --- 开头".to_string(),
        ));
    }
    let rest = &s[4..];
    match rest.find("\n---") {
        Some(idx) => Ok((rest[..idx].to_string(), rest[idx + 4..].to_string())),
        None => Err(new_err(
            CODE_FRONTMATTER_INVALID,
            "",
            "SKILL.md 的 frontmatter 没有结束分隔符 ---".to_string(),
        )),
    }
}

/// parse_yaml_mapping 把 frontmatter 文本解析为 YAML 映射；非映射或解析失败
/// 一律 FRONTMATTER_INVALID（Go: yaml.Unmarshal 错误或 data==nil）。
fn parse_yaml_mapping(front: &str, bad_message: &str) -> Result<Mapping, ManifestError> {
    match serde_yaml::from_str::<Value>(front) {
        Ok(Value::Mapping(m)) => Ok(m),
        _ => Err(new_err(CODE_FRONTMATTER_INVALID, "", bad_message.to_string())),
    }
}

/// scalar_string 把 YAML 标量渲染为文本。数字/布尔标量一律转字符串，使
/// `version: 1.0` 这类写法落到 INVALID_VERSION 的精确报错上，而非含糊的类型错误。
fn scalar_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Some(i.to_string())
            } else if let Some(u) = n.as_u64() {
                Some(u.to_string())
            } else if let Some(f) = n.as_f64() {
                // f64 Display 与 Go fmt.Sprint 对常见值一致（1.0→"1"，2.5→"2.5"）。
                Some(format!("{}", f))
            } else {
                None
            }
        }
        _ => None,
    }
}

/// get_field 从映射取字段值（键为字符串）。
fn get_field<'a>(data: &'a Mapping, field: &str) -> Option<&'a Value> {
    data.get(Value::String(field.to_string()))
}

fn required_string(
    data: &Mapping,
    field: &str,
    max_runes: usize,
) -> Result<String, ManifestError> {
    let raw = match get_field(data, field) {
        Some(v) if !matches!(v, Value::Null) => v,
        _ => {
            return Err(new_err(
                CODE_MISSING_FIELD,
                field,
                format!("缺少必填字段 {},请在 SKILL.md 的 frontmatter 中补充", field),
            ));
        }
    };
    let s = scalar_string(raw).ok_or_else(|| {
        new_err(
            CODE_INVALID_TYPE,
            field,
            format!("字段 {} 必须是单值字符串(不能是列表或映射)", field),
        )
    })?;
    let s = s.trim().to_string();
    if s.is_empty() {
        return Err(new_err(
            CODE_MISSING_FIELD,
            field,
            format!("必填字段 {} 不能为空", field),
        ));
    }
    if s.chars().count() > max_runes {
        return Err(new_err(
            CODE_FIELD_TOO_LONG,
            field,
            format!("字段 {} 超长(上限 {} 字)", field, max_runes),
        ));
    }
    Ok(s)
}

fn optional_string(data: &Mapping, field: &str, max_runes: usize) -> Result<String, ManifestError> {
    let raw = match get_field(data, field) {
        Some(v) if !matches!(v, Value::Null) => v,
        _ => return Ok(String::new()),
    };
    let s = scalar_string(raw).ok_or_else(|| {
        new_err(
            CODE_INVALID_TYPE,
            field,
            format!("字段 {} 必须是单值字符串", field),
        )
    })?;
    let s = s.trim().to_string();
    if s.chars().count() > max_runes {
        return Err(new_err(
            CODE_FIELD_TOO_LONG,
            field,
            format!("字段 {} 超长(上限 {} 字)", field, max_runes),
        ));
    }
    Ok(s)
}

fn required_version(data: &Mapping) -> Result<String, ManifestError> {
    let raw = match get_field(data, "version") {
        Some(v) if !matches!(v, Value::Null) => v,
        _ => {
            return Err(new_err(
                CODE_MISSING_FIELD,
                "version",
                "缺少必填字段 version,请在 SKILL.md 中写明版本号(如 1.0.0)".to_string(),
            ));
        }
    };
    let s = scalar_string(raw).ok_or_else(|| {
        new_err(
            CODE_INVALID_VERSION,
            "version",
            "version 必须是形如 1.2.0 的版本号".to_string(),
        )
    })?;
    let s = s.trim().to_string();
    if !is_version(&s) {
        return Err(new_err(
            CODE_INVALID_VERSION,
            "version",
            format!(
                "version {:?} 不是合法版本号:必须是 x.y.z(可带 -rc.1 预发布后缀);若写成 1.0 请补足三段并加引号",
                s
            ),
        ));
    }
    Ok(s)
}

/// optional_tags 解析可选 tags 数组；缺省返回空数组。空字符串标签被跳过。
fn optional_tags(data: &Mapping) -> Result<Vec<String>, ManifestError> {
    let raw = match get_field(data, "tags") {
        Some(v) if !matches!(v, Value::Null) => v,
        _ => return Ok(Vec::new()),
    };
    let list = match raw {
        Value::Sequence(s) => s,
        _ => {
            return Err(new_err(
                CODE_INVALID_TYPE,
                "tags",
                "字段 tags 必须是数组".to_string(),
            ));
        }
    };
    if list.len() > MAX_TAGS {
        return Err(new_err(
            CODE_FIELD_TOO_LONG,
            "tags",
            format!("标签过多(上限 {} 个)", MAX_TAGS),
        ));
    }
    let mut out = Vec::with_capacity(list.len());
    for item in list {
        let s = scalar_string(item).ok_or_else(|| {
            new_err(CODE_INVALID_TYPE, "tags", "标签必须是字符串".to_string())
        })?;
        let s = s.trim().to_string();
        if s.is_empty() {
            continue;
        }
        if s.chars().count() > MAX_TAG_RUNES {
            return Err(new_err(
                CODE_FIELD_TOO_LONG,
                "tags",
                format!("标签 {:?} 超长(上限 {} 字)", s, MAX_TAG_RUNES),
            ));
        }
        out.push(s);
    }
    Ok(out)
}

/// check_invocation 拒绝上游 parseInvocationPolicy 会抛错的内容：旧 camelCase
/// 键与非布尔值都会让上游忽略整个技能。
fn check_invocation(data: &Mapping) -> Result<(), ManifestError> {
    let legacy_keys = [
        ("disableModelInvocation", "disable-model-invocation"),
        ("modelInvocable", "disable-model-invocation"),
        ("userInvocable", "user-invocable"),
    ];
    for (legacy, canonical) in legacy_keys {
        if get_field(data, legacy).is_some() {
            return Err(new_err(
                CODE_INVOCATION_INVALID,
                legacy,
                format!(
                    "frontmatter 字段 {} 已废弃,请改用 {}(保留旧键会让技能被运行时忽略)",
                    legacy, canonical
                ),
            ));
        }
    }
    for key in ["disable-model-invocation", "user-invocable"] {
        let raw = match get_field(data, key) {
            Some(v) if !matches!(v, Value::Null) => v,
            _ => continue,
        };
        if matches!(raw, Value::Bool(_)) {
            continue;
        }
        let ok = scalar_string(raw)
            .map(|s| is_boolean_literal(&s.trim().to_ascii_lowercase()))
            .unwrap_or(false);
        if !ok {
            return Err(new_err(
                CODE_INVOCATION_INVALID,
                key,
                format!("字段 {} 必须是布尔值(true/false)", key),
            ));
        }
    }
    Ok(())
}

/// 上游 frontmatterBoolean 接受的布尔字面量（其余一律抛错 → 技能被忽略）。
fn is_boolean_literal(s: &str) -> bool {
    matches!(s, "true" | "yes" | "on" | "false" | "no" | "off" | "1" | "0")
}

/// check_provenance 拒绝携带安装器专属溯源标记的包。溯源块决定客户端如何判定
/// 「这份技能来自市场哪个应用」，允许作者自带就等于允许伪造归属。
fn check_provenance<S: AsRef<str>>(entries: &[S], data: &Mapping) -> Result<(), ManifestError> {
    for e in entries {
        if e.as_ref().starts_with(PROVENANCE_DIR) {
            return Err(new_err(
                CODE_PROVENANCE_FORBIDDEN,
                "",
                format!(
                    "归档不得包含 {} 目录:它由安装器写入,用于标记技能来源",
                    PROVENANCE_DIR
                ),
            ));
        }
    }
    if let Some(Value::Mapping(meta)) = get_field(data, "metadata") {
        if meta.contains_key(Value::String(PROVENANCE_KEY.to_string())) {
            return Err(new_err(
                CODE_PROVENANCE_FORBIDDEN,
                &format!("metadata.{}", PROVENANCE_KEY),
                format!(
                    "frontmatter 不得包含 metadata.{}:它由安装器写入,用于标记技能来源",
                    PROVENANCE_KEY
                ),
            ));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// ParseAgent：智能体 preset.yml 校验
// ---------------------------------------------------------------------------

/// parse_agent 校验一个智能体预设包并返回其 manifest。
///
/// 与技能的两点关键差异（遵循上游约定，不强行套用技能语义）：
/// 1. 智能体的运行时身份是目录名而非包内字段（没有「name 非 kebab 就整个被
///    忽略」的失效模式），因此不要求包内声明 ID；
/// 2. 上游 preset.yml 的 `name` 就是展示名（客户端读作 displayName），所以
///    展示名取 `title`、缺省回退 `name`，不能反过来把它当 ID 校验。
pub fn parse_agent<S: AsRef<str>>(
    entries: &[S],
    preset_yaml: &str,
    app_id: &str,
) -> Result<Manifest, ManifestError> {
    if preset_yaml.starts_with('\u{feff}') {
        return Err(new_err(
            CODE_BOM_DETECTED,
            "",
            format!("{} 含 UTF-8 BOM,请另存为「UTF-8 无 BOM」", PRESET_META_FILE),
        ));
    }
    if preset_yaml.trim().is_empty() {
        return Err(new_err(
            CODE_MISSING_FIELD,
            PRESET_META_FILE,
            format!(
                "归档缺少 {}:展示名/版本/描述/作者/分类必须写在包内",
                PRESET_META_FILE
            ),
        ));
    }
    let data = parse_yaml_mapping(
        preset_yaml,
        &format!("{} 不是合法的 YAML 映射", PRESET_META_FILE),
    )?;

    let mut m = Manifest {
        app_id: app_id.to_string(),
        ..Manifest::default()
    };
    // 展示名：title 优先，回退上游约定的 name。
    let title = optional_string(&data, "title", MAX_TITLE_RUNES)?;
    if !title.is_empty() {
        m.title = title;
    } else {
        m.title = required_string(&data, "name", MAX_TITLE_RUNES).map_err(|_| {
            new_err(
                CODE_MISSING_FIELD,
                "name",
                format!("缺少展示名:请在 {} 中填写 name(或 title)", PRESET_META_FILE),
            )
        })?;
    }
    m.version = required_version(&data)?;
    m.description = required_string(&data, "description", MAX_DESCRIPTION_RUNES)?;
    if m.description.chars().count() < MIN_DESCRIPTION_RUNES {
        return Err(new_err(
            CODE_FIELD_TOO_SHORT,
            "description",
            format!(
                "description 过短(至少 {} 字)",
                MIN_DESCRIPTION_RUNES
            ),
        ));
    }
    m.author = required_string(&data, "author", MAX_AUTHOR_RUNES)?;
    m.category = required_string(&data, "category", MAX_CATEGORY_RUNES)?;
    m.changelog = optional_string(&data, "changelog", MAX_CHANGELOG_RUNES)?;
    m.tags = optional_tags(&data)?;
    check_provenance(entries, &data)?;
    Ok(m)
}

// ---------------------------------------------------------------------------
// NormalizeSkillMD：规范化存量包
// ---------------------------------------------------------------------------

/// NormalizeOptions 提供规范化时的兜底值（全部来自 DB 行，不凭空编造）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NormalizeOptions {
    /// AppID 是权威应用 ID（= 技能目录名/DB name），frontmatter name 必须等于它。
    pub app_id: String,
    /// Version 兜底版本号：包内缺 version 时使用（通常传 DB 行的版本）。
    pub version: String,
    /// Author 兜底作者：包内缺 author 时使用（通常传 DB 行的作者）。
    pub author: String,
    /// Category 兜底分类：包内缺 category 时使用。
    pub category: String,
}

/// 规范化时保持原样透传的常见字段顺序（其余字段按字母序追加，输出稳定）。
const NORMALIZED_FIELD_ORDER: [&str; 8] = [
    "name", "title", "version", "description", "author", "category", "tags", "changelog",
];

/// normalize_skill_md 重写一份 SKILL.md 使其满足严格发布契约，并报告改动了什么。
///
/// 决策 2026-09-01 §八：存量包不改历史版本，而是由本函数产出规范化内容再作为
/// **新版本**发布。规范化只做「搬运与补齐」，绝不编造语义内容：
/// - 剥 UTF-8 BOM（否则上游解析不了 frontmatter）；
/// - frontmatter `name` 非法或与 AppID 不符时：原值移入 `title`（若 title 为
///   空），`name` 置为 AppID；
/// - `version`/`author`/`category` 缺失时用调用方给的 DB 兜底值；
/// - `description` 缺失或过短时报错：它决定模型何时加载技能，必须由人写。
pub fn normalize_skill_md(
    raw: &str,
    opts: &NormalizeOptions,
) -> Result<(String, Vec<String>), ManifestError> {
    let mut changes: Vec<String> = Vec::new();
    let mut s = raw.replace("\r\n", "\n");
    if s.starts_with('\u{feff}') {
        s = s.trim_start_matches('\u{feff}').to_string();
        changes.push("剥离 UTF-8 BOM".to_string());
    }
    if !is_app_id(&opts.app_id) {
        return Err(new_err(
            CODE_INVALID_APP_ID,
            "name",
            format!(
                "应用 ID {:?} 不是合法 kebab-case,无法规范化",
                opts.app_id
            ),
        ));
    }

    let mut data = Mapping::new();
    let mut body: String = s.clone();
    if s.starts_with("---\n") {
        let rest = &s[4..];
        match rest.find("\n---") {
            Some(idx) => {
                let front = &rest[..idx];
                body = rest[idx + 4..].trim_start_matches('\n').to_string();
                match serde_yaml::from_str::<Value>(front) {
                    Ok(Value::Mapping(m)) => data = m,
                    _ => {
                        return Err(new_err(
                            CODE_FRONTMATTER_INVALID,
                            "",
                            "frontmatter 不是合法 YAML,无法自动规范化".to_string(),
                        ));
                    }
                }
            }
            None => {
                return Err(new_err(
                    CODE_FRONTMATTER_INVALID,
                    "",
                    "frontmatter 缺少结束分隔符,无法自动规范化".to_string(),
                ));
            }
        }
    } else {
        changes.push("补全缺失的 frontmatter".to_string());
    }

    // name → AppID；原值（通常是中文展示名）移入 title。
    let old_name = scalar_string(get_field(&data, "name").unwrap_or(&Value::Null))
        .unwrap_or_default()
        .trim()
        .to_string();
    if old_name != opts.app_id {
        let title = scalar_string(get_field(&data, "title").unwrap_or(&Value::Null))
            .unwrap_or_default()
            .trim()
            .to_string();
        if title.is_empty() && !old_name.is_empty() {
            data.insert(Value::String("title".to_string()), Value::String(old_name.clone()));
            changes.push(format!("展示名 {:?} 迁移到 title", old_name));
        }
        data.insert(
            Value::String("name".to_string()),
            Value::String(opts.app_id.clone()),
        );
        changes.push(format!("name 规范化为 {:?}", opts.app_id));
    }
    let title = scalar_string(get_field(&data, "title").unwrap_or(&Value::Null))
        .unwrap_or_default()
        .trim()
        .to_string();
    if title.is_empty() {
        data.insert(
            Value::String("title".to_string()),
            Value::String(opts.app_id.clone()),
        );
        changes.push("title 缺失,回退为应用 ID".to_string());
    }

    // version：包内优先，其次调用方兜底；都没有则无法规范化。
    let version = scalar_string(get_field(&data, "version").unwrap_or(&Value::Null))
        .unwrap_or_default()
        .trim()
        .to_string();
    if !is_version(&version) {
        let fallback = opts.version.trim().to_string();
        if !is_version(&fallback) {
            return Err(new_err(
                CODE_INVALID_VERSION,
                "version",
                "包内无合法 version 且未提供兜底版本,无法规范化".to_string(),
            ));
        }
        data.insert(
            Value::String("version".to_string()),
            Value::String(fallback.clone()),
        );
        changes.push(format!("version 补为 {}", fallback));
    }

    // description 必须由人撰写：缺失/过短一律报错，不编造。
    let desc = scalar_string(get_field(&data, "description").unwrap_or(&Value::Null))
        .unwrap_or_default()
        .trim()
        .to_string();
    if desc.chars().count() < MIN_DESCRIPTION_RUNES {
        return Err(new_err(
            CODE_FIELD_TOO_SHORT,
            "description",
            format!(
                "description 缺失或过短(至少 {} 字),它决定模型何时加载技能,需人工补写",
                MIN_DESCRIPTION_RUNES
            ),
        ));
    }

    let author = scalar_string(get_field(&data, "author").unwrap_or(&Value::Null))
        .unwrap_or_default()
        .trim()
        .to_string();
    if author.is_empty() {
        if opts.author.trim().is_empty() {
            return Err(new_err(
                CODE_MISSING_FIELD,
                "author",
                "包内与服务端均无作者信息,无法规范化".to_string(),
            ));
        }
        data.insert(
            Value::String("author".to_string()),
            Value::String(opts.author.trim().to_string()),
        );
        changes.push(format!("author 补为 {}", opts.author.trim()));
    }
    let cat = scalar_string(get_field(&data, "category").unwrap_or(&Value::Null))
        .unwrap_or_default()
        .trim()
        .to_string();
    if cat.is_empty() {
        let category = if opts.category.trim().is_empty() {
            "通用".to_string()
        } else {
            opts.category.trim().to_string()
        };
        data.insert(
            Value::String("category".to_string()),
            Value::String(category.clone()),
        );
        changes.push(format!("category 补为 {}", category));
    }

    // 溯源块只能由安装器写入：包内自带一律剥离（否则新版本会被自己的校验拒绝）。
    let meta_key = Value::String("metadata".to_string());
    if let Some(Value::Mapping(meta)) = data.get(&meta_key) {
        let mut meta = meta.clone();
        let pico_key = Value::String(PROVENANCE_KEY.to_string());
        if meta.contains_key(&pico_key) {
            meta.remove(&pico_key);
            changes.push("移除包内自带的溯源块".to_string());
            if meta.is_empty() {
                data.remove(&meta_key);
            } else {
                data.insert(meta_key, Value::Mapping(meta));
            }
        }
    }

    let out = render_frontmatter(&data, &body)?;
    Ok((out, changes))
}

/// render_frontmatter 以稳定字段顺序重新输出 frontmatter，保留未知字段
/// （技能可能带 metadata/tags 等自定义信息，规范化不得丢数据）。
fn render_frontmatter(data: &Mapping, body: &str) -> Result<String, ManifestError> {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out = String::from("---\n");
    let emit = |out: &mut String, key: &str, val: &Value, seen: &mut std::collections::HashSet<String>| -> Result<(), ManifestError> {
        let key_s = key.to_string();
        if seen.contains(&key_s) {
            return Ok(());
        }
        seen.insert(key_s);
        let mut single = Mapping::new();
        single.insert(Value::String(key.to_string()), val.clone());
        let chunk = serde_yaml::to_string(&Value::Mapping(single)).map_err(|_| {
            new_err(
                CODE_FRONTMATTER_INVALID,
                key,
                format!("字段 {} 无法序列化", key),
            )
        })?;
        out.push_str(&chunk);
        Ok(())
    };
    for key in NORMALIZED_FIELD_ORDER {
        if let Some(val) = get_field(data, key) {
            emit(&mut out, key, val, &mut seen)?;
        }
    }
    let mut rest: Vec<&String> = data
        .keys()
        .filter_map(|k| match k {
            Value::String(s) if !seen.contains(s) => Some(s),
            _ => None,
        })
        .collect();
    rest.sort();
    for key in rest {
        let val = data.get(Value::String(key.clone())).unwrap();
        emit(&mut out, key, val, &mut seen)?;
    }
    out.push_str("---\n\n");
    out.push_str(body.trim_start_matches('\n'));
    Ok(out)
}

/// bump_patch 返回下一个补丁版本（"1.2.0" → "1.2.1"）。
/// 规范化产出的是新版本（历史版本不可变），因此需要一个确定的下一版本号。
pub fn bump_patch(version: &str) -> String {
    let core = version.split_once('-').map(|(c, _)| c).unwrap_or(version);
    let mut parts: Vec<&str> = core.split('.').collect();
    while parts.len() < 3 {
        parts.push("0");
    }
    let patch = parts[2].parse::<u64>().unwrap_or(0);
    format!("{}.{}.{}", parts[0], parts[1], patch + 1)
}

// ---------------------------------------------------------------------------
// 测试（对应 Go manifest_test.go / normalize_test.go / agent_test.go）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// good_body 是合规正文；单独抽出常量，便于「空壳」用例精确替换掉它。
    const GOOD_BODY: &str = "# 员工日常咨询知识库\n\n本技能提供员工日常咨询知识库的索引与强制读取规则,覆盖人事、行政、商业保险与财务报销等高频问题的查询路径。\n";

    /// good_md 构建合规 SKILL.md；每个用例只改动它的一处，保证失败信息
    /// 精确指向被测规则。
    fn good_md(overrides: &[(&str, &str)], omit: &[&str]) -> String {
        let mut fields: Vec<(String, String)> = [
            ("name", "team-knowledge-wiki"),
            ("title", "团队知识库助手"),
            ("version", "1.2.0"),
            ("description", "员工手册、SSC 人事服务与报销制度的知识库索引与读取规则。"),
            ("author", "zhangsan"),
            ("category", "通用"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        fields.retain(|(k, _)| !omit.contains(&k.as_str()));
        for (k, v) in overrides {
            if let Some(entry) = fields.iter_mut().find(|(ek, _)| ek == k) {
                entry.1 = v.to_string();
            } else {
                fields.push((k.to_string(), v.to_string()));
            }
        }
        let mut out = String::from("---\n");
        for (k, v) in &fields {
            out.push_str(&format!("{}: {}\n", k, v));
        }
        out.push_str("---\n\n");
        out.push_str(GOOD_BODY);
        out
    }

    fn entries() -> Vec<&'static str> {
        vec!["SKILL.md", "references/wiki-index.md"]
    }

    /// assert_code 断言 parse 返回指定错误码（并在失败时打印真实码与消息）。
    fn assert_code(err: &Result<Manifest, ManifestError>, want_code: &str, want_field: &str) {
        let e = match err {
            Err(e) => e,
            Ok(_) => panic!("want {}, got Ok", want_code),
        };
        assert_eq!(e.code, want_code, "field={:?} msg={}", e.field, e.message);
        if !want_field.is_empty() {
            assert_eq!(e.field.as_deref(), Some(want_field));
        }
        assert!(!e.message.trim().is_empty(), "error message must not be empty");
    }

    #[test]
    fn parse_valid_manifest() {
        let m = parse(&entries(), &good_md(&[], &[]), "team-knowledge-wiki").unwrap();
        assert_eq!(m.app_id, "team-knowledge-wiki");
        assert_eq!(m.title, "团队知识库助手");
        assert_eq!(m.version, "1.2.0");
        assert_eq!(m.author, "zhangsan");
        assert_eq!(m.category, "通用");
    }

    #[test]
    fn parse_accepts_optional_fields_and_crlf() {
        let md = good_md(
            &[("tags", "[HR, 报销, 员工手册]"), ("changelog", "补充生育报销与居转户章节。")],
            &[],
        )
        .replace("\n", "\r\n");
        let m = parse(&entries(), &md, "").unwrap();
        assert_eq!(m.tags, vec!["HR", "报销", "员工手册"]);
        assert_eq!(m.changelog, "补充生育报销与居转户章节。");
    }

    #[test]
    fn parse_required_field_matrix() {
        for field in ["name", "title", "version", "description", "author", "category"] {
            let err = parse(&entries(), &good_md(&[], &[field]), "");
            assert_code(&err, CODE_MISSING_FIELD, field);
        }
    }

    #[test]
    fn parse_rejects_empty_required_field() {
        let err = parse(&entries(), &good_md(&[("author", "\"\"")], &[]), "");
        assert_code(&err, CODE_MISSING_FIELD, "author");
    }

    #[test]
    fn parse_rejects_non_kebab_names() {
        for name in [
            "My-Skill",
            "my.skill",
            "my_skill",
            "my--skill",
            "my-skill-",
            "团队知识库助手",
        ] {
            let err = parse(&entries(), &good_md(&[("name", name)], &[]), "");
            assert_code(&err, CODE_INVALID_APP_ID, "name");
        }
    }

    #[test]
    fn parse_accepts_valid_kebab_names() {
        for name in [
            "dws",
            "excel-sheet-summary",
            "team-knowledge-wiki",
            "a1",
            "x2y3-z4",
        ] {
            parse(&entries(), &good_md(&[("name", name)], &[]), "")
                .unwrap_or_else(|e| panic!("{} should be valid: {}", name, e));
        }
    }

    #[test]
    fn parse_rejects_non_semver_versions() {
        for v in ["v1", "abc", "1.0", "1", "1.2.3.4", "1.2.x"] {
            let err = parse(&entries(), &good_md(&[("version", &format!("\"{}\"", v))], &[]), "");
            assert_code(&err, CODE_INVALID_VERSION, "version");
        }
    }

    #[test]
    fn parse_accepts_semver_with_prerelease() {
        let m = parse(&entries(), &good_md(&[("version", "2.0.0-rc.1")], &[]), "").unwrap();
        assert_eq!(m.version, "2.0.0-rc.1");
    }

    #[test]
    fn parse_unquoted_float_version() {
        // `version: 1.0` 会被 YAML 解析成浮点数，必须落到精确的版本号报错上。
        let err = parse(&entries(), &good_md(&[("version", "1.0")], &[]), "");
        assert_code(&err, CODE_INVALID_VERSION, "version");
    }

    #[test]
    fn parse_description_bounds() {
        let err = parse(&entries(), &good_md(&[("description", "太短")], &[]), "");
        assert_code(&err, CODE_FIELD_TOO_SHORT, "description");

        // 真实技能的 description 可以很长（线上最长 958 字），上限只防滥用。
        parse(&entries(), &good_md(&[("description", &"详".repeat(960))], &[]), "")
            .unwrap_or_else(|e| panic!("958 字量级的真实描述必须放行: {}", e));

        let long = "长".repeat(MAX_DESCRIPTION_RUNES + 1);
        let err = parse(&entries(), &good_md(&[("description", &long)], &[]), "");
        assert_code(&err, CODE_FIELD_TOO_LONG, "description");
    }

    #[test]
    fn parse_title_too_long() {
        let err = parse(
            &entries(),
            &good_md(&[("title", &"题".repeat(MAX_TITLE_RUNES + 1))], &[]),
            "",
        );
        assert_code(&err, CODE_FIELD_TOO_LONG, "title");
    }

    #[test]
    fn parse_rejects_list_category() {
        let err = parse(&entries(), &good_md(&[("category", "[通用, 人事]")], &[]), "");
        assert_code(&err, CODE_INVALID_TYPE, "category");
    }

    #[test]
    fn parse_tag_rules() {
        let err = parse(&entries(), &good_md(&[("tags", "HR")], &[]), "");
        assert_code(&err, CODE_INVALID_TYPE, "tags");

        let many = format!("[{}]", vec!["t"; MAX_TAGS + 1].join(", "));
        let err = parse(&entries(), &good_md(&[("tags", &many)], &[]), "");
        assert_code(&err, CODE_FIELD_TOO_LONG, "tags");

        let long_tag = format!("[{}]", "标".repeat(MAX_TAG_RUNES + 1));
        let err = parse(&entries(), &good_md(&[("tags", &long_tag)], &[]), "");
        assert_code(&err, CODE_FIELD_TOO_LONG, "tags");
    }

    #[test]
    fn parse_rejects_bom() {
        let err = parse(&entries(), &format!("\u{feff}{}", good_md(&[], &[])), "");
        assert_code(&err, CODE_BOM_DETECTED, "");
    }

    #[test]
    fn parse_frontmatter_problems() {
        let cases: Vec<(&str, String)> = vec![
            ("无 frontmatter", format!("# 只有正文\n\n{}", "内容".repeat(40))),
            ("未闭合", format!("---\nname: demo\n\n# 正文{}", "内容".repeat(40))),
            ("空文件", "   ".to_string()),
            ("非映射", format!("---\n- a\n- b\n---\n\n{}", "正文".repeat(40))),
            ("非法 YAML", format!("---\nname: [unclosed\n---\n\n{}", "正文".repeat(40))),
        ];
        for (label, md) in cases {
            let err = parse(&entries(), &md, "");
            assert_code(&err, CODE_FRONTMATTER_INVALID, "");
            let _ = label;
        }
    }

    #[test]
    fn parse_rejects_empty_body() {
        let md = good_md(&[], &[]).replace(GOOD_BODY, "简介\n");
        let err = parse(&entries(), &md, "");
        assert_code(&err, CODE_BODY_EMPTY, "");
    }

    #[test]
    fn parse_body_length_boundary() {
        let exact = "字".repeat(MIN_BODY_RUNES);
        let md = good_md(&[], &[]).replace(GOOD_BODY, &exact);
        parse(&entries(), &md, "").unwrap_or_else(|e| panic!("正文恰好 {} 字应通过: {}", MIN_BODY_RUNES, e));

        let short = "字".repeat(MIN_BODY_RUNES - 1);
        let md = good_md(&[], &[]).replace(GOOD_BODY, &short);
        let err = parse(&entries(), &md, "");
        assert_code(&err, CODE_BODY_EMPTY, "");
    }

    #[test]
    fn parse_invocation_rules() {
        let err = parse(&entries(), &good_md(&[("userInvocable", "true")], &[]), "");
        assert_code(&err, CODE_INVOCATION_INVALID, "userInvocable");

        let err = parse(&entries(), &good_md(&[("user-invocable", "maybe")], &[]), "");
        assert_code(&err, CODE_INVOCATION_INVALID, "user-invocable");

        parse(&entries(), &good_md(&[("user-invocable", "false")], &[]), "")
            .unwrap_or_else(|e| panic!("boolean literal should pass: {}", e));
        parse(&entries(), &good_md(&[("disable-model-invocation", "yes")], &[]), "")
            .unwrap_or_else(|e| panic!("yes/no literal should pass: {}", e));
    }

    #[test]
    fn parse_identity_mismatch() {
        let err = parse(&entries(), &good_md(&[], &[]), "another-app");
        assert_code(&err, CODE_IDENTITY_MISMATCH, "name");
    }

    #[test]
    fn parse_rejects_self_declared_provenance() {
        let with_dir: Vec<&str> = vec!["SKILL.md", "references/wiki-index.md", ".picoaide/release.json"];
        let err = parse(&with_dir, &good_md(&[], &[]), "");
        assert_code(&err, CODE_PROVENANCE_FORBIDDEN, "");

        let md = good_md(&[], &[]).replace(
            "---\n\n",
            "metadata:\n  picoaide:\n    app_id: forged\n---\n\n",
        );
        let err = parse(&entries(), &md, "");
        assert_code(&err, CODE_PROVENANCE_FORBIDDEN, "metadata.picoaide");
    }

    #[test]
    fn parse_allows_ordinary_metadata() {
        let md = good_md(&[], &[]).replace(
            "---\n\n",
            "metadata:\n  requires:\n    bins: [\"wecom-cli\"]\n---\n\n",
        );
        parse(&entries(), &md, "").unwrap_or_else(|e| panic!("ordinary metadata must pass: {}", e));
    }

    #[test]
    fn compare_versions_table() {
        let cases: Vec<(&str, &str, i32)> = vec![
            ("1.0.0", "1.0.1", -1),
            ("1.2.0", "1.10.0", -1),
            ("2.0.0", "1.99.99", 1),
            ("1.2.3", "1.2.3", 0),
            ("1.2.0-rc.1", "1.2.0", -1),
            ("1.2.0", "1.2.0-rc.1", 1),
            ("1.2.0-rc.1", "1.2.0-rc.2", -1),
            // B4(2026-09-01):预发布段数字标识符按数值比较(非字典序)。
            ("1.2.0-rc.2", "1.2.0-rc.10", -1),
            ("1.2.0-rc.10", "1.2.0-rc.2", 1),
            ("1.2.0-alpha.2", "1.2.0-alpha.10", -1),
            ("1.2.0-rc.1", "1.2.0-rc.1.1", -1),
            ("1.2.0-rc.10", "1.2.0-rc.10", 0),
            ("1.2.0-rc.1", "1.2.0-beta.1", 1),
            ("1.2.0-rc.1", "1.2.0-alpha", 1),
            ("1.2.0-99999999999999999999", "1.2.0-123456789012345678901", -1),
            ("1.2.0-123456789012345678901", "1.2.0-99999999999999999999", 1),
            ("1.2.0-0.1", "1.2.0-0.0", 1),
        ];
        for (a, b, want) in cases {
            let got = compare_versions(a, b);
            let sign = |v: i32| if v < 0 { -1 } else if v > 0 { 1 } else { 0 };
            assert_eq!(
                sign(got),
                want,
                "compare_versions({}, {}) = {}, want sign {}",
                a,
                b,
                got,
                want
            );
        }
    }

    #[test]
    fn is_app_id_length_bounds() {
        assert!(!is_app_id("a"), "单字符应用 ID 应被拒绝");
        assert!(is_app_id(&"a".repeat(MAX_APP_ID_LEN)), "上限长度应通过");
        assert!(!is_app_id(&"a".repeat(MAX_APP_ID_LEN + 1)), "超长应用 ID 应被拒绝");
    }

    #[test]
    fn status_for_all_422() {
        let codes = [
            CODE_MISSING_FIELD,
            CODE_INVALID_APP_ID,
            CODE_INVALID_VERSION,
            CODE_FIELD_TOO_LONG,
            CODE_FIELD_TOO_SHORT,
            CODE_INVALID_TYPE,
            CODE_IDENTITY_MISMATCH,
            CODE_BOM_DETECTED,
            CODE_FRONTMATTER_INVALID,
            CODE_BODY_EMPTY,
            CODE_INVOCATION_INVALID,
            CODE_PROVENANCE_FORBIDDEN,
            CODE_MANIFEST_MISMATCH,
        ];
        for code in codes {
            assert_eq!(status_for(code), 422, "StatusFor({})", code);
        }
        assert_eq!(status_for("UNKNOWN_CODE"), 422);
    }

    #[test]
    fn error_formatting() {
        let e = new_err(CODE_MISSING_FIELD, "name", "缺少 name".to_string());
        assert_eq!(e.to_string(), "MISSING_FIELD[name]: 缺少 name");
        let g = new_err(CODE_BOM_DETECTED, "", "BOM".to_string());
        assert_eq!(g.to_string(), "BOM_DETECTED: BOM");
    }

    #[test]
    fn parse_agent_valid() {
        let m = parse_agent(
            &["preset.yml"],
            "title: \"分析助手\"\nname: \"analyzer\"\nversion: \"2.1.0\"\ndescription: \"用于代码分析的助手,足够长的描述文本满足最少字数要求。\"\nauthor: \"QA\"\ncategory: \"编程\"\n",
            "my-agent",
        )
        .unwrap();
        assert_eq!(m.app_id, "my-agent");
        assert_eq!(m.title, "分析助手");
        assert_eq!(m.version, "2.1.0");
        assert_eq!(m.author, "QA");
        assert_eq!(m.category, "编程");
    }

    #[test]
    fn parse_agent_name_fallback() {
        let m = parse_agent(
            &["preset.yml"],
            "name: \"fallback-name\"\nversion: \"1.0.0\"\ndescription: \"这是足够长的描述文本,用于回退路径的校验。\"\nauthor: \"a\"\ncategory: \"通用\"\n",
            "agent-x",
        )
        .unwrap();
        assert_eq!(m.title, "fallback-name");
    }

    #[test]
    fn parse_agent_errors() {
        let bom = format!(
            "\u{feff}name: x\nversion: 1.0.0\ndescription: 足够长的描述文本至少二十个字符。\nauthor: a\ncategory: c\n"
        );
        let err = parse_agent::<&str>(&[], &bom, "a");
        assert_code(&err, CODE_BOM_DETECTED, "");

        let err = parse_agent::<&str>(&[], "", "a");
        assert_code(&err, CODE_MISSING_FIELD, PRESET_META_FILE);

        let err = parse_agent::<&str>(&[], "{}", "a");
        assert_code(&err, CODE_MISSING_FIELD, "name");

        let err = parse_agent::<&str>(&[], "- not\n- a\n- mapping\n", "a");
        assert_code(&err, CODE_FRONTMATTER_INVALID, "");

        let err = parse_agent::<&str>(
            &[],
            "name: x\nversion: 1.0.0\ndescription: \"短\"\nauthor: a\ncategory: c\n",
            "a",
        );
        assert_code(&err, CODE_FIELD_TOO_SHORT, "description");

        let err = parse_agent::<&str>(
            &[],
            "name: x\nversion: 1.0.0\ndescription: 足够长的描述文本至少二十个字符才能通过校验。\nauthor: a\n",
            "a",
        );
        assert_code(&err, CODE_MISSING_FIELD, "category");
    }

    // ---- normalize（对应 normalize_test.go） ----

    /// real_world_md 是真实存量形态：中文 name + 无 title + 有 version/author/category。
    const REAL_WORLD_MD: &str = "---\n\
name: 团队知识库助手\n\
category: 通用\n\
version: 1.0.0\n\
description: \"员工日常咨询知识库的索引与强制读取规则,覆盖人事行政与报销。\"\n\
tags: [example-org, HR]\n\
author: zhangsan\n\
---\n\n\
# 员工日常咨询知识库\n\n\
本技能用于服务端单元测试:正文需要足够长才能通过空壳校验,因此这里补充了两句完整的说明文字,描述该技能的用途、触发时机与使用方式,确保长度稳稳超过五十字的下限要求。\n";

    #[test]
    fn normalize_moves_chinese_name_to_title() {
        let (out, changes) = normalize_skill_md(
            REAL_WORLD_MD,
            &NormalizeOptions {
                app_id: "team-knowledge-wiki".to_string(),
                ..NormalizeOptions::default()
            },
        )
        .unwrap();
        // 规范化后必须能通过严格校验——这是本函数存在的全部意义。
        let m = parse(&["SKILL.md"], &out, "team-knowledge-wiki")
            .unwrap_or_else(|e| panic!("规范化产物仍不合规: {}\n{}", e, out));
        assert_eq!(m.app_id, "team-knowledge-wiki");
        assert_eq!(m.title, "团队知识库助手");
        assert_eq!(m.author, "zhangsan");
        assert_eq!(m.category, "通用");
        assert_eq!(m.tags, vec!["example-org", "HR"]);
        assert!(changes.iter().any(|c| c.contains("迁移到 title")), "changes = {:?}", changes);
        assert!(out.contains("本技能用于服务端单元测试"), "正文必须原样保留");
    }

    #[test]
    fn normalize_strips_bom_and_fills_fallbacks() {
        let md = format!(
            "\u{feff}---\nname: demo\ndescription: 这是一段足够长的技能描述用于测试。\n---\n\n本技能用于服务端单元测试:正文需要足够长才能通过空壳校验,因此这里补充了两句完整的说明文字,描述该技能的用途、触发时机与使用方式,确保长度稳稳超过五十字的下限要求。\n"
        );
        let (out, changes) = normalize_skill_md(
            &md,
            &NormalizeOptions {
                app_id: "demo".to_string(),
                version: "2.1.0".to_string(),
                author: "lisi".to_string(),
                category: "研发".to_string(),
            },
        )
        .unwrap();
        assert!(!out.starts_with('\u{feff}'), "BOM 未剥离");
        let m = parse(&["SKILL.md"], &out, "demo")
            .unwrap_or_else(|e| panic!("规范化产物仍不合规: {}\n{}", e, out));
        assert_eq!(m.version, "2.1.0");
        assert_eq!(m.author, "lisi");
        assert_eq!(m.category, "研发");
        let joined = changes.join(";");
        for want in ["BOM", "version 补为", "author 补为", "category 补为"] {
            assert!(joined.contains(want), "changes 缺 {:?}: {:?}", want, changes);
        }
    }

    #[test]
    fn normalize_refuses_to_invent_description() {
        let md = "---\nname: demo\nversion: 1.0.0\n---\n\n正文足够长的内容用于测试夹具说明文字补充。\n";
        let err = normalize_skill_md(
            md,
            &NormalizeOptions {
                app_id: "demo".to_string(),
                author: "a".to_string(),
                category: "b".to_string(),
                ..NormalizeOptions::default()
            },
        );
        assert!(err.is_err(), "缺 description 必须报错(不得编造语义内容)");
    }

    #[test]
    fn normalize_drops_self_declared_provenance() {
        let md = "---\nname: demo\nversion: 1.0.0\nauthor: a\ncategory: b\ndescription: 这是一段足够长的技能描述用于测试。\nmetadata:\n  picoaide:\n    app_id: forged\n---\n\n本技能用于服务端单元测试:正文需要足够长才能通过空壳校验,因此这里补充了两句完整的说明文字,描述该技能的用途、触发时机与使用方式,确保长度稳稳超过五十字的下限要求。\n";
        let (out, changes) = normalize_skill_md(
            md,
            &NormalizeOptions {
                app_id: "demo".to_string(),
                ..NormalizeOptions::default()
            },
        )
        .unwrap();
        parse(&["SKILL.md"], &out, "demo")
            .unwrap_or_else(|e| panic!("剥离溯源后应合规: {}\n{}", e, out));
        assert!(changes.iter().any(|c| c.contains("溯源")), "changes = {:?}", changes);
    }

    #[test]
    fn bump_patch_cases() {
        for (input, want) in [
            ("1.0.0", "1.0.1"),
            ("2.5.9", "2.5.10"),
            ("1.116.0", "1.116.1"),
            ("0.1.0", "0.1.1"),
        ] {
            assert_eq!(bump_patch(input), want, "BumpPatch({})", input);
        }
    }
}
