import { describe, expect, it } from 'vitest'
import { startLoopback } from '@/init/loopback'

async function getFollow(redirectUri: string, params: Record<string, string>): Promise<Response> {
  const url = new URL(redirectUri)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return fetch(url.toString())
}

describe('startLoopback', () => {
  it('captures code + state on the configured callback path', async () => {
    const lb = await startLoopback({ expectedState: 'state-1', timeoutMs: 5_000 })
    expect(lb.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)

    const res = await getFollow(lb.redirectUri, { code: 'abc', state: 'state-1' })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Authorization complete')

    const captured = await lb.result
    expect(captured).toEqual({ code: 'abc', state: 'state-1' })
  })

  it('rejects on state mismatch (CSRF)', async () => {
    const lb = await startLoopback({ expectedState: 'state-1', timeoutMs: 5_000 })
    const res = await getFollow(lb.redirectUri, { code: 'abc', state: 'wrong' })
    expect(res.status).toBe(400)
    await expect(lb.result).rejects.toThrow(/state mismatch/)
  })

  it('rejects when OAuth provider returns error', async () => {
    const lb = await startLoopback({ expectedState: 's', timeoutMs: 5_000 })
    const res = await getFollow(lb.redirectUri, {
      error: 'access_denied',
      error_description: 'user said no',
    })
    expect(res.status).toBe(400)
    await expect(lb.result).rejects.toThrow(/access_denied: user said no/)
  })

  it('rejects on missing code or state', async () => {
    const lb = await startLoopback({ expectedState: 's', timeoutMs: 5_000 })
    const res = await getFollow(lb.redirectUri, { code: 'only-code' })
    expect(res.status).toBe(400)
    await expect(lb.result).rejects.toThrow(/missing code or state/)
  })

  it('honors a custom callback path', async () => {
    const lb = await startLoopback({
      expectedState: 's',
      callbackPath: '/oauth/callback',
      timeoutMs: 5_000,
    })
    expect(lb.redirectUri).toMatch(/\/oauth\/callback$/)

    const res = await getFollow(lb.redirectUri, { code: 'a', state: 's' })
    expect(res.status).toBe(200)
    await expect(lb.result).resolves.toEqual({ code: 'a', state: 's' })
  })

  it('returns 404 on non-callback paths', async () => {
    const lb = await startLoopback({ expectedState: 's', timeoutMs: 5_000 })
    try {
      const url = new URL(lb.redirectUri)
      const res = await fetch(`http://${url.host}/other`)
      expect(res.status).toBe(404)
    } finally {
      await lb.close()
    }
  })

  it('rejects on timeout', async () => {
    const lb = await startLoopback({ expectedState: 's', timeoutMs: 50 })
    await expect(lb.result).rejects.toThrow(/timed out/)
  })

  it('close() is idempotent', async () => {
    const lb = await startLoopback({ expectedState: 's', timeoutMs: 5_000 })
    await lb.close()
    await lb.close() // second call must not throw
  })
})
