import { useState } from 'react'
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs'
import { PageHeader } from '../components/page-header'
import { useSearchParams } from 'react-router-dom'
import Marketplace from './Marketplace'
import Agents from './Agents'
import Capabilities from './Capabilities'

/**
 * 能力中心·统一管理面(2026-09-04 IA 定案):
 * 技能与智能体是两个独立的东西——三个一级 Tab:
 *   技能  = 技能市场(官方技能蓝标 / 员工上传技能, 独立页面组件)
 *   智能体 = 智能体市场(官方智能体蓝标 / 员工上传智能体, 独立页面组件)
 *   审批  = 唯一交叉点:统一审批队列(技能+智能体, 类型筛选)
 * 兼容:?tab=market(旧)→技能、?kind=agent→智能体、?tab=org→审批。
 */
export default function CapabilityCenter() {
  const [params, setParams] = useSearchParams()
  const initial = params.get('tab') === 'org'
    ? 'org'
    : params.get('kind') === 'agent'
      ? 'agent'
      : 'skill'
  const [tab, setTab] = useState<'skill' | 'agent' | 'org'>(initial)

  return (
    <div className="space-y-4">
      <PageHeader
        title="能力中心"
        desc="技能 / 智能体 / 审批:官方蓝标、员工上传审批与授权、锁定管理"
      />
      <Tabs
        value={tab}
        onValueChange={(v) => {
          const next = (v === 'agent' || v === 'org' ? v : 'skill') as 'skill' | 'agent' | 'org'
          setTab(next)
          setParams(next === 'org' ? { tab: 'org' } : { tab: 'market', kind: next }, { replace: true })
        }}
      >
        <TabsList>
          <TabsTrigger value="skill">技能</TabsTrigger>
          <TabsTrigger value="agent">智能体</TabsTrigger>
          <TabsTrigger value="org">审批</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === 'skill' ? <Marketplace /> : tab === 'agent' ? <Agents /> : <Capabilities />}
    </div>
  )
}
