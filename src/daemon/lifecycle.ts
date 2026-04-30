import fs from 'node:fs'
import { loadEnv, resetEnvCache } from '@/config/env'
import { paths } from '@/config/paths'
import { ensureToken } from '@/config/token'
import { type AnnotationLookup, createKeeperHubMiddleware, type ToolMiddleware } from '@/keeperhub'
import { defaultMcpServers, McpHost, McpToolSource, type ToolAnnotations } from '@/mcp-host'
import {
  assertNoLiveDaemon,
  createDb,
  type DbHandle,
  removePidFile,
  runMigrations,
  writePidFile,
} from '@/persistence'
import { AgentRegistry, TALOS_ETH_AGENT } from '@/runtime/agents'
import { createOpenAIEmbeddings } from '@/runtime/embeddings'
import { createProviderRouter } from '@/runtime/providers'
import { createRuntime } from '@/runtime/runtime'
import type { RunContext } from '@/runtime/types'
import { logger } from '@/shared/logger'
import { createAgentKitToolSource } from '@/tools/agentkit'
import { createLifiToolSource } from '@/tools/lifi'
import type { NativeToolSource } from '@/tools/native'
import { type ControlPlane, createControlPlane } from './server'

/**
 * Build the list of in-process (Talos-owned) tool sources Talos boots with.
 * Each source contributes pre-namespaced tools and self-declared
 * annotations consulted by the KeeperHub middleware.
 *
 * AgentKit init is async (it awaits action-provider registration); other
 * sources construct synchronously.
 */
async function defaultNativeToolSources(): Promise<NativeToolSource[]> {
  return [createLifiToolSource(), await createAgentKitToolSource()]
}

export type DaemonHandle = {
  /** Wait for shutdown — resolves on SIGTERM/SIGINT or explicit `stop()`. */
  done: Promise<void>
  /** Trigger graceful shutdown. */
  stop(): Promise<void>
  /** Bound port (useful when env var TALOS_DAEMON_PORT was 0 in tests). */
  port: number
  controlPlane: ControlPlane
}

export type StartDaemonOpts = {
  /** Override port; otherwise from env TALOS_DAEMON_PORT. */
  port?: number
  /** Override host; default 127.0.0.1. */
  host?: string
  /** Disable signal handlers — useful for tests where vitest manages process lifecycle. */
  installSignalHandlers?: boolean
  /** Use ephemeral PGLite (no on-disk file). Tests only. */
  ephemeralDb?: boolean
  /**
   * Skip booting the MCP host (no third-party servers spawned). Useful for
   * tests that don't need tools, or for offline development.
   */
  disableMcpHost?: boolean
}

export async function startDaemon(startOpts: StartDaemonOpts = {}): Promise<DaemonHandle> {
  const installSignals = startOpts.installSignalHandlers ?? true

  // Refresh env cache in case the file changed since last call.
  resetEnvCache()
  const env = loadEnv()

  // Refuse to boot if another daemon is already running.
  assertNoLiveDaemon()

  fs.mkdirSync(paths.dataDir, { recursive: true })
  fs.mkdirSync(paths.configDir, { recursive: true })

  // Bootstrap the bearer token. First-time generation is logged ONCE so the
  // user can copy it into client config (channels, MCP server, etc).
  const tokenExisted = fs.existsSync(paths.tokenPath)
  const token = await ensureToken()
  if (!tokenExisted) {
    logger.info(
      { tokenPath: paths.tokenPath },
      'generated new daemon bearer token (saved 0600); copy from the file path above',
    )
  }

  // Open DB + run migrations. PGLite ephemeral mode for tests.
  const dbHandle: DbHandle = startOpts.ephemeralDb
    ? await createDb({ ephemeral: true })
    : await createDb({ path: paths.dbPath })
  await runMigrations(dbHandle)

  // MCP host hosts the third-party tool servers. Started before the runtime
  // so the runtime can hold a stable McpToolSource reference. Connection
  // failures are non-fatal — the daemon keeps booting, tools just stay empty
  // until the operator fixes the underlying issue.
  const mcpHost = startOpts.disableMcpHost ? null : new McpHost()
  if (mcpHost) {
    try {
      await mcpHost.start(defaultMcpServers())
    } catch (err) {
      logger.warn({ err }, 'MCP host failed to connect to all servers — continuing with no tools')
    }
  }

  // In-process (native) tool sources contribute Talos-owned tools (Li.Fi,
  // AgentKit cherry-pick, future custom Aave/Uniswap). Share the runtime's
  // tool surface with the MCP host and provide their own annotations to the
  // KeeperHub middleware. No spawn cost, no serialization round-trip.
  const nativeSources: NativeToolSource[] = await defaultNativeToolSources()
  for (const src of nativeSources) {
    logger.info({ source: src.name, tools: src.toolNames().length }, 'native tool source ready')
  }

  // Annotation lookup feeds the KeeperHub `shouldAudit` policy. Native sources
  // declare their own annotations; the MCP host carries parsed + override-merged
  // annotations on its tool index. Native takes priority on collision (matches
  // `mergeToolSources` ordering).
  const annotationLookup: AnnotationLookup = (name) => {
    for (const src of nativeSources) {
      const a = src.annotations(name)
      if (a) return a
    }
    if (mcpHost) {
      const entry = mcpHost.listTools().find((t) => t.namespacedName === name)
      if (entry) return entry.annotations as ToolAnnotations
    }
    return undefined
  }

  // Per-run middleware factory. Bound at boot to db + annotation lookup; the
  // runtime calls it per run with the runId so audit rows carry the right
  // run context. Single writer for `tool_calls` (persistStep no longer inserts).
  const toolMiddleware = (ctx: RunContext): ToolMiddleware =>
    createKeeperHubMiddleware({
      db: dbHandle.db,
      runContext: () => ctx,
      annotations: annotationLookup,
    })

  // Build runtime deps. Knowledge / summarizer / fact pipeline are deferred
  // to follow-up issues (#11/#16/#17 LLM impls).
  const agents = new AgentRegistry()
  agents.register(TALOS_ETH_AGENT, { default: true })
  const providers = createProviderRouter()
  const embeddings = createOpenAIEmbeddings()
  const runtime = createRuntime({
    db: dbHandle,
    providers,
    embeddings,
    agents,
    toolSources: [...(mcpHost ? [new McpToolSource(mcpHost)] : []), ...nativeSources],
    toolMiddleware,
  })

  // Boot control plane.
  const controlPlane = createControlPlane({
    runtime,
    token,
    port: startOpts.port ?? env.TALOS_DAEMON_PORT,
    ...(startOpts.host !== undefined ? { host: startOpts.host } : {}),
  })
  const { port, host } = await controlPlane.start()

  // Write the PID file only after we've successfully bound — avoids leaking
  // a stale PID if start fails.
  writePidFile()

  if (!env.OPENAI_API_KEY) {
    logger.warn(
      'OPENAI_API_KEY not set — control plane up, but run-start frames will fail until configured',
    )
  }

  logger.info({ port, host, pidPath: paths.pidPath }, 'talosd ready')

  let stopping: Promise<void> | null = null
  let resolveDone: (() => void) | undefined
  const done = new Promise<void>((res) => {
    resolveDone = res
  })

  async function stop(): Promise<void> {
    if (stopping) return stopping
    stopping = (async () => {
      logger.info('talosd shutting down')
      try {
        await controlPlane.stop()
      } catch (err) {
        logger.warn({ err }, 'error stopping control plane')
      }
      if (mcpHost) {
        try {
          await mcpHost.stop()
        } catch (err) {
          logger.warn({ err }, 'error stopping mcp host')
        }
      }
      try {
        await dbHandle.close()
      } catch (err) {
        logger.warn({ err }, 'error closing db')
      }
      removePidFile()
      logger.info('talosd stopped')
      resolveDone?.()
    })()
    return stopping
  }

  if (installSignals) {
    const onSig = (sig: NodeJS.Signals) => {
      logger.info({ sig }, 'signal received')
      void stop()
    }
    process.once('SIGTERM', onSig)
    process.once('SIGINT', onSig)
  }

  return { done, stop, port, controlPlane }
}
