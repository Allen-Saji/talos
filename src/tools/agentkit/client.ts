import {
  type ActionProvider,
  AgentKit,
  basenameActionProvider,
  compoundActionProvider,
  ensoActionProvider,
  morphoActionProvider,
  openseaActionProvider,
  pythActionProvider,
  sushiRouterActionProvider,
  ViemWalletProvider,
  walletActionProvider,
  zerionActionProvider,
  zeroXActionProvider,
  zoraActionProvider,
} from '@coinbase/agentkit'
import { loadEnv } from '@/config/env'
import { logger } from '@/shared/logger'
import { getViemWalletClient } from '@/wallet'

const log = logger.child({ module: 'agentkit' })

let cached: AgentKit | undefined

/**
 * Lazy-init AgentKit with a Sepolia-bound viem wallet and the cherry-pick
 * of action providers per spec F3.1 (minus Farcaster — separate signer model,
 * deferred to a follow-up).
 *
 * Provider API-key gating: Zerion, 0x, and OpenSea each throw at construct
 * time if their key is missing. We skip them (with a log line) instead of
 * tanking the whole AgentKit init — the rest of the surface (Pyth, Compound,
 * Morpho, Sushi, Enso, Basename, Zora) stays available.
 *
 * Initialization is async because AgentKit's `from()` factory awaits provider
 * registration. Idempotent — subsequent calls return the cached instance.
 */
export async function getAgentKit(): Promise<AgentKit> {
  if (cached) return cached

  const env = loadEnv()
  const walletClient = getViemWalletClient('sepolia')
  const walletProvider = new ViemWalletProvider(
    // ViemWalletProvider's typing wants its internal `ViemWalletClient` shape;
    // viem's `WalletClient` is structurally compatible at runtime.
    walletClient as never,
  )

  // biome-ignore lint/suspicious/noExplicitAny: AgentKit.from()'s actionProviders param is loosely typed across providers
  type AnyActionProvider = ActionProvider<any>

  // Several providers (Zerion, 0x, OpenSea, Zora) throw at construct time when
  // their env-var key is missing. Wrap each in a try/catch so a single missing
  // key only drops that provider — not the rest of the AgentKit surface.
  const candidates: Array<{ name: string; build: () => AnyActionProvider }> = [
    { name: 'wallet', build: walletActionProvider },
    { name: 'pyth', build: pythActionProvider },
    { name: 'compound', build: compoundActionProvider },
    { name: 'morpho', build: morphoActionProvider },
    { name: 'sushiRouter', build: sushiRouterActionProvider },
    { name: 'enso', build: ensoActionProvider },
    { name: 'basename', build: basenameActionProvider },
    { name: 'zora', build: zoraActionProvider },
    {
      name: 'zerion',
      build: () =>
        zerionActionProvider(env.ZERION_API_KEY ? { apiKey: env.ZERION_API_KEY } : undefined),
    },
    {
      name: 'zeroX',
      build: () => zeroXActionProvider({ apiKey: env.ZEROX_API_KEY ?? '' }),
    },
    {
      name: 'opensea',
      build: () =>
        openseaActionProvider(env.OPENSEA_API_KEY ? { apiKey: env.OPENSEA_API_KEY } : undefined),
    },
  ]

  const actionProviders: AnyActionProvider[] = []
  for (const { name, build } of candidates) {
    try {
      actionProviders.push(build())
    } catch (err) {
      log.info(
        { provider: name, err: err instanceof Error ? err.message : String(err) },
        'skipping AgentKit provider (env-var likely unset)',
      )
    }
  }

  cached = await AgentKit.from({ walletProvider, actionProviders })

  return cached
}

/** Reset for tests so each test exercises a fresh init. */
export function resetAgentKitForTests(): void {
  cached = undefined
}
