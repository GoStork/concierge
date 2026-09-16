import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { useBrandSettings, Matchmaker } from "@/hooks/use-brand-settings";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { api } from "@shared/routes";
import { ChevronLeft, Loader2, Lock, Check, Eye, EyeOff, AlertCircle, UserRound, Sparkles, DollarSign, CalendarCheck, Stethoscope, Heart, Baby, FlaskConical, Search } from "lucide-react";
import { getPhotoSrc } from "@/lib/profile-utils";
import { AiIntroScreen } from "@/components/onboarding/ai-intro-screen";
import LocationAutocomplete from "@/components/location-autocomplete";
import { PhoneInput } from "@/components/ui/phone-input";
import { SmsTransactionalNotice, SmsNotificationsOptIn } from "@/components/ui/sms-consent-disclosure";
import { TurnstileWidget } from "@/components/ui/turnstile-widget";
import { Button } from "@/components/ui/button";
import { countryNameToIsoCode } from "@/lib/country-flag";

// After account creation the wizard shows "creating your account" and then
// the meet-your-concierge screen WITHOUT changing route. Both are component
// state, and logging in mid-wizard has remounted this page before (state
// gone, the URL's account step clamped back to the code step for a flash,
// the intro skipped). The phase therefore lives in sessionStorage with a
// tiny subscriber list: a remounted instance boots straight into the right
// screen, and the in-flight submit handler still reaches whichever instance
// is mounted.
type WizardPhase = "loading" | "intro" | null;
const PHASE_KEY = "gostork:onboarding-phase:v1";
const phaseListeners = new Set<(p: WizardPhase) => void>();
function readPhase(): WizardPhase {
  try {
    const v = sessionStorage.getItem(PHASE_KEY);
    return v === "loading" || v === "intro" ? v : null;
  } catch { return null; }
}
function setPhase(p: WizardPhase) {
  try { if (p) sessionStorage.setItem(PHASE_KEY, p); else sessionStorage.removeItem(PHASE_KEY); } catch { /* noop */ }
  phaseListeners.forEach((fn) => fn(p));
}

const TOTAL_STEPS_AUTHENTICATED = 5;
const TOTAL_STEPS_UNAUTHENTICATED = 6;
const ACCOUNT_STEP = 6;
const WELCOME_STEP = 0;

const GOALS = ["Fertility Clinic", "Egg Donor", "Surrogate", "Sperm Donor"];

/**
 * Draft persistence. Step 5 is exactly when the parent leaves this tab to read
 * the SMS code, and iOS Safari evicts background tabs, so a reload must not
 * dump them back to the welcome screen. The step lives in ?step= (browser Back
 * walks the wizard, reload keeps the place) and the answers live in
 * sessionStorage for the life of the tab. Password, confirm and the code are
 * never written; they are the secrets the draft exists to protect.
 */
const DRAFT_KEY = "gostork:onboarding-draft:v1";
type DraftData = Omit<OnboardingData, "password" | "confirmPassword" | "otp">;

function readDraft(): Partial<DraftData> | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeDraft(data: OnboardingData) {
  try {
    const { password: _p, confirmPassword: _c, otp: _o, ...draft } = data;
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // storage unavailable (private mode quota) - the URL step still survives
  }
}

function clearDraft() {
  try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* noop */ }
}

/**
 * Steps are named in the URL (?step=phone), not numbered: a name survives
 * reordering, reads in analytics and support screenshots, and the numbering
 * already differs between new visitors (6 steps) and returning ones (5).
 * Names are not secrets - the screens are in the bundle - and the clamp
 * below decides what may be shown, so a URL is a bookmark, never a permission.
 * Never put an answer (phone, code, email, name) in the URL: it would land
 * in history, referrers, analytics and logs.
 */
const STEP_SLUGS: Record<number, string> = {
  1: "goals",
  2: "name",
  3: "location",
  4: "phone",
  5: "code",
  [ACCOUNT_STEP]: "account",
};
const SLUG_TO_STEP: Record<string, number> = Object.fromEntries(
  Object.entries(STEP_SLUGS).map(([n, slug]) => [slug, Number(n)]),
);

function parseStepParam(raw: string | null): number | null {
  if (raw === null) return null;
  const slug = raw.trim().toLowerCase();
  if (slug in SLUG_TO_STEP) return SLUG_TO_STEP[slug];
  // Legacy numeric links (?step=4) shared before steps were named.
  const n = Number(slug);
  return Number.isInteger(n) && n > WELCOME_STEP && n <= ACCOUNT_STEP ? n : null;
}

function mapOtpSendError(code: string): string {
  switch (code) {
    case "phone_invalid":
      return "This phone number is invalid. Please check and try again.";
    case "phone_voip":
      return "VoIP numbers are not supported. Please enter a mobile phone number.";
    case "phone_landline":
      return "Landline numbers can't receive verification codes. Please use a mobile phone.";
    case "phone_unreachable":
      return "This number appears to be unreachable. Please check and try again.";
    case "verify_failed":
      return "Failed to send verification code. Please try again in a moment.";
    case "turnstile_failed":
      return "We couldn't confirm you're human. Please wait a moment and try again.";
    case "rate_limited":
      return "We've sent this number a few codes recently. Please wait about an hour and try again, or use a different mobile number.";
    case "country_blocked":
      return "We can't text codes to numbers in this country yet. Please use a mobile number from a supported country.";
    default:
      // Never surface a raw server code (observed live: "rate_limited" in red).
      return /^[a-z_]+$/.test(code || "") ? "We couldn't send the code just now. Please try again in a moment." : (code || "Please check your number and try again.");
  }
}

interface OnboardingData {
  email: string;
  password: string;
  confirmPassword: string;
  goals: string[];
  firstName: string;
  lastName: string;
  city: string;
  state: string;
  country: string;
  phoneE164: string;
  phoneDisplay: string;
  phoneIsoCode: string;
  phoneIsValid: boolean;
  smsOptIn: boolean;
  otp: string[];
}

function PillButton({
  label,
  selected,
  onClick,
  multiSelect,
  "data-testid": testId,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
  multiSelect?: boolean;
  "data-testid"?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      data-testid={testId}
      className={`hover-elevate active-elevate-2 w-full py-4 px-6 rounded-full text-lg font-medium border flex items-center justify-between focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
        selected
          ? "bg-primary text-primary-foreground border-primary shadow-md"
          : "bg-card text-foreground border-border hover:border-primary/50"
      }`}
    >
      <span className="flex-1 text-center">{label}</span>
      {selected && (
        <Check className="w-5 h-5 flex-shrink-0 ml-2" />
      )}
    </button>
  );
}

function OtpInput({
  value,
  onChange,
}: {
  value: string[];
  onChange: (val: string[]) => void;
}) {
  const joined = value.join("");

  const handleChange = (raw: string) => {
    const digits = raw.replace(/\D/g, "").slice(0, 6);
    const next = Array.from({ length: 6 }, (_, i) => digits[i] || "");
    onChange(next);
  };

  return (
    <div className="flex justify-center">
      <input
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={joined}
        onChange={e => handleChange(e.target.value)}
        placeholder="000000"
        data-testid="input-otp"
        className="w-full max-w-[240px] text-center text-3xl font-semibold tracking-[0.5em] border-b-2 border-border focus:border-primary outline-none pb-3 bg-transparent placeholder:text-muted-foreground/20 transition-colors"
        autoFocus
      />
    </div>
  );
}

export default function OnboardingPage() {
  const { user, isLoading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { data: brand } = useBrandSettings();
  const isRegistration = !user;
  // An invited family member (Intended Parent 2 / Viewer). Their family already
  // answered goals, name and location; the only thing they owe is their own
  // phone verification, so the wizard is two steps for them: phone, code.
  const memberRole = (user as any)?.parentAccountRole as string | null | undefined;
  const isInvitedMember = !!user && !!memberRole && memberRole !== "INTENDED_PARENT_1";
  const FIRST_MEMBER_STEP = 4;
  const [searchParams, setSearchParams] = useSearchParams();
  const urlStep = parseStepParam(searchParams.get("step"));
  const step = urlStep ?? WELCOME_STEP;
  // Step is derived from the URL so reload and browser Back keep the parent's
  // place. replace:true keeps the history stack to one entry per wizard visit
  // except when the parent moves forward, so Back walks steps in order.
  const setStep = useCallback((next: number | ((prev: number) => number), opts?: { replace?: boolean }) => {
    setSearchParams(prev => {
      const current = parseStepParam(prev.get("step")) ?? WELCOME_STEP;
      const resolved = typeof next === "function" ? next(current) : next;
      const params = new URLSearchParams(prev);
      const slug = STEP_SLUGS[resolved];
      if (resolved === WELCOME_STEP || !slug) params.delete("step");
      else params.set("step", slug);
      return params;
    }, { replace: opts?.replace ?? true });
  }, [setSearchParams]);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [submitting, setSubmitting] = useState(false);
  const [showLoading, setShowLoading] = useState<boolean>(() => readPhase() === "loading");
  const [showAiIntro, setShowAiIntro] = useState<boolean>(() => readPhase() === "intro");
  useEffect(() => {
    const fn = (p: WizardPhase) => { setShowLoading(p === "loading"); setShowAiIntro(p === "intro"); };
    phaseListeners.add(fn);
    return () => { phaseListeners.delete(fn); };
  }, []);
  type RegistrationError = { type: "emailExists" } | { type: "message"; message: string };
  const [registrationError, setRegistrationError] = useState<RegistrationError | null>(null);

  useEffect(() => {
    if (!isLoading && user && !user.mustCompleteProfile && !showLoading && !submitting && !showAiIntro) {
      navigate("/dashboard", { replace: true });
    }
  }, [isLoading, user, navigate, showLoading, submitting, showAiIntro]);

  // Authenticated users skip welcome and start at goals; invited members
  // start at the phone step.
  useEffect(() => {
    if (isLoading || !user || !user.mustCompleteProfile) return;
    if (isInvitedMember) {
      if (step < FIRST_MEMBER_STEP) setStep(FIRST_MEMBER_STEP);
    } else if (step === WELCOME_STEP) {
      setStep(1);
    }
  }, [isLoading, user, step, isInvitedMember]);

  const [otpSending, setOtpSending] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [otpChannel, setOtpChannel] = useState<"sms" | "whatsapp">("sms");
  // Turnstile draws nothing on the happy path (interaction-only), so its token can
  // still be in flight when the user taps Verify. Refs, not state, so the send-otp
  // handler reads the live value instead of a stale render closure.
  const turnstileTokenRef = useRef<string | null>(null);
  const turnstileEnabledRef = useRef(false);
  const [turnstileResetSignal, setTurnstileResetSignal] = useState(0);
  // Tokens are single-use, but resetting eagerly after a send starts a brand-new
  // challenge the user may never need (most never tap Resend) - and a challenged
  // visitor then sees the checkbox twice. So track consumption and reset lazily,
  // right before the next send that actually needs a token.
  const turnstileConsumedRef = useRef(false);
  // On the code step the widget stays mounted (so a lazy reset can mint a fresh
  // token) but hidden until a resend actually triggers a new challenge.
  const [turnstileVisibleOnCodeStep, setTurnstileVisibleOnCodeStep] = useState(false);

  /**
   * Resolve the Turnstile token for a send-otp call. A missing token is a hard 400
   * server-side, and with no widget on screen the user has no cue that the check is
   * still running - so wait for it instead of losing the signup to a race. Returns
   * as soon as the token lands; after the timeout we post what we have and let the
   * server's own error surface rather than hanging the button forever.
   */
  const awaitTurnstileToken = async (timeoutMs = 8000): Promise<string | null> => {
    if (!turnstileEnabledRef.current) return null;
    const deadline = Date.now() + timeoutMs;
    while (!turnstileTokenRef.current && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return turnstileTokenRef.current;
  };

  /**
   * Token for a send-otp call, minting a fresh one first if the last was consumed.
   * A lazy reset may pop an interactive challenge, so give the user time to click
   * it (30s) instead of the tight first-load window.
   */
  const getTurnstileTokenForSend = async (): Promise<string | null> => {
    if (!turnstileEnabledRef.current) return null;
    const needsReset = turnstileConsumedRef.current;
    if (needsReset) {
      turnstileTokenRef.current = null;
      turnstileConsumedRef.current = false;
      setTurnstileResetSignal((s) => s + 1);
    }
    return awaitTurnstileToken(needsReset ? 30000 : 8000);
  };

  const [data, setData] = useState<OnboardingData>(() => ({
    email: "",
    password: "",
    confirmPassword: "",
    goals: [],
    firstName: "",
    lastName: "",
    city: "",
    state: "",
    country: "",
    phoneE164: "",
    phoneDisplay: "",
    phoneIsoCode: "",
    phoneIsValid: false,
    // A2P: must start unticked. A pre-checked box is its own campaign violation.
    smsOptIn: false,
    otp: ["", "", "", "", "", ""],
    ...(readDraft() ?? {}),
  }));

  // Persist every answer as it changes (secrets excluded, see writeDraft).
  useEffect(() => { writeDraft(data); }, [data]);

  // A deep link or a stale draft can name a step the answers do not support
  // (draft cleared, ?step=5 with no phone). Clamp to the first step that is
  // still incomplete so the parent never lands on a screen that cannot proceed.
  const clampedOnceRef = useRef(false);
  useEffect(() => {
    if (isLoading || clampedOnceRef.current) return;
    clampedOnceRef.current = true;
    if (readPhase()) return; // account creation in flight: the phase screen is showing, never clamp under it
    const firstIncomplete = (() => {
      // Members always re-enter their phone after a reload: the code was sent
      // in a session that no longer exists, and a stale draft must never carry
      // another household member's answers into this one.
      if (isInvitedMember) return FIRST_MEMBER_STEP;
      if (data.goals.length === 0) return 1;
      if (!(data.firstName.trim() && data.lastName.trim())) return 2;
      if (!data.city.trim()) return 3;
      if (!data.phoneIsValid) return 4;
      return 5;
    })();
    if (step > firstIncomplete) setStep(firstIncomplete, { replace: true });
    // Once, on the first settled render: later navigation is driven by goNext,
    // and the login inside handleSubmit must never re-run this (it would pull
    // the parent back to the code step while their account is being created).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading]);

  const [detectedCountry, setDetectedCountry] = useState<string | null>(null);
  const [detectingCountry, setDetectingCountry] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    (async () => {
      try {
        const res = await fetch("/api/geo/country", {
          credentials: "include",
          signal: controller.signal,
        });
        if (!cancelled && res.ok) {
          const json = await res.json();
          if (typeof json?.countryCode === "string" && json.countryCode.length === 2) {
            setDetectedCountry(json.countryCode);
          }
        }
      } catch {
        // silent - user picks manually
      } finally {
        clearTimeout(timeout);
        if (!cancelled) setDetectingCountry(false);
      }
    })();
    return () => { cancelled = true; clearTimeout(timeout); controller.abort(); };
  }, []);

  const update = (partial: Partial<OnboardingData>) => {
    setRegistrationError(null);
    setData(prev => ({ ...prev, ...partial }));
  };

  const goNext = () => {
    setDirection("forward");
    setStep(prev => {
      let next = prev + 1;
      const lastStep = isRegistration ? ACCOUNT_STEP : TOTAL_STEPS_AUTHENTICATED;
      if (next > lastStep) return prev;
      return next;
    }, { replace: false });
  };

  const goBack = () => {
    setDirection("back");
    setStep(prev => {
      const minStep = isRegistration ? WELCOME_STEP : isInvitedMember ? FIRST_MEMBER_STEP : 1;
      let next = prev - 1;
      if (next < minStep) return prev;
      return next;
    });
  };

  const isValidEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  const canContinue = (): boolean => {
    switch (step) {
      case WELCOME_STEP: return true;
      case 1: return data.goals.length > 0;
      case 2: return data.firstName.trim().length > 0 && data.lastName.trim().length > 0;
      case 3: return data.city.trim().length > 0;
      case 4: return data.phoneIsValid === true;
      case 5: return data.otp.every(d => d !== "");
      case ACCOUNT_STEP: return isValidEmail(data.email) && data.password.length >= 8 && data.confirmPassword === data.password;
      default: return false;
    }
  };

  const handleSubmit = async () => {
    setPhase("loading");
    setSubmitting(true);

    try {
      if (isRegistration) {
        try {
          await apiRequest("POST", api.users.create.path, {
            email: data.email.trim(),
            password: data.password,
            name: `${data.firstName.trim()} ${data.lastName.trim()}`,
            mustCompleteProfile: true,
          });
        } catch (err: any) {
          setShowLoading(false);
          setSubmitting(false);
          const msg = err.message || "";
          if (msg.includes("Email already in use") || msg.includes("email_alias_exists")) {
            setRegistrationError({ type: "emailExists" });
          } else if (msg.includes("disposable_email")) {
            setRegistrationError({ type: "message", message: "Please use a permanent email address - temporary/disposable inboxes aren't accepted." });
          } else {
            setRegistrationError({ type: "message", message: msg || "Registration failed. Please try again." });
          }
          return;
        }

        const loginRes = await apiRequest("POST", api.auth.login.path, {
          email: data.email.trim(),
          password: data.password,
        });
        const loggedInUser = await loginRes.json();
        queryClient.setQueryData([api.auth.me.path], loggedInUser);
      }

      // Invited members only verify their own phone. Their family's goals,
      // location and profile are already on the shared account - never send
      // empty values that could overwrite them.
      await apiRequest("PUT", "/api/user/onboarding", isInvitedMember
        ? {
            mobileNumber: data.phoneE164,
            mobileNumberDisplay: data.phoneDisplay,
            smsNotificationsOptIn: data.smsOptIn,
          }
        : {
            firstName: data.firstName.trim(),
            lastName: data.lastName.trim(),
            city: data.city.trim(),
            state: data.state.trim(),
            country: data.country.trim() || null,
            mobileNumber: data.phoneE164,
            mobileNumberDisplay: data.phoneDisplay,
            smsNotificationsOptIn: data.smsOptIn,
            interestedServices: data.goals,
          });

      await queryClient.invalidateQueries({ queryKey: ["/api/user"] });
      clearDraft();

      if (isInvitedMember) {
        // The family already met their concierge and chose a persona; the
        // member joins the conversation in progress instead of re-running
        // the intro and the persona picker.
        setTimeout(() => {
          setPhase(null);
          setSubmitting(false);
          navigate("/chat", { replace: true });
        }, 2000);
        return;
      }

      setTimeout(() => {
        setPhase("intro");
      }, 2000);
    } catch (err: any) {
      setPhase(null);
      setSubmitting(false);
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  const lastStep = isRegistration ? ACCOUNT_STEP : TOTAL_STEPS_AUTHENTICATED;

  // Enter advances ONLY from a text field, and only when nothing else owns
  // the key: buttons (goal pills) keep their native toggle, an open list
  // (city suggestions, country picker) keeps its selection, and a child
  // that already handled Enter (defaultPrevented) is left alone. A previous
  // window-level listener advanced from anywhere, which made keyboard
  // multi-select impossible and skipped the parent's city pick.
  const handleStepKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" || e.defaultPrevented) return;
    const el = e.target as HTMLElement;
    if (!(el instanceof HTMLInputElement)) return;
    if (el.type === "checkbox" || el.type === "radio") return;
    if (el.getAttribute("aria-expanded") === "true") return;
    if (el.closest('[role="listbox"]')) return;
    if (!canContinue() || submitting || otpSending) return;
    e.preventDefault();
    handleContinue();
  };

  // Overflow cue: on short viewports (iPhone SE, keyboard up) the fourth goal
  // pill or the consent tray sat under the Continue bar with no hint that
  // more existed. Fade the scroller's bottom edge and rule the CTA bar while
  // there is content below the fold.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const scrollerObserverRef = useRef<ResizeObserver | null>(null);
  const [hasMoreBelow, setHasMoreBelow] = useState(false);
  const measureOverflow = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setHasMoreBelow(el.scrollHeight - el.scrollTop - el.clientHeight > 8);
  }, []);
  // Callback ref, not an effect: the scroller is not in the tree during the
  // auth-loading and welcome renders, so an effect keyed on step ran once
  // against a null ref and never came back. This attaches the observer the
  // moment the element mounts and detaches when it leaves.
  const setScrollerRef = useCallback((el: HTMLDivElement | null) => {
    scrollerObserverRef.current?.disconnect();
    scrollerObserverRef.current = null;
    scrollerRef.current = el;
    if (!el) return;
    const ro = new ResizeObserver(measureOverflow);
    ro.observe(el);
    Array.from(el.children).forEach(c => ro.observe(c));
    scrollerObserverRef.current = ro;
    measureOverflow();
  }, [measureOverflow]);
  // Each step swaps the keyed child: observe the new one and re-measure.
  useEffect(() => {
    const el = scrollerRef.current;
    const ro = scrollerObserverRef.current;
    if (el && ro) Array.from(el.children).forEach(c => ro.observe(c));
    const raf = requestAnimationFrame(measureOverflow);
    window.addEventListener("resize", measureOverflow);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", measureOverflow); };
  }, [step, measureOverflow]);

  // Focus management: after a step change, if nothing claimed focus (steps
  // with an autofocused field already did), move it to the step's heading so
  // keyboard and screen-reader users land on the new question, not the body.
  useEffect(() => {
    const t = setTimeout(() => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      document.querySelector<HTMLElement>('[data-testid="text-step-title"]')?.focus();
    }, 350);
    return () => clearTimeout(t);
  }, [step]);

  const handleContinue = async () => {
    if (step === WELCOME_STEP) {
      goNext();
    } else if (step === ACCOUNT_STEP && isRegistration) {
      if (data.password !== data.confirmPassword) {
        setRegistrationError({ type: "message", message: "Passwords do not match." });
        return;
      }
      if (data.password.length < 8) {
        setRegistrationError({ type: "message", message: "Password must be at least 8 characters." });
        return;
      }
      setRegistrationError(null);
      handleSubmit();
    } else if (step === lastStep) {
      handleSubmit();
    } else if (step === 4) {
      setOtpSending(true);
      setOtpError(null);
      try {
        const fullPhone = data.phoneE164;
        const turnstileToken = await getTurnstileTokenForSend();
        const res = await apiRequest("POST", "/api/auth/send-otp", { phone: fullPhone, turnstileToken });
        const result = await res.json();
        if (result.devCode) {
          (window as any).__devOtpCode = result.devCode;
        }
        if (result.channel === "whatsapp" || result.channel === "sms") {
          setOtpChannel(result.channel);
        }
        setOtpError(null);
        goNext();
      } catch (err: any) {
        let code = "";
        try {
          const parsed = JSON.parse(err.message.replace(/^\d+:\s*/, ""));
          if (parsed.message) code = String(parsed.message);
        } catch { if (err.message) code = err.message; }
        setOtpError(mapOtpSendError(code));
      } finally {
        setOtpSending(false);
        // Token spent (server verified it, pass or fail). The NEXT send - a retry
        // here or a resend on the code step - mints a fresh one lazily.
        turnstileConsumedRef.current = true;
      }
    } else if (step === 5) {
      const entered = data.otp.join("");
      setOtpSending(true);
      setOtpError(null);
      try {
        const fullPhone = data.phoneE164;
        await apiRequest("POST", "/api/auth/verify-otp", { phone: fullPhone, code: entered });
        setOtpError(null);
        goNext();
      } catch {
        setOtpError("The code you entered is incorrect or has expired. Please try again.");
      } finally {
        setOtpSending(false);
      }
    } else {
      goNext();
    }
  };

  // Why Continue is disabled, said out loud. A 40%-opacity button on its own
  // reads as decoration; one plain line under it names the missing piece.
  const continueHint = (() => {
    if (canContinue()) return null;
    switch (step) {
      case 1: return "Pick at least one to continue";
      case 2: return "Enter your first and last name";
      case 3: return "Choose your city from the list";
      case 4: return "Enter a mobile number we can text";
      case 5: return "Enter the 6-digit code from the text";
      case ACCOUNT_STEP: return "Enter your email and a password of 8 or more characters, twice";
      default: return null;
    }
  })();

  // Browser tab / recent-tabs title per step. The app otherwise leaves it empty.
  const stepTitleForTab = (() => {
    switch (step) {
      case WELCOME_STEP: return "Get started";
      case 1: return "What are you looking for?";
      case 2: return "Your name";
      case 3: return "Where you live";
      case 4: return "Your phone";
      case 5: return "Enter the code";
      case ACCOUNT_STEP: return "Create your account";
      default: return "Get started";
    }
  })();
  useEffect(() => {
    const prev = document.title;
    document.title = `${stepTitleForTab} - ${brand?.companyName || "GoStork"}`;
    return () => { document.title = prev; };
  }, [stepTitleForTab, brand?.companyName]);

  // Progress bar: steps 1-N (welcome step doesn't count). The bar reaches 100%
  // only on the "Welcome to the family" screen, never while a step is still
  // open, so it cannot claim the account exists before it does.
  const stepsCompleted = Math.max(0, isInvitedMember ? step - FIRST_MEMBER_STEP : step - 1);
  const totalVisibleSteps = isInvitedMember ? 2 : lastStep;
  const progress = totalVisibleSteps > 0 ? (stepsCompleted / totalVisibleSteps) * 100 : 0;
  const stepNumber = Math.max(1, isInvitedMember ? step - FIRST_MEMBER_STEP + 1 : step);

  const brandName = brand?.companyName || "GoStork";

  if (isLoading) {
    return (
      <div className="fixed inset-0 bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (showLoading) {
    return (
      <div className="fixed inset-0 bg-background flex flex-col items-center justify-center z-50">
        <div className="animate-[fadeIn_0.8s_ease-out_forwards] opacity-0 text-center px-8">
          <h1 className="text-3xl md:text-4xl font-bold mb-4 text-foreground" style={{ fontFamily: "var(--font-display)" }}>
            Welcome to the family{data.firstName ? `, ${data.firstName}` : ""}.
          </h1>
          <p className="text-muted-foreground text-lg">
            {isInvitedMember
              ? "You're on your family's account. Taking you to the conversation."
              : "We've saved your preferences. Now let's meet your concierge."}
          </p>
        </div>
        <div className="mt-8 animate-[fadeIn_1.2s_ease-out_forwards] opacity-0">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
        <style>{`
          @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
          }
        `}</style>
      </div>
    );
  }

  // AI Intro screen - shown after loading, before matchmaker selection
  if (showAiIntro) {
    const matchmakers: Matchmaker[] = (brand?.matchmakers || [])
      .filter((m: Matchmaker) => m.isActive)
      .sort((a: Matchmaker, b: Matchmaker) => a.sortOrder - b.sortOrder);
    // No persona is chosen yet (that is the next screen), so the preview
    // shows the house concierge only when there is exactly one.
    const concierge = matchmakers.length === 1 ? matchmakers[0] : null;
    return (
      <AiIntroScreen
        goals={data.goals}
        concierge={concierge}
        brand={brand}
        onContinue={() => { setPhase(null); navigate("/matchmaker-selection", { replace: true }); }}
      />
    );
  }

  // Welcome step - full-screen, no progress bar
  if (step === WELCOME_STEP) {
    return (
      <div className="fixed inset-0 bg-background overflow-y-auto px-6" data-testid="onboarding-welcome">
        <div
          className="min-h-full flex flex-col items-center justify-center"
          style={{ paddingTop: "max(2.5rem, env(safe-area-inset-top, 0px))", paddingBottom: "max(2.5rem, env(safe-area-inset-bottom, 0px))" }}
        >
        <div className="max-w-md w-full text-center space-y-6">
          {/* Brand logo or fallback */}
          <div className="flex justify-center">
            {(brand?.logoWithNameUrl || brand?.logoUrl) ? (
              <img
                src={getPhotoSrc(brand.logoWithNameUrl || brand.logoUrl!) || undefined}
                alt={brandName}
                className="h-14 object-contain"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            ) : (
              <h2 className="text-2xl font-bold text-primary" style={{ fontFamily: "var(--font-display)" }}>
                {brandName}
              </h2>
            )}
          </div>
          <h1
            className="text-3xl md:text-4xl font-bold leading-tight"
            style={{ fontFamily: "var(--font-display)" }}
            data-testid="text-welcome-title"
          >
            Building a family is a deeply personal journey.
          </h1>
          <p className="t-helper">
            We're here to guide you every step of the way.
          </p>

          {/* How it works steps */}
          <div className="space-y-4 text-left max-w-xs mx-auto">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                <UserRound className="w-5 h-5 text-primary" />
              </div>
              <span className="text-foreground font-medium">Share your journey</span>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                <Sparkles className="w-5 h-5 text-primary" />
              </div>
              <span className="text-foreground font-medium">Your concierge narrows the field for you</span>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                <DollarSign className="w-5 h-5 text-primary" />
              </div>
              <span className="text-foreground font-medium">See real costs upfront</span>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                <CalendarCheck className="w-5 h-5 text-primary" />
              </div>
              <span className="text-foreground font-medium">Book a free Match Call</span>
            </div>
          </div>

          <Button
            size="lg"
            onClick={() => goNext()}
            data-testid="btn-welcome-start"
            className="w-full h-auto py-4 text-lg"
          >
            Get started
          </Button>
        </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-background flex flex-col items-center" data-testid="onboarding-page">
      <div className="w-full max-w-lg flex flex-col flex-1 min-h-0">
      {/* Top bar: the wizard is fixed inset-0 with viewport-fit=cover, so pad below the phone status bar / notch */}
      <div
        className="flex items-center min-h-12 px-4 pb-2"
        style={{ paddingTop: "max(1rem, env(safe-area-inset-top, 0px))" }}
      >
        {step > (isRegistration ? WELCOME_STEP : 1) && (
          <button
            type="button"
            onClick={goBack}
            aria-label="Back"
            className="flex items-center justify-center w-10 h-10 -ml-2 rounded-full text-foreground hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            data-testid="btn-onboarding-back"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
        )}
        <div className="flex-1" />
        <span className="t-micro-label" role="status" aria-live="polite" data-testid="text-step-count">
          {stepNumber} of {totalVisibleSteps}
        </span>
      </div>

      <div className="px-6 mb-6">
        <div
          className="w-full h-1 bg-border rounded-full overflow-hidden"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={totalVisibleSteps}
          aria-valuenow={stepsCompleted}
          aria-label={`Step ${stepNumber} of ${totalVisibleSteps}`}
        >
          <div
            className="h-full bg-primary rounded-full transition-all duration-500 ease-out"
            style={{ width: `${progress}%` }}
            data-testid="progress-bar"
          />
        </div>
      </div>

      <div
        ref={setScrollerRef}
        onScroll={measureOverflow}
        className={`flex-1 overflow-y-auto px-6 pb-8 ${hasMoreBelow ? "scroll-fade-bottom" : ""}`}
      >
        <div
          key={step}
          className="animate-in fade-in slide-in-from-right-4 duration-300"
          onKeyDown={handleStepKeyDown}
        >
          {step === 1 && (
            <StepGoals goals={data.goals} onChange={g => update({ goals: g })} />
          )}
          {step === 2 && (
            <StepName
              firstName={data.firstName}
              lastName={data.lastName}
              onFirstNameChange={v => update({ firstName: v })}
              onLastNameChange={v => update({ lastName: v })}
            />
          )}
          {step === 3 && (
            <StepLocation
              value={{ address: "", city: data.city, state: data.state, zip: "", country: data.country }}
              onChange={loc => update({ city: loc.city, state: loc.state, country: loc.country })}
            />
          )}
          {step === 4 && (
            <StepPhone
              memberFirstName={isInvitedMember ? (user?.name || "").split(" ")[0] || null : null}
              value={data.phoneE164}
              displayValue={data.phoneDisplay}
              isoCode={data.phoneIsoCode}
              locationCountry={data.country}
              detectedCountry={detectedCountry}
              detectingCountry={detectingCountry}
              onChange={({ e164, display, isValid, isoCode }) => {
                update({
                  phoneE164: e164,
                  phoneDisplay: display,
                  phoneIsoCode: isoCode,
                  phoneIsValid: isValid,
                });
                setOtpError(null);
              }}
              smsOptIn={data.smsOptIn}
              onSmsOptInChange={checked => update({ smsOptIn: checked })}
              error={otpError}
            />
          )}
          {/* Mounted across BOTH the phone step and the code step: Turnstile tokens are
              single-use, so "Resend code" on step 5 needs the widget still alive to mint
              a fresh one. Unmounting it at step 4 left resend posting a consumed token.
              On the code step it stays hidden until a resend actually needs a fresh
              challenge - otherwise a challenged visitor sees the checkbox twice. */}
          {(step === 4 || step === 5) && (
            <div className={step === 4 ? "mt-4" : turnstileVisibleOnCodeStep ? "" : "hidden"}>
              <TurnstileWidget
                onToken={token => { turnstileTokenRef.current = token; }}
                onEnabledChange={enabled => { turnstileEnabledRef.current = enabled; }}
                resetSignal={turnstileResetSignal}
              />
            </div>
          )}
          {step === 5 && (
            <StepVerification
              otp={data.otp}
              onChange={v => { update({ otp: v }); setOtpError(null); }}
              phone={data.phoneDisplay || data.phoneE164}
              channel={otpChannel}
              onResend={async () => {
                setOtpError(null);
                // Unhide the widget first: the lazy reset below may pop an
                // interactive challenge the user has to be able to click.
                setTurnstileVisibleOnCodeStep(true);
                try {
                  const turnstileToken = await getTurnstileTokenForSend();
                  const res = await apiRequest("POST", "/api/auth/send-otp", { phone: data.phoneE164, turnstileToken });
                  const result = await res.json();
                  if (result.channel === "whatsapp" || result.channel === "sms") {
                    setOtpChannel(result.channel);
                  }
                  setTurnstileVisibleOnCodeStep(false);
                } finally {
                  turnstileConsumedRef.current = true;
                }
              }}
              error={otpError}
            />
          )}
          {step === ACCOUNT_STEP && isRegistration && (
            <StepAccount
              summary={[
                { step: 1, label: "Looking for", value: data.goals.join(", ") },
                { step: 2, label: "Name", value: `${data.firstName.trim()} ${data.lastName.trim()}`.trim() },
                { step: 3, label: "Location", value: [data.city, data.state].filter(Boolean).join(", ") },
                { step: 4, label: "Mobile", value: data.phoneDisplay || data.phoneE164 },
              ]}
              onEditStep={(n) => { setDirection("back"); setStep(n); }}
              email={data.email}
              password={data.password}
              confirmPassword={data.confirmPassword}
              onEmailChange={v => { update({ email: v }); setRegistrationError(null); }}
              onPasswordChange={v => { update({ password: v }); setRegistrationError(null); }}
              onConfirmPasswordChange={v => { update({ confirmPassword: v }); setRegistrationError(null); }}
              error={registrationError}
              onLoginRedirect={() => navigate("/auth", { state: { prefillEmail: data.email.trim() } })}
            />
          )}
        </div>
      </div>

      {step <= lastStep && (
        <div className={`px-6 pb-8 pt-2 transition-colors ${hasMoreBelow ? "border-t border-border" : "border-t border-transparent"}`}>
          <Button
            size="lg"
            onClick={handleContinue}
            disabled={!canContinue() || submitting || otpSending}
            data-testid="btn-onboarding-continue"
            className="w-full h-auto py-4 text-lg disabled:opacity-40"
            aria-describedby={continueHint ? "onboarding-continue-hint" : undefined}
          >
            {submitting || otpSending ? (
              <Loader2 className="w-5 h-5 animate-spin mx-auto" />
            ) : step === 4 ? (
              "Text me a code"
            ) : step === ACCOUNT_STEP ? (
              "Create account and finish"
            ) : (
              "Continue"
            )}
          </Button>
          {continueHint && (
            <p id="onboarding-continue-hint" className="t-helper text-center mt-3" aria-live="polite" data-testid="text-continue-hint">
              {continueHint}
            </p>
          )}
          {step === ACCOUNT_STEP && isRegistration && (
            <p className="t-helper text-center mt-4">
              Already have an account?{" "}
              <button
                type="button"
                onClick={() => navigate("/")}
                className="text-primary font-medium hover:underline"
                data-testid="link-back-to-login"
              >
                Login
              </button>
            </p>
          )}
        </div>
      )}
      </div>
    </div>
  );
}

function StepAccount({
  summary,
  onEditStep,
  email,
  password,
  confirmPassword,
  onEmailChange,
  onPasswordChange,
  onConfirmPasswordChange,
  error,
  onLoginRedirect,
}: {
  /** Read-back of the earlier answers; each row links to its step. */
  summary: { step: number; label: string; value: string }[];
  onEditStep: (step: number) => void;
  email: string;
  password: string;
  confirmPassword: string;
  onEmailChange: (v: string) => void;
  onPasswordChange: (v: string) => void;
  onConfirmPasswordChange: (v: string) => void;
  error: { type: "emailExists" } | { type: "message"; message: string } | null;
  onLoginRedirect: () => void;
}) {
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const summaryRows = summary.filter(r => r.value);

  return (
    <div>
      <h1
        className="text-3xl font-bold mb-2 leading-tight focus:outline-none"
        style={{ fontFamily: "var(--font-display)" }}
        data-testid="text-step-title"
        tabIndex={-1}
      >
        Create your account
      </h1>
      <p className="t-helper mb-4">Enter your email and choose a password to get started.</p>

      {/* Read-back: the parent commits five answers here, so restate them once
          with a way back to each. One line by default so the form still fits
          above the Continue bar on a laptop; expands inline to per-row Edit. */}
      <div className="rounded-[var(--radius)] border border-border bg-secondary/60 px-4 py-2.5 mb-6" data-testid="account-summary">
        <div className="flex items-center justify-between gap-3">
          <p className="t-helper min-w-0 truncate" data-testid="summary-line">
            {summaryRows.map(r => r.value).join(" · ")}
          </p>
          <button
            type="button"
            onClick={() => setSummaryOpen(o => !o)}
            aria-expanded={summaryOpen}
            aria-controls="account-summary-rows"
            className="t-helper text-primary hover:underline shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
            data-testid="summary-toggle"
          >
            {summaryOpen ? "Done" : "Change"}
          </button>
        </div>
        {summaryOpen && (
          <div id="account-summary-rows" className="mt-2 pt-2 border-t border-border space-y-1.5">
            {summaryRows.map(r => (
              <div key={r.step} className="flex items-baseline justify-between gap-3">
                <div className="min-w-0 truncate">
                  <span className="t-helper">{r.label}: </span>
                  <span className="t-field-value" data-testid={`summary-${r.step}`}>{r.value}</span>
                </div>
                <button
                  type="button"
                  onClick={() => onEditStep(r.step)}
                  className="t-helper text-primary hover:underline shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                  data-testid={`summary-edit-${r.step}`}
                >
                  Edit
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="space-y-5">
        <div>
          <label htmlFor="ob-email" className="t-form-label block mb-1">Email</label>
          <input
            id="ob-email"
            type="email"
            value={email}
            onChange={e => onEmailChange(e.target.value)}
            placeholder="you@example.com"
            autoFocus
            data-testid="input-register-email"
            className="w-full text-lg border-0 border-b-2 border-border focus:border-primary outline-none pb-3 bg-transparent placeholder:text-muted-foreground/60 transition-colors"
          />
          {email.length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && (
            <p className="t-error mt-1" role="alert" data-testid="text-email-hint">Please enter a valid email address</p>
          )}
        </div>
        <div>
          <label htmlFor="ob-password" className="t-form-label block mb-1">Password</label>
          <div className="relative">
            <input
              id="ob-password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={e => onPasswordChange(e.target.value)}
              placeholder="At least 8 characters"
              data-testid="input-register-password"
              className="w-full text-lg border-0 border-b-2 border-border focus:border-primary outline-none pb-3 bg-transparent placeholder:text-muted-foreground/60 transition-colors pr-10"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-0 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
              data-testid="btn-toggle-password"
            >
              {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
            </button>
          </div>
          {password.length > 0 && password.length < 8 && (
            <p className="t-error mt-1" role="alert" data-testid="text-password-hint">Password must be at least 8 characters</p>
          )}
        </div>
        <div>
          <label htmlFor="ob-confirm-password" className="t-form-label block mb-1">Confirm password</label>
          <div className="relative">
            <input
              id="ob-confirm-password"
              type={showConfirm ? "text" : "password"}
              value={confirmPassword}
              onChange={e => onConfirmPasswordChange(e.target.value)}
              placeholder="Re-enter your password"
              data-testid="input-register-confirm-password"
              className="w-full text-lg border-0 border-b-2 border-border focus:border-primary outline-none pb-3 bg-transparent placeholder:text-muted-foreground/60 transition-colors pr-10"
            />
            <button
              type="button"
              onClick={() => setShowConfirm(!showConfirm)}
              className="absolute right-0 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
              data-testid="btn-toggle-confirm-password"
            >
              {showConfirm ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
            </button>
          </div>
          {confirmPassword.length > 0 && confirmPassword !== password && (
            <p className="t-error mt-1" role="alert" data-testid="text-confirm-hint">Passwords do not match</p>
          )}
        </div>
        {error && (
          <p className="t-error" role="alert" data-testid="text-register-error">
            {error.type === "emailExists" ? (
              <>
                An account with this email already exists. Please{" "}
                <button
                  type="button"
                  onClick={onLoginRedirect}
                  className="text-primary underline hover:no-underline"
                  data-testid="btn-register-error-login"
                >
                  log in instead
                </button>
                .
              </>
            ) : (
              error.message
            )}
          </p>
        )}
      </div>
    </div>
  );
}

function StepGoals({ goals, onChange }: { goals: string[]; onChange: (g: string[]) => void }) {
  const toggle = (goal: string) => {
    onChange(
      goals.includes(goal) ? goals.filter(g => g !== goal) : [...goals, goal]
    );
  };

  return (
    <div>
      <h1
        className="text-3xl font-bold mb-8 leading-tight focus:outline-none"
        style={{ fontFamily: "var(--font-display)" }}
        data-testid="text-step-title"
        tabIndex={-1}
      >
        What are you looking for?
      </h1>
      <p className="t-helper mb-8 -mt-6">Select all that apply</p>
      <div className="space-y-3">
        {GOALS.map(goal => (
          <PillButton
            key={goal}
            label={goal}
            selected={goals.includes(goal)}
            onClick={() => toggle(goal)}
            multiSelect
            data-testid={`pill-goal-${goal.toLowerCase().replace(/\s+/g, "-")}`}
          />
        ))}
      </div>
    </div>
  );
}

function StepName({
  firstName,
  lastName,
  onFirstNameChange,
  onLastNameChange,
}: {
  firstName: string;
  lastName: string;
  onFirstNameChange: (v: string) => void;
  onLastNameChange: (v: string) => void;
}) {
  return (
    <div>
      <h1
        className="text-3xl font-bold mb-2 leading-tight focus:outline-none"
        style={{ fontFamily: "var(--font-display)" }}
        data-testid="text-step-title"
        tabIndex={-1}
      >
        What's your name?
      </h1>
      <p className="t-helper mb-8">Please use your real name - providers see it only after you book a Match Call with them</p>
      <div className="space-y-6">
        <div>
        <label htmlFor="ob-first-name" className="t-form-label block mb-1">First name</label>
        <input
          id="ob-first-name"
          type="text"
          value={firstName}
          onChange={e => onFirstNameChange(e.target.value)}
          autoComplete="given-name"
          placeholder="e.g. Jordan"
          autoFocus
          data-testid="input-first-name"
          className="w-full text-lg border-0 border-b-2 border-border focus:border-primary outline-none pb-3 bg-transparent placeholder:text-muted-foreground/60 transition-colors"
        />
        </div>
        <div>
        <label htmlFor="ob-last-name" className="t-form-label block mb-1">Last name</label>
        <input
          id="ob-last-name"
          type="text"
          value={lastName}
          onChange={e => onLastNameChange(e.target.value)}
          autoComplete="family-name"
          placeholder="e.g. Rivera"
          data-testid="input-last-name"
          className="w-full text-lg border-0 border-b-2 border-border focus:border-primary outline-none pb-3 bg-transparent placeholder:text-muted-foreground/60 transition-colors"
        />
        </div>
      </div>
    </div>
  );
}

function StepLocation({
  value,
  onChange,
}: {
  value: { address: string; city: string; state: string; zip: string; country: string };
  onChange: (loc: { address: string; city: string; state: string; zip: string; country: string }) => void;
}) {
  return (
    <div>
      <h1
        className="text-3xl font-bold mb-8 leading-tight focus:outline-none"
        style={{ fontFamily: "var(--font-display)" }}
        data-testid="text-step-title"
        tabIndex={-1}
      >
        Where are you currently living?
      </h1>
      <p className="t-helper mb-8 -mt-6">We use this to find providers near you</p>
      <label htmlFor="ob-city" className="t-form-label block mb-1">City</label>
      <LocationAutocomplete
        id="ob-city"
        value={value}
        onChange={onChange}
        placeholder="Start typing your city..."
        variant="onboarding"
        showCurrentLocation
        autoFocus
        data-testid="input-location"
      />
    </div>
  );
}

function StepPhone({
  memberFirstName,
  value,
  displayValue,
  isoCode,
  locationCountry,
  detectedCountry,
  detectingCountry,
  onChange,
  smsOptIn,
  onSmsOptInChange,
  error,
}: {
  /** Set for an invited family member: the step is their whole onboarding. */
  memberFirstName?: string | null;
  value: string;
  displayValue: string;
  isoCode: string;
  locationCountry?: string;
  detectedCountry: string | null;
  detectingCountry: boolean;
  onChange: (params: { e164: string; display: string; isValid: boolean; isoCode: string }) => void;
  smsOptIn: boolean;
  onSmsOptInChange: (checked: boolean) => void;
  error?: string | null;
}) {
  // Priority: explicit user selection > country from location step > geo API detection
  const isoFromLocation = locationCountry ? countryNameToIsoCode(locationCountry) : null;
  const effectiveDefault = isoCode || isoFromLocation || detectedCountry || undefined;

  return (
    <div>
      <h1
        className="text-3xl font-bold mb-2 leading-tight focus:outline-none"
        style={{ fontFamily: "var(--font-display)" }}
        data-testid="text-step-title"
        tabIndex={-1}
      >
        {memberFirstName ? `Welcome, ${memberFirstName}. One quick step.` : "What's your phone number?"}
      </h1>
      <p className="t-helper mb-8">
        {memberFirstName
          ? "Your family has already set everything up. Verify your own phone and you're in."
          : "We'll text a code to this number to confirm it's really you. It keeps the parents and providers here real."}
      </p>

      <div className="mb-6">
        <label htmlFor="ob-phone" className="t-form-label block mb-1">Mobile number</label>
        <PhoneInput
          inputId="ob-phone"
          variant="onboarding"
          value={value}
          displayValue={displayValue}
          defaultIsoCode={effectiveDefault}
          loadingCountry={detectingCountry && !isoCode && !isoFromLocation}
          onChange={onChange}
          autoFocus
          data-testid="input-phone"
        />
      </div>

      {error && (
        <p className="t-error mb-4 flex items-center gap-2" role="alert" data-testid="text-phone-error">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </p>
      )}

      {/* A2P 10DLC: the ongoing-notifications opt-in is a SEPARATE, genuinely optional
          consent. The box starts unticked and the Verify button works either way -
          if declining ever blocks signup, the campaign fails on error 30923 again. */}
      <label
        className="flex items-start gap-3 rounded-[var(--radius)] border border-border bg-secondary p-4 cursor-pointer transition-colors hover:border-primary/60 has-[:checked]:border-primary has-[:checked]:bg-primary/5"
        data-testid="label-sms-opt-in"
      >
        <input
          type="checkbox"
          checked={smsOptIn}
          onChange={e => onSmsOptInChange(e.target.checked)}
          aria-labelledby="sms-opt-in-title"
          aria-describedby="sms-opt-in-detail"
          className="mt-0.5 h-5 w-5 shrink-0 accent-[hsl(var(--primary))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
          data-testid="checkbox-sms-opt-in"
        />
        <SmsNotificationsOptIn titleId="sms-opt-in-title" detailId="sms-opt-in-detail" />
      </label>

      {/* The transactional notice (carrier-registered wording, unchanged) sits
          last so the field, its reassurance and the opt-in share the first
          viewport on a short phone; it stays fully readable on scroll. */}
      <SmsTransactionalNotice className="mt-5" />
    </div>
  );
}

function StepVerification({
  otp,
  onChange,
  phone,
  channel,
  onResend,
  error,
}: {
  otp: string[];
  onChange: (v: string[]) => void;
  phone: string;
  channel?: "sms" | "whatsapp";
  onResend: () => Promise<void>;
  error?: string | null;
}) {
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);

  const handleResend = async () => {
    setResending(true);
    try {
      await onResend();
      setResent(true);
      setTimeout(() => setResent(false), 3000);
    } catch {
    } finally {
      setResending(false);
    }
  };

  return (
    <div>
      <h1
        className="text-3xl font-bold mb-2 leading-tight focus:outline-none"
        style={{ fontFamily: "var(--font-display)" }}
        data-testid="text-step-title"
        tabIndex={-1}
      >
        Enter the code you received
      </h1>
      <p className="t-helper mb-10">Sent to {phone} via {channel === "whatsapp" ? "WhatsApp" : "SMS"}</p>

      <OtpInput value={otp} onChange={onChange} />

      {error && (
        <p className="t-error mt-4 flex items-center gap-2 justify-center" role="alert" data-testid="text-otp-error">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </p>
      )}

      <p className={`text-center t-helper ${error ? "mt-4" : "mt-8"}`}>
        You should receive the code within 30s
      </p>
      <p className="text-center text-sm mt-1">
        {resent ? (
          <span className="text-[hsl(var(--brand-success))]" data-testid="text-code-resent">Code sent!</span>
        ) : (
          <button
            type="button"
            onClick={handleResend}
            disabled={resending}
            className="underline text-foreground disabled:opacity-50"
            data-testid="btn-resend-code"
          >
            {resending ? "Sending..." : "Didn't receive the code?"}
          </button>
        )}
      </p>
    </div>
  );
}
