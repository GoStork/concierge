import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "./queryClient";

// Tracks which donor/surrogate/sperm-donor profiles the current parent
// account has already "seen". Used by the marketplace and AI chat to
// clear the "New" badge per profile (see SwipeDeckCard + swipe-mappers).
//
// Local Set is the source of truth during a session, hydrated from the
// /recent endpoint on mount. Writes are batched (default 1.5s window) so
// scroll-past doesn't fire a request per card. New IDs land in the Set
// optimistically, so the "New" badge disappears instantly on action even
// before the network write completes.

type ProfileType = "egg-donor" | "surrogate" | "sperm-donor";

interface PendingView {
  profileId: string;
  profileType: ProfileType;
}

const QUERY_KEY = ["/api/users/parent-account/profile-views/recent"];
const FLUSH_INTERVAL_MS = 1500;

// Module-level so all consumers share the same Set, watermark, and flush
// timer. Hydrated once from the backend /profile-views/recent endpoint;
// the watermark only changes when the parent starts a new session
// (server-controlled, 30-min sliding window).
const viewedSet = new Set<string>();
let previousVisitAt: Date | null = null;
const pendingQueue: Map<string, PendingView> = new Map();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let listenerSeq = 0;
const listeners = new Map<number, () => void>();

function makeKey(profileId: string, profileType: ProfileType): string {
  return `${profileType}:${profileId}`;
}

function notify(): void {
  for (const cb of listeners.values()) cb();
}

function hydrate(payload: { viewedIds: string[]; previousVisitAt: string }): void {
  let changed = false;
  for (const id of payload.viewedIds || []) {
    if (!viewedSet.has(id)) {
      viewedSet.add(id);
      changed = true;
    }
  }
  if (payload.previousVisitAt) {
    const parsed = new Date(payload.previousVisitAt);
    if (!Number.isNaN(parsed.getTime())) {
      if (!previousVisitAt || previousVisitAt.getTime() !== parsed.getTime()) {
        previousVisitAt = parsed;
        changed = true;
      }
    }
  }
  if (changed) notify();
}

async function flush(): Promise<void> {
  flushTimer = null;
  if (pendingQueue.size === 0) return;
  const batch = Array.from(pendingQueue.values());
  pendingQueue.clear();
  try {
    await apiRequest("POST", "/api/users/parent-account/profile-views", {
      views: batch,
    });
  } catch (e) {
    // Best-effort - if the server is briefly unreachable, the optimistic
    // local Set still hides the badge for the rest of this session. The
    // next page load re-hydrates from the server.
    console.warn("[profile-views] batch flush failed", e);
  }
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => { flush(); }, FLUSH_INTERVAL_MS);
}

// Mark a profile as viewed. Adds to the local Set immediately (so the
// "New" badge disappears on the next render) and enqueues a backend write.
// Safe to call repeatedly with the same id - duplicates are dedup'd.
export function recordProfileView(profileId: string, profileType: ProfileType): void {
  if (!profileId) return;
  const wasNew = !viewedSet.has(profileId);
  if (wasNew) {
    viewedSet.add(profileId);
    notify();
  }
  // Always enqueue - the backend createMany skipDuplicates handles repeats,
  // and the network write also covers the case where hydrate hasn't run yet.
  pendingQueue.set(makeKey(profileId, profileType), { profileId, profileType });
  scheduleFlush();
}

// React hook returning the marketplace view context: the Set of viewed
// profile IDs + previousVisitAt watermark. Components use:
//   const { viewedIds, previousVisitAt } = useMarketplaceViewContext();
//   const isNew = !viewedIds.has(profile.id) && profile.createdAt > previousVisitAt;
// The watermark is server-controlled with a 30-min sliding session window
// so consecutive reloads don't clear all New badges; see backend
// getRecentProfileViews for the rule.
export function useMarketplaceViewContext(): { viewedIds: Set<string>; previousVisitAt: Date | null } {
  const { data } = useQuery<{ viewedIds: string[]; previousVisitAt: string }>({
    queryKey: QUERY_KEY,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  useEffect(() => {
    if (data) hydrate(data);
  }, [data]);

  const [, force] = useState(0);
  useEffect(() => {
    const id = ++listenerSeq;
    listeners.set(id, () => force((n) => n + 1));
    return () => {
      listeners.delete(id);
    };
  }, []);

  // Returning the module-level state directly is fine - we trigger re-
  // renders via the listener whenever either changes. Components only
  // read .has() and the timestamp.
  return { viewedIds: viewedSet, previousVisitAt };
}

// Backwards-compatible thin alias for call sites that only need the Set.
// Prefer useMarketplaceViewContext when the watermark is also needed.
export function useViewedProfileIds(): Set<string> {
  return useMarketplaceViewContext().viewedIds;
}

// IntersectionObserver-backed "scroll past" detection. The callback fires
// once a target stays in viewport for `dwellMs` (default 1000ms), which
// is the cleanest "the parent saw this card" signal short of an explicit
// tap. Returns a ref to attach to the card element.
export function useScrollPastView(
  profileId: string | null | undefined,
  profileType: ProfileType,
  dwellMs: number = 1000,
): (el: HTMLElement | null) => void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const elementRef = useRef<HTMLElement | null>(null);
  const recordedRef = useRef(false);

  const setRef = useCallback((el: HTMLElement | null) => {
    if (observerRef.current && elementRef.current) {
      observerRef.current.unobserve(elementRef.current);
    }
    elementRef.current = el;
    if (!el || !profileId || recordedRef.current) return;
    if (!observerRef.current) {
      observerRef.current = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            if (timerRef.current === null) {
              timerRef.current = setTimeout(() => {
                timerRef.current = null;
                if (!recordedRef.current) {
                  recordedRef.current = true;
                  recordProfileView(profileId, profileType);
                  if (observerRef.current && elementRef.current) {
                    observerRef.current.unobserve(elementRef.current);
                  }
                }
              }, dwellMs);
            }
          } else if (timerRef.current !== null) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
          }
        }
      }, { threshold: 0.5 });
    }
    observerRef.current.observe(el);
  }, [profileId, profileType, dwellMs]);

  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    if (observerRef.current) observerRef.current.disconnect();
  }, []);

  return setRef;
}

// Resets all module-level state so the next mount re-fetches from the
// server. Call this when the parent account changes (logout / account
// switch) so the viewed set + watermark from the previous account don't
// leak into the new one.
export function invalidateViewedProfiles(): void {
  viewedSet.clear();
  previousVisitAt = null;
  pendingQueue.clear();
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  notify();
}
