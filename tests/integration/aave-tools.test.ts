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
  buildAccountTool,
  createAaveToolSource,
  resolveAaveToken,
  SEPOLIA_AAVE,
  SEPOLIA_AAVE_TOKENS,
} from '@/tools/aave'

const MAX_UINT256 = (1n << 256n) - 1n

// ---------------------------------------------------------------------------
// resolveAaveToken
// ---------------------------------------------------------------------------

describe('resolveAaveToken', () => {
  it('resolves canonical symbols (case-insensitive)', () => {
    expect(resolveAaveToken('USDC').address).toBe(SEPOLIA_AAVE_TOKENS.USDC?.address)
    expect(resolveAaveToken('usdc').address).toBe(SEPOLIA_AAVE_TOKENS.USDC?.address)
    expect(resolveAaveToken('WETH').decimals).toBe(18)
    expect(resolveAaveToken('GHO').decimals).toBe(18)
    expect(resolveAaveToken('USDT').decimals).toBe(6)
  })

  it('rejects ETH (no native-eth aliasing — use WETH)', () => {
    expect(() => resolveAaveToken('ETH')).toThrow(/unknown Aave Sepolia token/)
  })

  it('passes through hex addresses', () => {
    const t = resolveAaveToken('0x1234567890abCDEF1234567890ABCDEF12345678')
    expect(t.address).toBe('0x1234567890abcdef1234567890abcdef12345678')
    expect(t.decimals).toBe(18)
  })

  it('throws on unknown reference', () => {
    expect(() => resolveAaveToken('NOTATOKEN')).toThrow(/unknown Aave Sepolia token/)
  })
})

// ---------------------------------------------------------------------------
// Account-data tool
// ---------------------------------------------------------------------------

describe('aave_get_user_account_data', () => {
  const walletAddress = '0xAbCdEf0123456789aBcDeF0123456789ABCdEf01' as Address

  it('formats the six aggregate numbers from Pool.getUserAccountData', async () => {
    // Aave returns base-currency (USD) amounts in 8 decimals; LTV is 4 dp
    // (8000 = 80%); health factor is 18 dp (1e18 = 1.0).
    const collateral = parseUnits('1000', 8) // $1000
    const debt = parseUnits('500', 8) // $500
    const available = parseUnits('200', 8) // $200
    const liqThreshold = 8500n // 85%
    const ltv = 8000n // 80%
    const healthFactor = parseUnits('2', 18) // 2.0

    const readContract = vi
      .fn()
      .mockResolvedValue([collateral, debt, available, liqThreshold, ltv, healthFactor] as const)
    const publicClient = { readContract } as unknown as PublicClient

    const tool = buildAccountTool({ publicClient, walletAddress })
    const out = (await tool.execute!({}, { toolCallId: 'acc-1', messages: [] })) as {
      user: Address
      totalCollateralUsd: string
      totalDebtUsd: string
      availableBorrowsUsd: string
      currentLiquidationThreshold: string
      ltv: string
      healthFactor: string
      raw: { healthFactor: string }
    }

    expect(out.user).toBe(walletAddress)
    expect(out.totalCollateralUsd).toBe('1000')
    expect(out.totalDebtUsd).toBe('500')
    expect(out.availableBorrowsUsd).toBe('200')
    expect(out.currentLiquidationThreshold).toBe('0.85')
    expect(out.ltv).toBe('0.8')
    expect(out.healthFactor).toBe('2')
    expect(out.raw.healthFactor).toBe(healthFactor.toString())

    expect(readContract).toHaveBeenCalledOnce()
    const callArgs = readContract.mock.calls[0]?.[0] as { address: string; args: [string] }
    expect(callArgs.address).toBe(SEPOLIA_AAVE.pool)
    expect(callArgs.args[0]).toBe(walletAddress)
  })

  it('reports infinity health factor when no debt is open', async () => {
    const readContract = vi.fn().mockResolvedValue([0n, 0n, 0n, 0n, 0n, MAX_UINT256] as const)
    const publicClient = { readContract } as unknown as PublicClient

    const tool = buildAccountTool({ publicClient, walletAddress })
    const out = (await tool.execute!({}, { toolCallId: 'acc-2', messages: [] })) as {
      healthFactor: string
    }
    expect(out.healthFactor).toBe('infinity')
  })

  it('honours an explicit user override', async () => {
    const readContract = vi.fn().mockResolvedValue([0n, 0n, 0n, 0n, 0n, MAX_UINT256] as const)
    const publicClient = { readContract } as unknown as PublicClient

    const tool = buildAccountTool({ publicClient, walletAddress })
    const other = '0x1111111111111111111111111111111111111111' as Address
    await tool.execute!({ user: other }, { toolCallId: 'acc-3', messages: [] })

    const callArgs = readContract.mock.calls[0]?.[0] as { args: [string] }
    expect(callArgs.args[0]).toBe(other)
  })
})

// ---------------------------------------------------------------------------
// Source integration
// ---------------------------------------------------------------------------

describe('createAaveToolSource', () => {
  const walletAddress = '0xAbCdEf0123456789aBcDeF0123456789ABCdEf01' as Address
  const dummyKey = `0x${'33'.repeat(32)}` as Hex
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

  it('exposes 6 tools with the expected names + annotations', () => {
    const source = createAaveToolSource({ walletClient, publicClient, walletAddress })

    expect(source.toolNames().sort()).toEqual([
      'aave_approve_pool',
      'aave_borrow',
      'aave_get_user_account_data',
      'aave_repay',
      'aave_supply',
      'aave_withdraw',
    ])
    expect(source.annotations('aave_get_user_account_data')).toMatchObject({ readOnly: true })
    expect(source.annotations('aave_approve_pool')).toMatchObject({ mutates: true })
    expect(source.annotations('aave_supply')).toMatchObject({ mutates: true })
    expect(source.annotations('aave_borrow')).toMatchObject({ mutates: true })
    expect(source.annotations('aave_repay')).toMatchObject({ mutates: true })
    expect(source.annotations('aave_withdraw')).toMatchObject({ mutates: true })
  })
})
