import { fetchJson } from './http'
import type { KnowledgeSource, KnowledgeSourceItem, SourceDeps } from './types'

const SUMMARY_URL = 'https://l2beat.com/api/scaling/summary'

/**
 * L2Beat's public summary payload is shaped roughly:
 *   { projects: { [slug]: { name, slug, type, tvl, ... } } }
 * but the actual contract has wobbled across releases. We treat the response
 * as a record map and pull only the fields we render, so a missing key
 * degrades rather than throws.
 */
type L2BeatSummary = {
  projects?: Record<string, L2BeatProject> | L2BeatProject[]
}

type L2BeatProject = {
  id?: string
  slug?: string
  name?: string
  type?: string // 'layer2' | 'layer3' | ...
  category?: string // 'Optimistic Rollup' | 'ZK Rollup' | ...
  hostChain?: string | null
  stage?: string | null // 'Stage 0' | 'Stage 1' | 'Stage 2'
  tvl?: { breakdown?: { total?: number }; total?: number } | number
  isArchived?: boolean
}

function readTvl(p: L2BeatProject): number | null {
  if (typeof p.tvl === 'number') return p.tvl
  const t = p.tvl as L2BeatProject['tvl']
  if (t && typeof t === 'object') {
    if (typeof t.total === 'number') return t.total
    if (t.breakdown && typeof t.breakdown.total === 'number') return t.breakdown.total
  }
  return null
}

function fmtUsd(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return 'n/a'
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  return `$${n.toFixed(0)}`
}

function renderProject(p: L2BeatProject, tvlUsd: number | null): string {
  const lines: string[] = []
  lines.push(`# ${p.name ?? p.slug ?? p.id ?? 'unknown'}`)
  if (p.type) lines.push(`Type: ${p.type}`)
  if (p.category) lines.push(`Category: ${p.category}`)
  if (p.hostChain) lines.push(`Host chain: ${p.hostChain}`)
  if (p.stage) lines.push(`Stage: ${p.stage}`)
  lines.push(`TVL: ${fmtUsd(tvlUsd)}`)
  return lines.join('\n')
}

function projectsToArray(payload: L2BeatSummary): L2BeatProject[] {
  if (!payload.projects) return []
  if (Array.isArray(payload.projects)) return payload.projects
  return Object.values(payload.projects)
}

/**
 * L2Beat scaling summary: one item per non-archived rollup project. The
 * payload's exact shape is treated as best-effort — we degrade per-field
 * rather than throw, since L2Beat occasionally rejigs the schema.
 */
export function createL2BeatSource(deps: SourceDeps = {}): KnowledgeSource {
  return {
    name: 'l2beat:summary',
    async fetch(): Promise<KnowledgeSourceItem[]> {
      const payload = await fetchJson<L2BeatSummary>(SUMMARY_URL, {
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.timeoutMs != null ? { timeoutMs: deps.timeoutMs } : {}),
      })
      const projects = projectsToArray(payload).filter((p) => !p.isArchived)

      return projects.map((p) => {
        const tvlUsd = readTvl(p)
        const slug = p.slug ?? p.id ?? (p.name ?? 'unknown').toLowerCase().replace(/\s+/g, '-')
        return {
          sourceId: slug,
          content: renderProject(p, tvlUsd),
          metadata: {
            type: p.type ?? null,
            category: p.category ?? null,
            stage: p.stage ?? null,
            hostChain: p.hostChain ?? null,
            tvlUsd,
          },
        }
      })
    },
  }
}
