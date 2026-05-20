import type { LanguageModel, TextStreamPart, Tool, ToolSet } from 'ai'

// ---------- agent ----------

export type Agent = {
  /** Unique agent id (e.g. 'talos-eth') */
  id: string
  /** Human-readable persona, prepended to the system prompt */
  persona: string
  /** Model id understood by the ProviderRouter (e.g. 'openai/gpt-4o-mini') */
  modelId: string
}

// ---------- provider router ----------

export interface ProviderRouter {
  /** Resolve a model id to an AI SDK v6 LanguageModel */
  resolve(modelId: string): LanguageModel
}

// ---------- embeddings ----------

export interface EmbeddingsService {
  embed(text: string): Promise<number[]>
  embedMany(texts: string[]): Promise<number[][]>
}

// ---------- tools ----------

export interface ToolSource {
  /** Returns a record of named tools to mount on the model call. */
  getTools(): Promise<Record<string, Tool>>
}

// ---------- knowledge layer (from #11) ----------

export type KnowledgeChunkHit = {
  source: string
  content: string
  score?: number
}

export interface KnowledgeRetriever {
  retrieve(query: string, opts?: { topK?: number }): Promise<KnowledgeChunkHit[]>
}

// ---------- summarizer (warm tier, every 20 runs) ----------

export interface ThreadSummarizer {
  /**
   * Generate a fresh summary for the thread up to a given run, returning
   * { summary, embedding }. Implementations call an LLM + embedding model.
   * Persistence (writeThreadSummary) is handled by the runtime; the summarizer
   * only produces the content.
   */
  summarize(input: {
    threadId: string
    runRangeStart: string | null
    runRangeEnd: string
  }): Promise<{ summary: string; embedding: number[]; tokenCount?: number } | null>
}

// ---------- fact pipeline (Mem0, from #17) ----------

export interface FactPipeline {
  /**
   * Process a freshly-completed turn. Implementations call extract + reconcile
   * + applyFactOps internally. Returns nothing — fire-and-forget from runtime.
   */
  processRun(input: {
    threadId: string
    agentId: string
    channel: string
    runId: string
    userMessage: string
    assistantMessage: string
  }): Promise<void>
}

// ---------- run options + handle ----------

export type RunOptions = {
  threadId: string
  channel: string
  intent: string
  agentId?: string
  abortSignal?: AbortSignal
}

export type RunHandle = {
  runId: string
  /** AI SDK v6 typed event stream — caller iterates this for display */
  fullStream: AsyncIterable<TextStreamPart<ToolSet>>
  /**
   * Resolves after onFinish + post-run hooks (assistant embedding, fact
   * pipeline, summarizer if triggered) complete. Always resolves; persistence
   * errors are logged, not thrown — channel UX must not crash on storage.
   */
  done: Promise<void>
}

export interface AgentRuntime {
  run(opts: RunOptions): Promise<RunHandle>
}

// ---------- runtime config ----------

export type RuntimeConfig = {
  /** Hot-tier message budget; default 20 */
  recentMessages?: number
  /** stopWhen: stepCountIs(maxSteps); default 8 */
  maxSteps?: number
  /** Cross-thread cold recall threshold; default 0.78 */
  coldRecallThreshold?: number
  /** Cross-thread cold recall topK; default 3 */
  coldRecallTopK?: number
  /** Knowledge retrieval topK; default 5 */
  knowledgeTopK?: number
  /** Re-summarize the thread every N runs; default 20 */
  summarizeEveryNRuns?: number
}
