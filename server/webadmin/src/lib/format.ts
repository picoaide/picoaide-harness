// 数字格式化与配额计算共享工具(工程原则 §3.2:重复 2 次即提取共享模块)
// 供 Users.tsx / Usage.tsx 等页面复用,统一口径避免两端不一致。

// 紧凑数字格式:>=1e6 → 1.2M,>=1e3 → 3K,去尾零(3000 → 3K)
export function fmtTokens(n: number): string {
  if (n >= 1000000) return `${Number((n / 1000000).toFixed(1))}M`
  if (n >= 1000) return `${Number((n / 1000).toFixed(1))}K`
  return String(n)
}

// 完整数字(千分位),用于悬浮 title 展示精确值
export function fmtFull(n: number): string {
  return n.toLocaleString()
}

// 配额使用率(0-100,clamp;quota=0/null 表示不限 → 返回 0)
export function usageRate(used: number, quota: number | null | undefined): number {
  if (!quota || quota <= 0) return 0
  return Math.min(100, Math.round((used / quota) * 100))
}

// 本地时区 YYYY-MM-DD(修复 UTC 偏移一天的 bug;toISOString 在 UTC+8 上午会回退一天)
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// 快捷区间:相对 today 的起止日期(含 today)
export function rangePreset(days: number): { from: string; to: string } {
  const now = new Date()
  const to = ymd(now)
  const from = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)))
  return { from, to }
}

// 本月 1 日 → today
export function monthRange(): { from: string; to: string } {
  const now = new Date()
  return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: ymd(now) }
}

// ---- 金额(费用)格式化与配额计算(0022) ----
// 费用单位:元(¥)。展示两位小数(小额)或紧凑格式(大额),与 token 口径分开。

// 金额紧凑格式:>=1e6 → 123.5万,>=1e4 → 1.2万,>=1000 → 1,234,其余两位小数
export function fmtMoney(n: number): string {
  if (!isFinite(n)) return '—'
  if (n >= 1_000_000) return `${Number((n / 10000).toFixed(1))}万`
  if (n >= 10000) return `${Number((n / 10000).toFixed(1))}万`
  if (n >= 1000) return n.toLocaleString('zh-CN', { maximumFractionDigits: 0 })
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// 完整金额(千分位 + 两位小数),用于悬浮 title 展示精确值
export function fmtMoneyFull(n: number): string {
  return `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// 金额配额使用率(0-100,clamp;quota=0/null 表示不限 → 返回 0)
export function moneyRate(used: number, quota: number | null | undefined): number {
  if (!quota || quota <= 0) return 0
  return Math.min(100, Math.round((used / quota) * 100))
}

// 实际占用百分比(可 >100% 用于超额展示;quota=0/null 返回 null)
export function moneyPercent(used: number, quota: number | null | undefined): number | null {
  if (!quota || quota <= 0) return null
  return Math.round((used / quota) * 100)
}

// 是否超额(used > quota,且 quota 有限)
export function moneyOver(used: number, quota: number | null | undefined): boolean {
  return !!quota && quota > 0 && used > quota
}

// 模型是否已定价(审计修复 M6):输入价>0 或 输出价>0 即已定价。
// 纯 embedding 模型只配输入价也算已定价。Gateway 与 Usage 共用,避免
// 两页对同一模型给出矛盾的「未定价」判定(此前 Usage 把仅输入定价的
// embedding 模型误报为未定价,弹"金额配额可能被低估"横幅)。
export function isModelPriced(m: { input_price_per_1m?: number | null; output_price_per_1m?: number | null } | null | undefined): boolean {
  if (!m) return false
  return (m.input_price_per_1m ?? 0) > 0 || (m.output_price_per_1m ?? 0) > 0
}
