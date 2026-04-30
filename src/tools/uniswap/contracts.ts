import { type Abi, parseAbi } from 'viem'

/**
 * Uniswap V3 Sepolia deployment.
 *
 * SwapRouter02 (the simplified router that omits multicall + self-permit) is
 * the target for `exactInputSingle`. QuoterV2 is called statically for read
 * quotes — `quoteExactInputSingle` returns `(amountOut, sqrtPriceX96After,
 * initializedTicksCrossed, gasEstimate)`.
 *
 * Source: https://developers.uniswap.org/contracts/v3/reference/deployments/ethereum-deployments
 */
export const SEPOLIA_UNISWAP = {
  swapRouter02: '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E',
  quoterV2: '0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3',
  factory: '0x0227628f3F023bb0B980b67D528571c95c6DaC1c',
  weth: '0xfff9976782d46cc05630d1f6ebab18b2324d6b14',
} as const

/** Valid V3 fee tiers in basis points * 100 (i.e. 100 = 0.01%, 3000 = 0.3%). */
export const V3_FEE_TIERS = [100, 500, 3000, 10000] as const
export type V3FeeTier = (typeof V3_FEE_TIERS)[number]

/** Default fee tier — 0.3% pool has the deepest USDC/WETH liquidity on Sepolia. */
export const DEFAULT_FEE_TIER: V3FeeTier = 3000

/** Default slippage tolerance — 100 bps (1%). */
export const DEFAULT_SLIPPAGE_BPS = 100

/** ABI fragment for SwapRouter02.exactInputSingle (struct flattened to tuple). */
export const SWAP_ROUTER_ABI: Abi = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
])

/** ABI fragment for QuoterV2.quoteExactInputSingle. */
export const QUOTER_V2_ABI: Abi = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
])

/** Minimal ERC20 ABI for approve + allowance + balanceOf + symbol/decimals. */
export const ERC20_ABI: Abi = parseAbi([
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
  'function decimals() external view returns (uint8)',
  'function symbol() external view returns (string)',
])

/** Minimal V3 Pool ABI for liquidity reads via the Factory. */
export const FACTORY_ABI: Abi = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
])

export const POOL_ABI: Abi = parseAbi(['function liquidity() external view returns (uint128)'])
