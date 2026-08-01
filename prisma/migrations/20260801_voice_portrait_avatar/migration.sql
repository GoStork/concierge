-- Mobile (portrait) avatar variant per persona
ALTER TABLE "Matchmaker" ADD COLUMN IF NOT EXISTS "avatarFaceIdPortrait" TEXT;
