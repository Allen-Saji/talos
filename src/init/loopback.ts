import http from 'node:http'
import type { AddressInfo } from 'node:net'

const SUCCESS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Talos — authorization complete</title>
<style>
body { font-family: ui-sans-serif, system-ui, sans-serif; padding: 3rem; color: #111; }
h1 { font-weight: 600; margin: 0 0 0.5rem; }
p { color: #555; max-width: 36rem; }
</style>
</head>
<body>
<h1>Authorization complete</h1>
<p>You can close this tab and return to your terminal.</p>
</body>
</html>`

const ERROR_HTML = (msg: string) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Talos — authorization failed</title></head>
<body style="font-family: ui-sans-serif, system-ui; padding: 3rem;">
<h1>Authorization failed</h1>
<p>${escapeHtml(msg)}</p>
<p>Return to your terminal and re-run <code>talos init</code>.</p>
</body>
</html>`

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export type LoopbackResult = { code: string; state: string }

export type LoopbackOpts = {
  /** Expected `state` from the authorize URL — for CSRF defense. */
  expectedState: string
  /** Path the OAuth server will redirect to. Default `/callback`. */
  callbackPath?: string
  /** How long to wait before rejecting. Default 120_000 (2 minutes). */
  timeoutMs?: number
}

export type LoopbackHandle = {
  /** `http://127.0.0.1:<port>${callbackPath}` — pass this as the OAuth `redirect_uri`. */
  redirectUri: string
  /** Resolves with `{ code, state }` once the OAuth server hits `/callback`. */
  result: Promise<LoopbackResult>
  /** Stop the server early (e.g. user aborted). Idempotent. */
  close(): Promise<void>
}

/**
 * Start a single-shot loopback HTTP server on `127.0.0.1:<ephemeral>` to
 * capture the OAuth authorization code redirect. Per RFC 8252 (OAuth for
 * native apps), this is the recommended pattern for CLI tools.
 *
 * The server:
 *  - Binds to 127.0.0.1 only (never accessible off-machine)
 *  - Picks a random ephemeral port (port=0)
 *  - Accepts a single GET to `callbackPath`, captures `code` + `state`
 *  - Validates `state` matches `expectedState` (CSRF defense)
 *  - Returns a small HTML page so the user knows they can close the tab
 *  - Closes itself after one successful capture, or on timeout
 */
export async function startLoopback(opts: LoopbackOpts): Promise<LoopbackHandle> {
  const callbackPath = opts.callbackPath ?? '/callback'
  const timeoutMs = opts.timeoutMs ?? 120_000

  let resolveResult: (r: LoopbackResult) => void = () => undefined
  let rejectResult: (err: Error) => void = () => undefined
  const result = new Promise<LoopbackResult>((res, rej) => {
    resolveResult = res
    rejectResult = rej
  })

  const server = http.createServer((req, res) => {
    if (!req.url) {
      res.statusCode = 400
      res.end()
      return
    }
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname !== callbackPath) {
      res.statusCode = 404
      res.end()
      return
    }
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const error = url.searchParams.get('error')
    const errorDescription = url.searchParams.get('error_description')

    if (error) {
      const msg = `${error}${errorDescription ? `: ${errorDescription}` : ''}`
      sendHtml(res, 400, ERROR_HTML(msg))
      rejectResult(new Error(`OAuth provider returned error: ${msg}`))
      return
    }
    if (!code || !state) {
      sendHtml(res, 400, ERROR_HTML('missing code or state in redirect'))
      rejectResult(new Error('OAuth callback missing code or state'))
      return
    }
    if (state !== opts.expectedState) {
      sendHtml(res, 400, ERROR_HTML('state mismatch — possible CSRF'))
      rejectResult(new Error('OAuth state mismatch'))
      return
    }
    sendHtml(res, 200, SUCCESS_HTML)
    resolveResult({ code, state })
  })

  await new Promise<void>((res, rej) => {
    server.once('error', rej)
    server.listen(0, '127.0.0.1', () => res())
  })

  const addr = server.address() as AddressInfo
  const redirectUri = `http://127.0.0.1:${addr.port}${callbackPath}`

  const timer = setTimeout(() => {
    rejectResult(new Error(`OAuth callback timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  timer.unref()

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    clearTimeout(timer)
    await new Promise<void>((res) => server.close(() => res()))
  }
  // Auto-close once the result settles either way. Suppress propagation —
  // the caller awaits `result` and handles the original rejection; we just
  // need cleanup.
  result.then(close, close)

  return { redirectUri, result, close }
}

function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.statusCode = status
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(html)
}
