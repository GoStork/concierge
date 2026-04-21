import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { useBrandSettings, Matchmaker } from "@/hooks/use-brand-settings";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { api } from "@shared/routes";
import { ChevronLeft, Loader2, Lock, Check, Eye, EyeOff, AlertCircle, UserRound, Sparkles, DollarSign, CalendarCheck, Stethoscope, Heart, Baby, FlaskConical, Search } from "lucide-react";
import { getPhotoSrc } from "@/lib/profile-utils";
import LocationAutocomplete from "@/components/location-autocomplete";

// AI Intro service-to-visual config (inline version of OnboardingAiIntroPage)
const AI_INTRO_SERVICE_CONFIG: Record<string, { icon: typeof Stethoscope; gradient: string; label: string; imageKey: string; chatText: string; replyText: string }> = {
  "Fertility Clinic": { icon: Stethoscope, gradient: "from-primary/20 to-primary/5", label: "Top Clinics", imageKey: "onboardingClinicImageUrl", chatText: "I found a great match for you! A top-rated fertility clinic near you", replyText: "Tell me more about the clinic!" },
  "Egg Donor": { icon: FlaskConical, gradient: "from-pink-100 to-rose-50", label: "Egg Donors", imageKey: "onboardingEggDonorImageUrl", chatText: "I found an amazing egg donor that matches your preferences!", replyText: "She sounds great!" },
  "Surrogate": { icon: Baby, gradient: "from-amber-100 to-orange-50", label: "Surrogates", imageKey: "onboardingSurrogateImageUrl", chatText: "I found a wonderful surrogate who's a perfect fit for your journey!", replyText: "Tell me more about her!" },
  "Sperm Donor": { icon: Heart, gradient: "from-blue-100 to-sky-50", label: "Sperm Donors", imageKey: "onboardingSpermDonorImageUrl", chatText: "I found a great sperm donor that matches what you're looking for!", replyText: "Tell me more!" },
};

function AiIntroServiceCard({ service, imageUrl, style }: { service: string; imageUrl: string | null; style: React.CSSProperties }) {
  const config = AI_INTRO_SERVICE_CONFIG[service];
  if (!config) return null;
  const Icon = config.icon;
  const resolvedUrl = imageUrl ? (getPhotoSrc(imageUrl) || imageUrl) : null;
  return (
    <div className={`absolute w-48 h-60 rounded-2xl border border-border shadow-lg overflow-hidden ${!resolvedUrl ? `bg-gradient-to-br ${config.gradient}` : ""}`} style={style}>
      {resolvedUrl ? (
        <>
          <img src={resolvedUrl} alt={config.label} className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/50 to-transparent p-3">
            <span className="text-white text-sm font-semibold">{config.label}</span>
          </div>
        </>
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center gap-3">
          <div className="w-16 h-16 rounded-full bg-background/80 flex items-center justify-center">
            <Icon className="w-8 h-8 text-primary" />
          </div>
          <span className="text-sm font-semibold text-foreground/80">{config.label}</span>
        </div>
      )}
    </div>
  );
}

const TOTAL_STEPS_AUTHENTICATED = 5;
const TOTAL_STEPS_UNAUTHENTICATED = 6;
const ACCOUNT_STEP = 6;
const WELCOME_STEP = 0;

const GOALS = ["Fertility Clinic", "Egg Donor", "Surrogate", "Sperm Donor"];

const COUNTRY_CODES = [
  { code: "+1", label: "US", flag: "🇺🇸" },
  { code: "+44", label: "UK", flag: "🇬🇧" },
  { code: "+972", label: "IL", flag: "🇮🇱" },
  { code: "+61", label: "AU", flag: "🇦🇺" },
  { code: "+49", label: "DE", flag: "🇩🇪" },
  { code: "+33", label: "FR", flag: "🇫🇷" },
  { code: "+91", label: "IN", flag: "🇮🇳" },
  { code: "+86", label: "CN", flag: "🇨🇳" },
  { code: "+81", label: "JP", flag: "🇯🇵" },
  { code: "+55", label: "BR", flag: "🇧🇷" },
  { code: "+52", label: "MX", flag: "🇲🇽" },
  { code: "+34", label: "ES", flag: "🇪🇸" },
  { code: "+39", label: "IT", flag: "🇮🇹" },
  { code: "+82", label: "KR", flag: "🇰🇷" },
  { code: "+31", label: "NL", flag: "🇳🇱" },
];

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
  countryCode: string;
  phone: string;
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
      data-testid={testId}
      className={`w-full py-4 px-6 rounded-full text-lg font-medium transition-all duration-200 flex items-center justify-between ${
        selected
          ? "bg-primary text-primary-foreground shadow-md"
          : "bg-muted text-foreground hover:bg-muted/80"
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
  const [step, setStep] = useState(WELCOME_STEP);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [submitting, setSubmitting] = useState(false);
  const [showLoading, setShowLoading] = useState(false);
  const [showAiIntro, setShowAiIntro] = useState(false);
  const [registrationError, setRegistrationError] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading && user && !user.mustCompleteProfile && !showLoading && !submitting && !showAiIntro) {
      navigate("/dashboard", { replace: true });
    }
  }, [isLoading, user, navigate, showLoading, submitting, showAiIntro]);

  // Authenticated users skip welcome and start at goals
  useEffect(() => {
    if (!isLoading && user && user.mustCompleteProfile && step === WELCOME_STEP) {
      setStep(1);
    }
  }, [isLoading, user, step]);

  const [otpSending, setOtpSending] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);

  const [data, setData] = useState<OnboardingData>({
    email: "",
    password: "",
    confirmPassword: "",
    goals: [],
    firstName: "",
    lastName: "",
    city: "",
    state: "",
    country: "",
    countryCode: "+1",
    phone: "",
    otp: ["", "", "", "", "", ""],
  });

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
    });
  };

  const goBack = () => {
    setDirection("back");
    setStep(prev => {
      const minStep = isRegistration ? WELCOME_STEP : 1;
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
      case 4: return data.phone.trim().length >= 7;
      case 5: return data.otp.every(d => d !== "");
      case ACCOUNT_STEP: return isValidEmail(data.email) && data.password.length >= 6 && data.confirmPassword === data.password;
      default: return false;
    }
  };

  const handleSubmit = async () => {
    setShowLoading(true);
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
          if (msg.includes("Email already in use")) {
            setRegistrationError("An account with this email already exists. Please login instead.");
          } else {
            setRegistrationError(msg || "Registration failed. Please try again.");
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

      await apiRequest("PUT", "/api/user/onboarding", {
        firstName: data.firstName.trim(),
        lastName: data.lastName.trim(),
        city: data.city.trim(),
        state: data.state.trim(),
        country: data.country.trim() || null,
        mobileNumber: `${data.countryCode} ${data.phone.trim()}`,
        interestedServices: data.goals,
      });

      await queryClient.invalidateQueries({ queryKey: ["/api/user"] });

      setTimeout(() => {
        setShowLoading(false);
        setShowAiIntro(true);
      }, 2000);
    } catch (err: any) {
      setShowLoading(false);
      setSubmitting(false);
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  const lastStep = isRegistration ? ACCOUNT_STEP : TOTAL_STEPS_AUTHENTICATED;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Enter" && canContinue() && !submitting && !otpSending) {
        e.preventDefault();
        handleContinue();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  const handleContinue = async () => {
    if (step === WELCOME_STEP) {
      goNext();
    } else if (step === ACCOUNT_STEP && isRegistration) {
      if (data.password !== data.confirmPassword) {
        setRegistrationError("Passwords do not match.");
        return;
      }
      if (data.password.length < 6) {
        setRegistrationError("Password must be at least 6 characters.");
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
        const fullPhone = `${data.countryCode}${data.phone.replace(/\D/g, "")}`;
        const res = await apiRequest("POST", "/api/auth/send-otp", { phone: fullPhone });
        const result = await res.json();
        if (result.devCode) {
          (window as any).__devOtpCode = result.devCode;
        }
        setOtpError(null);
        goNext();
      } catch (err: any) {
        let msg = "Please check your number and try again.";
        try {
          const parsed = JSON.parse(err.message.replace(/^\d+:\s*/, ""));
          if (parsed.message) msg = parsed.message;
        } catch { if (err.message) msg = err.message; }
        setOtpError(msg);
      } finally {
        setOtpSending(false);
      }
    } else if (step === 5) {
      const entered = data.otp.join("");
      setOtpSending(true);
      setOtpError(null);
      try {
        const fullPhone = `${data.countryCode}${data.phone.replace(/\D/g, "")}`;
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

  // Progress bar: steps 1-N (welcome step doesn't count)
  const stepsCompleted = Math.max(0, step - 1);
  const totalVisibleSteps = lastStep - 1;
  const progress = totalVisibleSteps > 0 ? (stepsCompleted / totalVisibleSteps) * 100 : 0;

  const brandName = brand?.siteName || "GoStork";

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
            We've saved your preferences. Now, let's meet your AI concierge.
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
    const concierge = matchmakers[0];
    const visibleServices = data.goals.filter(g => AI_INTRO_SERVICE_CONFIG[g]).slice(0, 2);
    if (visibleServices.length === 0) visibleServices.push("Fertility Clinic", "Egg Donor");
    if (visibleServices.length === 1) {
      const fallback = Object.keys(AI_INTRO_SERVICE_CONFIG).find(k => !visibleServices.includes(k));
      if (fallback) visibleServices.push(fallback);
    }
    const getImageUrl = (service: string): string | null => {
      const key = AI_INTRO_SERVICE_CONFIG[service]?.imageKey;
      if (!key || !brand) return null;
      return (brand as any)[key] || null;
    };
    return (
      <div className="fixed inset-0 bg-background flex flex-col items-center justify-between py-12 px-6" data-testid="onboarding-ai-intro">
        <div className="max-w-md w-full flex flex-col items-center flex-1">
          <h1 className="text-3xl md:text-4xl font-bold leading-tight text-center mb-8" style={{ fontFamily: "var(--font-display)" }} data-testid="text-ai-intro-title">
            Now let's meet your AI concierge
          </h1>
          <div className="relative w-72 h-72 mx-auto mb-6">
            <AiIntroServiceCard service={visibleServices[1]} imageUrl={getImageUrl(visibleServices[1])} style={{ left: "8px", top: "16px", transform: "rotate(-6deg)", zIndex: 1 }} />
            <AiIntroServiceCard service={visibleServices[0]} imageUrl={getImageUrl(visibleServices[0])} style={{ right: "8px", top: "0px", transform: "rotate(4deg)", zIndex: 2 }} />
            <div className="absolute bottom-0 left-0 right-0 z-10 flex items-end gap-2">
              {concierge?.avatarUrl ? (
                <img src={getPhotoSrc(concierge.avatarUrl) || undefined} alt={concierge.name} className="w-10 h-10 rounded-full object-cover border-2 border-background flex-shrink-0" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
              ) : (
                <div className="w-10 h-10 rounded-full bg-primary flex items-center justify-center flex-shrink-0 border-2 border-background">
                  <span className="text-primary-foreground text-sm font-bold">AI</span>
                </div>
              )}
              <div className="bg-muted rounded-[var(--radius)] rounded-bl-none px-4 py-3 shadow-sm max-w-[220px]">
                <p className="text-sm text-foreground">{AI_INTRO_SERVICE_CONFIG[visibleServices[0]]?.chatText || "I found a great match for you!"}</p>
              </div>
            </div>
          </div>
          <div className="flex justify-end w-full max-w-xs mb-8">
            <div className="bg-primary text-primary-foreground rounded-[var(--radius)] rounded-br-none px-4 py-2.5">
              <p className="text-sm">{AI_INTRO_SERVICE_CONFIG[visibleServices[0]]?.replyText || "Tell me more!"}</p>
            </div>
          </div>
          <p className="text-center text-muted-foreground text-xs leading-relaxed max-w-sm mx-auto">
            Our AI is not perfect yet. It can have some glitches.
          </p>
        </div>
        <div className="w-full max-w-md mt-6">
          <button
            onClick={() => navigate("/matchmaker-selection", { replace: true })}
            data-testid="btn-ai-intro-continue"
            className="w-full py-4 rounded-full text-lg font-semibold bg-primary text-primary-foreground hover:bg-primary/90 active:scale-[0.98] transition-all duration-200"
          >
            Continue
          </button>
        </div>
      </div>
    );
  }

  // Welcome step - full-screen, no progress bar
  if (step === WELCOME_STEP) {
    return (
      <div className="fixed inset-0 bg-background flex flex-col items-center justify-center px-6" data-testid="onboarding-welcome">
        <div className="max-w-md text-center space-y-6">
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
          <p className="text-muted-foreground text-base">
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
              <span className="text-foreground font-medium">AI finds your best matches</span>
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
              <span className="text-foreground font-medium">Book a free consultation</span>
            </div>
          </div>

          <button
            onClick={() => goNext()}
            data-testid="btn-welcome-start"
            className="w-full py-4 rounded-full text-lg font-semibold bg-primary text-primary-foreground hover:bg-primary/90 active:scale-[0.98] transition-all duration-200"
          >
            Get Started
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-background flex flex-col items-center" data-testid="onboarding-page">
      <div className="w-full max-w-lg flex flex-col flex-1 min-h-0">
      <div className="flex items-center px-4 pt-4 pb-2">
        {step > (isRegistration ? WELCOME_STEP : 1) && (
          <button
            onClick={goBack}
            className="p-2 -ml-2 rounded-full hover:bg-muted transition-colors"
            data-testid="btn-onboarding-back"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
        )}
        <div className="flex-1" />
      </div>

      <div className="px-6 mb-6">
        <div className="w-full h-1 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-primary rounded-full transition-all duration-500 ease-out"
            style={{ width: `${progress}%` }}
            data-testid="progress-bar"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-8">
        <div
          key={step}
          className="animate-in fade-in slide-in-from-right-4 duration-300"
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
              countryCode={data.countryCode}
              phone={data.phone}
              onCountryCodeChange={v => { update({ countryCode: v }); setOtpError(null); }}
              onPhoneChange={v => { update({ phone: v }); setOtpError(null); }}
              error={otpError}
            />
          )}
          {step === 5 && (
            <StepVerification
              otp={data.otp}
              onChange={v => { update({ otp: v }); setOtpError(null); }}
              phone={`${data.countryCode} ${data.phone}`}
              onResend={async () => {
                setOtpError(null);
                const fullPhone = `${data.countryCode}${data.phone.replace(/\D/g, "")}`;
                await apiRequest("POST", "/api/auth/send-otp", { phone: fullPhone });
              }}
              error={otpError}
            />
          )}
          {step === ACCOUNT_STEP && isRegistration && (
            <StepAccount
              email={data.email}
              password={data.password}
              confirmPassword={data.confirmPassword}
              onEmailChange={v => { update({ email: v }); setRegistrationError(null); }}
              onPasswordChange={v => { update({ password: v }); setRegistrationError(null); }}
              onConfirmPasswordChange={v => { update({ confirmPassword: v }); setRegistrationError(null); }}
              error={registrationError}
            />
          )}
        </div>
      </div>

      {step <= lastStep && (
        <div className="px-6 pb-8 pt-2">
          <button
            onClick={handleContinue}
            disabled={!canContinue() || submitting || otpSending}
            data-testid="btn-onboarding-continue"
            className={`w-full py-4 rounded-full text-lg font-semibold transition-all duration-200 ${
              canContinue()
                ? "bg-primary text-primary-foreground hover:bg-primary/90 active:scale-[0.98]"
                : "bg-muted text-muted-foreground cursor-not-allowed"
            }`}
          >
            {submitting || otpSending ? (
              <Loader2 className="w-5 h-5 animate-spin mx-auto" />
            ) : step === 4 ? (
              "Verify phone number"
            ) : step === ACCOUNT_STEP ? (
              "Create Account & Finish"
            ) : (
              "Continue"
            )}
          </button>
          {step === ACCOUNT_STEP && isRegistration && (
            <p className="text-center text-sm text-muted-foreground mt-4">
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
  email,
  password,
  confirmPassword,
  onEmailChange,
  onPasswordChange,
  onConfirmPasswordChange,
  error,
}: {
  email: string;
  password: string;
  confirmPassword: string;
  onEmailChange: (v: string) => void;
  onPasswordChange: (v: string) => void;
  onConfirmPasswordChange: (v: string) => void;
  error: string | null;
}) {
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  return (
    <div>
      <h1
        className="text-3xl font-bold mb-2 leading-tight"
        style={{ fontFamily: "var(--font-display)" }}
        data-testid="text-step-title"
      >
        Create your account
      </h1>
      <p className="text-muted-foreground mb-8 text-sm">Enter your email and choose a password to get started.</p>
      <div className="space-y-6">
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">Email</label>
          <input
            type="email"
            value={email}
            onChange={e => onEmailChange(e.target.value)}
            placeholder="you@example.com"
            autoFocus
            data-testid="input-register-email"
            className="w-full text-lg border-0 border-b-2 border-border focus:border-primary outline-none pb-3 bg-transparent placeholder:text-muted-foreground/40 transition-colors"
          />
          {email.length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && (
            <p className="text-sm text-destructive mt-1" data-testid="text-email-hint">Please enter a valid email address</p>
          )}
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">Password</label>
          <div className="relative">
            <input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={e => onPasswordChange(e.target.value)}
              placeholder="At least 6 characters"
              data-testid="input-register-password"
              className="w-full text-lg border-0 border-b-2 border-border focus:border-primary outline-none pb-3 bg-transparent placeholder:text-muted-foreground/40 transition-colors pr-10"
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
          {password.length > 0 && password.length < 6 && (
            <p className="text-sm text-destructive mt-1" data-testid="text-password-hint">Password must be at least 6 characters</p>
          )}
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">Confirm Password</label>
          <div className="relative">
            <input
              type={showConfirm ? "text" : "password"}
              value={confirmPassword}
              onChange={e => onConfirmPasswordChange(e.target.value)}
              placeholder="Re-enter your password"
              data-testid="input-register-confirm-password"
              className="w-full text-lg border-0 border-b-2 border-border focus:border-primary outline-none pb-3 bg-transparent placeholder:text-muted-foreground/40 transition-colors pr-10"
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
            <p className="text-sm text-destructive mt-1" data-testid="text-confirm-hint">Passwords do not match</p>
          )}
        </div>
        {error && (
          <p className="text-sm text-destructive" data-testid="text-register-error">{error}</p>
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
        className="text-3xl font-bold mb-8 leading-tight"
        style={{ fontFamily: "var(--font-display)" }}
        data-testid="text-step-title"
      >
        What are you looking for?
      </h1>
      <p className="text-muted-foreground mb-8 text-sm -mt-6">Select all that apply</p>
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
        className="text-3xl font-bold mb-2 leading-tight"
        style={{ fontFamily: "var(--font-display)" }}
        data-testid="text-step-title"
      >
        What's your name?
      </h1>
      <p className="text-muted-foreground mb-8 text-sm">Please use your real name - providers will see it when you connect</p>
      <div className="space-y-6">
        <input
          type="text"
          value={firstName}
          onChange={e => onFirstNameChange(e.target.value)}
          placeholder="First name"
          autoFocus
          data-testid="input-first-name"
          className="w-full text-lg border-0 border-b-2 border-border focus:border-primary outline-none pb-3 bg-transparent placeholder:text-muted-foreground/40 transition-colors"
        />
        <input
          type="text"
          value={lastName}
          onChange={e => onLastNameChange(e.target.value)}
          placeholder="Last name"
          data-testid="input-last-name"
          className="w-full text-lg border-0 border-b-2 border-border focus:border-primary outline-none pb-3 bg-transparent placeholder:text-muted-foreground/40 transition-colors"
        />
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
        className="text-3xl font-bold mb-8 leading-tight"
        style={{ fontFamily: "var(--font-display)" }}
        data-testid="text-step-title"
      >
        Where are you currently living?
      </h1>
      <LocationAutocomplete
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
  countryCode,
  phone,
  onCountryCodeChange,
  onPhoneChange,
  error,
}: {
  countryCode: string;
  phone: string;
  onCountryCodeChange: (v: string) => void;
  onPhoneChange: (v: string) => void;
  error?: string | null;
}) {
  const [showCodes, setShowCodes] = useState(false);
  const selected = COUNTRY_CODES.find(c => c.code === countryCode) || COUNTRY_CODES[0];

  return (
    <div>
      <h1
        className="text-3xl font-bold mb-2 leading-tight"
        style={{ fontFamily: "var(--font-display)" }}
        data-testid="text-step-title"
      >
        What's your phone number?
      </h1>
      <p className="text-muted-foreground mb-8 text-sm">
        We will send you a verification code on this number. We make sure our users are real people
      </p>

      <div className="flex items-end gap-4 mb-8">
        <div className="relative">
          <button
            type="button"
            onClick={() => setShowCodes(!showCodes)}
            className="text-lg border-b-2 border-border pb-3 flex items-center gap-1 hover:border-primary transition-colors whitespace-nowrap"
            data-testid="btn-country-code"
          >
            {selected.label} {selected.code} <ChevronLeft className="w-4 h-4 rotate-[-90deg]" />
          </button>
          {showCodes && (
            <div className="absolute top-full left-0 mt-1 bg-background border border-border rounded-[var(--radius)] shadow-lg z-10 max-h-48 overflow-y-auto w-48">
              {COUNTRY_CODES.map(cc => (
                <button
                  key={cc.code}
                  type="button"
                  onClick={() => { onCountryCodeChange(cc.code); setShowCodes(false); }}
                  className="w-full text-left px-3 py-2 hover:bg-muted flex items-center gap-2 text-sm"
                  data-testid={`country-${cc.label.toLowerCase()}`}
                >
                  <span>{cc.flag}</span>
                  <span>{cc.label}</span>
                  <span className="text-muted-foreground">{cc.code}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <input
          type="tel"
          value={phone}
          onChange={e => onPhoneChange(e.target.value)}
          placeholder="(555) 123-4567"
          autoFocus
          data-testid="input-phone"
          className="flex-1 text-lg border-0 border-b-2 border-border focus:border-primary outline-none pb-3 bg-transparent placeholder:text-muted-foreground/40 transition-colors"
        />
      </div>

      {error && (
        <p className="text-destructive text-sm mb-4 flex items-center gap-2" data-testid="text-phone-error">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </p>
      )}

    </div>
  );
}

function StepVerification({
  otp,
  onChange,
  phone,
  onResend,
  error,
}: {
  otp: string[];
  onChange: (v: string[]) => void;
  phone: string;
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
        className="text-3xl font-bold mb-2 leading-tight"
        style={{ fontFamily: "var(--font-display)" }}
        data-testid="text-step-title"
      >
        Enter the code you received
      </h1>
      <p className="text-muted-foreground mb-10">Sent to {phone}</p>

      <OtpInput value={otp} onChange={onChange} />

      {error && (
        <p className="text-destructive text-sm mt-4 flex items-center gap-2 justify-center" data-testid="text-otp-error">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </p>
      )}

      <p className={`text-center text-muted-foreground text-sm ${error ? "mt-4" : "mt-12"}`}>
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
