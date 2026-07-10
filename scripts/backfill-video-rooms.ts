// One-off: provision a personal Daily.co video room for every provider-side
// or GoStork-staff user who is missing one (created before the role list
// covered their role, e.g. Lawyer / Legal Assistant / Billing Manager).
// Usage: npx tsx scripts/backfill-video-rooms.ts
import "reflect-metadata";
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../server/src/app.module";
import { PrismaService } from "../server/src/modules/prisma/prisma.service";
import { VideoService } from "../server/src/modules/video/video.service";
import { PROVIDER_ROLES, GOSTORK_ROLES } from "../shared/roles";

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn"] });
  const prisma = app.get(PrismaService);
  const video = app.get(VideoService);
  const users = await prisma.user.findMany({
    where: {
      dailyRoomUrl: null,
      isDisabled: false,
      roles: { hasSome: [...GOSTORK_ROLES, ...PROVIDER_ROLES] },
    },
    select: { id: true, name: true, email: true, roles: true },
  });
  console.log(`${users.length} user(s) missing a video room`);
  for (const u of users) {
    try {
      const room = await video.createRoom();
      await prisma.user.update({ where: { id: u.id }, data: { dailyRoomUrl: room.url } });
      console.log(`  ${u.name || u.email} (${u.roles.join(",")}) -> ${room.url}`);
    } catch (e: any) {
      console.error(`  FAILED for ${u.email}: ${e?.message}`);
    }
  }
  await app.close();
  process.exit(0);
})();
