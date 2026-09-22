// React Router v6 的 v7 未来开关（唯一真源，App 与测试共用）。
//
// 不开这两个开关时，react-router 6.30 会在**每个 Router 实例**挂载后打两行
// 「⚠️ React Router Future Flag Warning」（RTL 的 stderr 里每个测试文件各一次，
// 开发态浏览器控制台每次进页面各一次）。开关本身就是 v7 的行为：
//   * v7_startTransition   —— 导航引发的状态更新走 React.startTransition（可中断更新）；
//   * v7_relativeSplatPath —— splat 路由内部的相对路径按 v7 口径解析。
// 本应用路由表里没有任何带子路由的 splat（唯一的 `*` 是顶层 NotFound），
// 所以第二个开关在本仓是**纯等价**切换；第一个的实际效果只是导航更新降级为
// 非紧急更新（React 18 已具备该能力）。
//
// 为什么收成一份常量：App 与 10 处测试各自写字面量时，只要有一处漏写，
// 警告就只消失一半，而且没人能一眼看出是哪边漏了。
export const ROUTER_FUTURE = {
  v7_startTransition: true,
  v7_relativeSplatPath: true,
} as const
