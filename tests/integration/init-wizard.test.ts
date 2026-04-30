import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { paths as Paths } from '@/config/paths'
import type { Prompter } from '@/init/prompt'
import { runWizard } from '@/init/wizard'

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'talos-init-wizard-'))
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

/**
 * Wizard test harness — runs the orchestrator with mocked prompts and a
 * stand-in for the migrations step (PGLite contention is too costly to spin
 * up per test, plus migrations are exercised separately).
 */
describe('runWizard (interactive, fresh install with --skip-keeperhub)', () => {
  let dir: string
  let paths: typeof Paths

  beforeEach(() => {
    dir = tmpdir()
    paths = pathsFor(dir)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('runs all steps end-to-end on an empty config dir', async () => {
    // Mock prompter answers: openai key, mnemonic-saved confirm, channels.
    const prompter: Prompter = {
      text: vi.fn(),
      password: vi
        .fn()
        // openai-key step
        .mockResolvedValueOnce('sk-test-key-abc'),
      confirm: vi
        .fn()
        // wallet: saved mnemonic? -> yes
        .mockResolvedValueOnce(true)
        // channels: enable TG? -> no
        .mockResolvedValueOnce(false)
        // channels: enable MCP? -> yes
        .mockResolvedValueOnce(true),
      select: vi.fn(),
    }

    const printed: string[] = []
    const result = await runWizard({
      mode: 'interactive',
      skipKeeperhub: true,
      skipService: true,
      paths,
      prompter,
      forceIdempotency: 'reset',
      print: (l) => printed.push(l),
    })

    expect(result.succeeded).toBe(true)
    expect(fs.existsSync(path.join(dir, '.env'))).toBe(true)
    expect(fs.existsSync(paths.burnerWalletPath)).toBe(true)
    expect(fs.existsSync(paths.tokenPath)).toBe(true)
    expect(fs.existsSync(paths.channelsConfigPath)).toBe(true)
    // KH skipped -> no token file written.
    expect(fs.existsSync(paths.keeperhubTokenPath)).toBe(false)

    // Per-step results recorded.
    expect(result.context.results['openai-key']?.status).toBe('done')
    expect(result.context.results.wallet?.status).toBe('done')
    expect(result.context.results['keeperhub-oauth']?.status).toBe('skipped')
    expect(result.context.results.channels?.status).toBe('done')
    expect(result.context.results['daemon-token']?.status).toBe('done')
    expect(result.context.results.migrations?.status).toBe('done')
    expect(result.context.results.service?.status).toBe('skipped')

    // Summary mentions next steps.
    const out = printed.join('\n')
    expect(out).toContain('Talos init complete')
    expect(out).toContain('talos repl')
  })

  it('non-interactive reads OPENAI_API_KEY from env and skips KH/service', async () => {
    process.env.OPENAI_API_KEY = 'sk-non-interactive'
    try {
      const result = await runWizard({
        mode: 'non-interactive',
        paths,
        forceIdempotency: 'reset',
        print: () => undefined,
      })
      expect(result.succeeded).toBe(true)
      expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toContain(
        'OPENAI_API_KEY=sk-non-interactive',
      )
      expect(result.context.results['keeperhub-oauth']?.status).toBe('skipped')
      expect(result.context.results.service?.status).toBe('skipped')
    } finally {
      delete process.env.OPENAI_API_KEY
    }
  })

  it('idempotent rerun: detects existing config and keeps everything', async () => {
    // Pre-seed config dir.
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.env'), 'OPENAI_API_KEY=sk-existing\n')
    fs.writeFileSync(
      paths.burnerWalletPath,
      JSON.stringify({
        privateKey: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
      }),
    )
    fs.writeFileSync(paths.tokenPath, 'existing-token')
    fs.writeFileSync(paths.channelsConfigPath, 'auto_start_daemon: true\n')

    const result = await runWizard({
      mode: 'interactive',
      skipKeeperhub: true,
      skipService: true,
      paths,
      prompter: {
        text: vi.fn(),
        password: vi.fn(),
        confirm: vi.fn(),
        select: vi.fn(),
      },
      forceIdempotency: 'keep',
      print: () => undefined,
    })

    expect(result.succeeded).toBe(true)
    expect(result.context.results['openai-key']?.status).toBe('kept')
    expect(result.context.results.wallet?.status).toBe('kept')
    expect(result.context.results['daemon-token']?.status).toBe('kept')
    expect(result.context.results.channels?.status).toBe('kept')
    // Existing files untouched.
    expect(fs.readFileSync(paths.tokenPath, 'utf8')).toBe('existing-token')
    expect(fs.readFileSync(paths.channelsConfigPath, 'utf8')).toBe('auto_start_daemon: true\n')
  })
})
