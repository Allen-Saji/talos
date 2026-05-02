/**
 * KeeperHub live smoke test (Phase B + Phase C).
 *
 * Phase B (always runs):
 *   - OAuth round-trip: discover -> DCR -> loopback -> browser -> exchange -> save
 *   - MCP connect + listTools()
 *   - One read attempt (get_execution_logs with empty args, fail-soft)
 *
 * Phase C (gated on confirm):
 *   - executeTransfer on Sepolia
 *   - Poll until terminal status, print workflow URL + tx hash
 *
 * Token is written to a TEMP path. The real session at
 * ~/.config/talos/keeperhub.token is never touched.
 *
 * Run: pnpm smoke:kh
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { confirm, input } from '@inquirer/prompts'
import { openInBrowser } from '@/init/browser'
import { startLoopback } from '@/init/loopback'
import { createKeeperHubClient } from '@/keeperhub/client'
import {
  buildAuthorizeUrl,
  discoverAuthServer,
  exchangeCode,
  generatePkce,
  generateState,
  registerClient,
} from '@/keeperhub/oauth'
import { saveSession, sessionFromResponse } from '@/keeperhub/token'

const PREFIX = '[smoke:kh]'
const LOOPBACK_TIMEOUT_MS = 180_000
const POLL_TIMEOUT_MS = 90_000
const POLL_INTERVAL_MS = 3_000

function log(line: string): void {
  process.stdout.write(`${PREFIX} ${line}\n`)
}
function ok(line: string): void {
  process.stdout.write(`${PREFIX} OK   ${line}\n`)
}
function warn(line: string): void {
  process.stdout.write(`${PREFIX} WARN ${line}\n`)
}
function failLine(line: string): void {
  process.stderr.write(`${PREFIX} FAIL ${line}\n`)
}
function redact(token: string): string {
  if (token.length <= 12) return '***'
  return `${token.slice(0, 8)}...${token.slice(-4)} (len=${token.length})`
}

async function phaseB(tokenPath: string): Promise<{
  toolNames: string[]
  client: Awaited<ReturnType<typeof createKeeperHubClient>>
}> {
  log('=== Phase B: OAuth + MCP listTools (live) ===')

  log('1/5 discover auth server')
  const meta = await discoverAuthServer()
  ok(`issuer=${meta.issuer}`)
  ok(`authorization_endpoint=${meta.authorization_endpoint}`)
  ok(`token_endpoint=${meta.token_endpoint}`)

  log('2/5 start loopback (binds 127.0.0.1:<ephemeral>)')
  const expectedState = generateState()
  const lb = await startLoopback({ expectedState, timeoutMs: LOOPBACK_TIMEOUT_MS })
  ok(`redirect_uri=${lb.redirectUri}`)

  let registered: Awaited<ReturnType<typeof registerClient>> | null = null
  let success = false
  try {
    log('3/5 dynamic client registration (DCR)')
    registered = await registerClient({
      meta,
      redirectUri: lb.redirectUri,
      clientName: 'talos-smoke',
    })
    ok(`client_id=${registered.client_id}`)

    log('4/5 build authorize URL + open browser')
    const pkce = generatePkce()
    const authorizeUrl = buildAuthorizeUrl({
      meta,
      clientId: registered.client_id,
      redirectUri: lb.redirectUri,
      pkce,
      state: expectedState,
    })
    const opener = await openInBrowser(authorizeUrl)
    if (opener.opened) {
      ok('browser opened, complete consent there')
    } else {
      warn('could not open browser automatically; paste this URL manually:')
      log(`  ${authorizeUrl}`)
    }

    log(`     waiting up to ${LOOPBACK_TIMEOUT_MS / 1000}s for callback...`)
    const { code } = await lb.result
    ok(`callback received (code length=${code.length})`)

    log('5/5 exchange code for token + save to temp path')
    const tokenRes = await exchangeCode({
      meta,
      clientId: registered.client_id,
      ...(registered.client_secret !== undefined ? { clientSecret: registered.client_secret } : {}),
      redirectUri: lb.redirectUri,
      code,
      pkceVerifier: pkce.verifier,
    })
    ok(`access_token=${redact(tokenRes.access_token)}`)
    ok(`scope=${tokenRes.scope ?? '(none)'}`)
    ok(`expires_in=${tokenRes.expires_in ?? '(none)'}s`)
    ok(`refresh_token=${tokenRes.refresh_token ? 'present' : 'absent'}`)

    const session = sessionFromResponse(registered, tokenRes)
    await saveSession(tokenPath, session)
    ok(`session saved -> ${tokenPath}`)

    log('     creating KeeperHub MCP client')
    const client = await createKeeperHubClient({ tokenPath })
    const tools = await client.listTools()
    const toolNames = Object.keys(tools)
    if (toolNames.length === 0) {
      throw new Error('listTools() returned 0 tools')
    }
    ok(`listTools() returned ${toolNames.length} tool(s)`)
    log(`     first 10: ${toolNames.slice(0, 10).join(', ')}`)

    if (toolNames.includes('get_execution_logs')) {
      try {
        const result = await client.callTool('get_execution_logs', {})
        ok('get_execution_logs() returned (truncated):')
        const preview = JSON.stringify(result).slice(0, 200)
        log(`     ${preview}${preview.length === 200 ? '...' : ''}`)
      } catch (err) {
        warn(`get_execution_logs failed: ${err instanceof Error ? err.message : String(err)}`)
        warn('continuing — listTools() handshake already proves auth + transport')
      }
    } else {
      warn('get_execution_logs not in tool surface; skipped read attempt')
    }

    success = true
    return { toolNames, client }
  } finally {
    await lb.close()
    if (!success) {
      log('     (loopback closed; cleanup partial — see error above)')
    }
  }
}

async function phaseC(client: Awaited<ReturnType<typeof createKeeperHubClient>>): Promise<void> {
  log('=== Phase C: live mutate (Sepolia executeTransfer) ===')
  log('This will fire a REAL KeeperHub workflow against your KH-linked wallet.')
  log('Make sure that wallet has Sepolia ETH. KH chooses the sender; we pick recipient + amount.')

  const proceed = await confirm({
    message: 'Proceed with Phase C?',
    default: false,
  })
  if (!proceed) {
    warn('Phase C skipped (user declined)')
    return
  }

  const recipient = await input({
    message:
      'Recipient address on Sepolia (recommend YOUR OWN address for a no-loss self-transfer):',
    validate: (v) =>
      /^0x[a-fA-F0-9]{40}$/.test(v.trim()) || 'must be a 0x-prefixed 40-char hex address',
  })
  const amount = await input({
    message: 'Amount in ETH:',
    default: '0.0001',
    validate: (v) => Number.parseFloat(v) > 0 || 'must be > 0',
  })

  log(`firing executeTransfer: sepolia, ${amount} ETH -> ${recipient.trim()}`)
  const exec = await client.executeTransfer({
    network: 'sepolia',
    recipient_address: recipient.trim(),
    amount,
  })
  ok(`execution_id=${exec.executionId || '(empty)'}`)
  ok(`initial status=${exec.status}`)
  if (exec.txHash) ok(`tx_hash=${exec.txHash}`)
  if (exec.error) warn(`initial error field=${exec.error}`)

  if (!exec.executionId) {
    warn('no execution_id returned; cannot poll. Raw output above.')
    return
  }

  log(`polling status every ${POLL_INTERVAL_MS / 1000}s (up to ${POLL_TIMEOUT_MS / 1000}s)...`)
  const startedAt = Date.now()
  let last = exec
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    if (last.status === 'success' || last.status === 'failed' || last.status === 'cancelled') {
      break
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    last = await client.getExecutionStatus(exec.executionId)
    log(`     status=${last.status}${last.txHash ? ` tx=${last.txHash}` : ''}`)
  }

  if (last.status === 'success') {
    ok(`workflow succeeded`)
    if (last.txHash) {
      ok(`tx_hash=${last.txHash}`)
      ok(`explorer: https://sepolia.etherscan.io/tx/${last.txHash}`)
    }
  } else {
    failLine(`workflow terminal status=${last.status}${last.error ? ` error=${last.error}` : ''}`)
    process.exitCode = 2
  }
}

async function main(): Promise<void> {
  const tokenPath = path.join(os.tmpdir(), `talos-smoke-kh-${process.pid}-${Date.now()}.json`)
  log(`temp token path: ${tokenPath}`)

  let client: Awaited<ReturnType<typeof createKeeperHubClient>> | undefined
  try {
    const phaseBResult = await phaseB(tokenPath)
    client = phaseBResult.client

    log('')
    ok('Phase B passed.')
    log('')

    await phaseC(client)

    log('')
    ok('smoke test complete')
  } catch (err) {
    failLine(err instanceof Error ? (err.stack ?? err.message) : String(err))
    process.exitCode = 1
  } finally {
    if (client) {
      await client.close().catch(() => undefined)
    }
    await fs.unlink(tokenPath).catch(() => undefined)
    log(`(cleanup) temp token removed: ${tokenPath}`)
  }
}

main()
