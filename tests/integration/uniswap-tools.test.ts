import {
  type Address,
  createPublicClient,
  createWalletClient,
  type Hex,
  http,
  type PublicClient,
  parseUnits,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import { describe, expect, it, vi } from 'vitest'
import {
  buildQuoteTool,
  createUniswapToolSource,
  resolveToken,
  SEPOLIA_TOKENS,
  SEPOLIA_UNISWAP,
} from '@/tools/uniswap'

// ---------------------------------------------------------------------------
// resolveToken
// ---------------------------------------------------------------------------

describe('resolveToken', () => {
  it('resolves canonical symbols (case-insensitive)', () => {
    expect(resolveToken('USDC').address).toBe(SEPOLIA_TOKENS.USDC?.address)
    expect(resolveToken('usdc').address).toBe(SEPOLIA_TOKENS.USDC?.address)
    expect(resolveToken('WETH').decimals).toBe(18)
    expect(resolveToken('ETH').address).toBe(SEPOLIA_TOKENS.WETH?.address)
  })

  it('passes through hex addresses', () => {
    const t = resolveToken('0x1234567890abCDEF1234567890ABCDEF12345678')
    expect(t.address).toBe('0x1234567890abcdef1234567890abcdef12345678')
    expect(t.decimals).toBe(18)
  })

  it('throws on unknown reference', () => {
    expect(() => resolveToken('NOTATOKEN')).toThrow(/unknown token/)
  })
})

// ---------------------------------------------------------------------------
// Quote tool
// ---------------------------------------------------------------------------

describe('uniswap_get_quote', () => {
  it('reads QuoterV2 + factory and returns the expected shape', async () => {
    const simulateContract = vi.fn().mockResolvedValue({
      result: [parseUnits('0.04', 18), 0n, 0, 0n] as const,
    })
    const readContract = vi
      .fn()
      .mockResolvedValueOnce('0x6418eec70f50913ff0d756b48d32ce7c02b47c47') // pool
      .mockResolvedValueOnce(123_456_789n) // liquidity

    const publicClient = {
      simulateContract,
      readContract,
    } as unknown as PublicClient

    const tool = buildQuoteTool(publicClient)
    const out = (await tool.execute!(
      { tokenIn: 'USDC', tokenOut: 'WETH', amountIn: '100' },
      { toolCallId: 'qc-1', messages: [] },
    )) as { amountOut: string; fee: number; poolLiquidity: string; poolAddress: string }

    expect(out.amountOut).toBe('0.04')
    expect(out.fee).toBe(3000)
    expect(out.poolAddress).toBe('0x6418eec70f50913ff0d756b48d32ce7c02b47c47')
    expect(out.poolLiquidity).toBe('123456789')
    expect(simulateContract).toHaveBeenCalledOnce()
    const simArgs = simulateContract.mock.calls[0]?.[0] as {
      address: string
      args: [{ tokenIn: string; tokenOut: string; amountIn: bigint; fee: number }]
    }
    expect(simArgs.address).toBe(SEPOLIA_UNISWAP.quoterV2)
    expect(simArgs.args[0].tokenIn).toBe(SEPOLIA_TOKENS.USDC?.address)
    expect(simArgs.args[0].amountIn).toBe(parseUnits('100', 6))
  })

  it('rejects unknown fee tier', async () => {
    const publicClient = {
      simulateContract: vi.fn(),
      readContract: vi.fn(),
    } as unknown as PublicClient

    const tool = buildQuoteTool(publicClient)
    await expect(
      tool.execute!(
        { tokenIn: 'USDC', tokenOut: 'WETH', amountIn: '100', fee: 1234 },
        { toolCallId: 'qc-2', messages: [] },
      ),
    ).rejects.toThrow(/invalid fee tier/)
  })
})

// ---------------------------------------------------------------------------
// Source integration
// ---------------------------------------------------------------------------

describe('createUniswapToolSource', () => {
  const walletAddress = '0xAbCdEf0123456789aBcDeF0123456789ABCdEf01' as Address
  const dummyKey = `0x${'11'.repeat(32)}` as Hex
  const account = privateKeyToAccount(dummyKey)
  const walletClient: WalletClient = createWalletClient({
    account,
    chain: sepolia,
    transport: http('http://localhost:1'),
  })
  const publicClient = createPublicClient({
    chain: sepolia,
    transport: http('http://localhost:1'),
  })

  it('exposes 3 tools with the expected names + annotations', () => {
    const source = createUniswapToolSource({ walletClient, publicClient, walletAddress })

    expect(source.toolNames().sort()).toEqual([
      'uniswap_approve_router',
      'uniswap_get_quote',
      'uniswap_swap_exact_in',
    ])
    expect(source.annotations('uniswap_get_quote')).toMatchObject({ readOnly: true })
    expect(source.annotations('uniswap_approve_router')).toMatchObject({ mutates: true })
    expect(source.annotations('uniswap_swap_exact_in')).toMatchObject({ mutates: true })
  })
})
