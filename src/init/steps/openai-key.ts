import fs from 'node:fs'
import path from 'node:path'
import type { StepResult, WizardContext } from '../context'
import type { Prompter } from '../prompt'

export type OpenAiKeyDeps = {
  prompter: Prompter
  /** Override env reader (tests). */
  readEnv?: (k: string) => string | undefined
}

/**
 * Prompt for an OpenAI API key (or read from env in non-interactive mode) and
 * persist it to `paths.configDir/.env` (mode 0600).
 *
 * Idempotency: when the env file already has a non-empty `OPENAI_API_KEY=...`
 * line and the user chose `keep`, this step is a no-op. In `partial-oauth-only`
 * mode we always preserve. Otherwise we prompt.
 */
export async function runOpenAiKeyStep(
  ctx: WizardContext,
  deps: OpenAiKeyDeps,
): Promise<StepResult> {
  const envPath = path.join(ctx.paths.configDir, '.env')

  if (
    ctx.idempotency === 'partial-oauth-only' ||
    (ctx.idempotency === 'keep' && ctx.existing.envHasOpenAiKey)
  ) {
    return { status: 'kept', summary: `OpenAI key kept (${envPath})` }
  }

  let key: string | undefined
  if (ctx.mode === 'non-interactive') {
    const readEnv = deps.readEnv ?? ((k) => process.env[k])
    key = readEnv('OPENAI_API_KEY')
    if (!key) {
      throw new Error('non-interactive mode: OPENAI_API_KEY env var is required')
    }
  } else {
    key = await deps.prompter.password({
      message: 'OpenAI API key (sk-...):',
    })
    if (!key || key.trim().length === 0) {
      throw new Error('OpenAI API key required')
    }
  }

  fs.mkdirSync(ctx.paths.configDir, { recursive: true })
  upsertEnvKey(envPath, 'OPENAI_API_KEY', key.trim())
  fs.chmodSync(envPath, 0o600)

  return {
    status: 'done',
    summary: `OpenAI key written to ${envPath}`,
    data: { envPath },
  }
}

/**
 * Idempotent KEY=VALUE writer. If the file exists and already has KEY,
 * replace the line. Otherwise append. Preserves all other lines verbatim.
 */
export function upsertEnvKey(envPath: string, key: string, value: string): void {
  let raw = ''
  if (fs.existsSync(envPath)) {
    raw = fs.readFileSync(envPath, 'utf8')
  }
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, 'm')
  const line = `${key}=${value}`
  const next = re.test(raw)
    ? raw.replace(re, line)
    : `${raw}${raw.length > 0 && !raw.endsWith('\n') ? '\n' : ''}${line}\n`
  fs.writeFileSync(envPath, next, { encoding: 'utf8', mode: 0o600 })
}
