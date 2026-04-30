import { fetchGraphql } from './http'
import type { KnowledgeSource, KnowledgeSourceItem, SourceDeps } from './types'

const SNAPSHOT_URL = 'https://hub.snapshot.org/graphql'

/**
 * Default ENS-like Snapshot space ids for the major DAOs Talos cares about.
 * Override via `createSnapshotSource({ spaces: [...] })`. Add freely — the
 * GraphQL `space_in` filter accepts any number.
 */
export const DEFAULT_SNAPSHOT_SPACES = [
  'aave.eth',
  'uniswapgovernance.eth',
  'uniswap',
  'lido-snapshot.eth',
  'curve.eth',
  'ens.eth',
  'compoundgovernance.eth',
  'arbitrumfoundation.eth',
  'opcollective.eth',
] as const

const QUERY = `
  query RecentProposals($spaces: [String]!, $first: Int!) {
    proposals(
      first: $first
      orderBy: "created"
      orderDirection: desc
      where: { space_in: $spaces }
    ) {
      id
      title
      body
      state
      author
      created
      start
      end
      choices
      scores
      scores_total
      space { id name }
      link
    }
  }
`

type SnapshotProposal = {
  id: string
  title: string
  body: string
  state: 'pending' | 'active' | 'closed' | string
  author: string
  created: number
  start: number
  end: number
  choices: string[]
  scores: number[]
  scores_total: number
  space: { id: string; name?: string | null }
  link?: string | null
}

type ProposalsResponse = { proposals: SnapshotProposal[] }

const SNAPSHOT_BODY_CHAR_LIMIT = 4_000

function clipBody(body: string): string {
  const trimmed = body.trim()
  if (trimmed.length <= SNAPSHOT_BODY_CHAR_LIMIT) return trimmed
  return `${trimmed.slice(0, SNAPSHOT_BODY_CHAR_LIMIT)}\n\n[…body truncated]`
}

function leadingChoice(p: SnapshotProposal): string | null {
  if (!p.choices.length || !p.scores.length) return null
  let bestIdx = 0
  for (let i = 1; i < p.scores.length; i++) {
    if ((p.scores[i] ?? 0) > (p.scores[bestIdx] ?? 0)) bestIdx = i
  }
  const total = p.scores_total || 0
  const pct = total > 0 ? ((p.scores[bestIdx] ?? 0) / total) * 100 : 0
  return `${p.choices[bestIdx]} (${pct.toFixed(1)}%)`
}

function renderProposal(p: SnapshotProposal): string {
  const lines: string[] = []
  lines.push(`# [${p.space.name ?? p.space.id}] ${p.title}`)
  lines.push(`State: ${p.state}`)
  lines.push(`Created: ${new Date(p.created * 1000).toISOString().slice(0, 10)}`)
  lines.push(
    `Voting: ${new Date(p.start * 1000).toISOString().slice(0, 10)} -> ${new Date(p.end * 1000).toISOString().slice(0, 10)}`,
  )
  const lead = leadingChoice(p)
  if (lead) lines.push(`Leading: ${lead}`)
  if (p.link) lines.push(`Link: ${p.link}`)
  if (p.body && p.body.trim().length > 0) {
    lines.push('', clipBody(p.body))
  }
  return lines.join('\n')
}

export type SnapshotDeps = SourceDeps & {
  /** Snapshot space ids to query. Defaults to {DEFAULT_SNAPSHOT_SPACES}. */
  spaces?: readonly string[]
  /** Max proposals to fetch (newest first). Default 30. */
  limit?: number
}

/**
 * Snapshot proposals source: latest proposals across the configured DAOs,
 * one item per proposal. Long bodies are clipped to keep the embedded chunk
 * count reasonable; the full body is reachable via the `link` line.
 */
export function createSnapshotSource(deps: SnapshotDeps = {}): KnowledgeSource {
  const spaces = deps.spaces ?? DEFAULT_SNAPSHOT_SPACES
  const limit = deps.limit ?? 30

  return {
    name: 'snapshot:proposals',
    async fetch(): Promise<KnowledgeSourceItem[]> {
      const data = await fetchGraphql<ProposalsResponse>(SNAPSHOT_URL, QUERY, {
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.timeoutMs != null ? { timeoutMs: deps.timeoutMs } : {}),
        variables: { spaces, first: limit },
      })
      return data.proposals.map((p) => ({
        sourceId: p.id,
        content: renderProposal(p),
        metadata: {
          space: p.space.id,
          state: p.state,
          createdUnix: p.created,
          startUnix: p.start,
          endUnix: p.end,
          link: p.link ?? null,
        },
      }))
    },
  }
}
