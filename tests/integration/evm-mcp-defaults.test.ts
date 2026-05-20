import { describe, expect, it } from 'vitest'
import { defaultMcpServers } from '@/mcp-host'

const evmmcp = () => {
  const server = defaultMcpServers().find((s) => s.name === 'evmmcp')
  if (!server) throw new Error('evmmcp server not found in defaults')
  return server
}

describe('defaultMcpServers — evm-mcp', () => {
  it('is wired as stdio via npx', () => {
    const s = evmmcp()
    expect(s.transport).toBe('stdio')
    expect(s.command).toBe('npx')
    expect(s.args).toEqual(expect.arrayContaining(['-y']))
    expect(s.args?.[1]).toMatch(/^@mcpdotdirect\/evm-mcp-server/)
  })

  it('declares staticAnnotations for tools whose names do not self-declare read-only intent', () => {
    const s = evmmcp()
    const overrides = s.staticAnnotations ?? {}
    expect(overrides.resolve_ens_name).toEqual({ readOnly: true })
    expect(overrides.lookup_ens_address).toEqual({ readOnly: true })
    expect(overrides.wait_for_transaction).toEqual({ readOnly: true })
    expect(overrides.read_contract).toEqual({ readOnly: true })
    expect(overrides.multicall).toEqual({ readOnly: true })
  })
})
