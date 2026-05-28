import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const p = new PrismaClient({ adapter: new PrismaPg(pool) }) as any;
(async () => {
  const c = await p.invoice.count({ where: { bankPayoutCompletedAt: { not: null } } });
  console.log(`Invoices stamped 'Received': ${c}`);
  if (c > 0) {
    const recent = await p.invoice.findMany({
      where: { bankPayoutCompletedAt: { not: null } },
      select: { id: true, providerPayoutAmount: true, bankPayoutCompletedAt: true, stripeBankPayoutId: true },
      orderBy: { bankPayoutCompletedAt: "desc" },
      take: 5,
    });
    for (const r of recent) console.log(`  ${r.id} | ${r.providerPayoutAmount} | payout=${r.stripeBankPayoutId} | at=${r.bankPayoutCompletedAt?.toISOString()}`);
  }
  process.exit(0);
})();
