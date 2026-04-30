import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { paths as Paths } from '@/config/paths'
import { detectExisting } from '@/init/detect'

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'talos-init-detect-'))
}

function pathsFor(configDir: string): typeof Paths {
  return {
    home: configDir,
    dataDir: configDir,
    configDir,
    dbPath: path.join(configDir, 'db'),
    tokenPath: path.join(configDir, 'daemon.token'),
    pidPath: path.join(configDir, 'daemon.pid'),
    channelsConfigPath: path.join(configDir, 'channels.yaml'),
    logPath: path.join(configDir, 'talos.log'),
    keeperhubTokenPath: path.join(configDir, 'keeperhub.token'),
    burnerWalletPath: path.join(configDir, 'burner.json'),
  } as const
}

describe('detectExisting', () => {
  let dir: string

  beforeEach(() => {
    dir = tmpdir()
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reports empty when nothing exists', () => {
    const state = detectExisting(pathsFor(dir))
    expect(state.empty).toBe(true)
    expect(state.envFile).toBe(false)
    expect(state.envHasOpenAiKey).toBe(false)
  })

  it('detects each artifact independently', () => {
    fs.writeFileSync(path.join(dir, '.env'), 'OPENAI_API_KEY=sk-test\n')
    fs.writeFileSync(path.join(dir, 'burner.json'), '{}')
    fs.writeFileSync(path.join(dir, 'keeperhub.token'), '{}')
    fs.writeFileSync(path.join(dir, 'daemon.token'), 'abc')
    fs.writeFileSync(path.join(dir, 'channels.yaml'), 'auto_start_daemon: true\n')

    const state = detectExisting(pathsFor(dir))
    expect(state).toEqual({
      envFile: true,
      envHasOpenAiKey: true,
      burnerWallet: true,
      keeperhubToken: true,
      daemonToken: true,
      channelsConfig: true,
      empty: false,
    })
  })

  it('flags env file with empty OPENAI_API_KEY value as missing the key', () => {
    fs.writeFileSync(path.join(dir, '.env'), 'OPENAI_API_KEY=\n')
    const state = detectExisting(pathsFor(dir))
    expect(state.envFile).toBe(true)
    expect(state.envHasOpenAiKey).toBe(false)
  })

  it('strips quotes around env values when checking presence', () => {
    fs.writeFileSync(path.join(dir, '.env'), 'OPENAI_API_KEY="sk-quoted"\n')
    const state = detectExisting(pathsFor(dir))
    expect(state.envHasOpenAiKey).toBe(true)
  })

  it('ignores commented-out keys', () => {
    fs.writeFileSync(path.join(dir, '.env'), '# OPENAI_API_KEY=sk-ignored\n')
    const state = detectExisting(pathsFor(dir))
    expect(state.envFile).toBe(true)
    expect(state.envHasOpenAiKey).toBe(false)
  })
})
