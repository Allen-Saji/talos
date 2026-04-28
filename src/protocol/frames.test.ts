import { describe, expect, it } from 'vitest'
import { ClientFrame, ServerFrame } from './frames'

describe('ClientFrame', () => {
  it('parses a valid hello frame', () => {
    const result = ClientFrame.safeParse({ type: 'hello', version: '0.1.0' })
    expect(result.success).toBe(true)
  })

  it('parses a valid auth frame', () => {
    const result = ClientFrame.safeParse({ type: 'auth', token: 'abc123' })
    expect(result.success).toBe(true)
  })

  it('rejects auth frame with empty token', () => {
    const result = ClientFrame.safeParse({ type: 'auth', token: '' })
    expect(result.success).toBe(false)
  })

  it('parses a valid run-start frame', () => {
    const result = ClientFrame.safeParse({
      type: 'run-start',
      threadId: 'cli:allen:default',
      prompt: 'what is my eth balance',
    })
    expect(result.success).toBe(true)
  })

  it('rejects unknown frame type', () => {
    const result = ClientFrame.safeParse({ type: 'unknown' })
    expect(result.success).toBe(false)
  })
})

describe('ServerFrame', () => {
  it('parses a hello-ack frame', () => {
    const result = ServerFrame.safeParse({
      type: 'hello-ack',
      version: '0.1.0',
      serverTime: new Date().toISOString(),
    })
    expect(result.success).toBe(true)
  })

  it('parses an error frame', () => {
    const result = ServerFrame.safeParse({
      type: 'error',
      code: 'AUTH_FAILED',
      message: 'invalid token',
    })
    expect(result.success).toBe(true)
  })
})
