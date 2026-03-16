import { useState, useRef, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { api } from "@shared/routes";
import { ChevronLeft, Loader2, Lock, Check, Eye, EyeOff } from "lucide-react";

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
          ? "bg-black text-white shadow-md"
          : "bg-gray-100 text-gray-800 hover:bg-gray-200"
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
        className="absolute left-0 right-0 bg-gray-100 rounded-lg pointer-events-none z-0"
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
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  const handleChange = (index: number, char: string) => {
    if (!/^\d?$/.test(char)) return;
    const next = [...value];
    next[index] = char;
    onChange(next);
    if (char && index < 5) {
      refs.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !value[index] && index > 0) {
      refs.current[index - 1]?.focus();
    }
  };

  return (
    <div className="flex gap-3 justify-center">
      {value.map((digit, i) => (
        <input
          key={i}
          ref={el => { refs.current[i] = el; }}
          type="text"
          inputMode="numeric"
          maxLength={1}
          value={digit}
          onChange={e => handleChange(i, e.target.value)}
          onKeyDown={e => handleKeyDown(i, e)}
          data-testid={`input-otp-${i}`}
          className="w-12 h-14 text-center text-2xl font-semibold border-b-2 border-gray-300 focus:border-black outline-none bg-transparent transition-colors"
        />
      ))}
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
  const [mockOtp] = useState(() => {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    return code;
  });

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
      case 9: return data.city.trim().length > 0 && data.state.trim().length > 0;
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
    } else if (step === 11) {
      const entered = data.otp.join("");
      if (entered === mockOtp) {
        goNext();
      } else {
        toast({ title: "Invalid code", description: "Please enter the correct verification code.", variant: "destructive" });
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
      <div className="fixed inset-0 bg-white flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
      </div>
    );
  }

  if (showLoading) {
    return (
      <div className="fixed inset-0 bg-white flex flex-col items-center justify-center z-50">
        <div className="animate-[fadeIn_0.8s_ease-out_forwards] opacity-0 text-center px-8">
          <h1 className="text-3xl md:text-4xl font-bold mb-4" style={{ fontFamily: "var(--font-display)" }}>
            Welcome to the family{data.firstName ? `, ${data.firstName}` : ""}.
          </h1>
          <p className="text-gray-500 text-lg">
            We've saved your preferences. Now, let's choose a guide to help you start your journey.
          </p>
        </div>
        <div className="mt-8 animate-[fadeIn_1.2s_ease-out_forwards] opacity-0">
          <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
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
    <div className="fixed inset-0 bg-white flex flex-col" data-testid="onboarding-page">
      <div className="flex items-center px-4 pt-4 pb-2">
        {step > firstStep && (
          <button
            onClick={goBack}
            className="p-2 -ml-2 rounded-full hover:bg-gray-100 transition-colors"
            data-testid="btn-onboarding-back"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
        )}
        <div className="flex-1" />
      </div>

      <div className="px-6 mb-6">
        <div className="w-full h-1 bg-gray-200 rounded-full overflow-hidden">
          <div
            className="h-full bg-black rounded-full transition-all duration-500 ease-out"
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
              city={data.city}
              state={data.state}
              onCityChange={v => update({ city: v })}
              onStateChange={v => update({ state: v })}
            />
          )}
          {step === 10 && (
            <StepPhone
              countryCode={data.countryCode}
              phone={data.phone}
              onCountryCodeChange={v => update({ countryCode: v })}
              onPhoneChange={v => update({ phone: v })}
              mockOtp={mockOtp}
            />
          )}
          {step === 11 && (
            <StepVerification
              otp={data.otp}
              onChange={v => update({ otp: v })}
              phone={`${data.countryCode} ${data.phone}`}
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
            disabled={!canContinue() || submitting}
            data-testid="btn-onboarding-continue"
            className={`w-full py-4 rounded-full text-lg font-semibold transition-all duration-200 ${
              canContinue()
                ? "bg-black text-white hover:bg-gray-800 active:scale-[0.98]"
                : "bg-gray-200 text-gray-400 cursor-not-allowed"
            }`}
          >
            {submitting ? (
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
            <p className="text-center text-sm text-gray-500 mt-4">
              Already have an account?{" "}
              <button
                type="button"
                onClick={() => navigate("/")}
                className="text-black font-medium hover:underline"
                data-testid="link-back-to-login"
              >
                Login
              </button>
            </p>
          )}
        </div>
      )}
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
      <p className="text-gray-500 mb-8 text-sm">Enter your email and choose a password to get started.</p>
      <div className="space-y-6">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
          <input
            type="email"
            value={email}
            onChange={e => onEmailChange(e.target.value)}
            placeholder="you@example.com"
            autoFocus
            data-testid="input-register-email"
            className="w-full text-lg border-0 border-b-2 border-gray-300 focus:border-black outline-none pb-3 bg-transparent placeholder:text-gray-300 transition-colors"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
          <div className="relative">
            <input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={e => onPasswordChange(e.target.value)}
              placeholder="At least 6 characters"
              data-testid="input-register-password"
              className="w-full text-lg border-0 border-b-2 border-gray-300 focus:border-black outline-none pb-3 bg-transparent placeholder:text-gray-300 transition-colors pr-10"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-0 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
              data-testid="btn-toggle-password"
            >
              {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
            </button>
          </div>
          {password.length > 0 && password.length < 6 && (
            <p className="text-sm text-red-500 mt-1" data-testid="text-password-hint">Password must be at least 6 characters</p>
          )}
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Confirm Password</label>
          <div className="relative">
            <input
              type={showConfirm ? "text" : "password"}
              value={confirmPassword}
              onChange={e => onConfirmPasswordChange(e.target.value)}
              placeholder="Re-enter your password"
              data-testid="input-register-confirm-password"
              className="w-full text-lg border-0 border-b-2 border-gray-300 focus:border-black outline-none pb-3 bg-transparent placeholder:text-gray-300 transition-colors pr-10"
            />
            <button
              type="button"
              onClick={() => setShowConfirm(!showConfirm)}
              className="absolute right-0 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
              data-testid="btn-toggle-confirm-password"
            >
              {showConfirm ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
            </button>
          </div>
          {confirmPassword.length > 0 && confirmPassword !== password && (
            <p className="text-sm text-red-500 mt-1" data-testid="text-confirm-hint">Passwords do not match</p>
          )}
        </div>
        {error && (
          <p className="text-sm text-red-500" data-testid="text-register-error">{error}</p>
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
      <p className="text-gray-500 mb-8 text-sm">Your name cannot be changed later</p>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="First name"
        autoFocus
        data-testid="input-first-name"
        className="w-full text-lg border-0 border-b-2 border-gray-300 focus:border-black outline-none pb-3 bg-transparent placeholder:text-gray-300 transition-colors"
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
        className="w-full text-lg border-0 border-b-2 border-gray-300 focus:border-black outline-none pb-3 bg-transparent placeholder:text-gray-300 transition-colors"
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
            className="w-full text-lg border-0 border-b-2 border-gray-300 focus:border-black outline-none pb-3 bg-transparent placeholder:text-gray-300 transition-colors"
          />
        </div>
        <div>
          <input
            type="number"
            value={age}
            onChange={e => onAgeChange(e.target.value)}
            placeholder="Partner's age"
            data-testid="input-partner-age"
            className="w-full text-lg border-0 border-b-2 border-gray-300 focus:border-black outline-none pb-3 bg-transparent placeholder:text-gray-300 transition-colors"
          />
        </div>
      </div>
    </div>
  );
}

function StepLocation({
  city,
  state,
  onCityChange,
  onStateChange,
}: {
  city: string;
  state: string;
  onCityChange: (v: string) => void;
  onStateChange: (v: string) => void;
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
      <div className="space-y-6">
        <input
          type="text"
          value={city}
          onChange={e => onCityChange(e.target.value)}
          placeholder="City"
          autoFocus
          data-testid="input-city"
          className="w-full text-lg border-0 border-b-2 border-gray-300 focus:border-black outline-none pb-3 bg-transparent placeholder:text-gray-300 transition-colors"
        />
        <input
          type="text"
          value={state}
          onChange={e => onStateChange(e.target.value)}
          placeholder="State / Province"
          data-testid="input-state"
          className="w-full text-lg border-0 border-b-2 border-gray-300 focus:border-black outline-none pb-3 bg-transparent placeholder:text-gray-300 transition-colors"
        />
      </div>
    </div>
  );
}

function StepPhone({
  countryCode,
  phone,
  onCountryCodeChange,
  onPhoneChange,
  mockOtp,
}: {
  countryCode: string;
  phone: string;
  onCountryCodeChange: (v: string) => void;
  onPhoneChange: (v: string) => void;
  mockOtp: string;
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
      <p className="text-gray-500 mb-8 text-sm">
        We will send you a verification code on this number. We make sure our users are real people
      </p>

      <div className="flex items-end gap-4 mb-8">
        <div className="relative">
          <button
            type="button"
            onClick={() => setShowCodes(!showCodes)}
            className="text-lg border-b-2 border-gray-300 pb-3 flex items-center gap-1 hover:border-black transition-colors whitespace-nowrap"
            data-testid="btn-country-code"
          >
            {selected.label} {selected.code} <ChevronLeft className="w-4 h-4 rotate-[-90deg]" />
          </button>
          {showCodes && (
            <div className="absolute top-full left-0 mt-1 bg-white border rounded-lg shadow-lg z-10 max-h-48 overflow-y-auto w-48">
              {COUNTRY_CODES.map(cc => (
                <button
                  key={cc.code}
                  type="button"
                  onClick={() => { onCountryCodeChange(cc.code); setShowCodes(false); }}
                  className="w-full text-left px-3 py-2 hover:bg-gray-100 flex items-center gap-2 text-sm"
                  data-testid={`country-${cc.label.toLowerCase()}`}
                >
                  <span>{cc.flag}</span>
                  <span>{cc.label}</span>
                  <span className="text-gray-400">{cc.code}</span>
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
          className="flex-1 text-lg border-0 border-b-2 border-gray-300 focus:border-black outline-none pb-3 bg-transparent placeholder:text-gray-300 transition-colors"
        />
      </div>

      <div className="flex items-center gap-2 text-gray-500 text-sm justify-center">
        <Lock className="w-4 h-4" />
        <span>Your number will never be shared with anyone</span>
      </div>

      <div className="mt-6 p-3 bg-blue-50 rounded-lg text-sm text-blue-800 text-center">
        Demo mode: Your verification code is <strong>{mockOtp}</strong>
      </div>
    </div>
  );
}

function StepVerification({
  otp,
  onChange,
  phone,
}: {
  otp: string[];
  onChange: (v: string[]) => void;
  phone: string;
}) {
  return (
    <div>
      <h1
        className="text-3xl font-bold mb-2 leading-tight"
        style={{ fontFamily: "var(--font-display)" }}
        data-testid="text-step-title"
      >
        Enter the code you received
      </h1>
      <p className="text-gray-500 mb-10">Sent to {phone}</p>

      <OtpInput value={otp} onChange={onChange} />

      <p className="text-center text-gray-500 text-sm mt-12">
        You should receive the code within 30s
      </p>
      <p className="text-center text-sm mt-1">
        <button type="button" className="underline text-gray-700" data-testid="btn-resend-code">
          Didn't receive the code?
        </button>
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
