//! 语义化版本比较（Go `util.CompareSemVer` 等价）。

/// CompareSemVer 数值感知版本比较；返回 -1/0/1。
/// 任一输入为空或含非法字符时回退到字节序比较（全序，永不 panic）。
pub fn compare_semver(left: &str, right: &str) -> i32 {
    if left == right {
        return 0;
    }
    if left.is_empty() || right.is_empty() {
        return left.cmp(right) as i32;
    }
    let lt = version_tokens(left);
    let rt = version_tokens(right);
    let (lt, rt) = match (lt, rt) {
        (Some(l), Some(r)) => (l, r),
        _ => return { let c = left.cmp(right); if c == std::cmp::Ordering::Less { -1 } else if c == std::cmp::Ordering::Greater { 1 } else { 0 } },
    };
    let n = lt.len().max(rt.len());
    for i in 0..n {
        let have_l = i < lt.len();
        let have_r = i < rt.len();
        if have_l && have_r {
            let l = &lt[i];
            let r = &rt[i];
            if l.numeric == r.numeric && l.text == r.text {
                continue;
            }
            if l.numeric && r.numeric {
                let ln: i64 = l.text.parse().unwrap_or(0);
                let rn: i64 = r.text.parse().unwrap_or(0);
                if ln < rn {
                    return -1;
                }
                if ln > rn {
                    return 1;
                }
                continue;
            }
            if l.numeric != r.numeric {
                // 数值 run 在同类位置排在字母 run 之下（"2" < "rc"）
                return if l.numeric { -1 } else { 1 };
            }
            return match l.text.cmp(&r.text) {
                std::cmp::Ordering::Less => -1,
                std::cmp::Ordering::Greater => 1,
                std::cmp::Ordering::Equal => 0,
            };
        }
        if have_l != have_r {
            let extra = if have_l { &lt[i] } else { &rt[i] };
            if !extra.numeric {
                // 额外字母 run = 预发布，排较低
                return if have_l { -1 } else { 1 };
            }
            return if have_l { 1 } else { -1 };
        }
        return 0;
    }
    0
}

#[derive(Clone, Debug)]
struct VersionToken {
    text: String,
    numeric: bool,
}

/// version_tokens 把版本拆成交替的字母/数字 run。含接受集外字符则返回 None。
fn version_tokens(v: &str) -> Option<Vec<VersionToken>> {
    let mut out: Vec<VersionToken> = Vec::new();
    let mut run = String::new();
    let mut run_numeric = false;
    let mut have_run = false;
    let flush = |out: &mut Vec<VersionToken>, run: &mut String, run_numeric: &bool, have_run: &bool| {
        if *have_run {
            out.push(VersionToken { text: run.clone(), numeric: *run_numeric });
            run.clear();
        }
    };
    for ch in v.chars() {
        match ch {
            '.' | '-' | '_' => {
                flush(&mut out, &mut run, &run_numeric, &have_run);
                have_run = false;
            }
            '0'..='9' => {
                if have_run && !run_numeric {
                    flush(&mut out, &mut run, &run_numeric, &have_run);
                }
                run.push(ch);
                run_numeric = true;
                have_run = true;
            }
            'a'..='z' | 'A'..='Z' => {
                if have_run && run_numeric {
                    flush(&mut out, &mut run, &run_numeric, &have_run);
                }
                run.push(ch);
                run_numeric = false;
                have_run = true;
            }
            _ => return None,
        }
    }
    flush(&mut out, &mut run, &run_numeric, &have_run);
    if out.is_empty() {
        return None;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numeric_not_lexicographic() {
        assert!(compare_semver("1.9.0", "1.10.0") < 0);
        assert!(compare_semver("v2", "v10") < 0);
    }

    #[test]
    fn prerelease_ranks_lower() {
        assert!(compare_semver("1.0.0-rc1", "1.0.0") < 0);
        assert!(compare_semver("1.0.0-beta", "1.0.0") < 0);
    }

    #[test]
    fn equal() {
        assert_eq!(compare_semver("1.0.0", "1.0.0"), 0);
        assert_eq!(compare_semver("1.0", "1.0"), 0);
    }

    #[test]
    fn patch_greater() {
        assert!(compare_semver("1.0", "1.0.1") < 0);
        assert!(compare_semver("1.0.1", "1.0") > 0);
    }

    #[test]
    fn invalid_falls_back_to_byte_order() {
        assert_eq!(compare_semver("", "1.0"), -1);
        assert!(compare_semver("1.0", "") > 0);
        // "a!" 含非法字符 → 字节序
        assert_eq!(compare_semver("a!", "b"), "a!".cmp("b") as i32);
    }
}
