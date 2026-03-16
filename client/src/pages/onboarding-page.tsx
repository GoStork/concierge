import { useState, useRef, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { api } from "@shared/routes";
import { ChevronLeft, Loader2, Lock, Check, Eye, EyeOff, AlertCircle } from "lucide-react";
import LocationAutocomplete from "@/components/location-autocomplete";

const TOTAL_STEPS_AUTHENTICATED = 12;
const TOTAL_STEPS_UNAUTHENTICATED = 13;
const ACCOUNT_STEP = 13;

const GOALS = ["Fertility Clinic", "Egg Donor", "Surrogate", "Sperm Donor"];
const GENDERS = ["I'm a woman", "I'm a man", "I'm non-binary"];
const ORIENTATIONS = ["Straight", "Gay", "Lesbian", "Bi", "Queer"];
const RELATIONSHIPS = ["Single", "Partnered", "Married", "Separated/Divorced/Widowed"];
const SOURCES = ["Google", "Social Media", "Friend", "Other"];

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);
const currentYear = new Date().getFullYear();
const YEARS = Array.from({ length: 100 }, (_, i) => currentYear - i);

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
  birthMonth: number;
  birthDay: number;
  birthYear: number;
  gender: string;
  orientation: string;
  relationship: string;
  partnerFirstName: string;
  partnerAge: string;
  city: string;
  state: string;
  country: string;
  countryCode: string;
  phone: string;
  otp: string[];
  source: string;
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

function ScrollWheel({
  items,
  selectedIndex,
  onSelect,
  formatItem,
  testIdPrefix,
}: {
  items: any[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  formatItem?: (item: any) => string;
  testIdPrefix: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const itemHeight = 44;
  const visibleCount = 5;
  const scrolling = useRef(false);

  useEffect(() => {
    if (containerRef.current && !scrolling.current) {
      containerRef.current.scrollTop = selectedIndex * itemHeight;
    }
  }, [selectedIndex]);

  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    scrolling.current = true;
    const scrollTop = containerRef.current.scrollTop;
    const index = Math.round(scrollTop / itemHeight);
    const clamped = Math.max(0, Math.min(items.length - 1, index));
    if (clamped !== selectedIndex) {
      onSelect(clamped);
    }
    clearTimeout((containerRef.current as any)._scrollTimer);
    (containerRef.current as any)._scrollTimer = setTimeout(() => {
      scrolling.current = false;
      if (containerRef.current) {
        containerRef.current.scrollTo({ top: clamped * itemHeight, behavior: "smooth" });
      }
    }, 100);
  }, [items.length, selectedIndex, onSelect]);

  return (
    <div className="relative" style={{ height: visibleCount * itemHeight }}>
      <div
        className="absolute left-0 right-0 bg-muted rounded-lg pointer-events-none z-0"
        style={{ top: Math.floor(visibleCount / 2) * itemHeight, height: itemHeight }}
      />
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="absolute inset-0 overflow-y-scroll scrollbar-hide snap-y snap-mandatory"
        style={{ paddingTop: Math.floor(visibleCount / 2) * itemHeight, paddingBottom: Math.floor(visibleCount / 2) * itemHeight }}
        data-testid={testIdPrefix}
      >
        {items.map((item, i) => {
          const distance = Math.abs(i - selectedIndex);
          const opacity = distance === 0 ? 1 : distance === 1 ? 0.5 : 0.25;
          const scale = distance === 0 ? 1 : distance === 1 ? 0.9 : 0.85;
          return (
            <div
              key={i}
              className="flex items-center justify-center snap-center cursor-pointer select-none font-medium"
              style={{ height: itemHeight, opacity, transform: `scale(${scale})`, transition: "all 0.15s" }}
              onClick={() => onSelect(i)}
              data-testid={`${testIdPrefix}-item-${i}`}
            >
              <span className="text-lg">{formatItem ? formatItem(item) : String(item)}</span>
            </div>
          );
        })}
      </div>
    </div>
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
  const isRegistration = !user;
  const firstStep = 1;
  const [step, setStep] = useState(firstStep);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [submitting, setSubmitting] = useState(false);
  const [showLoading, setShowLoading] = useState(false);
  const [registrationError, setRegistrationError] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading && user && !user.mustCompleteProfile) {
      navigate("/dashboard", { replace: true });
    }
  }, [isLoading, user, navigate]);
  const [otpSending, setOtpSending] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);

  const [data, setData] = useState<OnboardingData>({
    email: "",
    password: "",
    confirmPassword: "",
    goals: [],
    firstName: "",
    lastName: "",
    birthMonth: 0,
    birthDay: 11,
    birthYear: 30,
    gender: "",
    orientation: "",
    relationship: "",
    partnerFirstName: "",
    partnerAge: "",
    city: "",
    state: "",
    country: "",
    countryCode: "+1",
    phone: "",
    otp: ["", "", "", "", "", ""],
    source: "",
  });

  const update = (partial: Partial<OnboardingData>) => {
    setRegistrationError(null);
    setData(prev => ({ ...prev, ...partial }));
  };

  const effectiveStep = (s: number): number => {
    if (s === 8 && data.relationship !== "Partnered" && data.relationship !== "Married") {
      return direction === "forward" ? effectiveStep(9) : effectiveStep(7);
    }
    return s;
  };

  const goNext = () => {
    setDirection("forward");
    setStep(prev => {
      let next = prev + 1;
      const lastStep = isRegistration ? ACCOUNT_STEP : TOTAL_STEPS_AUTHENTICATED;
      if (next > lastStep) return prev;
      next = effectiveStep(next);
      return next;
    });
  };

  const goBack = () => {
    setDirection("back");
    setStep(prev => {
      let next = prev - 1;
      if (next < firstStep) return prev;
      if (next === 8 && data.relationship !== "Partnered" && data.relationship !== "Married") {
        next = 7;
      }
      return next;
    });
  };

  const isValidEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  const canContinue = (): boolean => {
    switch (step) {
      case 1: return data.goals.length > 0;
      case 2: return data.firstName.trim().length > 0;
      case 3: return data.lastName.trim().length > 0;
      case 4: return true;
      case 5: return data.gender !== "";
      case 6: return data.orientation !== "";
      case 7: return data.relationship !== "";
      case 8: return data.partnerFirstName.trim().length > 0 && data.partnerAge.trim().length > 0;
      case 9: return data.city.trim().length > 0;
      case 10: return data.phone.trim().length >= 7;
      case 11: return data.otp.every(d => d !== "");
      case 12: return data.source !== "";
      case ACCOUNT_STEP: return isValidEmail(data.email) && data.password.length >= 6 && data.confirmPassword === data.password;
      default: return false;
    }
  };

  const handleSubmit = async () => {
    setShowLoading(true);
    setSubmitting(true);

    const birthDate = new Date(YEARS[data.birthYear], data.birthMonth, DAYS[data.birthDay]);

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
            toast({ title: "Email already in use", description: "An account with this email already exists. Please login instead.", variant: "destructive" });
          } else {
            toast({ title: "Registration failed", description: msg, variant: "destructive" });
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
        dateOfBirth: birthDate.toISOString(),
        gender: data.gender,
        sexualOrientation: data.orientation,
        relationshipStatus: data.relationship,
        partnerFirstName: data.partnerFirstName.trim() || null,
        partnerAge: data.partnerAge ? parseInt(data.partnerAge) : null,
        city: data.city.trim(),
        state: data.state.trim(),
        country: data.country.trim() || null,
        mobileNumber: `${data.countryCode} ${data.phone.trim()}`,
        referralSource: data.source,
        interestedServices: data.goals,
      });

      await queryClient.invalidateQueries({ queryKey: ["/api/user"] });

      setTimeout(() => {
        navigate("/matchmaker-selection", { replace: true });
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
    if (step === ACCOUNT_STEP && isRegistration) {
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
    } else if (step === 10) {
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
    } else if (step === 11) {
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

  const stepsCompleted = step - firstStep;
  const totalVisibleSteps = lastStep - firstStep;
  const progress = totalVisibleSteps > 0 ? ((stepsCompleted) / totalVisibleSteps) * 100 : 0;

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
            We've saved your preferences. Now, let's choose a guide to help you start your journey.
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

  return (
    <div className="fixed inset-0 bg-background flex flex-col items-center" data-testid="onboarding-page">
      <div className="w-full max-w-lg flex flex-col flex-1 min-h-0">
      <div className="flex items-center px-4 pt-4 pb-2">
        {step > firstStep && (
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
            <StepFirstName value={data.firstName} onChange={v => update({ firstName: v })} />
          )}
          {step === 3 && (
            <StepLastName value={data.lastName} onChange={v => update({ lastName: v })} />
          )}
          {step === 4 && (
            <StepBirthDate
              month={data.birthMonth}
              day={data.birthDay}
              year={data.birthYear}
              onMonthChange={v => update({ birthMonth: v })}
              onDayChange={v => update({ birthDay: v })}
              onYearChange={v => update({ birthYear: v })}
            />
          )}
          {step === 5 && (
            <StepGender value={data.gender} onChange={v => update({ gender: v })} />
          )}
          {step === 6 && (
            <StepOrientation value={data.orientation} onChange={v => update({ orientation: v })} />
          )}
          {step === 7 && (
            <StepRelationship value={data.relationship} onChange={v => update({ relationship: v })} />
          )}
          {step === 8 && (
            <StepPartner
              firstName={data.partnerFirstName}
              age={data.partnerAge}
              onFirstNameChange={v => update({ partnerFirstName: v })}
              onAgeChange={v => update({ partnerAge: v })}
            />
          )}
          {step === 9 && (
            <StepLocation
              value={{ address: "", city: data.city, state: data.state, zip: "", country: data.country }}
              onChange={loc => update({ city: loc.city, state: loc.state, country: loc.country })}
            />
          )}
          {step === 10 && (
            <StepPhone
              countryCode={data.countryCode}
              phone={data.phone}
              onCountryCodeChange={v => { update({ countryCode: v }); setOtpError(null); }}
              onPhoneChange={v => { update({ phone: v }); setOtpError(null); }}
              error={otpError}
            />
          )}
          {step === 11 && (
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
          {step === 12 && (
            <StepSource value={data.source} onChange={v => update({ source: v })} />
          )}
          {step === ACCOUNT_STEP && isRegistration && (
            <StepAccount
              email={data.email}
              password={data.password}
              confirmPassword={data.confirmPassword}
              onEmailChange={v => update({ email: v })}
              onPasswordChange={v => update({ password: v })}
              onConfirmPasswordChange={v => update({ confirmPassword: v })}
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
            ) : step === 10 ? (
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
        How can we help you build your family?
      </h1>
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

function StepFirstName({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <h1
        className="text-3xl font-bold mb-2 leading-tight"
        style={{ fontFamily: "var(--font-display)" }}
        data-testid="text-step-title"
      >
        What's your first name?
      </h1>
      <p className="text-muted-foreground mb-8 text-sm">Your name cannot be changed later</p>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="First name"
        autoFocus
        data-testid="input-first-name"
        className="w-full text-lg border-0 border-b-2 border-border focus:border-primary outline-none pb-3 bg-transparent placeholder:text-muted-foreground/40 transition-colors"
      />
    </div>
  );
}

function StepLastName({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <h1
        className="text-3xl font-bold mb-8 leading-tight"
        style={{ fontFamily: "var(--font-display)" }}
        data-testid="text-step-title"
      >
        And your last name?
      </h1>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="Last name"
        autoFocus
        data-testid="input-last-name"
        className="w-full text-lg border-0 border-b-2 border-border focus:border-primary outline-none pb-3 bg-transparent placeholder:text-muted-foreground/40 transition-colors"
      />
    </div>
  );
}

function StepBirthDate({
  month,
  day,
  year,
  onMonthChange,
  onDayChange,
  onYearChange,
}: {
  month: number;
  day: number;
  year: number;
  onMonthChange: (v: number) => void;
  onDayChange: (v: number) => void;
  onYearChange: (v: number) => void;
}) {
  return (
    <div>
      <h1
        className="text-3xl font-bold mb-8 leading-tight"
        style={{ fontFamily: "var(--font-display)" }}
        data-testid="text-step-title"
      >
        What's your birth date?
      </h1>
      <div className="grid grid-cols-3 gap-4">
        <ScrollWheel
          items={MONTHS}
          selectedIndex={month}
          onSelect={onMonthChange}
          testIdPrefix="scroll-month"
        />
        <ScrollWheel
          items={DAYS}
          selectedIndex={day}
          onSelect={onDayChange}
          testIdPrefix="scroll-day"
        />
        <ScrollWheel
          items={YEARS}
          selectedIndex={year}
          onSelect={onYearChange}
          testIdPrefix="scroll-year"
        />
      </div>
    </div>
  );
}

function StepGender({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <h1
        className="text-3xl font-bold mb-8 leading-tight"
        style={{ fontFamily: "var(--font-display)" }}
        data-testid="text-step-title"
      >
        How do you identify?
      </h1>
      <div className="space-y-3">
        {GENDERS.map(g => (
          <PillButton
            key={g}
            label={g}
            selected={value === g}
            onClick={() => onChange(g)}
            data-testid={`pill-gender-${g.toLowerCase().replace(/['\s]+/g, "-")}`}
          />
        ))}
      </div>
    </div>
  );
}

function StepOrientation({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <h1
        className="text-3xl font-bold mb-8 leading-tight"
        style={{ fontFamily: "var(--font-display)" }}
        data-testid="text-step-title"
      >
        What is your sexual orientation?
      </h1>
      <div className="space-y-3">
        {ORIENTATIONS.map(o => (
          <PillButton
            key={o}
            label={o}
            selected={value === o}
            onClick={() => onChange(o)}
            data-testid={`pill-orientation-${o.toLowerCase()}`}
          />
        ))}
      </div>
    </div>
  );
}

function StepRelationship({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <h1
        className="text-3xl font-bold mb-8 leading-tight"
        style={{ fontFamily: "var(--font-display)" }}
        data-testid="text-step-title"
      >
        What is your relationship status?
      </h1>
      <div className="space-y-3">
        {RELATIONSHIPS.map(r => (
          <PillButton
            key={r}
            label={r}
            selected={value === r}
            onClick={() => onChange(r)}
            data-testid={`pill-relationship-${r.toLowerCase().replace(/[/\s]+/g, "-")}`}
          />
        ))}
      </div>
    </div>
  );
}

function StepPartner({
  firstName,
  age,
  onFirstNameChange,
  onAgeChange,
}: {
  firstName: string;
  age: string;
  onFirstNameChange: (v: string) => void;
  onAgeChange: (v: string) => void;
}) {
  return (
    <div>
      <h1
        className="text-3xl font-bold mb-8 leading-tight"
        style={{ fontFamily: "var(--font-display)" }}
        data-testid="text-step-title"
      >
        Tell us about your partner.
      </h1>
      <div className="space-y-6">
        <div>
          <input
            type="text"
            value={firstName}
            onChange={e => onFirstNameChange(e.target.value)}
            placeholder="Partner's first name"
            autoFocus
            data-testid="input-partner-name"
            className="w-full text-lg border-0 border-b-2 border-border focus:border-primary outline-none pb-3 bg-transparent placeholder:text-muted-foreground/40 transition-colors"
          />
        </div>
        <div>
          <input
            type="number"
            value={age}
            onChange={e => onAgeChange(e.target.value)}
            placeholder="Partner's age"
            data-testid="input-partner-age"
            className="w-full text-lg border-0 border-b-2 border-border focus:border-primary outline-none pb-3 bg-transparent placeholder:text-muted-foreground/40 transition-colors"
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
            <div className="absolute top-full left-0 mt-1 bg-background border border-border rounded-lg shadow-lg z-10 max-h-48 overflow-y-auto w-48">
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

      <div className="flex items-center gap-2 text-muted-foreground text-sm justify-center">
        <Lock className="w-4 h-4" />
        <span>Your number will never be shared with anyone</span>
      </div>
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

function StepSource({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <h1
        className="text-3xl font-bold mb-8 leading-tight"
        style={{ fontFamily: "var(--font-display)" }}
        data-testid="text-step-title"
      >
        How did you hear about GoStork?
      </h1>
      <div className="space-y-3">
        {SOURCES.map(s => (
          <PillButton
            key={s}
            label={s}
            selected={value === s}
            onClick={() => onChange(s)}
            data-testid={`pill-source-${s.toLowerCase().replace(/\s+/g, "-")}`}
          />
        ))}
      </div>
    </div>
  );
}
