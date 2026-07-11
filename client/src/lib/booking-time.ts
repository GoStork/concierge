// Shared booking time math. A meeting is "ended" once its scheduled start
// plus duration is in the past - Join/Start meeting actions must never render
// for ended meetings (see meeting-reminder-popup, calendar, appointments).

export const DEFAULT_BOOKING_DURATION_MIN = 30;

export function getBookingEnd(scheduledAt: string | Date, duration?: number | null): Date | null {
  const start = new Date(scheduledAt);
  if (isNaN(start.getTime())) return null;
  return new Date(start.getTime() + (duration || DEFAULT_BOOKING_DURATION_MIN) * 60 * 1000);
}

export function hasBookingEnded(scheduledAt: string | Date, duration?: number | null): boolean {
  const end = getBookingEnd(scheduledAt, duration);
  return end ? end.getTime() <= Date.now() : false;
}

// Instant video invites (uiCardType "video_invite") create a booking with
// scheduledAt = message time and a 30-minute duration (video.controller.ts).
// The card only carries bookingId, so expiry is derived from the message
// timestamp with extra grace for calls that start late or run long.
const VIDEO_INVITE_TTL_MS = 60 * 60 * 1000;

export function isVideoInviteExpired(messageCreatedAt?: string | Date | null): boolean {
  if (!messageCreatedAt) return false;
  const created = new Date(messageCreatedAt);
  if (isNaN(created.getTime())) return false;
  return Date.now() - created.getTime() > VIDEO_INVITE_TTL_MS;
}
