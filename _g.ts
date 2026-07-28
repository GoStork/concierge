import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
const rows = await prisma.providerMember.findMany({
  where: { photoUrl: { startsWith: "https://storage.googleapis.com/gostork-recordings/profile-photos/" } },
  select: { name: true, photoUrl: true }, take: 12,
});
for (const r of rows) {
  const res = await fetch(r.photoUrl!, { method: "HEAD", signal: AbortSignal.timeout(10000) }).catch(e => ({ status: "ERR " + e.message } as any));
  console.log(res.status, r.name);
}
await prisma.$disconnect();
