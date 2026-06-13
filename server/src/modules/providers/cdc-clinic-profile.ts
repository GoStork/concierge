import { PrismaService } from "../prisma/prisma.service";

// CDC ART clinic-profile enrichment: pulls the two CDC ART datasets that the
// success-rates sync does NOT cover - "Services and Profiles" and "Patient and
// Cycle Characteristics" - and writes per-clinic JSON onto Provider, joined by
// cdcClinicId. Surfaces what services a clinic offers, what diagnoses its patients
// most have (experience signal), and how it practices (PGT/ICSI/frozen/etc.).

const SOCRATA_CATALOG_URL = "https://api.us.socrata.com/api/catalog/v1";
const CDC_DATA_BASE = "https://data.cdc.gov/resource";
const PAGE_SIZE = 10000;

// Known 2022 dataset IDs (used as a fallback when catalog discovery comes up empty).
const FALLBACK_2022 = { services: "ix4g-rt8v", patientCycle: "wrev-kwxu" };

// Map a CDC service/profile subtopic to a clean boolean key on cdcServices.
const SERVICE_KEYS: { match: RegExp; key: string }[] = [
  { match: /donor egg/i, key: "donorEgg" },
  { match: /donated embryo/i, key: "donatedEmbryo" },
  { match: /embryo cryopreservation/i, key: "embryoCryo" },
  { match: /egg cryopreservation/i, key: "eggCryo" },
  { match: /gestational carrier/i, key: "gestationalCarrier" },
  { match: /single wom/i, key: "singleWomen" },
  { match: /female couple|same.?sex/i, key: "femaleCouple" },
  { match: /lab accreditation/i, key: "labAccredited" },
];

// Map a CDC cycle-characteristic question to a clean numeric key on cdcCycleStats.
const CYCLE_KEYS: { match: RegExp; key: string }[] = [
  { match: /preimplantation genetic testing|\bPGT\b/i, key: "pgtPct" },
  { match: /intracytoplasmic sperm injection|\bICSI\b/i, key: "icsiPct" },
  { match: /frozen embryos/i, key: "frozenPct" },
  { match: /single embryo/i, key: "singleEmbryoPct" },
  { match: /gestational carrier/i, key: "gestationalCarrierPct" },
  { match: /fertility preservation/i, key: "fertilityPreservationPct" },
];

async function fetchAll(datasetId: string): Promise<any[]> {
  const rows: any[] = [];
  let offset = 0;
  for (;;) {
    const url = `${CDC_DATA_BASE}/${datasetId}.json?$limit=${PAGE_SIZE}&$offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CDC dataset ${datasetId} returned ${res.status}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

// Find a dataset id by name fragment + year via the Socrata catalog.
async function discover(year: number, nameFragment: string): Promise<string | null> {
  const q = encodeURIComponent(`Assisted Reproductive Technology ${nameFragment} ${year}`);
  const url = `${SOCRATA_CATALOG_URL}?domains=data.cdc.gov&q=${q}&limit=50`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const frag = nameFragment.toLowerCase();
    const match = (data.results || []).find((r: any) => {
      const name = (r.resource?.name || "").toLowerCase();
      return name.includes(String(year)) && frag.split(" ").every((w) => name.includes(w));
    });
    return match?.resource?.id || null;
  } catch {
    return null;
  }
}

export async function syncClinicProfiles(
  prisma: PrismaService,
  year: number,
): Promise<{ servicesFilled: number; experienceFilled: number; cycleFilled: number }> {
  const servicesId = (await discover(year, "Services and Profiles")) || (year === 2022 ? FALLBACK_2022.services : null);
  const patientCycleId = (await discover(year, "Patient and Cycle Characteristics")) || (year === 2022 ? FALLBACK_2022.patientCycle : null);

  // clinicid -> built JSON
  const services = new Map<string, Record<string, boolean>>();
  const experience = new Map<string, Record<string, number>>();
  const cycle = new Map<string, Record<string, number>>();
  const medicalDirector = new Map<string, string>();

  if (servicesId) {
    const rows = await fetchAll(servicesId);
    for (const r of rows) {
      const cid = String(r.clinicid || "");
      if (!cid) continue;
      if (r.medicaldirector && !medicalDirector.has(cid)) medicalDirector.set(cid, String(r.medicaldirector).trim());
      const subtopic = r.subtopic || "";
      if (!subtopic) continue;
      const hit = SERVICE_KEYS.find((s) => s.match.test(subtopic));
      if (!hit) continue;
      const yes = /^yes$/i.test(String(r.data_value || "").trim());
      if (!services.has(cid)) services.set(cid, {});
      services.get(cid)![hit.key] = yes;
    }
    console.log(`[cdc-profile] services dataset ${servicesId}: ${services.size} clinics, ${medicalDirector.size} directors`);
  }

  if (patientCycleId) {
    const rows = await fetchAll(patientCycleId);
    for (const r of rows) {
      const cid = String(r.clinicid || "");
      if (!cid) continue;
      const q = r.question || "";
      const val = r.data_value_num != null ? Number(r.data_value_num) : parseFloat(r.data_value);
      if (!Number.isFinite(val)) continue;
      if (/reasons patients used ART/i.test(q) && r.breakout_category) {
        if (!experience.has(cid)) experience.set(cid, {});
        experience.get(cid)![r.breakout_category] = val;
      } else {
        const hit = CYCLE_KEYS.find((c) => c.match.test(q));
        if (hit) {
          if (!cycle.has(cid)) cycle.set(cid, {});
          cycle.get(cid)![hit.key] = val;
        }
      }
    }
    console.log(`[cdc-profile] patient/cycle dataset ${patientCycleId}: ${experience.size} experience, ${cycle.size} cycle`);
  }

  // Write to Provider by cdcClinicId.
  const clinicIds = new Set<string>([...services.keys(), ...experience.keys(), ...cycle.keys(), ...medicalDirector.keys()]);
  let servicesFilled = 0, experienceFilled = 0, cycleFilled = 0;
  for (const cid of clinicIds) {
    const data: any = {};
    if (services.has(cid)) { data.cdcServices = services.get(cid); servicesFilled++; }
    if (experience.has(cid)) { data.cdcExperience = experience.get(cid); experienceFilled++; }
    if (cycle.has(cid)) { data.cdcCycleStats = cycle.get(cid); cycleFilled++; }
    if (medicalDirector.has(cid)) data.cdcMedicalDirector = medicalDirector.get(cid);
    if (Object.keys(data).length === 0) continue;
    await prisma.provider.updateMany({ where: { cdcClinicId: cid }, data });
  }
  console.log(`[cdc-profile] wrote services=${servicesFilled} experience=${experienceFilled} cycle=${cycleFilled}`);
  return { servicesFilled, experienceFilled, cycleFilled };
}
