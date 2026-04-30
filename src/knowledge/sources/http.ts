import { TalosError } from '@/shared/errors'
import type { HttpFetch } from './types'

const DEFAULT_TIMEOUT_MS = 15_000
const USER_AGENT = 'Talos/0.1 (+https://github.com/Allen-Saji/talos)'

export type FetchJsonOpts = {
  fetch?: HttpFetch
  timeoutMs?: number
  headers?: Record<string, string>
}

/**
 * GET {url} as JSON. Throws TalosError on non-2xx, abort on timeout, parse failure.
 * Centralized so every source surfaces the same error shape and the same UA.
 */
export async function fetchJson<T>(url: string, opts: FetchJsonOpts = {}): Promise<T> {
  const fetchImpl = opts.fetch ?? globalThis.fetch
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...opts.headers },
      signal: ctrl.signal,
    })
    if (!res.ok) {
      throw new TalosError(`GET ${url} -> ${res.status}`, 'KNOWLEDGE_HTTP_ERROR')
    }
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

export type FetchTextOpts = FetchJsonOpts

export async function fetchText(url: string, opts: FetchTextOpts = {}): Promise<string> {
  const fetchImpl = opts.fetch ?? globalThis.fetch
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT, accept: 'text/*, application/xml', ...opts.headers },
      signal: ctrl.signal,
    })
    if (!res.ok) {
      throw new TalosError(`GET ${url} -> ${res.status}`, 'KNOWLEDGE_HTTP_ERROR')
    }
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

export type GraphqlOpts = FetchJsonOpts & {
  variables?: Record<string, unknown>
}

export async function fetchGraphql<T>(
  url: string,
  query: string,
  opts: GraphqlOpts = {},
): Promise<T> {
  const fetchImpl = opts.fetch ?? globalThis.fetch
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'user-agent': USER_AGENT,
        accept: 'application/json',
        'content-type': 'application/json',
        ...opts.headers,
      },
      body: JSON.stringify({ query, variables: opts.variables ?? {} }),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      throw new TalosError(`POST ${url} -> ${res.status}`, 'KNOWLEDGE_HTTP_ERROR')
    }
    const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> }
    if (body.errors && body.errors.length > 0) {
      throw new TalosError(
        `graphql errors: ${body.errors.map((e) => e.message).join('; ')}`,
        'KNOWLEDGE_GRAPHQL_ERROR',
      )
    }
    if (!body.data) {
      throw new TalosError('graphql response missing data field', 'KNOWLEDGE_GRAPHQL_ERROR')
    }
    return body.data
  } finally {
    clearTimeout(timer)
  }
}
