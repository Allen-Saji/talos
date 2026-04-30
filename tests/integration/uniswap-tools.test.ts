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
  buildApproveRoute,
  buildQuoteTool,
  buildSwapRoute,
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
// Approve route shape
// ---------------------------------------------------------------------------

describe('uniswap_approve_router route', () => {
  it('encodes ContractCallInput pointing at the token contract', async () => {
    const route = buildApproveRoute()
    const input = (await route({ token: 'USDC', amount: '100' })) as ContractCallInput
    expect(input.network).toBe('sepolia')
    expect(input.contract_address).toBe(SEPOLIA_TOKENS.USDC?.address)
    expect(input.function_name).toBe('approve')
    expect(input.function_args?.[0]).toBe(SEPOLIA_UNISWAP.swapRouter02)
    expect(input.function_args?.[1]).toBe(parseUnits('100', 6).toString())
  })

  it('rejects malformed input', () => {
    const route = buildApproveRoute()
    expect(() => route({ token: 'USDC', amount: 100 })).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Swap route shape
// ---------------------------------------------------------------------------

describe('uniswap_swap_exact_in route', () => {
  const walletAddress = '0xAbCdEf0123456789aBcDeF0123456789ABCdEf01' as Address

  it('builds ContractCallInput with slippage-applied amountOutMinimum', async () => {
    const expectedOut = parseUnits('0.04', 18)
    const simulateContract = vi.fn().mockResolvedValue({
      result: [expectedOut, 0n, 0, 0n] as const,
    })
    const publicClient = {
      simulateContract,
    } as unknown as PublicClient

    const route = buildSwapRoute({ walletAddress, publicClient })
    const input = (await route({
      tokenIn: 'USDC',
      tokenOut: 'WETH',
      amountIn: '100',
      slippageBps: 100,
    })) as ContractCallInput

    expect(input.network).toBe('sepolia')
    expect(input.contract_address).toBe(SEPOLIA_UNISWAP.swapRouter02)
    expect(input.function_name).toBe('exactInputSingle')

    const params = input.function_args?.[0] as {
      tokenIn: string
      tokenOut: string
      fee: number
      recipient: string
      amountIn: string
      amountOutMinimum: string
    }
    expect(params.tokenIn).toBe(SEPOLIA_TOKENS.USDC?.address)
    expect(params.tokenOut).toBe(SEPOLIA_TOKENS.WETH?.address)
    expect(params.fee).toBe(3000)
    expect(params.recipient).toBe(walletAddress)
    expect(params.amountIn).toBe(parseUnits('100', 6).toString())

    // 1% slippage applied: 0.04 * 0.99
    const expectedMin = (expectedOut * 9900n) / 10000n
    expect(params.amountOutMinimum).toBe(expectedMin.toString())
  })

  it('uses 100 bps slippage by default', async () => {
    const expectedOut = parseUnits('1', 18)
    const publicClient = {
      simulateContract: vi.fn().mockResolvedValue({
        result: [expectedOut, 0n, 0, 0n] as const,
      }),
    } as unknown as PublicClient

    const route = buildSwapRoute({ walletAddress, publicClient })
    const input = (await route({
      tokenIn: 'USDC',
      tokenOut: 'WETH',
      amountIn: '1',
    })) as ContractCallInput
    const params = input.function_args?.[0] as { amountOutMinimum: string }
    expect(params.amountOutMinimum).toBe(((expectedOut * 9900n) / 10000n).toString())
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

  it('exposes 3 tools with the expected names + annotations + routes', () => {
    const source = createUniswapToolSource({ walletClient, publicClient, walletAddress })

    expect(source.toolNames().sort()).toEqual([
      'uniswap_approve_router',
      'uniswap_get_quote',
      'uniswap_swap_exact_in',
    ])
    expect(source.annotations('uniswap_get_quote')).toMatchObject({ readOnly: true })
    expect(source.annotations('uniswap_approve_router')).toMatchObject({ mutates: true })
    expect(source.annotations('uniswap_swap_exact_in')).toMatchObject({ mutates: true })

    const routes = source.routes()
    expect(Object.keys(routes).sort()).toEqual(['uniswap_approve_router', 'uniswap_swap_exact_in'])
  })
})

// ---------------------------------------------------------------------------
// End-to-end through the KeeperHub middleware
// ---------------------------------------------------------------------------

describe('uniswap mutate routing through middleware', () => {
  let handle: DbHandle
  let runId: string

  beforeEach(async () => {
    handle = await createDb({ ephemeral: true })
    await runMigrations(handle)
    await upsertThread(handle.db, { id: 't-uni', channel: 'cli', agentId: 'talos-eth' })
    const run = await openRun(handle.db, { threadId: 't-uni', prompt: 'swap' })
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

  it('routes uniswap_approve_router through KH client with the token contract address', async () => {
    const calls: ContractCallInput[] = []
    const client = fakeKhClient({
      executeContractCall: async (input) => {
        calls.push(input)
        return { executionId: 'exec-approve', status: 'success', txHash: '0xaabb' }
      },
    })

    const walletAddress = '0xAbCdEf0123456789aBcDeF0123456789ABCdEf01' as Address
    const dummyKey = `0x${'22'.repeat(32)}` as Hex
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

    const source = createUniswapToolSource({ walletClient, publicClient, walletAddress })
    const tools = await source.getTools()
    const middleware = createKeeperHubMiddleware({
      db: handle.db,
      runContext: () => ({ runId }),
      annotations: (name) => source.annotations(name),
      kh: { client, routes: new Map(Object.entries(source.routes())) },
    })
    const wrapped = middleware(tools)

    const result = await wrapped.uniswap_approve_router?.execute?.(
      { token: 'USDC', amount: '100' },
      { toolCallId: 'tc-approve', messages: [] },
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.contract_address).toBe(SEPOLIA_TOKENS.USDC?.address)
    expect(calls[0]?.function_name).toBe('approve')
    expect(result).toMatchObject({ executionId: 'exec-approve', txHash: '0xaabb' })

    const rows = await handle.pg.query<{
      audit: { reason: string; executionId?: string; txHash?: string }
    }>(`SELECT audit FROM tool_calls WHERE tool_call_id = $1`, ['tc-approve'])
    expect(rows.rows[0]?.audit.reason).toBe('annotation_mutates')
    expect(rows.rows[0]?.audit.executionId).toBe('exec-approve')
    expect(rows.rows[0]?.audit.txHash).toBe('0xaabb')
  })
})
