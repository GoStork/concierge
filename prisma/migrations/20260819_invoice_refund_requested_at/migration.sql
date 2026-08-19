-- "Refund Requested" journey branch: stamped when an admin issues a refund,
-- before the charge.refunded webhook stamps refundedAt.
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "refundRequestedAt" TIMESTAMP(3);
