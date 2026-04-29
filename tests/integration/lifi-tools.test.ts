import { beforeEach, describe, expect, it, vi } from 'vitest'

const sdkMocks = vi.hoisted(() => ({
  getChains: vi.fn(),
  getTokens: vi.fn(),
  getConnections: vi.fn(),
  getQuote: vi.fn(),
  getStatus: vi.fn(),
  createConfig: vi.fn(),
}))

vi.mock('@lifi/sdk', () => sdkMocks)

import { shouldAudit } from '@/keeperhub/middleware'
import { namespaceToolName } from '@/mcp-host'
import { resetLifiSdkForTests } from '@/tools/lifi/client'
import { lifiReadTools } from '@/tools/lifi/tools'

beforeEach(() => {
  for (const m of Object.values(sdkMocks)) m.mockReset()
  resetLifiSdkForTests()
})

const ctx = { toolCallId: 'tc-1', messages: [] } as never

describe('lifiReadTools — registration shape', () => {
  it('exposes 5 read tools with lifi_ prefix', () => {
    const { tools, annotations } = lifiReadTools()
    const names = Object.keys(tools).sort()
    expect(names).toEqual([
      'lifi_get_chains',
      'lifi_get_connections',
      'lifi_get_quote',
      'lifi_get_status',
      'lifi_get_tokens',
    ])
    for (const name of names) {
      expect(annotations[name]).toEqual({ mutates: false, readOnly: true, destructive: false })
    }
  })

  it('every tool routes to bypass via shouldAudit', () => {
    const { tools, annotations } = lifiReadTools()
    for (const name of Object.keys(tools)) {
      const namespaced = namespaceToolName('runtime', name).replace('runtime_', '')
      // Native tools are pre-namespaced; just pass the name as-is.
      const decision = shouldAudit(name, annotations[name])
      expect(decision.shouldAudit, `${namespaced} should bypass audit`).toBe(false)
    }
  })
})

describe('lifiReadTools — execute paths', () => {
  it('lifi_get_chains forwards chainTypes when supplied', async () => {
    sdkMocks.getChains.mockResolvedValue([{ id: 1, name: 'Ethereum' }])
    const { tools } = lifiReadTools()
    const result = await tools.lifi_get_chains?.execute?.({ chainTypes: ['EVM'] }, ctx)
    expect(sdkMocks.createConfig).toHaveBeenCalledOnce()
    expect(sdkMocks.getChains).toHaveBeenCalledWith({ chainTypes: ['EVM'] })
    expect(result).toEqual([{ id: 1, name: 'Ethereum' }])
  })

  it('lifi_get_chains passes undefined when chainTypes omitted', async () => {
    sdkMocks.getChains.mockResolvedValue([])
    const { tools } = lifiReadTools()
    await tools.lifi_get_chains?.execute?.({}, ctx)
    expect(sdkMocks.getChains).toHaveBeenCalledWith(undefined)
  })

  it('lifi_get_tokens passes through chains list', async () => {
    sdkMocks.getTokens.mockResolvedValue({ tokens: {} })
    const { tools } = lifiReadTools()
    await tools.lifi_get_tokens?.execute?.({ chains: [1, 137] }, ctx)
    expect(sdkMocks.getTokens).toHaveBeenCalledWith({ chains: [1, 137] })
  })

  it('lifi_get_connections forwards required + optional fields', async () => {
    sdkMocks.getConnections.mockResolvedValue({ connections: [] })
    const { tools } = lifiReadTools()
    await tools.lifi_get_connections?.execute?.(
      { fromChain: 1, toChain: 137, fromToken: 'USDC' },
      ctx,
    )
    expect(sdkMocks.getConnections).toHaveBeenCalledWith({
      fromChain: 1,
      toChain: 137,
      fromToken: 'USDC',
    })
  })

  it('lifi_get_quote forwards required quote fields', async () => {
    sdkMocks.getQuote.mockResolvedValue({ id: 'route_1' })
    const { tools } = lifiReadTools()
    const params = {
      fromChain: 137,
      toChain: 8453,
      fromToken: '0xUSDC',
      toToken: '0x0000000000000000000000000000000000000000',
      fromAmount: '100000000',
      fromAddress: '0xabc',
    }
    const result = await tools.lifi_get_quote?.execute?.(params, ctx)
    expect(sdkMocks.getQuote).toHaveBeenCalledWith(params)
    expect(result).toEqual({ id: 'route_1' })
  })

  it('lifi_get_status forwards txHash + bridge', async () => {
    sdkMocks.getStatus.mockResolvedValue({ status: 'DONE' })
    const { tools } = lifiReadTools()
    await tools.lifi_get_status?.execute?.(
      { txHash: '0xdeadbeef', bridge: 'stargate', fromChain: 1, toChain: 137 },
      ctx,
    )
    expect(sdkMocks.getStatus).toHaveBeenCalledWith({
      txHash: '0xdeadbeef',
      bridge: 'stargate',
      fromChain: 1,
      toChain: 137,
    })
  })

  it('initialises the SDK exactly once across many tool calls', async () => {
    sdkMocks.getChains.mockResolvedValue([])
    sdkMocks.getTokens.mockResolvedValue({ tokens: {} })
    const { tools } = lifiReadTools()
    await tools.lifi_get_chains?.execute?.({}, ctx)
    await tools.lifi_get_tokens?.execute?.({ chains: [1] }, ctx)
    await tools.lifi_get_chains?.execute?.({}, ctx)
    expect(sdkMocks.createConfig).toHaveBeenCalledTimes(1)
    expect(sdkMocks.createConfig).toHaveBeenCalledWith({ integrator: 'talos' })
  })
})
