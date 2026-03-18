import { useState, useEffect, useRef, useCallback } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useBrandSettings, Matchmaker } from "@/hooks/use-brand-settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { SwipeDeckCard, type TabSection } from "@/components/marketplace/swipe-deck-card";
import {
  mapDatabaseDonorToSwipeProfile,
  mapDatabaseSurrogateToSwipeProfile,
  mapDatabaseSpermDonorToSwipeProfile,
  getDonorTabs,
  getSurrogateTabs,
  buildTitle,
  buildStatusLabel,
  getPhotoList,
} from "@/components/marketplace/swipe-mappers";
import { Loader2, Send, ArrowLeft, Sparkles, Headphones, FileText, Download, Heart, Brain, Stethoscope, MessageCircle, Shield, CalendarCheck, X, ExternalLink } from "lucide-react";

interface MatchCard {
  name: string;
  type: string;
  location?: string;
  photo?: string;
  reasons: string[];
  providerId: string;
  ownerProviderId?: string;
}

interface ConsultationCardData {
  providerId: string;
  providerName: string;
  providerLogo?: string;
  bookingUrl?: string;
  iframeEnabled?: boolean;
  providerEmail?: string;
}

interface ChatMessage {
  id?: string;
  role: "user" | "assistant";
  content: string;
  quickReplies?: string[];
  multiSelect?: boolean;
  matchCards?: MatchCard[];
  prepDoc?: boolean;
  consultationCard?: ConsultationCardData;
  senderType?: string;
  senderName?: string;
}

const CURATION_LINES = [
  "Analyzing your family-building goals...",
  "Matching your criteria with 1,000+ providers...",
  "Finalizing your personalized results...",
];

const PREP_DOC_SECTIONS = [
  { icon: Heart, title: "Personal & Lifestyle", items: ["Family background & motivation", "Daily life & support system", "Work schedule"] },
  { icon: Brain, title: "Values & Boundaries", items: ["Relationship expectations", "Level of involvement during pregnancy"] },
  { icon: Stethoscope, title: "Medical & Pregnancy", items: ["Past pregnancy history", "Embryo transfer preferences", "Openness to twins"] },
  { icon: MessageCircle, title: "Ethical Topics", items: ["Views on termination if medically advised", "Personal/religious considerations"] },
  { icon: Shield, title: "Legal & Communication", items: ["Prior surrogacy experience", "Preferred communication style"] },
];

function CurationOverlay({ brandColor, onComplete }: { brandColor: string; onComplete: () => void }) {
  const [lineIndex, setLineIndex] = useState(0);
  const [displayText, setDisplayText] = useState("");
  const [charIndex, setCharIndex] = useState(0);

  useEffect(() => {
    if (lineIndex >= CURATION_LINES.length) {
      const t = setTimeout(onComplete, 400);
      return () => clearTimeout(t);
    }
    const line = CURATION_LINES[lineIndex];
    if (charIndex < line.length) {
      const t = setTimeout(() => {
        setDisplayText(line.substring(0, charIndex + 1));
        setCharIndex(charIndex + 1);
      }, 30);
      return () => clearTimeout(t);
    } else {
      const t = setTimeout(() => {
        setLineIndex(lineIndex + 1);
        setCharIndex(0);
        setDisplayText("");
      }, 800);
      return () => clearTimeout(t);
    }
  }, [lineIndex, charIndex, onComplete]);

  return (
    <div className="fixed inset-0 bg-background/95 backdrop-blur-sm flex flex-col items-center justify-center z-50" data-testid="curation-overlay">
      <div className="flex flex-col items-center text-center px-8 max-w-md">
        <div className="relative mb-8">
          <div
            className="w-16 h-16 rounded-full animate-spin"
            style={{
              border: `3px solid ${brandColor}20`,
              borderTopColor: brandColor,
            }}
          />
          <Sparkles
            className="w-6 h-6 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
            style={{ color: brandColor }}
          />
        </div>
        <div className="h-8 flex items-center">
          <p
            className="text-lg font-medium"
            style={{ fontFamily: "var(--font-display)", color: brandColor }}
            data-testid="curation-text"
          >
            {displayText}
            <span className="animate-pulse">|</span>
          </p>
        </div>
        <div className="flex gap-2 mt-6">
          {CURATION_LINES.map((_, i) => (
            <div
              key={i}
              className="h-1.5 rounded-full transition-all duration-500"
              style={{
                width: i === lineIndex ? "2rem" : "0.5rem",
                backgroundColor: i <= lineIndex ? brandColor : `${brandColor}30`,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function PrepDocCard({ brandColor }: { brandColor: string }) {
  return (
    <Card
      className="overflow-hidden max-w-sm animate-[slideUp_0.4s_ease-out_forwards]"
      style={{ borderRadius: "var(--container-radius, 0.5rem)" }}
      data-testid="prep-doc-card"
    >
      <div className="p-1.5" style={{ backgroundColor: brandColor }}>
        <div className="flex items-center gap-2 px-3 py-1.5">
          <FileText className="w-4 h-4 text-white" />
          <span className="text-white text-xs font-semibold uppercase tracking-wider">Match Call Prep Guide</span>
        </div>
      </div>
      <div className="p-4 space-y-3">
        <p className="text-sm text-muted-foreground">
          Here are the key topics to discuss during your first surrogate match call:
        </p>
        <div className="space-y-2.5">
          {PREP_DOC_SECTIONS.map((section, i) => (
            <div key={i} className="flex gap-2.5">
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
                style={{ backgroundColor: `${brandColor}15` }}
              >
                <section.icon className="w-3.5 h-3.5" style={{ color: brandColor }} />
              </div>
              <div>
                <p className="text-sm font-medium" style={{ color: brandColor }}>{section.title}</p>
                <ul className="mt-0.5 space-y-0.5">
                  {section.items.map((item, j) => (
                    <li key={j} className="text-xs text-muted-foreground flex items-start gap-1.5">
                      <span className="mt-1 w-1 h-1 rounded-full flex-shrink-0" style={{ backgroundColor: `${brandColor}60` }} />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>
        <div className="pt-2 border-t">
          <a
            href="/surrogacy-match-call-guide.pdf"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-sm font-medium transition-opacity hover:opacity-80"
            style={{ color: brandColor }}
            data-testid="btn-download-prep-doc"
          >
            <Download className="w-4 h-4" />
            Download Full Guide (PDF)
          </a>
        </div>
        <p className="text-xs text-muted-foreground italic">
          Tip: Start warm and personal — this is a relationship-building moment, not just a checklist.
        </p>
      </div>
      <style>{`
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </Card>
  );
}

function ConsultationBookingCard({
  card,
  brandColor,
  onSchedule,
}: {
  card: ConsultationCardData;
  brandColor: string;
  onSchedule: (card: ConsultationCardData) => void;
}) {
  return (
    <Card
      className="overflow-hidden max-w-sm animate-[slideUp_0.4s_ease-out_forwards]"
      style={{ borderRadius: "var(--container-radius, 0.5rem)" }}
      data-testid="consultation-booking-card"
    >
      <div className="p-1.5" style={{ backgroundColor: brandColor }}>
        <div className="flex items-center gap-2 px-3 py-1.5">
          <CalendarCheck className="w-4 h-4 text-white" />
          <span className="text-white text-xs font-semibold uppercase tracking-wider">Book a Consultation</span>
        </div>
      </div>
      <div className="p-4">
        <div className="flex items-center gap-3 mb-3">
          {card.providerLogo ? (
            <img
              src={card.providerLogo.startsWith("/") ? card.providerLogo : `/api/uploads/proxy?url=${encodeURIComponent(card.providerLogo)}`}
              alt={card.providerName}
              className="w-12 h-12 rounded-full object-cover border-2"
              style={{ borderColor: `${brandColor}30` }}
            />
          ) : (
            <div
              className="w-12 h-12 rounded-full flex items-center justify-center text-white text-lg font-bold"
              style={{ backgroundColor: brandColor }}
            >
              {card.providerName.charAt(0)}
            </div>
          )}
          <div>
            <p className="font-semibold text-sm">{card.providerName}</p>
            <p className="text-xs text-muted-foreground">Ready to connect</p>
          </div>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Take the next step in your journey. Schedule a consultation to discuss your options directly with {card.providerName}.
        </p>
        <Button
          className="w-full gap-2 text-white"
          style={{ backgroundColor: brandColor, borderRadius: "var(--radius, 0.5rem)" }}
          onClick={() => onSchedule(card)}
          data-testid="btn-schedule-consultation"
        >
          <CalendarCheck className="w-4 h-4" />
          Schedule Consultation
        </Button>
      </div>
    </Card>
  );
}

function BookingOverlay({
  card,
  brandColor,
  userEmail,
  userName,
  onClose,
}: {
  card: ConsultationCardData;
  brandColor: string;
  userEmail: string;
  userName: string;
  onClose: () => void;
}) {
  const [callbackName, setCallbackName] = useState(userName);
  const [callbackEmail, setCallbackEmail] = useState(userEmail);
  const [callbackMessage, setCallbackMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const hasBookingUrl = !!card.bookingUrl;
  const useIframe = hasBookingUrl && card.iframeEnabled;

  const [error, setError] = useState("");

  async function handleCallbackSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/consultation/request-callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          providerId: card.providerId,
          providerName: card.providerName,
          name: callbackName,
          email: callbackEmail,
          message: callbackMessage,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ message: "Request failed" }));
        setError(data.message || "Something went wrong. Please try again.");
        return;
      }
      setSubmitted(true);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background" data-testid="booking-overlay">
      <div
        className="flex items-center justify-between px-4 py-3 border-b"
        style={{ backgroundColor: `${brandColor}08` }}
      >
        <div className="flex items-center gap-2">
          <CalendarCheck className="w-5 h-5" style={{ color: brandColor }} />
          <span className="font-semibold text-sm">
            {useIframe ? `Book with ${card.providerName}` : `Request Callback — ${card.providerName}`}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          data-testid="btn-close-booking"
        >
          <X className="w-5 h-5" />
        </Button>
      </div>
      <div className="flex-1 overflow-auto">
        {useIframe ? (
          <iframe
            src={card.bookingUrl!}
            className="w-full h-full border-0"
            title={`Book consultation with ${card.providerName}`}
            allow="payment"
            data-testid="booking-iframe"
          />
        ) : hasBookingUrl && !card.iframeEnabled ? (
          <div className="flex flex-col items-center justify-center h-full p-6 text-center gap-4">
            <CalendarCheck className="w-12 h-12" style={{ color: brandColor }} />
            <h3 className="text-lg font-semibold">Schedule with {card.providerName}</h3>
            <p className="text-sm text-muted-foreground max-w-md">
              Click below to open the scheduling page in a new tab and book your consultation.
            </p>
            <a
              href={card.bookingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-6 py-3 text-white text-sm font-medium transition-opacity hover:opacity-90"
              style={{ backgroundColor: brandColor, borderRadius: "var(--radius, 0.5rem)" }}
              data-testid="link-external-booking"
            >
              <ExternalLink className="w-4 h-4" />
              Open Scheduling Page
            </a>
            <Button variant="outline" onClick={onClose} className="mt-2" data-testid="btn-back-to-chat">
              Back to Chat
            </Button>
          </div>
        ) : submitted ? (
          <div className="flex flex-col items-center justify-center h-full p-6 text-center gap-4">
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center"
              style={{ backgroundColor: `${brandColor}15` }}
            >
              <CalendarCheck className="w-8 h-8" style={{ color: brandColor }} />
            </div>
            <h3 className="text-lg font-semibold">Request Sent!</h3>
            <p className="text-sm text-muted-foreground max-w-md">
              We've sent your consultation request to {card.providerName}. They'll reach out to you shortly.
            </p>
            <Button
              onClick={onClose}
              style={{ backgroundColor: brandColor, borderRadius: "var(--radius, 0.5rem)" }}
              className="text-white mt-2"
              data-testid="btn-back-to-chat-after-submit"
            >
              Back to Chat
            </Button>
          </div>
        ) : (
          <div className="max-w-md mx-auto p-6 space-y-4">
            <h3 className="text-lg font-semibold">Request a Callback</h3>
            <p className="text-sm text-muted-foreground">
              {card.providerName} doesn't have online booking set up yet. Fill out this form and they'll reach out to schedule your consultation.
            </p>
            <form onSubmit={handleCallbackSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label>Your Name</Label>
                <Input
                  value={callbackName}
                  onChange={e => setCallbackName(e.target.value)}
                  required
                  data-testid="input-callback-name"
                />
              </div>
              <div className="space-y-2">
                <Label>Email</Label>
                <Input
                  type="email"
                  value={callbackEmail}
                  onChange={e => setCallbackEmail(e.target.value)}
                  required
                  data-testid="input-callback-email"
                />
              </div>
              <div className="space-y-2">
                <Label>Message (optional)</Label>
                <Textarea
                  value={callbackMessage}
                  onChange={e => setCallbackMessage(e.target.value)}
                  placeholder="Tell them a bit about what you're looking for..."
                  rows={3}
                  data-testid="input-callback-message"
                />
              </div>
              <Button
                type="submit"
                className="w-full text-white gap-2"
                style={{ backgroundColor: brandColor, borderRadius: "var(--radius, 0.5rem)" }}
                disabled={submitting}
                data-testid="btn-submit-callback"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                {submitting ? "Sending..." : "Request Callback"}
              </Button>
              {error && (
                <p className="text-sm text-destructive text-center" data-testid="callback-error">{error}</p>
              )}
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

function getProfileUrlSlug(type: string): string {
  const t = type.toLowerCase();
  if (t === "surrogate") return "surrogate";
  if (t === "egg donor") return "eggdonor";
  if (t === "sperm donor") return "spermdonor";
  return "surrogate";
}

function getProfileEndpoint(type: string): string {
  const t = type.toLowerCase();
  if (t === "surrogate") return "surrogates";
  if (t === "egg donor") return "egg-donors";
  if (t === "sperm donor") return "sperm-donors";
  return "surrogates";
}

function buildMatchTabs(profile: any, cardType: string, reasons: string[]): TabSection[] {
  const t = cardType.toLowerCase();
  const isSurrogate = t === "surrogate";

  const swipeProfile = isSurrogate
    ? mapDatabaseSurrogateToSwipeProfile(profile)
    : t === "sperm donor"
      ? mapDatabaseSpermDonorToSwipeProfile(profile)
      : mapDatabaseDonorToSwipeProfile(profile);

  const baseTabs = isSurrogate
    ? getSurrogateTabs(swipeProfile, [])
    : getDonorTabs(swipeProfile, []);

  if (reasons.length > 0) {
    const matchTab: TabSection = {
      layoutType: "matched_bubbles",
      title: `Matched ${reasons.length} Preference${reasons.length !== 1 ? "s" : ""}`,
      items: reasons.map(r => ({ label: r, value: "" })),
    };
    return [matchTab, ...baseTabs];
  }

  return baseTabs;
}

function MatchCardComponent({ card, brandColor, onAction, onViewProfile }: { card: MatchCard; brandColor: string; onAction: (text: string) => void; onViewProfile: (card: MatchCard) => void }) {
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchProfile = async () => {
      if (!card.ownerProviderId) { setLoading(false); return; }
      try {
        const endpoint = getProfileEndpoint(card.type);
        const res = await fetch(`/api/providers/${card.ownerProviderId}/${endpoint}/${card.providerId}`, { credentials: "include" });
        if (res.ok) setProfile(await res.json());
      } catch {}
      setLoading(false);
    };
    fetchProfile();
  }, [card.ownerProviderId, card.providerId, card.type]);

  if (loading) {
    return (
      <div className="w-full max-w-sm aspect-[3/4] rounded-[var(--container-radius)] overflow-hidden bg-muted animate-pulse flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (profile) {
    const t = card.type.toLowerCase();
    const swipeProfile = t === "surrogate"
      ? mapDatabaseSurrogateToSwipeProfile(profile)
      : t === "sperm donor"
        ? mapDatabaseSpermDonorToSwipeProfile(profile)
        : mapDatabaseDonorToSwipeProfile(profile);
    const photos = getPhotoList(swipeProfile);
    const title = buildTitle(swipeProfile);
    const statusLabel = buildStatusLabel(swipeProfile);
    const tabs = buildMatchTabs(profile, card.type, card.reasons);

    return (
      <div
        className="w-full max-w-sm aspect-[3/4] animate-[slideUp_0.4s_ease-out_forwards]"
        data-testid={`match-card-${card.providerId}`}
      >
        <SwipeDeckCard
          id={card.providerId}
          photos={photos}
          title={title}
          statusLabel={statusLabel}
          isExperienced={swipeProfile.isExperienced}
          isPremium={swipeProfile.isPremium}
          tabs={tabs}
          disableSwipe
          chatMode
          onPass={() => onAction(`I'm not interested in ${card.name || title}. Show me another option.`)}
          onSave={() => onAction(`I like ${card.name || title}! Save as favorite. ❤️`)}
          onViewFullProfile={() => onViewProfile(card)}
        />
      </div>
    );
  }

  return (
    <div
      className="w-full max-w-sm aspect-[3/4] rounded-[var(--container-radius)] overflow-hidden bg-muted cursor-pointer relative"
      data-testid={`match-card-${card.providerId}`}
      onClick={() => onViewProfile(card)}
    >
      {card.photo && (
        <img src={card.photo} alt={card.name} className="w-full h-full object-cover" />
      )}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent pt-24 pb-6 px-4">
        <h3 className="text-white font-heading text-xl leading-tight">{card.name}</h3>
        {card.location && (
          <p className="text-white/70 text-sm mt-1">{card.location}</p>
        )}
      </div>
    </div>
  );
}

export default function ConciergeChatPage() {
  const [searchParams] = useSearchParams();
  const matchmakerId = searchParams.get("matchmaker");
  const existingSessionId = searchParams.get("session");
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data: brand } = useBrandSettings();
  const queryClient = useQueryClient();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [multiSelectChoices, setMultiSelectChoices] = useState<Set<string>>(new Set());
  const [sessionId, setSessionId] = useState<string | null>(existingSessionId);
  const [showCuration, setShowCuration] = useState(false);
  const [pendingCurationMessage, setPendingCurationMessage] = useState<ChatMessage | null>(null);
  const [humanEscalated, setHumanEscalated] = useState(false);
  const [bookingCard, setBookingCard] = useState<ConsultationCardData | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [greetingSet, setGreetingSet] = useState(false);
  const [providerInChat, setProviderInChat] = useState(false);
  const handleViewProfile = useCallback((card: MatchCard) => {
    if (!card.ownerProviderId) return;
    const slug = getProfileUrlSlug(card.type);
    const profileUrl = `/${slug}/${card.ownerProviderId}/${card.providerId}`;
    navigate(profileUrl, {
      state: {
        fromChat: true,
        matchReasons: card.reasons || [],
        chatPath: window.location.pathname + window.location.search,
      },
    });
  }, [navigate]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false);
  const lastPollTimeRef = useRef<string | null>(null);

  const matchmakers: Matchmaker[] = brand?.matchmakers || [];
  const [resolvedMatchmakerId, setResolvedMatchmakerId] = useState<string | null>(null);
  const effectiveMatchmakerId = matchmakerId || resolvedMatchmakerId;
  const selectedMatchmaker = matchmakers.find((m) => m.id === effectiveMatchmakerId);
  const brandColor = brand?.primaryColor || "#004D4D";

  const loadMessagesForSession = async (sid: string) => {
    try {
      const res = await fetch(`/api/ai-concierge/session/${sid}/messages`, { credentials: "include" });
      if (!res.ok) return;
      const msgs = await res.json();
      if (msgs.length > 0) {
        const parsed: ChatMessage[] = msgs.map((m: any) => {
          const extras = m.uiCardData || {};
          return {
            id: m.id,
            role: m.role as "user" | "assistant",
            content: m.content,
            senderType: m.senderType,
            senderName: m.senderName,
            matchCards: extras.matchCards,
            prepDoc: extras.prepDoc,
            consultationCard: extras.consultationCard,
          };
        });
        setMessages(parsed);
        setGreetingSet(true);
        lastPollTimeRef.current = msgs[msgs.length - 1].createdAt;
        if (msgs.some((m: any) => m.senderType === "human")) setHumanEscalated(true);
        if (msgs.some((m: any) => m.senderType === "provider")) setProviderInChat(true);
      }
    } catch {}
  };

  useEffect(() => {
    if (sessionLoaded) return;

    if (existingSessionId) {
      (async () => {
        await loadMessagesForSession(existingSessionId);
        setSessionLoaded(true);
      })();
      return;
    }

    (async () => {
      try {
        const sessRes = await fetch("/api/my/chat-sessions", { credentials: "include" });
        if (sessRes.ok) {
          const sessions = await sessRes.json();
          const conciergeSession = sessions[0];
          if (conciergeSession) {
            setSessionId(conciergeSession.id);
            if (matchmakerId && conciergeSession.matchmakerId !== matchmakerId) {
              await fetch("/api/my/chat-session/matchmaker", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ matchmakerId }),
              });
              setResolvedMatchmakerId(matchmakerId);
            } else if (conciergeSession.matchmakerId) {
              setResolvedMatchmakerId(conciergeSession.matchmakerId);
            }
            await loadMessagesForSession(conciergeSession.id);
          }
        }
      } catch {}
      setSessionLoaded(true);
    })();
  }, [existingSessionId, matchmakerId, sessionLoaded]);

  useEffect(() => {
    window.scrollTo(0, document.body.scrollHeight);
  }, []);

  const parentProfileQuery = useQuery<{ interestedServices?: string[] }>({
    queryKey: ["/api/parent-profile"],
    queryFn: async () => {
      const res = await fetch("/api/parent-profile", { credentials: "include" });
      if (!res.ok) return {};
      return res.json();
    },
    enabled: !!user,
  });

  const initialScrollDone = useRef(false);
  useEffect(() => {
    if (!messages.length) return;
    if (!initialScrollDone.current) {
      const scrollToBottom = () => messagesEndRef.current?.scrollIntoView({ behavior: "instant" as ScrollBehavior });
      scrollToBottom();
      const t1 = setTimeout(scrollToBottom, 100);
      const t2 = setTimeout(scrollToBottom, 300);
      const t3 = setTimeout(() => {
        scrollToBottom();
        initialScrollDone.current = true;
      }, 600);
      return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
    } else {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  useEffect(() => {
    if ((!humanEscalated && !providerInChat) || !sessionId) return;
    const interval = setInterval(async () => {
      try {
        const afterParam = lastPollTimeRef.current ? `?after=${encodeURIComponent(lastPollTimeRef.current)}` : "";
        const res = await fetch(`/api/ai-concierge/session/${sessionId}/messages${afterParam}`, { credentials: "include" });
        if (!res.ok) return;
        const newMsgs = await res.json();
        const externalMsgs = newMsgs.filter((m: any) => m.senderType === "human" || m.senderType === "provider" || m.senderType === "system");
        if (externalMsgs.length > 0) {
          setMessages((prev) => [
            ...prev,
            ...externalMsgs.map((m: any) => ({
              role: "assistant" as const,
              content: m.content,
              senderType: m.senderType as string,
              senderName: m.senderName || (m.senderType === "human" ? "GoStork Expert" : m.senderType === "provider" ? m.senderName : "Eva"),
            })),
          ]);
          lastPollTimeRef.current = externalMsgs[externalMsgs.length - 1].createdAt;
          if (externalMsgs.some((m: any) => m.senderType === "provider" || m.senderType === "system")) {
            setProviderInChat(true);
          }
        }
      } catch {}
    }, 3000);
    return () => clearInterval(interval);
  }, [humanEscalated, providerInChat, sessionId]);

  const profileReady = !parentProfileQuery.isLoading;

  useEffect(() => {
    if (greetingSet || !selectedMatchmaker || !user || !profileReady) return;
    if (!sessionLoaded) return;
    if (sessionId || existingSessionId) return;
    let greeting = selectedMatchmaker.initialGreeting
      || `Hi there! I'm ${selectedMatchmaker.name}, ${selectedMatchmaker.title.toLowerCase()}. ${selectedMatchmaker.description} How can I help you on your fertility journey today?`;
    const u = user as any;
    const firstName = u.firstName || u.name?.split(" ")[0] || "there";
    const city = u.city || "";
    const state = u.state || "";
    const location = city && state ? `${city}, ${state}` : city || state || "your area";
    const services = parentProfileQuery.data?.interestedServices || [];
    const service = services.length ? services.join(" and ") : "fertility services";
    greeting = greeting
      .replace(/\[First Name\]/gi, firstName)
      .replace(/\[Service\]/gi, service)
      .replace(/\[Location\]/gi, location);
    setMessages([{ role: "assistant", content: greeting }]);
    setGreetingSet(true);

    (async () => {
      try {
        const res = await fetch("/api/ai-concierge/init-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ matchmakerId: effectiveMatchmakerId, greeting }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.sessionId) setSessionId(data.sessionId);
        }
      } catch {}
    })();
  }, [selectedMatchmaker, user, profileReady, greetingSet, parentProfileQuery.data, sessionLoaded, sessionId, existingSessionId]);

  if (!effectiveMatchmakerId && !existingSessionId && !sessionId && sessionLoaded) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] px-4 text-center" data-testid="concierge-no-matchmaker">
        <Sparkles className="w-12 h-12 text-muted-foreground mb-4" />
        <h2 className="font-display text-xl font-semibold mb-2">No Matchmaker Selected</h2>
        <p className="text-muted-foreground text-sm mb-4">
          Please choose an AI guide to start your concierge experience.
        </p>
        <Button onClick={() => navigate("/account/concierge")} data-testid="btn-go-select-matchmaker">
          Choose a Concierge
        </Button>
      </div>
    );
  }

  const sendMessage = async (text: string) => {
    if (!text.trim() || sending || sendingRef.current || showCuration) return;
    sendingRef.current = true;
    const userMessage = text.trim();
    setInput("");
    setMessages((prev) => {
      const updated = prev.map((m, i) =>
        i === prev.length - 1 && m.quickReplies ? { ...m, quickReplies: undefined } : m
      );
      return [...updated, { role: "user" as const, content: userMessage }];
    });
    setSending(true);

    try {
      const res = await fetch("/api/ai-concierge/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          message: userMessage,
          sessionId,
          matchmakerId: effectiveMatchmakerId,
        }),
      });

      if (!res.ok) throw new Error("Chat request failed");
      const data = await res.json();
      if (data.sessionId && data.sessionId !== sessionId) {
        setSessionId(data.sessionId);
        queryClient.invalidateQueries({ queryKey: ["/api/my/chat-sessions"] });
      }

      if (data.skipAiResponse) {
        setSending(false);
        sendingRef.current = false;
        return;
      }

      if (data.humanNeeded) {
        setHumanEscalated(true);
      }
      if (data.consultationCard) {
        setProviderInChat(true);
      }

      const newMessage: ChatMessage = {
        role: "assistant",
        content: data.message.content,
        id: data.message.id,
        quickReplies: data.quickReplies,
        multiSelect: data.multiSelect,
        matchCards: data.matchCards,
        prepDoc: data.prepDoc,
        consultationCard: data.consultationCard,
        senderType: data.message.senderType,
        senderName: data.message.senderName,
      };

      if (data.showCuration) {
        setMessages((prev) => [...prev, newMessage]);
        setPendingCurationMessage(newMessage);
        setTimeout(() => setShowCuration(true), 2000);
      } else {
        setMessages((prev) => [...prev, newMessage]);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "I'm sorry, I'm having trouble connecting right now. Please try again." },
      ]);
    } finally {
      setSending(false);
      sendingRef.current = false;
    }
  };

  const handleSend = () => sendMessage(input);

  const handleQuickReply = (text: string) => {
    sendMessage(text);
  };

  const handleTalkToTeam = () => {
    sendMessage("I'd like to talk to a real person on the GoStork team");
  };

  const handleCurationComplete = useCallback(() => {
    setShowCuration(false);
    if (pendingCurationMessage) {
      setPendingCurationMessage(null);
      sendMessage("ready");
    }
  }, [pendingCurationMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <>
      {showCuration && (
        <CurationOverlay brandColor={brandColor} onComplete={handleCurationComplete} />
      )}
      <div className="flex flex-col h-dvh max-w-3xl mx-auto overflow-hidden" data-testid="concierge-chat-page">
        <div
          className="flex items-center gap-3 px-4 py-3 border-b"
          data-testid="concierge-chat-header"
        >
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={() => navigate("/chat")}
            data-testid="btn-back-to-chats"
          >
            <ArrowLeft className="w-4 h-4" />
          </Button>
          {selectedMatchmaker?.avatarUrl ? (
            <img
              src={selectedMatchmaker.avatarUrl}
              alt={selectedMatchmaker.name}
              className="w-9 h-9 rounded-full object-cover border"
            />
          ) : (
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-bold"
              style={{ backgroundColor: brandColor }}
            >
              {selectedMatchmaker?.name.charAt(0) || "?"}
            </div>
          )}
          <div className="flex-1">
            <h2 className="text-sm font-ui" style={{ fontWeight: 600 }}>
              {selectedMatchmaker?.name || "AI Concierge"}
            </h2>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="text-xs gap-1.5 h-8"
            style={{ borderColor: `${brandColor}30`, color: brandColor, borderRadius: "999px" }}
            onClick={handleTalkToTeam}
            disabled={sending || humanEscalated}
            data-testid="btn-talk-to-team"
          >
            <Headphones className="w-3.5 h-3.5" />
            {humanEscalated ? "Team Notified" : "Talk to GoStork Team"}
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4" data-testid="concierge-messages">
          {messages.map((msg, i) => (
            <div key={i}>
              {msg.role === "assistant" && msg.senderType === "human" && (
                <div className="flex items-center gap-1.5 mb-1 ml-1">
                  <div
                    className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full text-white"
                    style={{ backgroundColor: brandColor }}
                    data-testid={`badge-expert-${i}`}
                  >
                    GoStork Expert
                  </div>
                  {msg.senderName && (
                    <span className="text-[11px] text-muted-foreground">{msg.senderName}</span>
                  )}
                </div>
              )}
              {msg.role === "assistant" && msg.senderType === "provider" && (
                <div className="flex items-center gap-1.5 mb-1 ml-1">
                  <div
                    className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full text-white bg-[hsl(var(--brand-success))]"
                    data-testid={`badge-provider-${i}`}
                  >
                    {msg.senderName || "Agency Expert"}
                  </div>
                </div>
              )}
              {msg.role === "assistant" && msg.senderType === "system" && (
                <div className="flex items-center gap-1.5 mb-1 ml-1">
                  <div className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-[hsl(var(--accent))] text-white" data-testid={`badge-system-${i}`}>
                    {selectedMatchmaker?.name || "Eva"}
                  </div>
                </div>
              )}
              <div
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                data-testid={`chat-message-${msg.role}-${i}`}
              >
                <div
                  className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-base leading-relaxed font-ui ${
                    msg.role === "user"
                      ? "text-white"
                      : msg.senderType === "human"
                      ? "text-foreground border-2"
                      : msg.senderType === "provider"
                      ? "text-foreground border-2 border-emerald-300"
                      : "text-foreground"
                  }`}
                  style={
                    msg.role === "user"
                      ? {
                          backgroundColor: brandColor,
                          borderRadius: "var(--radius, 0.5rem)",
                        }
                      : msg.senderType === "human"
                      ? {
                          borderRadius: "var(--radius, 0.5rem)",
                          borderColor: brandColor,
                          backgroundColor: `${brandColor}08`,
                        }
                      : msg.senderType === "provider"
                      ? {
                          borderRadius: "var(--radius, 0.5rem)",
                          backgroundColor: "#ecfdf508",
                        }
                      : {
                          borderRadius: "var(--radius, 0.5rem)",
                          backgroundColor: `${brandColor}15`,
                        }
                  }
                >
                  {msg.content}
                </div>
              </div>

              {msg.prepDoc && (
                <div className="flex justify-start mt-3 ml-0">
                  <PrepDocCard brandColor={brandColor} />
                </div>
              )}

              {msg.matchCards && msg.matchCards.length > 0 && (
                <div className="flex justify-start mt-3 ml-0">
                  <div className="space-y-3">
                    {msg.matchCards.map((card, ci) => (
                      <MatchCardComponent
                        key={ci}
                        card={card}
                        brandColor={brandColor}
                        onAction={handleQuickReply}
                        onViewProfile={handleViewProfile}
                      />
                    ))}
                  </div>
                </div>
              )}

              {msg.consultationCard && (
                <div className="flex justify-start mt-3 ml-0">
                  <ConsultationBookingCard
                    card={msg.consultationCard}
                    brandColor={brandColor}
                    onSchedule={(c) => setBookingCard(c)}
                  />
                </div>
              )}

              {msg.quickReplies && msg.quickReplies.length > 0 && i === messages.length - 1 && (
                <div className="flex flex-wrap gap-2 mt-2 ml-0" data-testid="quick-replies">
                  {msg.quickReplies.map((qr, qi) => {
                    const isMulti = msg.multiSelect;
                    const isSelected = isMulti && multiSelectChoices.has(qr);
                    return (
                      <Button
                        key={qi}
                        variant="outline"
                        size="sm"
                        className="text-sm transition-all hover:shadow-sm"
                        style={{
                          borderRadius: "999px",
                          borderColor: isSelected ? brandColor : `${brandColor}40`,
                          backgroundColor: isSelected ? `${brandColor}15` : "transparent",
                          color: brandColor,
                        }}
                        onClick={() => {
                          if (isMulti) {
                            setMultiSelectChoices((prev) => {
                              const next = new Set(prev);
                              if (next.has(qr)) {
                                next.delete(qr);
                              } else {
                                next.add(qr);
                              }
                              return next;
                            });
                          } else {
                            handleQuickReply(qr);
                          }
                        }}
                        disabled={sending}
                        data-testid={`quick-reply-${qi}`}
                      >
                        {isSelected && <span className="mr-1">✓</span>}
                        {qr}
                      </Button>
                    );
                  })}
                  {msg.multiSelect && multiSelectChoices.size > 0 && (
                    <Button
                      size="sm"
                      className="text-sm font-medium"
                      style={{
                        borderRadius: "999px",
                        backgroundColor: brandColor,
                        color: "white",
                      }}
                      onClick={() => {
                        const selected = Array.from(multiSelectChoices).join(", ");
                        setMultiSelectChoices(new Set());
                        handleQuickReply(selected);
                      }}
                      disabled={sending}
                      data-testid="multi-select-done"
                    >
                      Done
                    </Button>
                  )}
                </div>
              )}
            </div>
          ))}
          {sending && (
            <div className="flex items-center gap-2 justify-start py-1" data-testid="chat-typing-indicator">
              <div className="flex items-center gap-1">
                <div className="w-1.5 h-1.5 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                <div className="w-1.5 h-1.5 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                <div className="w-1.5 h-1.5 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
              <span className="text-xs text-muted-foreground">{selectedMatchmaker?.name || "AI Concierge"} is typing</span>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="border-t px-4 py-3" data-testid="concierge-input-area">
          <div className="flex gap-2">
            <Input
              placeholder={`Message ${selectedMatchmaker?.name || "AI Concierge"}...`}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={sending}
              className="flex-1 !text-base font-ui"
              data-testid="input-concierge-message"
            />
            <Button
              size="sm"
              onClick={handleSend}
              disabled={!input.trim() || sending}
              className="h-10 w-10 p-0"
              style={{ borderRadius: "var(--radius, 0.5rem)" }}
              data-testid="btn-send-message"
            >
              {sending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </Button>
          </div>
        </div>
      </div>
      {bookingCard && (
        <BookingOverlay
          card={bookingCard}
          brandColor={brandColor}
          userEmail={(user as any)?.email || ""}
          userName={(user as any)?.name || ""}
          onClose={() => setBookingCard(null)}
        />
      )}
    </>
  );
}
