import { useState } from 'react'
import { Button } from '../components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs'
import { PageHeader } from '../components/page-header'
import { useSearchParams } from 'react-router-dom'
import Marketplace from './Marketplace'
import Agents from './Agents'
import Capabilities from './Capabilities'

/**
 * 能力中心·统一管理面(2026-09-02,与客户端 IA 对齐):
 * 客户端能力中心把「市场(商城)+组织共享」放在一个入口;管理后台此前
 * 分「市场 · 技能」与「能力中心」两个菜单,现合并为单入口——
 * Tab「市场技能」= 商城管理(上架/授权/上下架/归属)、
 * Tab「组织共享」= 统一审批队列 + 锁定管理 + 归属。
 * 兼容:?tab=market|org 直接定位(旧 /marketplace 路由重定向到此)。
 */
export default function CapabilityCenter() {
  const [params, setParams] = useSearchParams()
  const [tab, setTab] = useState<'market' | 'org'>(params.get('tab') === 'org' ? 'org' : 'market')
  // G4: 市场分区内类型切换(技能/智能体)
  const [kind, setKind] = useState<'skill' | 'agent'>(params.get('kind') === 'agent' ? 'agent' : 'skill')

  return (
    <div className="space-y-4">
      <PageHeader
        title="能力中心"
        desc="市场技能与组织共享的统一管理面:上架/审核/锁定/授权/归属,与客户端能力中心对齐"
      />
      <Tabs
        value={tab}
        onValueChange={(v) => {
          setTab(v === 'org' ? 'org' : 'market')
          setParams(v === 'org' ? { tab: 'org' } : {}, { replace: true })
        }}
      >
        <TabsList>
          <TabsTrigger value="market">市场</TabsTrigger>
          <TabsTrigger value="org">组织共享</TabsTrigger>
        </TabsList>
        {tab === 'market' && (
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant={kind === 'skill' ? 'default' : 'outline'} onClick={() => { setKind('skill'); setParams({ tab: 'market', kind: 'skill' }, { replace: true }) }}>技能</Button>
            <Button size="sm" variant={kind === 'agent' ? 'default' : 'outline'} onClick={() => { setKind('agent'); setParams({ tab: 'market', kind: 'agent' }, { replace: true }) }}>智能体</Button>
          </div>
        )}
      </Tabs>
      {tab === 'market' ? (kind === 'agent' ? <Agents /> : <Marketplace />) : <Capabilities />}
    </div>
  )
}
