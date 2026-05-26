-- Migration: invoice line items + agency tax ID / legal name for receipts
--
-- 1. New InvoiceLineItem table - lets an agency bill multiple services on a
--    single invoice (e.g. "Surrogacy deposit" + "Legal coordination" +
--    "Genetic counseling"). The parent sees the full breakdown in the chat
--    card, the payment page, the request email, and the receipt PDF.
--
-- 2. Tax ID + legal name on ProviderBrandSettings - shown in the receipt
--    PDF footer so parents can forward the document to their employer
--    (FSA/HSA) or insurance carrier with the issuer info insurers expect.
--
-- Idempotent: rerunning is a no-op.

CREATE TABLE IF NOT EXISTS "InvoiceLineItem" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "serviceType" TEXT NOT NULL,
    "description" TEXT,
    "amountCents" INTEGER NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceLineItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "InvoiceLineItem_invoiceId_idx" ON "InvoiceLineItem"("invoiceId");

-- FK with ON DELETE CASCADE so deleting an invoice cleans up its line items.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'InvoiceLineItem_invoiceId_fkey'
    ) THEN
        ALTER TABLE "InvoiceLineItem"
            ADD CONSTRAINT "InvoiceLineItem_invoiceId_fkey"
            FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE;
    END IF;
END
$$;

-- ProviderBrandSettings: agency-specific billing identity for receipts.
ALTER TABLE "ProviderBrandSettings" ADD COLUMN IF NOT EXISTS "legalName" TEXT;
ALTER TABLE "ProviderBrandSettings" ADD COLUMN IF NOT EXISTS "taxId" TEXT;
