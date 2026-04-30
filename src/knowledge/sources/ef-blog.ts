import { fetchText } from './http'
import type { KnowledgeSource, KnowledgeSourceItem, SourceDeps } from './types'

const FEED_URL = 'https://blog.ethereum.org/feed.xml'
const POSTS_LIMIT = 30

/**
 * Hand-rolled RSS extractor. Pulls the `<item>` blocks and reads the inner
 * `<title>`, `<link>`, `<pubDate>`, `<description>` fields. We avoid pulling
 * a real XML parser dep — the EF feed is well-formed and the blogosphere is
 * forgiving to the regex approach.
 */
type RssItem = {
  title: string
  link: string
  pubDate: string
  description: string
  guid: string
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function readField(block: string, tag: string): string {
  const cdata = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i')
  const m1 = block.match(cdata)
  if (m1?.[1] != null) return decodeEntities(m1[1].trim())
  const plain = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i')
  const m2 = block.match(plain)
  if (m2?.[1] != null) return decodeEntities(m2[1].trim())
  return ''
}

function parseFeed(xml: string): RssItem[] {
  const items: RssItem[] = []
  const itemRe = /<item\b[\s\S]*?<\/item>/gi
  for (const match of xml.matchAll(itemRe)) {
    const block = match[0]
    items.push({
      title: readField(block, 'title'),
      link: readField(block, 'link'),
      pubDate: readField(block, 'pubDate'),
      description: readField(block, 'description'),
      guid: readField(block, 'guid'),
    })
  }
  return items
}

function slugFromLink(link: string, fallback: string): string {
  try {
    const u = new URL(link)
    const last = u.pathname.split('/').filter(Boolean).pop()
    if (last) return last.toLowerCase()
  } catch {
    // fall through
  }
  return (
    fallback
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'post'
  )
}

function renderPost(item: RssItem): string {
  const lines: string[] = []
  lines.push(`# ${item.title}`)
  if (item.pubDate) lines.push(`Published: ${item.pubDate}`)
  if (item.link) lines.push(`Link: ${item.link}`)
  const summary = stripHtml(item.description)
  if (summary.length > 0) lines.push('', summary)
  return lines.join('\n')
}

/**
 * Ethereum Foundation blog: latest posts via RSS. ETH-level signal —
 * hardforks, EIPs going live, devcon notes. Daily refresh fits the cadence
 * (posts are weekly+ on a busy month).
 */
export function createEfBlogSource(deps: SourceDeps = {}): KnowledgeSource {
  return {
    name: 'ef-blog',
    async fetch(): Promise<KnowledgeSourceItem[]> {
      const xml = await fetchText(FEED_URL, {
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.timeoutMs != null ? { timeoutMs: deps.timeoutMs } : {}),
      })
      const items = parseFeed(xml).slice(0, POSTS_LIMIT)
      return items.map((item) => {
        const sourceId =
          item.guid && item.guid.length > 0 ? item.guid : slugFromLink(item.link, item.title)
        return {
          sourceId,
          content: renderPost(item),
          metadata: {
            link: item.link || null,
            pubDate: item.pubDate || null,
          },
        }
      })
    },
  }
}
