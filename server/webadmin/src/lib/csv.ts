// CSV 导出工具(单一实现:审计页与用量中心共用)。
//
// 2026-09-13(审计 R7 webadmin-branding-4):审计日志导出手写了一份 CSV 生成
// 代码,既没有公式注入转义也没有 BOM,而用量中心有一份正确的 —— 同一仓库两套
// 口径。审计行里的 username/detail 来自匿名可写输入(登录失败即落一条审计,
// 用户名只限长度不校验字符集),导出后管理员用 Excel/LibreOffice 打开就会执行
// 以 = + - @ Tab CR 开头的单元格(公式/DDE)。抽到这里后两端同口径。

/**
 * 序列化一个 CSV 单元格。
 *
 * 公式注入防护:以 `=` `+` `-` `@` Tab CR 开头的值加 `'` 前缀(电子表格把
 * 该单元格当文本,前缀本身不显示)。前缀是**中和**不是删除 —— 原文完整保留。
 */
export function csvCell(v: string | number): string {
  let s = String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"'
  return s
}

/** 把表头与数据行拼成 CSV 文本(带 UTF-8 BOM,Excel 打开中文不乱码)。 */
export function buildCsv(head: string[], lines: (string | number)[][]): string {
  return '\uFEFF' + [head.join(','), ...lines.map((l) => l.map((v) => csvCell(v)).join(','))].join('\n')
}

/** 触发浏览器下载一份 CSV。 */
export function downloadCsv(filename: string, head: string[], lines: (string | number)[][]) {
  const blob = new Blob([buildCsv(head, lines)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
