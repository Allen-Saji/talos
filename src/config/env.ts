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
