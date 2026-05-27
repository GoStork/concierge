import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ParentProfileCard } from "@/components/profile-cards";
import type { SessionUser } from "@/components/chat/chat-types";

export default function ParentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: parent, isLoading, error } = useQuery<SessionUser>({
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
            <div className="rounded-[var(--radius)] bg-card border p-5" data-testid="parent-detail-card">
              <ParentProfileCard user={parent} testId="parent-detail-profile" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
