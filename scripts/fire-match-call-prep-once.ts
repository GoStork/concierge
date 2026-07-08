// One-off: fire the match-call prep bundle (24h-hold explainer + prep guide
// PDF) for the most recent MATCH_CALL booking. Usage: npx tsx scripts/fire-match-call-prep-once.ts
import "reflect-metadata";
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../server/src/app.module";
import { CalendarController } from "../server/src/modules/calendar/calendar.controller";
import { prisma } from "../server/db";

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn"] });
  const ctrl = app.get(CalendarController);
  const booking = await prisma.booking.findFirst({
    where: { meetingSubtype: "MATCH_CALL", status: { in: ["CONFIRMED", "PENDING"] } },
    orderBy: { createdAt: "desc" },
  });
  if (!booking) { console.log("no match call booking found"); process.exit(1); }
  console.log("firing prep for booking", booking.id, booking.scheduledAt.toISOString());
  await (ctrl as any).fireMatchCallPrep(booking);
  console.log("done");
  await app.close();
  process.exit(0);
})();
