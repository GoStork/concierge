export const CDC_QUESTION_IDS = [
  'Q011', 'Q012', 'Q013', 'Q014',
  'Q015', 'Q016', 'Q017', 'Q018',
  'Q019', 'Q020', 'Q021', 'Q022',
  'Q023', 'Q024',
  'Q025', 'Q026', 'Q027',
  'Q028', 'Q029',
  'Q030', 'Q031', 'Q032', 'Q033',
];

const QUESTION_ID_SQL_LIST = CDC_QUESTION_IDS.map((q) => `'${q}'`).join(', ');

const AVG_QUESTION_IDS = ['Q023', 'Q024', 'Q028', 'Q029'];
const AVG_SQL_LIST = AVG_QUESTION_IDS.map((q) => `'${q}'`).join(', ');

const METRIC_CODE_CASE = `CASE
    WHEN (r."rawData"->>'questionid') = 'Q011' THEN 'pct_intended_retrievals_live_births'
    WHEN (r."rawData"->>'questionid') = 'Q012' THEN 'pct_intended_retrievals_singleton_live_births'
    WHEN (r."rawData"->>'questionid') = 'Q013' THEN 'pct_intended_retrievals_stnw_live_births'
    WHEN (r."rawData"->>'questionid') = 'Q014' THEN 'pct_intended_retrievals_multiple_live_births'
    WHEN (r."rawData"->>'questionid') = 'Q015' THEN 'pct_actual_retrievals_live_births'
    WHEN (r."rawData"->>'questionid') = 'Q016' THEN 'pct_actual_retrievals_singleton_live_births'
    WHEN (r."rawData"->>'questionid') = 'Q017' THEN 'pct_actual_retrievals_stnw_live_births'
    WHEN (r."rawData"->>'questionid') = 'Q018' THEN 'pct_actual_retrievals_multiple_live_births'
    WHEN (r."rawData"->>'questionid') = 'Q019' THEN 'pct_transfers_live_births'
    WHEN (r."rawData"->>'questionid') = 'Q020' THEN 'pct_transfers_singleton_live_births'
    WHEN (r."rawData"->>'questionid') = 'Q021' THEN 'pct_transfers_stnw_live_births'
    WHEN (r."rawData"->>'questionid') = 'Q022' THEN 'pct_transfers_multiple_live_births'
    WHEN (r."rawData"->>'questionid') = 'Q023' THEN 'avg_transfers_per_intended_retrieval'
    WHEN (r."rawData"->>'questionid') = 'Q024' THEN 'avg_intended_retrievals_per_live_birth'
    WHEN (r."rawData"->>'questionid') = 'Q025' THEN 'pct_new_patients_live_birth_after_1_retrieval'
    WHEN (r."rawData"->>'questionid') = 'Q026' THEN 'pct_new_patients_live_birth_after_1_or_2_retrievals'
    WHEN (r."rawData"->>'questionid') = 'Q027' THEN 'pct_new_patients_live_birth_after_all_retrievals'
    WHEN (r."rawData"->>'questionid') = 'Q028' THEN 'avg_intended_retrievals_per_new_patient'
    WHEN (r."rawData"->>'questionid') = 'Q029' THEN 'avg_transfers_per_intended_retrieval_new'
    WHEN (r."rawData"->>'questionid') = 'Q030' THEN 'pct_transfers_live_births_donor'
    WHEN (r."rawData"->>'questionid') = 'Q031' THEN 'pct_transfers_singleton_live_births_donor'
    WHEN (r."rawData"->>'questionid') = 'Q032' THEN 'pct_transfers_stnw_live_births_donor'
    WHEN (r."rawData"->>'questionid') = 'Q033' THEN 'pct_transfers_multiple_live_births_donor'
    ELSE NULL
  END`;

const AGE_GROUP_CASE = `CASE
    WHEN (r."rawData"->>'breakout') = '<35' THEN 'under_35'
    WHEN (r."rawData"->>'breakout') = '35-37' THEN '35_37'
    WHEN (r."rawData"->>'breakout') = '38-40' THEN '38_40'
    WHEN (r."rawData"->>'breakout') = '>40' THEN 'over_40'
    ELSE NULL
  END`;

const SUBMETRIC_CASE = `CASE
    WHEN (r."rawData"->>'breakout') = 'Fresh Embryos Fresh Eggs' THEN 'fresh_embryos_fresh_eggs'
    WHEN (r."rawData"->>'breakout') = 'Fresh Embryos Frozen Eggs' THEN 'fresh_embryos_frozen_eggs'
    WHEN (r."rawData"->>'breakout') = 'Frozen Embryos' THEN 'frozen_embryos'
    WHEN (r."rawData"->>'breakout') = 'Donated Embryos' THEN 'donated_embryos'
    ELSE NULL
  END`;

export function buildEnrichmentSqlStatements(year: number): string[] {
  const safeYear = Math.floor(Number(year));
  if (!safeYear || safeYear < 2000 || safeYear > 2100) {
    throw new Error(`Invalid year for enrichment: ${year}`);
  }

  return [
    `DROP TABLE IF EXISTS _cdc_national`,
    `DROP TABLE IF EXISTS _cdc_parsed`,

    `CREATE TEMP TABLE _cdc_parsed AS
SELECT
  r."id" AS raw_id,
  r."year",
  r."facilityName",
  (r."rawData"->>'clinicid') AS clinic_id,
  (r."rawData"->>'facilityname') AS facility_name,
  (r."rawData"->>'address') AS address,
  (r."rawData"->>'city') AS city,
  (r."rawData"->>'locationabbr') AS state,
  (r."rawData"->>'zipcode') AS zip,
  (r."rawData"->>'questionid') AS question_id,
  (r."rawData"->>'type') AS record_type,
  (r."rawData"->>'breakout') AS breakout,
  (r."rawData"->>'breakout_category') AS breakout_category,
  CASE
    WHEN (r."rawData"->>'data_value_num') IS NOT NULL
      AND (r."rawData"->>'data_value_num') ~ '^-?[0-9]+(\\.[0-9]+)?$'
    THEN
      CASE
        WHEN (r."rawData"->>'questionid') IN (${AVG_SQL_LIST})
        THEN (r."rawData"->>'data_value_num')::numeric
        ELSE (r."rawData"->>'data_value_num')::numeric / 100.0
      END
    ELSE NULL
  END AS success_rate,
  CASE
    WHEN (r."rawData"->>'cycle_count') IS NOT NULL
      AND (r."rawData"->>'cycle_count') ~ '^[0-9]+(\\.[0-9]+)?$'
    THEN FLOOR((r."rawData"->>'cycle_count')::numeric)::int
    ELSE 0
  END AS cycle_count,
  ${METRIC_CODE_CASE} AS metric_code,
  CASE
    WHEN (r."rawData"->>'type') LIKE '%own eggs%' THEN 'own_eggs'
    WHEN (r."rawData"->>'type') LIKE '%donor%' THEN 'donor'
    ELSE NULL
  END AS profile_type,
  CASE
    WHEN (r."rawData"->>'questionid') IN ('Q025', 'Q026', 'Q027', 'Q028', 'Q029') THEN true
    ELSE false
  END AS is_new_patient,
  ${AGE_GROUP_CASE} AS age_group,
  ${SUBMETRIC_CASE} AS submetric
FROM "RawCdcData" r
WHERE r."year" = ${safeYear}
  AND (r."rawData"->>'questionid') IN (${QUESTION_ID_SQL_LIST})
  AND (r."rawData"->>'filterid') = 'F009'
  AND (r."rawData"->>'data_value_num') IS NOT NULL
  AND (r."rawData"->>'data_value_num') ~ '^-?[0-9]+(\\.[0-9]+)?$'
  AND LOWER(r."facilityName") != 'national'`,

    `CREATE TEMP TABLE _cdc_national AS
SELECT
  ${METRIC_CODE_CASE} AS metric_code,
  ${AGE_GROUP_CASE} AS age_group,
  ${SUBMETRIC_CASE} AS submetric,
  CASE
    WHEN (r."rawData"->>'questionid') IN ('Q025', 'Q026', 'Q027', 'Q028', 'Q029') THEN true
    ELSE false
  END AS is_new_patient,
  CASE
    WHEN (r."rawData"->>'questionid') IN (${AVG_SQL_LIST})
    THEN (r."rawData"->>'data_value_num')::numeric
    ELSE (r."rawData"->>'data_value_num')::numeric / 100.0
  END AS national_avg
FROM "RawCdcData" r
WHERE r."year" = ${safeYear}
  AND (r."rawData"->>'questionid') IN (${QUESTION_ID_SQL_LIST})
  AND (r."rawData"->>'filterid') = 'F009'
  AND (r."rawData"->>'data_value_num') IS NOT NULL
  AND (r."rawData"->>'data_value_num') ~ '^-?[0-9]+(\\.[0-9]+)?$'
  AND LOWER(r."facilityName") = 'national'`,

    `INSERT INTO "Provider" ("id", "name", "createdAt", "updatedAt")
SELECT DISTINCT ON (p.facility_name)
  gen_random_uuid()::text,
  p.facility_name,
  NOW(),
  NOW()
FROM _cdc_parsed p
WHERE p.facility_name IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "Provider" prov WHERE LOWER(prov."name") = LOWER(p.facility_name)
  )
ORDER BY p.facility_name, p.raw_id`,

    `INSERT INTO "ProviderService" ("id", "providerId", "providerTypeId", "status")
SELECT
  gen_random_uuid()::text,
  prov."id",
  pt."id",
  'NEW'
FROM "Provider" prov
CROSS JOIN "ProviderType" pt
WHERE pt."name" = 'IVF Clinic'
  AND EXISTS (
    SELECT 1 FROM _cdc_parsed p WHERE LOWER(p.facility_name) = LOWER(prov."name")
  )
  AND NOT EXISTS (
    SELECT 1 FROM "ProviderService" ps
    WHERE ps."providerId" = prov."id" AND ps."providerTypeId" = pt."id"
  )`,

    `INSERT INTO "ProviderLocation" ("id", "providerId", "address", "city", "state", "zip")
SELECT DISTINCT ON (prov."id")
  gen_random_uuid()::text,
  prov."id",
  p.address,
  p.city,
  p.state,
  p.zip
FROM _cdc_parsed p
JOIN "Provider" prov ON LOWER(prov."name") = LOWER(p.facility_name)
WHERE NOT EXISTS (
  SELECT 1 FROM "ProviderLocation" pl WHERE pl."providerId" = prov."id"
)
ORDER BY prov."id", p.raw_id`,

    `UPDATE "Provider" SET "cdcClinicId" = sub.clinic_id
FROM (
  SELECT DISTINCT ON (facility_name) facility_name, clinic_id
  FROM _cdc_parsed
  WHERE clinic_id IS NOT NULL
  ORDER BY facility_name, raw_id
) sub
WHERE LOWER("Provider"."name") = LOWER(sub.facility_name)`,

    `DELETE FROM "IvfSuccessRate"
WHERE "providerId" IN (
  SELECT DISTINCT prov."id"
  FROM _cdc_parsed p
  JOIN "Provider" prov ON LOWER(prov."name") = LOWER(p.facility_name)
)
AND "year" = ${safeYear}`,

    `INSERT INTO "IvfSuccessRate" (
  "id", "providerId", "year", "profileType", "metricCode", "submetric",
  "ageGroup", "isNewPatient", "successRate", "cycleCount",
  "percentile", "top10pct", "nationalAverage"
)
SELECT
  gen_random_uuid()::text,
  enriched."providerId",
  ${safeYear},
  enriched.profile_type,
  enriched.metric_code,
  enriched.submetric,
  enriched.age_group,
  enriched.is_new_patient,
  enriched.success_rate,
  enriched.cycle_count,
  enriched.pct_rank,
  enriched.pct_rank >= 0.90,
  COALESCE(enriched.national_avg, enriched.computed_avg)
FROM (
  SELECT
    prov."id" AS "providerId",
    p.profile_type,
    p.metric_code,
    p.submetric,
    p.age_group,
    p.is_new_patient,
    p.success_rate,
    p.cycle_count,
    PERCENT_RANK() OVER (
      PARTITION BY p.metric_code, p.age_group, p.submetric, p.is_new_patient
      ORDER BY p.success_rate
    ) AS pct_rank,
    nat.national_avg,
    AVG(p.success_rate) OVER (
      PARTITION BY p.metric_code, p.age_group, p.submetric, p.is_new_patient
    ) AS computed_avg
  FROM _cdc_parsed p
  JOIN "Provider" prov ON LOWER(prov."name") = LOWER(p.facility_name)
  LEFT JOIN _cdc_national nat ON
    nat.metric_code = p.metric_code
    AND COALESCE(nat.age_group, '') = COALESCE(p.age_group, '')
    AND COALESCE(nat.submetric, '') = COALESCE(p.submetric, '')
    AND nat.is_new_patient = p.is_new_patient
  WHERE p.success_rate IS NOT NULL
    AND p.metric_code IS NOT NULL
    AND p.profile_type IS NOT NULL
) enriched`,

    `UPDATE "ProviderService" SET "status" = 'INACTIVE'
WHERE "id" IN (
  SELECT ps."id"
  FROM "ProviderService" ps
  JOIN "ProviderType" pt ON pt."id" = ps."providerTypeId"
  JOIN "Provider" prov ON prov."id" = ps."providerId"
  WHERE pt."name" = 'IVF Clinic'
    AND prov."cdcClinicId" IS NOT NULL
    AND ps."status" != 'INACTIVE'
    AND NOT EXISTS (
      SELECT 1 FROM _cdc_parsed p WHERE LOWER(p.facility_name) = LOWER(prov."name")
    )
)`,

    `DELETE FROM "RawCdcData" WHERE "year" = ${safeYear}`,

    `DROP TABLE IF EXISTS _cdc_national`,
    `DROP TABLE IF EXISTS _cdc_parsed`,
  ];
}
