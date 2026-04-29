import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createDaemonClient, type DaemonClient } from '@/channels/ws-client'
import { child } from '@/shared/logger'

const log = child({ module: 'mcp-server-channel' })

export type McpProxyOpts = {
  daemonUrl: string
  token: string
  /** Override daemon client (testing). */
  daemonClient?: DaemonClient
  /** Stable thread id (default: `mcp:${pid}:${startedAt}`). */
  threadId?: string
  /** Server info advertised to MCP host. */
  serverName?: string
  serverVersion?: string
}

export type McpProxyHandle = {
  /** McpServer instance — useful in tests. */
  server: McpServer
  /** Connect the McpServer to a transport. */
  connect(
    transport: ConstructorParameters<typeof McpServer>[1] extends never
      ? never
      : Parameters<McpServer['connect']>[0],
  ): Promise<void>
  /** Close transport + daemon client. */
  close(): Promise<void>
}

/**
 * Build the MCP-server channel adapter — a stdio MCP server that, on tool
 * call, forwards the prompt over WS to talosd, accumulates the streamed
 * `text-delta`s, and returns the assistant text as the tool result.
 *
 * In v1 a single tool is exposed: `talos_run({ prompt })`. Per host-session
 * thread keeps the agent stateful across calls (per architecture.md §MCP
 * channel).
 */
export async function createMcpProxy(opts: McpProxyOpts): Promise<McpProxyHandle> {
  const threadId = opts.threadId ?? `mcp:${process.pid}:${Date.now()}`
  const client =
    opts.daemonClient ??
    createDaemonClient({ url: opts.daemonUrl, token: opts.token, client: 'talos-mcp-proxy' })
  if (!opts.daemonClient) await client.start()

  const server = new McpServer({
    name: opts.serverName ?? 'talos',
    version: opts.serverVersion ?? '0.1.0',
  })

  server.registerTool(
    'talos_run',
    {
      description:
        'Run an end-to-end Talos agent turn. Sends the prompt to the running talosd, returns the assembled assistant text. Maintains a single thread per host session.',
      inputSchema: { prompt: z.string().min(1) },
    },
    async ({ prompt }) => {
      let assembled = ''
      try {
        const stream = client.runStart({ threadId, prompt })
        // Pre-attach catch so a synchronous done-rejection (e.g. RUN_START_FAILED)
        // never surfaces as an UnhandledPromiseRejection across await boundaries.
        const settledDone: Promise<unknown> = stream.done.catch((err: unknown) => err)
        for await (const ev of stream.events) {
          if (!ev || typeof ev !== 'object') continue
          const e = ev as { type?: string; text?: string }
          if (e.type === 'text-delta' && typeof e.text === 'string') {
            assembled += e.text
          }
        }
        const result = await settledDone
        if (result instanceof Error) throw result
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `talos_run failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        }
      }
      return {
        content: [{ type: 'text', text: assembled || '(no response)' }],
      }
    },
  )

  return {
    server,
    async connect(transport): Promise<void> {
      await server.connect(transport)
    },
    async close(): Promise<void> {
      try {
        await server.close()
      } catch (err) {
        log.warn({ err }, 'mcp server close failed')
      }
      if (!opts.daemonClient) {
        try {
          await client.close()
        } catch (err) {
          log.warn({ err }, 'daemon client close failed')
        }
      }
    },
  }
}

/** Bootstraps the proxy on stdio — used by `talos serve --mcp`. */
export async function runStdioMcpProxy(opts: McpProxyOpts): Promise<void> {
  const handle = await createMcpProxy(opts)
  const transport = new StdioServerTransport()
  await handle.connect(transport)

  await new Promise<void>((resolve) => {
    const onClose = (): void => resolve()
    transport.onclose = onClose
    process.once('SIGINT', () => resolve())
    process.once('SIGTERM', () => resolve())
  })

  await handle.close()
}
