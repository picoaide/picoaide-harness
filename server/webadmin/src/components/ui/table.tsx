import * as React from 'react'
import { cn } from '../../lib/utils'

const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    <div className="relative w-full min-w-0 overflow-auto">
      <table ref={ref} className={cn('w-full caption-bottom text-sm', className)} {...props} />
    </div>
  )
)
Table.displayName = 'Table'

const TableHeader = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <thead
      ref={ref}
      className={cn(
        // sticky 表头(数据面板规范):滚动时列名保持可见
        'sticky top-0 z-10 [&_tr]:border-b [&_tr]:bg-muted/60 [&_tr]:backdrop-blur-sm',
        className,
      )}
      {...props}
    />
  )
)
TableHeader.displayName = 'TableHeader'

const TableBody = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <tbody ref={ref} className={cn('[&_tr:last-child]:border-0', className)} {...props} />
  )
)
TableBody.displayName = 'TableBody'

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn(
        // data-dense:36px 行高 + hover 浅蓝高亮(200ms 过渡)
        'h-9 border-b transition-colors duration-200 hover:bg-accent/50 data-[state=selected]:bg-accent/60',
        className,
      )}
      {...props}
    />
  )
)
TableRow.displayName = 'TableRow'

const TableHead = React.forwardRef<HTMLTableCellElement, React.ThHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <th
      ref={ref}
      className={cn(
        // 企业级表头:12px 大写 + Fira Code 数字列 + 浅蓝底
        'h-9 px-3 text-left align-middle text-[11px] font-semibold uppercase tracking-wider text-slate-500',
        className,
      )}
      {...props}
    />
  )
)
TableHead.displayName = 'TableHead'

const TableCell = React.forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <td ref={ref} className={cn('px-3 py-2 text-sm align-middle', className)} {...props} />
  )
)
TableCell.displayName = 'TableCell'

export { Table, TableHeader, TableBody, TableHead, TableRow, TableCell }
