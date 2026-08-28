import { useCallback, useEffect, useState } from 'react'
import { request } from '../api'
import { Badge } from '../components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog'
import { AlertTriangle, Download } from 'lucide-react'

export interface ArchivePreviewData {
  files: string[]
  skill_md?: string
  composition?: string
}

interface FileContentData {
  path: string
  size: number
  binary: boolean
  too_large: boolean
  content: string
}

interface Props {
  /** 预览弹窗 key(空 = 关闭),用于标题展示与加载去重 */
  openKey: string
  /** 归档预览数据(列表/主文件内容) */
  data: ArchivePreviewData | null
  /** 顶部主文件标题(SKILL.md / agent.cordis.yml) */
  mainTitle: string
  /** 主文件内容 */
  mainContent: string
  /** 单文件内容端点前缀,如 /api/admin/shared-skills/xxx/1.0.0 */
  fileBase: string
  onClose: () => void
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * ArchivePreviewDialog 审核归档内容弹窗:展示主文件(SKILL.md /
 * agent.cordis.yml)全文与文件清单;文件清单可点击,按需查看任意
 * 文件内容(文本内联、二进制/超大标记、不存在则提示)。
 */
export function ArchivePreviewDialog({ openKey, data, mainTitle, mainContent, fileBase, onClose }: Props) {
  const [selected, setSelected] = useState<{ path: string; loading: boolean } | null>(null)
  const [file, setFile] = useState<FileContentData | null>(null)
  const [fileError, setFileError] = useState('')

  // 切换技能/重新打开时清空选择。
  useEffect(() => {
    setSelected(null)
    setFile(null)
    setFileError('')
  }, [openKey])

  const loadFile = useCallback(async (path: string) => {
    setSelected({ path, loading: true })
    setFile(null)
    setFileError('')
    try {
      const data = await request<FileContentData>(
        `${fileBase}/file?path=${encodeURIComponent(path)}`)
      setFile(data)
    } catch (err: any) {
      setFileError(err.message ?? '加载失败')
    } finally {
      setSelected(prev => prev?.path === path ? { ...prev, loading: false } : prev)
    }
  }, [fileBase])

  return (
    <Dialog open={openKey !== ''} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>内容预览: {openKey}</DialogTitle>
          <DialogDescription>归档文件可逐一点击查看内容(用于决策审核)</DialogDescription>
        </DialogHeader>
        {data === null ? (
          <p className="text-sm text-muted-foreground">加载中…</p>
        ) : (
          <div className="space-y-3">
            <div>
              <h4 className="mb-1 text-sm font-medium">{mainTitle}</h4>
              <pre className="max-h-56 overflow-auto rounded-md bg-muted p-3 text-xs">{mainContent || '—'}</pre>
            </div>
            <div>
              <h4 className="mb-1 text-sm font-medium">文件清单（{data.files.length}）</h4>
              <div className="flex max-h-56 flex-wrap gap-1 overflow-auto">
                {data.files.map(f => {
                  const active = selected?.path === f
                  return (
                    <button
                      key={f}
                      type="button"
                      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 font-mono text-[11px] transition-colors ${
                        active
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-background hover:border-primary hover:text-primary'
                      }`}
                      onClick={() => { void loadFile(f) }}
                      title="点击查看内容"
                    >
                      {f}
                    </button>
                  )
                })}
              </div>
            </div>
            {selected !== null && (
              <div className="rounded-md border p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h4 className="font-mono text-sm font-medium">{selected.path}</h4>
                  <div className="flex items-center gap-2">
                    {file?.too_large && (
                      <Badge variant="destructive">
                        <AlertTriangle className="mr-1 h-3 w-3" /> 文件过大，
                        <a
                          href={`${fileBase}/archive`}
                          className="underline"
                          target="_blank"
                          rel="noreferrer"
                        >
                          下载归档查看
                        </a>
                      </Badge>
                    )}
                    {file?.binary && (
                      <Badge variant="secondary">二进制文件(不可预览)</Badge>
                    )}
                    {file && (
                      <span className="text-xs text-muted-foreground">{fmtSize(file.size)}</span>
                    )}
                  </div>
                </div>
                {selected.loading ? (
                  <p className="text-sm text-muted-foreground">加载中…</p>
                ) : fileError ? (
                  <p className="text-sm text-destructive">{fileError}</p>
                ) : file?.binary || file?.too_large ? (
                  <p className="text-sm text-muted-foreground">
                    <Download className="mr-1 inline h-3 w-3" />
                    该文件不支持内联预览,请下载归档后本地查看
                  </p>
                ) : (
                  <pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap break-all">{file?.content ?? ''}</pre>
                )}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
