import { describe, expect, it, vi } from 'vitest'
import {
  createDefillamaHacksSource,
  createDefillamaProtocolsSource,
} from '@/knowledge/sources/defillama'
import { createEfBlogSource } from '@/knowledge/sources/ef-blog'
import { createL2BeatSource } from '@/knowledge/sources/l2beat'
import { createSnapshotSource } from '@/knowledge/sources/snapshot'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function textResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/xml' },
  })
}

describe('defillama protocols source', () => {
  it('fetches, ranks, slices to top 50, renders markdown', async () => {
    const protocols = Array.from({ length: 60 }, (_, i) => ({
      name: `Proto${i}`,
      slug: `proto-${i}`,
      tvl: (60 - i) * 1_000_000_000,
      change_1d: 0.0123,
      change_7d: -0.0456,
      category: 'Lending',
      chains: ['Ethereum'],
    }))
    const fetchMock = vi.fn(async () => jsonResponse(protocols))
    const src = createDefillamaProtocolsSource({ fetch: fetchMock as typeof fetch })

    const items = await src.fetch()
    expect(items.length).toBe(50)
    expect(items[0]?.sourceId).toBe('proto-0')
    expect(items[0]?.content).toContain('# Proto0')
    expect(items[0]?.content).toContain('TVL: $60.00B')
    expect(items[0]?.content).toContain('+1.23%')
    expect(items[0]?.metadata?.rank).toBe(1)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('skips protocols with non-numeric tvl', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse([
        { name: 'A', slug: 'a', tvl: 100 },
        { name: 'B', slug: 'b', tvl: null },
        { name: 'C', slug: 'c' },
      ]),
    )
    const src = createDefillamaProtocolsSource({ fetch: fetchMock as typeof fetch })
    const items = await src.fetch()
    expect(items.map((i) => i.sourceId)).toEqual(['a'])
  })
})

describe('defillama hacks source', () => {
  it('keeps only the last 90 days, sorted newest first', async () => {
    const now = Math.floor(Date.now() / 1000)
    const day = 86_400
    const fetchMock = vi.fn(async () =>
      jsonResponse([
        { id: 1, name: 'Old hack', date: now - 200 * day, amount: 5 },
        {
          id: 2,
          name: 'Recent hack',
          date: now - 5 * day,
          amount: 10,
          classification: 'Smart Contract',
        },
        { id: 3, name: 'Mid hack', date: now - 30 * day, amount: 2 },
      ]),
    )
    const src = createDefillamaHacksSource({ fetch: fetchMock as typeof fetch })
    const items = await src.fetch()
    expect(items.length).toBe(2)
    expect(items[0]?.sourceId).toBe('2')
    expect(items[0]?.content).toContain('Loss: $10.0M')
    expect(items[0]?.content).toContain('Classification: Smart Contract')
    expect(items[1]?.sourceId).toBe('3')
  })
})

describe('l2beat source', () => {
  it('reads projects map and skips archived', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        projects: {
          arbitrum: {
            slug: 'arbitrum',
            name: 'Arbitrum One',
            type: 'layer2',
            category: 'Optimistic Rollup',
            stage: 'Stage 1',
            tvl: { breakdown: { total: 12_400_000_000 }, total: 12_400_000_000 },
          },
          dead: {
            slug: 'dead',
            name: 'Dead L2',
            isArchived: true,
            tvl: 0,
          },
        },
      }),
    )
    const src = createL2BeatSource({ fetch: fetchMock as typeof fetch })
    const items = await src.fetch()
    expect(items.length).toBe(1)
    expect(items[0]?.sourceId).toBe('arbitrum')
    expect(items[0]?.content).toContain('# Arbitrum One')
    expect(items[0]?.content).toContain('TVL: $12.40B')
    expect(items[0]?.metadata?.tvlUsd).toBe(12_400_000_000)
  })

  it('handles array-shaped projects payload', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        projects: [{ slug: 'optimism', name: 'Optimism', type: 'layer2', tvl: 5_000_000_000 }],
      }),
    )
    const src = createL2BeatSource({ fetch: fetchMock as typeof fetch })
    const items = await src.fetch()
    expect(items.length).toBe(1)
    expect(items[0]?.sourceId).toBe('optimism')
  })
})

describe('snapshot source', () => {
  it('issues GraphQL POST and renders proposals', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: {
          proposals: [
            {
              id: '0xabc',
              title: 'Deprecate USDT market',
              body: 'Long body here.',
              state: 'active',
              author: '0x1',
              created: 1_700_000_000,
              start: 1_700_100_000,
              end: 1_700_200_000,
              choices: ['For', 'Against'],
              scores: [800_000, 200_000],
              scores_total: 1_000_000,
              space: { id: 'aave.eth', name: 'Aave' },
              link: 'https://snapshot.org/#/aave.eth/proposal/0xabc',
            },
          ],
        },
      }),
    )
    const src = createSnapshotSource({ fetch: fetchMock as typeof fetch, spaces: ['aave.eth'] })
    const items = await src.fetch()

    const call = fetchMock.mock.calls[0] as [string, RequestInit] | undefined
    expect(call?.[0]).toContain('hub.snapshot.org/graphql')
    expect(call?.[1]?.method).toBe('POST')

    expect(items.length).toBe(1)
    expect(items[0]?.sourceId).toBe('0xabc')
    expect(items[0]?.content).toContain('# [Aave] Deprecate USDT market')
    expect(items[0]?.content).toContain('Leading: For (80.0%)')
    expect(items[0]?.content).toContain('Long body here.')
  })

  it('clips long bodies', async () => {
    const longBody = 'x'.repeat(10_000)
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: {
          proposals: [
            {
              id: '1',
              title: 't',
              body: longBody,
              state: 'closed',
              author: '0x1',
              created: 1,
              start: 1,
              end: 2,
              choices: [],
              scores: [],
              scores_total: 0,
              space: { id: 's', name: 's' },
            },
          ],
        },
      }),
    )
    const src = createSnapshotSource({ fetch: fetchMock as typeof fetch, spaces: ['s'] })
    const items = await src.fetch()
    expect(items[0]?.content).toContain('[…body truncated]')
    expect(items[0]?.content.length).toBeLessThan(longBody.length)
  })

  it('throws when GraphQL returns errors array', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ errors: [{ message: 'oops' }] }))
    const src = createSnapshotSource({ fetch: fetchMock as typeof fetch, spaces: ['x'] })
    await expect(src.fetch()).rejects.toThrow(/oops/)
  })
})

describe('ef-blog source', () => {
  it('parses RSS items, decodes entities, strips html in description', async () => {
    const xml = `<?xml version="1.0"?>
<rss><channel>
  <item>
    <title>Pectra activated</title>
    <link>https://blog.ethereum.org/2026/04/01/pectra</link>
    <pubDate>Mon, 01 Apr 2026 00:00:00 +0000</pubDate>
    <description><![CDATA[<p>Pectra is <b>live</b>.</p>]]></description>
    <guid>https://blog.ethereum.org/2026/04/01/pectra</guid>
  </item>
  <item>
    <title>Devcon &amp; recap</title>
    <link>https://blog.ethereum.org/2026/03/15/devcon</link>
    <pubDate>Sat, 15 Mar 2026 00:00:00 +0000</pubDate>
    <description>Devcon happened.</description>
    <guid>https://blog.ethereum.org/2026/03/15/devcon</guid>
  </item>
</channel></rss>`
    const fetchMock = vi.fn(async () => textResponse(xml))
    const src = createEfBlogSource({ fetch: fetchMock as typeof fetch })
    const items = await src.fetch()
    expect(items.length).toBe(2)
    expect(items[0]?.sourceId).toBe('https://blog.ethereum.org/2026/04/01/pectra')
    expect(items[0]?.content).toContain('Pectra activated')
    expect(items[0]?.content).toContain('Pectra is live.')
    expect(items[1]?.content).toContain('Devcon & recap')
  })

  it('falls back to slug-from-link when no guid', async () => {
    const xml = `<rss><channel>
  <item>
    <title>Hello</title>
    <link>https://blog.ethereum.org/2026/05/06/hello-world</link>
    <pubDate>x</pubDate>
    <description>x</description>
  </item>
</channel></rss>`
    const fetchMock = vi.fn(async () => textResponse(xml))
    const src = createEfBlogSource({ fetch: fetchMock as typeof fetch })
    const items = await src.fetch()
    expect(items[0]?.sourceId).toBe('hello-world')
  })
})

describe('http error surface', () => {
  it('throws on non-2xx', async () => {
    const fetchMock = vi.fn(async () => new Response('bad', { status: 500 }))
    const src = createDefillamaProtocolsSource({ fetch: fetchMock as typeof fetch })
    await expect(src.fetch()).rejects.toThrow(/500/)
  })
})
