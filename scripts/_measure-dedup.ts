import "reflect-metadata"; import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../server/src/app.module";
import { PrismaService } from "../server/src/modules/prisma/prisma.service";
import { StorageService } from "../server/src/modules/storage/storage.service";
import sharp from "sharp";
const N = 32;
async function thumb(buf: Buffer) {
  const raw = await sharp(buf, { failOn: "none" }).greyscale().resize(N, N, { fit: "fill" }).raw().toBuffer();
  const a = new Float64Array(N * N);
  for (let i = 0; i < N * N; i++) a[i] = raw[i];
  const mean = a.reduce((s, v) => s + v, 0) / a.length;
  const sd = Math.sqrt(a.reduce((s, v) => s + (v - mean) ** 2, 0) / a.length) || 1;
  for (let i = 0; i < a.length; i++) a[i] = (a[i] - mean) / sd;
  return a;
}
const corr = (a: Float64Array, b: Float64Array) => a.reduce((s, v, i) => s + v * b[i], 0) / a.length;
(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
  const p = app.get(PrismaService); const s = app.get(StorageService);
  const rows = await p.eggDonor.findMany({ take: 70, where: { photos: { isEmpty: false } }, orderBy: { externalId: "asc" } });
  const out: any[] = [];
  for (const r of rows) {
    const urls = (r.photos as string[]).filter((u) => /storage.googleapis/.test(u)).slice(0, 12);
    const ts: any[] = [];
    for (const u of urls) {
      try {
        const path = decodeURIComponent(u.replace(/^https:\/\/storage.googleapis.com\/[^/]+\//, ""));
        const { buffer } = await s.downloadObject(path);
        const m = await sharp(buffer).metadata();
        ts.push({ t: await thumb(buffer), w: m.width, h: m.height });
      } catch { ts.push(null); }
    }
    for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) {
      if (!ts[i] || !ts[j]) continue;
      const c = corr(ts[i].t, ts[j].t);
      if (c >= 0.7) out.push({ c, id: r.externalId, i, j, a: `${ts[i].w}x${ts[i].h}`, b: `${ts[j].w}x${ts[j].h}` });
    }
  }
  out.sort((x, y) => y.c - x.c);
  console.log("pairs with correlation >= 0.70 across", rows.length, "egg donors:");
  out.forEach((o) => console.log(`  ${o.c.toFixed(3)}  ${o.id} #${o.i}(${o.a}) / #${o.j}(${o.b})`));
  await app.close(); process.exit(0);
})();
