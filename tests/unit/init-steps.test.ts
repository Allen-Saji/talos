import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { paths as Paths } from '@/config/paths'
import type { WizardContext } from '@/init/context'
import type { ExistingState } from '@/init/detect'
import type { Prompter } from '@/init/prompt'
import { runChannelsStep } from '@/init/steps/channels'
import { runDaemonTokenStep } from '@/init/steps/daemon-token'
import { runOpenAiKeyStep, upsertEnvKey } from '@/init/steps/openai-key'
import { runWalletStep } from '@/init/steps/wallet'
import { runWelcomeStep } from '@/init/steps/welcome'

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'talos-init-steps-'))
}

function pathsFor(configDir: string): typeof Paths {
  return {
    home: configDir,
    dataDir: path.join(configDir, 'data'),
    configDir,
    dbPath: path.join(configDir, 'data', 'db'),
    tokenPath: path.join(configDir, 'daemon.token'),
    pidPath: path.join(configDir, 'daemon.pid'),
    channelsConfigPath: path.join(configDir, 'channels.yaml'),
    logPath: path.join(configDir, 'talos.log'),
    keeperhubTokenPath: path.join(configDir, 'keeperhub.token'),
    burnerWalletPath: path.join(configDir, 'burner.json'),
  } as const
}

function emptyExisting(): ExistingState {
  return {
    envFile: false,
    envHasOpenAiKey: false,
    burnerWallet: false,
    keeperhubToken: false,
    daemonToken: false,
    channelsConfig: false,
    empty: true,
  }
}

function makeCtx(overrides: Partial<WizardContext> & { paths: typeof Paths }): WizardContext {
  return {
    mode: 'interactive',
    skipKeeperhub: false,
    skipService: false,
    existing: emptyExisting(),
    idempotency: 'reset',
    results: {},
    ...overrides,
  }
}

function makePrompter(overrides: Partial<Prompter> = {}): Prompter {
  return {
    text: vi.fn(),
    password: vi.fn(),
    confirm: vi.fn(),
    select: vi.fn(),
    ...overrides,
  }
}

describe('runWelcomeStep', () => {
  it('throws when node major < 22', () => {
    expect(() =>
      runWelcomeStep(makeCtx({ paths: pathsFor('/tmp/x') }), {
        log: () => undefined,
        nodeVersion: '20.10.0',
      }),
    ).toThrow(/below the minimum/)
  })

  it('passes on node 22+', () => {
    const lines: string[] = []
    expect(() =>
      runWelcomeStep(makeCtx({ paths: pathsFor('/tmp/x') }), {
        log: (l) => lines.push(l),
        nodeVersion: '22.10.0',
      }),
    ).not.toThrow()
    expect(lines.some((l) => l.includes('Node 22.10.0 OK'))).toBe(true)
  })
})

describe('upsertEnvKey', () => {
  let dir: string
  beforeEach(() => {
    dir = tmpdir()
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('writes a fresh file with mode 0600', () => {
    const envPath = path.join(dir, '.env')
    upsertEnvKey(envPath, 'OPENAI_API_KEY', 'sk-1')
    expect(fs.readFileSync(envPath, 'utf8')).toBe('OPENAI_API_KEY=sk-1\n')
    const stat = fs.statSync(envPath)
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('replaces an existing key in place, preserves other lines', () => {
    const envPath = path.join(dir, '.env')
    fs.writeFileSync(envPath, 'FOO=bar\nOPENAI_API_KEY=sk-old\nBAZ=qux\n')
    upsertEnvKey(envPath, 'OPENAI_API_KEY', 'sk-new')
    expect(fs.readFileSync(envPath, 'utf8')).toBe('FOO=bar\nOPENAI_API_KEY=sk-new\nBAZ=qux\n')
  })

  it('appends when key absent', () => {
    const envPath = path.join(dir, '.env')
    fs.writeFileSync(envPath, 'FOO=bar')
    upsertEnvKey(envPath, 'OPENAI_API_KEY', 'sk-1')
    expect(fs.readFileSync(envPath, 'utf8')).toBe('FOO=bar\nOPENAI_API_KEY=sk-1\n')
  })
})

describe('runOpenAiKeyStep', () => {
  let dir: string
  beforeEach(() => {
    dir = tmpdir()
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('prompts in interactive mode and writes the key', async () => {
    const paths = pathsFor(dir)
    const prompter = makePrompter({
      password: vi.fn().mockResolvedValue('sk-test-123'),
    })
    const result = await runOpenAiKeyStep(makeCtx({ paths }), { prompter })
    expect(result.status).toBe('done')
    const written = fs.readFileSync(path.join(dir, '.env'), 'utf8')
    expect(written).toContain('OPENAI_API_KEY=sk-test-123')
  })

  it('reads from env in non-interactive mode', async () => {
    const paths = pathsFor(dir)
    const ctx = makeCtx({ paths, mode: 'non-interactive' })
    const result = await runOpenAiKeyStep(ctx, {
      prompter: makePrompter(),
      readEnv: (k) => (k === 'OPENAI_API_KEY' ? 'sk-from-env' : undefined),
    })
    expect(result.status).toBe('done')
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toContain('OPENAI_API_KEY=sk-from-env')
  })

  it('throws in non-interactive mode when env is unset', async () => {
    const paths = pathsFor(dir)
    const ctx = makeCtx({ paths, mode: 'non-interactive' })
    await expect(
      runOpenAiKeyStep(ctx, { prompter: makePrompter(), readEnv: () => undefined }),
    ).rejects.toThrow(/OPENAI_API_KEY/)
  })

  it('preserves existing key on `keep` idempotency', async () => {
    const paths = pathsFor(dir)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.env'), 'OPENAI_API_KEY=sk-keep\n')
    const ctx = makeCtx({
      paths,
      idempotency: 'keep',
      existing: { ...emptyExisting(), envFile: true, envHasOpenAiKey: true, empty: false },
    })
    const result = await runOpenAiKeyStep(ctx, { prompter: makePrompter() })
    expect(result.status).toBe('kept')
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toContain('OPENAI_API_KEY=sk-keep')
  })
})

describe('runWalletStep', () => {
  let dir: string
  beforeEach(() => {
    dir = tmpdir()
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('generates a wallet and persists privateKey + mnemonic', async () => {
    const paths = pathsFor(dir)
    const prompter = makePrompter({ confirm: vi.fn().mockResolvedValue(true) })
    const lines: string[] = []
    const result = await runWalletStep(makeCtx({ paths }), {
      prompter,
      log: (l) => lines.push(l),
    })
    expect(result.status).toBe('done')
    expect(result.data?.regenerated).toBe(true)
    const stored = JSON.parse(fs.readFileSync(paths.burnerWalletPath, 'utf8'))
    expect(stored.privateKey).toMatch(/^0x[0-9a-f]{64}$/)
    expect(stored.mnemonic).toMatch(/^(\w+ ){11}\w+$/)
    expect(lines.some((l) => l.includes('Mnemonic:'))).toBe(true)
  })

  it('preserves existing wallet under partial-oauth-only', async () => {
    const paths = pathsFor(dir)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      paths.burnerWalletPath,
      JSON.stringify({
        privateKey: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
      }),
    )
    const ctx = makeCtx({
      paths,
      idempotency: 'partial-oauth-only',
      existing: { ...emptyExisting(), burnerWallet: true, empty: false },
    })
    const result = await runWalletStep(ctx, { prompter: makePrompter() })
    expect(result.status).toBe('kept')
    expect(result.data?.regenerated).toBe(false)
  })

  it('asks before regenerating an existing wallet in interactive mode', async () => {
    const paths = pathsFor(dir)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      paths.burnerWalletPath,
      JSON.stringify({
        privateKey: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
      }),
    )
    const confirm = vi.fn().mockResolvedValueOnce(false) // regenerate? -> no
    const ctx = makeCtx({
      paths,
      idempotency: 'reset',
      existing: { ...emptyExisting(), burnerWallet: true, empty: false },
    })
    const result = await runWalletStep(ctx, {
      prompter: makePrompter({ confirm }),
    })
    expect(result.status).toBe('kept')
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Regenerate') }),
    )
  })
})

describe('runDaemonTokenStep', () => {
  let dir: string
  beforeEach(() => {
    dir = tmpdir()
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('writes a 64-char hex token (mode 0600)', () => {
    const paths = pathsFor(dir)
    const result = runDaemonTokenStep(makeCtx({ paths }))
    expect(result.status).toBe('done')
    const raw = fs.readFileSync(paths.tokenPath, 'utf8').trim()
    expect(raw).toMatch(/^[0-9a-f]{64}$/)
    expect(fs.statSync(paths.tokenPath).mode & 0o777).toBe(0o600)
  })

  it('preserves existing token under keep', () => {
    const paths = pathsFor(dir)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(paths.tokenPath, 'old-token-do-not-touch')
    const ctx = makeCtx({
      paths,
      idempotency: 'keep',
      existing: { ...emptyExisting(), daemonToken: true, empty: false },
    })
    const result = runDaemonTokenStep(ctx)
    expect(result.status).toBe('kept')
    expect(fs.readFileSync(paths.tokenPath, 'utf8')).toBe('old-token-do-not-touch')
  })
})

describe('runChannelsStep', () => {
  let dir: string
  beforeEach(() => {
    dir = tmpdir()
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('writes default config (cli + mcp_server only) when user declines TG', async () => {
    const paths = pathsFor(dir)
    const confirm = vi
      .fn()
      // enable TG? -> no
      .mockResolvedValueOnce(false)
      // enable MCP? -> yes
      .mockResolvedValueOnce(true)
    const result = await runChannelsStep(makeCtx({ paths }), {
      prompter: makePrompter({ confirm }),
    })
    expect(result.status).toBe('done')
    const raw = fs.readFileSync(paths.channelsConfigPath, 'utf8')
    expect(raw).toContain('cli:')
    expect(raw).toContain('enabled: true')
    expect(raw).toMatch(/telegram:[\s\S]*?enabled: false/)
    expect(raw).toMatch(/mcp_server:[\s\S]*?enabled: true/)
  })

  it('writes TG config + stashes raw token in .env', async () => {
    const paths = pathsFor(dir)
    const confirm = vi
      .fn()
      .mockResolvedValueOnce(true) // enable TG?
      .mockResolvedValueOnce(true) // enable MCP?
    const password = vi.fn().mockResolvedValue('123:abc-tg-token')
    const result = await runChannelsStep(makeCtx({ paths }), {
      prompter: makePrompter({ confirm, password }),
    })
    expect(result.status).toBe('done')
    const cfg = fs.readFileSync(paths.channelsConfigPath, 'utf8')
    expect(cfg).toMatch(/telegram:[\s\S]*?enabled: true/)
    expect(cfg).toContain('bot_token_ref: env:TELEGRAM_BOT_TOKEN')
    const env = fs.readFileSync(path.join(dir, '.env'), 'utf8')
    expect(env).toContain('TELEGRAM_BOT_TOKEN=123:abc-tg-token')
  })

  it('honors `env:VAR_NAME` token ref without writing .env', async () => {
    const paths = pathsFor(dir)
    const confirm = vi
      .fn()
      .mockResolvedValueOnce(true) // TG yes
      .mockResolvedValueOnce(true) // MCP yes
    const password = vi.fn().mockResolvedValue('env:MY_BOT_TOKEN')
    await runChannelsStep(makeCtx({ paths }), {
      prompter: makePrompter({ confirm, password }),
    })
    expect(fs.existsSync(path.join(dir, '.env'))).toBe(false)
    expect(fs.readFileSync(paths.channelsConfigPath, 'utf8')).toContain(
      'bot_token_ref: env:MY_BOT_TOKEN',
    )
  })

  it('non-interactive infers TG enabled from TELEGRAM_BOT_TOKEN env presence', async () => {
    const paths = pathsFor(dir)
    const result = await runChannelsStep(makeCtx({ paths, mode: 'non-interactive' }), {
      prompter: makePrompter(),
      readEnv: (k) => (k === 'TELEGRAM_BOT_TOKEN' ? 'tok' : undefined),
    })
    expect(result.status).toBe('done')
    const cfg = fs.readFileSync(paths.channelsConfigPath, 'utf8')
    expect(cfg).toMatch(/telegram:[\s\S]*?enabled: true/)
    expect(cfg).toContain('bot_token_ref: env:TELEGRAM_BOT_TOKEN')
  })

  it('preserves existing channels.yaml under keep', async () => {
    const paths = pathsFor(dir)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(paths.channelsConfigPath, 'existing: true\n')
    const ctx = makeCtx({
      paths,
      idempotency: 'keep',
      existing: { ...emptyExisting(), channelsConfig: true, empty: false },
    })
    const result = await runChannelsStep(ctx, { prompter: makePrompter() })
    expect(result.status).toBe('kept')
    expect(fs.readFileSync(paths.channelsConfigPath, 'utf8')).toBe('existing: true\n')
  })
})
