import * as React from 'react'
import { cn } from '../../lib/utils'

// 原生 checkbox(shadcn 风格):受控,带 label 场景用 CheckboxItem
export const Checkbox = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      type="checkbox"
      ref={ref}
      className={cn(
        'h-4 w-4 shrink-0 cursor-pointer appearance-none rounded-sm border border-input bg-background',
        'checked:bg-primary checked:border-primary checked:bg-[url("data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%20fill=%27none%27%20stroke=%27white%27%20stroke-width=%273%27%20stroke-linecap=%27round%27%20stroke-linejoin=%27round%27%3E%3Cpath%20d=%27M20%206L9%2017l-5-5%27/%3E%3C/svg%3E")] bg-center bg-no-repeat',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
)
Checkbox.displayName = 'Checkbox'
