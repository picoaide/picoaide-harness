// @ts-check
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'
import sitemap from '@astrojs/sitemap'

// https://astro.build/config
export default defineConfig({
  site: 'https://www.picoaide.com',
  integrations: [
    sitemap({
      filter: page => !page.includes('/404'),
    }),
    starlight({
      title: 'PicoAide Wiki',
      description: 'PicoAide Harness 部署、使用与开发文档',
      logo: {
        light: '../brands/official/logo.svg',
        dark: '../brands/official/logo-dark.svg',
        replacesTitle: true,
      },
      // 与营销页（src/styles/global.css）同一套强调色 / 字体栈 / 圆角。
      // 只覆盖 Starlight 的公开变量（--sl-color-*），不改它的布局与组件结构。
      customCss: ['./src/styles/starlight.css'],
      defaultLocale: 'root',
      locales: {
        root: { label: '简体中文', lang: 'zh-CN' },
        en: { label: 'English', lang: 'en' },
      },
      sidebar: [
        {
          label: '入门',
          translations: { en: 'Getting started' },
          items: [
            { label: '欢迎', translations: { en: 'Welcome' }, slug: 'welcome' },
            { label: '快速开始', translations: { en: 'Quick start' }, slug: 'getting-started' },
            { label: '产品哲学', translations: { en: 'Philosophy' }, slug: 'philosophy' },
          ],
        },
        {
          label: '产品',
          translations: { en: 'Product' },
          items: [
            { label: '桌面客户端', translations: { en: 'Desktop client' }, slug: 'desktop' },
            { label: '企业管控面', translations: { en: 'Enterprise control plane' }, slug: 'admin' },
            { label: '应用中心', translations: { en: 'App centre' }, slug: 'apps' },
            { label: '安全与合规', translations: { en: 'Security & compliance' }, slug: 'security' },
          ],
        },
        {
          label: '部署',
          translations: { en: 'Deployment' },
          items: [
            { label: '部署总览', translations: { en: 'Deployment overview' }, slug: 'deployment' },
            { label: '容器化部署', translations: { en: 'Container deployment' }, slug: 'deployment/compose' },
            {
              label: '升级、备份与回滚',
              translations: { en: 'Upgrade, backup & rollback' },
              slug: 'deployment/upgrade',
            },
            {
              label: '客户端分发与升级',
              translations: { en: 'Client delivery & updates' },
              slug: 'deployment/client-delivery',
            },
            { label: '渠道与白标', translations: { en: 'Channels & white-label' }, slug: 'deployment/channels' },
            { label: '离线部署', translations: { en: 'Air-gapped deployment' }, slug: 'deployment/offline' },
            {
              label: '运维与排障',
              translations: { en: 'Operations & troubleshooting' },
              slug: 'deployment/operations',
            },
          ],
        },
        {
          label: '架构与扩展',
          translations: { en: 'Architecture & extension' },
          items: [
            { label: '系统架构', translations: { en: 'System architecture' }, slug: 'architecture' },
            { label: '插件开发', translations: { en: 'Plugin development' }, slug: 'plugin-development' },
            { label: '插件生态', translations: { en: 'Plugin ecosystem' }, slug: 'plugin-ecosystem' },
            { label: 'API 参考', translations: { en: 'API reference' }, slug: 'api-reference' },
          ],
        },
        {
          label: '支持',
          translations: { en: 'Support' },
          items: [{ label: '常见问题', translations: { en: 'FAQ' }, slug: 'faq' }],
        },
      ],
    }),
  ],
})
