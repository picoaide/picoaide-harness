/**
 * 作者数据面板：**只读**浏览自己应用库里的数据（2026-09-21 新增）。
 *
 * 为什么在产品里必须有一个入口：服务端的 `GET …/schema` 与 `GET …/rows` 在
 * 2026-09-21 之前**没有任何客户端消费方**（作者只能在对话里让 AI 猜），而
 * "我写进去的数据到底长什么样"是作者排障的第一现场。
 *
 * 三条纪律（与服务端的安全论证对齐，见 `server/internal/wasmapp/api/rows.go`）：
 *  1. **仅发布者可见**：`AppDetailView` 只在 `item.isOwner` 时渲染本面板；服务端另有
 *     硬闸（非发布者一律 404 与"应用不存在"同形）—— 界面隐藏不是权限。
 *  2. **默认脱敏**：敏感列显示 `***`；要原值必须显式点「显示原值（会记审计）」，
 *     服务端会为该次调用写 `wasm_app_rows_view_unmasked` 审计。
 *  3. **失败原样呈现**：形状不符/404/超限都渲染服务端的错误信封，**不回落成空表** ——
 *     把 404 画成"这张表是空的"会让作者以为"数据没写进去"，方向完全错。
 *
 * @module @picoaide/dsh-wasm-apps/client/DataBrowserPanel
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'

import { PanelButton } from '@picoaide/dsh-panel-surface/client'

import { fetchRows, fetchSchema, type AppRowsReport, type AppSchemaReport } from './app-lifecycle.ts'
import type { PublishFailure, RequestDeps } from './publish-app.ts'
import { t, tCount } from './locales.ts'

/** 一页多少行（与面板的分页按钮配合；服务端上限 200）。 */
const PAGE_SIZE = 50

/** 数据面板的取数状态（两种资源各自独立，互不覆盖）。 */
type SchemaState =
  | { kind: 'loading' }
  | { kind: 'ready', report: AppSchemaReport }
  | { kind: 'failed', failure: PublishFailure }

type RowsState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready', report: AppRowsReport }
  | { kind: 'failed', failure: PublishFailure }

/**
 * 数据面板。
 *
 * @param props - app_id、可选的可注入取数依赖（测试用）、是否可见。
 * @returns 面板 DOM（无可读内容时也渲染说明，不渲染空白）。
 */
export function DataBrowserPanel({ appId, deps }: { appId: string, deps?: RequestDeps }): ReactNode {
  const [open, setOpen] = useState(false)
  const [schema, setSchema] = useState<SchemaState>({ kind: 'loading' })
  const [table, setTable] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)
  const [unmask, setUnmask] = useState(false)
  const [rows, setRows] = useState<RowsState>({ kind: 'idle' })

  const loadSchema = useCallback(async (): Promise<void> => {
    setSchema({ kind: 'loading' })
    const result = await fetchSchema(appId, deps ?? {})
    if (!result.ok) {
      setSchema({ kind: 'failed', failure: result })
      return
    }
    setSchema({ kind: 'ready', report: result })
    setTable(previous => previous ?? result.tables.find(row => !row.skipped)?.name ?? null)
  }, [appId, deps])

  const loadRows = useCallback(async (nextTable: string, nextOffset: number, nextUnmask: boolean): Promise<void> => {
    setRows({ kind: 'loading' })
    const result = await fetchRows(appId, { table: nextTable, limit: PAGE_SIZE, offset: nextOffset, unmask: nextUnmask }, deps ?? {})
    setRows(result.ok ? { kind: 'ready', report: result } : { kind: 'failed', failure: result })
  }, [appId, deps])

  // 面板**展开时**才取数（收起状态零请求）：应用详情页是高频入口，
  // 不该因为"看了一眼详情"就去读一次应用库。
  useEffect(() => {
    if (!open) return
    void loadSchema()
  }, [open, loadSchema])

  useEffect(() => {
    if (!open || table === null) return
    void loadRows(table, offset, unmask)
  }, [open, table, offset, unmask, loadRows])

  return (
    <section className="pico-app-data" data-role="app-data" data-open={open ? 'true' : 'false'}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13 }}>{t('appCenter.dataTitle')}</strong>
        <PanelButton
          variant="ghost"
          size="sm"
          className="pico-app-data-toggle"
          onClick={() => { setOpen(previous => !previous) }}
        >
          {open ? t('appCenter.dataHide') : t('appCenter.dataShow')}
        </PanelButton>
        {open && (
          <PanelButton
            variant="ghost"
            size="sm"
            className="pico-app-data-reload"
            onClick={() => { void loadSchema() }}
          >
            {t('appCenter.dataReload')}
          </PanelButton>
        )}
      </div>
      {/* 说明文案常驻：作者要知道"这是只读的、默认脱敏的、会审计的"。 */}
      <p style={{ fontSize: 12, opacity: 0.75, margin: '4px 0 0' }} data-role="data-hint">{t('appCenter.dataHint')}</p>

      {open && schema.kind === 'loading' && <p style={HINT} data-role="data-loading">{t('appCenter.dataLoading')}</p>}
      {open && schema.kind === 'failed' && (
        <FailureBlock failure={schema.failure} role="data-schema-error" onRetry={() => { void loadSchema() }} />
      )}
      {open && schema.kind === 'ready' && schema.report.tables.length === 0 && (
        <p style={HINT} data-role="data-empty">{t('appCenter.dataEmpty')}</p>
      )}
      {open && schema.kind === 'ready' && schema.report.tables.length > 0 && (
        <>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }} data-role="data-tables">
            {schema.report.tables.map(row => (
              <PanelButton
                key={row.name}
                variant={row.name === table ? 'primary' : 'ghost'}
                size="sm"
                className="pico-app-data-table"
                data-table={row.name}
                disabled={row.skipped}
                onClick={() => { setOffset(0); setTable(row.name) }}
              >
                {`${row.name} · ${String(row.rows)} ${t('appCenter.dataRowsCount')}`}
              </PanelButton>
            ))}
          </div>
          {rows.kind === 'loading' && <p style={HINT} data-role="data-rows-loading">{t('appCenter.dataLoading')}</p>}
          {rows.kind === 'failed' && (
            <FailureBlock
              failure={rows.failure}
              role="data-rows-error"
              onRetry={() => { if (table !== null) void loadRows(table, offset, unmask) }}
            />
          )}
          {rows.kind === 'ready' && <RowsTable report={rows.report} />}
          {rows.kind === 'ready' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
              <PanelButton
                variant="ghost"
                size="sm"
                className="pico-app-data-prev"
                disabled={rows.report.offset <= 0}
                onClick={() => { setOffset(Math.max(0, rows.report.offset - PAGE_SIZE)) }}
              >
                {t('appCenter.dataPrev')}
              </PanelButton>
              <span style={{ fontSize: 12 }} data-role="data-page">
                {tCount('appCenter.dataPage', Math.floor(rows.report.offset / PAGE_SIZE) + 1)}
              </span>
              <PanelButton
                variant="ghost"
                size="sm"
                className="pico-app-data-next"
                disabled={!rows.report.hasMore}
                onClick={() => { setOffset(rows.report.offset + PAGE_SIZE) }}
              >
                {t('appCenter.dataNext')}
              </PanelButton>
              {rows.report.hasMore && (
                <span style={{ fontSize: 12, opacity: 0.75 }}>
                  {`${t('appCenter.dataMore')}: ${String(Math.max(0, rows.report.totalRows - rows.report.offset - rows.report.returned))}`}
                </span>
              )}
              {rows.report.maskedColumns.length > 0 && (
                <>
                  <span style={{ fontSize: 12, opacity: 0.75 }} data-role="data-masked-note">{t('appCenter.dataMaskedNote')}</span>
                  <PanelButton
                    variant="ghost"
                    size="sm"
                    className="pico-app-data-unmask"
                    onClick={() => { setUnmask(true) }}
                  >
                    {t('appCenter.dataUnmask')}
                  </PanelButton>
                </>
              )}
              {rows.report.unmasked && (
                <PanelButton
                  variant="ghost"
                  size="sm"
                  className="pico-app-data-remask"
                  onClick={() => { setUnmask(false) }}
                >
                  {t('appCenter.dataRemask')}
                </PanelButton>
              )}
              {rows.report.truncatedValues > 0 && (
                <span style={{ fontSize: 12, opacity: 0.75 }} data-role="data-truncated-note">{t('appCenter.dataTruncatedNote')}</span>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}

/** 行表格：列头 + 值（`***` 就是服务端给的脱敏值，不是客户端替换的）。 */
function RowsTable({ report }: { report: AppRowsReport }): ReactNode {
  if (report.returned === 0) {
    return <p style={HINT} data-role="data-no-rows">{t('appCenter.dataNoRows')}</p>
  }
  return (
    <div style={{ overflowX: 'auto', marginTop: 8 }} data-role="data-rows">
      <table style={{ borderCollapse: 'collapse', fontSize: 12, minWidth: '100%' }}>
        <thead>
          <tr>
            {report.columns.map(col => (
              <th
                key={col.name}
                data-column={col.name}
                data-sensitive={col.sensitive ? 'true' : 'false'}
                style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid rgba(127,127,127,0.35)', whiteSpace: 'nowrap' }}
              >
                {col.name}
                {col.sensitive && <span title={t('appCenter.dataMaskedNote')}>{' *'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row, i) => (
            <tr key={i} data-row={i}>
              {row.map((value, j) => (
                <td key={j} style={{ padding: '4px 8px', verticalAlign: 'top', maxWidth: 320, overflowWrap: 'anywhere' }}>
                  {renderValue(value)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * 渲染一个单元格的值。
 *
 * NULL 与空串必须**可区分**：作者排障时"这一列是 NULL"和"这一列是空字符串"
 * 是完全不同的结论，所以 NULL 渲染成斜体占位符而不是空白。
 * @param value - 服务端回传的标量。
 * @returns 单元格内容。
 */
function renderValue(value: string | number | boolean | null): ReactNode {
  if (value === null) return <em style={{ opacity: 0.6 }}>NULL</em>
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  return value
}

/** 失败块：原样显示服务端错误信封（错误码/消息/细节/建议），不是一句"加载失败"。 */
function FailureBlock({ failure, role, onRetry }: { failure: PublishFailure, role: string, onRetry: () => void }): ReactNode {
  return (
    <div data-role={role} style={{ marginTop: 8, fontSize: 12 }}>
      <p style={{ margin: 0 }}>
        <strong>{failure.code}</strong>
        {failure.message !== '' && `: ${failure.message}`}
      </p>
      {failure.hints.length > 0 && (
        <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
          {failure.hints.map(hint => <li key={hint}>{hint}</li>)}
        </ul>
      )}
      <PanelButton variant="ghost" size="sm" className="pico-app-data-retry" onClick={onRetry}>
        {t('appCenter.retry')}
      </PanelButton>
    </div>
  )
}

const HINT = { fontSize: 12, opacity: 0.8, margin: '6px 0 0' } as const
