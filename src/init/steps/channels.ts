import fs from 'node:fs'
import path from 'node:path'
import { stringify as stringifyYaml } from 'yaml'
import type { StepResult, WizardContext } from '../context'
import type { Prompter } from '../prompt'

export type ChannelsStepDeps = {
  prompter: Prompter
  /** Test seam — overrides env reader. */
  readEnv?: (k: string) => string | undefined
}

type ChannelKey = 'cli' | 'telegram' | 'mcp_server'

/**
 * Pick which channels to enable and (for telegram) collect a bot token.
 * Writes `paths.channelsConfigPath` (YAML).
 *
 * Idempotency: in `keep` or `partial-oauth-only` and a config exists, no-op.
 * Non-interactive defaults to CLI + MCP-server enabled, Telegram off unless
 * `TELEGRAM_BOT_TOKEN` is set in env.
 */
export async function runChannelsStep(
  ctx: WizardContext,
  deps: ChannelsStepDeps,
): Promise<StepResult> {
  const channelsPath = ctx.paths.channelsConfigPath
  const readEnv = deps.readEnv ?? ((k: string) => process.env[k])

  if (
    (ctx.idempotency === 'keep' || ctx.idempotency === 'partial-oauth-only') &&
    ctx.existing.channelsConfig
  ) {
    return { status: 'kept', summary: `channels.yaml kept (${channelsPath})` }
  }

  // Non-interactive: defaults from env.
  if (ctx.mode === 'non-interactive') {
    const tgToken = readEnv('TELEGRAM_BOT_TOKEN')
    const cfg = buildConfig({
      cli: true,
      mcp: true,
      telegram: Boolean(tgToken),
      tgTokenRef: tgToken ? 'env:TELEGRAM_BOT_TOKEN' : undefined,
    })
    writeConfig(channelsPath, cfg)
    return {
      status: 'done',
      summary: `channels.yaml written (cli + mcp_server${tgToken ? ' + telegram' : ''})`,
      data: { channelsPath },
    }
  }

  // Interactive — one yes/no per optional channel; CLI is always on.
  const enableTg = await deps.prompter.confirm({
    message: 'Enable Telegram channel?',
    default: false,
  })
  let tgTokenRef: string | undefined
  if (enableTg) {
    const refOrToken = await deps.prompter.password({
      message:
        'Telegram bot token (paste raw token, or `env:VAR_NAME` to read from env at runtime):',
    })
    if (refOrToken.trim().startsWith('env:')) {
      tgTokenRef = refOrToken.trim()
    } else {
      // Stash raw token under TELEGRAM_BOT_TOKEN in .env, reference it.
      const envPath = path.join(ctx.paths.configDir, '.env')
      upsertEnv(envPath, 'TELEGRAM_BOT_TOKEN', refOrToken.trim())
      tgTokenRef = 'env:TELEGRAM_BOT_TOKEN'
    }
  }

  const enableMcp = await deps.prompter.confirm({
    message: 'Enable MCP-server channel? (lets external hosts treat Talos as an MCP server)',
    default: true,
  })

  const cfg = buildConfig({
    cli: true,
    mcp: enableMcp,
    telegram: enableTg,
    ...(tgTokenRef ? { tgTokenRef } : {}),
  })
  writeConfig(channelsPath, cfg)

  const enabled = ['cli', enableMcp ? 'mcp_server' : null, enableTg ? 'telegram' : null]
    .filter(Boolean)
    .join(' + ')
  return {
    status: 'done',
    summary: `channels.yaml written (${enabled})`,
    data: { channelsPath },
  }
}

type ConfigInput = {
  cli: boolean
  mcp: boolean
  telegram: boolean
  tgTokenRef?: string
}

function buildConfig(input: ConfigInput): Record<string, unknown> {
  return {
    auto_start_daemon: true,
    daemon: { bind: '127.0.0.1:7711' },
    channels: {
      cli: { enabled: input.cli },
      mcp_server: { enabled: input.mcp },
      telegram: input.telegram
        ? {
            enabled: true,
            ...(input.tgTokenRef ? { bot_token_ref: input.tgTokenRef } : {}),
            allowed_users: [],
          }
        : { enabled: false, allowed_users: [] },
    },
  }
}

function writeConfig(channelsPath: string, cfg: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(channelsPath), { recursive: true })
  fs.writeFileSync(channelsPath, stringifyYaml(cfg), { encoding: 'utf8' })
}

function upsertEnv(envPath: string, key: string, value: string): void {
  let raw = ''
  if (fs.existsSync(envPath)) raw = fs.readFileSync(envPath, 'utf8')
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, 'm')
  const line = `${key}=${value}`
  const next = re.test(raw)
    ? raw.replace(re, line)
    : `${raw}${raw.length > 0 && !raw.endsWith('\n') ? '\n' : ''}${line}\n`
  fs.mkdirSync(path.dirname(envPath), { recursive: true })
  fs.writeFileSync(envPath, next, { encoding: 'utf8', mode: 0o600 })
  fs.chmodSync(envPath, 0o600)
}
