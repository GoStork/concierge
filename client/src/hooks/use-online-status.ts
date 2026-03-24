import { useState, useEffect, useRef, useCallback } from "react";

interface OnlineStatusState {
  statuses: Record<string, boolean>;
  isLoading: boolean;
}

/**
 * Polls /api/online-status for a set of user IDs and/or provider IDs.
 * Returns a map of id -> boolean (online or not).
 * Polls every `intervalMs` (default 10s).
 */
export function useOnlineStatus(
  userIds: string[] = [],
  providerIds: string[] = [],
  intervalMs = 10000,
): OnlineStatusState {
  const [statuses, setStatuses] = useState<Record<string, boolean>>({});
  const [isLoading, setIsLoading] = useState(true);
  const prevKeyRef = useRef("");

  const fetchStatuses = useCallback(async (uIds: string[], pIds: string[]) => {
    const params = new URLSearchParams();
    if (uIds.length > 0) params.set("userIds", uIds.join(","));
    if (pIds.length > 0) params.set("providerIds", pIds.join(","));
    if (!params.toString()) {
      setStatuses({});
      setIsLoading(false);
      return;
    }
    try {
      const res = await fetch(`/api/online-status?${params}`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setStatuses(data);
      }
    } catch {}
    setIsLoading(false);
  }, []);

  useEffect(() => {
    const sortedKey = [...userIds].sort().join(",") + "|" + [...providerIds].sort().join(",");
    if (sortedKey === "|") {
      setStatuses({});
      setIsLoading(false);
      return;
    }
    // Reset loading state when IDs change significantly
    if (sortedKey !== prevKeyRef.current) {
      prevKeyRef.current = sortedKey;
      setIsLoading(true);
    }

    fetchStatuses(userIds, providerIds);
    const interval = setInterval(() => fetchStatuses(userIds, providerIds), intervalMs);
    return () => clearInterval(interval);
  }, [userIds.join(","), providerIds.join(","), intervalMs, fetchStatuses]);

  return { statuses, isLoading };
}
