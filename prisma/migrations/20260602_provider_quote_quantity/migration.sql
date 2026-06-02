-- ProviderQuote.quantity: number of priced units the total represents
-- (e.g. 2 sperm vials, 3 egg lots). Defaults to 1 for legacy rows and any
-- quote whose provider entered the total manually. FLAT referral fees
-- scale by this multiplier in computeFee() / createInvoice().
ALTER TABLE "ProviderQuote" ADD COLUMN IF NOT EXISTS "quantity" INTEGER NOT NULL DEFAULT 1;
