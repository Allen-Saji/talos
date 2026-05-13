import { describe, expect, it } from 'vitest'
import { defaultMcpServers } from '@/mcp-host'

const blockscout = () => {
  const server = defaultMcpServers().find((s) => s.name === 'blockscout')
  if (!server) throw new Error('blockscout server not found in defaults')
  return server
}

describe('defaultMcpServers — blockscout', () => {
  it('is wired as Streamable HTTP', () => {
    const s = blockscout()
    expect(s.transport).toBe('http')
    expect(s.url).toMatch(/^https?:\/\//)
  })

  it('defaults to the hosted endpoint when no env override is set', () => {
    const s = blockscout()
    expect(s.url).toBeTruthy()
    if (!process.env.BLOCKSCOUT_MCP_URL) {
      expect(s.url).toBe('https://mcp.blockscout.com/mcp')
    }
  })

  it('declares no staticAnnotations', () => {
    const s = blockscout()
    expect(s.staticAnnotations).toBeUndefined()
  })
})
