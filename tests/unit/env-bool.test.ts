import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadEnv, resetEnvCache } from '@/config/env'

describe('env bool parser (KNOWLEDGE_CRON_DISABLE)', () => {
  const previousValues: Record<string, string | undefined> = {}
  const KEY = 'KNOWLEDGE_CRON_DISABLE'

  beforeEach(() => {
    previousValues[KEY] = process.env[KEY]
  })

  afterEach(() => {
    if (previousValues[KEY] === undefined) delete process.env[KEY]
    else process.env[KEY] = previousValues[KEY]
    resetEnvCache()
  })

  for (const v of ['false', 'FALSE', '0', 'no', 'off', '']) {
    it(`treats "${v}" as false (not the z.coerce.boolean footgun)`, () => {
      process.env[KEY] = v
      resetEnvCache()
      expect(loadEnv().KNOWLEDGE_CRON_DISABLE).toBe(false)
    })
  }

  for (const v of ['true', 'TRUE', '1', 'yes', 'on']) {
    it(`treats "${v}" as true`, () => {
      process.env[KEY] = v
      resetEnvCache()
      expect(loadEnv().KNOWLEDGE_CRON_DISABLE).toBe(true)
    })
  }

  it('falls back to the default when unset', () => {
    delete process.env[KEY]
    resetEnvCache()
    expect(loadEnv().KNOWLEDGE_CRON_DISABLE).toBe(false)
  })
})
