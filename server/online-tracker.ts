/**
 * Shared singleton that tracks which users are currently connected via SSE.
 * Used by NestJS services (AppEventsService, BookingEventsService) and
 * plain Express routers (chat-router, ai-router) to determine online status.
 */
const connectedCounts = new Map<string, number>();

export function trackConnect(userId: string) {
  connectedCounts.set(userId, (connectedCounts.get(userId) || 0) + 1);
}

export function trackDisconnect(userId: string) {
  const current = connectedCounts.get(userId) || 0;
  if (current > 1) {
    connectedCounts.set(userId, current - 1);
  } else {
    connectedCounts.delete(userId);
  }
}

export function isUserOnline(userId: string): boolean {
  return (connectedCounts.get(userId) || 0) > 0;
}

export function getConnectedCount(userId: string): number {
  return connectedCounts.get(userId) || 0;
}

export function getOnlineUserIds(): string[] {
  return Array.from(connectedCounts.keys());
}
