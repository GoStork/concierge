-- Speed up MCP search_clinics and friends. The hot path joins:
--   Provider -> ProviderService (filter providerTypeId + status)
--   Provider -> ProviderLocation (filter state/city)
--   Provider -> IvfSuccessRate
-- Without these indexes the joins were full sequential scans on tables that
-- contain thousands of rows, causing search_clinics to take 30-60+ seconds
-- under parallel load and hit the MCP 60s timeout.

-- ProviderLocation has NO indexes at all, not even on providerId.
-- providerId is the most common join key.
CREATE INDEX IF NOT EXISTS "ProviderLocation_providerId_idx"
  ON "ProviderLocation" ("providerId");

-- Indexes on lower(state) and lower(city) - speeds up the "contains" filter
-- that resolveLocationTerms() generates for "California"/"Los Angeles" queries.
-- (For full prefix/substring search across long lists we'd need pg_trgm GIN;
-- a btree on lower() at least helps exact + prefix matches.)
CREATE INDEX IF NOT EXISTS "ProviderLocation_state_lower_idx"
  ON "ProviderLocation" (LOWER("state"));
CREATE INDEX IF NOT EXISTS "ProviderLocation_city_lower_idx"
  ON "ProviderLocation" (LOWER("city"));

-- ProviderService only has unique(providerId, providerTypeId). The hot query
-- filters by providerTypeId AND status='APPROVED'. Add a composite that
-- matches the predicate.
CREATE INDEX IF NOT EXISTS "ProviderService_providerTypeId_status_idx"
  ON "ProviderService" ("providerTypeId", "status");

-- IvfSuccessRate has @@index([providerId, year]) which is good for join-by-providerId.
-- But the search filters by metricCode + ageGroup; if the table grows, a
-- composite (providerId, metricCode) helps. Low-priority but cheap.
CREATE INDEX IF NOT EXISTS "IvfSuccessRate_providerId_metricCode_idx"
  ON "IvfSuccessRate" ("providerId", "metricCode");
