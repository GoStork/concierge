import { useState, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Search, Loader2, MessageSquare } from "lucide-react";

type FilterTab = "all" | "unread" | "agreements";

interface ConversationsShellProps {
  hasSelection: boolean;
  onBack: () => void;
  isLoading: boolean;
  sidebarItems: ReactNode;
  emptyMessage: string;
  emptyAction?: ReactNode;
  detailContent: ReactNode;
  brandColor: string;
  headerAction?: ReactNode;
  /** When true and hasSelection is true, show the left sidebar on desktop. Default: true. */
  showSidebar?: boolean;
  /** When true and hasSelection is true, show the left sidebar on ALL screen sizes (consultation mode). */
  sidebarAlwaysVisible?: boolean;
}

export function ConversationsShell({
  hasSelection,
  onBack,
  isLoading,
  sidebarItems,
  emptyMessage,
  emptyAction,
  detailContent,
  brandColor,
  headerAction,
  showSidebar = true,
  sidebarAlwaysVisible = false,
}: ConversationsShellProps) {
  const [activeFilter, setActiveFilter] = useState<FilterTab>("all");
  const [searchQuery, setSearchQuery] = useState("");

  // Left sidebar is visible when:
  // - no selection (user needs to pick a conversation), OR
  // - has selection AND showSidebar=true (e.g. consultation mode with provider in chat)
  // Hidden when has selection AND showSidebar=false (e.g. AI-only chat, full-width middle pane)
  const sidebarVisible = !hasSelection || showSidebar;

  // Sidebar CSS class: always flex when sidebarAlwaysVisible (consultation mode),
  // otherwise hide on mobile when a session is selected (standard responsive behavior)
  const sidebarClass = !sidebarVisible
    ? "hidden"
    : hasSelection
      ? (sidebarAlwaysVisible ? "flex" : "hidden md:flex")
      : "flex";

  return (
    <div className="flex fixed inset-0 md:static md:h-[calc(100dvh-64px)] w-full overflow-hidden" data-testid="conversations-page">
      <div className={`${sidebarClass} flex-col shrink-0 ${sidebarAlwaysVisible ? "w-64 md:w-80 lg:w-96" : "w-full md:w-80 lg:w-96"} border-r bg-background overflow-hidden`}>
        <div className="shrink-0 bg-background border-b px-4 pt-4 pb-3 space-y-3">
          <div className="flex items-center justify-between">
            <h1 className="font-display text-lg font-bold" data-testid="text-inbox-title">Conversations</h1>
            {headerAction}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex gap-1.5 flex-shrink-0">
              {(["all", "unread", "agreements"] as FilterTab[]).map(tab => (
                <button
                  key={tab}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                    activeFilter === tab
                      ? "text-primary-foreground"
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
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : sidebarItems ? (
            sidebarItems
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-center px-6" data-testid="inbox-empty">
              <MessageSquare className="w-10 h-10 text-muted-foreground mb-3" />
              <p className="text-sm text-muted-foreground">{emptyMessage}</p>
              {emptyAction}
            </div>
          )}
        </div>
      </div>

      <div className={`${!hasSelection ? "hidden md:flex" : "flex"} flex-1 min-w-0 flex-col bg-background min-h-0 relative overflow-hidden`}>
        {!hasSelection ? (
          <div className="flex-1 flex items-center justify-center text-center px-8">
            <div>
              <MessageSquare className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
              <h3 className="font-display text-lg font-semibold text-muted-foreground mb-1">Select a conversation</h3>
              <p className="text-sm text-muted-foreground">Choose a conversation from the list to view messages</p>
            </div>
          </div>
        ) : detailContent}
      </div>
    </div>
  );
}

export type { FilterTab };
