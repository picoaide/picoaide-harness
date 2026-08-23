import rss from '@astrojs/rss'
import type { APIContext } from 'astro'
import { getCollection } from 'astro:content'

export async function GET(context: APIContext) {
  const posts = await getCollection('blog', ({ data }) => !data.draft)
  return rss({
    title: 'PicoAide Harness',
    description: 'PicoAide Harness 产品动态、技术文章与最佳实践。',
    site: context.site ?? 'https://www.picoaide.com',
    items: posts.map(post => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.pubDate,
      link: `/blog/${post.id}/`,
    })),
  })
}
