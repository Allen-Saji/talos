/**
 * KeeperHub status-query debug.
 *
 * Re-runs OAuth, lists ALL tools, then probes status-query tools with
 * multiple name + arg-shape variants and dumps raw JSON for each.
 *
 * Goal: determine the canonical name + arg shape + status string KH uses
 * for direct executions, so we can fix `getExecutionStatus` in
 * src/keeperhub/client.ts.
 *
 * Usage:
 *   pnpm tsx scripts/debug-kh-status.ts <execution_id>
 *   # default execution_id is the one from the failed smoke run
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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

const PREFIX = '[debug:kh]'
const LOOPBACK_TIMEOUT_MS = 180_000

const DEFAULT_EXEC_ID = 'spgrp6oi4d5ea2fdugdny'

function log(line: string): void {
  process.stdout.write(`${PREFIX} ${line}\n`)
}
function ok(line: string): void {
  process.stdout.write(`${PREFIX} OK   ${line}\n`)
}
function divider(label: string): void {
  process.stdout.write(`\n${PREFIX} ===== ${label} =====\n`)
}

async function authenticate(tokenPath: string): Promise<void> {
  log('OAuth: discovering auth server')
  const meta = await discoverAuthServer()

  const expectedState = generateState()
  const lb = await startLoopback({ expectedState, timeoutMs: LOOPBACK_TIMEOUT_MS })
  log(`OAuth: loopback listening at ${lb.redirectUri}`)

  try {
    const registered = await registerClient({
      meta,
      redirectUri: lb.redirectUri,
      clientName: 'talos-debug',
    })
    const pkce = generatePkce()
    const authorizeUrl = buildAuthorizeUrl({
      meta,
      clientId: registered.client_id,
      redirectUri: lb.redirectUri,
      pkce,
      state: expectedState,
    })
    const opener = await openInBrowser(authorizeUrl)
    if (!opener.opened) {
      log('OAuth: could not open browser; paste this URL manually:')
      log(`  ${authorizeUrl}`)
    } else {
      log('OAuth: browser opened, complete consent')
    }

    const { code } = await lb.result
    const tokenRes = await exchangeCode({
      meta,
      clientId: registered.client_id,
      ...(registered.client_secret !== undefined ? { clientSecret: registered.client_secret } : {}),
      redirectUri: lb.redirectUri,
      code,
      pkceVerifier: pkce.verifier,
    })
    const session = sessionFromResponse(registered, tokenRes)
    await saveSession(tokenPath, session)
    ok(`OAuth complete; session saved -> ${tokenPath}`)
  } finally {
    await lb.close()
  }
}

async function probe(
  client: Awaited<ReturnType<typeof createKeeperHubClient>>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<void> {
  divider(`probe: ${toolName} args=${JSON.stringify(args)}`)
  try {
    const result = await client.callTool(toolName, args)
    log('RAW RESULT:')
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (err) {
    log(`ERROR: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function main(): Promise<void> {
  const execId = process.argv[2] || DEFAULT_EXEC_ID
  const tokenPath = path.join(os.tmpdir(), `talos-debug-kh-${process.pid}-${Date.now()}.json`)
  log(`execution_id: ${execId}`)
  log(`temp token path: ${tokenPath}`)

  let client: Awaited<ReturnType<typeof createKeeperHubClient>> | undefined
  try {
    await authenticate(tokenPath)

    client = await createKeeperHubClient({ tokenPath })
    const tools = await client.listTools()
    const toolNames = Object.keys(tools).sort()

    divider(`all ${toolNames.length} KH tools`)
    for (const name of toolNames) {
      const t = tools[name]
      const desc = (t as { description?: string })?.description ?? ''
      log(`  ${name}${desc ? ` — ${desc.slice(0, 80)}` : ''}`)
    }

    const candidates = toolNames.filter(
      (n) => n.includes('execution') || n.includes('status') || n.includes('run'),
    )
    divider(`candidate status-query tools (${candidates.length})`)
    for (const c of candidates) log(`  ${c}`)

    const argShapes: Array<Record<string, unknown>> = [
      { execution_id: execId },
      { executionId: execId },
      { id: execId },
      { run_id: execId },
    ]

    for (const name of candidates) {
      for (const args of argShapes) {
        await probe(client, name, args)
      }
    }
  } catch (err) {
    process.stderr.write(
      `${PREFIX} FATAL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    )
    process.exitCode = 1
  } finally {
    if (client) await client.close().catch(() => undefined)
    await fs.unlink(tokenPath).catch(() => undefined)
    log(`(cleanup) temp token removed`)
  }
}

main()
