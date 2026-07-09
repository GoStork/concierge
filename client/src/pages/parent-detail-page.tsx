import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Loader2, AlertCircle, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ParentProfileCard } from "@/components/profile-cards";
import type { SessionUser } from "@/components/chat/chat-types";
import { formatPhoneDisplay } from "@/lib/phone-countries";

type AccountMember = {
  id: string;
  name: string | null;
  email: string;
  mobileNumber: string | null;
  photoUrl: string | null;
};

export default function ParentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: parent, isLoading, error } = useQuery<SessionUser & { accountMembers?: AccountMember[] }>({
    queryKey: ["/api/provider/parents", id],
    queryFn: async () => {
      const res = await fetch(`/api/provider/parents/${id}`, { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ message: "Failed to load parent" }));
        throw new Error(body.message || `Failed to load parent (${res.status})`);
      }
      return res.json();
    },
    enabled: !!id,
    retry: false,
  });

  return (
    <div className="flex flex-col min-h-[calc(100dvh-64px)]">
      <div className="flex items-center gap-3 px-4 h-14 border-b bg-background shrink-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate(-1)}
          className="gap-1.5"
          data-testid="btn-parent-detail-back"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </Button>
        <span className="text-sm font-medium font-ui">Parent profile</span>
      </div>

      <div className="flex-1 px-4 py-6">
        <div className="max-w-2xl mx-auto w-full">
          {isLoading && (
            <div className="flex flex-col items-center justify-center gap-3 py-12">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">Loading parent...</p>
            </div>
          )}

          {error && (
            <div className="flex flex-col items-center justify-center gap-3 py-12 text-center" data-testid="parent-detail-error">
              <AlertCircle className="w-8 h-8 text-destructive" />
              <p className="text-sm font-medium">{(error as Error).message}</p>
              <p className="text-xs text-muted-foreground max-w-sm">
                You can only view parents you've connected with through a chat session or booking.
              </p>
            </div>
          )}

          {parent && (
            <div className="space-y-4">
              {/* Shared parent account: both partners have their own login
                  but share one journey - surface every member's contact
                  info so the provider can reach either of them. */}
              {(parent.accountMembers?.length || 0) > 1 && (
                <div className="rounded-[var(--radius)] border p-4" style={{ background: "hsl(var(--accent) / 0.08)" }} data-testid="parent-detail-household">
                  <div className="flex items-center gap-2 mb-3">
                    <Users className="w-4 h-4" style={{ color: "hsl(var(--accent))" }} />
                    <span className="text-sm font-medium font-ui">Shared account - {parent.accountMembers!.length} members</span>
                  </div>
                  <div className="space-y-2">
                    {parent.accountMembers!.map(m => (
                      <div key={m.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm" data-testid={`household-member-${m.id}`}>
                        <span className="font-medium">{m.name || "-"}</span>
                        <span className="text-muted-foreground">{m.email}</span>
                        {m.mobileNumber && <span className="text-muted-foreground">{formatPhoneDisplay(m.mobileNumber)}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="rounded-[var(--radius)] bg-card border p-5" data-testid="parent-detail-card">
                <ParentProfileCard user={parent} testId="parent-detail-profile" />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
