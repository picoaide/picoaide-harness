import { Inbox } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../lib/utils'

// 统一空状态:图标 + 文案 + 可选操作,居中展示
export function EmptyState({
  icon,
  title,
  desc,
  action,
  className,
}: {
  icon?: ReactNode
  title?: string
  desc?: string
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 py-14 text-center', className)}>
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        {icon ?? <Inbox className="h-5 w-5 text-muted-foreground" />}
      </div>
      <div className="text-sm font-medium text-muted-foreground">{title ?? '暂无数据'}</div>
      {desc && <div className="text-xs text-muted-foreground/70">{desc}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}
