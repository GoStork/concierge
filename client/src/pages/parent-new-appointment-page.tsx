import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Search, Video, User, Building2, Shield, Loader2 } from "lucide-react";
import { useCompanyName } from "@/hooks/use-brand-settings";
import { getPhotoSrc } from "@/lib/profile-utils";

interface BookableProvider {
  id: string;
  name: string;
  email: string;
  photoUrl: string | null;
  slug: string;
  meetingDuration: number;
  providerName: string | null;
  isGoStorkMember: boolean;
}

export default function ParentNewAppointmentPage() {
  const navigate = useNavigate();
  const companyName = useCompanyName();
  const [search, setSearch] = useState("");

  const { data: providers, isLoading } = useQuery<BookableProvider[]>({
    queryKey: ["/api/calendar/bookable-providers"],
  });

  const filtered = (providers || []).filter((p) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      p.name?.toLowerCase().includes(q) ||
      p.email?.toLowerCase().includes(q) ||
      p.providerName?.toLowerCase().includes(q)
    );
  });

  const goStorkMembers = filtered.filter((p) => p.isGoStorkMember);
  const providerStaff = filtered.filter((p) => !p.isGoStorkMember);

  const photoSrc = (url: string | null) => getPhotoSrc(url);

  const handleSelect = (provider: BookableProvider) => {
    navigate(`/book/${provider.slug}`);
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto px-4 py-8">
        <div className="flex items-center gap-3 mb-6">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate("/calendar")}
            className="rounded-lg"
            data-testid="button-back-to-calendar"
          >
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-heading" data-testid="text-page-title">New Appointment</h1>
            <p className="text-sm text-muted-foreground">Select a provider or {companyName} team member to schedule with</p>
          </div>
        </div>

        <div className="relative mb-6">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search by name, email, or organization..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
            data-testid="input-search-providers"
          />
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground" data-testid="text-no-providers">
            {search ? "No providers found matching your search." : "No providers with booking enabled found."}
          </div>
        ) : (
          <div className="space-y-6">
            {goStorkMembers.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Shield className="w-4 h-4 text-primary" />
                  <h2 className="text-sm font-heading text-muted-foreground uppercase tracking-wide" data-testid="text-gostork-section">{companyName} Team</h2>
                </div>
                <div className="space-y-2">
                  {goStorkMembers.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => handleSelect(p)}
                      className="w-full flex items-center gap-4 p-4 rounded-xl border border-border/50 bg-card hover:border-primary/30 hover:bg-primary/5 transition-colors text-left"
                      data-testid={`button-select-provider-${p.id}`}
                    >
                      {photoSrc(p.photoUrl) ? (
                        <img src={photoSrc(p.photoUrl)!} alt={p.name} className="w-10 h-10 rounded-full object-cover" />
                      ) : (
                        <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                          <User className="w-5 h-5 text-primary" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="font-ui truncate" data-testid={`text-provider-name-${p.id}`}>{p.name}</p>
                        <p className="text-sm text-muted-foreground truncate">{companyName} Team</p>
                      </div>
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
                        <Video className="w-3.5 h-3.5" />
                        {p.meetingDuration} min
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {providerStaff.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Building2 className="w-4 h-4 text-primary" />
                  <h2 className="text-sm font-heading text-muted-foreground uppercase tracking-wide" data-testid="text-providers-section">Providers</h2>
                </div>
                <div className="space-y-2">
                  {providerStaff.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => handleSelect(p)}
                      className="w-full flex items-center gap-4 p-4 rounded-xl border border-border/50 bg-card hover:border-primary/30 hover:bg-primary/5 transition-colors text-left"
                      data-testid={`button-select-provider-${p.id}`}
                    >
                      {photoSrc(p.photoUrl) ? (
                        <img src={photoSrc(p.photoUrl)!} alt={p.name} className="w-10 h-10 rounded-full object-cover" />
                      ) : (
                        <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                          <User className="w-5 h-5 text-primary" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="font-ui truncate" data-testid={`text-provider-name-${p.id}`}>{p.name}</p>
                        <p className="text-sm text-muted-foreground truncate">{p.providerName || p.email}</p>
                      </div>
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
                        <Video className="w-3.5 h-3.5" />
                        {p.meetingDuration} min
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
