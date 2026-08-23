import { type ReactNode } from 'react'
import { cn } from '../lib/utils'

// 企业级页面头部:大标题 + 描述 + 右侧操作区(统一所有页面 header 观感)
export function PageHeader({
  title,
  desc,
  actions,
  className,
}: {
  title: string
  desc?: string
  actions?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-3', className)}>
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <span className="h-4 w-1 rounded-full bg-[#1E40AF]" />
          <h1 className="page-title">{title}</h1>
        </div>
        {desc && <p className="page-desc mt-1.5 pl-3.5">{desc}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}
