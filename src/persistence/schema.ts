import { sql } from 'drizzle-orm'
import {
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

export const runStatus = pgEnum('run_status', ['running', 'completed', 'failed', 'cancelled'])

export const stepRole = pgEnum('step_role', ['assistant', 'tool'])

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
    tsv: text('tsv'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('message_embeddings_thread_idx').on(t.threadId),
    index('message_embeddings_hnsw_idx').using('hnsw', sql`${t.embedding} vector_cosine_ops`),
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
