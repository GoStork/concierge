-- Invoice.serviceType stored a DISPLAY LABEL ("Egg Donation") while
-- Agreement.serviceType and ProviderQuote.serviceType store the enum
-- ("EGG_DONATION"). Three models, one concept, two vocabularies - an
-- enum-keyed lookup applied to the label silently missed, which is how a
-- parent's match status came out wrong on the monitor.
--
-- Normalized onto the enum. Every render point humanizes at the boundary.
UPDATE "Invoice" SET "serviceType" = CASE
    WHEN lower("serviceType") LIKE '%egg%'     THEN 'EGG_DONATION'
    WHEN lower("serviceType") LIKE '%surrog%'  THEN 'SURROGACY'
    WHEN lower("serviceType") LIKE '%sperm%'   THEN 'SPERM_DONATION'
    WHEN lower("serviceType") LIKE '%ivf%'
      OR lower("serviceType") LIKE '%clinic%'  THEN 'IVF_CLINIC'
    WHEN lower("serviceType") LIKE '%legal%'   THEN 'LEGAL_SERVICES'
    ELSE 'OTHER'
  END
WHERE "serviceType" IS NOT NULL AND "serviceType" <> upper("serviceType");
