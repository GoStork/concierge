/**
 * Phase 8 Reviews & Ratings - shared client pieces (docs/reviews-ratings-spec.md).
 *
 * - StarDisplay / StarRatingInput: read-only + interactive 1-5 stars.
 * - ReviewForm: the one form used everywhere (Eva's chat card + self-serve
 *   on profile pages). Categories adapt to org vs doctor; 1-2 star ratings
 *   offer the private-feedback offramp.
 * - ReviewPromptCard: Eva's in-chat ask (parent-only card).
 * - ReviewsSection: aggregates + published list + self-serve form, mounted
 *   on provider and doctor profile pages.
 * - ProviderReviewsPanel: the provider dashboard's own-reviews view with
 *   reply + flag actions.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Star, Check, Flag, MessageSquare, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiRequest, queryClient } from "@/lib/queryClient";

const ORG_CATEGORIES: { key: string; label: string }[] = [
  { key: "communication", label: "Communication" },
  { key: "transparency", label: "Transparency & Pricing" },
  { key: "responsiveness", label: "Responsiveness" },
  { key: "support", label: "Support & Care" },
];
const DOCTOR_CATEGORIES: { key: string; label: string }[] = [
  { key: "communication", label: "Communication" },
  { key: "expertise", label: "Expertise" },
  { key: "care", label: "Care & Empathy" },
];

export function StarDisplay({ value, size = 14 }: { value: number | null | undefined; size?: number }) {
  if (value == null) return null;
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${value} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          style={{ width: size, height: size }}
          className={i <= Math.round(value) ? "fill-[hsl(var(--brand-warning))] text-[hsl(var(--brand-warning))]" : "text-muted-foreground/40"}
        />
      ))}
    </span>
  );
}

/** Compact "4.8 (12)" badge for cards and headers. */
export function RatingBadge({ avg, count, size = 13 }: { avg: number | null | undefined; count: number | null | undefined; size?: number }) {
  if (!count || avg == null) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-foreground" data-testid="rating-badge">
      <Star style={{ width: size, height: size }} className="fill-[hsl(var(--brand-warning))] text-[hsl(var(--brand-warning))]" />
      {Number(avg).toFixed(1)}
      <span className="text-muted-foreground font-normal">({count})</span>
    </span>
  );
}

function StarRatingInput({ value, onChange, size = 26 }: { value: number; onChange: (v: number) => void; size?: number }) {
  const [hover, setHover] = useState(0);
  return (
    <div className="flex items-center gap-1" role="radiogroup" aria-label="Rating">
      {[1, 2, 3, 4, 5].map((i) => (
        <button
          key={i}
          type="button"
          onClick={() => onChange(i)}
          onMouseEnter={() => setHover(i)}
          onMouseLeave={() => setHover(0)}
          className="p-0.5"
          data-testid={`star-${i}`}
          aria-label={`${i} stars`}
        >
          <Star
            style={{ width: size, height: size }}
            className={i <= (hover || value) ? "fill-[hsl(var(--brand-warning))] text-[hsl(var(--brand-warning))]" : "text-muted-foreground/40"}
          />
        </button>
      ))}
    </div>
  );
}

export function ReviewForm({
  providerId,
  memberId,
  targetLabel,
  existing,
  initialRating,
  onSubmitted,
  onCancel,
}: {
  providerId: string;
  memberId?: string | null;
  targetLabel: string;
  existing?: { rating?: number | null; categories?: Record<string, number> | null; text?: string | null; anonymous?: boolean } | null;
  initialRating?: number;
  onSubmitted?: (result: { status: string; visibility: string }) => void;
  onCancel?: () => void;
}) {
  const categories = memberId ? DOCTOR_CATEGORIES : ORG_CATEGORIES;
  const [rating, setRating] = useState<number>(initialRating || existing?.rating || 0);
  const [cats, setCats] = useState<Record<string, number>>((existing?.categories as any) || {});
  const [text, setText] = useState(existing?.text || "");
  const [anonymous, setAnonymous] = useState(existing?.anonymous || false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ status: string; visibility: string } | null>(null);

  const submit = async (visibility: "PUBLIC" | "PRIVATE_FEEDBACK") => {
    if (!rating) { setError("Pick a star rating first."); return; }
    setPending(true);
    setError(null);
    try {
      const res = await apiRequest("POST", "/api/reviews", {
        providerId, memberId: memberId || undefined, rating, categories: cats, text: text.trim() || undefined, anonymous, visibility,
      });
      const data = await res.json();
      setDone({ status: data.status, visibility: data.visibility });
      queryClient.invalidateQueries({ queryKey: ["reviews", providerId, memberId || "org"] });
      queryClient.invalidateQueries({ queryKey: ["review-eligibility", providerId, memberId || "org"] });
      onSubmitted?.({ status: data.status, visibility: data.visibility });
    } catch (e: any) {
      // Gateway/tunnel failures surface as raw HTML pages - never dump those
      // into the form. Show server JSON messages when short and clean.
      const raw = String(e?.message || "");
      const friendly = raw && raw.length < 160 && !/<[a-z!]/i.test(raw)
        ? raw
        : "Connection hiccup - your review wasn't saved. Please try again.";
      setError(friendly);
    } finally {
      setPending(false);
    }
  };

  if (done) {
    const label = done.visibility === "PRIVATE_FEEDBACK"
      ? "Shared privately with the GoStork team - thank you."
      : done.status === "PUBLISHED"
        ? "Thank you! Your review is live."
        : "Thank you! Your review is being looked at and will publish shortly.";
    return (
      <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-[hsl(var(--brand-success))]/10 text-[hsl(var(--brand-success))]" data-testid="review-submitted">
        <Check className="w-3.5 h-3.5" />
        {label}
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-[var(--radius)] border bg-secondary/30 p-3" data-testid="review-form">
      <div>
        <p className="text-base font-semibold text-foreground mb-1">Overall experience with {targetLabel}</p>
        <StarRatingInput value={rating} onChange={setRating} />
      </div>
      {/* One category per row, always stacked - the two-column layout on wide
          pages read as if only half the categories were editable. */}
      <div className="space-y-2.5 max-w-md">
        {categories.map((c) => (
          <div key={c.key} className="flex items-center justify-between gap-2">
            <span className="text-sm text-foreground">{c.label}</span>
            <StarRatingInput value={cats[c.key] || 0} onChange={(v) => setCats((p) => ({ ...p, [c.key]: v }))} size={19} />
          </div>
        ))}
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="A sentence or two helps other families (optional)"
        className="w-full text-sm rounded-[var(--radius)] border bg-background p-2 min-h-[70px] font-ui"
        data-testid="review-text"
      />
      <label className="flex items-start gap-2 cursor-pointer">
        <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} className="rounded border-input accent-primary w-4 h-4 mt-0.5" />
        <span className="text-sm text-foreground">
          Hide my name
          <span className="t-helper block">Reviews only ever show your first name and last initial (e.g. "Sarah K."). Check this to show "Verified GoStork Parent" instead.</span>
        </span>
      </label>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {rating > 0 && rating <= 2 ? (
        <div className="space-y-2">
          <p className="text-sm text-foreground">
            Sorry it wasn't a great experience. You can post this publicly, or share it privately with the GoStork team - we'll follow up either way.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={pending} onClick={() => submit("PUBLIC")} data-testid="review-submit-public">
              {pending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
              Post publicly
            </Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => submit("PRIVATE_FEEDBACK")} data-testid="review-submit-private">
              Share privately with GoStork
            </Button>
            {onCancel && <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>}
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={pending || !rating} onClick={() => submit("PUBLIC")} data-testid="review-submit">
            {pending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
            {existing?.rating ? "Update review" : "Submit review"}
          </Button>
          {onCancel && <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>}
        </div>
      )}
    </div>
  );
}

/** Eva's in-chat review ask (parent chat only - providers never see it). */
export function ReviewPromptCard({ messageId, data }: {
  messageId: string;
  data: { providerId: string; providerName?: string | null; memberId?: string | null; stage?: string | null; submitted?: boolean; submittedRating?: number | null; existingRating?: number | null };
}) {
  const [open, setOpen] = useState(false);
  const [startRating, setStartRating] = useState(0);
  const [submitted, setSubmitted] = useState(!!data.submitted);
  const [updating, setUpdating] = useState(false);
  const providerName = data.providerName || "your provider";

  // Reopening a submitted card for an update: pull the saved review so the
  // form comes back pre-filled (same endpoint the profile page uses).
  const existingQuery = useQuery<any>({
    queryKey: ["review-eligibility", data.providerId, data.memberId || "org"],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (data.memberId) params.set("memberId", data.memberId);
      else params.set("providerId", data.providerId);
      const res = await fetch(`/api/reviews/eligibility?${params}`, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: updating,
    staleTime: 10_000,
  });

  if (submitted && updating) {
    const existing = existingQuery.data?.existing;
    if (existingQuery.isLoading) {
      return <div className="t-helper mt-1.5">Loading your review...</div>;
    }
    return (
      <div className="mt-1.5 max-w-md">
        <ReviewForm
          providerId={data.providerId}
          memberId={data.memberId || undefined}
          targetLabel={providerName}
          existing={existing ? { rating: existing.rating, categories: existing.subScores, text: existing.bodyText, anonymous: existing.anonymous } : null}
          onSubmitted={() => setUpdating(false)}
          onCancel={() => setUpdating(false)}
        />
      </div>
    );
  }
  if (submitted) {
    return (
      <div className="mt-1.5 inline-flex items-center gap-2" data-testid={`review-prompt-done-${messageId}`}>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-[hsl(var(--brand-success))]/10 text-[hsl(var(--brand-success))]">
          <Check className="w-3.5 h-3.5" />
          Review submitted{data.submittedRating ? <StarDisplay value={data.submittedRating} size={12} /> : null}
        </span>
        <button
          type="button"
          className="text-xs text-primary underline underline-offset-2 hover:opacity-80"
          onClick={() => setUpdating(true)}
          data-testid={`review-prompt-update-${messageId}`}
        >
          Update review
        </button>
      </div>
    );
  }
  if (!open) {
    return (
      <div className="mt-1.5" data-testid={`review-prompt-${messageId}`}>
        <div className="rounded-[var(--radius)] border bg-secondary/30 px-3 py-2 inline-flex items-center gap-3">
          <span className="text-sm font-medium text-foreground">Rate {providerName}:</span>
          <StarRatingInput
            value={startRating}
            onChange={(v) => { setStartRating(v); setOpen(true); }}
            size={22}
          />
        </div>
      </div>
    );
  }
  return (
    <div className="mt-1.5 max-w-md">
      <ReviewForm
        providerId={data.providerId}
        memberId={data.memberId || undefined}
        targetLabel={providerName}
        initialRating={startRating}
        onSubmitted={() => setSubmitted(true)}
        onCancel={() => { setOpen(false); setStartRating(0); }}
      />
    </div>
  );
}

function reviewDateLabel(r: { createdAt: string; updatedAt: string; stage?: string | null }): string {
  const stageLabel = r.stage === "handed_off" ? "after handoff" : r.stage === "matched" ? "after matching" : r.stage === "consult_completed" ? "after their consultation" : null;
  const d = new Date(r.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return stageLabel ? `Reviewed ${stageLabel} · ${d}` : d;
}

/** Aggregates + published list + self-serve form. Works for orgs (providerId) and doctors (memberId). */
export function ReviewsSection({ providerId, memberId, targetLabel, isParent }: {
  /** Org id; may be omitted for doctors (resolved via eligibility). */
  providerId?: string | null;
  memberId?: string | null;
  targetLabel: string;
  isParent: boolean;
}) {
  const [writing, setWriting] = useState(false);
  const listQuery = useQuery<any>({
    queryKey: ["reviews", providerId || "byMember", memberId || "org"],
    queryFn: async () => {
      const url = memberId ? `/api/reviews/member/${memberId}` : `/api/reviews/provider/${providerId}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load reviews");
      return res.json();
    },
    enabled: !!(providerId || memberId),
    staleTime: 30_000,
  });
  const eligQuery = useQuery<any>({
    queryKey: ["review-eligibility", providerId || "byMember", memberId || "org"],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (memberId) params.set("memberId", memberId);
      else if (providerId) params.set("providerId", providerId);
      const res = await fetch(`/api/reviews/eligibility?${params}`, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: isParent && !!(providerId || memberId),
    staleTime: 30_000,
  });

  const agg = listQuery.data?.aggregates;
  const reviews: any[] = listQuery.data?.reviews || [];
  const canWrite = isParent && eligQuery.data?.eligible;
  const existing = eligQuery.data?.existing || null;
  const resolvedProviderId = providerId || eligQuery.data?.providerId || null;

  return (
    <div className="space-y-4" data-testid="reviews-section">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-3">
          <h3 className="font-display text-base font-semibold">Reviews</h3>
          {agg?.count ? (
            <span className="flex items-center gap-2">
              <StarDisplay value={agg.avg} size={16} />
              <span className="text-sm font-semibold">{agg.avg}</span>
              <span className="t-helper">{agg.count} verified {agg.count === 1 ? "review" : "reviews"}</span>
            </span>
          ) : (
            <span className="t-helper">No reviews yet</span>
          )}
        </div>
        {canWrite && !writing && (
          <Button size="sm" variant="outline" className="text-xs" onClick={() => setWriting(true)} data-testid="btn-write-review">
            {existing ? "Update your review" : "Write a review"}
          </Button>
        )}
      </div>

      {agg?.count > 0 && Object.keys(agg.categoryAverages || {}).length > 0 && (
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          {Object.entries(agg.categoryAverages as Record<string, number>).map(([k, v]) => (
            <span key={k} className="t-helper capitalize">
              {k === "transparency" ? "Transparency & Pricing" : k === "support" ? "Support & Care" : k === "care" ? "Care & Empathy" : k}:{" "}
              <span className="font-medium text-foreground">{v}</span>
            </span>
          ))}
        </div>
      )}

      {writing && resolvedProviderId && (
        <ReviewForm
          providerId={resolvedProviderId}
          memberId={memberId || undefined}
          targetLabel={targetLabel}
          existing={existing ? { rating: existing.rating, categories: existing.subScores, text: existing.bodyText, anonymous: existing.anonymous } : null}
          onSubmitted={() => setWriting(false)}
          onCancel={() => setWriting(false)}
        />
      )}
      {writing && !resolvedProviderId && (
        <p className="t-helper">Loading review form...</p>
      )}

      <div className="space-y-3">
        {reviews.map((r) => (
          <div key={r.id} className="rounded-[var(--radius)] border bg-secondary/20 p-3" data-testid={`review-${r.id}`}>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <StarDisplay value={r.rating} />
                <span className="text-xs font-medium">{r.reviewerLabel}</span>
              </div>
              <span className="t-helper">{reviewDateLabel(r)}</span>
            </div>
            {r.text && <p className="text-sm mt-1.5 whitespace-pre-wrap">{r.text}</p>}
            {r.providerReply && (
              <div className="mt-2 pl-3 border-l-2 border-primary/30">
                <p className="t-helper font-medium">Response from {targetLabel}</p>
                <p className="text-xs mt-0.5 whitespace-pre-wrap">{r.providerReply}</p>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Provider dashboard: own reviews + reply / flag actions. */
export function ProviderReviewsPanel({ brandColor }: { brandColor: string }) {
  const q = useQuery<any[]>({
    queryKey: ["/api/reviews/mine"],
    queryFn: async () => {
      const res = await fetch("/api/reviews/mine", { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    staleTime: 30_000,
  });
  const [replyFor, setReplyFor] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [flagFor, setFlagFor] = useState<string | null>(null);
  const [flagText, setFlagText] = useState("");
  const [pending, setPending] = useState(false);

  const act = async (kind: "reply" | "flag", id: string, text: string) => {
    setPending(true);
    try {
      await apiRequest("POST", `/api/reviews/${id}/${kind}`, kind === "reply" ? { text } : { reason: text });
      queryClient.invalidateQueries({ queryKey: ["/api/reviews/mine"] });
      setReplyFor(null); setFlagFor(null); setReplyText(""); setFlagText("");
    } finally {
      setPending(false);
    }
  };

  if (q.isLoading) return <div className="py-8 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>;
  const reviews = q.data || [];
  if (reviews.length === 0) {
    return <p className="t-helper py-6">No reviews yet. Parents are invited to review after consultations, matches, and handoff - reviews will appear here as they come in.</p>;
  }
  return (
    <div className="space-y-3" data-testid="provider-reviews-panel">
      {reviews.map((r) => (
        <div key={r.id} className="rounded-[var(--radius)] border bg-card p-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <StarDisplay value={r.rating} />
              <span className="text-xs font-medium">{r.reviewerLabel}</span>
              {r.memberName && <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-accent/15 text-[hsl(var(--accent))]">Dr. review: {r.memberName}</span>}
            </div>
            <span className="t-helper">{reviewDateLabel(r)}</span>
          </div>
          {r.text && <p className="text-sm mt-1.5 whitespace-pre-wrap">{r.text}</p>}
          {r.providerReply ? (
            <div className="mt-2 pl-3 border-l-2 border-primary/30">
              <p className="t-helper font-medium">Your response</p>
              <p className="text-xs mt-0.5 whitespace-pre-wrap">{r.providerReply}</p>
              <button type="button" className="t-helper underline mt-1" onClick={() => { setReplyFor(r.id); setReplyText(r.providerReply); }}>Edit response</button>
            </div>
          ) : null}
          {replyFor === r.id ? (
            <div className="mt-2 flex gap-2 items-start">
              <Input value={replyText} onChange={(e) => setReplyText(e.target.value)} placeholder="Write a public response..." className="text-xs h-8" />
              <Button size="sm" className="text-xs h-8" style={{ backgroundColor: brandColor }} disabled={pending || !replyText.trim()} onClick={() => act("reply", r.id, replyText.trim())}>Post</Button>
              <Button size="sm" variant="ghost" className="text-xs h-8" onClick={() => setReplyFor(null)}>Cancel</Button>
            </div>
          ) : flagFor === r.id ? (
            <div className="mt-2 flex gap-2 items-start">
              <Input value={flagText} onChange={(e) => setFlagText(e.target.value)} placeholder="Why should GoStork re-check this review?" className="text-xs h-8" />
              <Button size="sm" className="text-xs h-8" disabled={pending || !flagText.trim()} onClick={() => act("flag", r.id, flagText.trim())}>Send</Button>
              <Button size="sm" variant="ghost" className="text-xs h-8" onClick={() => setFlagFor(null)}>Cancel</Button>
            </div>
          ) : (
            <div className="mt-2 flex gap-3">
              {!r.providerReply && (
                <button type="button" className="t-helper inline-flex items-center gap-1 hover:text-foreground" onClick={() => setReplyFor(r.id)} data-testid={`btn-reply-${r.id}`}>
                  <MessageSquare className="w-3 h-3" /> Respond publicly
                </button>
              )}
              {r.flaggedByProviderAt ? (
                <span className="inline-flex items-center gap-1 text-[11px] text-[hsl(var(--brand-warning))]"><Flag className="w-3 h-3" /> Flagged - GoStork is reviewing</span>
              ) : (
                <button type="button" className="t-helper inline-flex items-center gap-1 hover:text-foreground" onClick={() => setFlagFor(r.id)} data-testid={`btn-flag-${r.id}`}>
                  <Flag className="w-3 h-3" /> Flag for re-check
                </button>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
