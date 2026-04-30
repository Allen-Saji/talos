import { fetchJson } from './http'
import type { KnowledgeSource, KnowledgeSourceItem, SourceDeps } from './types'

const PROTOCOLS_URL = 'https://api.llama.fi/protocols'
const HACKS_URL = 'https://api.llama.fi/hacks'

const TOP_PROTOCOLS = 50
const HACKS_LOOKBACK_DAYS = 90

type DefillamaProtocol = {
  id?: string
  name: string
  symbol?: string | null
  url?: string | null
  description?: string | null
  category?: string | null
  chain?: string | null
  chains?: string[]
  slug?: string
  tvl?: number
  change_1d?: number | null
  change_7d?: number | null
  mcap?: number | null
}

type DefillamaHack = {
  id?: number | string
  name: string
  date?: number // unix seconds
  amount?: number | null // millions of USD
  source_url?: string | null
  technique?: string | null
  classification?: string | null
  language?: string | null
  bridgeHack?: boolean | null
  targetType?: string | null
  defillamaId?: string | null
  chain?: string[] | null
  returnedFunds?: number | null
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'n/a'
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`
  return `$${n.toFixed(0)}`
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'n/a'
  const sign = n > 0 ? '+' : ''
  return `${sign}${(n * 100).toFixed(2)}%`
}

function renderProtocol(p: DefillamaProtocol): string {
  const lines: string[] = []
  lines.push(`# ${p.name}${p.symbol ? ` (${p.symbol})` : ''}`)
  if (p.category) lines.push(`Category: ${p.category}`)
  if (p.chain || (p.chains && p.chains.length > 0)) {
    const chains = p.chains?.length ? p.chains.join(', ') : (p.chain ?? '')
    lines.push(`Chains: ${chains}`)
  }
  lines.push(`TVL: ${fmtUsd(p.tvl)}`)
  if (p.change_1d != null) lines.push(`24h change: ${fmtPct(p.change_1d)}`)
  if (p.change_7d != null) lines.push(`7d change: ${fmtPct(p.change_7d)}`)
  if (p.mcap != null) lines.push(`Market cap: ${fmtUsd(p.mcap)}`)
  if (p.url) lines.push(`Website: ${p.url}`)
  if (p.description?.trim()) lines.push('', p.description.trim())
  return lines.join('\n')
}

/**
 * DefiLlama protocols source: top {TOP_PROTOCOLS} by TVL, one item per
 * protocol so retrieval can match queries like "what's Aave's TVL". Each
 * item's metadata carries the raw numeric fields for downstream callers.
 */
export function createDefillamaProtocolsSource(deps: SourceDeps = {}): KnowledgeSource {
  return {
    name: 'defillama:protocols',
    async fetch(): Promise<KnowledgeSourceItem[]> {
      const list = await fetchJson<DefillamaProtocol[]>(PROTOCOLS_URL, {
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.timeoutMs != null ? { timeoutMs: deps.timeoutMs } : {}),
      })
      const ranked = list
        .filter((p) => typeof p.tvl === 'number' && Number.isFinite(p.tvl))
        .sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0))
        .slice(0, TOP_PROTOCOLS)

      return ranked.map((p, i) => ({
        sourceId: p.slug ?? p.name.toLowerCase().replace(/\s+/g, '-'),
        content: renderProtocol(p),
        metadata: {
          rank: i + 1,
          tvlUsd: p.tvl ?? null,
          change1d: p.change_1d ?? null,
          change7d: p.change_7d ?? null,
          category: p.category ?? null,
          chains: p.chains ?? (p.chain ? [p.chain] : []),
          url: p.url ?? null,
        },
      }))
    },
  }
}

function renderHack(h: DefillamaHack): string {
  const dateIso = h.date ? new Date(h.date * 1000).toISOString().slice(0, 10) : 'unknown'
  const amount = h.amount != null ? `$${h.amount.toFixed(1)}M` : 'undisclosed'
  const lines: string[] = []
  lines.push(`# ${h.name}`)
  lines.push(`Date: ${dateIso}`)
  lines.push(`Loss: ${amount}`)
  if (h.classification) lines.push(`Classification: ${h.classification}`)
  if (h.technique) lines.push(`Technique: ${h.technique}`)
  if (h.targetType) lines.push(`Target: ${h.targetType}`)
  if (h.chain && h.chain.length > 0) lines.push(`Chains: ${h.chain.join(', ')}`)
  if (h.bridgeHack) lines.push('Bridge hack: yes')
  if (h.returnedFunds != null && h.returnedFunds > 0) {
    lines.push(`Returned funds: $${h.returnedFunds.toFixed(1)}M`)
  }
  if (h.source_url) lines.push(`Source: ${h.source_url}`)
  return lines.join('\n')
}

/**
 * DefiLlama hacks source: incidents within the last {HACKS_LOOKBACK_DAYS}
 * days, one item per hack. The agent can cite recent exploits when a user
 * asks about a protocol.
 */
export function createDefillamaHacksSource(deps: SourceDeps = {}): KnowledgeSource {
  return {
    name: 'defillama:hacks',
    async fetch(): Promise<KnowledgeSourceItem[]> {
      const list = await fetchJson<DefillamaHack[]>(HACKS_URL, {
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.timeoutMs != null ? { timeoutMs: deps.timeoutMs } : {}),
      })
      const cutoff = Date.now() / 1000 - HACKS_LOOKBACK_DAYS * 86_400
      const recent = list
        .filter((h) => typeof h.date === 'number' && (h.date as number) >= cutoff)
        .sort((a, b) => (b.date ?? 0) - (a.date ?? 0))

      return recent.map((h) => ({
        sourceId: h.id != null ? String(h.id) : h.name.toLowerCase().replace(/\s+/g, '-'),
        content: renderHack(h),
        metadata: {
          dateUnix: h.date ?? null,
          amountMUsd: h.amount ?? null,
          classification: h.classification ?? null,
          technique: h.technique ?? null,
          chains: h.chain ?? [],
          sourceUrl: h.source_url ?? null,
        },
      }))
    },
  }
}
