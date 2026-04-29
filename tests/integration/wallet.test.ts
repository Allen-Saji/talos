import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const baseEnv = {
  TALOS_DAEMON_PORT: 7711,
  TALOS_LOG_LEVEL: 'silent' as const,
  NODE_ENV: 'test' as const,
  BLOCKSCOUT_MCP_URL: 'https://mcp.blockscout.com/mcp',
}

// Hoisted so the mock has a valid default return value before any module
// (notably `@/shared/logger`) calls `loadEnv()` at import time.
const { loadEnvMock } = vi.hoisted(() => {
  const fn = vi.fn()
  fn.mockReturnValue({
    TALOS_DAEMON_PORT: 7711,
    TALOS_LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
    BLOCKSCOUT_MCP_URL: 'https://mcp.blockscout.com/mcp',
  })
  return { loadEnvMock: fn }
})

vi.mock('@/config/paths', async () => {
  const tmp = path.join(os.tmpdir(), `talos-wallet-${process.pid}-${Date.now()}`)
  return {
    paths: {
      home: tmp,
      dataDir: path.join(tmp, 'data'),
      configDir: path.join(tmp, 'config'),
      dbPath: path.join(tmp, 'data', 'db'),
      tokenPath: path.join(tmp, 'config', 'daemon.token'),
      pidPath: path.join(tmp, 'config', 'daemon.pid'),
      channelsConfigPath: path.join(tmp, 'config', 'channels.yaml'),
      logPath: path.join(tmp, 'data', 'talos.log'),
      keeperhubTokenPath: path.join(tmp, 'config', 'keeperhub.token'),
      burnerWalletPath: path.join(tmp, 'config', 'burner.json'),
    },
  }
})

vi.mock('@/config/env', () => ({
  loadEnv: loadEnvMock,
  resetEnvCache: vi.fn(),
}))

import { paths } from '@/config/paths'
import { getWalletAccount, getWalletAddress, getWalletSource, resetWalletForTests } from '@/wallet'

beforeEach(() => {
  resetWalletForTests()
  // Clean burner file between tests so each one exercises the right load path.
  if (fs.existsSync(paths.burnerWalletPath)) fs.rmSync(paths.burnerWalletPath)
})

afterEach(() => {
  if (fs.existsSync(paths.burnerWalletPath)) fs.rmSync(paths.burnerWalletPath)
})

describe('wallet module', () => {
  it('loads from EVM_PRIVATE_KEY when set (with 0x prefix)', () => {
    const key = generatePrivateKey()
    loadEnvMock.mockReturnValue({ ...baseEnv, EVM_PRIVATE_KEY: key } as never)

    const account = getWalletAccount()
    expect(account.address).toBe(privateKeyToAccount(key).address)
    expect(getWalletSource()).toBe('env')
    expect(fs.existsSync(paths.burnerWalletPath)).toBe(false)
  })

  it('accepts EVM_PRIVATE_KEY without 0x prefix', () => {
    const key = generatePrivateKey()
    loadEnvMock.mockReturnValue({ ...baseEnv, EVM_PRIVATE_KEY: key.slice(2) } as never)

    const account = getWalletAccount()
    expect(account.address).toBe(privateKeyToAccount(key).address)
    expect(getWalletSource()).toBe('env')
  })

  it('generates a fresh burner when env is unset and no file exists', () => {
    loadEnvMock.mockReturnValue(baseEnv as never)

    const account = getWalletAccount()
    expect(account.address).toMatch(/^0x[a-fA-F0-9]{40}$/)
    expect(getWalletSource()).toBe('burner-fresh')
    expect(fs.existsSync(paths.burnerWalletPath)).toBe(true)
    const stats = fs.statSync(paths.burnerWalletPath)
    expect(stats.mode & 0o777).toBe(0o600)
  })

  it('reuses a persisted burner across calls', () => {
    loadEnvMock.mockReturnValue(baseEnv as never)

    // First call: generates + persists.
    const a = getWalletAccount()
    resetWalletForTests()

    // Second call (env still empty) should load from disk, same address.
    const b = getWalletAccount()
    expect(b.address).toBe(a.address)
    expect(getWalletSource()).toBe('burner-disk')
  })

  it('regenerates if the burner file is malformed', () => {
    loadEnvMock.mockReturnValue(baseEnv as never)

    fs.mkdirSync(path.dirname(paths.burnerWalletPath), { recursive: true })
    fs.writeFileSync(paths.burnerWalletPath, '{ not json')

    const account = getWalletAccount()
    expect(account.address).toMatch(/^0x[a-fA-F0-9]{40}$/)
    expect(getWalletSource()).toBe('burner-fresh')
  })

  it('caches the account across multiple getWalletAccount calls', () => {
    loadEnvMock.mockReturnValue(baseEnv as never)

    const a = getWalletAccount()
    const b = getWalletAccount()
    expect(b).toBe(a) // exact same instance
  })

  it('getWalletAddress returns the same address as getWalletAccount', () => {
    loadEnvMock.mockReturnValue(baseEnv as never)
    expect(getWalletAddress()).toBe(getWalletAccount().address)
  })
})
