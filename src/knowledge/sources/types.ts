/**
 * One document from a knowledge source. Sources own their `sourceId` choice;
 * the cron uses `(name, sourceId)` as the idempotency key when persisting.
 */
export type KnowledgeSourceItem = {
  /** Stable per-document key. e.g. 'aave-v3', 'proposal:0xabc', 'arbitrum'. */
  sourceId: string
  /** Markdown-ish content to chunk + embed. */
  content: string
  /** Optional structured payload preserved on every chunk row. */
  metadata?: Record<string, unknown>
}

export type KnowledgeSource = {
  /** Identifier persisted in the `source` column. e.g. 'defillama:protocols'. */
  name: string
  /** One round-trip; returns the current snapshot. Throws on fatal upstream failure. */
  fetch(): Promise<KnowledgeSourceItem[]>
}

/** Injectable fetch — defaults to globalThis.fetch but tests pass a mock. */
export type HttpFetch = typeof globalThis.fetch

export type SourceDeps = {
  /** Override fetch for tests / non-default user agents. */
  fetch?: HttpFetch
  /** Per-request timeout in ms. Default 15s. */
  timeoutMs?: number
}
