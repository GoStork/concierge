-- Migrate all embedding columns from text-embedding-3-small (1536 dims) to Gemini text-embedding-004 (768 dims)
-- Drop existing pgvector indexes first, then alter column types, then recreate indexes

-- Provider
DROP INDEX IF EXISTS "Provider_profileEmbedding_idx";
ALTER TABLE "Provider" ALTER COLUMN "profileEmbedding" TYPE vector(768) USING NULL;

-- EggDonor
DROP INDEX IF EXISTS "EggDonor_profileEmbedding_idx";
ALTER TABLE "EggDonor" ALTER COLUMN "profileEmbedding" TYPE vector(768) USING NULL;

-- Surrogate
DROP INDEX IF EXISTS "Surrogate_profileEmbedding_idx";
ALTER TABLE "Surrogate" ALTER COLUMN "profileEmbedding" TYPE vector(768) USING NULL;

-- SpermDonor
DROP INDEX IF EXISTS "SpermDonor_profileEmbedding_idx";
ALTER TABLE "SpermDonor" ALTER COLUMN "profileEmbedding" TYPE vector(768) USING NULL;

-- KnowledgeChunk
DROP INDEX IF EXISTS "KnowledgeChunk_embedding_idx";
ALTER TABLE "KnowledgeChunk" ALTER COLUMN "embedding" TYPE vector(768) USING NULL;

-- Recreate HNSW indexes for the new dimension
CREATE INDEX IF NOT EXISTS "Provider_profileEmbedding_idx" ON "Provider" USING hnsw ("profileEmbedding" vector_cosine_ops);
CREATE INDEX IF NOT EXISTS "EggDonor_profileEmbedding_idx" ON "EggDonor" USING hnsw ("profileEmbedding" vector_cosine_ops);
CREATE INDEX IF NOT EXISTS "Surrogate_profileEmbedding_idx" ON "Surrogate" USING hnsw ("profileEmbedding" vector_cosine_ops);
CREATE INDEX IF NOT EXISTS "SpermDonor_profileEmbedding_idx" ON "SpermDonor" USING hnsw ("profileEmbedding" vector_cosine_ops);
CREATE INDEX IF NOT EXISTS "KnowledgeChunk_embedding_idx" ON "KnowledgeChunk" USING hnsw ("embedding" vector_cosine_ops);
