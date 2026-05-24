-- Make biological baseline fields nullable so null = "not yet asked"
-- Previously false/0 was indistinguishable from "answered: no"
ALTER TABLE "IntendedParentProfile" 
  ALTER COLUMN "hasEmbryos" DROP NOT NULL,
  ALTER COLUMN "hasEmbryos" DROP DEFAULT,
  ALTER COLUMN "embryoCount" DROP NOT NULL,
  ALTER COLUMN "embryoCount" DROP DEFAULT,
  ALTER COLUMN "embryosTested" DROP NOT NULL,
  ALTER COLUMN "embryosTested" DROP DEFAULT,
  ALTER COLUMN "needsSurrogate" DROP NOT NULL,
  ALTER COLUMN "needsSurrogate" DROP DEFAULT,
  ALTER COLUMN "needsEggDonor" DROP NOT NULL,
  ALTER COLUMN "needsEggDonor" DROP DEFAULT,
  ALTER COLUMN "needsClinic" DROP NOT NULL,
  ALTER COLUMN "needsClinic" DROP DEFAULT;
