import fs from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { paths } from '@/config/paths'
import { child } from '@/shared/logger'

const log = child({ module: 'channels-config' })

const TelegramChannelConfig = z.object({
  enabled: z.boolean().default(false),
  bot_token_ref: z.string().min(1).optional(),
  allowed_users: z.array(z.string()).default([]),
})

const CliChannelConfig = z.object({ enabled: z.boolean().default(true) })
const McpServerChannelConfig = z.object({ enabled: z.boolean().default(true) })

const ChannelsInner = z.object({
  cli: CliChannelConfig.default({ enabled: true }),
  telegram: TelegramChannelConfig.default({
    enabled: false,
    allowed_users: [],
  }),
  mcp_server: McpServerChannelConfig.default({ enabled: true }),
})

const DaemonConfig = z.object({
  bind: z.string().default('127.0.0.1:7711'),
  log_file: z.string().optional(),
})

const ChannelConfigSchema = z.object({
  auto_start_daemon: z.boolean().default(true),
  daemon: DaemonConfig.default({ bind: '127.0.0.1:7711' }),
  channels: ChannelsInner.default({
    cli: { enabled: true },
    telegram: { enabled: false, allowed_users: [] },
    mcp_server: { enabled: true },
  }),
})

export type TelegramChannelConfig = z.infer<typeof TelegramChannelConfig>
export type ChannelsConfig = z.infer<typeof ChannelConfigSchema>

let cached: ChannelsConfig | undefined

export function loadChannelsConfig(configPath?: string): ChannelsConfig {
  if (cached) return cached
  const filePath = configPath ?? paths.channelsConfigPath
  if (!fs.existsSync(filePath)) {
    log.debug({ path: filePath }, 'channels.yaml not found, using defaults')
    cached = ChannelConfigSchema.parse({})
    return cached
  }
  const raw = fs.readFileSync(filePath, 'utf8')
  const parsed = parseYaml(raw)
  const result = ChannelConfigSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    log.warn({ path: filePath, issues }, 'invalid channels.yaml — using defaults')
    cached = ChannelConfigSchema.parse({})
    return cached
  }
  cached = result.data
  return cached
}

export function resetChannelsConfigCache(): void {
  cached = undefined
}

/**
 * Resolve bot_token_ref (format: `env:VAR_NAME`) to the actual token value.
 * Returns undefined if the ref is missing or the env var is unset.
 */
export function resolveBotToken(ref?: string): string | undefined {
  if (!ref) return undefined
  if (!ref.startsWith('env:')) {
    log.warn({ ref }, 'bot_token_ref must start with env:')
    return undefined
  }
  const varName = ref.slice(4)
  return process.env[varName] || undefined
}
