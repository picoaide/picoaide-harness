import React from 'react'
import { Input } from './ui/input'
import { Eye, EyeOff } from 'lucide-react'

// 密码/密钥输入(审计修复 P3-4):显隐切换按钮,复用 Input 样式;
// 密码管理工具与粘贴不受影响。Gateway(上游 API Key)与 Auth(LDAP/OIDC
// 密钥)共用,禁止复制粘贴。
export function SecretInput(props: React.ComponentProps<'input'>) {
  const [show, setShow] = React.useState(false)
  return (
    <div className="relative">
      <Input
        {...props}
        type={show ? 'text' : 'password'}
        className={`pr-9 ${props.className ?? ''}`}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={show ? '隐藏' : '显示'}
        onClick={() => setShow((s) => !s)}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  )
}
