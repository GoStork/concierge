import { useEffect } from "react";
import { useParams, useNavigate, useSearchParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Loader2, User } from "lucide-react";
import { getPhotoSrc, getBrandAssetSrc } from "@/lib/profile-utils";
import { useAuth } from "@/hooks/use-auth";
import { useBrandSettings, useCompanyName } from "@/hooks/use-brand-settings";
import { Button } from "@/components/ui/button";
import { InlineBookingCalendar } from "@/components/chat/concierge-cards";

// A provider staff member's shareable booking link (/book/:slug).
//
// This page used to be its own scheduling UI: a frosted-glass Calendly clone
// with a hardcoded font, Title Case labels, slots that rendered below the
// fold with no scroll, no page title and no H1, and no word that the provider
// still has to confirm. It now wraps the same InlineBookingCalendar the chat
// uses (calendar, slots, "Booking as" form, pending card, time zone picker),
// so both ways into a booking behave the same and a fix lands in both.
export default function BookingPage() {
  const { slug } = useParams<{ slug: string }>();
  // Match Call / Doctor Call links carry ?subtype= so the booking is tagged
  // and the post-call readiness rules fire per provider type.
  const [searchParams] = useSearchParams();
  const rawSubtype = searchParams.get("subtype");
  const meetingSubtype = rawSubtype === "MATCH_CALL" || rawSubtype === "DOCTOR_CONSULTATION" ? rawSubtype : null;
  const { user } = useAuth();
  const navigate = useNavigate();
  const companyName = useCompanyName();
  const { data: brand } = useBrandSettings();
  const brandColor = brand?.primaryColor || "hsl(var(--primary))";
  const isViewer = (user as any)?.parentAccountRole === "VIEWER";

  useEffect(() => {
    if (isViewer) navigate("/marketplace", { replace: true });
  }, [isViewer, navigate]);

  const { data: pageInfo, isLoading, isError } = useQuery({
    queryKey: ["/api/calendar/page", slug],
    queryFn: async () => {
      const res = await fetch(`/api/calendar/page/${slug}`);
      if (!res.ok) throw new Error("Booking page not found");
      return res.json();
    },
    enabled: !!slug,
  });

  const host = pageInfo?.user;
  const org = host?.provider;
  const hostName: string = host?.name || "your host";
  const hostFirst = hostName.split(" ")[0];
  const siteLogo = pageInfo?.siteSettings?.logoWithNameUrl || pageInfo?.siteSettings?.logoUrl;
  const orgLogo = org?.brandSettings?.logoWithNameUrl || org?.brandSettings?.logoUrl || org?.logoUrl;
  const logoSrc = getBrandAssetSrc(siteLogo || orgLogo);
  const photoSrc = getPhotoSrc(host?.photoUrl);

  useEffect(() => {
    if (host?.name) document.title = `Book with ${host.name} - ${companyName}`;
  }, [host?.name, companyName]);

  if (isLoading) {
    return (
      <main className="min-h-screen bg-background flex items-center justify-center" aria-busy="true">
        <Loader2 className="w-8 h-8 animate-spin text-primary" aria-label="Loading" />
      </main>
    );
  }

  if (isError || !pageInfo) {
    return (
      <main className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="text-center max-w-sm space-y-4">
          <h1 className="text-2xl font-heading">This booking link isn't active</h1>
          <p className="text-muted-foreground">The person who shared it may have changed their link. You can always book a consultation from your chat.</p>
          <Button asChild><Link to="/chat">Open chat</Link></Button>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background px-4 py-8 md:py-14">
      <div className="mx-auto w-full max-w-md md:max-w-3xl space-y-6">
        {logoSrc && <img src={logoSrc} alt={companyName} className="h-8 object-contain" data-testid="img-provider-logo" />}

        <div className="bg-card border rounded-[var(--container-radius)] overflow-hidden md:grid md:grid-cols-[260px_1fr]">
          <section className="bg-secondary/60 p-5 md:p-6 border-b md:border-b-0 md:border-r space-y-4" aria-labelledby="host-name">
            <div className="flex items-center gap-3 md:flex-col md:items-start">
              {photoSrc ? (
                <img src={photoSrc} alt="" className="w-14 h-14 rounded-full object-cover shrink-0" data-testid="img-host-photo" />
              ) : (
                <div className="w-14 h-14 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0" aria-hidden="true">
                  <User className="w-7 h-7" />
                </div>
              )}
              <div className="min-w-0">
                <h1 id="host-name" className="text-xl font-heading font-bold leading-tight text-balance" data-testid="text-host-name">
                  {hostName}
                </h1>
                {org?.name && <p className="t-helper mt-0.5">{org.name}</p>}
              </div>
            </div>
            {/* Every request waits for the host. Said up front, so nobody
                books believing the time is already locked in. */}
            <p className="text-sm text-muted-foreground">
              Pick a time that suits you. {hostFirst} confirms each request, and you get an email as soon as they do.
            </p>
          </section>

          <section className="p-4 md:p-6" aria-labelledby="pick-a-time">
            <h2 id="pick-a-time" className="t-section-title font-heading mb-2" data-testid="text-select-date">Pick a time</h2>
            <InlineBookingCalendar
              slug={slug!}
              memberName={hostName}
              brandColor={brandColor}
              consultationMeta={meetingSubtype ? { meetingSubtype } : undefined}
              onBookingConfirmed={(meta) => {
                if (meta.booking?.publicToken) navigate(`/booking/${meta.booking.publicToken}`, { replace: true });
              }}
            />
          </section>
        </div>

        <p className="t-helper text-center">
          Booked through <span className="font-semibold text-foreground">{companyName}</span>
        </p>
      </div>
    </main>
  );
}
