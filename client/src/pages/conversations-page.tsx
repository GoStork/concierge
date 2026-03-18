import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useBrandSettings } from "@/hooks/use-brand-settings";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  ArrowLeft, MessageSquare, Send, User, Loader2, FileText,
  MapPin, Mail, CheckCircle2, UserPlus, Shield, ThumbsUp, ThumbsDown,
  Search, Sparkles, Building2, ChevronDown, MessageCircle, Clock,
} from "lucide-react";
import { hasProviderRole } from "@shared/roles";

interface ChatSession {
  id: string;
  title: string | null;
  status: string;
  matchmakerId: string | null;
  matchmakerName: string | null;
  matchmakerAvatar: string | null;
  matchmakerTitle: string | null;
  providerId: string | null;
  providerName: string | null;
  providerLogo: string | null;
  providerJoinedAt: string | null;
  humanRequested: boolean;
  lastMessage: string | null;
  lastMessageAt: string;
  lastMessageSenderType: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ProviderSession {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  userAvatar: string | null;
  status: string;
  providerJoinedAt: string | null;
  messageCount: number;
  lastMessage: string | null;
  lastMessageAt: string;
  createdAt: string;
}

interface SessionMessage {
  id: string;
  role: string;
  content: string;
  senderType: string;
  senderName: string | null;
  createdAt: string;
}

interface SessionDetail {
  id: string;
  userId: string;
  status: string;
  providerId: string | null;
  providerJoinedAt: string | null;
  user: {
    id: string;
    name: string;
    email: string;
    photoUrl: string | null;
    city: string | null;
    state: string | null;
    parentAccount?: {
      intendedParentProfile?: {
        journeyStage: string | null;
        eggSource: string | null;
        spermSource: string | null;
        carrier: string | null;
        hasEmbryos: boolean | null;
        embryoCount: number | null;
      } | null;
    } | null;
  };
  messages: SessionMessage[];
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(dateStr).toLocaleDateString();
}

function truncateMessage(msg: string, maxLen = 60): string {
  const cleaned = msg.replace(/\[\[.*?\]\]/g, "").replace(/\n/g, " ").trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.substring(0, maxLen) + "...";
}

type FilterTab = "all" | "unread" | "agreements";

export default function ConversationsPage() {
  const { user } = useAuth();
  const { data: brand } = useBrandSettings();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const brandColor = brand?.primaryColor || "#004D4D";
  const chatEndRef = useRef<HTMLDivElement>(null);

  const roles: string[] = (user as any)?.roles || [];
  const isParent = roles.includes("PARENT") && !roles.some((r: string) => ["GOSTORK_ADMIN", "GOSTORK_CONCIERGE", "GOSTORK_DEVELOPER"].includes(r)) && !hasProviderRole(roles);
  const isProvider = hasProviderRole(roles) || (roles.includes("GOSTORK_ADMIN") && !!(user as any)?.providerId);
  const showConcierge = brand?.enableAiConcierge !== false;

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<FilterTab>("all");
  const [replyText, setReplyText] = useState("");
  const [expandedProviders, setExpandedProviders] = useState<Record<string, boolean>>({});

  const parentSessionsQuery = useQuery<ChatSession[]>({
    queryKey: ["/api/my/chat-sessions"],
    enabled: isParent && !!user,
    refetchInterval: 10000,
    staleTime: 0,
    refetchOnMount: "always",
  });

  const providerSessionsQuery = useQuery<ProviderSession[]>({
    queryKey: ["/api/provider/concierge-sessions"],
    queryFn: async () => {
      const res = await fetch("/api/provider/concierge-sessions", { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: isProvider && !!user,
    refetchInterval: 10000,
    staleTime: 0,
    refetchOnMount: "always",
  });

  const sessionDetailQuery = useQuery<SessionDetail>({
    queryKey: ["/api/provider/concierge-sessions", selectedSessionId],
    queryFn: async () => {
      const res = await fetch(`/api/provider/concierge-sessions/${selectedSessionId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: isProvider && !!selectedSessionId,
    refetchInterval: 5000,
  });

  const joinMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      const res = await fetch(`/api/provider/concierge-sessions/${sessionId}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to join");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions", selectedSessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions"] });
    },
  });

  const sendMessageMutation = useMutation({
    mutationFn: async ({ sessionId, content }: { sessionId: string; content: string }) => {
      const res = await fetch(`/api/provider/concierge-sessions/${sessionId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ content }),
      });
      if (!res.ok) throw new Error("Failed to send");
      return res.json();
    },
    onSuccess: () => {
      setReplyText("");
      queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions", selectedSessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions"] });
    },
  });

  const consultationStatusMutation = useMutation({
    mutationFn: async ({ sessionId, status }: { sessionId: string; status: string }) => {
      const res = await fetch(`/api/provider/concierge-sessions/${sessionId}/consultation-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error("Failed to update");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions", selectedSessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions"] });
    },
  });

  const generateAgreementMutation = useMutation({
    mutationFn: async ({ sessionId }: { sessionId: string }) => {
      const res = await fetch("/api/agreements/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ sessionId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Failed to generate agreement" }));
        throw new Error(err.message);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions", selectedSessionId] });
    },
  });

  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [sessionDetailQuery.data?.messages?.length]);

  const handleSendReply = () => {
    if (!replyText.trim() || !selectedSessionId) return;
    sendMessageMutation.mutate({ sessionId: selectedSessionId, content: replyText.trim() });
  };

  const handleParentSessionClick = (session: ChatSession) => {
    const params = new URLSearchParams();
    if (session.matchmakerId) params.set("matchmaker", session.matchmakerId);
    params.set("session", session.id);
    navigate(`/concierge?${params.toString()}`);
  };

  const detail = sessionDetailQuery.data;
  const profile = detail?.user?.parentAccount?.intendedParentProfile;
  const hasJoined = !!detail?.providerJoinedAt;

  if (isParent) {
    const allSessions = parentSessionsQuery.data || [];
    const allEvaConversations = allSessions.filter(s => !s.providerJoinedAt || !s.providerName);
    const evaConversations = allEvaConversations.length > 0 ? [allEvaConversations[0]] : [];
    const providerConversations = allSessions.filter(s => s.providerJoinedAt && s.providerName);

    const filteredEva = evaConversations.filter(s =>
      !searchQuery || (s.matchmakerName || "Eva").toLowerCase().includes(searchQuery.toLowerCase()) ||
      (s.lastMessage || "").toLowerCase().includes(searchQuery.toLowerCase())
    );
    const filteredProvider = providerConversations.filter(s =>
      !searchQuery || (s.providerName || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
      (s.lastMessage || "").toLowerCase().includes(searchQuery.toLowerCase())
    );

    const providerGroups: Record<string, ChatSession[]> = {};
    filteredProvider.forEach(s => {
      const key = s.providerId || "other";
      if (!providerGroups[key]) providerGroups[key] = [];
      providerGroups[key].push(s);
    });

    const toggleProvider = (id: string) => {
      setExpandedProviders(prev => ({ ...prev, [id]: !prev[id] }));
    };

    return (
      <div className="flex flex-col h-[calc(100vh-64px)] w-full overflow-hidden" data-testid="conversations-page">
        <div className="flex flex-col w-full max-w-lg mx-auto flex-1 overflow-hidden">
          <div className="sticky top-0 z-10 bg-background border-b px-4 pt-4 pb-3 space-y-3">
            <div className="flex items-center justify-between">
              <h1 className="font-display text-xl font-bold" data-testid="text-inbox-title">Chats</h1>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex gap-1.5 flex-shrink-0">
                {(["all", "unread", "agreements"] as FilterTab[]).map(tab => (
                  <button
                    key={tab}
                    className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                      activeFilter === tab
                        ? "text-white"
                        : "bg-muted text-muted-foreground hover:bg-muted/80"
                    }`}
                    style={activeFilter === tab ? { backgroundColor: brandColor } : undefined}
                    onClick={() => setActiveFilter(tab)}
                    data-testid={`filter-${tab}`}
                  >
                    {tab === "all" ? "All" : tab === "unread" ? "Unread" : "Agreements"}
                  </button>
                ))}
              </div>
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9 h-8 text-sm"
                  data-testid="input-search-conversations"
                />
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {parentSessionsQuery.isLoading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
              </div>
            ) : allSessions.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center px-6" data-testid="inbox-empty">
                <MessageCircle className="w-12 h-12 text-muted-foreground mb-4" />
                <h2 className="font-display text-lg font-semibold mb-2">No conversations yet</h2>
                <p className="text-muted-foreground text-sm mb-6">
                  {showConcierge
                    ? "Start a conversation with your AI concierge to get personalized fertility guidance."
                    : "Your provider conversations will appear here."
                  }
                </p>
                {showConcierge && (
                  <Button
                    onClick={() => navigate("/account/concierge")}
                    data-testid="btn-start-first-chat"
                    style={{ backgroundColor: brandColor }}
                    className="text-white"
                  >
                    Choose Your AI Concierge
                  </Button>
                )}
              </div>
            ) : (
              <div className="pb-24">
                {showConcierge && filteredEva.length > 0 && (
                  <div data-testid="section-concierge">
                    <div
                      className="mx-4 mt-3 mb-2 px-3 py-2 rounded-lg flex items-center gap-2"
                      style={{ backgroundColor: `${brandColor}08` }}
                    >
                      <Sparkles className="w-4 h-4" style={{ color: brandColor }} />
                      <span className="text-xs font-semibold" style={{ color: brandColor }}>Your AI Concierge</span>
                    </div>
                    {filteredEva.map(session => (
                      <button
                        key={session.id}
                        className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-muted/50 transition-colors text-left border-b border-border/20"
                        onClick={() => handleParentSessionClick(session)}
                        data-testid={`chat-session-${session.id}`}
                      >
                        {session.matchmakerAvatar ? (
                          <img src={session.matchmakerAvatar} alt="" className="w-11 h-11 rounded-full object-cover border flex-shrink-0" />
                        ) : (
                          <div className="w-11 h-11 rounded-full flex items-center justify-center text-white text-sm font-bold flex-shrink-0" style={{ backgroundColor: brandColor }}>
                            {(session.matchmakerName || "E").charAt(0)}
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-ui truncate" style={{ fontWeight: 600 }}>{session.matchmakerName || "Eva"}</span>
                            <span className="text-[11px] text-muted-foreground flex-shrink-0">{timeAgo(session.lastMessageAt)}</span>
                          </div>
                          {session.lastMessage && (
                            <p className="text-sm text-muted-foreground truncate mt-0.5">{truncateMessage(session.lastMessage)}</p>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {Object.keys(providerGroups).length > 0 && (
                  <div className="mt-2" data-testid="section-provider-chats">
                    <div className="px-4 py-2">
                      <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Provider Conversations</span>
                    </div>
                    {Object.entries(providerGroups).map(([providerId, sessions]) => {
                      const first = sessions[0];
                      const isExpanded = expandedProviders[providerId] !== false;
                      return (
                        <Collapsible key={providerId} open={isExpanded} onOpenChange={() => toggleProvider(providerId)}>
                          <CollapsibleTrigger className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-muted/30 transition-colors text-left" data-testid={`provider-group-${providerId}`}>
                            {first.providerLogo ? (
                              <img src={first.providerLogo} alt="" className="w-8 h-8 rounded-full object-cover border flex-shrink-0" />
                            ) : (
                              <div className="w-8 h-8 rounded-full flex items-center justify-center bg-muted text-muted-foreground flex-shrink-0">
                                <Building2 className="w-4 h-4" />
                              </div>
                            )}
                            <span className="font-medium text-sm font-ui flex-1">{first.providerName}</span>
                            <span className="text-[11px] text-muted-foreground mr-1">{sessions.length}</span>
                            <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                          </CollapsibleTrigger>
                          <CollapsibleContent>
                            {sessions.map(session => (
                              <button
                                key={session.id}
                                className="w-full flex items-center gap-3 pl-14 pr-4 py-3 hover:bg-muted/50 transition-colors text-left border-b border-border/10"
                                onClick={() => handleParentSessionClick(session)}
                                data-testid={`chat-session-provider-${session.id}`}
                              >
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="font-medium text-sm font-ui truncate">{session.matchmakerName || "Conversation"}</span>
                                    <span className="text-[11px] text-muted-foreground flex-shrink-0">{timeAgo(session.lastMessageAt)}</span>
                                  </div>
                                  {session.lastMessage && (
                                    <p className="text-sm text-muted-foreground truncate mt-0.5">{truncateMessage(session.lastMessage)}</p>
                                  )}
                                </div>
                              </button>
                            ))}
                          </CollapsibleContent>
                        </Collapsible>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (isProvider) {
    const sessions = providerSessionsQuery.data || [];
    const filteredSessions = sessions.filter(s =>
      !searchQuery ||
      (s.userName || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
      (s.userEmail || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
      (s.lastMessage || "").toLowerCase().includes(searchQuery.toLowerCase())
    );

    return (
      <div className="flex h-[calc(100vh-64px)] w-full overflow-hidden" data-testid="conversations-page">
        <div className={`${selectedSessionId ? "hidden md:flex" : "flex"} flex-col w-full md:w-80 lg:w-96 border-r bg-background`}>
          <div className="sticky top-0 z-10 bg-background border-b px-4 pt-4 pb-3 space-y-3">
            <h1 className="font-display text-lg font-bold" data-testid="text-inbox-title">Conversations</h1>
            <div className="flex items-center gap-2">
              <div className="flex gap-1.5 flex-shrink-0">
                {(["all", "unread", "agreements"] as FilterTab[]).map(tab => (
                  <button
                    key={tab}
                    className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                      activeFilter === tab
                        ? "text-white"
                        : "bg-muted text-muted-foreground hover:bg-muted/80"
                    }`}
                    style={activeFilter === tab ? { backgroundColor: brandColor } : undefined}
                    onClick={() => setActiveFilter(tab)}
                    data-testid={`filter-${tab}`}
                  >
                    {tab === "all" ? "All" : tab === "unread" ? "Unread" : "Agreements"}
                  </button>
                ))}
              </div>
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9 h-8 text-sm"
                  data-testid="input-search-conversations"
                />
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {providerSessionsQuery.isLoading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : filteredSessions.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center px-6" data-testid="inbox-empty">
                <MessageSquare className="w-10 h-10 text-muted-foreground mb-3" />
                <p className="text-sm text-muted-foreground">
                  {searchQuery ? "No conversations match your search" : "No conversations yet"}
                </p>
                {!searchQuery && (
                  <p className="text-xs text-muted-foreground mt-1">When parents request a consultation, their conversations will appear here</p>
                )}
              </div>
            ) : (
              filteredSessions.map(s => (
                <button
                  key={s.id}
                  className={`w-full flex items-center gap-3 px-4 py-3.5 hover:bg-muted/50 transition-colors text-left border-b border-border/20 ${
                    selectedSessionId === s.id ? "bg-muted/70" : ""
                  }`}
                  onClick={() => setSelectedSessionId(s.id)}
                  data-testid={`provider-session-${s.id}`}
                >
                  {s.userAvatar ? (
                    <img src={s.userAvatar} alt="" className="w-11 h-11 rounded-full object-cover flex-shrink-0" />
                  ) : (
                    <div className="w-11 h-11 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
                      <User className="w-5 h-5 text-muted-foreground" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-semibold text-sm font-ui truncate">{s.userName || "Unknown"}</span>
                        {s.providerJoinedAt ? (
                          <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-[hsl(var(--brand-success))]/15 text-[hsl(var(--brand-success))] text-[9px] font-bold uppercase flex-shrink-0">
                            <CheckCircle2 className="w-2.5 h-2.5" />
                            Joined
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-[hsl(var(--brand-warning))]/15 text-[hsl(var(--brand-warning))] text-[9px] font-bold uppercase flex-shrink-0">
                            New
                          </span>
                        )}
                      </div>
                      <span className="text-[11px] text-muted-foreground flex-shrink-0">{timeAgo(s.lastMessageAt)}</span>
                    </div>
                    {s.lastMessage && (
                      <p className="text-sm text-muted-foreground truncate mt-0.5">{truncateMessage(s.lastMessage)}</p>
                    )}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        <div className={`${!selectedSessionId ? "hidden md:flex" : "flex"} flex-1 flex-col bg-background`}>
          {!selectedSessionId ? (
            <div className="flex-1 flex items-center justify-center text-center px-8">
              <div>
                <MessageSquare className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
                <h3 className="font-display text-lg font-semibold text-muted-foreground mb-1">Select a conversation</h3>
                <p className="text-sm text-muted-foreground">Choose a conversation from the list to view messages</p>
              </div>
            </div>
          ) : sessionDetailQuery.isLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : detail ? (
            <>
              <div className="flex items-center gap-3 px-4 py-3 border-b bg-background">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 md:hidden"
                  onClick={() => setSelectedSessionId(null)}
                  data-testid="btn-back-to-sessions"
                >
                  <ArrowLeft className="w-4 h-4" />
                </Button>
                <div className="flex items-center gap-2 flex-1">
                  {detail.user.photoUrl ? (
                    <img src={detail.user.photoUrl} alt="" className="w-8 h-8 rounded-full object-cover" />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center">
                      <User className="w-4 h-4 text-muted-foreground" />
                    </div>
                  )}
                  <div>
                    <h3 className="font-semibold text-sm font-ui">{detail.user.name || "Unknown"}</h3>
                  </div>
                </div>
                {hasJoined ? (
                  <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[hsl(var(--brand-success))]/10 text-[hsl(var(--brand-success))] text-xs font-medium" data-testid="badge-provider-joined">
                    <CheckCircle2 className="w-3 h-3" />
                    Joined
                  </div>
                ) : (
                  <Button
                    size="sm"
                    className="h-8 text-xs text-white gap-1"
                    style={{ backgroundColor: brandColor }}
                    onClick={() => joinMutation.mutate(selectedSessionId)}
                    disabled={joinMutation.isPending}
                    data-testid="btn-join-conversation"
                  >
                    {joinMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserPlus className="w-3 h-3" />}
                    Join
                  </Button>
                )}
              </div>

              <div className="flex flex-1 overflow-hidden">
                <div className="flex-1 flex flex-col">
                  <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3" data-testid="provider-chat-messages">
                    {detail.messages.map((msg, i) => (
                      <div key={msg.id}>
                        {msg.role === "assistant" && msg.senderType === "human" && (
                          <div className="flex items-center gap-1.5 mb-1 ml-1">
                            <div className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full text-white bg-muted-foreground">GoStork Expert</div>
                            {msg.senderName && <span className="text-[11px] text-muted-foreground">{msg.senderName}</span>}
                          </div>
                        )}
                        {msg.role === "assistant" && msg.senderType === "provider" && (
                          <div className="flex items-center gap-1.5 mb-1 ml-1">
                            <div className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full text-white" style={{ backgroundColor: brandColor }}>Agency Expert</div>
                            {msg.senderName && <span className="text-[11px] text-muted-foreground">{msg.senderName}</span>}
                          </div>
                        )}
                        {msg.role === "assistant" && msg.senderType === "system" && (
                          <div className="flex items-center gap-1.5 mb-1 ml-1">
                            <div className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-[hsl(var(--accent))] text-white">Eva</div>
                          </div>
                        )}
                        <div className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                          <div
                            className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-base leading-relaxed font-ui ${
                              msg.role === "user"
                                ? "bg-[hsl(var(--accent))]/15 text-[hsl(var(--accent))]"
                                : msg.senderType === "provider"
                                ? "text-foreground border-2"
                                : msg.senderType === "human"
                                ? "bg-muted text-foreground"
                                : msg.senderType === "system"
                                ? "bg-[hsl(var(--accent))]/10 text-[hsl(var(--accent))] border border-[hsl(var(--accent))]/30"
                                : "bg-muted text-foreground"
                            }`}
                            style={msg.senderType === "provider" ? { borderColor: brandColor, backgroundColor: `${brandColor}08` } : undefined}
                            data-testid={`provider-msg-${i}`}
                          >
                            {msg.content}
                          </div>
                        </div>
                        <div className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"} mt-0.5`}>
                          <span className="text-[10px] text-muted-foreground">
                            {msg.role === "user" ? "Parent" : msg.senderType === "provider" ? "You" : msg.senderType === "human" ? "GoStork" : msg.senderType === "system" ? "System" : "AI"} · {timeAgo(msg.createdAt)}
                          </span>
                        </div>
                      </div>
                    ))}
                    <div ref={chatEndRef} />
                  </div>

                  {hasJoined ? (
                    <div className="border-t px-4 py-3 bg-background" data-testid="provider-reply-area">
                      <div className="flex items-center gap-1.5 mb-2 text-xs text-muted-foreground">
                        <Shield className="w-3 h-3" />
                        <span>Sending as <strong className="text-foreground">Agency Expert</strong></span>
                      </div>
                      <div className="flex gap-2">
                        <Input
                          placeholder="Type a message to the parent..."
                          value={replyText}
                          onChange={(e) => setReplyText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              handleSendReply();
                            }
                          }}
                          disabled={sendMessageMutation.isPending}
                          className="flex-1 !text-base font-ui"
                          data-testid="input-provider-message"
                        />
                        <Button
                          size="sm"
                          onClick={handleSendReply}
                          disabled={!replyText.trim() || sendMessageMutation.isPending}
                          className="h-10 px-4 text-white"
                          style={{ backgroundColor: brandColor }}
                          data-testid="btn-send-provider-message"
                        >
                          {sendMessageMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="border-t px-4 py-4 bg-muted/30 text-center" data-testid="provider-join-prompt">
                      <p className="text-sm text-muted-foreground mb-2">Join this conversation to start chatting</p>
                      <Button
                        size="sm"
                        className="text-white gap-1"
                        style={{ backgroundColor: brandColor }}
                        onClick={() => joinMutation.mutate(selectedSessionId)}
                        disabled={joinMutation.isPending}
                        data-testid="btn-join-conversation-bottom"
                      >
                        {joinMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserPlus className="w-3 h-3" />}
                        Join Conversation
                      </Button>
                    </div>
                  )}
                </div>

                <div className="w-72 border-l overflow-y-auto p-4 bg-muted/30 hidden lg:block" data-testid="provider-sidebar">
                  <h4 className="font-semibold text-sm mb-3" style={{ fontFamily: "var(--font-display)" }}>Parent Profile</h4>
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <User className="w-4 h-4 text-muted-foreground" />
                      <span className="text-sm">{detail.user.name || "—"}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Mail className="w-4 h-4 text-muted-foreground" />
                      <span className="text-sm truncate">{detail.user.email}</span>
                    </div>
                    {(detail.user.city || detail.user.state) && (
                      <div className="flex items-center gap-2">
                        <MapPin className="w-4 h-4 text-muted-foreground" />
                        <span className="text-sm">{[detail.user.city, detail.user.state].filter(Boolean).join(", ")}</span>
                      </div>
                    )}
                    {profile && (
                      <div className="border-t pt-3 mt-3">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Journey Details</p>
                        <div className="space-y-1.5">
                          {profile.journeyStage && <div className="text-sm"><span className="text-muted-foreground">Stage:</span> {profile.journeyStage}</div>}
                          {profile.eggSource && <div className="text-sm"><span className="text-muted-foreground">Egg Source:</span> {profile.eggSource}</div>}
                          {profile.spermSource && <div className="text-sm"><span className="text-muted-foreground">Sperm Source:</span> {profile.spermSource}</div>}
                          {profile.carrier && <div className="text-sm"><span className="text-muted-foreground">Carrier:</span> {profile.carrier}</div>}
                          {profile.hasEmbryos !== null && <div className="text-sm"><span className="text-muted-foreground">Embryos:</span> {profile.hasEmbryos ? `Yes (${profile.embryoCount || "??"})` : "No"}</div>}
                        </div>
                      </div>
                    )}
                  </div>

                  {hasJoined && (
                    <div className="border-t pt-4 mt-4" data-testid="consultation-status-section">
                      <h4 className="font-semibold text-sm mb-3" style={{ fontFamily: "var(--font-display)" }}>Consultation Status</h4>
                      <div className="space-y-2">
                        <Button
                          size="sm"
                          className="w-full text-white gap-1.5 text-xs"
                          style={{ backgroundColor: "var(--brand-success, #22c55e)" }}
                          onClick={() => consultationStatusMutation.mutate({ sessionId: selectedSessionId, status: "READY_FOR_MATCH" })}
                          disabled={consultationStatusMutation.isPending}
                          data-testid="btn-ready-for-match"
                        >
                          {consultationStatusMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <ThumbsUp className="w-3 h-3" />}
                          Completed — Ready for Match
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full gap-1.5 text-xs border-destructive text-destructive hover:bg-destructive hover:text-white"
                          onClick={() => consultationStatusMutation.mutate({ sessionId: selectedSessionId, status: "NOT_A_FIT" })}
                          disabled={consultationStatusMutation.isPending}
                          data-testid="btn-not-a-fit"
                        >
                          {consultationStatusMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <ThumbsDown className="w-3 h-3" />}
                          Completed — Not a Fit
                        </Button>
                      </div>
                    </div>
                  )}

                  {hasJoined && (
                    <div className="border-t pt-4 mt-4" data-testid="agreement-section">
                      <h4 className="font-semibold text-sm mb-3" style={{ fontFamily: "var(--font-display)" }}>Agreement</h4>
                      <Button
                        size="sm"
                        className="w-full gap-1.5 text-xs"
                        style={{ backgroundColor: brandColor }}
                        onClick={() => { if (selectedSessionId) generateAgreementMutation.mutate({ sessionId: selectedSessionId }); }}
                        disabled={generateAgreementMutation.isPending}
                        data-testid="btn-generate-agreement"
                      >
                        {generateAgreementMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileText className="w-3 h-3" />}
                        Generate & Send Agreement
                      </Button>
                      {generateAgreementMutation.isError && (
                        <p className="text-xs text-destructive mt-1.5" data-testid="text-agreement-error">
                          {(generateAgreementMutation.error as Error)?.message || "Failed to generate agreement"}
                        </p>
                      )}
                      {generateAgreementMutation.isSuccess && (
                        <p className="text-xs text-[hsl(var(--brand-success))] mt-1.5" data-testid="text-agreement-success">
                          Agreement sent successfully
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center min-h-[60vh] text-muted-foreground" data-testid="conversations-no-role">
      <MessageSquare className="w-6 h-6 mr-2" />
      <span>No conversations available for your account type.</span>
    </div>
  );
}
