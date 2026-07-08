CREATE TABLE IF NOT EXISTS "ConciergeAsset" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "objectPath" TEXT NOT NULL,
  "contentType" TEXT NOT NULL DEFAULT 'application/pdf',
  "uploadedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConciergeAsset_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ConciergeAsset_key_key" ON "ConciergeAsset"("key");
