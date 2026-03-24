import { useMemo, useState } from "react";
import { useParams, useNavigate, useSearchParams, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft, Globe, Phone, MapPin, Calendar, Building2, User, CheckCircle2, XCircle,
  Loader2,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { IvfSuccessRatesSection } from "@/components/ivf-success-rates-section";
import { getPhotoSrc } from "@/lib/profile-utils";

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="px-4 py-2.5 border-b bg-muted/50">
      <h3 className="text-sm font-heading font-semibold text-foreground" data-testid={`section-header-${title.toLowerCase().replace(/\s+/g, "-")}`}>
        {title}
      </h3>
    </div>
  );
}

function FieldItem({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div data-testid={`field-${label.toLowerCase().replace(/\s+/g, "-")}`}>
      <p className="text-xs font-ui text-foreground">{label}</p>
      <p className="text-sm text-muted-foreground">{value}</p>
    </div>
  );
}

export default function ProviderProfilePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const chatState = location.state as { fromChat?: boolean; chatPath?: string } | null;
  const fromChat = chatState?.fromChat === true;
  const chatPath = chatState?.chatPath || "/chat";

  const filterContext = useMemo(() => {
    const eggSource = searchParams.get("eggSource");
    const ageGroup = searchParams.get("ageGroup");
    const isNewPatient = searchParams.get("isNewPatient");
    if (!eggSource && !ageGroup) return undefined;
    return {
      ...(eggSource ? { eggSource } : {}),
      ...(ageGroup ? { ageGroup } : {}),
      ...(isNewPatient ? { isNewPatient } : {}),
    };
  }, [searchParams]);

  const { data: provider, isLoading } = useQuery<any>({
    queryKey: ["/api/providers", id],
    queryFn: async () => {
      const res = await fetch(`/api/providers/${id}`, { credentials: "include" });
      if (!res.ok) throw new Error("Provider not found");
      return res.json();
    },
    enabled: !!id,
  });

  const approvedServices = useMemo(() => {
    if (!provider?.services) return [];
    return provider.services.filter((s: any) => s.status === "APPROVED");
  }, [provider]);

  const surrogacyProfile = provider?.surrogacyProfile;
  const screening = surrogacyProfile?.screening;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!provider) {
    return (
      <div className="space-y-4 p-6">
        <Button variant="ghost" onClick={() => fromChat ? navigate(chatPath) : navigate(-1)} data-testid="link-back-marketplace">
          <ArrowLeft className="w-4 h-4 mr-2" /> {fromChat ? "Back to Chat" : "Back to Marketplace"}
        </Button>
        <p className="text-muted-foreground text-center py-8" data-testid="text-not-found">Provider not found.</p>
      </div>
    );
  }

  const logoSrc = getPhotoSrc(provider.logoUrl);

  return (
    <div className="space-y-6 w-full">
      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={() => fromChat ? navigate(chatPath) : navigate(-1)} data-testid="link-back-marketplace">
          <ArrowLeft className="w-4 h-4 mr-2" /> {fromChat ? "Back to Chat" : "Back to Marketplace"}
        </Button>
      </div>

      <div className="flex items-start gap-5">
        {logoSrc ? (
          <img
            src={logoSrc}
            alt={provider.name}
            className="w-20 h-20 rounded-xl object-contain border border-border/30 shrink-0 bg-background p-1"
            data-testid="img-provider-logo"
          />
        ) : (
          <div className="w-20 h-20 rounded-xl bg-secondary/30 flex items-center justify-center border border-border/30 shrink-0">
            <Building2 className="w-10 h-10 text-muted-foreground/30" />
          </div>
        )}
        <div>
          <h1 className="font-display text-2xl font-heading text-foreground" data-testid="text-provider-name">
            {provider.name}
          </h1>
          <div className="flex flex-wrap gap-1 mt-1">
            {approvedServices.map((s: any) => (
              <Badge key={s.id} variant="secondary" className="text-xs" data-testid={`badge-service-${s.id}`}>
                {s.providerType?.name || "Service"}
              </Badge>
            ))}
          </div>
          {provider.websiteUrl && (
            <a
              href={provider.websiteUrl.startsWith("http") ? provider.websiteUrl : `https://${provider.websiteUrl}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-primary hover:underline flex items-center gap-1 mt-1"
              data-testid="link-website"
            >
              <Globe className="h-3.5 w-3.5" /> {provider.websiteUrl}
            </a>
          )}
        </div>
      </div>

      <Card className="overflow-hidden" data-testid="section-company-info">
        <SectionHeader title="Company Information" />
        <div className="p-6">
          <div className="grid grid-cols-2 gap-x-12 gap-y-3">
            <FieldItem label="Provider Name" value={provider.name} />
            <FieldItem label="Year Founded" value={provider.yearFounded ? String(provider.yearFounded) : null} />
            <FieldItem label="Phone" value={provider.phone} />
            <FieldItem label="Email" value={provider.email} />
            {provider.websiteUrl && <FieldItem label="Website" value={provider.websiteUrl} />}
          </div>
          {provider.about && (
            <div className="mt-4" data-testid="field-about">
              <p className="text-xs font-ui text-foreground">About</p>
              <p className="text-sm text-muted-foreground whitespace-pre-line leading-body mt-1">{provider.about}</p>
            </div>
          )}
        </div>
      </Card>

      {provider.ivfSuccessRates && provider.ivfSuccessRates.length > 0 && (
        <IvfSuccessRatesSection rates={provider.ivfSuccessRates} filterContext={filterContext} />
      )}

      {provider.locations && provider.locations.length > 0 && (
        <Card className="overflow-hidden" data-testid="section-locations">
          <SectionHeader title="Locations" />
          <div className="p-6 space-y-3">
            {provider.locations.map((loc: any, idx: number) => {
              const parts = [loc.address, loc.city, loc.state, loc.zip].filter(Boolean);
              if (parts.length === 0) return null;
              return (
                <div key={loc.id || idx} className="flex items-start gap-2" data-testid={`location-${idx}`}>
                  <MapPin className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                  <p className="text-sm text-foreground">{parts.join(", ")}</p>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {provider.members && provider.members.length > 0 && (
        <Card className="overflow-hidden" data-testid="section-team">
          <SectionHeader title="Team Members" />
          <div className="p-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {provider.members.map((member: any) => {
                const memberPhoto = getPhotoSrc(member.photoUrl);
                const memberLocations = member.locations
                  ?.map((ml: any) => {
                    const l = ml.location;
                    return [l?.city, l?.state].filter(Boolean).join(", ");
                  })
                  .filter(Boolean);

                return (
                  <div key={member.id} className="flex gap-3" data-testid={`member-${member.id}`}>
                    {memberPhoto ? (
                      <img
                        src={memberPhoto}
                        alt={member.name}
                        className="w-14 h-14 rounded-full object-cover border border-border/30 shrink-0"
                      />
                    ) : (
                      <div className="w-14 h-14 rounded-full bg-secondary/40 flex items-center justify-center border border-border/30 shrink-0">
                        <User className="w-6 h-6 text-muted-foreground/40" />
                      </div>
                    )}
                    <div className="min-w-0">
                      <p className="font-ui text-sm text-foreground">{member.name}</p>
                      {member.title && (
                        <p className="text-xs text-primary font-ui">{member.title}</p>
                      )}
                      {member.bio && (
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-3">{member.bio}</p>
                      )}
                      {memberLocations && memberLocations.length > 0 && (
                        <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                          <MapPin className="w-3 h-3 shrink-0" />
                          {memberLocations.join(" · ")}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </Card>
      )}

      {surrogacyProfile && (
        <Card className="overflow-hidden" data-testid="section-surrogacy-details">
          <SectionHeader title="Surrogacy Agency Details" />
          <div className="p-6">
            <div className="grid grid-cols-2 gap-x-12 gap-y-3">
              <FieldItem
                label="Number of Babies Born"
                value={surrogacyProfile.numberOfBabiesBorn != null ? String(surrogacyProfile.numberOfBabiesBorn) : null}
              />
              <FieldItem label="Time to Match" value={surrogacyProfile.timeToMatch} />
              <FieldItem
                label="Families per Coordinator"
                value={surrogacyProfile.familiesPerCoordinator != null ? String(surrogacyProfile.familiesPerCoordinator) : null}
              />
            </div>
          </div>
        </Card>
      )}

      {screening && (
        <Card className="overflow-hidden" data-testid="section-screening">
          <SectionHeader title="Surrogate Screening Process" />
          <div className="p-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {[
                { label: "Criminal Background Check", value: screening.criminalBackgroundCheck },
                { label: "Home Visits", value: screening.homeVisits },
                { label: "Financials Review", value: screening.financialsReview },
                { label: "Social Worker Screening", value: screening.socialWorkerScreening },
                { label: "Medical Records Review", value: screening.medicalRecordsReview },
                { label: "Surrogate Insurance Review", value: screening.surrogateInsuranceReview },
                { label: "Psychological Screening", value: screening.psychologicalScreening },
              ].map(({ label, value }) => (
                <div key={label} className="flex items-center gap-2" data-testid={`screening-${label.toLowerCase().replace(/\s+/g, "-")}`}>
                  {value ? (
                    <CheckCircle2 className="w-4 h-4 text-[hsl(var(--brand-success))] shrink-0" />
                  ) : (
                    <XCircle className="w-4 h-4 text-muted-foreground/40 shrink-0" />
                  )}
                  <span className="text-sm text-foreground">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
