CREATE TABLE "thread_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" text NOT NULL,
	"run_range_start" uuid,
	"run_range_end" uuid,
	"summary" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"token_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "thread_summaries" ADD CONSTRAINT "thread_summaries_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_summaries" ADD CONSTRAINT "thread_summaries_run_range_start_runs_id_fk" FOREIGN KEY ("run_range_start") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_summaries" ADD CONSTRAINT "thread_summaries_run_range_end_runs_id_fk" FOREIGN KEY ("run_range_end") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "thread_summaries_thread_idx" ON "thread_summaries" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "thread_summaries_hnsw_idx" ON "thread_summaries" USING hnsw ("embedding" vector_cosine_ops);