import { defineCollection, z } from 'astro:content'
import { glob } from 'astro/loaders'
import { docsSchema } from '@astrojs/starlight/schema'

// 博客集合（本站管理）
const blog = defineCollection({
  loader: glob({ pattern: '**/[^_]*.{md,mdx}', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    tags: z.array(z.string()).default([]),
    author: z.string().default('PicoAide Team'),
    cover: z.string().optional(),
    draft: z.boolean().default(false),
  }),
})

// Wiki 文档集合（Starlight 官方 schema）
const docs = defineCollection({
  loader: glob({ pattern: '**/[^_]*.{md,mdx}', base: './src/content/docs' }),
  schema: docsSchema(),
})

export const collections = { blog, docs }
