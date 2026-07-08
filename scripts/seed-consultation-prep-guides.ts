// One-off: seed the four first-consultation prep guides from the Desktop PDFs.
import "dotenv/config";
import { Storage } from "@google-cloud/storage";
import { readFileSync } from "fs";
import { prisma } from "../server/db";

const GUIDES = [
  { key: "consultation_prep_guide_ivf", file: "/Users/eranamir/Desktop/IVF Clinic Consultation Questions.pdf", name: "IVF Clinic Consultation Questions.pdf" },
  { key: "consultation_prep_guide_surrogacy", file: "/Users/eranamir/Desktop/Surrogacy Agency Consultation Questions.pdf", name: "Surrogacy Agency Consultation Questions.pdf" },
  { key: "consultation_prep_guide_egg_donor", file: "/Users/eranamir/Desktop/Egg Donor Agency Consultation Questions.pdf", name: "Egg Donor Agency Consultation Questions.pdf" },
  { key: "consultation_prep_guide_sperm_bank", file: "/Users/eranamir/Desktop/Sperm Bank Consultation Questions.pdf", name: "Sperm Bank Consultation Questions.pdf" },
];

(async () => {
  const credentials = JSON.parse(process.env.GCS_SERVICE_ACCOUNT_KEY!);
  const storage = new Storage({ credentials });
  const bucket = storage.bucket(process.env.GCS_BUCKET_NAME || "gostork-recordings");
  for (const g of GUIDES) {
    const buf = readFileSync(g.file);
    const objectPath = `concierge-assets/${g.key}.pdf`;
    await bucket.file(objectPath).save(buf, { contentType: "application/pdf" });
    await prisma.conciergeAsset.upsert({
      where: { key: g.key },
      create: { key: g.key, fileName: g.name, objectPath, contentType: "application/pdf" },
      update: { fileName: g.name, objectPath },
    });
    console.log("seeded", g.key);
  }
  await prisma.$disconnect();
  process.exit(0);
})();
