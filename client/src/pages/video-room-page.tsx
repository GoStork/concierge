import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { hasProviderRole } from "@shared/roles";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Loader2,
  Video,
  VideoOff,
  AlertCircle,
  User,
  Baby,
} from "lucide-react";
import DailyIframe from "@daily-co/daily-js";
import { useCompanyName } from "@/hooks/use-brand-settings";

export default function VideoRoomPage() {
  const { bookingId } = useParams<{ bookingId: string }>();
  const [searchParams] = useSearchParams();
  const preConsent = searchParams.get("consent");
  const { user, isLoading: authLoading } = useAuth();
  const companyName = useCompanyName();
  const navigate = useNavigate();

  const [guestEmail, setGuestEmail] = useState("");
  const [guestName, setGuestName] = useState("");
  const [guestVerified, setGuestVerified] = useState(false);
  const [guestError, setGuestError] = useState<string | null>(null);
  const [guestVerifying, setGuestVerifying] = useState(false);

  const isGuest = !authLoading && !user;
  const isReady = !authLoading && (!!user || guestVerified);

  const initialConsent = preConsent === "yes" ? "consented" as const : preConsent === "no" ? "declined" as const : "pending" as const;
  const [consentStep, setConsentStep] = useState<"pending" | "consented" | "declined" | "dismissed">(initialConsent);
  const [callState, setCallState] = useState<"idle" | "loading-token" | "iframe-ready" | "joined" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [rememberConsent, setRememberConsent] = useState(false);
  const callFrameRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const joiningRef = useRef(false);
  const autoConsentApplied = useRef(false);
  const guestPublicTokenRef = useRef<string | null>(null);

  const isProviderOrAdmin = !!(user && (hasProviderRole(user.roles) || user.roles?.includes("GOSTORK_ADMIN")));

  const bookingQuery = useQuery({
    queryKey: isGuest ? ["/api/video/room-info", bookingId] : ["/api/calendar/bookings", bookingId],
    queryFn: async () => {
      const url = isGuest
        ? `/api/video/room-info/${bookingId}`
        : `/api/calendar/bookings/${bookingId}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load booking");
      return res.json();
    },
    enabled: !!bookingId && (isReady || isGuest),
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    staleTime: Infinity,
  });

  const configQuery = useQuery<{ autoConsentRecording?: boolean }>({
    queryKey: ["/api/calendar/config"],
    queryFn: async () => {
      const res = await fetch("/api/calendar/config", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load config");
      return res.json();
    },
    enabled: isProviderOrAdmin,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });

  const consentMutation = useMutation({
    mutationFn: async (consentGiven: boolean) => {
      if (isGuest) {
        const res = await fetch("/api/video/guest-consent", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bookingId, email: guestEmail, consentGiven }),
        });
        if (!res.ok) throw new Error("Failed to update consent");
        return res.json();
      }
      const res = await apiRequest("PATCH", "/api/video/consent", {
        bookingId,
        consentGiven,
      });
      return res.json();
    },
  });

  const saveAutoConsentMutation = useMutation({
    mutationFn: async (autoConsentRecording: boolean) => {
      await apiRequest("PUT", "/api/calendar/config", { autoConsentRecording });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/config"] });
    },
  });

  useEffect(() => {
    if (
      isProviderOrAdmin &&
      configQuery.data?.autoConsentRecording === true &&
      consentStep === "pending" &&
      !autoConsentApplied.current &&
      bookingQuery.data
    ) {
      autoConsentApplied.current = true;
      consentMutation.mutateAsync(true).then(() => {
        setConsentStep("consented");
      }).catch(() => {
        autoConsentApplied.current = false;
      });
    }
  }, [isProviderOrAdmin, configQuery.data, consentStep, bookingQuery.data]);

  const handleConsent = useCallback(
    async (consented: boolean) => {
      try {
        await consentMutation.mutateAsync(consented);
        if (rememberConsent && isProviderOrAdmin && consented) {
          saveAutoConsentMutation.mutate(true);
        }
        setConsentStep(consented ? "consented" : "declined");
      } catch (err: any) {
        setError(err.message || "Failed to update consent");
      }
    },
    [consentMutation, rememberConsent, isProviderOrAdmin, saveAutoConsentMutation],
  );

  const joinCall = useCallback(async () => {
    if (!containerRef.current || callFrameRef.current || joiningRef.current) return;
    joiningRef.current = true;
    setCallState("loading-token");
    setError(null);

    try {
      let data: any;
      if (isGuest) {
        const res = await fetch("/api/video/guest-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bookingId, email: guestEmail, name: guestName }),
        });
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          throw new Error(errBody.message || "Failed to get video token");
        }
        data = await res.json();
        if (data.publicToken) guestPublicTokenRef.current = data.publicToken;
      } else {
        const res = await apiRequest("POST", "/api/video/token", { bookingId });
        data = await res.json();
      }

      if (!containerRef.current) {
        throw new Error("Video container not available");
      }

      const callFrame = DailyIframe.createFrame(containerRef.current, {
        iframeStyle: {
          position: "absolute",
          top: "0",
          left: "0",
          width: "100%",
          height: "100%",
          border: "0",
        },
        showLeaveButton: true,
        showFullscreenButton: true,
      });

      const iframe = callFrame.iframe();
      if (iframe) {
        iframe.setAttribute("allow", "camera *; microphone *; autoplay *; display-capture *; fullscreen *");
      }

      callFrameRef.current = callFrame;
      setCallState("iframe-ready");

      callFrame.on("joined-meeting", () => {
        setCallState("joined");
        if (isGuest) {
          fetch("/api/video/guest-joined", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bookingId, email: guestEmail, name: guestName, token: guestPublicTokenRef.current || "" }),
          }).catch(() => {});
        } else {
          apiRequest("POST", "/api/video/participant-joined", { bookingId }).catch(() => {});
          if (isProviderOrAdmin && consentStep === "consented") {
            callFrame.startRecording({ layout: { preset: "active-participant" } }).catch((err: any) => {
              console.warn("Auto-start recording failed:", err?.message || err);
            });
          }
        }
      });

      callFrame.on("left-meeting", () => {
        try { callFrame.stopRecording().catch(() => {}); } catch {}
        callFrame.destroy();
        callFrameRef.current = null;
        joiningRef.current = false;
        if (!isGuest) {
          apiRequest("PATCH", "/api/video/call-ended", { bookingId }).catch(() => {});
        }
        const isInIframe = window.self !== window.top;
        if (isInIframe) {
          try { window.parent.postMessage({ type: "video-call-ended", bookingId }, "*"); } catch {}
          return;
        }
        if (user) {
          navigate("/calendar?tab=meetings", { replace: true });
        } else {
          setCallState("idle");
          setConsentStep("pending");
          setGuestVerified(false);
        }
      });

      callFrame.on("error", (e: any) => {
        console.error("Daily error:", e);
        setError(e?.errorMsg || "Video call error");
        setCallState("error");
        joiningRef.current = false;
      });

      await callFrame.join({
        url: data.roomUrl,
        token: data.token,
      });
    } catch (err: any) {
      console.error("Join call error:", err);
      setError(err.message || "Failed to join video call");
      setCallState("error");
      joiningRef.current = false;
    }
  }, [bookingId, navigate, isGuest, guestEmail, guestName, user, isProviderOrAdmin, consentStep]);

  useEffect(() => {
    if ((consentStep === "consented" || consentStep === "declined") && callState === "idle" && isReady) {
      joinCall();
    }
  }, [consentStep, isReady]);

  useEffect(() => {
    return () => {
      if (callFrameRef.current) {
        callFrameRef.current.destroy();
        callFrameRef.current = null;
      }
    };
  }, []);

  const handleGuestVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!guestName.trim() || !guestEmail.trim()) {
      setGuestError("Please enter your name and email.");
      return;
    }
    setGuestVerifying(true);
    setGuestError(null);
    try {
      const res = await fetch("/api/video/guest-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingId, email: guestEmail.trim(), name: guestName.trim() }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.message || "Unable to verify your access");
      }
      setGuestVerified(true);
    } catch (err: any) {
      setGuestError(err.message || "Unable to verify your access. Please check your email.");
    } finally {
      setGuestVerifying(false);
    }
  };

  if (authLoading) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-80px)]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (isGuest && !guestVerified) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-primary/5 to-background flex items-center justify-center p-4">
        <div className="w-full max-w-sm">
          <Card className="rounded-[var(--container-radius)] shadow-lg p-8">
            <div className="text-center mb-6">
              <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-primary/10 flex items-center justify-center">
                <Video className="w-7 h-7 text-primary" />
              </div>
              <h1 className="text-xl font-display font-heading mb-1" data-testid="text-guest-join-title">Join Meeting</h1>
              <p className="text-sm text-muted-foreground">Enter your details to join the video call</p>
            </div>
            <form onSubmit={handleGuestVerify} className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="guest-name">Your Name</Label>
                <Input
                  id="guest-name"
                  value={guestName}
                  onChange={(e) => setGuestName(e.target.value)}
                  placeholder="Enter your name"
                  data-testid="input-guest-name"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="guest-email">Email Address</Label>
                <Input
                  id="guest-email"
                  type="email"
                  value={guestEmail}
                  onChange={(e) => setGuestEmail(e.target.value)}
                  placeholder="Enter the email you were invited with"
                  data-testid="input-guest-email"
                />
              </div>
              {guestError && (
                <p className="text-sm text-destructive" data-testid="text-guest-error">{guestError}</p>
              )}
              <Button type="submit" className="w-full gap-2" disabled={guestVerifying} data-testid="button-guest-join">
                {guestVerifying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Video className="w-4 h-4" />}
                Join Meeting
              </Button>
            </form>
            <p className="text-xs text-muted-foreground text-center mt-4">
              Already have a {companyName} account? <a href="/auth" className="text-primary hover:underline">Sign in</a>
            </p>
          </Card>
          <p className="text-center text-xs text-muted-foreground mt-4">
            Powered by <span className="font-ui text-primary">{companyName}</span>
          </p>
        </div>
      </div>
    );
  }

  const isLoading = bookingQuery.isLoading || (isProviderOrAdmin && configQuery.isLoading);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-80px)]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (bookingQuery.error || !bookingQuery.data) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-80px)]">
        <div className="text-center max-w-md px-4">
          <AlertCircle className="w-12 h-12 text-destructive mx-auto mb-4" />
          <h2 className="text-xl font-display font-heading mb-2" data-testid="text-video-error">
            Unable to Load Meeting
          </h2>
          <p className="text-muted-foreground text-sm">
            {bookingQuery.error?.message || "Booking not found or you don't have access."}
          </p>
          {user && (
            <Button
              variant="outline"
              className="mt-4"
              onClick={() => navigate("/calendar?tab=meetings")}
              data-testid="button-back-appointments"
            >
              Back to Appointments
            </Button>
          )}
        </div>
      </div>
    );
  }

  const booking = bookingQuery.data;

  if (booking.status !== "CONFIRMED") {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-80px)]">
        <div className="text-center max-w-md px-4">
          <VideoOff className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
          <h2 className="text-xl font-display font-heading mb-2" data-testid="text-video-not-ready">
            Meeting Not Available
          </h2>
          <p className="text-muted-foreground text-sm">
            {booking.status === "PENDING"
              ? "This meeting hasn't been confirmed yet."
              : booking.status === "CANCELLED"
                ? "This meeting was cancelled."
                : "This meeting is no longer available."}
          </p>
          {user && (
            <Button
              variant="outline"
              className="mt-4"
              onClick={() => navigate("/calendar?tab=meetings")}
              data-testid="button-back-appointments-status"
            >
              Back to Appointments
            </Button>
          )}
        </div>
      </div>
    );
  }

  const showIframe = callState === "iframe-ready" || callState === "joined";

  return (
    <>
      <Dialog open={consentStep === "pending" && !autoConsentApplied.current} onOpenChange={(open) => { if (!open) { setConsentStep("dismissed"); if (user) { navigate("/calendar?tab=meetings"); } } }}>
        <DialogContent
          className="sm:max-w-md p-6"
          onPointerDownOutside={(e) => e.preventDefault()}
        >
          <DialogHeader className="space-y-3">
            <div className="flex items-center justify-center">
              <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                <Video className="w-6 h-6 text-primary" />
              </div>
            </div>
            <DialogTitle className="text-center text-lg">
              Record This Consultation?
            </DialogTitle>
            <DialogDescription className="text-center text-sm leading-body">
              This call will be recorded and transcribed. You'll get a link to rewatch the video and review the transcript anytime.
            </DialogDescription>
            <p className="text-center text-xs text-muted-foreground">
              You can decline and still join without recording.
            </p>
          </DialogHeader>
          <div className="flex flex-col gap-2 mt-4">
            <Button
              className="w-full gap-2"
              onClick={() => handleConsent(true)}
              disabled={consentMutation.isPending}
              data-testid="button-consent-accept"
            >
              {consentMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Video className="w-4 h-4" />
              )}
              Yes, Record & Transcribe
            </Button>
            <Button
              variant="ghost"
              className="w-full text-muted-foreground"
              onClick={() => handleConsent(false)}
              disabled={consentMutation.isPending}
              data-testid="button-consent-decline"
            >
              Join Without Recording
            </Button>
          </div>
          {isProviderOrAdmin && (
            <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border/30">
              <Checkbox
                id="remember-consent"
                checked={rememberConsent}
                onCheckedChange={(checked) => setRememberConsent(!!checked)}
                data-testid="checkbox-remember-consent"
              />
              <label
                htmlFor="remember-consent"
                className="text-xs text-muted-foreground cursor-pointer select-none leading-tight"
              >
                Always record my calls - don't ask me again. You can change this in Settings.
              </label>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {callState === "error" && error && (
        <div className="bg-destructive/10 border border-destructive/30 rounded-[var(--radius)] p-4 m-4">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-5 h-5 text-destructive shrink-0" />
            <p className="text-sm text-destructive" data-testid="text-video-call-error">{error}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => {
              setError(null);
              setCallState("idle");
              joiningRef.current = false;
              if (callFrameRef.current) {
                callFrameRef.current.destroy();
                callFrameRef.current = null;
              }
              joinCall();
            }}
            data-testid="button-retry-join"
          >
            Try Again
          </Button>
        </div>
      )}

      {callState === "loading-token" && (
        <div className="flex items-center justify-center" style={{ height: "calc(100vh - 80px)" }}>
          <div className="text-center">
            <Loader2 className="w-8 h-8 animate-spin text-primary mx-auto mb-4" />
            <p className="text-muted-foreground">Connecting to video call...</p>
          </div>
        </div>
      )}

      {showIframe && bookingQuery.data && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            height: "44px",
            zIndex: 60,
            background: "hsl(var(--primary) / 0.92)",
            backdropFilter: "blur(8px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "10px",
            padding: "0 16px",
            boxShadow: "0 1px 4px rgba(0,0,0,0.2)",
          }}
          data-testid="video-branded-header"
        >
          <div style={{
            width: "28px",
            height: "28px",
            borderRadius: "6px",
            background: "rgba(255,255,255,0.15)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}>
            <Baby style={{ width: "16px", height: "16px", color: "white" }} />
          </div>
          <span style={{
            color: "white",
            fontSize: "13px",
            fontWeight: 600,
            letterSpacing: "0.01em",
            opacity: 0.95,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: "500px",
          }} data-testid="text-video-meeting-title">
            {bookingQuery.data.subject || `${companyName} Meeting`}
          </span>
        </div>
      )}

      <div
        id="daily-container"
        ref={containerRef}
        style={{
          position: showIframe ? "fixed" : "absolute",
          top: showIframe ? "44px" : "-9999px",
          left: "0",
          width: "100vw",
          height: showIframe ? "calc(100vh - 44px)" : "100vh",
          zIndex: showIframe ? 50 : -1,
        }}
        data-testid="daily-video-container"
      />
    </>
  );
}
