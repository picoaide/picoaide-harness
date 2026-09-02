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
      defaultLocale: 'root',
      locales: {
        root: { label: '简体中文', lang: 'zh-CN' },
        en: { label: 'English', lang: 'en' },
      },
      sidebar: [
        {
          label: '入门',
          items: [
            { label: '欢迎', slug: 'welcome' },
            { label: '快速开始', slug: 'getting-started' },
            { label: '产品哲学', slug: 'philosophy' },
          ],
        },
        {
          label: '使用',
          items: [
            { label: '桌面客户端', slug: 'desktop' },
            { label: '管理后台', slug: 'admin' },
          ],
        },
        {
          label: '部署',
          items: [{ label: '私有化部署指南', slug: 'deployment' }],
        },
        {
          label: '开发',
          items: [
            { label: '插件开发', slug: 'plugin-development' },
            { label: '插件生态', slug: 'plugin-ecosystem' },
            { label: 'API 参考', slug: 'api-reference' },
          ],
        },
        {
          label: '架构',
          items: [{ label: '系统架构', slug: 'architecture' }],
        },
        {
          label: '支持',
          items: [{ label: '常见问题', slug: 'faq' }],
        },
      ],
    }),
  ],
})
