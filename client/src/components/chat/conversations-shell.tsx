import { useEffect, useRef, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { ClearFiltersButton } from "@/components/clear-filters-button";
import { Search, Loader2, MessageSquare } from "lucide-react";

type FilterTab = "all" | "unread";

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
  activeFilter: FilterTab;
  onFilterChange: (filter: FilterTab) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  /**
   * The currently selected conversation's id. Arriving from a deep link
   * (Open chat on a parent record, a cost-sheet chip) highlights the row but
   * used to leave the list scrolled wherever it was, so on a long inbox the
   * highlighted thread sat off-screen and you had to hunt for it.
   *
   * The shell cannot reach inside sidebarItems, so the contract is one
   * attribute: mark the selected row `data-selected="true"` and it gets
   * scrolled into view whenever this key changes.
   */
  selectedKey?: string | null;
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
  activeFilter,
  onFilterChange,
  searchQuery,
  onSearchChange,
  selectedKey,
}: ConversationsShellProps) {
  const listRef = useRef<HTMLDivElement | null>(null);

  // Bring the selected row into view when the selection changes - which covers
  // arriving on a deep link. Keyed on selectedKey rather than every render, so
  // clicking a row already on screen never yanks the list under you.
  useEffect(() => {
    if (!selectedKey) return;
    // Two frames: the list re-renders with the new selection first.
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => {
      listRef.current
        ?.querySelector('[data-selected="true"]')
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }));
    return () => cancelAnimationFrame(raf);
  }, [selectedKey]);

  // Lock body scroll on mobile so the page body doesn't compete with the inner list scroll
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Left sidebar is visible when:
  // - no selection (user needs to pick a conversation), OR
  // - has selection AND showSidebar=true (e.g. consultation mode with provider in chat)
  // Hidden when has selection AND showSidebar=false (e.g. AI-only chat, full-width middle pane)
  const sidebarVisible = !hasSelection || showSidebar;

  // Sidebar CSS class: on mobile always hide the left sidebar when a session is selected
  // so the user only sees one column at a time. On desktop, sidebarAlwaysVisible keeps
  // the conversation list visible alongside the chat (consultation mode).
  const sidebarClass = !sidebarVisible
    ? "hidden"
    : hasSelection
      ? "hidden md:flex"
      : "flex";

  return (
    <div className="flex fixed inset-x-0 top-0 md:static h-dvh md:h-[calc(100dvh-64px)] w-full overflow-hidden" data-testid="conversations-page">
      <div className={`${sidebarClass} flex-col shrink-0 ${sidebarAlwaysVisible ? "w-64 md:w-80 lg:w-96" : "w-full md:w-80 lg:w-96"} border-r bg-background overflow-hidden`}>
        <div className="shrink-0 bg-background border-b px-4 pt-4 pb-3 space-y-3">
          <div className="flex items-center justify-between">
            <h1 className="font-display text-lg font-bold" data-testid="text-inbox-title">Conversations</h1>
            {headerAction}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex gap-1.5 flex-shrink-0">
              {(["all", "unread"] as FilterTab[]).map(tab => (
                <button
                  key={tab}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                    activeFilter === tab
                      ? "text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:bg-muted/80"
                  }`}
                  style={activeFilter === tab ? { backgroundColor: brandColor } : undefined}
                  onClick={() => onFilterChange(tab)}
                  data-testid={`filter-${tab}`}
                >
                  {tab === "all" ? "All" : "Unread"}
                </button>
              ))}
            </div>
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search..."
                value={searchQuery}
                onChange={(e) => onSearchChange(e.target.value)}
                className="pl-9 h-8 text-sm"
                data-testid="input-search-conversations"
              />
            </div>
            <ClearFiltersButton
              pill
              show={!!(searchQuery || activeFilter !== "all")}
              onClick={() => { onSearchChange(""); onFilterChange("all"); }}
              testId="conversations-clear-filters"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto" ref={listRef}>
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : sidebarItems ? (
            <>
              {sidebarItems}
              <div style={{ height: 'calc(5rem + env(safe-area-inset-bottom))' }} aria-hidden />
            </>
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-center px-6" data-testid="inbox-empty">
              <MessageSquare className="w-10 h-10 text-muted-foreground mb-3" />
              <p className="t-helper">{emptyMessage}</p>
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
              <p className="t-helper">Choose a conversation from the list to view messages</p>
            </div>
          </div>
        ) : detailContent}
      </div>
    </div>
  );
}

export type { FilterTab };
