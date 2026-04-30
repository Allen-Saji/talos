import { tool } from 'ai'
import { type Address, type PublicClient, parseUnits } from 'viem'
import { z } from 'zod'
import {
  DEFAULT_FEE_TIER,
  FACTORY_ABI,
  POOL_ABI,
  QUOTER_V2_ABI,
  SEPOLIA_UNISWAP,
  V3_FEE_TIERS,
} from './contracts'
import { resolveToken } from './tokens'

const QuoteSchema = z.object({
  tokenIn: z.string().describe('Token symbol (USDC, WETH, DAI, ETH) or 0x address'),
  tokenOut: z.string().describe('Token symbol or 0x address'),
  amountIn: z
    .string()
    .describe(
      'Amount in tokenIn human units (e.g. "100" for 100 USDC, decimals applied internally)',
    ),
  fee: z
    .number()
    .optional()
    .describe(
      'V3 fee tier in 1e6 units (100, 500, 3000, 10000); default 3000 (deepest USDC/WETH pool on Sepolia)',
    ),
})

export type QuoteResult = {
  tokenIn: { symbol: string; address: Address }
  tokenOut: { symbol: string; address: Address }
  amountIn: string
  amountInRaw: string
  amountOut: string
  amountOutRaw: string
  fee: number
  poolAddress: Address
  poolLiquidity: string
}

/**
 * Build the `uniswap_get_quote` tool. The leading `_get_` opts the tool out of
 * KeeperHub audit by matching the `KNOWN_READONLY` regex — quotes are pure
 * static reads against QuoterV2 + the Factory.
 */
export function buildQuoteTool(publicClient: PublicClient) {
  return tool({
    description:
      'Get an exact-input quote on Uniswap V3 (Sepolia). Returns expected output amount, the pool address, and pool liquidity. Read-only static call; no state changes.',
    inputSchema: QuoteSchema,
    execute: async (args): Promise<QuoteResult> => {
      const tokenIn = resolveToken(args.tokenIn)
      const tokenOut = resolveToken(args.tokenOut)
      const fee = (args.fee ?? DEFAULT_FEE_TIER) as number

      if (!V3_FEE_TIERS.includes(fee as (typeof V3_FEE_TIERS)[number])) {
        throw new Error(`invalid fee tier ${fee}; must be one of ${V3_FEE_TIERS.join(', ')}`)
      }

      const amountInRaw = parseUnits(args.amountIn, tokenIn.decimals)

      const { result: quoterResult } = await publicClient.simulateContract({
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

      const [amountOutRaw] = quoterResult as readonly [bigint, bigint, number, bigint]

      const poolAddress = (await publicClient.readContract({
        address: SEPOLIA_UNISWAP.factory as Address,
        abi: FACTORY_ABI,
        functionName: 'getPool',
        args: [tokenIn.address, tokenOut.address, fee],
      })) as Address

      let poolLiquidity = '0'
      if (poolAddress && poolAddress !== '0x0000000000000000000000000000000000000000') {
        const liquidity = (await publicClient.readContract({
          address: poolAddress,
          abi: POOL_ABI,
          functionName: 'liquidity',
        })) as bigint
        poolLiquidity = liquidity.toString()
      }

      return {
        tokenIn: { symbol: tokenIn.symbol, address: tokenIn.address },
        tokenOut: { symbol: tokenOut.symbol, address: tokenOut.address },
        amountIn: args.amountIn,
        amountInRaw: amountInRaw.toString(),
        amountOut: formatUnits(amountOutRaw, tokenOut.decimals),
        amountOutRaw: amountOutRaw.toString(),
        fee,
        poolAddress,
        poolLiquidity,
      }
    },
  })
}

/** Inlined to avoid pulling viem/utils helpers across module boundaries. */
function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n
  const v = negative ? -value : value
  const str = v.toString().padStart(decimals + 1, '0')
  const head = str.slice(0, str.length - decimals)
  const tail = str.slice(str.length - decimals).replace(/0+$/, '')
  const out = tail.length > 0 ? `${head}.${tail}` : head
  return negative ? `-${out}` : out
}
