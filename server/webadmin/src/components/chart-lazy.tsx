// 懒加载 VChart(性能优化 2026-P):官方全量入口 @visactor/vchart 约 2.3MB,
// 只会渲染 line/pie/bar 三类图;此处用官方按需入口 vchart-simple 构造
// VChart(仅注册 line/bar/area/pie/common + label/crosshair/tooltip/legend/
// 笛卡尔轴/动画),再配合 React.lazy 动态 import 拆成独立 chunk:
//   - Usage 主 chunk 不再携带图表库,首屏/页面骨架先渲染
//   - 图表库 chunk: 全量 676KB(gz) → 按需 ~182KB(gz)
// 与 @visactor/react-vchart 的 VChart 用法兼容(spec/onClick/className 透传)。
import React, { Suspense } from 'react'
import type { ISpec } from '@visactor/vchart'

// 动态 import:打包器把 vchart 单独切分,不进入 Usage 主 chunk
const VChartLazy = React.lazy(async () => {
  const { createChart } = await import('@visactor/react-vchart/esm/charts/BaseChart')
  const { VChart: SimpleVChart } = await import('@visactor/vchart/esm/vchart-simple')
  // vchart-simple 内置注册 line/bar/area/pie/common 及其轴/图例/tooltip/label
  const VChart = createChart('PicoVChart', { vchartConstructor: SimpleVChart })
  return { default: VChart }
})

// 与 <VChart spec={...} onClick={...}> 兼容的公开 props(不含内部 vchartConstructor)
export interface ChartLazyProps {
  spec: ISpec
  [key: string]: unknown
}

export function ChartLazy({ spec, ...props }: ChartLazyProps) {
  return (
    <Suspense
      fallback={
        <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
          图表加载中…
        </div>
      }
    >
      <VChartLazy {...(props as any)} spec={spec} />
    </Suspense>
  )
}
