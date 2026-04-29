import { createConfig } from '@lifi/sdk'

let initialized = false

/**
 * Initialize the Li.Fi SDK once for the lifetime of the daemon.
 *
 * The SDK uses a global config — there is no instance-scoped client. We
 * gate the call so repeated invocations (per-request, per-test) are no-ops
 * after the first one.
 *
 * `integrator` is a free-form identifier the API logs against the request;
 * Li.Fi recommends setting it for usage analytics. No API key is required
 * for the public read endpoints (10 req/s/IP rate limit).
 */
export function ensureLifiSdk(): void {
  if (initialized) return
  createConfig({ integrator: 'talos' })
  initialized = true
}

/**
 * Reset for tests so each test exercises the init path. Production code
 * should never call this.
 */
export function resetLifiSdkForTests(): void {
  initialized = false
}
