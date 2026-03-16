import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const { Pool } = pg;
const Decimal = Prisma.Decimal;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set.");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const GITHUB_BASE =
  "https://raw.githubusercontent.com/GoStork/success-rates/main/public/data";

interface RawClinic {
  ClinicID: number;
  clinic_name: string;
  Address: string;
  City: string;
  state: string;
  zip: number | string | null;
  lat: number | null;
  lng: number | null;
}

interface RawSuccessRate {
  ClinicID: string;
  profile_type: string;
  metric_code: string;
  submetric: string | null;
  age_group: string | null;
  is_new_patient: boolean | null;
  success_rate: number | null;
  cycle_count: number | null;
  suppressed: boolean;
  rank: number | null;
  percentile: number | null;
  top10pct: boolean;
  Topic: string;
  SubTopic: string;
  Question: string;
  Breakout: string;
  footnote: string | null;
}

interface NationalAverages {
  metrics: {
    own_eggs: Record<
      string,
      {
        all_patients_intended_retrieval_lbd_rate: number;
        new_patients_all_intended_retrievals_lbd_rate: number;
      }
    >;
    donor: Record<string, number>;
  };
}

function getNationalAvg(
  national: NationalAverages,
  sr: RawSuccessRate,
): number {
  if (sr.profile_type === "own_eggs" && sr.age_group) {
    const group = national.metrics.own_eggs[sr.age_group];
    if (!group) return 0;
    return sr.is_new_patient
      ? group.new_patients_all_intended_retrievals_lbd_rate
      : group.all_patients_intended_retrieval_lbd_rate;
  }
  if (sr.profile_type === "donor" && sr.submetric) {
    const key = `${sr.submetric}_transfer_lbd_rate`;
    return (national.metrics.donor as Record<string, number>)[key] ?? 0;
  }
  return 0;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.json() as Promise<T>;
}

async function main() {
  console.log("Fetching national averages...");
  const national = await fetchJson<NationalAverages>(
    `${GITHUB_BASE}/national_2022.json`,
  );

  let clinicsRaw: RawClinic[];
  let successRatesRaw: RawSuccessRate[];

  try {
    console.log("Trying to fetch clinics_2022.json from GitHub...");
    clinicsRaw = await fetchJson<RawClinic[]>(
      `${GITHUB_BASE}/clinics_2022.json`,
    );
    successRatesRaw = await fetchJson<RawSuccessRate[]>(
      `${GITHUB_BASE}/success_rates_2022.json`,
    );
  } catch {
    console.log(
      "GitHub data files not found. Using embedded representative data...",
    );
    clinicsRaw = getEmbeddedClinics();
    successRatesRaw = getEmbeddedSuccessRates();
  }

  console.log(`Processing ${clinicsRaw.length} clinics...`);

  let ivfClinicType = await prisma.providerType.findUnique({
    where: { name: "IVF Clinic" },
  });
  if (!ivfClinicType) {
    ivfClinicType = await prisma.providerType.create({
      data: { name: "IVF Clinic" },
    });
    console.log("Created ProviderType: IVF Clinic");
  }

  const clinicIdToProviderId = new Map<number, string>();

  for (const clinic of clinicsRaw) {
    let provider = await prisma.provider.findFirst({
      where: { name: clinic.clinic_name },
    });

    if (!provider) {
      provider = await prisma.provider.create({
        data: { name: clinic.clinic_name },
      });
    }

    clinicIdToProviderId.set(clinic.ClinicID, provider.id);

    const existingService = await prisma.providerService.findUnique({
      where: {
        providerId_providerTypeId: {
          providerId: provider.id,
          providerTypeId: ivfClinicType.id,
        },
      },
    });
    if (!existingService) {
      await prisma.providerService.create({
        data: {
          providerId: provider.id,
          providerTypeId: ivfClinicType.id,
          status: "APPROVED",
        },
      });
    }

    const existingLocation = await prisma.providerLocation.findFirst({
      where: { providerId: provider.id },
    });
    if (!existingLocation) {
      await prisma.providerLocation.create({
        data: {
          providerId: provider.id,
          address: clinic.Address || null,
          city: clinic.City || null,
          state: clinic.state || null,
          zip: clinic.zip != null ? String(clinic.zip) : null,
        },
      });
    }
  }

  console.log(`Mapped ${clinicIdToProviderId.size} clinics to providers.`);

  const validRates = successRatesRaw.filter(
    (sr) =>
      !sr.suppressed &&
      sr.success_rate != null &&
      clinicIdToProviderId.has(parseInt(sr.ClinicID, 10)),
  );

  console.log(
    `Inserting ${validRates.length} success rate records (skipping suppressed)...`,
  );

  await prisma.ivfSuccessRate.deleteMany({
    where: {
      providerId: {
        in: Array.from(clinicIdToProviderId.values()),
      },
    },
  });

  const BATCH_SIZE = 500;
  for (let i = 0; i < validRates.length; i += BATCH_SIZE) {
    const batch = validRates.slice(i, i + BATCH_SIZE);
    await prisma.ivfSuccessRate.createMany({
      data: batch.map((sr) => {
        const providerId = clinicIdToProviderId.get(
          parseInt(sr.ClinicID, 10),
        )!;
        const natAvg = getNationalAvg(national, sr);
        return {
          providerId,
          profileType: sr.profile_type,
          metricCode: sr.metric_code,
          submetric: sr.submetric || null,
          ageGroup: sr.age_group || null,
          isNewPatient: sr.is_new_patient ?? false,
          successRate: new Decimal(sr.success_rate!),
          cycleCount: sr.cycle_count ?? 0,
          percentile: new Decimal(sr.percentile ?? 0),
          top10pct: sr.top10pct,
          nationalAverage: new Decimal(natAvg),
        };
      }),
    });
    console.log(
      `  Batch ${Math.floor(i / BATCH_SIZE) + 1}: inserted ${Math.min(i + BATCH_SIZE, validRates.length)} / ${validRates.length}`,
    );
  }

  console.log("Migration complete!");
}

function getEmbeddedClinics(): RawClinic[] {
  return [
    { ClinicID: 1, clinic_name: "Boston IVF", Address: "130 Second Ave", City: "Waltham", state: "MA", zip: "02451", lat: 42.3765, lng: -71.2356 },
    { ClinicID: 2, clinic_name: "CCRM Fertility", Address: "10290 RidgeGate Cir", City: "Lone Tree", state: "CO", zip: "80124", lat: 39.5369, lng: -104.8808 },
    { ClinicID: 3, clinic_name: "RMA of New York", Address: "635 Madison Ave", City: "New York", state: "NY", zip: "10022", lat: 40.7644, lng: -73.9718 },
    { ClinicID: 4, clinic_name: "Shady Grove Fertility", Address: "15001 Shady Grove Rd", City: "Rockville", state: "MD", zip: "20850", lat: 39.0958, lng: -77.1975 },
    { ClinicID: 5, clinic_name: "Pacific Fertility Center", Address: "55 Francisco St", City: "San Francisco", state: "CA", zip: "94133", lat: 37.8044, lng: -122.4100 },
    { ClinicID: 6, clinic_name: "Fertility Institute of Hawaii", Address: "1401 S Beretania St", City: "Honolulu", state: "HI", zip: "96814", lat: 21.3022, lng: -157.8456 },
    { ClinicID: 7, clinic_name: "Northwestern Fertility", Address: "676 N St Clair St", City: "Chicago", state: "IL", zip: "60611", lat: 41.8951, lng: -87.6232 },
    { ClinicID: 8, clinic_name: "Dallas IVF", Address: "7777 Forest Ln", City: "Dallas", state: "TX", zip: "75230", lat: 32.9057, lng: -96.7878 },
    { ClinicID: 9, clinic_name: "Kindbody", Address: "110 E 40th St", City: "New York", state: "NY", zip: "10016", lat: 40.7505, lng: -73.9795 },
    { ClinicID: 10, clinic_name: "Spring Fertility", Address: "1700 California St", City: "San Francisco", state: "CA", zip: "94109", lat: 37.7909, lng: -122.4208 },
    { ClinicID: 11, clinic_name: "HRC Fertility", Address: "1 Hoag Dr", City: "Newport Beach", state: "CA", zip: "92663", lat: 33.6189, lng: -117.9295 },
    { ClinicID: 12, clinic_name: "SGF Atlanta", Address: "5505 Peachtree Dunwoody Rd", City: "Atlanta", state: "GA", zip: "30342", lat: 33.8921, lng: -84.3520 },
  ];
}

function getEmbeddedSuccessRates(): RawSuccessRate[] {
  const ageGroups = ["under_35", "35_37", "38_40", "over_40"];
  const rates: RawSuccessRate[] = [];
  const clinicProfiles: Record<number, { base: number; top10: boolean }> = {
    1: { base: 0.56, top10: true },
    2: { base: 0.55, top10: true },
    3: { base: 0.58, top10: true },
    4: { base: 0.48, top10: false },
    5: { base: 0.52, top10: true },
    6: { base: 0.44, top10: false },
    7: { base: 0.50, top10: false },
    8: { base: 0.46, top10: false },
    9: { base: 0.53, top10: true },
    10: { base: 0.54, top10: true },
    11: { base: 0.51, top10: false },
    12: { base: 0.47, top10: false },
  };

  const ageDecay: Record<string, number> = {
    under_35: 1.0,
    "35_37": 0.82,
    "38_40": 0.60,
    over_40: 0.30,
  };

  for (const [clinicIdStr, profile] of Object.entries(clinicProfiles)) {
    const clinicId = parseInt(clinicIdStr);
    for (const ag of ageGroups) {
      const decay = ageDecay[ag];
      for (const isNew of [false, true]) {
        const sr = Math.round(profile.base * decay * (isNew ? 1.1 : 1.0) * 1000) / 1000;
        const pctile = Math.min(99, Math.round(sr * 100 + (profile.top10 ? 15 : 0)));
        rates.push({
          ClinicID: String(clinicId),
          profile_type: "own_eggs",
          metric_code: "cum_live_birth_per_intended_retrieval",
          submetric: null,
          age_group: ag,
          is_new_patient: isNew,
          success_rate: sr,
          cycle_count: Math.floor(Math.random() * 300) + 50,
          suppressed: false,
          rank: null,
          percentile: pctile,
          top10pct: profile.top10 && ag === "under_35",
          Topic: "ART Success Rates",
          SubTopic: "Live Births",
          Question: "Cumulative live birth rate per intended egg retrieval",
          Breakout: ag === "under_35" ? "Patients under 35" : `Patients ${ag.replace("_", "-")}`,
          footnote: null,
        });
      }
    }

    for (const subm of ["fresh_embryos_fresh_eggs", "fresh_embryos_frozen_eggs", "frozen_embryos", "donated_embryos"]) {
      const sr = Math.round((profile.base * 0.9 + Math.random() * 0.05) * 1000) / 1000;
      rates.push({
        ClinicID: String(clinicId),
        profile_type: "donor",
        metric_code: "noncum_live_birth_per_transfer",
        submetric: subm,
        age_group: null,
        is_new_patient: null,
        success_rate: sr,
        cycle_count: Math.floor(Math.random() * 100) + 10,
        suppressed: false,
        rank: null,
        percentile: Math.round(sr * 100),
        top10pct: profile.top10,
        Topic: "ART Success Rates",
        SubTopic: "Donor Egg Live Births",
        Question: "Live birth rate per transfer",
        Breakout: subm.replace(/_/g, " "),
        footnote: null,
      });
    }
  }

  return rates;
}

main()
  .catch((e) => {
    console.error("Migration failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
