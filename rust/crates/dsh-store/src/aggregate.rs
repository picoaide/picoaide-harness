//! 用量聚合（Go `serverstore/usage.go` 的 UsageAggregate 部分 +
//! `serverstore/usage_dept.go` 的 RegroupByDept 等价）。
//!
//! 聚合维度：day | week | month | model | user。时间分组在给定 from/to 时按
//! 日/周/月补零（缺桶填 0）；按 user 分组时标签用用户名（LEFT JOIN users），
//! 查无行时回退用户 ID 字符串。kind 为拆分字段而非分组维度（embedding 行单独
//! 计入 embed_requests/embed_tokens，见 `UsageAggregateRow` 注释）。
//!
//! PG 日期表达式与 Go 的 dialect.go 一致（北京时区 Asia/Shanghai）：
//! - day:   `to_char(created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD')`
//! - week:  `to_char(date_trunc('week', created_at AT TIME ZONE 'Asia/Shanghai')::date, 'YYYY-MM-DD')`
//! - month: `to_char(created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM')`
//! - range: `created_at AT TIME ZONE 'Asia/Shanghai'`（比较参数为 YYYY-MM-DD 字符串）

use crate::errors::{map_db_error, StoreError};
use crate::usage_dept::{dept_user_ids_by_name, pre_order_nodes, user_id_to_depts};
use chrono::{Datelike, NaiveDate};
use sqlx::Row;
use std::collections::HashMap;

/// 聚合行的日期标签时区（Go pgTZ）。
const TZ: &str = "Asia/Shanghai";

/// UsageAggregateRow 一条聚合用量行（Go UsageAggregateRow 等价）。
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct UsageAggregateRow {
    pub label: String,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub requests: i64,
    /// kind 拆分（审计 2026-E2）：embedding 行 prompt_tokens>0 且
    /// completion_tokens=0，单独统计便于前端区分 chat/embedding 用量；
    /// chat = requests - embed_requests。
    pub embed_requests: i64,
    pub embed_tokens: i64,
    /// cache_tokens 缓存命中的输入 token（0030，DeepSeek 缓存计费）。
    pub cache_tokens: i64,
    /// cost 该桶费用合计（元，0022）：SUM(usage.cost)，未定价模型贡献 0。
    pub cost: f64,
}

/// UsageAggregateQuery 聚合过滤条件（builder 风格替代 Go 的 variadic option）。
#[derive(Debug, Clone, Default)]
pub struct UsageAggregateQuery {
    /// 仅统计该用户名（用于用户钻取；子查询过滤，避免与 group=user 的
    /// LEFT JOIN users 双 JOIN 同别名冲突）。
    pub username: Option<String>,
    /// 仅统计该部门树内成员（与预算 enforcement 同口径）。
    pub dept: Option<String>,
    /// 仅统计指定模型。
    pub model: Option<String>,
    /// 仅统计指定类型 chat|embedding|search。
    pub kind: Option<String>,
}

impl UsageAggregateQuery {
    pub fn new() -> Self {
        Self::default()
    }

    /// WithUsername 只聚合指定用户名（JOIN users），用于用户详情钻取。
    pub fn with_username(mut self, username: &str) -> Self {
        self.username = Some(username.to_string());
        self
    }

    /// WithDept 只聚合指定部门（含其子树）的成员用量——与部门预算 enforcement
    /// 同口径（成员归属祖先链全部计入）。部门不存在 = 空结果。
    pub fn with_dept(mut self, dept: &str) -> Self {
        self.dept = Some(dept.to_string());
        self
    }

    /// WithModel 只聚合指定模型的用量。
    pub fn with_model(mut self, model: &str) -> Self {
        self.model = Some(model.to_string());
        self
    }

    /// WithKind 只聚合指定类型（chat|embedding|search）的用量。
    pub fn with_kind(mut self, kind: &str) -> Self {
        self.kind = Some(kind.to_string());
        self
    }
}

/// 查询绑定参数（按出现顺序编号）。
enum Arg {
    Text(String),
    Int(i64),
}

/// day_fill 完整日桶序列（YYYY-MM-DD，from..=to）。
fn day_fill(from: NaiveDate, to: NaiveDate) -> Vec<String> {
    let mut out = Vec::new();
    let mut d = from;
    while d <= to {
        out.push(d.format("%Y-%m-%d").to_string());
        d = d.succ_opt().expect("date overflow");
    }
    out
}

/// week_monday 返回该日期所在周的周一（YYYY-MM-DD）。SQL 侧用
/// `date_trunc('week', ...)`（PG week 从周一开始）得到同一周一，两者严格对齐，
/// 免疫 ISO/%W 的跨年边界差异（审计 2026-E2）。
fn week_monday(d: NaiveDate) -> NaiveDate {
    let wd = d.weekday().num_days_from_sunday() as i64; // 0=Sunday..6=Saturday
    let back = (wd + 6) % 7; // 周一前推 wd-1 天;Sunday(wd=0)前推 6 天
    d - chrono::Duration::days(back)
}

/// week_fill 完整周桶序列（按周一日期，每 7 天一步）。
fn week_fill(from: NaiveDate, to: NaiveDate) -> Vec<String> {
    let mut out = Vec::new();
    let mut d = from;
    while d <= to {
        out.push(week_monday(d).format("%Y-%m-%d").to_string());
        d = d + chrono::Duration::days(7);
    }
    out
}

/// month_fill 完整月桶序列（YYYY-MM）。先归一到月初再 +1 月：避免 from=8/31
/// 时 +1 月跳过头导致 9 月桶被跳过（审计 2026-E3 P1-2）。
fn month_fill(from: NaiveDate, to: NaiveDate) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = NaiveDate::from_ymd_opt(from.year(), from.month(), 1).expect("valid month");
    let end = NaiveDate::from_ymd_opt(to.year(), to.month(), 1).expect("valid month");
    while cur <= end {
        out.push(cur.format("%Y-%m").to_string());
        cur = cur.checked_add_months(chrono::Months::new(1)).expect("month overflow");
    }
    out
}

/// usage_aggregate 聚合 usage 表（Go UsageAggregate 等价）。
///
/// group ∈ day|week|month|model|user；from/to 为 None = 无边界；时间分组在
/// 给定 from/to 时按日/周/月补零（缺桶填 0）。
pub async fn usage_aggregate(
    pool: &sqlx::PgPool,
    from: Option<NaiveDate>,
    to: Option<NaiveDate>,
    group: &str,
    q: &UsageAggregateQuery,
) -> Result<Vec<UsageAggregateRow>, StoreError> {
    // 部门过滤：子树成员集合（2026-09 用量中心，与预算 enforcement 同口径）。
    let mut dept_ids: Vec<i64> = Vec::new();
    if let Some(dept) = &q.dept {
        match dept_user_ids_by_name(pool, dept).await {
            Ok(ids) => dept_ids = ids,
            Err(StoreError::NotFound) => return Ok(Vec::new()), // 部门不存在 = 空结果
            Err(e) => return Err(e),
        }
        if dept_ids.is_empty() {
            return Ok(Vec::new());
        }
    }

    let (select_expr, group_expr, join, fill): (&str, &str, &str, Option<fn(NaiveDate, NaiveDate) -> Vec<String>>) =
        match group {
            "day" => (
                "to_char(usage.created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD')",
                "to_char(usage.created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD')",
                "",
                Some(day_fill),
            ),
            "week" => (
                "to_char(date_trunc('week', usage.created_at AT TIME ZONE 'Asia/Shanghai')::date, 'YYYY-MM-DD')",
                "to_char(date_trunc('week', usage.created_at AT TIME ZONE 'Asia/Shanghai')::date, 'YYYY-MM-DD')",
                "",
                Some(week_fill),
            ),
            "month" => (
                "to_char(usage.created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM')",
                "to_char(usage.created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM')",
                "",
                Some(month_fill),
            ),
            "model" => ("usage.model", "usage.model", "", None),
            _ => {
                // default = user 分组：用户名优先，回退 user_id 字符串
                (
                    "COALESCE(u.username, CAST(usage.user_id AS TEXT))",
                    "u.username, usage.user_id",
                    " LEFT JOIN users u ON u.id = usage.user_id",
                    None,
                )
            }
        };

    let mut sql = String::from("SELECT ");
    sql.push_str(select_expr);
    sql.push_str(
        " AS label, \
         SUM(usage.prompt_tokens)::bigint AS pt, SUM(usage.completion_tokens)::bigint AS ct, COUNT(*) AS req, \
         SUM(CASE WHEN usage.kind = 'embedding' THEN 1 ELSE 0 END) AS ereq, \
         SUM(CASE WHEN usage.kind = 'embedding' THEN usage.prompt_tokens ELSE 0 END)::bigint AS etok, \
         SUM(usage.cache_prompt_tokens)::bigint AS ctk, \
         SUM(usage.cost) AS cost \
         FROM usage",
    );
    sql.push_str(join);
    sql.push_str(" WHERE 1=1");

    let mut args: Vec<Arg> = Vec::new();
    if let Some(f) = from {
        args.push(Arg::Text(f.format("%Y-%m-%d").to_string()));
        sql.push_str(&format!(
            " AND usage.created_at AT TIME ZONE 'Asia/Shanghai' >= ${}::timestamp",
            args.len()
        ));
    }
    if let Some(t) = to {
        // 下一天（日历语义），避免 DST 切换日 24h 加法跳日（审计 2026-E3 P1-3）
        let next = t.succ_opt().expect("date overflow");
        args.push(Arg::Text(next.format("%Y-%m-%d").to_string()));
        sql.push_str(&format!(
            " AND usage.created_at AT TIME ZONE 'Asia/Shanghai' < ${}::timestamp",
            args.len()
        ));
    }
    // username 过滤用相关子查询：避免与 group=user 的 LEFT JOIN users 双 JOIN
    // 同别名冲突（审计 2026-E3 P1-1）
    if let Some(u) = &q.username {
        args.push(Arg::Text(u.clone()));
        sql.push_str(&format!(
            " AND usage.user_id = (SELECT id FROM users WHERE username = ${})",
            args.len()
        ));
    }
    if let Some(m) = &q.model {
        args.push(Arg::Text(m.clone()));
        sql.push_str(&format!(" AND usage.model = ${}", args.len()));
    }
    if let Some(k) = &q.kind {
        args.push(Arg::Text(k.clone()));
        sql.push_str(&format!(" AND usage.kind = ${}", args.len()));
    }
    if !dept_ids.is_empty() {
        sql.push_str(" AND usage.user_id IN (");
        for (i, _) in dept_ids.iter().enumerate() {
            if i > 0 {
                sql.push(',');
            }
            args.push(Arg::Int(dept_ids[i]));
            sql.push_str(&format!("${}", args.len()));
        }
        sql.push(')');
    }

    sql.push_str(" GROUP BY ");
    sql.push_str(group_expr);
    sql.push_str(" ORDER BY label");

    let mut qb = sqlx::query(&sql);
    for a in &args {
        qb = match a {
            Arg::Text(t) => qb.bind(t),
            Arg::Int(i) => qb.bind(*i as i32),
        };
    }
    let rows = qb.fetch_all(pool).await.map_err(map_db_error)?;
    let mut out: Vec<UsageAggregateRow> = Vec::new();
    for r in rows {
        out.push(UsageAggregateRow {
            label: r.get("label"),
            prompt_tokens: r.get("pt"),
            completion_tokens: r.get("ct"),
            requests: r.get("req"),
            embed_requests: r.get("ereq"),
            embed_tokens: r.get("etok"),
            cache_tokens: r.get("ctk"),
            cost: r.get("cost"),
        });
    }

    // 时间分组补零：缺失桶填 0（修复 D1：折线不跨缺日直连）
    if let Some(fill) = fill {
        if let (Some(f), Some(t)) = (from, to) {
            let by_label: HashMap<String, UsageAggregateRow> =
                out.into_iter().map(|r| (r.label.clone(), r)).collect();
            let mut filled = Vec::new();
            for bucket in fill(f, t) {
                if let Some(r) = by_label.get(&bucket) {
                    filled.push(r.clone());
                } else {
                    filled.push(UsageAggregateRow {
                        label: bucket,
                        ..Default::default()
                    });
                }
            }
            out = filled;
        }
    }
    Ok(out)
}

/// regroup_by_dept 把 group=user 的聚合行按部门树归并为按部门行（树先序排序）。
/// rows.label 为用户名（或已删用户的 user_id 字符串）。与部门预算 enforcement
/// 同口径：部门树内合计 = 成员归属祖先链全部计入，同一用户对同一部门只计一次。
/// 未归属任何部门的用量不计入部门视图。
pub async fn regroup_by_dept(
    pool: &sqlx::PgPool,
    rows: &[UsageAggregateRow],
) -> Result<Vec<UsageAggregateRow>, StoreError> {
    let nodes = pre_order_nodes(pool).await?;
    if nodes.is_empty() {
        return Ok(Vec::new());
    }
    // 用户（可能多部门）→ 所属部门名集合（已祖先展开、去重）
    let user_depts = user_id_to_depts(pool).await?;

    // label → userID：用户名优先，否则按 user_id 字符串解析
    let rows_res = sqlx::query("SELECT id, username FROM users")
        .fetch_all(pool)
        .await
        .map_err(map_db_error)?;
    let mut label_to_uid: HashMap<String, i64> = HashMap::new();
    for r in rows_res {
        let id = r.get::<i64, _>("id");
        let name: String = r.get("username");
        label_to_uid.insert(name, id);
    }

    let mut agg: HashMap<String, UsageAggregateRow> = HashMap::new();
    for r in rows {
        let uid = match label_to_uid.get(&r.label) {
            Some(uid) => *uid,
            None => match r.label.parse::<i64>() {
                Ok(n) => n,
                Err(_) => continue, // 未归属部门（或已删且无法解析）
            },
        };
        let Some(depts) = user_depts.get(&uid) else {
            continue; // 无部门归属 → 不计入部门视图
        };
        for dept in depts {
            if let Some(cur) = agg.get_mut(dept) {
                cur.prompt_tokens += r.prompt_tokens;
                cur.completion_tokens += r.completion_tokens;
                cur.requests += r.requests;
                cur.embed_requests += r.embed_requests;
                cur.embed_tokens += r.embed_tokens;
                cur.cache_tokens += r.cache_tokens;
                cur.cost += r.cost;
            } else {
                let mut cp = r.clone();
                cp.label = dept.clone(); // 首行作为种子，label 换成部门名
                agg.insert(dept.clone(), cp);
            }
        }
    }

    let mut out: Vec<UsageAggregateRow> = agg.into_values().collect();
    // 树先序排序：父部门在前，子部门跟随（展示层级感）
    let order: HashMap<String, usize> = nodes
        .iter()
        .enumerate()
        .map(|(i, n)| (n.name.clone(), i))
        .collect();
    out.sort_by(|a, b| match (order.get(&a.label), order.get(&b.label)) {
        (Some(oi), Some(oj)) => oi.cmp(oj),
        _ => a.label.cmp(&b.label),
    });
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::new_test_db;

    /// rec_at 插入一行指定 created_at 的 usage（回填历史月份，测试确定性）。
    async fn rec_at(
        pool: &sqlx::PgPool,
        uid: i64,
        model: &str,
        pt: i64,
        ct: i64,
        kind: &str,
        ts: &str,
    ) {
        let id = crate::usage::record_usage_kind(pool, uid, model, pt, ct, kind)
            .await
            .unwrap();
        sqlx::query("UPDATE usage SET created_at = $1::timestamptz WHERE id = $2")
            .bind(ts)
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
    }

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    async fn new_user(pool: &sqlx::PgPool, name: &str) -> i64 {
        crate::users::create_user(
            pool,
            &crate::users::User {
                username: name.into(),
                source: "local".into(),
                status: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn aggregate_day_zero_fill() {
        let pool = new_test_db().await;
        let uid = new_user(&pool, "zf").await;
        rec_at(&pool, uid, "m", 10, 5, "chat", "2026-08-10 09:00:00").await;
        rec_at(&pool, uid, "m", 10, 5, "chat", "2026-08-12 09:00:00").await;

        let rows = usage_aggregate(&pool, Some(d(2026, 8, 10)), Some(d(2026, 8, 12)), "day", &UsageAggregateQuery::new())
            .await
            .unwrap();
        assert_eq!(rows.len(), 3, "want 3 buckets (8-10/8-11/8-12): {rows:?}");
        for (i, w) in ["2026-08-10", "2026-08-11", "2026-08-12"].iter().enumerate() {
            assert_eq!(rows[i].label, *w);
        }
        assert_eq!(rows[0].requests, 1);
        assert_eq!(rows[1].requests, 0, "gap day must be zero-filled");
        assert_eq!(rows[2].requests, 1);
    }

    #[tokio::test]
    async fn aggregate_week_month_and_overflow() {
        let pool = new_test_db().await;
        let uid = new_user(&pool, "wm").await;
        for ts in ["2026-08-10 09:00:00", "2026-08-17 09:00:00", "2026-08-18 09:00:00"] {
            rec_at(&pool, uid, "m", 10, 5, "chat", ts).await;
        }

        // week：2026-08-10（周一）与 2026-08-17 分属两个周桶
        let rows = usage_aggregate(&pool, Some(d(2026, 8, 10)), Some(d(2026, 8, 20)), "week", &UsageAggregateQuery::new())
            .await
            .unwrap();
        assert_eq!(rows.len(), 2, "{rows:?}");
        assert_eq!(rows[0].label, "2026-08-10");
        assert_eq!(rows[1].label, "2026-08-17");
        assert_eq!(rows[0].requests, 1);
        assert_eq!(rows[1].requests, 2);

        // month：7/8/9 三个月，7 月填 0
        let rows = usage_aggregate(&pool, Some(d(2026, 7, 1)), Some(d(2026, 9, 15)), "month", &UsageAggregateQuery::new())
            .await
            .unwrap();
        assert_eq!(rows.len(), 3, "{rows:?}");
        assert_eq!(rows[0].label, "2026-07");
        assert_eq!(rows[0].requests, 0);
        assert_eq!(rows[1].label, "2026-08");
        assert_eq!(rows[1].requests, 3);

        // month overflow：from 为月末 8/31 时 9 月桶不得跳过（审计 2026-E3 P1-2）
        rec_at(&pool, uid, "m", 20, 5, "chat", "2026-08-31 09:00:00").await;
        rec_at(&pool, uid, "m", 20, 5, "chat", "2026-09-15 09:00:00").await;
        let rows = usage_aggregate(&pool, Some(d(2026, 8, 31)), Some(d(2026, 9, 15)), "month", &UsageAggregateQuery::new())
            .await
            .unwrap();
        assert_eq!(rows.len(), 2, "{rows:?}");
        assert_eq!(rows[0].label, "2026-08");
        assert_eq!(rows[1].label, "2026-09");
        assert_eq!(rows[0].requests, 1);
        assert_eq!(rows[1].requests, 1);
    }

    #[tokio::test]
    async fn aggregate_model_kind_split_and_cache() {
        let pool = new_test_db().await;
        let uid = new_user(&pool, "ks").await;
        rec_at(&pool, uid, "m", 10, 5, "chat", "2026-08-10 09:00:00").await;
        rec_at(&pool, uid, "embed-m", 30, 0, "embedding", "2026-08-10 09:00:00").await;
        // 缓存命中：cache_prompt_tokens=300（回填到 8-11，避免落在"今天"时间桶）
        let id = crate::usage::record_usage_kind_cached(&pool, uid, "m", 1000, 500, 300, "chat")
            .await
            .unwrap();
        sqlx::query("UPDATE usage SET created_at = $1::timestamptz WHERE id = $2")
            .bind("2026-08-11 09:00:00")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();

        // group=model：embedding 行单独计入 embed_requests/embed_tokens
        let rows = usage_aggregate(&pool, None, None, "model", &UsageAggregateQuery::new())
            .await
            .unwrap();
        assert_eq!(rows.len(), 2, "{rows:?}");
        let emb = rows.iter().find(|r| r.label == "embed-m").unwrap();
        assert_eq!(emb.requests, 1);
        assert_eq!(emb.embed_requests, 1);
        assert_eq!(emb.embed_tokens, 30);
        assert_eq!(emb.prompt_tokens, 30);
        let chat = rows.iter().find(|r| r.label == "m").unwrap();
        assert_eq!(chat.requests, 2);
        assert_eq!(chat.prompt_tokens, 1010);
        assert_eq!(chat.completion_tokens, 505);
        assert_eq!(chat.cache_tokens, 300);

        // group=day + cache/embed 混合验证
        let rows = usage_aggregate(&pool, Some(d(2026, 8, 10)), Some(d(2026, 8, 11)), "day", &UsageAggregateQuery::new())
            .await
            .unwrap();
        assert_eq!(rows.len(), 2, "{rows:?}");
        assert_eq!(rows[0].label, "2026-08-10");
        assert_eq!(rows[0].requests, 2);
        assert_eq!(rows[0].embed_requests, 1);
        assert_eq!(rows[0].embed_tokens, 30);
        assert_eq!(rows[0].prompt_tokens, 40);
        assert_eq!(rows[1].label, "2026-08-11");
        assert_eq!(rows[1].requests, 1);
        assert_eq!(rows[1].prompt_tokens, 1000);
        assert_eq!(rows[1].cache_tokens, 300);
    }

    #[tokio::test]
    async fn aggregate_user_group_and_username_filter() {
        let pool = new_test_db().await;
        let alice = new_user(&pool, "alice").await;
        let bob = new_user(&pool, "bob").await;
        rec_at(&pool, alice, "m", 10, 5, "chat", "2026-08-10 09:00:00").await;
        rec_at(&pool, bob, "m", 99, 1, "chat", "2026-08-10 10:00:00").await;

        // group=user：标签为用户名
        let rows = usage_aggregate(&pool, None, None, "user", &UsageAggregateQuery::new())
            .await
            .unwrap();
        assert_eq!(rows.len(), 2, "{rows:?}");
        assert_eq!(rows[0].label, "alice");
        assert_eq!(rows[0].prompt_tokens, 10);
        assert_eq!(rows[1].label, "bob");
        assert_eq!(rows[1].prompt_tokens, 99);

        // username 过滤仅返回该用户
        let rows =
            usage_aggregate(&pool, None, None, "day", &UsageAggregateQuery::new().with_username("alice"))
                .await
                .unwrap();
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0].prompt_tokens, 10);

        // username 过滤 + group=user 组合：相关子查询不产生双 JOIN（审计 2026-E3 P1-1）
        let rows =
            usage_aggregate(&pool, None, None, "user", &UsageAggregateQuery::new().with_username("alice"))
                .await
                .unwrap();
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0].label, "alice");
    }

    #[tokio::test]
    async fn aggregate_dept_filter_and_regroup() {
        let pool = new_test_db().await;
        let everyone: i64 = sqlx::query_scalar("SELECT id FROM groups WHERE name = '全员'")
            .fetch_one(&pool)
            .await
            .unwrap();
        let rd = crate::departments::create_department(&pool, "研发部", everyone, 0, "").await.unwrap();
        let fg = crate::departments::create_department(&pool, "前研一组", rd, 0, "").await.unwrap();

        let dev1 = new_user(&pool, "dev1").await;
        let dev2 = new_user(&pool, "dev2").await;
        let nobody = new_user(&pool, "nobody").await;
        crate::groups::add_user_group(&pool, dev1, rd).await.unwrap();
        crate::groups::add_user_group(&pool, dev2, fg).await.unwrap();

        rec_at(&pool, dev1, "m1", 100, 0, "chat", "2026-08-10 09:00:00").await;
        rec_at(&pool, dev2, "m1", 300, 0, "chat", "2026-08-10 10:00:00").await;
        rec_at(&pool, nobody, "m1", 500, 0, "chat", "2026-08-10 11:00:00").await;

        // 1) group=user → 按部门树归并：全员 = dev1+dev2，研发部 = dev1+dev2，
        //    前研一组 = dev2；nobody 无部门归属不计入
        let urows = usage_aggregate(&pool, None, None, "user", &UsageAggregateQuery::new())
            .await
            .unwrap();
        let rows = regroup_by_dept(&pool, &urows).await.unwrap();
        let by_name: HashMap<String, i64> =
            rows.iter().map(|r| (r.label.clone(), r.prompt_tokens)).collect();
        assert_eq!(by_name.get("研发部"), Some(&400), "{rows:?}");
        assert_eq!(by_name.get("前研一组"), Some(&300), "{rows:?}");
        assert_eq!(by_name.get("全员"), Some(&400), "{rows:?}");
        assert!(!by_name.contains_key("nobody"), "user row leaked into dept view");
        // 树先序：全员 在前，研发部 次之，前研一组 最后
        assert_eq!(rows[0].label, "全员");
        assert_eq!(rows[1].label, "研发部");
        assert_eq!(rows[2].label, "前研一组");

        // 2) WithDept 过滤 + 模型分组：研发部 → m1 只含 dev1+dev2
        let mrows =
            usage_aggregate(&pool, None, None, "model", &UsageAggregateQuery::new().with_dept("研发部"))
                .await
                .unwrap();
        assert_eq!(mrows.len(), 1, "{mrows:?}");
        assert_eq!(mrows[0].prompt_tokens, 400);
        assert_eq!(mrows[0].requests, 2);

        // 3) WithDept + group=user
        let urows =
            usage_aggregate(&pool, None, None, "user", &UsageAggregateQuery::new().with_dept("前研一组"))
                .await
                .unwrap();
        assert_eq!(urows.len(), 1, "{urows:?}");
        assert_eq!(urows[0].label, "dev2");
        assert_eq!(urows[0].prompt_tokens, 300);

        // 4) 部门不存在 → 空结果（不 500）
        let empty = usage_aggregate(&pool, None, None, "user", &UsageAggregateQuery::new().with_dept("幽灵部门"))
            .await
            .unwrap();
        assert!(empty.is_empty());
    }
}
