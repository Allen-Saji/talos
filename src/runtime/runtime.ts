import {
  type ModelMessage,
  type OnStepFinishEvent,
  type StreamTextResult,
  stepCountIs,
  streamText,
  type ToolSet,
} from 'ai'
import type { Logger } from 'pino'
import type { DbHandle } from '@/persistence/client'
import {
  appendStep,
  closeRun,
  insertMessageEmbedding,
  openRun,
  updateToolCallStepIds,
  upsertThread,
  writeThreadSummary,
} from '@/persistence/queries'
import { logger } from '@/shared/logger'
import type { AgentRegistry } from './agents'
import { coldRecall, recentMessages, runCount, warmTierSummary } from './memory'
import { buildSystemPrompt } from './prompt'
import { mergeToolSources } from './tool-source'
import type {
  AgentRuntime,
  EmbeddingsService,
  FactPipeline,
  KnowledgeRetriever,
  ProviderRouter,
  RunHandle,
  RunOptions,
  RuntimeConfig,
  ThreadSummarizer,
  ToolMiddlewareFactory,
  ToolSource,
} from './types'

const NULL_KNOWLEDGE_RETRIEVER: KnowledgeRetriever = {
  retrieve: async () => [],
}

export type RuntimeDeps = {
  db: DbHandle
  providers: ProviderRouter
  embeddings: EmbeddingsService
  agents: AgentRegistry
  toolSources?: readonly ToolSource[]
  /**
   * Per-run middleware factory (KeeperHub audit-by-default in production).
   * Called once per run after `openRun` so the middleware has the runId. When
   * unset, tools pass through unwrapped and `tool_calls` rows are not written.
   */
  toolMiddleware?: ToolMiddlewareFactory
  knowledgeRetriever?: KnowledgeRetriever
  factPipeline?: FactPipeline
  summarizer?: ThreadSummarizer
  config?: RuntimeConfig
}

export function createRuntime(deps: RuntimeDeps): AgentRuntime {
  const cfg: Required<RuntimeConfig> = {
    recentMessages: deps.config?.recentMessages ?? 20,
    maxSteps: deps.config?.maxSteps ?? 8,
    coldRecallThreshold: deps.config?.coldRecallThreshold ?? 0.78,
    coldRecallTopK: deps.config?.coldRecallTopK ?? 3,
    knowledgeTopK: deps.config?.knowledgeTopK ?? 5,
    summarizeEveryNRuns: deps.config?.summarizeEveryNRuns ?? 20,
  }
  const knowledge = deps.knowledgeRetriever ?? NULL_KNOWLEDGE_RETRIEVER
  const toolSources = deps.toolSources ?? []

  return {
    async run(opts: RunOptions): Promise<RunHandle> {
      const agent = deps.agents.get(opts.agentId)
      const log = logger.child({ runtime: 'run', threadId: opts.threadId, agentId: agent.id })

      // 1. Embed the user intent (sync — blocks first-token latency by ~100ms,
      //    but unlocks cold recall + episodic write before streamText opens).
      const intentEmbedding = await deps.embeddings.embed(opts.intent)

      // 2. Persist user message + thread upsert in a single transaction.
      await deps.db.db.transaction(async (tx) => {
        await upsertThread(tx, {
          id: opts.threadId,
          channel: opts.channel,
          agentId: agent.id,
        })
        await insertMessageEmbedding(tx, {
          threadId: opts.threadId,
          role: 'user',
          content: opts.intent,
          embedding: intentEmbedding,
        })
      })

      // 3. Pull memory tiers in parallel (independent reads).
      const [hotMessages, warmSummary, coldSummaries, knowledgeChunks] = await Promise.all([
        recentMessages(deps.db.db, opts.threadId, cfg.recentMessages),
        warmTierSummary(deps.db.db, opts.threadId),
        coldRecall(deps.db.db, intentEmbedding, opts.threadId, {
          topK: cfg.coldRecallTopK,
          threshold: cfg.coldRecallThreshold,
        }),
        knowledge.retrieve(opts.intent, { topK: cfg.knowledgeTopK }),
      ])

      // 4. Mount tools + assemble system prompt. Names stay the same after
      //    middleware wrapping, so the prompt can be built before the wrap.
      const rawTools = await mergeToolSources(toolSources)
      const system = buildSystemPrompt({
        persona: agent.persona,
        warmSummary,
        coldRecallSummaries: coldSummaries,
        knowledgeChunks,
        toolNames: Object.keys(rawTools),
      })

      // 5. Open run row (status = 'running').
      const runRow = await openRun(deps.db.db, {
        threadId: opts.threadId,
        prompt: opts.intent,
      })
      const runId = runRow.id

      log.info({ runId }, 'run opened')

      // 5b. Apply tool middleware now that runId exists. The middleware writes
      //     `tool_calls` audit rows (KeeperHub policy) so this is the single
      //     writer — `persistStep` no longer inserts into `tool_calls`. When
      //     unset, tools pass through and the table stays empty for this run.
      const tools = deps.toolMiddleware ? deps.toolMiddleware({ runId })(rawTools) : rawTools

      // 6. Build messages for the model: hot tier + new user message.
      const messages: ModelMessage[] = [...hotMessages, { role: 'user', content: opts.intent }]

      // 7. Stream — register persistence callbacks.
      let nextStepIndex = 0
      let finalAssistantText = ''
      let runCompletionPromise: Promise<void> = Promise.resolve()

      const result: StreamTextResult<ToolSet, never> = streamText({
        model: deps.providers.resolve(agent.modelId),
        system,
        messages,
        tools,
        stopWhen: stepCountIs(cfg.maxSteps),
        abortSignal: opts.abortSignal,
        onStepFinish: async (event) => {
          try {
            await persistStep(deps.db, runId, nextStepIndex++, event)
          } catch (err) {
            log.error({ err, runId }, 'persistStep failed (continuing)')
          }
        },
        onFinish: async (event) => {
          finalAssistantText = event.text
          runCompletionPromise = finishRun({
            deps,
            cfg,
            runId,
            agentId: agent.id,
            channel: opts.channel,
            threadId: opts.threadId,
            userMessage: opts.intent,
            assistantMessage: event.text,
            log,
          })
          // Don't await — let onFinish return promptly so AI SDK closes the
          // stream. The done promise (returned to caller) awaits this work.
        },
        onError: ({ error }) => {
          log.error({ err: error, runId }, 'stream error')
        },
      })

      // 8. Cancel handling: if the caller aborts before onFinish fires,
      //    mark the run cancelled. Idempotent — finishRun checks status first.
      const onAbort = () => {
        runCompletionPromise = closeRun(deps.db.db, runId, {
          status: 'cancelled',
          summary: finalAssistantText || null,
        }).catch((err) => log.error({ err, runId }, 'cancel persist failed'))
      }
      opts.abortSignal?.addEventListener('abort', onAbort, { once: true })

      // 9. Compose `done` — settles after persistence + post-hooks complete.
      //    Always resolves; persistence errors are logged.
      const done = (async () => {
        try {
          // Wait for the SDK's internal text promise to settle.
          await Promise.resolve(result.text).catch(() => undefined)
          await runCompletionPromise
        } catch (err) {
          log.error({ err, runId }, 'done settled with error (logged, not thrown)')
        } finally {
          opts.abortSignal?.removeEventListener('abort', onAbort)
        }
      })()

      return { runId, fullStream: result.fullStream, done }
    },
  }
}

// ---------- helpers ----------

async function persistStep(
  db: DbHandle,
  runId: string,
  stepIndex: number,
  event: OnStepFinishEvent<ToolSet>,
): Promise<void> {
  // The KeeperHub middleware is the single writer of `tool_calls` rows (with
  // audit metadata). `persistStep` writes the step row + backfills `step_id`
  // on audit rows already inserted by the middleware (it fires at tool
  // execute time, before this step row exists, so it writes step_id = null).
  // The `tool_calls` jsonb summary on the step keeps step-level reasoning
  // even when middleware is absent.
  const stepRow = await appendStep(db.db, {
    runId,
    stepIndex,
    role: 'assistant',
    content: event.text || null,
    toolCalls: event.toolCalls.length > 0 ? event.toolCalls.map(toolCallShape) : null,
    finishReason: event.finishReason,
  })

  if (event.toolCalls.length > 0) {
    await updateToolCallStepIds(
      db.db,
      runId,
      event.toolCalls.map((c) => c.toolCallId),
      stepRow.id,
    )
  }
}

function toolCallShape(call: { toolCallId: string; toolName: string; input: unknown }) {
  return { toolCallId: call.toolCallId, toolName: call.toolName, input: call.input }
}

type FinishRunInput = {
  deps: RuntimeDeps
  cfg: Required<RuntimeConfig>
  runId: string
  agentId: string
  channel: string
  threadId: string
  userMessage: string
  assistantMessage: string
  log: Logger
}

async function finishRun(input: FinishRunInput): Promise<void> {
  const { deps, cfg, runId, agentId, channel, threadId, userMessage, assistantMessage, log } = input

  // 1. Close the run row with the final assistant text as summary.
  try {
    await closeRun(deps.db.db, runId, {
      status: 'completed',
      summary: assistantMessage || null,
    })
  } catch (err) {
    log.error({ err, runId }, 'closeRun failed')
  }

  // 2. Embed assistant message + write to message_embeddings (cold-recall food).
  if (assistantMessage.trim().length > 0) {
    try {
      const embedding = await deps.embeddings.embed(assistantMessage)
      await insertMessageEmbedding(deps.db.db, {
        threadId,
        runId,
        role: 'assistant',
        content: assistantMessage,
        embedding,
      })
    } catch (err) {
      log.error({ err, runId }, 'assistant embedding failed')
    }
  }

  // 3. Async post-hooks — fact pipeline + warm-tier re-summarization. Run in
  //    parallel; either failing doesn't block the other.
  await Promise.allSettled([
    runFactPipeline(deps, { runId, agentId, channel, threadId, userMessage, assistantMessage }),
    runSummarizerIfDue(deps, cfg, { runId, threadId, log }),
  ])
}

async function runFactPipeline(
  deps: RuntimeDeps,
  input: {
    runId: string
    agentId: string
    channel: string
    threadId: string
    userMessage: string
    assistantMessage: string
  },
): Promise<void> {
  if (!deps.factPipeline) return
  try {
    await deps.factPipeline.processRun(input)
  } catch (err) {
    logger.error({ err, runId: input.runId }, 'factPipeline.processRun failed')
  }
}

async function runSummarizerIfDue(
  deps: RuntimeDeps,
  cfg: Required<RuntimeConfig>,
  input: { runId: string; threadId: string; log: Logger },
): Promise<void> {
  if (!deps.summarizer) return
  let count: number
  try {
    count = await runCount(deps.db.db, input.threadId)
  } catch (err) {
    input.log.error({ err }, 'runCount failed')
    return
  }
  if (count <= 0 || count % cfg.summarizeEveryNRuns !== 0) return

  try {
    const result = await deps.summarizer.summarize({
      threadId: input.threadId,
      runRangeStart: null,
      runRangeEnd: input.runId,
    })
    if (!result) return
    await writeThreadSummary(deps.db.db, {
      threadId: input.threadId,
      runRangeStart: null,
      runRangeEnd: input.runId,
      summary: result.summary,
      embedding: result.embedding,
      tokenCount: result.tokenCount ?? null,
    })
  } catch (err) {
    input.log.error({ err }, 'summarizer failed')
  }
}
