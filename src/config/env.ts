import 'dotenv/config'
import { z } from 'zod'
import { TalosConfigError } from '@/shared/errors'

/** Coerce empty string to undefined (dotenv sets VAR= as "") */
const optionalUrl = z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional())

const optionalNonEmpty = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.string().min(1).optional(),
)

const EnvSchema = z.object({
  OPENAI_API_KEY: optionalNonEmpty,
  OPENAI_BASE_URL: optionalUrl,
  KEEPERHUB_URL: optionalUrl,
  TELEGRAM_BOT_TOKEN: optionalNonEmpty,
  TALOS_DAEMON_PORT: z.coerce.number().int().min(1).max(65535).default(7711),
  TALOS_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  TALOS_DATA_DIR: z.string().optional(),
  TALOS_CONFIG_DIR: z.string().optional(),
  BLOCKSCOUT_MCP_URL: z.preprocess(
    (v) => (v === '' || v == null ? 'https://mcp.blockscout.com/mcp' : v),
    z.string().url(),
  ),
  /** User-supplied EVM private key. If unset, daemon generates a burner persisted to paths.burnerWalletPath. */
  EVM_PRIVATE_KEY: optionalNonEmpty,
  /** Override the default public RPC for Sepolia (e.g. an Alchemy URL). */
  RPC_URL_SEPOLIA: optionalUrl,
  /** Override the default public RPC for Base Sepolia. */
  RPC_URL_BASE_SEPOLIA: optionalUrl,
  /** AgentKit 0x action provider — required for swap quote / execute calls. */
  ZEROX_API_KEY: optionalNonEmpty,
  /** AgentKit Zerion action provider — required for portfolio queries. */
  ZERION_API_KEY: optionalNonEmpty,
  /** AgentKit OpenSea action provider — required for NFT marketplace calls. */
  OPENSEA_API_KEY: optionalNonEmpty,
  /** Knowledge cron interval, ms. Default 24h. */
  KNOWLEDGE_CRON_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1)
    .default(24 * 60 * 60 * 1000),
  /** Disable the knowledge cron entirely (tests, dev). */
  KNOWLEDGE_CRON_DISABLE: z.coerce.boolean().default(false),
  /** Run the knowledge cron once at boot — used by `talos init`'s sync first-fetch. */
  KNOWLEDGE_CRON_RUN_ON_BOOT: z.coerce.boolean().default(false),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
})

export type Env = z.infer<typeof EnvSchema>

let cached: Env | undefined

export function loadEnv(): Env {
  if (cached) return cached
  const parsed = EnvSchema.safeParse(process.env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new TalosConfigError(`invalid environment:\n${issues}`)
  }
  cached = parsed.data
  return cached
}

export function resetEnvCache(): void {
  cached = undefined
}
