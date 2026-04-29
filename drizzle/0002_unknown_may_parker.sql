CREATE TYPE "public"."fact_event" AS ENUM('ADD', 'UPDATE', 'DELETE');--> statement-breakpoint
CREATE TABLE "fact_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fact_id" uuid NOT NULL,
	"event" "fact_event" NOT NULL,
	"old_text" text,
	"new_text" text,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"channel" text NOT NULL,
	"thread_id" text,
	"text" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"hash" text NOT NULL,
	"attributed_to_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_by" uuid,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "fact_history" ADD CONSTRAINT "fact_history_fact_id_facts_id_fk" FOREIGN KEY ("fact_id") REFERENCES "public"."facts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_history" ADD CONSTRAINT "fact_history_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_attributed_to_run_id_runs_id_fk" FOREIGN KEY ("attributed_to_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_superseded_by_facts_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."facts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fact_history_fact_idx" ON "fact_history" USING btree ("fact_id");--> statement-breakpoint
CREATE INDEX "fact_history_run_idx" ON "fact_history" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "facts_scope_idx" ON "facts" USING btree ("agent_id","channel","thread_id");--> statement-breakpoint
CREATE INDEX "facts_live_hash_idx" ON "facts" USING btree ("agent_id","channel","hash") WHERE deleted_at IS NULL AND superseded_by IS NULL;--> statement-breakpoint
CREATE INDEX "facts_hnsw_idx" ON "facts" USING hnsw ("embedding" vector_cosine_ops);