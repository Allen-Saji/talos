import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  vector,
} from 'drizzle-orm/pg-core'

/**
 * Postgres `tsvector` column type. drizzle 0.45 has no built-in for it; the
 * raw type is needed because `to_tsvector(...)` returns `tsvector` and
 * Postgres rejects the cast to `text` on a generated column.
 */
const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
})

export const runStatus = pgEnum('run_status', ['running', 'completed', 'failed', 'cancelled'])

export const stepRole = pgEnum('step_role', ['assistant', 'tool'])

export const factEvent = pgEnum('fact_event', ['ADD', 'UPDATE', 'DELETE'])

export const threads = pgTable(
  'threads',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull().default('default'),
    channel: text('channel').notNull(),
    title: text('title'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('threads_channel_idx').on(t.channel)],
)

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    status: runStatus('status').notNull().default('running'),
    prompt: text('prompt').notNull(),
    summary: text('summary'),
    metadata: jsonb('metadata'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('runs_thread_idx').on(t.threadId), index('runs_status_idx').on(t.status)],
)

export const steps = pgTable(
  'steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    stepIndex: integer('step_index').notNull(),
    role: stepRole('role').notNull(),
    content: text('content'),
    toolCalls: jsonb('tool_calls'),
    finishReason: text('finish_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('steps_run_idx').on(t.runId)],
)

export const toolCalls = pgTable(
  'tool_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    stepId: uuid('step_id').references(() => steps.id, { onDelete: 'cascade' }),
    toolCallId: text('tool_call_id').notNull(),
    toolName: text('tool_name').notNull(),
    args: jsonb('args'),
    result: jsonb('result'),
    error: text('error'),
    audit: jsonb('audit'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('tool_calls_run_idx').on(t.runId), index('tool_calls_name_idx').on(t.toolName)],
)

export const messageEmbeddings = pgTable(
  'message_embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content').notNull(),
    embedding: vector('embedding', { dimensions: 1536 }).notNull(),
    /**
     * Postgres maintains this column via `GENERATED ALWAYS AS (...) STORED`.
     * Backed by the GIN index below — used for the lexical half of hybrid
     * retrieval (`searchMessages` does `tsv @@ plainto_tsquery(...)`).
     */
    tsv: tsvector('tsv').generatedAlwaysAs(sql`to_tsvector('english', content)`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('message_embeddings_thread_idx').on(t.threadId),
    index('message_embeddings_hnsw_idx').using('hnsw', sql`${t.embedding} vector_cosine_ops`),
    index('message_embeddings_tsv_gin_idx').using('gin', t.tsv),
  ],
)

export const threadSummaries = pgTable(
  'thread_summaries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    runRangeStart: uuid('run_range_start').references(() => runs.id, { onDelete: 'set null' }),
    runRangeEnd: uuid('run_range_end').references(() => runs.id, { onDelete: 'set null' }),
    summary: text('summary').notNull(),
    embedding: vector('embedding', { dimensions: 1536 }).notNull(),
    tokenCount: integer('token_count'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('thread_summaries_thread_idx').on(t.threadId),
    index('thread_summaries_hnsw_idx').using('hnsw', sql`${t.embedding} vector_cosine_ops`),
  ],
)

export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source').notNull(),
    sourceId: text('source_id'),
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    embedding: vector('embedding', { dimensions: 1536 }).notNull(),
    metadata: jsonb('metadata'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('knowledge_chunks_source_idx').on(t.source),
    index('knowledge_chunks_hnsw_idx').using('hnsw', sql`${t.embedding} vector_cosine_ops`),
  ],
)

export const facts = pgTable(
  'facts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: text('agent_id').notNull(),
    channel: text('channel').notNull(),
    threadId: text('thread_id'),
    text: text('text').notNull(),
    embedding: vector('embedding', { dimensions: 1536 }).notNull(),
    hash: text('hash').notNull(),
    attributedToRunId: uuid('attributed_to_run_id').references(() => runs.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    supersededBy: uuid('superseded_by').references((): AnyPgColumn => facts.id, {
      onDelete: 'set null',
    }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('facts_scope_idx').on(t.agentId, t.channel, t.threadId),
    index('facts_live_hash_idx')
      .on(t.agentId, t.channel, t.hash)
      .where(sql`deleted_at IS NULL AND superseded_by IS NULL`),
    index('facts_hnsw_idx').using('hnsw', sql`${t.embedding} vector_cosine_ops`),
  ],
)

export const factHistory = pgTable(
  'fact_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    factId: uuid('fact_id')
      .notNull()
      .references(() => facts.id, { onDelete: 'cascade' }),
    event: factEvent('event').notNull(),
    oldText: text('old_text'),
    newText: text('new_text'),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('fact_history_fact_idx').on(t.factId), index('fact_history_run_idx').on(t.runId)],
)

export type Thread = typeof threads.$inferSelect
export type NewThread = typeof threads.$inferInsert
export type Run = typeof runs.$inferSelect
export type NewRun = typeof runs.$inferInsert
export type Step = typeof steps.$inferSelect
export type NewStep = typeof steps.$inferInsert
export type ToolCall = typeof toolCalls.$inferSelect
export type NewToolCall = typeof toolCalls.$inferInsert
export type MessageEmbedding = typeof messageEmbeddings.$inferSelect
export type NewMessageEmbedding = typeof messageEmbeddings.$inferInsert
export type KnowledgeChunk = typeof knowledgeChunks.$inferSelect
export type NewKnowledgeChunk = typeof knowledgeChunks.$inferInsert
export type ThreadSummary = typeof threadSummaries.$inferSelect
export type NewThreadSummary = typeof threadSummaries.$inferInsert
export type Fact = typeof facts.$inferSelect
export type NewFact = typeof facts.$inferInsert
export type FactHistoryRow = typeof factHistory.$inferSelect
export type NewFactHistoryRow = typeof factHistory.$inferInsert
