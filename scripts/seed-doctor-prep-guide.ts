// One-off: seed the Doctor Call prep guide from the Desktop PDF.
import "dotenv/config";
import { Storage } from "@google-cloud/storage";
import { readFileSync } from "fs";
import { prisma } from "../server/db";

(async () => {
  const credentials = JSON.parse(process.env.GCS_SERVICE_ACCOUNT_KEY!);
  const storage = new Storage({ credentials });
  const bucket = storage.bucket(process.env.GCS_BUCKET_NAME || "gostork-recordings");
  const buf = readFileSync("/Users/eranamir/Desktop/IVF Doctor Call Questions.pdf");
  const objectPath = "concierge-assets/doctor_call_prep_guide.pdf";
  await bucket.file(objectPath).save(buf, { contentType: "application/pdf" });
  const asset = await prisma.conciergeAsset.upsert({
    where: { key: "doctor_call_prep_guide" },
    create: { key: "doctor_call_prep_guide", fileName: "IVF Doctor Call Questions.pdf", objectPath, contentType: "application/pdf" },
    update: { fileName: "IVF Doctor Call Questions.pdf", objectPath },
  });
  console.log("seeded", asset.key, asset.fileName);
  await prisma.$disconnect();
  process.exit(0);
})();
