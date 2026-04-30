-- The previous schema declared `tsv` as plain `text` with a TODO. Replace it
-- with a Postgres-managed STORED generated column of type `tsvector`, backed
-- by a GIN index for the lexical half of hybrid retrieval.
--
-- drizzle-kit 0.31 emits a broken first ALTER for customType migrations
-- (`"undefined"."tsvector"`). The drop-then-add pair below replaces the
-- column outright, which is what we want — generated columns can't be
-- altered in place anyway.

ALTER TABLE "message_embeddings" drop column "tsv";--> statement-breakpoint
ALTER TABLE "message_embeddings" ADD COLUMN "tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;--> statement-breakpoint
CREATE INDEX "message_embeddings_tsv_gin_idx" ON "message_embeddings" USING gin ("tsv");
