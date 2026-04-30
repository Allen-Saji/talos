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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ContractCallInput,
  createKeeperHubMiddleware,
  type ExecutionResult,
  type KeeperHubClient,
} from '@/keeperhub'
import { createDb, type DbHandle, openRun, runMigrations, upsertThread } from '@/persistence'
import {
  buildAaveApproveRoute,
  buildAccountTool,
  buildBorrowRoute,
  buildRepayRoute,
  buildSupplyRoute,
  buildWithdrawRoute,
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
// Approve route shape
// ---------------------------------------------------------------------------

describe('aave_approve_pool route', () => {
  it('encodes ContractCallInput pointing at the underlying token', async () => {
    const route = buildAaveApproveRoute()
    const input = (await route({ token: 'USDC', amount: '100' })) as ContractCallInput
    expect(input.network).toBe('sepolia')
    expect(input.contract_address).toBe(SEPOLIA_AAVE_TOKENS.USDC?.address)
    expect(input.function_name).toBe('approve')
    expect(input.function_args?.[0]).toBe(SEPOLIA_AAVE.pool)
    expect(input.function_args?.[1]).toBe(parseUnits('100', 6).toString())
  })

  it('rejects malformed input', () => {
    const route = buildAaveApproveRoute()
    expect(() => route({ token: 'USDC', amount: 100 })).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Supply route shape
// ---------------------------------------------------------------------------

describe('aave_supply route', () => {
  const walletAddress = '0xAbCdEf0123456789aBcDeF0123456789ABCdEf01' as Address

  it('builds ContractCallInput for Pool.supply with referralCode=0', async () => {
    const route = buildSupplyRoute({ walletAddress })
    const input = (await route({ token: 'USDC', amount: '100' })) as ContractCallInput

    expect(input.network).toBe('sepolia')
    expect(input.contract_address).toBe(SEPOLIA_AAVE.pool)
    expect(input.function_name).toBe('supply')
    expect(input.function_args).toEqual([
      SEPOLIA_AAVE_TOKENS.USDC?.address,
      parseUnits('100', 6).toString(),
      walletAddress,
      0,
    ])
  })

  it('honours onBehalfOf override', async () => {
    const route = buildSupplyRoute({ walletAddress })
    const other = '0x1111111111111111111111111111111111111111' as Address
    const input = (await route({
      token: 'WETH',
      amount: '0.5',
      onBehalfOf: other,
    })) as ContractCallInput
    expect(input.function_args?.[2]).toBe(other)
  })
})

// ---------------------------------------------------------------------------
// Borrow route shape
// ---------------------------------------------------------------------------

describe('aave_borrow route', () => {
  const walletAddress = '0xAbCdEf0123456789aBcDeF0123456789ABCdEf01' as Address

  it('builds ContractCallInput for Pool.borrow at variable rate', async () => {
    const route = buildBorrowRoute({ walletAddress })
    const input = (await route({ token: 'DAI', amount: '50' })) as ContractCallInput

    expect(input.contract_address).toBe(SEPOLIA_AAVE.pool)
    expect(input.function_name).toBe('borrow')
    // [asset, amount, interestRateMode, referralCode, onBehalfOf]
    expect(input.function_args).toEqual([
      SEPOLIA_AAVE_TOKENS.DAI?.address,
      parseUnits('50', 18).toString(),
      '2',
      0,
      walletAddress,
    ])
  })
})

// ---------------------------------------------------------------------------
// Repay route shape
// ---------------------------------------------------------------------------

describe('aave_repay route', () => {
  const walletAddress = '0xAbCdEf0123456789aBcDeF0123456789ABCdEf01' as Address

  it('builds ContractCallInput for Pool.repay at variable rate', async () => {
    const route = buildRepayRoute({ walletAddress })
    const input = (await route({ token: 'USDC', amount: '25' })) as ContractCallInput

    expect(input.function_name).toBe('repay')
    expect(input.function_args).toEqual([
      SEPOLIA_AAVE_TOKENS.USDC?.address,
      parseUnits('25', 6).toString(),
      '2',
      walletAddress,
    ])
  })

  it('encodes amount="max" as type(uint256).max', async () => {
    const route = buildRepayRoute({ walletAddress })
    const input = (await route({ token: 'USDC', amount: 'max' })) as ContractCallInput
    expect(input.function_args?.[1]).toBe(MAX_UINT256.toString())
  })
})

// ---------------------------------------------------------------------------
// Withdraw route shape
// ---------------------------------------------------------------------------

describe('aave_withdraw route', () => {
  const walletAddress = '0xAbCdEf0123456789aBcDeF0123456789ABCdEf01' as Address

  it('builds ContractCallInput for Pool.withdraw with `to` defaulted to wallet', async () => {
    const route = buildWithdrawRoute({ walletAddress })
    const input = (await route({ token: 'USDC', amount: '10' })) as ContractCallInput

    expect(input.function_name).toBe('withdraw')
    expect(input.function_args).toEqual([
      SEPOLIA_AAVE_TOKENS.USDC?.address,
      parseUnits('10', 6).toString(),
      walletAddress,
    ])
  })

  it('encodes amount="max" as type(uint256).max', async () => {
    const route = buildWithdrawRoute({ walletAddress })
    const input = (await route({ token: 'WETH', amount: 'max' })) as ContractCallInput
    expect(input.function_args?.[1]).toBe(MAX_UINT256.toString())
  })

  it('honours `to` override', async () => {
    const route = buildWithdrawRoute({ walletAddress })
    const other = '0x2222222222222222222222222222222222222222' as Address
    const input = (await route({ token: 'USDC', amount: '5', to: other })) as ContractCallInput
    expect(input.function_args?.[2]).toBe(other)
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

  it('exposes 6 tools with the expected names + annotations + routes', () => {
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

    const routes = source.routes()
    expect(Object.keys(routes).sort()).toEqual([
      'aave_approve_pool',
      'aave_borrow',
      'aave_repay',
      'aave_supply',
      'aave_withdraw',
    ])
  })
})

// ---------------------------------------------------------------------------
// End-to-end through the KeeperHub middleware
// ---------------------------------------------------------------------------

describe('aave mutate routing through middleware', () => {
  let handle: DbHandle
  let runId: string

  beforeEach(async () => {
    handle = await createDb({ ephemeral: true })
    await runMigrations(handle)
    await upsertThread(handle.db, { id: 't-aave', channel: 'cli', agentId: 'talos-eth' })
    const run = await openRun(handle.db, { threadId: 't-aave', prompt: 'supply' })
    runId = run.id
  })

  afterEach(async () => {
    await handle.close()
  })

  function fakeKhClient(impl: {
    executeContractCall: (input: ContractCallInput) => Promise<ExecutionResult>
  }): KeeperHubClient {
    return {
      ensureToken: async () => 'token',
      listTools: async () => ({}),
      callTool: async () => undefined,
      executeContractCall: impl.executeContractCall,
      executeTransfer: async () => ({ executionId: 'noop', status: 'success' }),
      getExecutionStatus: async () => ({ executionId: 'noop', status: 'success' }),
      close: async () => {},
    }
  }

  it('routes aave_supply through KH client at the Pool address', async () => {
    const calls: ContractCallInput[] = []
    const client = fakeKhClient({
      executeContractCall: async (input) => {
        calls.push(input)
        return { executionId: 'exec-supply', status: 'success', txHash: '0xabcd' }
      },
    })

    const walletAddress = '0xAbCdEf0123456789aBcDeF0123456789ABCdEf01' as Address
    const dummyKey = `0x${'44'.repeat(32)}` as Hex
    const account = privateKeyToAccount(dummyKey)
    const walletClient = createWalletClient({
      account,
      chain: sepolia,
      transport: http('http://localhost:1'),
    })
    const publicClient = createPublicClient({
      chain: sepolia,
      transport: http('http://localhost:1'),
    })

    const source = createAaveToolSource({ walletClient, publicClient, walletAddress })
    const tools = await source.getTools()
    const middleware = createKeeperHubMiddleware({
      db: handle.db,
      runContext: () => ({ runId }),
      annotations: (name) => source.annotations(name),
      kh: { client, routes: new Map(Object.entries(source.routes())) },
    })
    const wrapped = middleware(tools)

    const result = await wrapped.aave_supply?.execute?.(
      { token: 'USDC', amount: '100' },
      { toolCallId: 'tc-supply', messages: [] },
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.contract_address).toBe(SEPOLIA_AAVE.pool)
    expect(calls[0]?.function_name).toBe('supply')
    expect(calls[0]?.function_args?.[0]).toBe(SEPOLIA_AAVE_TOKENS.USDC?.address)
    expect(result).toMatchObject({ executionId: 'exec-supply', txHash: '0xabcd' })

    const rows = await handle.pg.query<{
      audit: { reason: string; executionId?: string; txHash?: string }
    }>(`SELECT audit FROM tool_calls WHERE tool_call_id = $1`, ['tc-supply'])
    expect(rows.rows[0]?.audit.reason).toBe('annotation_mutates')
    expect(rows.rows[0]?.audit.executionId).toBe('exec-supply')
    expect(rows.rows[0]?.audit.txHash).toBe('0xabcd')
  })
})
