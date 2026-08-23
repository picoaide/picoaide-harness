---
title: 插件开发
description: 如何开发 PicoAide Harness 插件。
---

## 插件机制

一切都以插件方式组合。桌面壳本身就是一个合法的 DSH 插件，通过官方 Cordis 插件机制与官方能力组合进同一个运行时。

## 客户端插件

客户端插件使用 `clientBundle` 预设构建，外部依赖对齐平台模块表。

## 服务端插件

服务类包默认导出服务类；函数插件仅命名导出 `name` / `inject` / `Config` / `apply`。

## 约束

- 跨包客户端 import 被禁止，通过 `ctx.slots.inject` 注入，目标包在自己的 client 里 `ctx.slots.register` 注册
- 类型检查时使用 `skipLibCheck: true` 规避上游类型错误
- 每个包自带 `./invariant` 子路径

更多细节见仓库中的文档与包级 README。
