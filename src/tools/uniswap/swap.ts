import { tool } from 'ai'
import { type Address, type Hex, type PublicClient, parseUnits, type WalletClient } from 'viem'
import { z } from 'zod'
import type { MutateRoute } from '@/keeperhub'
import {
  DEFAULT_FEE_TIER,
  DEFAULT_SLIPPAGE_BPS,
  ERC20_ABI,
  QUOTER_V2_ABI,
  SEPOLIA_UNISWAP,
  SWAP_ROUTER_ABI,
  V3_FEE_TIERS,
} from './contracts'
import { resolveToken, type SepoliaToken } from './tokens'

const SwapSchema = z.object({
  tokenIn: z.string().describe('Token symbol (USDC, WETH, DAI) or 0x address'),
  tokenOut: z.string().describe('Token symbol or 0x address'),
  amountIn: z.string().describe('Input amount in tokenIn human units (e.g. "100" for 100 USDC)'),
  fee: z.number().optional().describe('V3 fee tier (100, 500, 3000, 10000); default 3000'),
  slippageBps: z
    .number()
    .optional()
    .describe('Slippage tolerance in basis points; default 100 (1%)'),
})

type SwapInput = z.infer<typeof SwapSchema>

export type SwapResult = {
  tokenIn: { symbol: string; address: Address }
  tokenOut: { symbol: string; address: Address }
  amountIn: string
  amountInRaw: string
  amountOutMin: string
  amountOutMinRaw: string
  fee: number
  txHash?: Hex
}

/**
 * Build the `uniswap_swap_exact_in` tool. Calls SwapRouter02.exactInputSingle
 * after computing `amountOutMinimum` from a fresh QuoterV2 call.
 *
 * In KeeperHub-routed mode this tool's execute is replaced by the route below;
 * the wallet must have already called `uniswap_approve_router`. The direct
 * execute path also assumes allowance is in place — it fails loudly when the
 * router has no approval, mirroring the routed contract.
 */
export function buildSwapTool(opts: {
  walletClient: WalletClient
  publicClient: PublicClient
  walletAddress: Address
}) {
  return tool({
    description:
      'Swap an exact input amount of one token for another on Uniswap V3 (Sepolia). Internally fetches a quote and applies slippage tolerance to compute amountOutMinimum. Native ETH input is sent as msg.value (no approval needed); ERC-20 input requires the SwapRouter02 to be pre-approved (call uniswap_approve_router first).',
    inputSchema: SwapSchema,
    execute: async (args): Promise<SwapResult> => {
      const prep = await prepareSwap(args, opts.publicClient)
      const isNativeIn = prep.tokenIn.symbol === 'ETH'

      // Fail-loud allowance precondition: confirm the router can pull tokenIn
      // from the wallet before we burn gas on a swap that will revert.
      // Native ETH input bypasses this — tokens are sent via msg.value.
      if (!isNativeIn) {
        const allowance = (await opts.publicClient.readContract({
          address: prep.tokenIn.address,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [opts.walletAddress, SEPOLIA_UNISWAP.swapRouter02 as Address],
        })) as bigint
        if (allowance < prep.amountInRaw) {
          throw new Error(
            `insufficient allowance: SwapRouter02 has ${allowance.toString()} but needs ${prep.amountInRaw.toString()}; call uniswap_approve_router first`,
          )
        }
      }

      // Pass the bound Account (PrivateKeyAccount) so viem signs locally and
      // uses eth_sendRawTransaction. Falling through to a bare Address makes
      // viem think this is an EIP-1193 wallet and try wallet_sendTransaction,
      // which public RPCs don't support.
      const txHash = await opts.walletClient.writeContract({
        account: opts.walletClient.account ?? opts.walletAddress,
        chain: opts.walletClient.chain ?? null,
        address: SEPOLIA_UNISWAP.swapRouter02 as Address,
        abi: SWAP_ROUTER_ABI,
        functionName: 'exactInputSingle',
        args: [
          {
            tokenIn: prep.tokenIn.address,
            tokenOut: prep.tokenOut.address,
            fee: prep.fee,
            recipient: opts.walletAddress,
            amountIn: prep.amountInRaw,
            amountOutMinimum: prep.amountOutMinRaw,
            sqrtPriceLimitX96: 0n,
          },
        ],
        value: isNativeIn ? prep.amountInRaw : 0n,
      })

      return {
        tokenIn: { symbol: prep.tokenIn.symbol, address: prep.tokenIn.address },
        tokenOut: { symbol: prep.tokenOut.symbol, address: prep.tokenOut.address },
        amountIn: args.amountIn,
        amountInRaw: prep.amountInRaw.toString(),
        amountOutMin: formatUnits(prep.amountOutMinRaw, prep.tokenOut.decimals),
        amountOutMinRaw: prep.amountOutMinRaw.toString(),
        fee: prep.fee,
        txHash,
      }
    },
  })
}

/**
 * KeeperHub mutate route for `uniswap_swap_exact_in`. Async so it can re-run
 * the QuoterV2 call at route-build time — fresh quote → fresh
 * `amountOutMinimum` → KH workflow gets the same slippage protection the
 * direct path enforces.
 */
export const buildSwapRoute =
  (opts: { walletAddress: Address; publicClient: PublicClient }): MutateRoute =>
  async (args) => {
    const parsed = SwapSchema.parse(args)
    const prep = await prepareSwap(parsed, opts.publicClient)
    return {
      network: 'sepolia',
      contract_address: SEPOLIA_UNISWAP.swapRouter02,
      function_name: 'exactInputSingle',
      function_args: [
        {
          tokenIn: prep.tokenIn.address,
          tokenOut: prep.tokenOut.address,
          fee: prep.fee,
          recipient: opts.walletAddress,
          amountIn: prep.amountInRaw.toString(),
          amountOutMinimum: prep.amountOutMinRaw.toString(),
          sqrtPriceLimitX96: '0',
        },
      ],
      abi: SWAP_ROUTER_ABI,
    }
  }

async function prepareSwap(
  args: SwapInput,
  publicClient: PublicClient,
): Promise<{
  tokenIn: SepoliaToken
  tokenOut: SepoliaToken
  amountInRaw: bigint
  fee: number
  amountOutMinRaw: bigint
}> {
  const tokenIn = resolveToken(args.tokenIn)
  const tokenOut = resolveToken(args.tokenOut)
  const fee = (args.fee ?? DEFAULT_FEE_TIER) as number
  const slippageBps = args.slippageBps ?? DEFAULT_SLIPPAGE_BPS

  if (!V3_FEE_TIERS.includes(fee as (typeof V3_FEE_TIERS)[number])) {
    throw new Error(`invalid fee tier ${fee}; must be one of ${V3_FEE_TIERS.join(', ')}`)
  }

  const amountInRaw = parseUnits(args.amountIn, tokenIn.decimals)

  const { result } = await publicClient.simulateContract({
    address: SEPOLIA_UNISWAP.quoterV2 as Address,
    abi: QUOTER_V2_ABI,
    functionName: 'quoteExactInputSingle',
    args: [
      {
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        amountIn: amountInRaw,
        fee,
        sqrtPriceLimitX96: 0n,
      },
    ],
  })
  const [amountOutRaw] = result as readonly [bigint, bigint, number, bigint]
  const amountOutMinRaw = (amountOutRaw * BigInt(10000 - slippageBps)) / 10000n

  return { tokenIn, tokenOut, amountInRaw, fee, amountOutMinRaw }
}

function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n
  const v = negative ? -value : value
  const str = v.toString().padStart(decimals + 1, '0')
  const head = str.slice(0, str.length - decimals)
  const tail = str.slice(str.length - decimals).replace(/0+$/, '')
  const out = tail.length > 0 ? `${head}.${tail}` : head
  return negative ? `-${out}` : out
}
