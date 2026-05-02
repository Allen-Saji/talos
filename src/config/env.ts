import path from 'node:path'
import { config as loadDotenv } from 'dotenv'
import { z } from 'zod'
import { paths } from '@/config/paths'
import { TalosConfigError } from '@/shared/errors'

// Load configDir/.env first (the canonical location the wizard writes to).
// Then CWD/.env with default override:false — dev-time project-root .env can
// add extras but won't shadow values the wizard placed under ~/.config/talos.
loadDotenv({ path: path.join(paths.configDir, '.env') })
loadDotenv()

/** Coerce empty string to undefined (dotenv sets VAR= as "") */
const optionalUrl = z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional())

const optionalNonEmpty = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.string().min(1).optional(),
)

/**
 * String-aware boolean for env vars. `z.coerce.boolean()` is a footgun: every
 * non-empty string (including the literal "false") coerces to `true`. This
 * parser respects "true|1|yes|on" / "false|0|no|off" with a configurable
 * default for missing/empty values.
 */
function envBool(def: boolean): z.ZodType<boolean> {
  return z
    .preprocess((v) => {
      if (v === undefined || v === null || v === '') return def
      if (typeof v === 'boolean') return v
      if (typeof v !== 'string') return Boolean(v)
      const s = v.trim().toLowerCase()
      if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true
      if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false
      return def
    }, z.boolean())
    .default(def)
}

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
  KNOWLEDGE_CRON_DISABLE: envBool(false),
  /** Run the knowledge cron once at boot — used by `talos init`'s sync first-fetch. */
  KNOWLEDGE_CRON_RUN_ON_BOOT: envBool(false),
  /**
   * Skip routing mutate tools through KeeperHub. When `true`, the audit
   * middleware still records each call but the tool's original `execute`
   * runs (direct viem TX from the burner wallet). Useful when the upstream
   * KH service is degraded or for demos where deterministic latency matters.
   */
  KEEPERHUB_DISABLE_MUTATES: envBool(false),
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
