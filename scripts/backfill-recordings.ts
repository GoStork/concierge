/**
 * One-time backfill for Daily.co recordings that were never downloaded because
 * the webhook was registered without `eventTypes` (delivered nothing). See
 * server/src/modules/video/video.service.ts (DAILY_WEBHOOK_EVENTS).
 *
 * Strategy: fetch every recording from Daily's cloud, match each to a booking
 * by room name + a time window around the recording's start_ts (rooms are
 * REUSED across bookings, so a naive room-only match would mis-assign). Only
 * consent-given bookings are eligible. Then run the real
 * VideoService.processRecordingReady (download -> GCS -> ffmpeg -> Google STT)
 * and wait for transcription to finish before exiting.
 *
 * Run: npx tsx scripts/backfill-recordings.ts          (process matches)
 *      npx tsx scripts/backfill-recordings.ts --dry-run (report only)
 */
import "reflect-metadata";
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../server/src/app.module";
import { PrismaService } from "../server/src/modules/prisma/prisma.service";
import { VideoService } from "../server/src/modules/video/video.service";

const DRY_RUN = process.argv.includes("--dry-run");
const DAILY_API_BASE = "https://api.daily.co/v1";
const WINDOW_BEFORE_MS = 30 * 60 * 1000; // recording may start up to 30m before scheduledAt
const WINDOW_AFTER_MS = 4 * 60 * 60 * 1000; // ...and well after, until call ends

function roomNameOf(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.split("/").pop() || null;
}

async function fetchAllDailyRecordings(apiKey: string): Promise<any[]> {
  const all: any[] = [];
  let url = `${DAILY_API_BASE}/recordings?limit=100`;
  // Daily paginates with `?starting_after=<id>`; loop until a short page.
  for (let guard = 0; guard < 20; guard++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) throw new Error(`Daily list recordings failed: ${await res.text()}`);
    const data = await res.json();
    const page = data.data || [];
    all.push(...page);
    if (page.length < 100) break;
    url = `${DAILY_API_BASE}/recordings?limit=100&starting_after=${page[page.length - 1].id}`;
  }
  return all;
}

async function main() {
  const apiKey = process.env.DAILY_API_KEY;
  if (!apiKey) throw new Error("DAILY_API_KEY not set");

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn"] });
  const prisma = app.get(PrismaService);
  const video = app.get(VideoService);

  console.log(`\n=== Daily recording backfill ${DRY_RUN ? "(DRY RUN)" : ""} ===\n`);

  const recordings = await fetchAllDailyRecordings(apiKey);
  console.log(`Fetched ${recordings.length} recordings from Daily.co cloud.`);

  // Pull every consent-given booking that has a resolvable room, plus the
  // provider's persistent room url, so we can match by room + time.
  const bookings = await prisma.booking.findMany({
    where: { consentGiven: true },
    select: {
      id: true, subject: true, status: true, scheduledAt: true,
      actualStartedAt: true, actualEndedAt: true, meetingUrl: true,
      providerUser: { select: { dailyRoomUrl: true } },
    },
  });

  // Index bookings by room name.
  const byRoom = new Map<string, any[]>();
  for (const b of bookings) {
    const room = roomNameOf(b.meetingUrl) || roomNameOf(b.providerUser?.dailyRoomUrl);
    if (!room) continue;
    if (!byRoom.has(room)) byRoom.set(room, []);
    byRoom.get(room)!.push({ ...b, room });
  }

  const existing = await prisma.recording.findMany({ select: { dailyRecordingId: true } });
  const processedIds = new Set(existing.map((r) => r.dailyRecordingId).filter(Boolean));

  const toProcess: Array<{ rec: any; booking: any }> = [];
  let skippedDone = 0, skippedNoRoom = 0, skippedNoMatch = 0, ambiguous = 0;

  for (const rec of recordings) {
    if (processedIds.has(rec.id)) { skippedDone++; continue; }
    const room = rec.room_name;
    const candidates = byRoom.get(room) || [];
    if (candidates.length === 0) { skippedNoRoom++; continue; }

    const recStart = new Date((rec.start_ts || 0) * 1000);
    // A booking matches if recStart falls in [scheduledAt - 30m, end + 4h].
    const fits = candidates.filter((b) => {
      const sched = b.scheduledAt ? new Date(b.scheduledAt).getTime() : null;
      const end = b.actualEndedAt ? new Date(b.actualEndedAt).getTime() : (sched ? sched + WINDOW_AFTER_MS : null);
      if (sched == null || end == null) return false;
      return recStart.getTime() >= sched - WINDOW_BEFORE_MS && recStart.getTime() <= end + WINDOW_AFTER_MS;
    });

    let chosen: any = null;
    if (fits.length === 1) {
      chosen = fits[0];
    } else if (fits.length > 1) {
      // Pick the booking whose scheduledAt is closest to the recording start.
      chosen = fits.sort((a, b) =>
        Math.abs(new Date(a.scheduledAt).getTime() - recStart.getTime()) -
        Math.abs(new Date(b.scheduledAt).getTime() - recStart.getTime()))[0];
      ambiguous++;
    }

    if (!chosen) { skippedNoMatch++; continue; }
    toProcess.push({ rec, booking: chosen });
  }

  console.log(`\nMatch summary:`);
  console.log(`  already processed : ${skippedDone}`);
  console.log(`  no consent booking for room : ${skippedNoRoom}`);
  console.log(`  no time-window match        : ${skippedNoMatch}`);
  console.log(`  matched (incl. ${ambiguous} closest-of-several): ${toProcess.length}\n`);

  for (const { rec, booking } of toProcess) {
    console.log(`  ${new Date((rec.start_ts || 0) * 1000).toISOString()}  ${rec.duration ?? "?"}s  room=${rec.room_name}`);
    console.log(`    -> booking ${booking.id}  "${booking.subject}"  (${booking.status})`);
  }

  if (DRY_RUN) { await app.close(); console.log("\nDry run - nothing processed.\n"); return; }
  if (toProcess.length === 0) { await app.close(); console.log("Nothing to process.\n"); return; }

  console.log(`\nProcessing ${toProcess.length} recordings sequentially...\n`);
  const createdRecordingIds: string[] = [];

  for (const { rec, booking } of toProcess) {
    try {
      // The recording.ready handler keys off actualStartedAt; set it to the real
      // call start (the recording's start_ts) if the webhook never recorded it.
      if (!booking.actualStartedAt) {
        await prisma.booking.update({
          where: { id: booking.id },
          data: { actualStartedAt: new Date((rec.start_ts || 0) * 1000) },
        });
      }
      let downloadUrl = rec.download_url;
      if (!downloadUrl) downloadUrl = await video.getRecordingAccessLink(rec.id);
      if (!downloadUrl) { console.log(`  ! no download url for ${rec.id} - skipped`); continue; }

      await video.processRecordingReady(booking.id, rec.id, downloadUrl, rec.duration);
      const row = await prisma.recording.findFirst({
        where: { bookingId: booking.id, dailyRecordingId: rec.id },
        select: { id: true, status: true },
      });
      if (row) {
        createdRecordingIds.push(row.id);
        console.log(`  ok  ${rec.id} -> recording ${row.id} (${row.status})`);
      }
    } catch (err: any) {
      console.log(`  ! failed ${rec.id}: ${err.message}`);
    }
  }

  // Transcription runs detached inside processRecordingReady; wait for it to
  // finish (or fail) before exiting, otherwise the process dies mid-transcribe.
  console.log(`\nWaiting for transcription of ${createdRecordingIds.length} recordings...`);
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline && createdRecordingIds.length) {
    const rows = await prisma.recording.findMany({
      where: { id: { in: createdRecordingIds } },
      select: { id: true, transcriptStatus: true },
    });
    const pending = rows.filter((r) => r.transcriptStatus === "pending" || r.transcriptStatus === "processing");
    if (pending.length === 0) break;
    process.stdout.write(`  ${pending.length} still transcribing...\r`);
    await new Promise((r) => setTimeout(r, 5000));
  }

  const final = await prisma.recording.findMany({
    where: { id: { in: createdRecordingIds } },
    select: { status: true, transcriptStatus: true },
  });
  const ready = final.filter((r) => r.transcriptStatus === "ready").length;
  console.log(`\n\nDone. ${final.length} recordings stored, ${ready} with transcripts ready.\n`);
  await app.close();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
