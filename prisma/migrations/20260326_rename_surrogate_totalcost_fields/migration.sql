-- Rename totalCompensationMin/Max to totalCostMin/Max on Surrogate table
ALTER TABLE "Surrogate" RENAME COLUMN "totalCompensationMin" TO "totalCostMin";
ALTER TABLE "Surrogate" RENAME COLUMN "totalCompensationMax" TO "totalCostMax";
