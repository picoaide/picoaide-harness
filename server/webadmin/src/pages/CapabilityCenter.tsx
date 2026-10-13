import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs'
import { PageHeader } from '../components/page-header'
import { useSearchParams } from 'react-router-dom'
import Marketplace from './Marketplace'
import Agents from './Agents'
import Capabilities from './Capabilities'
import BuiltinSkills from './BuiltinSkills'

/**
 * 能力中心·统一管理面(2026-09-04 IA 定案):
 *   技能  = 技能市场(官方技能蓝标 / 员工上传技能, 独立页面组件)
 *   智能体 = 智能体市场(官方智能体蓝标 / 员工上传智能体, 独立页面组件)
 *   审批  = 唯一交叉点:统一审批队列(技能+智能体, 类型筛选)
 *   平台内置 = 服务端镜像里带的技能(只读,2026-09-19 新增):员工侧「能力中心 → 平台内置」
 *            按需安装的那些技能在这儿看得到;坏掉的技能(被跳过)连原因一起显示。
 * 兼容:?tab=market(旧)→技能、?kind=agent→智能体、?tab=org→审批、?tab=builtin→平台内置。
 *
 * P3: tab 由 URL 派生(单一真源)——原来用 useState(initial) 只在挂载时读一次,
 * 浏览器前进/后退或站内链接改 ?tab=/?kind= 后,Tab 高亮与实际内容不同步。
 */
type TabKey = 'skill' | 'agent' | 'org' | 'builtin'

/**
 * 能力中心的**变体哨兵串**（P3；命名 = `picoaide.feature.<模块>.v1`，模块名 `skills`
 * 与 Go 侧 `-tags`、渠道配置 `features` 逐字一致）。
 *
 * 用途：产物级判据 `scripts/check-feature-chunks.mjs` 在 dist 里按这个串做**双侧**存在性
 * 断言 —— 开启变体里必须出现、关闭变体里必须不出现。两条纪律（与 P0 §6 同口径）：
 *   1. 它必须落在**该页面真的会渲染**的那条路径上（这里作为根元素的 data 属性渲染出去），
 *      不能只躺在一个常量模块里 —— 没被引用的字符串会被打包器一起丢掉，那样"产物里没有
 *      这个串"就既可能是"模块被裁掉了"、也可能只是"串被优化掉了"，判据失去意义；
 *   2. 判据必须**双侧**：只判"关闭变体里没有"是恒真的（一个空产物也满足）。
 */
export const FEATURE_SENTINEL = 'picoaide.feature.skills.v1'

export default function CapabilityCenter() {
  const [params, setParams] = useSearchParams()
  const tab: TabKey = params.get('tab') === 'org'
    ? 'org'
    : params.get('tab') === 'builtin'
      ? 'builtin'
      : params.get('kind') === 'agent'
        ? 'agent'
        : 'skill'

  return (
    <div className="space-y-4" data-feature-sentinel={FEATURE_SENTINEL}>
      <PageHeader
        title="能力中心"
        desc="技能 / 智能体 / 审批 / 平台内置:官方蓝标、员工上传审批与授权、锁定管理"
      />
      <Tabs
        value={tab}
        onValueChange={(v) => {
          const next = (v === 'agent' || v === 'org' || v === 'builtin' ? v : 'skill') as TabKey
          setParams(
            next === 'org' || next === 'builtin' ? { tab: next } : { tab: 'market', kind: next },
            { replace: true },
          )
        }}
      >
        <TabsList>
          <TabsTrigger value="skill">技能</TabsTrigger>
          <TabsTrigger value="agent">智能体</TabsTrigger>
          <TabsTrigger value="org">审批</TabsTrigger>
          <TabsTrigger value="builtin">平台内置</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === 'skill'
        ? <Marketplace />
        : tab === 'agent'
          ? <Agents />
          : tab === 'org'
            ? <Capabilities />
            : <BuiltinSkills />}
    </div>
  )
}
