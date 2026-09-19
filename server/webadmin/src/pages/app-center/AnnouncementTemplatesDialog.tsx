import { useState } from 'react'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { copyText } from '../../lib/clipboard'
import { useFlash } from '../../lib/use-flash'
import { Check, Copy } from 'lucide-react'
import {
  ACCESS_LEGACY_PUBLIC,
  LEGACY_ACCESS_EXPLAIN,
  accessLevelRejectionMessage,
} from './access-level'
import { ANNOUNCEMENT_PLACEHOLDERS, ANNOUNCEMENT_TEMPLATES } from './announcements'

/**
 * 「公告模板」对话框（契约 §19 Q13：访问级别筛选 + **面向员工的公告模板**）。
 *
 * 为什么放在应用页：这次改造的两个变化（历史 `public` 退役、应用只在客户端内打开）
 * 都是**员工可感知**的 —— 不通知就会出现"浏览器里打不开、以为系统坏了"的工单。
 * 管理员在这里一键复制、替换 `<…>` 占位符后发出即可。
 *
 * 细节：
 *   - 复制走 `lib/clipboard.copyText`（http 内网无 navigator.clipboard 时回落
 *     execCommand）；**失败必须明说"请手动选择复制"**，不假装成功。
 *   - 对话框里同时给出写侧口径（两值 + public 已退役），免得管理员回到应用配置里
 *     又去试 `public`（服务端会以 APP_CONFIG_INVALID 拒绝）。
 */

export function AnnouncementTemplatesDialog({ open, onOpenChange }: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [copied, setCopied] = useState('')
  const [failed, setFailed] = useState('')
  const [flashMsg, flash] = useFlash()

  const copy = async (id: string, body: string) => {
    const ok = await copyText(body)
    if (ok) {
      setFailed('')
      setCopied(id)
      flash('已复制公告全文')
      return
    }
    setCopied('')
    setFailed(id)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl" data-testid="announcement-dialog">
        <DialogHeader>
          <DialogTitle>公告模板</DialogTitle>
          <DialogDescription>
            把下面的文案发给员工：本次改造有两处变化必须告知 —— 访问级别收敛（历史匿名公开退役）
            与应用只在桌面客户端内打开。复制后请替换掉 {'<…>'} 占位符再发。
          </DialogDescription>
        </DialogHeader>

        {/* 写侧口径（唯一一份校验消息）：两值 + public 已退役。 */}
        <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground" data-testid="announcement-access-rule">
          {accessLevelRejectionMessage(ACCESS_LEGACY_PUBLIC)}（{LEGACY_ACCESS_EXPLAIN}）
        </p>
        <p className="text-xs text-muted-foreground" data-testid="announcement-placeholders">
          占位符：{ANNOUNCEMENT_PLACEHOLDERS.join('、')}
        </p>

        {flashMsg && (
          <p role="status" aria-live="polite" className="text-xs text-muted-foreground" data-testid="announcement-flash">
            {flashMsg}
          </p>
        )}

        <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
          {ANNOUNCEMENT_TEMPLATES.map((t) => (
            <section key={t.id} className="space-y-2 rounded-md border p-3" data-testid={`announcement-${t.id}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold">{t.title}</h3>
                  <Badge variant={t.audience === '管理员' ? 'secondary' : 'outline'}>{t.audience}</Badge>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid={`announcement-copy-${t.id}`}
                  onClick={() => { void copy(t.id, t.body) }}
                >
                  {copied === t.id
                    ? <><Check className="mr-1 h-4 w-4" />已复制</>
                    : <><Copy className="mr-1 h-4 w-4" />复制全文</>}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{t.summary}</p>
              <pre
                data-testid={`announcement-body-${t.id}`}
                className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/60 p-2 text-[11px] leading-relaxed"
              >
                {t.body}
              </pre>
              {failed === t.id && (
                <p role="alert" aria-live="assertive" data-testid={`announcement-copy-failed-${t.id}`} className="text-xs text-destructive">
                  复制失败（浏览器未授予剪贴板权限）：请在上面的正文里手动选择并复制。
                </p>
              )}
            </section>
          ))}
        </div>

        <div className="flex justify-end">
          <Button variant="outline" onClick={() => { onOpenChange(false) }}>关闭</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
