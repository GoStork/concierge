import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { useBrandSettings, Matchmaker } from "@/hooks/use-brand-settings";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Sparkles, MessageCircle, Check } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface ChatSession {
  id: string;
  matchmakerId: string | null;
  matchmakerName: string | null;
  matchmakerAvatar: string | null;
  matchmakerTitle: string | null;
  lastMessageAt: string;
  updatedAt: string;
  providerJoinedAt: string | null;
  providerName: string | null;
}

export default function ConciergeSettingsTab() {
  const { data: brand, isLoading: brandLoading } = useBrandSettings();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const brandColor = brand?.primaryColor || "#004D4D";

  const roles: string[] = (user as any)?.roles || [];
  const isParent = roles.includes("PARENT");

  const sessionsQuery = useQuery<ChatSession[]>({
    queryKey: ["/api/my/chat-sessions"],
    enabled: isParent && !!user,
    staleTime: 0,
    refetchOnMount: "always",
  });

  const matchmakers: Matchmaker[] = (brand?.matchmakers || [])
    .filter(m => m.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const sessions = sessionsQuery.data || [];
  const conciergeSession = sessions.find(s => !s.providerJoinedAt || !s.providerName);
  const currentMatchmakerId = conciergeSession?.matchmakerId || null;

  const handleSelect = (matchmaker: Matchmaker) => {
    setSelectedId(matchmaker.id);
  };

  const handleSwitch = async () => {
    if (!selectedId) return;
    setSwitching(true);
    try {
      if (conciergeSession) {
        const res = await fetch("/api/my/chat-session/matchmaker", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ matchmakerId: selectedId }),
        });
        if (!res.ok) throw new Error("Failed to switch");
        await queryClient.invalidateQueries({ queryKey: ["/api/my/chat-sessions"] });
        toast({ title: "Concierge switched!", description: `Your concierge is now ${matchmakers.find(m => m.id === selectedId)?.name}.` });
        setSelectedId(null);
      } else {
        navigate(`/concierge?matchmaker=${selectedId}`);
      }
    } catch {
      toast({ title: "Error", description: "Could not switch concierge. Please try again.", variant: "destructive" });
    } finally {
      setSwitching(false);
    }
  };

  if (brandLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!brand?.enableAiConcierge) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center px-6" data-testid="concierge-disabled">
        <Sparkles className="w-12 h-12 text-muted-foreground mb-4" />
        <h2 className="font-display text-lg font-semibold mb-2">AI Concierge Not Available</h2>
        <p className="text-muted-foreground text-sm">The AI Concierge is currently not enabled.</p>
      </div>
    );
  }

  if (matchmakers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center px-6" data-testid="concierge-no-matchmakers">
        <Sparkles className="w-12 h-12 text-muted-foreground mb-4" />
        <h2 className="font-display text-lg font-semibold mb-2">AI Concierges Coming Soon</h2>
        <p className="text-muted-foreground text-sm">Our AI Concierges are currently being set up.</p>
      </div>
    );
  }

  const activeId = selectedId || currentMatchmakerId;

  return (
    <div className="space-y-6" data-testid="concierge-settings-tab">
      <Card className="p-6">
        <div className="flex items-center gap-2 mb-1">
          <Sparkles className="w-5 h-5" style={{ color: brandColor }} />
          <h2 className="font-display text-lg font-semibold" data-testid="text-concierge-heading">
            Your AI Concierge
          </h2>
        </div>
        <p className="text-sm text-muted-foreground mb-6">
          {isParent
            ? "Choose the concierge personality that best fits your communication style. Switching will update your existing conversation — the new concierge picks up right where you left off."
            : "View the available AI concierge personalities that assist parents on the platform."
          }
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {matchmakers.map((m) => {
            const isCurrent = currentMatchmakerId === m.id && !selectedId;
            const isSelected = activeId === m.id;
            return (
              <div
                key={m.id}
                className={`relative rounded-lg border-2 p-4 space-y-3 transition-all duration-200 ${
                  isParent ? "cursor-pointer hover:shadow-md" : ""
                } ${
                  isSelected
                    ? "shadow-lg"
                    : "hover:border-primary/30"
                }`}
                style={{
                  borderColor: isSelected ? brandColor : undefined,
                  borderRadius: "var(--container-radius, 0.5rem)",
                }}
                onClick={() => isParent && handleSelect(m)}
                data-testid={`matchmaker-card-${m.id}`}
              >
                {isCurrent && (
                  <div
                    className="absolute top-3 right-3 px-2 py-0.5 rounded-full text-[10px] font-semibold text-white"
                    style={{ backgroundColor: brandColor }}
                    data-testid={`badge-current-${m.id}`}
                  >
                    Current
                  </div>
                )}
                {selectedId === m.id && selectedId !== currentMatchmakerId && (
                  <div
                    className="absolute top-3 right-3 w-6 h-6 rounded-full flex items-center justify-center text-white"
                    style={{ backgroundColor: brandColor }}
                  >
                    <Check className="w-3.5 h-3.5" />
                  </div>
                )}
                <div className="flex items-center gap-3">
                  {m.avatarUrl ? (
                    <img
                      src={m.avatarUrl}
                      alt={m.name}
                      className="w-14 h-14 rounded-full object-cover border-2"
                      style={{ borderColor: isSelected ? brandColor : "transparent" }}
                    />
                  ) : (
                    <div
                      className="w-14 h-14 rounded-full flex items-center justify-center text-white text-lg font-bold"
                      style={{ backgroundColor: brandColor }}
                    >
                      {m.name.charAt(0)}
                    </div>
                  )}
                  <div>
                    <h3 className="font-display font-semibold text-base">{m.name}</h3>
                    <p className="text-xs text-muted-foreground">{m.title}</p>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">{m.description}</p>
              </div>
            );
          })}
        </div>

        {isParent && selectedId && selectedId !== currentMatchmakerId && (
          <div className="flex justify-center mt-6">
            <Button
              size="lg"
              className="px-8 gap-2"
              style={{ borderRadius: "var(--radius, 0.5rem)" }}
              onClick={handleSwitch}
              disabled={switching}
              data-testid="btn-switch-concierge"
            >
              {switching ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <MessageCircle className="w-4 h-4" />
              )}
              {conciergeSession
                ? `Switch to ${matchmakers.find(m => m.id === selectedId)?.name}`
                : `Start Chatting with ${matchmakers.find(m => m.id === selectedId)?.name}`
              }
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
