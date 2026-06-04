import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { formatMoneyDollars } from "@/lib/format-money";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer";
import { useIsMobile } from "@/hooks/use-mobile";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Tabs as ServiceTabs, TabsContent as ServiceTabsContent, TabsList as ServiceTabsList, TabsTrigger as ServiceTabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Upload,
  Download,
  Trash2,
  FileText,
  Plus,
  Send,
  Check,
  X,
  AlertTriangle,
  Loader2,
  DollarSign,
  Copy,
  ArrowRight,
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  Pencil,
  Globe,
} from "lucide-react";
import { Label } from "@/components/ui/label";
import { SingleCountryAutocompleteInput } from "@/components/ui/country-autocomplete-input";
import { getCountryFlag, getCountryShortName } from "@/lib/country-flag";

// Mirror of server/src/modules/costs/cost-templates-config.ts. Keep these
// in sync. We don't import from server/ to avoid bundling server code.
type IvfTab =
  | "ivf_cycle"
  | "embryo_creation_only"
  | "fet"
  | "shipping_embryos"
  | "shipping_eggs_sperm"
  | "egg_freezing";

type IvfSubType =
  | "ivf_cycle_own_eggs_own_carry"
  | "ivf_cycle_own_eggs_surrogate_carry"
  | "ivf_cycle_donor_eggs_own_carry"
  | "ivf_cycle_donor_eggs_surrogate_carry"
  | "ivf_cycle_reciprocal"
  | "embryo_creation_only_own_eggs"
  | "embryo_creation_only_donor_eggs"
  | "fet_to_self"
  | "fet_to_surrogate"
  | "shipping_embryos_to_self"
  | "shipping_embryos_to_surrogate"
  | "shipping_eggs_sperm_to_self"
  | "shipping_eggs_sperm_to_surrogate"
  | "egg_freezing_retrieval_storage";

const IVF_TABS: { id: IvfTab; label: string }[] = [
  { id: "ivf_cycle", label: "IVF Cycle" },
  { id: "embryo_creation_only", label: "Embryo Creation Only" },
  { id: "fet", label: "Frozen Embryo Transfer (FET)" },
  { id: "shipping_embryos", label: "Shipping Embryos" },
  { id: "shipping_eggs_sperm", label: "Shipping Eggs + Sperm" },
  { id: "egg_freezing", label: "Egg Freezing" },
];

const SUBTYPES_BY_TAB: Record<IvfTab, { id: IvfSubType; label: string }[]> = {
  ivf_cycle: [
    { id: "ivf_cycle_own_eggs_own_carry", label: "Own eggs, own/self carry" },
    { id: "ivf_cycle_own_eggs_surrogate_carry", label: "Own eggs, surrogate carries" },
    { id: "ivf_cycle_donor_eggs_own_carry", label: "Donor eggs, own/self carry" },
    { id: "ivf_cycle_donor_eggs_surrogate_carry", label: "Donor eggs, surrogate carries" },
    { id: "ivf_cycle_reciprocal", label: "Reciprocal (own eggs, partner carries)" },
  ],
  embryo_creation_only: [
    { id: "embryo_creation_only_own_eggs", label: "Own eggs (create + freeze, no transfer)" },
    { id: "embryo_creation_only_donor_eggs", label: "Donor eggs (create + freeze, no transfer)" },
  ],
  fet: [
    { id: "fet_to_self", label: "Transfer to own/self (in-house embryos)" },
    { id: "fet_to_surrogate", label: "Transfer to surrogate (in-house embryos)" },
  ],
  shipping_embryos: [
    { id: "shipping_embryos_to_self", label: "Transfer shipped-in embryos to own/self" },
    { id: "shipping_embryos_to_surrogate", label: "Transfer shipped-in embryos to surrogate" },
  ],
  shipping_eggs_sperm: [
    { id: "shipping_eggs_sperm_to_self", label: "Create embryos + transfer to own/self" },
    { id: "shipping_eggs_sperm_to_surrogate", label: "Create embryos + transfer to surrogate" },
  ],
  egg_freezing: [
    { id: "egg_freezing_retrieval_storage", label: "Egg retrieval + storage" },
  ],
};

function tabOfSubtype(subType: string | null | undefined): IvfTab | null {
  if (!subType) return null;
  for (const tab of IVF_TABS) {
    if (SUBTYPES_BY_TAB[tab.id].some((s) => s.id === subType)) return tab.id;
  }
  return null;
}

function labelOfSubtype(subType: string | null | undefined): string | null {
  if (!subType) return null;
  for (const tab of IVF_TABS) {
    const found = SUBTYPES_BY_TAB[tab.id].find((s) => s.id === subType);
    if (found) return found.label;
  }
  return null;
}

function isIvfClinicType(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes("ivf") || lower.includes("clinic");
}

// All upload-first providers (IVF + Surrogacy + Egg Donor + Sperm Bank +
// Egg Bank + multi-service). All get the AI dropzone + classification card
// + tier section, but only IVF surfaces the 14-subtype dropdown.
function supportsUploadFirst(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === "multi-service") return true;
  return lower.includes("ivf")
    || lower.includes("clinic")
    || lower.includes("surrogacy")
    || lower.includes("egg donor")
    || lower.includes("egg bank")
    || lower.includes("sperm bank")
    || lower.includes("sperm donor");
}

// Subtype-having providers. IVF has the 14-subtype taxonomy. Egg donor has
// the simpler "fresh"/"frozen" pair. Surrogacy / sperm bank have no subtype.
// Multi-service providers don't get a fixed subtype dropdown - subtype is
// per-program and surfaces only when the program's serviceTypes include
// the relevant tag (handled inline at the program-row level).
function hasIvfSubtypes(name: string): boolean {
  if (name.toLowerCase() === "multi-service") return false;
  return isIvfClinicType(name);
}
function hasFreshFrozenSubtypes(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === "multi-service") return false;
  return lower.includes("egg donor") || lower.includes("egg bank");
}

const FRESH_FROZEN_SUBTYPES: { id: string; label: string }[] = [
  { id: "fresh", label: "Fresh donor cycle" },
  { id: "frozen", label: "Frozen egg lot" },
];

// Marketplace-style popover for the IVF subtype picker. Replaces the
// native <select> whose dropdown the OS centers on the selected item
// (and the Radix Select primitive whose value-prop semantics crash in
// this specific spot). Single-select, grouped by Tab, anchors below
// the trigger consistently. Mirrors MarketplaceFilterBar's pill style.
function IvfSubtypePopover({
  currentSubType,
  tabFilter,
  onSelect,
  triggerClassName,
}: {
  currentSubType: string | null;
  tabFilter?: IvfTab;
  onSelect: (subType: string) => void;
  // Per-callsite styling for the trigger button. The inline program-row
  // usage passes a fixed width so every IVF row's Fixed-Cost toggle lines
  // up at the same X position regardless of which subtype is selected
  // (the longest label is "Transfer to surrogate (in-house embryos)";
  // shorter labels render with extra padding on the right). The expanded
  // SingleCostsTab usage leaves it unset for a natural-width button.
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const groups = tabFilter
    ? [{ id: tabFilter, label: IVF_TABS.find(t => t.id === tabFilter)?.label || tabFilter, subtypes: SUBTYPES_BY_TAB[tabFilter] }]
    : IVF_TABS.map(t => ({ id: t.id, label: t.label, subtypes: SUBTYPES_BY_TAB[t.id] }));
  const currentLabel = currentSubType ? labelOfSubtype(currentSubType) : null;

  const trigger = (
    <Button
      variant="outline"
      size="sm"
      className={cn(
        "shrink-0 h-8 text-xs font-medium rounded-[var(--radius)] gap-1.5 px-3",
        triggerClassName,
      )}
      data-testid="select-subtype"
    >
      <span className="truncate text-left">{currentLabel || "Select program type..."}</span>
      <ChevronDown className="w-3.5 h-3.5 opacity-60 flex-shrink-0" />
    </Button>
  );

  // Shared body - rendered inside the Popover (desktop) or Drawer (mobile).
  const body = (
    <>
      {groups.map(g => (
        <div key={g.id}>
          <span
            className="font-ui text-muted-foreground mb-1.5 block"
            style={{ fontSize: 'var(--badge-text-size, 13px)' }}
          >
            {g.label}
          </span>
          <div className="flex flex-wrap gap-2.5">
            {g.subtypes.map(s => {
              const selected = currentSubType === s.id;
              return (
                <Badge
                  key={s.id}
                  variant={selected ? "default" : "outline"}
                  className="cursor-pointer font-ui px-4 py-2 rounded-full whitespace-normal text-left max-w-full"
                  style={{ fontSize: 'var(--badge-text-size, 13px)' }}
                  onClick={() => {
                    onSelect(s.id);
                    setOpen(false);
                  }}
                  data-testid={`subtype-option-${s.id}`}
                >
                  {s.label}
                </Badge>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );

  // Mobile: bottom drawer (same UX as MarketplaceFilterBar's mobile filters).
  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger asChild>{trigger}</DrawerTrigger>
        <DrawerContent data-testid="drawer-subtype">
          <DrawerHeader>
            <DrawerTitle>Program type</DrawerTitle>
          </DrawerHeader>
          <div className="px-6 pb-6 max-h-[70vh] overflow-y-auto space-y-4">
            {body}
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  // Desktop: anchored popover.
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      {/* Open downward by default - matches the dropdown mental model and
          keeps the popover well away from the sticky top nav. Radix's
          collision detection still auto-flips to "top" when the trigger is
          too close to the bottom of the viewport, but max-h is then
          clamped to --radix-popover-content-available-height so the
          popover never overflows past the viewport edge into unreachable
          space. The previous fixed cap (min(80vh, 32rem)) could exceed
          what Radix had room for when flipping upward, which is what made
          the top of the content unreachable: the popover's actual top
          sat above the visible viewport with no way to scroll up to it. */}
      <PopoverContent
        className="w-[28rem] max-w-[calc(100vw-2rem)] p-4 max-h-[var(--radix-popover-content-available-height)] overflow-y-auto"
        align="start"
        side="bottom"
        sideOffset={6}
        collisionPadding={16}
      >
        <div className="space-y-3">
          <div className="flex justify-between items-center sticky top-0 bg-popover pb-2 -mt-1 -mx-1 px-1 z-10">
            <span className="font-ui" style={{ fontSize: 'var(--filter-label-size, 18px)' }}>Program type</span>
          </div>
          {body}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Derive the service tags displayed on a program's main row from its
// canonical subTypes[]. One IVF leaf maps to one "ivf_clinic" tag; the
// non-IVF leaves map per SERVICE_TAG_OF_NON_IVF_LEAF. Dedupes.
function serviceTagsFromSubTypes(subTypes: string[] | null | undefined): string[] {
  const tags = new Set<string>();
  for (const leaf of subTypes || []) {
    if (leaf === "surrogacy") tags.add("surrogacy");
    else if (leaf === "egg_donor_fresh" || leaf === "egg_donor_frozen") tags.add("egg_donor");
    else if (leaf === "sperm_donor") tags.add("sperm_donor");
    else tags.add("ivf_clinic"); // any IVF subtype id
  }
  return Array.from(tags);
}

// Unified coverage leaf taxonomy for the top-bar Coverage toggle row.
// Each leaf is a single coverage concept admins toggle independently. The
// "ivf" leaf is virtual - selecting it surfaces the Program type popover
// (the 14-leaf IVF taxonomy) immediately to the right; the actual IVF
// subtype lives in subTypes[] as one of the ivf_*/embryo_*/fet_*/etc IDs.
const COVERAGE_LEAVES: { id: string; label: string; serviceTag: string }[] = [
  { id: "surrogacy",         label: "Surrogacy",   serviceTag: "surrogacy" },
  { id: "egg_donor_fresh",   label: "Fresh Donor", serviceTag: "egg_donor" },
  { id: "egg_donor_frozen",  label: "Frozen Egg",  serviceTag: "egg_donor" },
  { id: "sperm_donor",       label: "Sperm Donor", serviceTag: "sperm_donor" },
  { id: "ivf",               label: "IVF",         serviceTag: "ivf_clinic" },
];

// Backwards alias - some call sites still import NON_IVF_LEAVES.
const NON_IVF_LEAVES = COVERAGE_LEAVES.filter(l => l.id !== "ivf");

// IVF subtype IDs (from cost-templates-config). True when a leaf in subTypes[]
// is an IVF subtype - tells the Coverage row "IVF" toggle is on.
function hasAnyIvfSubtype(subTypes: string[] | null | undefined): boolean {
  const ivfPrefixes = ["ivf_", "embryo_creation_only", "fet_", "shipping_embryos", "shipping_eggs_sperm", "egg_freezing_"];
  return (subTypes || []).some(s => ivfPrefixes.some(p => s.startsWith(p)));
}

// Derive which leaves are visible based on provider's allowed service tags.
function leavesForServiceTags(tags: string[]): { id: string; label: string }[] {
  const allowed = new Set(tags);
  return COVERAGE_LEAVES.filter(l => allowed.has(l.serviceTag));
}

// Find the (single) IVF subtype currently in subTypes[]. Returns null if
// the program has no IVF coverage. We treat IVF as a single-select picker
// even though subTypes[] can technically hold multiple - keeps the UI tidy.
function getIvfSubtype(subTypes: string[] | null | undefined): string | null {
  const ivfPrefixes = ["ivf_", "embryo_creation_only", "fet_", "shipping_embryos", "shipping_eggs_sperm", "egg_freezing_"];
  return (subTypes || []).find(s => ivfPrefixes.some(p => s.startsWith(p))) || null;
}

// Consolidated classification controls rendered inline inside each cost
// program's top bar. Encapsulates: Coverage toggle row (Surrogacy / Fresh
// Donor / Frozen Egg / Sperm Donor / IVF), Program type popover (visible
// only when IVF leaf is on), Fixed-Cost / Not-Fixed segmented toggle, and
// the Confirm Classification button OR Confirmed badge. Owns its own
// mutations so ProgramsView can drop it in without prop-drilling.
function ProgramClassificationControls({
  program,
  providerId,
  allowedServiceTags,
  providerType,
}: {
  program: CostProgram;
  providerId: string;
  allowedServiceTags: string[];
  providerType: string;
}) {
  const { toast } = useToast();
  const visibleLeaves = leavesForServiceTags(allowedServiceTags);
  const current = program.subTypes ?? [];
  const currentIvfSubtype = getIvfSubtype(current);
  const ivfOn = !!currentIvfSubtype;
  const latestSheet = program.latestSheet ?? null;
  const needsConfirm =
    latestSheet?.isFixedCostSource === "ai_proposed" ||
    latestSheet?.isFixedCostSource == null ||
    latestSheet?.legacyNeedsReview === true;
  // hasInteracted used to gate the Confirm button on whether the clinic
  // had clicked one of the Fixed-Cost / Not Fixed Costs toggles in this
  // render cycle. That guard was added when the AI's pre-population was
  // unreliable - now it always populates correctly, and the guard mostly
  // made the button look clickable while silently doing nothing because
  // disabled. Derived directly from the data now: if a value exists
  // (either AI-proposed or clinic-confirmed) the action is valid; if
  // it's still null we keep the button disabled with a tooltip telling
  // the clinic to pick a toggle first. setHasInteracted is still wired
  // through the toggle clicks below but no longer gates anything - kept
  // as a no-op for now to avoid touching every onClick.
  const hasInteracted = latestSheet?.isFixedCost != null;
  const setHasInteracted = (_v: boolean) => { /* no-op; see comment above */ };

  // Invalidations target every query the row depends on:
  //   - /api/costs/programs - the ProgramsView programs list (where this
  //     row's latestSheet status comes from). Previously this was the
  //     /api/costs/provider/.../programs key, which DOES NOT EXIST as a
  //     real query - so the cache never busted and the row stayed on
  //     "Confirm Classification" until the user reloaded.
  //   - /api/costs/provider/.../sheets and /approved - SingleCostsTab's
  //     queries inside the expanded program body, in case the user has
  //     it open.
  const invalidateRowAndSheet = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/costs/programs"] });
    queryClient.invalidateQueries({ queryKey: ["/api/costs/provider", providerId], exact: false });
  };

  const updateSubTypesMutation = useMutation({
    mutationFn: ({ subTypes }: { subTypes: string[] }) =>
      apiRequest("PATCH", `/api/costs/programs/${program.id}`, { subTypes }),
    onSuccess: invalidateRowAndSheet,
    onError: (err: any) => toast({ title: "Failed to update coverage", description: err.message, variant: "destructive" }),
  });

  const classificationMutation = useMutation({
    mutationFn: (payload: { isFixedCost?: boolean; confirm?: boolean }) =>
      apiRequest("PATCH", `/api/costs/sheet/${latestSheet!.id}/classification`, payload),
    onSuccess: invalidateRowAndSheet,
    onError: (err: any) => toast({ title: "Failed to save classification", description: err.message, variant: "destructive" }),
  });

  const toggleLeaf = (leafId: string) => {
    if (leafId === "ivf") {
      // Toggling IVF removes ALL IVF subtypes if currently on, or
      // adds a sensible default if currently off (the Program type
      // popover next to it lets admin refine).
      if (ivfOn) {
        const next = current.filter(s => !s.startsWith("ivf_") && !s.startsWith("embryo_") && !s.startsWith("fet_") && !s.startsWith("shipping_") && !s.startsWith("egg_freezing_"));
        updateSubTypesMutation.mutate({ subTypes: next });
      } else {
        const next = [...current, "ivf_cycle_own_eggs_own_carry"];
        updateSubTypesMutation.mutate({ subTypes: next });
      }
      return;
    }
    const has = current.includes(leafId);
    const next = has ? current.filter(s => s !== leafId) : [...current, leafId];
    updateSubTypesMutation.mutate({ subTypes: next });
  };

  const setIvfSubtype = (newSub: string) => {
    // Replace current IVF leaf with the new one, keep non-IVF leaves intact.
    const nonIvf = current.filter(s => !s.startsWith("ivf_") && !s.startsWith("embryo_") && !s.startsWith("fet_") && !s.startsWith("shipping_") && !s.startsWith("egg_freezing_"));
    updateSubTypesMutation.mutate({ subTypes: [...nonIvf, newSub] });
  };

  return (
    <>
      {/* Each section is wrapped in a fixed-width "slot" so the rows in
          the programs list visually line up column-by-column - the
          coverage toggle on row N sits at the same horizontal position
          as the coverage toggle on row N+1, regardless of program name
          length, presence of the IVF program-type popover, or total
          badge width. Without these slots the flexbox right-edge
          alignment of the trailing group shifted everything sideways
          per row based on each row's total amount. */}

      {/* Slot 1: Coverage (multi-select pills). Natural width with
          flex-shrink-0 so the chip set doesn't compress on narrow
          viewports. The same provider has the same visibleLeaves
          on every row so widths match naturally across rows. */}
      <div className="flex items-center flex-shrink-0">
        {visibleLeaves.length > 0 && (
          <div className="inline-flex gap-1 p-1 bg-background border-2 border-accent/40 rounded-[var(--radius)] shadow-sm items-center">
            {visibleLeaves.map(leaf => {
              const selected = leaf.id === "ivf" ? ivfOn : current.includes(leaf.id);
              return (
                <button
                  key={`cov-${program.id}-${leaf.id}`}
                  type="button"
                  onClick={(e) => { e.stopPropagation(); toggleLeaf(leaf.id); }}
                  className={cn(
                    "px-2.5 py-1 text-xs rounded-[var(--radius)] transition-all font-medium whitespace-nowrap",
                    selected ? "bg-accent text-accent-foreground shadow-sm" : "text-foreground hover:bg-accent/10",
                  )}
                  data-testid={`top-leaf-${program.id}-${leaf.id}`}
                >
                  {leaf.label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Slot 2: IVF subtype picker. Only emitted when ivfOn so non-IVF
          rows don't reserve a phantom column. Fixed-width trigger (w-72
          = 288px) so the Fixed-Cost / Not Fixed Costs toggle in the next
          slot starts at exactly the same X position on every IVF row,
          regardless of which subtype is selected. The width was sized
          against the longest label ("Transfer to surrogate (in-house
          embryos)"), with truncation as a safety net for any future
          label that grows beyond it. */}
      {ivfOn && (
        <div className="flex items-center flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          <IvfSubtypePopover
            currentSubType={currentIvfSubtype}
            onSelect={setIvfSubtype}
            triggerClassName="w-72 justify-between"
          />
        </div>
      )}

      {/* Slot 3: Cost (Fixed-Cost / Not Fixed Costs segmented toggle).
          The original long labels are back now that the country chip
          abbreviates to "USA" / "UK" / etc. - that reclaimed enough
          horizontal space on the row for the full labels to fit
          without colliding with wide totals like "$6,500 - $20,000
          (draft)". */}
      <div className="flex items-center flex-shrink-0">
        {latestSheet && (
          <div className="inline-flex gap-1 p-1 bg-background border-2 border-accent/40 rounded-[var(--radius)] shadow-sm" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className={cn(
                "px-2.5 py-1 text-xs rounded-[var(--radius)] transition-all font-medium whitespace-nowrap",
                latestSheet.isFixedCost === true ? "bg-accent text-accent-foreground shadow-sm" : "text-foreground hover:bg-accent/10",
              )}
              onClick={() => { setHasInteracted(true); classificationMutation.mutate({ isFixedCost: true }); }}
              disabled={classificationMutation.isPending}
              data-testid={`top-mark-fixed-${program.id}`}
            >
              Fixed-Cost
            </button>
            <button
              type="button"
              className={cn(
                "px-2.5 py-1 text-xs rounded-[var(--radius)] transition-all font-medium whitespace-nowrap",
                latestSheet.isFixedCost === false ? "bg-accent text-accent-foreground shadow-sm" : "text-foreground hover:bg-accent/10",
              )}
              onClick={() => { setHasInteracted(true); classificationMutation.mutate({ isFixedCost: false }); }}
              disabled={classificationMutation.isPending}
              data-testid={`top-mark-not-fixed-${program.id}`}
            >
              Not Fixed Costs
            </button>
          </div>
        )}
      </div>

      {/* The Confirm button + Confirmed badge used to live here as Slot 4,
          but the flex-1 / overflow-hidden wrapper that holds this whole
          control bar kept clipping the button whenever the program's total
          column was wide (e.g. "$30,600 (draft)" or "$166,910 - $171,910
          (draft)"). Moved to ProgramConfirmIconButton, which is rendered
          OUTSIDE the flex-1 wrapper as a sibling of the Pencil / Trash /
          Chevron action icons, so the action area always has reserved
          horizontal space and the icon can never get cut off. */}
    </>
  );
}

// Compact icon-only button for confirming the AI's Fixed-Cost vs Not-Fixed
// classification. Renders three visual states from the latest sheet:
//   - clinic_confirmed -> filled green-tinted check (disabled, decorative)
//   - ai_proposed/null + a Fixed-Cost choice picked -> solid green primary
//     button you can click to confirm
//   - ai_proposed/null + no Fixed-Cost choice yet -> muted disabled button
//     with a tooltip telling the clinic to click Fixed-Cost or Not Fixed
//     Costs first
// Hover tooltip explains the current action in plain English so the icon
// is never cryptic. Lives in the action-icon group (next to Pencil/Trash/
// Chevron) so it gets the same reserved width as the other icon buttons
// and can't be clipped by the row's overflow-hidden wrapper.
function ProgramConfirmIconButton({
  program,
  providerId,
}: {
  program: CostProgram;
  providerId: string;
}) {
  const { toast } = useToast();
  const latestSheet = program.latestSheet ?? null;
  const needsConfirm =
    latestSheet?.isFixedCostSource === "ai_proposed" ||
    latestSheet?.isFixedCostSource == null ||
    latestSheet?.legacyNeedsReview === true;
  const isConfirmed = latestSheet?.isFixedCostSource === "clinic_confirmed";
  const hasInteracted = latestSheet?.isFixedCost != null;

  const invalidateRowAndSheet = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/costs/programs"] });
    queryClient.invalidateQueries({ queryKey: ["/api/costs/provider", providerId], exact: false });
  };

  const classificationMutation = useMutation({
    mutationFn: (payload: { isFixedCost?: boolean; confirm?: boolean }) =>
      apiRequest("PATCH", `/api/costs/sheet/${latestSheet!.id}/classification`, payload),
    onSuccess: (_data, vars) => {
      invalidateRowAndSheet();
      // Explicit success feedback - the icon's color change alone is too
      // subtle for the user to register that the click did anything, so we
      // surface a toast on the confirm action specifically.
      if (vars?.confirm === true) {
        toast({
          title: "Classification confirmed",
          description: "This sheet's Fixed-Cost classification is locked in.",
        });
      }
    },
    onError: (err: any) => toast({ title: "Failed to save classification", description: err.message, variant: "destructive" }),
  });

  if (!latestSheet) return null;

  if (isConfirmed) {
    // Decorative state: clinic already confirmed. Now visually distinct from
    // the clickable needs-confirm state - a SOLID green circle background
    // with a white check inside, vs. the needs-confirm state which is a
    // simple ghost icon. Previously both states rendered the same green
    // check on a transparent background, so clicking confirm did nothing
    // visible even though the DB and cache had updated correctly.
    return (
      <Button
        size="sm"
        variant="ghost"
        className="h-7 w-7 p-0 rounded-full bg-[hsl(var(--brand-success))] text-white hover:bg-[hsl(var(--brand-success))]/90 cursor-default flex items-center justify-center"
        title="Classification confirmed by the clinic"
        onClick={(e) => e.stopPropagation()}
        data-testid={`top-confirmed-${program.id}`}
      >
        <Check className="w-4 h-4 stroke-[3]" />
      </Button>
    );
  }

  if (!needsConfirm) return null;

  // Disabled until the clinic acknowledges the AI's Fixed-Cost / Not Fixed
  // Costs choice by clicking one of the two toggles in the control bar.
  // We keep the icon visible so the clinic understands an action is
  // pending; the tooltip explains the gate.
  const disabled = classificationMutation.isPending || !hasInteracted;
  const titleText = !hasInteracted
    ? "Click Fixed-Cost or Not Fixed Costs first to confirm the AI's classification"
    : "Confirm classification";

  return (
    <Button
      size="sm"
      variant="ghost"
      className={cn(
        "h-7 w-7 p-0",
        disabled
          ? "text-muted-foreground/60"
          : "text-[hsl(var(--brand-success))] hover:bg-[hsl(var(--brand-success))]/10",
      )}
      disabled={disabled}
      title={titleText}
      onClick={(e) => {
        e.stopPropagation();
        classificationMutation.mutate({ isFixedCost: latestSheet.isFixedCost ?? false, confirm: true });
      }}
      data-testid={`top-confirm-${program.id}`}
    >
      {classificationMutation.isPending
        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
        : <Check className="w-4 h-4" />}
    </Button>
  );
}

interface CostItemData {
  id?: string;
  templateFieldId?: string | null;
  category: string;
  key: string;
  minValue: number | null;
  maxValue: number | null;
  isCustom: boolean;
  comment: string | null;
  isIncluded: boolean;
  isTier?: boolean;
  sortOrder: number;
  _isVariant?: boolean;
}

interface CostTemplate {
  id: string;
  category: string;
  fieldName: string;
  fieldDescription: string | null;
  isMandatory: boolean;
  isBaseCompensation: boolean;
  allowMultiple: boolean;
  sortOrder: number;
  subType?: string | null;
}

const NUMERIC_ONLY_FIELDS = new Set([
  "Number of Eggs in Egg Lot",
  "Number of Egg Retrievals Included",
  "Number of Sperm Collections Included",
  "Number of Transfers Included",
]);

function isNumericOnlyField(fieldName: string): boolean {
  return NUMERIC_ONLY_FIELDS.has(fieldName);
}

interface CostSheet {
  id: string;
  providerId: string;
  parentClientId: string | null;
  programId: string | null;
  fileUrl: string | null;
  filePath: string | null;
  originalFileName: string | null;
  status: string;
  adminFeedback: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  items: CostItemData[];
  tab: string | null;
  subType: string | null;
  isFixedCost: boolean | null;
  isFixedCostSource: string | null;
  legacyNeedsReview: boolean;
  parseStage?: string | null;
  parseProgress?: number | null;
  parseItemsCount?: number | null;
}

interface CostProgram {
  id: string;
  providerId: string;
  providerTypeId: string | null;
  tab: string | null;
  subType: string | null;
  subTypes: string[];
  serviceTypes: string[];
  name: string;
  country: string;
  createdAt: string;
  latestSheetStatus: string | null;
  // Items from the latest master (parentClientId=null) sheet for this
  // program - the ProgramTotalBadge reads these directly so it can derive
  // the total without firing its own queries that were susceptible to
  // stale-cache after a fresh upload+parse cycle.
  latestSheetItems?: CostItemData[];
  // Phase: latest sheet metadata needed by the top-bar classification
  // controls (Fixed/Not Fixed toggle + Confirm button). Null when no
  // master sheet exists yet (newly created program).
  latestSheet?: {
    id: string;
    isFixedCost: boolean | null;
    isFixedCostSource: string | null;
    legacyNeedsReview: boolean;
    status: string;
  } | null;
}

const SERVICE_TYPE_LABELS: Record<string, string> = {
  ivf_clinic: "IVF",
  surrogacy: "Surrogacy",
  egg_donor: "Egg Donor",
  sperm_donor: "Sperm Donor",
};
const ALL_SERVICE_TYPES = ["surrogacy", "egg_donor", "sperm_donor", "ivf_clinic"] as const;

interface ServiceInfo {
  providerTypeId: string;
  providerTypeName: string;
}

interface SingleCostsTabProps {
  providerType: string;
  providerTypeId?: string;
  providerId: string;
  isAdminView: boolean;
  parentId?: string;
  subType?: string;
  programId?: string;
  programSubType?: string | null;
  programTab?: string | null;
  // Program-type picker config - lifted into the classification card so
  // both the AI-confirmation toggle and the subtype picker live in the
  // same green/amber surface.
  programShowsAnySubtype?: boolean;
  programShowsIvfSubtype?: boolean; // true => IVF taxonomy dropdown; false => unified leaf-toggle row
  programCurrentSubType?: string | null;
  programTabFilter?: IvfTab;
  onSubTypeChange?: (subType: string, tab?: string) => void;
  // Services-covered multi-select - lifted into the classification card
  // alongside the subtype + Fixed/Not-Fixed toggles. Disabled until the
  // provider has at least one approved service we can map a tag from.
  allowedServiceTags?: string[];
  programServiceTypes?: string[];
  onServiceTypesChange?: (next: string[]) => void;
  // Multi-select coverage: canonical subTypes[] (leaves) for non-IVF
  // programs. Replaces the legacy services + program-type two-row UI with
  // a single multi-select toggle row.
  programCurrentSubTypes?: string[];
  onSubTypesChange?: (next: string[]) => void;
}

interface ProviderCostsTabProps {
  providerType: string;
  providerId: string;
  isAdminView: boolean;
  canManagePrograms?: boolean;
  parentId?: string;
  providerServices?: ServiceInfo[];
}

function calculateTotalCost(
  costItems: CostItemData[],
  specificProfile?: { compensationValue?: number },
): { minTotal: number; maxTotal: number } {
  let minTotal = 0;
  let maxTotal = 0;

  // Tier items are alternatives (parent picks one), not additive. Sum
  // only the non-tier items into the baseline, then add the CHEAPEST
  // tier on top so the provider sees one representative total.
  const tierItems: CostItemData[] = [];

  for (const item of costItems) {
    if (!item.isIncluded) continue;
    if (item.isTier) {
      tierItems.push(item);
      continue;
    }

    const baseKey = item.key.replace(/\s*\((?:Standard|Variant \d+)\)$/, "");
    if (isNumericOnlyField(baseKey)) continue;

    const min = item.minValue ?? 0;
    const max = item.maxValue ?? min;
    const effectiveMin = min;
    const effectiveMax = max === 0 && min > 0 ? min : max;

    if (
      specificProfile?.compensationValue !== undefined &&
      item.key &&
      (item.key.toLowerCase().includes("compensation") ||
        item.category.toLowerCase() === "compensation")
    ) {
      minTotal += specificProfile.compensationValue;
      maxTotal += specificProfile.compensationValue;
    } else {
      minTotal += effectiveMin;
      maxTotal += effectiveMax;
    }
  }

  if (tierItems.length > 0) {
    const tierPrices = tierItems
      .map((t) => t.minValue ?? t.maxValue ?? 0)
      .filter((v) => v > 0);
    if (tierPrices.length > 0) {
      // Spread the tier prices across the range: cheapest tier goes into
      // the minTotal (parent's entry-point cost), most-expensive into the
      // maxTotal (top of the range). The program badge then displays
      // "$X - $Y" automatically via its existing min/max range formatter.
      minTotal += Math.min(...tierPrices);
      maxTotal += Math.max(...tierPrices);
    }
  }

  return { minTotal, maxTotal };
}

function mergeSheetWithTemplate(
  sheetItems: CostItemData[],
  templateItems: CostItemData[],
): CostItemData[] {
  const usedTemplateIds = new Set<string>();
  const usedCatKeys = new Set<string>();
  const result: CostItemData[] = [];

  for (const si of sheetItems) {
    if (si.templateFieldId) {
      const tpl = templateItems.find((t) => t.templateFieldId === si.templateFieldId);
      if (tpl) {
        result.push({
          ...si,
          category: tpl.category,
          key: tpl.key,
          sortOrder: tpl.sortOrder,
        });
        usedTemplateIds.add(tpl.templateFieldId!);
        continue;
      }
    }
    const catKeyMatch = templateItems.find(
      (t) => t.category === si.category && t.key === si.key && !usedTemplateIds.has(t.templateFieldId!),
    );
    if (catKeyMatch) {
      result.push({ ...si, templateFieldId: catKeyMatch.templateFieldId, sortOrder: catKeyMatch.sortOrder });
      usedTemplateIds.add(catKeyMatch.templateFieldId!);
      usedCatKeys.add(`${si.category}::${si.key}`);
    } else if (si.isCustom || si._isVariant) {
      result.push(si);
    } else {
      result.push({ ...si, isCustom: true });
    }
  }

  for (const tpl of templateItems) {
    if (tpl.templateFieldId && !usedTemplateIds.has(tpl.templateFieldId)) {
      result.push({ ...tpl });
    }
  }

  result.sort((a, b) => {
    const aIdx = templateItems.findIndex((t) => t.templateFieldId && t.templateFieldId === a.templateFieldId);
    const bIdx = templateItems.findIndex((t) => t.templateFieldId && t.templateFieldId === b.templateFieldId);
    if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
    if (aIdx !== -1) return -1;
    if (bIdx !== -1) return 1;
    return a.sortOrder - b.sortOrder;
  });

  return result.map((item, idx) => ({ ...item, sortOrder: idx }));
}

const formatCurrency = formatMoneyDollars;

function getStatusBadge(status: string) {
  switch (status) {
    case "APPROVED":
      return <Badge data-testid="badge-status-approved" className="bg-[hsl(var(--brand-success))]/15 text-[hsl(var(--brand-success))] border-[hsl(var(--brand-success))]/30">Approved</Badge>;
    case "DRAFT":
      return <Badge data-testid="badge-status-draft" className="bg-muted text-muted-foreground border-border">Draft</Badge>;
    case "PENDING":
      return <Badge data-testid="badge-status-pending" className="bg-[hsl(var(--brand-warning))]/15 text-[hsl(var(--brand-warning))] border-[hsl(var(--brand-warning))]/30">Pending Review</Badge>;
    case "REJECTED":
      return <Badge data-testid="badge-status-rejected" className="bg-destructive/10 text-destructive border-destructive/30">Rejected</Badge>;
    case "SENT_TO_PARENT":
      return <Badge data-testid="badge-status-sent" className="bg-[hsl(var(--accent))]/15 text-[hsl(var(--accent))] border-[hsl(var(--accent))]/30">Sent to Parent</Badge>;
    case "ARCHIVED":
      return <Badge data-testid="badge-status-archived" className="bg-muted text-muted-foreground border-border">Archived</Badge>;
    default:
      return <Badge>{status}</Badge>;
  }
}

function DiffValueCell({ label, pendingVal, approvedVal, isCurrency = true }: { label: string; pendingVal: number | null; approvedVal: number | null; isCurrency?: boolean }) {
  const pv = pendingVal ?? 0;
  const av = approvedVal ?? 0;
  const changed = pv !== av;
  const fmt = (v: number) => isCurrency ? formatCurrency(v) : String(v);

  return (
    <div className="text-right">
      <span className={`text-sm font-medium tabular-nums ${changed ? "text-[hsl(var(--brand-warning))] font-bold" : ""}`}>
        {pendingVal != null ? fmt(pendingVal) : "-"}
      </span>
      {changed && approvedVal != null && (
        <div className="text-xs text-muted-foreground line-through">
          {fmt(approvedVal)}
        </div>
      )}
    </div>
  );
}

function SingleCostsTab({
  providerType,
  providerTypeId,
  providerId,
  isAdminView,
  parentId,
  subType,
  programId,
  programSubType,
  programTab,
  programShowsAnySubtype,
  programShowsIvfSubtype: programShowsIvfSubtypeProp,
  programCurrentSubType,
  programTabFilter,
  onSubTypeChange,
  allowedServiceTags,
  programServiceTypes,
  onServiceTypesChange,
  programCurrentSubTypes,
  onSubTypesChange,
}: SingleCostsTabProps) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingFileRef = useRef<File | null>(null);
  const [editItems, setEditItems] = useState<CostItemData[]>([]);
  const [isEditing, setIsEditing] = useState(!isAdminView);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectFeedback, setRejectFeedback] = useState("");
  const [rejectSheetId, setRejectSheetId] = useState("");
  const [isParsing, setIsParsing] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [parseProgress, setParseProgress] = useState(0);
  const [parseStage, setParseStage] = useState("");
  const parseTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [accordionValue, setAccordionValue] = useState<string[]>([]);
  // Track whether the user has actively clicked one of the Fixed-Cost /
  // Not Fixed Costs toggles since landing on this sheet. The AI's proposed
  // value alone doesn't count - the clinic has to interact with the toggle
  // so we know they actually saw and considered it before clicking Confirm.
  // Resets when the displayed sheet changes (different program expanded).
  const [hasInteractedWithFixedToggle, setHasInteractedWithFixedToggle] = useState(false);

  // When inside an IVF program, use programSubType (ivf_cycle / shipping_embryos) for the template query.
  // For egg donation programs the existing subType prop (fresh/frozen) is used as-is.
  const effectiveSubType = programSubType !== undefined ? (programSubType ?? undefined) : subType;
  const subTypeParam = effectiveSubType ? `?subType=${encodeURIComponent(effectiveSubType)}` : "";
  const templatesQuery = useQuery<{ providerTypeId: string; templates: Record<string, CostTemplate[]> }>({
    queryKey: ["/api/costs/templates", providerType, effectiveSubType || "default"],
    queryFn: () => fetch(`/api/costs/templates/${encodeURIComponent(providerType)}${subTypeParam}`).then((r) => r.json()),
    enabled: !!providerType,
  });

  const sheetsParams = new URLSearchParams();
  if (programId) {
    sheetsParams.set("programId", programId);
  } else {
    if (providerTypeId) sheetsParams.set("providerTypeId", providerTypeId);
    if (subType) sheetsParams.set("subType", subType);
  }
  const sheetsQueryString = sheetsParams.toString() ? `?${sheetsParams.toString()}` : "";
  const sheetsQuery = useQuery<CostSheet[]>({
    queryKey: ["/api/costs/provider", providerId, "sheets", providerTypeId || "all", subType || "default", programId || "none"],
    queryFn: () => fetch(`/api/costs/provider/${providerId}${sheetsQueryString}`).then((r) => r.json()),
    enabled: !!providerId,
  });

  const approvedQuery = useQuery<CostSheet | null>({
    queryKey: ["/api/costs/provider", providerId, "approved", providerTypeId || "all", subType || "default", programId || "none"],
    queryFn: () => fetch(`/api/costs/provider/${providerId}/approved${sheetsQueryString}`).then((r) => r.json()),
    enabled: !!providerId,
  });

  const invalidateAll = () => {
    // Use prefix matches so we hit every sheets/approved variant for this
    // provider regardless of how the query key includes providerTypeId /
    // subType / programId. Without the prefix the ProgramTotalBadge (which
    // builds its query key with hardcoded "none" placeholders for those
    // params) stayed stale after a fresh upload until manual refresh.
    queryClient.invalidateQueries({ queryKey: ["/api/costs/provider", providerId], exact: false });
    // Programs query carries name + country + subType + tab which the AI
    // updates after upload-first parse. Refresh it too so the program row
    // reflects the new values without a manual reload.
    queryClient.invalidateQueries({ queryKey: ["/api/costs/programs"] });
  };

  // Real progress is driven by polling the sheet row's parseStage /
  // parseProgress / parseItemsCount fields, which the backend updates as
  // Gemini streams items in. The local-only setters here just initialize
  // the bar (so the UI doesn't flash at 0%) and clear it when done. No
  // fake setInterval - the bar moves only when the server reports new state.
  const startParseProgress = useCallback(() => {
    setParseProgress(5);
    setParseStage("Uploading document...");
  }, []);

  const stopParseProgress = useCallback((success: boolean) => {
    if (parseTimerRef.current) {
      clearInterval(parseTimerRef.current);
      parseTimerRef.current = null;
    }
    if (success) {
      setParseProgress(100);
      setParseStage("Complete!");
      setTimeout(() => {
        setParseProgress(0);
        setParseStage("");
      }, 600);
    } else {
      setParseProgress(0);
      setParseStage("");
    }
  }, []);

  const templateItems = useMemo((): CostItemData[] => {
    const templates = templatesQuery.data?.templates;
    if (!templates || typeof templates !== "object") return [];
    const items: CostItemData[] = [];
    let sortIdx = 0;
    for (const [category, fields] of Object.entries(templates)) {
      for (const field of fields) {
        items.push({
          templateFieldId: field.id,
          category,
          key: field.fieldName,
          minValue: null,
          maxValue: null,
          isCustom: false,
          comment: null,
          isIncluded: true,
          sortOrder: sortIdx++,
        });
      }
    }
    return items;
  }, [templatesQuery.data]);

  const handleAiParse = useCallback(
    async (file: File) => {
      setIsParsing(true);
      startParseProgress();
      try {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("providerType", providerType);
        const res = await fetch("/api/costs/parse", { method: "POST", body: formData, credentials: "include" });
        if (!res.ok) throw new Error((await res.json()).message);
        const data = await res.json();

        const parsedItems: CostItemData[] = (data.items || []).map(
          (item: any, idx: number) => ({
            category: item.category,
            key: item.key,
            minValue: item.minValue,
            maxValue: item.maxValue,
            isCustom: item.isCustom || false,
            comment: item.comment || null,
            isIncluded: item.isIncluded !== false,
            sortOrder: idx,
          }),
        );

        const merged = templateItems.map((tpl) => {
          const match = parsedItems.find(
            (p) => p.category === tpl.category && p.key === tpl.key,
          );
          return match ? { ...tpl, minValue: match.minValue, maxValue: match.maxValue, comment: match.comment, isIncluded: match.isIncluded } : { ...tpl };
        });
        const customItems = parsedItems.filter(
          (p) => p.isCustom || !templateItems.some((t) => t.category === p.category && t.key === p.key),
        );
        const finalItems = [...merged, ...customItems].map((item, i) => ({ ...item, sortOrder: i }));

        stopParseProgress(true);
        setEditItems(finalItems);
        setIsEditing(true);
        setTimeout(() => {
          saveDraftMutationRef.current.mutate(finalItems);
        }, 100);
        const filledCount = parsedItems.length;
        toast({ title: "AI parsing complete", description: `${filledCount} items extracted and merged into template`, variant: "success" });
      } catch (err: any) {
        stopParseProgress(false);
        toast({ title: "AI parsing failed", description: err.message, variant: "destructive" });
      } finally {
        setIsParsing(false);
      }
    },
    [providerType, toast, startParseProgress, stopParseProgress, templateItems],
  );

  const startPollingForParse = useCallback((sheetId: string, resuming: boolean) => {
    setIsParsing(true);
    // Initial UI state - replaced by the first poll response which carries
    // the real parseStage / parseProgress / parseItemsCount that the
    // backend has been writing as Gemini streams.
    if (resuming) {
      setParseProgress(15);
      setParseStage("Resuming parse...");
    } else {
      startParseProgress();
    }
    // Faster cadence (1s) for the streaming era - the backend now updates
    // progress 2-3x/sec while items pour in, so 2s feels laggy.
    const poll = setInterval(async () => {
      try {
        const res = await fetch(`/api/costs/sheet/${sheetId}`, { credentials: "include" });
        if (res.status === 404) { clearInterval(poll); stopParseProgress(false); setIsParsing(false); invalidateAll(); return; }
        if (!res.ok) return;
        const sheet = await res.json();
        // Mid-parse: pull real stage + percentage off the row. The backend
        // increments these as Gemini's stream chunks arrive (see
        // CostsController.backgroundParseAndSave). itemsCount shown in the
        // label gives the user live feedback that work is actually happening.
        if (sheet.status === "PARSING") {
          if (typeof sheet.parseProgress === "number" && sheet.parseProgress > 0) {
            setParseProgress(sheet.parseProgress);
          }
          if (typeof sheet.parseStage === "string" && sheet.parseStage.length > 0) {
            setParseStage(sheet.parseStage);
          }
        }
        if (sheet.status !== "PARSING") {
          clearInterval(poll);
          stopParseProgress(true);
          setIsParsing(false);
          invalidateAll();
          if (sheet.items && sheet.items.length > 0) {
            const items = sheet.items.map((item: any, idx: number) => ({
              id: item.id,
              templateFieldId: item.templateFieldId,
              category: item.category,
              key: item.key,
              minValue: item.minValue,
              maxValue: item.maxValue,
              isCustom: item.isCustom || false,
              comment: item.comment || null,
              isIncluded: item.isIncluded !== false,
              sortOrder: item.sortOrder ?? idx,
            }));
            setEditItems(items);
            setIsEditing(true);
            setIsDirty(true);
            const filledCount = items.filter((i: CostItemData) => i.minValue !== null || i.maxValue !== null).length;
            toast({ title: "AI parsing complete", description: `${filledCount} cost items extracted`, variant: "success" });
          }
        }
      } catch {}
    }, 1000);
    return poll;
  }, [startParseProgress, stopParseProgress, invalidateAll, toast]);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => { return () => { if (pollRef.current) clearInterval(pollRef.current); }; }, []);

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("providerId", providerId);
      formData.append("providerType", providerType);
      if (providerTypeId) formData.append("providerTypeId", providerTypeId);
      if (effectiveSubType) formData.append("subType", effectiveSubType);
      if (programId) formData.append("programId", programId);
      const res = await fetch("/api/costs/upload", { method: "POST", body: formData, credentials: "include" });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    onSuccess: (sheet: any) => {
      invalidateAll();
      toast({ title: "File uploaded - parsing with AI..." });
      if (sheet.status === "PARSING") {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = startPollingForParse(sheet.id, false);
      }
    },
    onError: (err: any) => {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (_sheetId: string) => {
      const resetParams = new URLSearchParams();
      // Scope the reset to this specific program when we have one. Without
      // it the server falls back to providerTypeId+subType which doesn't
      // match anything post-migration (every sheet has a non-null subType).
      if (programId) {
        resetParams.set("programId", programId);
      } else {
        if (providerTypeId) resetParams.set("providerTypeId", providerTypeId);
        if (subType) resetParams.set("subType", subType);
      }
      const resetQs = resetParams.toString() ? `?${resetParams.toString()}` : "";
      await apiRequest("DELETE", `/api/costs/reset/${providerId}${resetQs}`);
    },
    onSuccess: () => {
      invalidateAll();
      setEditItems([...templateItems]);
      setIsEditing(true);
      toast({ title: "Cost sheet reset to default template", variant: "success" });
    },
  });

  const cancelUploadMutation = useMutation({
    mutationFn: async (sheetId: string) => {
      await apiRequest("DELETE", `/api/costs/${sheetId}/cancel`);
    },
    onSuccess: () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      stopParseProgress(false);
      setIsParsing(false);
      invalidateAll();
      toast({ title: "Upload cancelled", variant: "success" });
    },
  });

  const submitMutation = useMutation({
    mutationFn: async (data: { items: CostItemData[]; sheetId?: string }) => {
      return apiRequest("POST", "/api/costs/submit", {
        providerId,
        items: data.items,
        sheetId: data.sheetId,
        providerTypeId,
        subType: effectiveSubType,
        programId,
      });
    },
    onSuccess: () => {
      invalidateAll();
      setIsDirty(false);
      if (isAdminView) setIsEditing(false);
      toast({ title: isAdminView ? "Cost sheet saved and approved" : "Cost sheet submitted for review", variant: "success" });
    },
    onError: (err: any) => {
      toast({ title: "Submit failed", description: err.message, variant: "destructive" });
    },
  });

  const approveMutation = useMutation({
    mutationFn: async (sheetId: string) => {
      return apiRequest("POST", `/api/costs/approve/${sheetId}`);
    },
    onSuccess: () => {
      invalidateAll();
      toast({ title: "Cost sheet approved", variant: "success" });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: async ({ sheetId, feedback }: { sheetId: string; feedback: string }) => {
      return apiRequest("POST", `/api/costs/reject/${sheetId}`, { feedback });
    },
    onSuccess: () => {
      invalidateAll();
      setRejectDialogOpen(false);
      setRejectFeedback("");
      toast({ title: "Cost sheet rejected", variant: "success" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ sheetId, items }: { sheetId: string; items: CostItemData[] }) => {
      return apiRequest("PATCH", `/api/costs/sheet/${sheetId}`, { items });
    },
    onSuccess: () => {
      invalidateAll();
      if (isAdminView) setIsEditing(false);
      toast({ title: "Cost items saved", variant: "success" });
    },
  });

  const [autoSaveStatus, setAutoSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSavePendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const saveDraftMutation = useMutation({
    mutationFn: async (items: CostItemData[]) => {
      return apiRequest("POST", "/api/costs/save-draft", {
        providerId,
        items,
        sheetId: latestMaster?.status === "APPROVED" ? undefined : latestMaster?.id,
        providerTypeId,
        subType,
        programId,
      });
    },
    onSuccess: () => {
      setAutoSaveStatus("saved");
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = setTimeout(() => setAutoSaveStatus("idle"), 2000);
      queryClient.invalidateQueries({ queryKey: ["/api/costs/provider", providerId, "sheets", providerTypeId || "all", subType || "default"] });
    },
    onError: () => {
      setAutoSaveStatus("idle");
    },
  });

  const saveDraftMutationRef = useRef(saveDraftMutation);
  saveDraftMutationRef.current = saveDraftMutation;

  const editItemsRef = useRef<CostItemData[]>(editItems);
  editItemsRef.current = editItems;

  const triggerAutoSave = useCallback(() => {
    if (!isEditing) return;
    if (isAdminView && !isDirty) return;
    const items = editItemsRef.current;
    if (!items || items.length === 0) return;
    if (autoSavePendingTimerRef.current) clearTimeout(autoSavePendingTimerRef.current);
    autoSavePendingTimerRef.current = setTimeout(() => {
      autoSavePendingTimerRef.current = null;
      setAutoSaveStatus("saving");
      saveDraftMutationRef.current.mutate(editItemsRef.current);
    }, 500);
  }, [isEditing, isAdminView, isDirty]);

  const createQuoteMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", `/api/costs/custom-quote/${providerId}/${parentId}`);
    },
    onSuccess: () => {
      invalidateAll();
      toast({ title: "Custom quote created", variant: "success" });
    },
    onError: (err: any) => {
      toast({ title: "Failed", description: err.message, variant: "destructive" });
    },
  });

  const sendQuoteMutation = useMutation({
    mutationFn: async (sheetId: string) => {
      return apiRequest("POST", `/api/costs/send-quote/${sheetId}`);
    },
    onSuccess: () => {
      invalidateAll();
      toast({ title: "Quote sent to parent", variant: "success" });
    },
  });

  // Update the AI-proposed classification (tab + subType + isFixedCost).
  // The server only flips source -> clinic_confirmed when payload.confirm
  // === true (sent by the explicit Confirm button). Toggling the Fixed pill
  // alone just updates the value but keeps the AI-proposed status so the
  // clinic still has to explicitly Confirm before Submit unblocks.
  const classificationMutation = useMutation({
    mutationFn: async (payload: { sheetId: string; tab?: string; subType?: string; isFixedCost?: boolean; confirm?: boolean }) => {
      return apiRequest("PATCH", `/api/costs/sheet/${payload.sheetId}/classification`, {
        tab: payload.tab,
        subType: payload.subType,
        isFixedCost: payload.isFixedCost,
        confirm: payload.confirm,
      });
    },
    onSuccess: () => {
      invalidateAll();
      queryClient.invalidateQueries({ queryKey: ["/api/costs/programs"] });
    },
    onError: (err: any) => {
      toast({ title: "Failed to save classification", description: err.message, variant: "destructive" });
    },
  });

  const handleFileDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) uploadMutation.mutate(file);
    },
    [uploadMutation],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) uploadMutation.mutate(file);
    },
    [uploadMutation],
  );


  const allTemplatesFlat = useMemo(() => {
    if (!templatesQuery.data?.templates) return [];
    return Object.values(templatesQuery.data.templates).flat();
  }, [templatesQuery.data]);

  const isVariant = useCallback((key: string): boolean => {
    return /\s*\((?:Standard|Variant \d+)\)$/.test(key);
  }, []);

  const getBaseKey = useCallback((key: string): string => {
    return key.replace(/\s*\((?:Standard|Variant \d+)\)$/, "");
  }, []);

  const getTemplateForItem = useCallback(
    (item: CostItemData): CostTemplate | undefined => {
      const baseKey = getBaseKey(item.key);
      return allTemplatesFlat.find(
        (t) => t.fieldName === baseKey && t.category === item.category,
      ) || allTemplatesFlat.find((t) => t.fieldName === baseKey);
    },
    [allTemplatesFlat, getBaseKey],
  );

  const startEditingFromTemplate = useCallback(() => {
    if (templateItems.length > 0) {
      setEditItems([...templateItems]);
    } else {
      setEditItems([{
        category: "General",
        key: "",
        minValue: null,
        maxValue: null,
        isCustom: true,
        comment: null,
        isIncluded: true,
        sortOrder: 0,
      }]);
    }
    setIsEditing(true);
  }, [templateItems]);

  const startEditingFromSheet = useCallback((sheet: CostSheet) => {
    setEditItems(
      sheet.items.map((item) => ({
        category: item.category,
        key: item.key,
        minValue: item.minValue,
        maxValue: item.maxValue,
        isCustom: item.isCustom,
        comment: item.comment,
        isIncluded: item.isIncluded,
        sortOrder: item.sortOrder,
      })),
    );
    setIsEditing(true);
  }, []);

  const updateEditItem = useCallback(
    (idx: number, field: keyof CostItemData, value: any) => {
      setIsDirty(true);
      setEditItems((prev) => {
        const updated = [...prev];
        updated[idx] = { ...updated[idx], [field]: value };
        return updated;
      });
    },
    [],
  );

  const addCustomItem = useCallback(() => {
    setEditItems((prev) => [
      ...prev,
      {
        category: "Other",
        key: "",
        minValue: null,
        maxValue: null,
        isCustom: true,
        comment: null,
        isIncluded: true,
        sortOrder: prev.length,
      },
    ]);
  }, []);

  const addVariant = useCallback(
    (sourceItem: CostItemData, insertAfterIdx: number) => {
      setEditItems((prev) => {
        const baseKey = sourceItem.key.replace(/\s*\((?:Standard|Variant \d+)\)$/, "");
        const existingVariants = prev.filter(
          (it) => it.category === sourceItem.category &&
            (it.key === baseKey || it.key.startsWith(baseKey + " (")) &&
            !it.isCustom,
        );

        const updated = [...prev];

        const hasAnyRenamed = existingVariants.some((it) => it.key.includes("("));
        if (!hasAnyRenamed) {
          const originalIdx = updated.findIndex(
            (it) => it.key === baseKey && it.category === sourceItem.category,
          );
          if (originalIdx >= 0) {
            updated[originalIdx] = {
              ...updated[originalIdx],
              key: `${baseKey} (Standard)`,
              _isVariant: true,
            };
          }
        }

        const variantNum = existingVariants.length + 1;
        const newItem: CostItemData = {
          category: sourceItem.category,
          key: `${baseKey} (Variant ${variantNum})`,
          minValue: null,
          maxValue: null,
          isCustom: false,
          comment: null,
          isIncluded: true,
          sortOrder: insertAfterIdx + 1,
          _isVariant: true,
        };

        const lastSiblingIdx = updated.reduce((last, it, i) =>
          it.category === sourceItem.category &&
          (it.key === baseKey || it.key.startsWith(baseKey + " ("))
            ? i : last, insertAfterIdx);

        updated.splice(lastSiblingIdx + 1, 0, newItem);
        return updated.map((it, i) => ({ ...it, sortOrder: i }));
      });
    },
    [],
  );

  const removeVariant = useCallback(
    (idx: number) => {
      setEditItems((prev) => {
        const item = prev[idx];
        if (!item) return prev;
        const baseKey = getBaseKey(item.key);
        const updated = prev.filter((_, i) => i !== idx);
        const remainingSiblings = updated.filter(
          (it) => it.category === item.category && it._isVariant &&
            (it.key === baseKey || it.key.startsWith(baseKey + " (")),
        );
        if (remainingSiblings.length === 1) {
          const soloIdx = updated.findIndex(
            (it) => it.category === item.category && it._isVariant &&
              (it.key === baseKey || it.key.startsWith(baseKey + " (")),
          );
          if (soloIdx >= 0) {
            updated[soloIdx] = { ...updated[soloIdx], key: baseKey, _isVariant: false };
          }
        }
        return updated.map((it, i) => ({ ...it, sortOrder: i }));
      });
      setTimeout(triggerAutoSave, 50);
    },
    [getBaseKey, triggerAutoSave],
  );

  const removeItem = useCallback((idx: number) => {
    setEditItems((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const allSheets = Array.isArray(sheetsQuery.data) ? sheetsQuery.data : [];
  const masterSheets = allSheets.filter((s) => !s.parentClientId);
  const latestMaster = masterSheets[0];
  const approvedSheet = approvedQuery.data;
  const parsingSheet = masterSheets.find((s) => s.status === "PARSING");
  const draftSheet = masterSheets.find((s) => s.status === "DRAFT");
  const pendingSheet = masterSheets.find((s) => s.status === "PENDING");
  const customSheets = parentId ? allSheets.filter((s) => s.parentClientId === parentId) : [];
  const activeCustomSheet = customSheets[0];

  const displaySheet = parentId ? activeCustomSheet : latestMaster;

  // Reset the "user actively touched the Fixed-cost toggle" gate whenever
  // we land on a new sheet. Already-confirmed sheets implicitly count as
  // touched so the gate doesn't re-block them.
  useEffect(() => {
    setHasInteractedWithFixedToggle(displaySheet?.isFixedCostSource === "clinic_confirmed");
  }, [displaySheet?.id, displaySheet?.isFixedCostSource]);

  useEffect(() => {
    if (parsingSheet && !isParsing) {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = startPollingForParse(parsingSheet.id, true);
    }
  }, [parsingSheet?.id]);

  useEffect(() => {
    if ((isAdminView && !programId) || parentId) return;
    if (sheetsQuery.isLoading || templatesQuery.isLoading) return;
    if (isEditing && editItems.length > 0) return;

    const mapSheetItem = (item: any): CostItemData => ({
      templateFieldId: item.templateFieldId ?? null,
      category: item.category,
      key: item.key,
      minValue: item.minValue,
      maxValue: item.maxValue,
      isCustom: item.isCustom,
      comment: item.comment,
      isIncluded: item.isIncluded,
      isTier: item.isTier === true,
      sortOrder: item.sortOrder,
      _isVariant: isVariant(item.key),
    });

    const filterBySubType = (items: CostItemData[]): CostItemData[] => {
      // Legacy category-filter only kicks in for the original egg-donation
      // fresh/frozen distinction. For IVF clinic subtypes (new 14-subtype
      // taxonomy), keep every item the AI extracted - filtering them by the
      // OLD seeded-IVF template categories drops the AI's headline / new
      // category items and produces a wrong Estimated Total vs the badge.
      if (effectiveSubType !== "fresh" && effectiveSubType !== "frozen") {
        return items;
      }
      const templateCategories = new Set(templateItems.map((t) => t.category));
      return items.filter((item) => templateCategories.has(item.category) || item.isCustom || item._isVariant);
    };

    const mergeWithTpl = (items: CostItemData[]) =>
      templateItems.length > 0 ? mergeSheetWithTemplate(items, templateItems) : items;

    if (draftSheet && draftSheet.items && draftSheet.items.length > 0) {
      setEditItems(mergeWithTpl(filterBySubType(draftSheet.items.map(mapSheetItem))));
      setIsEditing(true);
    } else if (pendingSheet && pendingSheet.items && pendingSheet.items.length > 0) {
      setEditItems(mergeWithTpl(filterBySubType(pendingSheet.items.map(mapSheetItem))));
      if (!isAdminView) setIsEditing(true);
    } else if (latestMaster && latestMaster.items && latestMaster.items.length > 0) {
      setEditItems(mergeWithTpl(filterBySubType(latestMaster.items.map(mapSheetItem))));
      if (!isAdminView) setIsEditing(true);
    } else if (templateItems.length > 0) {
      setEditItems([...templateItems]);
      if (!isAdminView) setIsEditing(true);
    }
  }, [sheetsQuery.isLoading, templatesQuery.isLoading, draftSheet?.id, pendingSheet?.id, latestMaster?.id, latestMaster?.status, templateItems.length, isAdminView, parentId, programId]);

  const mergedDisplayItems = useMemo((): CostItemData[] => {
    const sheetItems = displaySheet?.items || [];
    if (sheetItems.length > 0) {
      const mapped = sheetItems.map((item: any): CostItemData => ({
        templateFieldId: item.templateFieldId ?? null,
        category: item.category,
        key: item.key,
        minValue: item.minValue,
        maxValue: item.maxValue,
        isCustom: item.isCustom,
        comment: item.comment,
        isIncluded: item.isIncluded,
        isTier: item.isTier === true,
        sortOrder: item.sortOrder,
        _isVariant: isVariant(item.key),
      }));
      // Legacy category-filter is only correct for the egg-donation
      // fresh/frozen distinction. For IVF subtypes the AI emits items in
      // categories not in the seeded IVF template (e.g. the headline
      // package line) - filtering by template categories would drop them
      // from the form and the Estimated Total would silently disagree
      // with the program badge.
      const isLegacyEggDonationSubType = effectiveSubType === "fresh" || effectiveSubType === "frozen";
      if (templateItems.length > 0) {
        const merged = mergeSheetWithTemplate(mapped, templateItems);
        if (isLegacyEggDonationSubType) {
          const templateCategories = new Set(templateItems.map((t) => t.category));
          return merged.filter((item) => templateCategories.has(item.category) || item.isCustom || item._isVariant);
        }
        return merged;
      }
      if (isLegacyEggDonationSubType) {
        const templateCategories = new Set(templateItems.map((t) => t.category));
        return mapped.filter((item: CostItemData) => templateCategories.has(item.category) || item.isCustom || item._isVariant);
      }
      return mapped;
    }
    return templateItems;
  }, [displaySheet, templateItems, effectiveSubType]);

  const effectiveEditing = isAdminView ? isEditing : (isEditing || editItems.length > 0);
  const displayItems = effectiveEditing && editItems.length > 0 ? editItems : mergedDisplayItems;

  const showDiffView = isAdminView && !isEditing && pendingSheet?.status === "PENDING" && approvedSheet && pendingSheet.id !== approvedSheet.id;

  const approvedItemMap = useMemo(() => {
    if (!approvedSheet?.items) return new Map<string, CostItemData>();
    const map = new Map<string, CostItemData>();
    for (const item of approvedSheet.items) {
      map.set(`${item.category}::${item.key}`, item);
    }
    return map;
  }, [approvedSheet]);

  const templateCategoryOrder = useMemo(() => {
    const order: string[] = [];
    for (const item of templateItems) {
      if (!order.includes(item.category)) order.push(item.category);
    }
    return order;
  }, [templateItems]);

  // Pricing tier items render in a dedicated card above the accordion.
  // We keep their _editIdx so the same input handlers (updateEditItem,
  // removeItem) work without special-casing.
  const tierItems: (CostItemData & { _editIdx: number })[] = [];
  const groupedItems: Record<string, (CostItemData & { _editIdx: number })[]> = {};
  displayItems.forEach((item, idx) => {
    if (item.isTier) {
      tierItems.push({ ...item, _editIdx: idx });
      return;
    }
    const cat = item.category || "Other";
    if (!groupedItems[cat]) groupedItems[cat] = [];
    groupedItems[cat].push({ ...item, _editIdx: idx });
  });

  const sortedGroupedEntries = useMemo(() => {
    const entries = Object.entries(groupedItems);
    return entries.sort(([a], [b]) => {
      const ai = templateCategoryOrder.indexOf(a);
      const bi = templateCategoryOrder.indexOf(b);
      const aIdx = ai === -1 ? 999 : ai;
      const bIdx = bi === -1 ? 999 : bi;
      return aIdx - bIdx;
    });
  }, [displayItems, templateCategoryOrder]);

  useEffect(() => {
    const allCategories = Object.keys(groupedItems);
    if (allCategories.length > 0) {
      setAccordionValue(allCategories);
    }
  }, [displayItems]);

  const totals = calculateTotalCost(displayItems);

  const isLoading = templatesQuery.isLoading || sheetsQuery.isLoading;

  const mandatoryFields = templatesQuery.data?.templates
    ? Object.values(templatesQuery.data.templates)
        .flat()
        .filter((t) => t.isMandatory)
        .map((t) => t.fieldName)
    : [];

  const hasAnyValue = editItems.some((item) => item.minValue !== null || item.maxValue !== null);
  const missingMandatory = effectiveEditing && !isParsing && (displaySheet || hasAnyValue)
    ? mandatoryFields.filter(
        (field) =>
          !editItems.some(
            (item) =>
              (item.key === field || item.key.startsWith(field + " (")) &&
              item.isIncluded &&
              (item.minValue !== null || item.maxValue !== null),
          ),
      )
    : [];

  // Block Submit until the clinic confirms the AI classification. Triggers
  // when the sheet is AI-proposed and not yet confirmed, OR when the sheet
  // is a legacy-migrated row that the clinic hasn't reviewed, OR when the
  // sheet has no subtype yet (Awaiting classification state). The warning
  // banner above the form spells out what's blocking.
  // Subtype is only a confirmation requirement for provider types that
  // HAVE subtypes (IVF + egg donor). Surrogacy + sperm bank just need the
  // Fixed/Not-Fixed acknowledgement.
  const requiresSubtype = hasIvfSubtypes(providerType) || hasFreshFrozenSubtypes(providerType);
  const needsClassificationConfirmation = !!displaySheet && !parentId && displaySheet.status !== "PARSING" && (
    (requiresSubtype && !displaySheet.subType) ||
    displaySheet.legacyNeedsReview === true ||
    displaySheet.isFixedCostSource === "ai_proposed" ||
    displaySheet.isFixedCostSource == null ||
    displaySheet.isFixedCost == null
  );

  const diffStats = useMemo(() => {
    if (!showDiffView || !pendingSheet) return null;
    let changed = 0;
    let added = 0;
    let removed = 0;
    for (const item of pendingSheet.items) {
      const key = `${item.category}::${item.key}`;
      const approved = approvedItemMap.get(key);
      if (!approved) {
        added++;
      } else if (approved.minValue !== item.minValue || approved.maxValue !== item.maxValue || approved.isIncluded !== item.isIncluded) {
        changed++;
      }
    }
    for (const item of approvedSheet!.items) {
      const key = `${item.category}::${item.key}`;
      if (!pendingSheet.items.some((p) => `${p.category}::${p.key}` === key)) {
        removed++;
      }
    }
    return { changed, added, removed };
  }, [showDiffView, pendingSheet, approvedSheet, approvedItemMap]);

  if (isLoading) {
    return (
      <div className="space-y-4 p-4" data-testid="costs-loading">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-28" data-testid="provider-costs-tab">
      {displaySheet?.status === "REJECTED" && displaySheet.adminFeedback && (
        <Alert variant="destructive" data-testid="alert-rejection-feedback">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            <strong>Rejection feedback:</strong> {displaySheet.adminFeedback}
          </AlertDescription>
        </Alert>
      )}

      {/* Legacy-review banner: shown for sheets auto-migrated from the
          2-subtype world. Clinic must confirm tab + subtype + Fixed-cost
          before the banner clears. */}
      {displaySheet?.legacyNeedsReview && displaySheet.status !== "PARSING" && (
        <Alert className="border-[hsl(var(--brand-warning))]/40 bg-[hsl(var(--brand-warning))]/10" data-testid="alert-legacy-review">
          <AlertTriangle className="h-4 w-4 text-[hsl(var(--brand-warning))]" />
          <AlertDescription className="text-sm">
            <strong>Confirm this program's classification.</strong> We reorganized cost sheets into 4 tabs with subtypes. We auto-defaulted this sheet to{" "}
            <span className="font-semibold">{labelOfSubtype(displaySheet.subType) ?? "Own eggs, own/self carry"}</span> -
            please confirm or change it below.
          </AlertDescription>
        </Alert>
      )}

      {/* Classification card hidden - all controls live inline in the
          program top bar now (ProgramClassificationControls). Render
          gated to false so we keep the surrounding JSX shape intact
          without ripping out the editor's existing layout. */}
      {false && displaySheet && !parentId && displaySheet.status !== "PARSING" && (displaySheet.subType || !hasIvfSubtypes(providerType)) && (
        <Card className={cn(
          "border-2",
          needsClassificationConfirmation
            ? "border-[hsl(var(--brand-warning))] bg-[hsl(var(--brand-warning))]/10"
            : "border-[hsl(var(--brand-success))]/40 bg-[hsl(var(--brand-success))]/5"
        )} data-testid="card-classification">
          <CardContent className="py-4 space-y-3">
            {needsClassificationConfirmation && (
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-5 h-5 text-[hsl(var(--brand-warning))] shrink-0 mt-0.5" />
                <div>
                  {/* Heading: readable foreground color. The amber accent
                      lives on the card border + icon, not on the text - keeps
                      contrast high against the amber-tinted card surface. */}
                  <p className="text-sm font-semibold text-foreground">
                    Confirm the AI classification before submitting
                  </p>
                  <p className="text-xs text-foreground/80 mt-0.5">
                    Review the program type below. Click <strong>Fixed-Cost</strong> or <strong>Not Fixed Costs</strong> to acknowledge the AI's choice (or change it), then click <strong>Confirm Classification</strong>. You can't submit for approval until this is confirmed.
                  </p>
                </div>
              </div>
            )}
            <div className="flex items-start gap-3 flex-wrap">
              <div className="flex-1 min-w-[200px] space-y-2">
                {/* Services-covered multi-toggle (lifted into the card so
                    all three AI classifications - services, subtype,
                    Fixed/Not-Fixed - live on the same surface). Rendered
                    as a segmented row of buttons that match the Fixed-
                    Cost toggle's styling; each one is independently
                    toggleable since a single program can bundle multiple
                    services (e.g. surrogacy + egg donor combined). */}
                {/* Unified non-IVF coverage row. Each toggle is a flat
                    leaf (e.g. "Surrogacy", "Fresh Donor", "Frozen Egg",
                    "Sperm Donor"). Multi-select - one cost sheet can
                    cover any combination. Writes to subTypes[] which the
                    auto-draft matcher queries with hasSome. Legacy
                    serviceTypes[] + subType are derived on save. */}
                {/* Coverage row visible for ALL provider types - including
                    IVF clinics whose programs may layer non-IVF leaves
                    (e.g. an IVF cycle program at a multi-service provider
                    that also covers Surrogacy or Fresh Donor). The IVF
                    subtype dropdown sits separately below for the 14-leaf
                    IVF taxonomy. */}
                {allowedServiceTags && allowedServiceTags.length > 0 && (() => {
                  const visibleLeaves = leavesForServiceTags(allowedServiceTags);
                  if (visibleLeaves.length === 0) return null;
                  const current = programCurrentSubTypes ?? [];
                  return (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-muted-foreground">Coverage:</span>
                      <div className="inline-flex gap-1 p-1 bg-background border-2 border-accent/40 rounded-[var(--radius)] shadow-sm flex-wrap">
                        {visibleLeaves.map((leaf) => {
                          const selected = current.includes(leaf.id);
                          return (
                            <button
                              key={`leaf-${leaf.id}`}
                              type="button"
                              className={cn(
                                "px-3 py-1.5 text-xs rounded-[var(--radius)] transition-all font-medium",
                                selected
                                  ? "bg-accent text-accent-foreground shadow-sm"
                                  : "text-foreground hover:bg-accent/10",
                              )}
                              onClick={() => {
                                const next = selected
                                  ? current.filter((id) => id !== leaf.id)
                                  : [...current, leaf.id];
                                onSubTypesChange?.(next);
                              }}
                              data-testid={`btn-leaf-${leaf.id}`}
                            >
                              {leaf.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}
                {/* IVF clinics keep the 14-option dropdown - too many leaves
                    for a toggle row. Dropdown writes single subType; save
                    path mirrors it into subTypes=[subType]. */}
                {programShowsAnySubtype && programShowsIvfSubtypeProp && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-muted-foreground">Program type:</span>
                    <IvfSubtypePopover
                      currentSubType={programCurrentSubType ?? null}
                      tabFilter={programTabFilter}
                      onSelect={(newSub) =>
                        onSubTypeChange?.(newSub, tabOfSubtype(newSub) ?? undefined)
                      }
                    />
                  </div>
                )}

                {/* AI proposed badge - only while still awaiting confirmation.
                    The Confirmed badge has moved to the right column so it
                    sits where the "Confirm Classification" button used to
                    live (visual continuity). Descriptive Fixed-cost text
                    removed to keep this block tight. */}
                {displaySheet.isFixedCostSource === "ai_proposed" && (
                  <div className="flex items-center gap-2 flex-wrap">
                    {!programShowsAnySubtype && (
                      <span className="text-xs text-muted-foreground">Cost-sheet classification:</span>
                    )}
                    <Badge className="bg-background text-[hsl(var(--brand-warning))] border border-[hsl(var(--brand-warning))]/50 text-xs font-medium">AI proposed</Badge>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {/* Segmented toggle: white interior so the unselected label
                    sits on a clean surface (was blending into the cream-on-
                    amber card behind it). Border tinted with --accent to
                    cohere with the mauve selected pill. */}
                <div className="inline-flex gap-1 p-1 bg-background border-2 border-accent/40 rounded-[var(--radius)] shadow-sm">
                  <button
                    type="button"
                    className={cn(
                      "px-3 py-1.5 text-xs rounded-[var(--radius)] transition-all font-medium",
                      displaySheet.isFixedCost === true
                        ? "bg-accent text-accent-foreground shadow-sm"
                        : "text-foreground hover:bg-accent/10"
                    )}
                    onClick={() => {
                      setHasInteractedWithFixedToggle(true);
                      classificationMutation.mutate({ sheetId: displaySheet.id, isFixedCost: true });
                    }}
                    disabled={classificationMutation.isPending}
                    data-testid="btn-mark-fixed"
                  >
                    Fixed-Cost
                  </button>
                  <button
                    type="button"
                    className={cn(
                      "px-3 py-1.5 text-xs rounded-[var(--radius)] transition-all font-medium",
                      displaySheet.isFixedCost === false
                        ? "bg-accent text-accent-foreground shadow-sm"
                        : "text-foreground hover:bg-accent/10"
                    )}
                    onClick={() => {
                      setHasInteractedWithFixedToggle(true);
                      classificationMutation.mutate({ sheetId: displaySheet.id, isFixedCost: false });
                    }}
                    disabled={classificationMutation.isPending}
                    data-testid="btn-mark-not-fixed"
                  >
                    Not Fixed Costs
                  </button>
                </div>
                {needsClassificationConfirmation && displaySheet.isFixedCost !== null && (
                  <Button
                    size="sm"
                    className="h-9 font-semibold shadow-md"
                    disabled={classificationMutation.isPending || !hasInteractedWithFixedToggle}
                    title={!hasInteractedWithFixedToggle ? "Click Fixed-Cost or Not Fixed Costs first to acknowledge the AI's choice" : undefined}
                    onClick={() =>
                      classificationMutation.mutate({
                        sheetId: displaySheet.id,
                        isFixedCost: displaySheet.isFixedCost ?? false,
                        confirm: true,
                      })
                    }
                    data-testid="btn-confirm-classification"
                  >
                    {classificationMutation.isPending
                      ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                      : <Check className="w-3.5 h-3.5 mr-1.5" />
                    }
                    Confirm Classification
                  </Button>
                )}
                {/* Confirmed state - sits where the Confirm Classification
                    button was, keeping the right-aligned anchor consistent
                    across the AI-proposed -> Confirmed transition. */}
                {displaySheet.isFixedCostSource === "clinic_confirmed" && (
                  // Match the inline row badge style: icon-only circular check.
                  <Badge
                    className="h-9 w-9 p-0 rounded-full bg-[hsl(var(--brand-success))]/15 text-[hsl(var(--brand-success))] border-[hsl(var(--brand-success))]/30 flex items-center justify-center flex-shrink-0"
                    title="Classification confirmed"
                  >
                    <Check className="w-4 h-4" />
                  </Badge>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* AI parse-failure alert. backgroundParseAndSave swallows Gemini
          errors silently - it flips the sheet to DRAFT with no items and
          no classification, which looks indistinguishable from a fresh
          empty sheet. Detect that state (DRAFT + file present + zero
          items + no AI classification proposed) and tell the clinic
          exactly what happened so they know to override or re-upload. */}
      {!parentId &&
        displaySheet?.status === "DRAFT" &&
        displaySheet.filePath &&
        !isParsing &&
        (displaySheet.items?.length ?? 0) === 0 &&
        displaySheet.isFixedCost === null &&
        displaySheet.isFixedCostSource == null && (
        <Alert variant="default" className="border-[hsl(var(--brand-warning))]/40 bg-[hsl(var(--brand-warning))]/5">
          <AlertTriangle className="h-4 w-4 text-[hsl(var(--brand-warning))]" />
          <AlertDescription className="text-foreground space-y-3">
            <div>
              <strong>AI couldn't extract any data from this file.</strong>{" "}
              The file is attached but no items, classification, or program type were detected. Add items manually, or re-upload the file in a clearer format (PDF with selectable text, XLS/XLSX preferred over scanned images).
            </div>
            {/* Override button duplicated here next to the explanation so the
                clinic doesn't have to hunt for it in the status bar at the
                very bottom of the editor. Same handler as the status-bar
                Override, so either entry point starts editing the sheet. */}
            {isAdminView && (
              <Button
                size="sm"
                onClick={() => startEditingFromSheet(displaySheet)}
                data-testid="btn-alert-override"
              >
                <Pencil className="w-3.5 h-3.5 mr-1.5" />
                Override - add items manually
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {!parentId && (
        <Card data-testid="card-file-management">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="w-4 h-4" />
              Cost Sheet Document
            </CardTitle>
          </CardHeader>
          <CardContent>
            {displaySheet?.filePath ? (
              <div className="space-y-3">
                <div className="flex items-center gap-3 p-3 bg-muted rounded-[var(--radius)]" data-testid="file-info">
                  <FileText className="w-8 h-8 text-primary" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate" data-testid="text-filename">
                      {displaySheet.originalFileName || "Cost Sheet"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Version {displaySheet.version}
                    </p>
                  </div>
                  {!isParsing && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        asChild
                        data-testid="btn-download-file"
                      >
                        <a href={`/api/costs/${displaySheet.id}/download`} target="_blank" rel="noopener noreferrer">
                          <Download className="w-4 h-4 mr-1" />
                          Download
                        </a>
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="outline" size="sm" className="text-destructive" data-testid="btn-delete-file">
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Reset cost sheet?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This will remove all saved cost data and reset to the default template.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => deleteMutation.mutate(displaySheet.id)}
                              data-testid="btn-confirm-delete-file"
                            >
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </>
                  )}
                </div>
                {isParsing && (
                  <div className="px-1" data-testid="parse-progress-container">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-1.5">
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                        <span className="text-xs font-medium text-primary" data-testid="text-parse-stage">
                          {parseStage || "AI is analyzing your document..."} {parseProgress > 0 ? `${parseProgress}%` : ""}
                        </span>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
                        disabled={cancelUploadMutation.isPending}
                        onClick={() => { const s = parsingSheet; if (s) cancelUploadMutation.mutate(s.id); }}
                      >
                        <X className="w-3 h-3 mr-1" /> Cancel
                      </Button>
                    </div>
                    <div className="w-full bg-muted rounded-full h-2 overflow-hidden" data-testid="parse-progress-bar">
                      <div
                        className="bg-primary h-2 rounded-full transition-all duration-500 ease-out"
                        style={{ width: `${Math.max(parseProgress, 3)}%` }}
                        data-testid="parse-progress-fill"
                      />
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-1.5">
                      AI is reading your document and mapping costs to the GoStork template
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <div
                className={`border-2 border-dashed rounded-[var(--radius)] p-8 text-center transition-colors ${
                  uploadMutation.isPending || isParsing
                    ? "border-primary/30 bg-primary/5 cursor-wait"
                    : isDragging
                      ? "border-primary bg-primary/5 cursor-pointer"
                      : "border-border hover:border-primary/50 cursor-pointer"
                }`}
                onDragOver={(e) => { e.preventDefault(); if (!uploadMutation.isPending && !isParsing) setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(e) => { if (!uploadMutation.isPending && !isParsing) handleFileDrop(e); else e.preventDefault(); }}
                onClick={() => { if (!uploadMutation.isPending && !isParsing) fileInputRef.current?.click(); }}
                data-testid="dropzone-cost-sheet"
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  accept=".pdf,.xlsx,.xls"
                  onChange={handleFileSelect}
                />
                {uploadMutation.isPending ? (
                  <>
                    <Loader2 className="w-8 h-8 mx-auto mb-2 text-primary animate-spin" />
                    <p className="text-sm font-medium">Uploading file...</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      This may take a moment
                    </p>
                  </>
                ) : isParsing ? (
                  <div className="w-full max-w-sm mx-auto" data-testid="parse-progress-container">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-1.5">
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                        <span className="text-xs font-medium text-primary" data-testid="text-parse-stage">
                          {parseStage || "Starting..."} {parseProgress > 0 ? `${parseProgress}%` : ""}
                        </span>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
                        disabled={cancelUploadMutation.isPending}
                        onClick={(e) => { e.stopPropagation(); const s = parsingSheet; if (s) cancelUploadMutation.mutate(s.id); }}
                      >
                        <X className="w-3 h-3 mr-1" /> Cancel
                      </Button>
                    </div>
                    <div className="w-full bg-muted rounded-full h-2 overflow-hidden" data-testid="parse-progress-bar">
                      <div
                        className="bg-primary h-2 rounded-full transition-all duration-500 ease-out"
                        style={{ width: `${Math.max(parseProgress, 3)}%` }}
                        data-testid="parse-progress-fill"
                      />
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-1.5 text-center">
                      AI is reading your document and mapping costs to the GoStork template
                    </p>
                  </div>
                ) : (
                  <>
                    <Upload className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
                    <p className="text-sm font-medium">
                      Drop a PDF or Excel file here, or click to browse
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Supports PDF, XLS, XLSX (max 20MB) · AI will auto-parse your costs
                    </p>
                  </>
                )}
              </div>
            )}

          </CardContent>
        </Card>
      )}

      {displaySheet && (!effectiveEditing || !isAdminView) && (
        <div className="flex items-center gap-3 flex-wrap" data-testid="sheet-status-bar">
          {getStatusBadge(displaySheet.status)}
          <span className="text-xs text-muted-foreground">
            v{displaySheet.version} · Updated{" "}
            {new Date(displaySheet.updatedAt).toLocaleDateString()}
          </span>
          <div className="flex-1" />

          {isAdminView && !effectiveEditing && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => startEditingFromSheet(displaySheet)}
              data-testid="btn-admin-override-edit"
            >
              <Pencil className="w-3.5 h-3.5 mr-1" />
              Override
            </Button>
          )}

          {/* Approve / Reject is a review action - it only makes sense on a
              sheet a provider has submitted for approval (PENDING). When an
              admin uploads a sheet themselves it starts as DRAFT, and the
              right path is Override to fill in the data, then Submit/Approve
              from the editor. The previous gate let DRAFT through too, which
              put Approve / Reject on admin-uploaded sheets with no items -
              nothing meaningful to approve. */}
          {isAdminView && !effectiveEditing && displaySheet.status === "PENDING" && (
            <>
              <Button
                size="sm"
                className="bg-[hsl(var(--brand-success))] hover:bg-[hsl(var(--brand-success))]/90 text-primary-foreground"
                onClick={() => approveMutation.mutate(displaySheet.id)}
                disabled={approveMutation.isPending}
                data-testid="btn-approve-sheet"
              >
                <Check className="w-4 h-4 mr-1" />
                Approve
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  setRejectSheetId(displaySheet.id);
                  setRejectDialogOpen(true);
                }}
                data-testid="btn-reject-sheet"
              >
                <X className="w-4 h-4 mr-1" />
                Reject
              </Button>
            </>
          )}

          {parentId && displaySheet.status !== "SENT_TO_PARENT" && (
            <Button
              size="sm"
              onClick={() => sendQuoteMutation.mutate(displaySheet.id)}
              disabled={sendQuoteMutation.isPending}
              data-testid="btn-send-quote"
            >
              <Send className="w-4 h-4 mr-1" />
              Send to Parent
            </Button>
          )}
        </div>
      )}

      {showDiffView && diffStats && (
        <Card className="border-[hsl(var(--brand-warning))]/30 bg-[hsl(var(--brand-warning))]/5" data-testid="card-diff-summary">
          <CardContent className="py-3">
            <div className="flex items-center gap-2 text-sm">
              <ArrowUpDown className="w-4 h-4 text-[hsl(var(--brand-warning))]" />
              <span className="font-medium text-[hsl(var(--brand-warning))]">Changes from approved version:</span>
              {diffStats.changed > 0 && (
                <Badge variant="outline" className="bg-[hsl(var(--brand-warning))]/15 text-[hsl(var(--brand-warning))] border-[hsl(var(--brand-warning))]/30">
                  {diffStats.changed} modified
                </Badge>
              )}
              {diffStats.added > 0 && (
                <Badge variant="outline" className="bg-[hsl(var(--brand-success))]/15 text-[hsl(var(--brand-success))] border-[hsl(var(--brand-success))]/30">
                  {diffStats.added} added
                </Badge>
              )}
              {diffStats.removed > 0 && (
                <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/30">
                  {diffStats.removed} removed
                </Badge>
              )}
              {diffStats.changed === 0 && diffStats.added === 0 && diffStats.removed === 0 && (
                <span className="text-muted-foreground">No changes</span>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {!displaySheet && !effectiveEditing && !parentId && displayItems.length > 0 && (
        <div className="flex items-center gap-3 flex-wrap" data-testid="sheet-status-bar-empty">
          <Badge className="bg-muted text-muted-foreground border-border">No submission yet</Badge>
          <div className="flex-1" />
          {isAdminView && (
            <Button
              size="sm"
              variant="outline"
              onClick={startEditingFromTemplate}
              data-testid="btn-admin-edit-costs"
            >
              <Pencil className="w-3.5 h-3.5 mr-1" />
              Edit Costs
            </Button>
          )}
        </div>
      )}

      {!activeCustomSheet && parentId && !effectiveEditing && (
        <Card data-testid="card-no-custom-quote">
          <CardContent className="py-8 text-center">
            <DollarSign className="w-10 h-10 mx-auto mb-3 text-muted-foreground" />
            <p className="text-sm text-muted-foreground mb-4">
              No custom cost sheet for this parent yet.
            </p>
            <Button
              onClick={() => createQuoteMutation.mutate()}
              disabled={createQuoteMutation.isPending || !approvedSheet}
              data-testid="btn-create-custom-quote"
            >
              <Plus className="w-4 h-4 mr-1" />
              Create Custom Cost Sheet
            </Button>
            {!approvedSheet && (
              <p className="text-xs text-muted-foreground mt-2">
                An approved master cost sheet is required first.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {tierItems.length > 0 && (
        <Card className="border-2 border-accent/40 bg-accent/5" data-testid="card-pricing-tiers">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-accent" />
              Pricing Tiers
              <Badge variant="outline" className="text-xs bg-background border-accent/40 text-accent">
                {tierItems.length} option{tierItems.length === 1 ? "" : "s"}
              </Badge>
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              The parent picks one tier. Each tier renders as its own card on the parent profile, with the same Included items repeated under each.
            </p>
          </CardHeader>
          <CardContent className="space-y-2">
            {tierItems.map((tier) => (
              <div
                key={`tier-${tier._editIdx}`}
                className="flex items-center gap-3 p-3 rounded-[var(--radius)] bg-background border border-border"
                data-testid={`tier-row-${tier._editIdx}`}
              >
                <div className="flex-1">
                  <Input
                    value={tier.key}
                    onChange={(e) => updateEditItem(tier._editIdx, "key", e.target.value)}
                    placeholder="Tier name (e.g. Single Cycle, Two Cycles, Unlimited)"
                    className="h-8 text-sm font-medium border-0 px-1 focus-visible:ring-1"
                    disabled={!effectiveEditing}
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">$</span>
                  <NumberInput
                    value={tier.minValue != null ? String(tier.minValue) : ""}
                    onChange={(raw) => {
                      const v = raw === "" ? null : Number(raw);
                      updateEditItem(tier._editIdx, "minValue", v);
                      updateEditItem(tier._editIdx, "maxValue", v);
                    }}
                    placeholder="Price"
                    className="h-8 text-sm w-32 tabular-nums"
                    disabled={!effectiveEditing}
                  />
                </div>
                {effectiveEditing && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0 text-destructive"
                    onClick={() => removeItem(tier._editIdx)}
                    data-testid={`tier-delete-${tier._editIdx}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                )}
              </div>
            ))}
            {effectiveEditing && (
              <Button
                size="sm"
                variant="outline"
                className="w-full border-dashed"
                onClick={() => {
                  setEditItems((prev) => [
                    ...prev,
                    {
                      category: "Pricing Tiers",
                      key: "",
                      minValue: null,
                      maxValue: null,
                      isCustom: true,
                      comment: null,
                      isIncluded: true,
                      isTier: true,
                      sortOrder: prev.length,
                    },
                  ]);
                }}
                data-testid="btn-add-tier"
              >
                <Plus className="w-3.5 h-3.5 mr-1" /> Add Pricing Tier
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {displayItems.length > 0 && (
        <Accordion
          type="multiple"
          value={accordionValue}
          onValueChange={setAccordionValue}
          className="space-y-2"
          data-testid="cost-items-accordion"
        >
          {sortedGroupedEntries.map(([category, items]) => {
            const categoryHasChanges = showDiffView && items.some((item) => {
              const approved = approvedItemMap.get(`${item.category}::${item.key}`);
              return !approved || approved.minValue !== item.minValue || approved.maxValue !== item.maxValue || approved.isIncluded !== item.isIncluded;
            });

            return (
              <AccordionItem
                key={category}
                value={category}
                className={`border rounded-[var(--radius)] px-4 ${categoryHasChanges ? "border-[hsl(var(--brand-warning))]/30 bg-[hsl(var(--brand-warning))]/5" : ""}`}
                data-testid={`accordion-category-${category.toLowerCase().replace(/\s+/g, "-")}`}
              >
                <AccordionTrigger className="text-sm font-semibold py-3">
                  <div className="flex items-center gap-2">
                    {category}
                    <span className="text-xs text-muted-foreground font-normal">
                      ({items.length} item{items.length !== 1 ? "s" : ""})
                    </span>
                    {categoryHasChanges && (
                      <Badge variant="outline" className="text-xs bg-[hsl(var(--brand-warning))]/15 text-[hsl(var(--brand-warning))] border-[hsl(var(--brand-warning))]/30 ml-1">
                        Changed
                      </Badge>
                    )}
                  </div>
                </AccordionTrigger>
                <AccordionContent>
                  {showDiffView && (
                    <div className="flex text-xs text-muted-foreground border-b pb-2 mb-2 px-3 gap-2">
                      <div className="flex-1">Item</div>
                      <div className="w-28 text-right">Pending</div>
                      <div className="w-4 shrink-0" />
                      <div className="w-28 text-right">Approved</div>
                      <div className="w-16 text-center">Status</div>
                    </div>
                  )}
                  <div className="space-y-3 pb-3">
                    {items.map((item) => {
                      const template = getTemplateForItem(item);
                      const approvedItem = approvedItemMap.get(`${item.category}::${item.key}`);
                      const itemChanged = showDiffView && approvedItem && (
                        approvedItem.minValue !== item.minValue ||
                        approvedItem.maxValue !== item.maxValue ||
                        approvedItem.isIncluded !== item.isIncluded
                      );
                      const isNewItem = showDiffView && !approvedItem;

                      return (
                        <div
                          key={item._editIdx}
                          className={`flex flex-col gap-2 p-3 rounded-[var(--radius)] border ${
                            item.isCustom
                              ? "border-l-4 border-l-[hsl(var(--brand-warning))]/60 bg-[hsl(var(--brand-warning))]/5"
                              : isNewItem
                                ? "border-l-4 border-l-[hsl(var(--brand-success))]/60 bg-[hsl(var(--brand-success))]/5"
                                : itemChanged
                                  ? "border-l-4 border-l-[hsl(var(--brand-warning))]/60 bg-[hsl(var(--brand-warning))]/3"
                                  : "bg-card"
                          } ${!item.isIncluded ? "opacity-50" : ""}`}
                          data-testid={`cost-item-row-${item._editIdx}`}
                        >
                          {showDiffView ? (
                            <div className="flex items-center gap-2">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-medium" data-testid={`text-key-${item._editIdx}`}>
                                    {item.key}
                                  </span>
                                  {item.isCustom && (
                                    <Badge variant="outline" className="text-xs bg-[hsl(var(--brand-warning))]/10 text-[hsl(var(--brand-warning))] border-[hsl(var(--brand-warning))]/30">
                                      Custom
                                    </Badge>
                                  )}
                                </div>
                              </div>
                              <div className="w-28">
                                <DiffValueCell label="Min" pendingVal={item.minValue} approvedVal={approvedItem?.minValue ?? null} isCurrency={!isNumericOnlyField(getBaseKey(item.key))} />
                                {(item.maxValue !== item.minValue || (approvedItem && approvedItem.maxValue !== approvedItem.minValue)) && (
                                  <DiffValueCell label="Max" pendingVal={item.maxValue} approvedVal={approvedItem?.maxValue ?? null} isCurrency={!isNumericOnlyField(getBaseKey(item.key))} />
                                )}
                              </div>
                              <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0" />
                              <div className="w-28 text-right">
                                {approvedItem ? (
                                  <>
                                    <span className="text-sm tabular-nums text-muted-foreground">
                                      {approvedItem.minValue != null
                                        ? (isNumericOnlyField(getBaseKey(item.key)) ? String(approvedItem.minValue) : formatCurrency(approvedItem.minValue))
                                        : "-"}
                                    </span>
                                    {approvedItem.maxValue !== approvedItem.minValue && approvedItem.maxValue != null && (
                                      <div className="text-xs text-muted-foreground">
                                        – {isNumericOnlyField(getBaseKey(item.key)) ? String(approvedItem.maxValue) : formatCurrency(approvedItem.maxValue)}
                                      </div>
                                    )}
                                  </>
                                ) : (
                                  <span className="text-xs text-muted-foreground italic">New</span>
                                )}
                              </div>
                              <div className="w-16 text-center">
                                {isNewItem ? (
                                  <Badge className="text-xs bg-[hsl(var(--brand-success))]/15 text-[hsl(var(--brand-success))] border-[hsl(var(--brand-success))]/30">New</Badge>
                                ) : itemChanged ? (
                                  <Badge className="text-xs bg-[hsl(var(--brand-warning))]/15 text-[hsl(var(--brand-warning))] border-[hsl(var(--brand-warning))]/30">Changed</Badge>
                                ) : (
                                  <span className="text-xs text-muted-foreground">-</span>
                                )}
                              </div>
                            </div>
                          ) : (
                            <div className="flex flex-col sm:flex-row sm:items-start gap-2">
                              {/* Label/name column - fixed width so the
                                  comment + values columns line up across
                                  items in the same category. Wraps to its
                                  own line on mobile via the parent's
                                  flex-col-on-small. */}
                              <div className="w-full sm:w-44 sm:flex-shrink-0">
                                {effectiveEditing && (item.isCustom || item._isVariant) ? (
                                  <Input
                                    value={item.key}
                                    onChange={(e) =>
                                      updateEditItem(item._editIdx, "key", e.target.value)
                                    }
                                    placeholder="Cost item name"
                                    className="h-8 text-sm"
                                    data-testid={`input-key-${item._editIdx}`}
                                  />
                                ) : (
                                  <div className="flex items-center gap-2">
                                    <span className="text-sm font-medium" data-testid={`text-key-${item._editIdx}`}>
                                      {item.key}
                                    </span>
                                    {item.isCustom && (
                                      <Badge variant="outline" className="text-xs bg-[hsl(var(--brand-warning))]/10 text-[hsl(var(--brand-warning))] border-[hsl(var(--brand-warning))]/30">
                                        Custom
                                      </Badge>
                                    )}
                                  </div>
                                )}
                              </div>

                              {/* Inline comment column - flexes to fill the
                                  middle of the row. In edit mode it's a
                                  Textarea with field-sizing: content so it
                                  auto-grows vertically as the user types or
                                  pastes a multi-line note (the row's
                                  items-start alignment keeps the label and
                                  value cells anchored at the top while the
                                  comment expands downward). In read-only
                                  view the same column renders the comment
                                  as a wrapping paragraph - or stays empty
                                  to keep horizontal alignment intact when
                                  an item has no comment. */}
                              <div className="flex-1 min-w-0 self-stretch">
                                {effectiveEditing ? (
                                  <Textarea
                                    value={item.comment || ""}
                                    onChange={(e) => updateEditItem(item._editIdx, "comment", e.target.value || null)}
                                    onBlur={triggerAutoSave}
                                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); triggerAutoSave(); } }}
                                    placeholder="Note (visible to parents)"
                                    rows={1}
                                    className="text-xs min-h-[2rem] resize-none [field-sizing:content]"
                                    data-testid={`input-comment-${item._editIdx}`}
                                  />
                                ) : item.comment ? (
                                  <p className="text-xs text-muted-foreground italic" data-testid={`text-comment-${item._editIdx}`}>
                                    {item.comment}
                                  </p>
                                ) : null}
                              </div>

                              <div className="flex items-center gap-2 flex-shrink-0">
                                {effectiveEditing ? (
                                  isNumericOnlyField(getBaseKey(item.key)) ? (
                                    <div className="flex items-center gap-1">
                                      <NumberInput
                                        allowDecimal={false}
                                        value={item.minValue != null ? String(item.minValue) : ""}
                                        onChange={(raw) => {
                                          const val = raw === "" ? null : Number(raw);
                                          updateEditItem(item._editIdx, "minValue", val);
                                          updateEditItem(item._editIdx, "maxValue", val);
                                        }}
                                        onBlur={triggerAutoSave}
                                        onKeyDown={(e) => { if (e.key === "Enter") triggerAutoSave(); }}
                                        placeholder="Quantity"
                                        className="w-28 h-8 text-sm"
                                        data-testid={`input-numeric-${item._editIdx}`}
                                      />
                                    </div>
                                  ) : (
                                  <>
                                    <div className="flex items-center gap-1">
                                      <span className="text-xs text-muted-foreground">$</span>
                                      <NumberInput
                                        value={item.minValue != null ? String(item.minValue) : ""}
                                        onChange={(raw) =>
                                          updateEditItem(
                                            item._editIdx,
                                            "minValue",
                                            raw === "" ? null : Number(raw),
                                          )
                                        }
                                        onBlur={triggerAutoSave}
                                        onKeyDown={(e) => { if (e.key === "Enter") triggerAutoSave(); }}
                                        placeholder="Min"
                                        className="w-24 h-8 text-sm"
                                        data-testid={`input-min-${item._editIdx}`}
                                      />
                                    </div>
                                    <span className="text-muted-foreground">–</span>
                                    <div className="flex items-center gap-1">
                                      <span className="text-xs text-muted-foreground">$</span>
                                      <NumberInput
                                        value={item.maxValue != null ? String(item.maxValue) : ""}
                                        onChange={(raw) =>
                                          updateEditItem(
                                            item._editIdx,
                                            "maxValue",
                                            raw === "" ? null : Number(raw),
                                          )
                                        }
                                        onBlur={triggerAutoSave}
                                        onKeyDown={(e) => { if (e.key === "Enter") triggerAutoSave(); }}
                                        placeholder="Max"
                                        className="w-24 h-8 text-sm"
                                        data-testid={`input-max-${item._editIdx}`}
                                      />
                                    </div>
                                  </>
                                  )
                                ) : (
                                  <span className="text-sm font-medium tabular-nums whitespace-nowrap" data-testid={`text-value-${item._editIdx}`}>
                                    {isNumericOnlyField(getBaseKey(item.key))
                                      ? (item.minValue != null ? String(item.minValue) : "-")
                                      : item.minValue != null || item.maxValue != null
                                        ? item.minValue === item.maxValue || item.maxValue == null
                                          ? formatCurrency(item.minValue ?? 0)
                                          : `${formatCurrency(item.minValue ?? 0)} – ${formatCurrency(item.maxValue)}`
                                        : item.isIncluded
                                          ? "Included"
                                          : "-"
                                    }
                                  </span>
                                )}

                                {effectiveEditing && (
                                  <>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className={`h-8 px-2 text-xs ${item.isIncluded ? "text-[hsl(var(--brand-success))]" : "text-muted-foreground"}`}
                                      onClick={() => { updateEditItem(item._editIdx, "isIncluded", !item.isIncluded); setTimeout(triggerAutoSave, 50); }}
                                      data-testid={`btn-toggle-included-${item._editIdx}`}
                                    >
                                      {item.isIncluded ? "Included" : "Excluded"}
                                    </Button>
                                    {template?.allowMultiple && (
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-8 px-2 text-xs text-primary"
                                        onClick={() => addVariant(item, item._editIdx)}
                                        data-testid={`btn-add-variant-${item._editIdx}`}
                                      >
                                        <Copy className="w-3 h-3 mr-1" />
                                        Add Variant
                                      </Button>
                                    )}
                                    {item.isCustom && (
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-8 px-2 text-destructive"
                                        onClick={() => removeItem(item._editIdx)}
                                        data-testid={`btn-remove-item-${item._editIdx}`}
                                      >
                                        <Trash2 className="w-3 h-3" />
                                      </Button>
                                    )}
                                    {!item.isCustom && item._isVariant && (
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-8 px-2 text-destructive"
                                        onClick={() => removeVariant(item._editIdx)}
                                        data-testid={`btn-remove-variant-${item._editIdx}`}
                                      >
                                        <Trash2 className="w-3 h-3" />
                                      </Button>
                                    )}
                                  </>
                                )}
                              </div>
                            </div>
                          )}

                          {/* Comment input + read-only paragraph used to
                              live here on their own line; they're now
                              rendered inline inside the label/values row
                              above (in the middle column). */}
                        </div>
                      );
                    })}

                    {showDiffView && approvedSheet && (() => {
                      const removedItems = approvedSheet.items.filter(
                        (ai) => ai.category === category && !items.some((pi) => pi.key === ai.key),
                      );
                      if (removedItems.length === 0) return null;
                      return removedItems.map((ri, idx) => (
                        <div
                          key={`removed-${idx}`}
                          className="flex items-center gap-2 p-3 rounded-[var(--radius)] border border-l-4 border-l-destructive/60 bg-destructive/5 opacity-60"
                          data-testid={`cost-item-removed-${ri.key}`}
                        >
                          <div className="flex-1 min-w-0">
                            <span className="text-sm font-medium line-through text-destructive">{ri.key}</span>
                          </div>
                          <div className="w-28 text-right">
                            <span className="text-sm tabular-nums text-muted-foreground italic">-</span>
                          </div>
                          <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0" />
                          <div className="w-28 text-right">
                            <span className="text-sm tabular-nums text-destructive/70 line-through">
                              {ri.minValue != null ? formatCurrency(ri.minValue) : "-"}
                            </span>
                          </div>
                          <div className="w-16 text-center">
                            <Badge className="text-xs bg-destructive/10 text-destructive border-destructive/30">Removed</Badge>
                          </div>
                        </div>
                      ));
                    })()}
                  </div>
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>
      )}

      {effectiveEditing && (
        <Button
          variant="outline"
          onClick={addCustomItem}
          className="w-full"
          data-testid="btn-add-custom-item"
        >
          <Plus className="w-4 h-4 mr-1" />
          Add Custom Cost Item
        </Button>
      )}

      {displayItems.length > 0 && (totals.minTotal > 0 || totals.maxTotal > 0 || effectiveEditing) && (
        <Card data-testid="card-total-cost">
          <CardContent className="py-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">Estimated Total</span>
              <span className="text-lg font-bold tabular-nums" data-testid="text-total-cost">
                {totals.minTotal > 0 && totals.minTotal !== totals.maxTotal
                  ? `${formatCurrency(totals.minTotal)} – ${formatCurrency(totals.maxTotal)}`
                  : formatCurrency(totals.maxTotal || totals.minTotal)}
              </span>
            </div>
            {showDiffView && approvedSheet && (
              <div className="flex items-center justify-between mt-1 text-xs text-muted-foreground">
                <span>Previously approved total</span>
                <span className="tabular-nums">
                  {(() => {
                    const at = calculateTotalCost(approvedSheet.items);
                    return at.minTotal === at.maxTotal
                      ? formatCurrency(at.minTotal)
                      : `${formatCurrency(at.minTotal)} – ${formatCurrency(at.maxTotal)}`;
                  })()}
                </span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {isAdminView && effectiveEditing && editItems.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-50 bg-background px-6 py-4 border-t flex gap-2 justify-end items-center" data-testid="admin-edit-actions">
          {autoSaveStatus === "saving" && (
            <span className="text-xs text-muted-foreground flex items-center gap-1 mr-auto" data-testid="text-auto-save-status">
              <Loader2 className="w-3 h-3 animate-spin" />
              Saving draft...
            </span>
          )}
          {autoSaveStatus === "saved" && (
            <span className="text-xs text-[hsl(var(--brand-success))] flex items-center gap-1 mr-auto" data-testid="text-auto-save-status">
              <Check className="w-3 h-3" />
              Draft saved
            </span>
          )}
          <Button
            variant="outline"
            onClick={() => {
              setIsEditing(false);
              setEditItems([]);
            }}
            data-testid="btn-cancel-edit"
          >
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (autoSavePendingTimerRef.current) { clearTimeout(autoSavePendingTimerRef.current); autoSavePendingTimerRef.current = null; }
              if (isAdminView) {
                const existingSheetId = displaySheet && displaySheet.status !== "APPROVED" ? displaySheet.id : undefined;
                submitMutation.mutate({ items: editItems, sheetId: existingSheetId });
              } else if (displaySheet && displaySheet.status !== "APPROVED") {
                updateMutation.mutate({ sheetId: displaySheet.id, items: editItems });
              } else {
                submitMutation.mutate({ items: editItems, sheetId: undefined });
              }
            }}
            disabled={updateMutation.isPending || submitMutation.isPending}
            data-testid="btn-admin-save"
          >
            {(updateMutation.isPending || submitMutation.isPending) ? (
              <Loader2 className="w-4 h-4 mr-1 animate-spin" />
            ) : null}
            Save
          </Button>
        </div>
      )}

      {!isAdminView && editItems.length > 0 && (isDirty || !displaySheet || displaySheet.status === "DRAFT" || displaySheet.status === "REJECTED") && (
        <div className="fixed bottom-0 left-0 right-0 z-50 bg-background px-6 py-4 border-t flex gap-2 justify-end items-center" data-testid="edit-actions">
          {autoSaveStatus === "saving" && (
            <span className="text-xs text-muted-foreground flex items-center gap-1 mr-auto" data-testid="text-auto-save-status">
              <Loader2 className="w-3 h-3 animate-spin" />
              Saving draft...
            </span>
          )}
          {autoSaveStatus === "saved" && (
            <span className="text-xs text-[hsl(var(--brand-success))] flex items-center gap-1 mr-auto" data-testid="text-auto-save-status">
              <Check className="w-3 h-3" />
              Draft saved
            </span>
          )}
          {missingMandatory.length > 0 && (
            <p className="text-xs text-destructive self-center mr-2" data-testid="text-missing-mandatory">
              Missing: {missingMandatory.join(", ")}
            </p>
          )}
          {needsClassificationConfirmation && missingMandatory.length === 0 && (
            <p className="text-xs text-[hsl(var(--brand-warning))] font-medium self-center mr-2 flex items-center gap-1" data-testid="text-needs-classification-confirm">
              <AlertTriangle className="w-3.5 h-3.5" />
              Confirm the AI classification first
            </p>
          )}
          <Button
            onClick={() => {
              if (autoSavePendingTimerRef.current) { clearTimeout(autoSavePendingTimerRef.current); autoSavePendingTimerRef.current = null; }
              submitMutation.mutate({
                items: editItems,
                sheetId: displaySheet?.status === "APPROVED" ? undefined : displaySheet?.id,
              });
            }}
            disabled={submitMutation.isPending || missingMandatory.length > 0 || isParsing || needsClassificationConfirmation}
            data-testid="btn-submit-for-approval"
          >
            {submitMutation.isPending ? (
              <Loader2 className="w-4 h-4 mr-1 animate-spin" />
            ) : null}
            Submit for Approval
          </Button>
        </div>
      )}

      <Dialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject Cost Sheet</DialogTitle>
            <DialogDescription>Provide feedback for the provider.</DialogDescription>
          </DialogHeader>
          <Textarea
            value={rejectFeedback}
            onChange={(e) => setRejectFeedback(e.target.value)}
            placeholder="Explain why this cost sheet is being rejected..."
            className="min-h-[100px]"
            data-testid="input-reject-feedback"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                rejectMutation.mutate({
                  sheetId: rejectSheetId,
                  feedback: rejectFeedback,
                })
              }
              disabled={!rejectFeedback.trim() || rejectMutation.isPending}
              data-testid="btn-confirm-reject"
            >
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const SERVICE_LABELS: Record<string, string> = {
  "Egg Donor Agency": "Egg Donation",
  "Surrogacy Agency": "Surrogacy",
  "IVF Clinic": "IVF",
  "Egg Bank": "Egg Bank",
  "Sperm Bank": "Sperm Bank",
  "Legal Services": "Legal",
};

function getServiceLabel(name: string): string {
  return SERVICE_LABELS[name] || name;
}

function ProgramTotalBadge({ program }: { program: CostProgram }) {
  // Derive the total straight from the items the server included on the
  // program. No standalone fetch here - the previous version fired two
  // useQuery calls keyed by programId, but their cache stayed stale after
  // a fresh upload+parse (the post-parse invalidateAll() didn't always
  // win the race vs the queries' initial empty fetch). Now the totals
  // ride along with programsQuery, which IS invalidated by every cost
  // mutation, so the badge always reflects the same DB state the editor
  // below renders.
  const items = program.latestSheetItems;
  if (!items?.length) return null;

  const totals = calculateTotalCost(items);
  if (!totals.maxTotal && !totals.minTotal) return null;

  const isDraft = program.latestSheetStatus !== "APPROVED";
  const display =
    totals.minTotal > 0 && totals.minTotal !== totals.maxTotal
      ? `${formatCurrency(totals.minTotal)} - ${formatCurrency(totals.maxTotal)}`
      : formatCurrency(totals.maxTotal || totals.minTotal);

  return (
    <span className="text-sm font-semibold tabular-nums text-primary" data-testid="program-total-badge">
      {display}
      {isDraft && <span className="ml-1 text-xs font-normal text-muted-foreground">(draft)</span>}
    </span>
  );
}

function ProgramsView({
  providerType,
  providerTypeId,
  providerId,
  isAdminView,
  canManagePrograms,
  parentId,
  subType,
  tabFilter,
  providerServices,
}: {
  providerType: string;
  providerTypeId?: string;
  providerId: string;
  isAdminView: boolean;
  canManagePrograms?: boolean;
  parentId?: string;
  subType?: string;
  tabFilter?: IvfTab;
  // Approved services on this provider. Used to filter the "Services
  // covered" chip row down to tags the provider can actually offer - a
  // surrogacy agency shouldn't see an IVF chip on a program row.
  providerServices?: ServiceInfo[];
}) {
  const { toast } = useToast();
  const [expandedProgramId, setExpandedProgramId] = useState<string | null>(null);
  const autoExpandedRef = useRef(false);
  const [isAddingProgram, setIsAddingProgram] = useState(false);
  const [editingProgramId, setEditingProgramId] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formCountry, setFormCountry] = useState("");

  const programsQueryKey = ["/api/costs/programs", providerId, providerTypeId || "all", subType || "none"];
  const programsQuery = useQuery<CostProgram[]>({
    queryKey: programsQueryKey,
    queryFn: () => {
      const params = new URLSearchParams({ providerId });
      if (providerTypeId) params.set("providerTypeId", providerTypeId);
      if (subType) params.set("subType", subType);
      return fetch(`/api/costs/programs?${params.toString()}`, { credentials: "include" }).then((r) => r.json());
    },
    enabled: !!providerId,
  });

  const allPrograms = Array.isArray(programsQuery.data) ? programsQuery.data : [];
  // When `tabFilter` is provided (IVF clinic 4-tab wrapper), only show
  // programs whose tab matches. Programs with no tab yet (newly created or
  // pre-classification) appear in EVERY tab so the clinic can claim them.
  const programs = tabFilter
    ? allPrograms.filter((p) => !p.tab || p.tab === tabFilter)
    : allPrograms;

  // Auto-expand the first program with a pending review when admin lands on this tab.
  // Uses a ref so collapsing manually never re-triggers the auto-expand.
  useEffect(() => {
    if (!isAdminView || autoExpandedRef.current || programs.length === 0) return;
    autoExpandedRef.current = true;
    const pending = programs.find((p) => p.latestSheetStatus === "PENDING");
    if (pending) setExpandedProgramId(pending.id);
    else if (programs.length === 1) setExpandedProgramId(programs[0].id);
  }, [isAdminView, programs.length]);

  const invalidatePrograms = () => queryClient.invalidateQueries({ queryKey: programsQueryKey });

  const createMutation = useMutation({
    mutationFn: async (data: { name: string; country: string }) => {
      const payload: any = { providerId, providerTypeId, subType, ...data };
      // Default the new program into the tab the clinic is currently viewing.
      // Subtype stays null until upload + AI classifies (or the clinic picks).
      if (tabFilter) payload.tab = tabFilter;
      const res = await apiRequest("POST", "/api/costs/programs", payload);
      return res.json() as Promise<CostProgram>;
    },
    onSuccess: (newProgram: CostProgram) => {
      invalidatePrograms();
      setIsAddingProgram(false);
      setFormName("");
      setFormCountry("");
      setExpandedProgramId(newProgram.id);
      toast({ title: "Program created", variant: "success" });
    },
    onError: (err: any) => {
      toast({ title: "Failed to create program", description: err.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, name, country }: { id: string; name: string; country: string }) =>
      apiRequest("PATCH", `/api/costs/programs/${id}`, { name, country }),
    onSuccess: () => {
      invalidatePrograms();
      setEditingProgramId(null);
      toast({ title: "Program updated", variant: "success" });
    },
    onError: (err: any) => {
      toast({ title: "Failed to update program", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/costs/programs/${id}`),
    onSuccess: () => {
      invalidatePrograms();
      toast({ title: "Program deleted", variant: "success" });
    },
    onError: (err: any) => {
      toast({ title: "Failed to delete program", description: err.message, variant: "destructive" });
    },
  });

  // Update the program-level subType (also writes back to the program's
  // latest sheet via the controller).
  const updateSubTypesMutation = useMutation({
    mutationFn: ({ id, subTypes }: { id: string; subTypes: string[] }) =>
      apiRequest("PATCH", `/api/costs/programs/${id}`, { subTypes }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/costs/provider", providerId, "programs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/costs/provider", providerId, "sheets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/costs/provider", providerId, "approved"] });
    },
    onError: (err: any) => {
      toast({ title: "Failed to update coverage", description: err.message, variant: "destructive" });
    },
  });

  const updateSubTypeMutation = useMutation({
    mutationFn: ({ id, subType, tab }: { id: string; subType: string; tab?: string }) =>
      apiRequest("PATCH", `/api/costs/programs/${id}`, { subType, ...(tab ? { tab } : {}) }),
    onSuccess: () => invalidatePrograms(),
    onError: (err: any) => {
      toast({ title: "Failed to update program type", description: err.message, variant: "destructive" });
    },
  });

  // Update the program's serviceTypes tag array. Lets the provider override
  // an AI-misclassified tag set (or add a tag when a sheet bundles multiple
  // services). Server validates against the allowed enum.
  const updateServiceTypesMutation = useMutation({
    mutationFn: ({ id, serviceTypes }: { id: string; serviceTypes: string[] }) =>
      apiRequest("PATCH", `/api/costs/programs/${id}`, { serviceTypes }),
    onSuccess: () => invalidatePrograms(),
    onError: (err: any) => {
      toast({ title: "Failed to update service tags", description: err.message, variant: "destructive" });
    },
  });

  // Upload-first flow (IVF clinics): drop a file with no programId. Server
  // auto-creates a placeholder program; AI fills in name + country + subtype
  // + Fixed/Not-Fixed once parsing finishes. The returned programId tells us
  // which row to expand.
  const uploadFirstMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("providerId", providerId);
      formData.append("providerType", providerType);
      if (providerTypeId) formData.append("providerTypeId", providerTypeId);
      const res = await fetch("/api/costs/upload", { method: "POST", body: formData, credentials: "include" });
      if (!res.ok) throw new Error((await res.json()).message || "Upload failed");
      return res.json() as Promise<{ id: string; programId: string }>;
    },
    onSuccess: (result) => {
      invalidatePrograms();
      setExpandedProgramId(result.programId);
      toast({ title: "Uploaded - AI is classifying your cost sheet...", variant: "success" });
    },
    onError: (err: any) => {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    },
  });

  const [isUploadDragging, setIsUploadDragging] = useState(false);
  const uploadFileInputRef = useRef<HTMLInputElement>(null);

  const isIvfType = isIvfClinicType(providerType);
  const isMultiServiceProvider = providerType.toLowerCase() === "multi-service";

  // Allowed serviceType tags for THIS provider. Derived from the providers's
  // approved services so a surrogacy agency only sees a "Surrogacy" chip,
  // an IVF clinic + egg bank sees "IVF" + "Egg Donor", etc. Mirrors the
  // server's costs.service.ts mapping (provider type name -> serviceType
  // tag) so the chip set stays in sync with what the matcher accepts.
  // Falls back to the full set when we don't know the provider's services
  // (single-service legacy view, parent-facing view, etc.) so we never
  // accidentally hide every chip.
  const allowedServiceTagSet = (() => {
    if (!providerServices || providerServices.length === 0) {
      return new Set<string>(ALL_SERVICE_TYPES);
    }
    const tags = new Set<string>();
    for (const svc of providerServices) {
      const n = (svc.providerTypeName || "").toLowerCase();
      if (n.includes("ivf") || n.includes("clinic")) tags.add("ivf_clinic");
      if (n.includes("surrogacy")) tags.add("surrogacy");
      if (n.includes("egg donor") || n.includes("egg bank")) tags.add("egg_donor");
      if (n.includes("sperm bank") || n.includes("sperm donor")) tags.add("sperm_donor");
    }
    // Defensive: if mapping produced nothing (unknown provider type name)
    // fall back to the full set instead of locking the clinic out.
    return tags.size > 0 ? tags : new Set<string>(ALL_SERVICE_TYPES);
  })();
  const allowedServiceTags = ALL_SERVICE_TYPES.filter((tag) => allowedServiceTagSet.has(tag));
  // Every upload-first provider (IVF + surrogacy + egg donor + sperm bank +
  // multi-service) gets the dropzone and the classification card. Only the
  // subtype layer differs - IVF uses the 14-subtype taxonomy, egg donor uses
  // fresh/frozen, surrogacy/sperm-bank get nothing. For multi-service the
  // subtype layer is per-program (driven by that program's serviceTypes),
  // computed inline below.
  const uploadFirstType = supportsUploadFirst(providerType);
  const showFreshFrozenSubtype = hasFreshFrozenSubtypes(providerType);
  const showIvfSubtypeDropdown = hasIvfSubtypes(providerType);
  const showAnySubtypeDropdown = showIvfSubtypeDropdown || showFreshFrozenSubtype;

  // Per-program subtype-dropdown selectors. For single-service providers
  // these collapse to the provider-level flags. For multi-service providers
  // they read the program's serviceTypes tags - so an IVF program on
  // Eggspecting gets the IVF dropdown, a surrogacy program gets none.
  function programShowsIvfSubtype(program: CostProgram): boolean {
    if (!isMultiServiceProvider) return showIvfSubtypeDropdown;
    return (program.serviceTypes ?? []).includes("ivf_clinic");
  }
  function programShowsFreshFrozen(program: CostProgram): boolean {
    if (!isMultiServiceProvider) return showFreshFrozenSubtype;
    const tags = program.serviceTypes ?? [];
    return tags.includes("egg_donor") && !tags.includes("ivf_clinic");
  }
  function programShowsAnySubtype(program: CostProgram): boolean {
    return programShowsIvfSubtype(program) || programShowsFreshFrozen(program);
  }

  function startEdit(program: CostProgram) {
    setEditingProgramId(program.id);
    setFormName(program.name);
    setFormCountry(program.country);
  }

  function cancelEdit() {
    setEditingProgramId(null);
    setFormName("");
    setFormCountry("");
  }

  function startAdd() {
    setIsAddingProgram(true);
    setFormName("");
    setFormCountry("");
    setEditingProgramId(null);
  }

  const canManage = isAdminView || canManagePrograms;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {programs.length === 0 ? "No programs yet" : `${programs.length} program${programs.length !== 1 ? "s" : ""}`}
        </p>
        {/* Legacy add-program button only for providers that don't support
            upload-first (e.g. legal services). All fertility-tier providers
            use the dropzone instead. */}
        {canManage && !uploadFirstType && !isAddingProgram && (
          <Button size="sm" variant="outline" onClick={startAdd}>
            <Plus className="w-4 h-4 mr-1" />
            Add Program
          </Button>
        )}
      </div>

      {/* Upload-first dropzone. Available to IVF + Surrogacy + Egg Donor +
          Sperm Bank. The server auto-creates a placeholder program; AI fills
          in name, country, Fixed/Not-Fixed, and (for IVF / Egg Donor) the
          subtype once parsing finishes. */}
      {canManage && uploadFirstType && (
        <div
          className={cn(
            "border-2 border-dashed rounded-[var(--container-radius)] p-6 text-center transition-colors cursor-pointer",
            isUploadDragging
              ? "border-primary bg-primary/5"
              : uploadFirstMutation.isPending
              ? "border-primary/40 bg-primary/5 cursor-wait"
              : "border-border hover:border-primary/50"
          )}
          onDragOver={(e) => {
            e.preventDefault();
            if (!uploadFirstMutation.isPending) setIsUploadDragging(true);
          }}
          onDragLeave={() => setIsUploadDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsUploadDragging(false);
            const file = e.dataTransfer.files[0];
            if (file && !uploadFirstMutation.isPending) uploadFirstMutation.mutate(file);
          }}
          onClick={() => {
            if (!uploadFirstMutation.isPending) uploadFileInputRef.current?.click();
          }}
          data-testid="dropzone-upload-first"
        >
          <input
            ref={uploadFileInputRef}
            type="file"
            className="hidden"
            accept=".pdf,.xlsx,.xls"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) uploadFirstMutation.mutate(file);
            }}
          />
          {uploadFirstMutation.isPending ? (
            <>
              <Loader2 className="w-8 h-8 mx-auto mb-2 text-primary animate-spin" />
              <p className="text-sm font-medium text-foreground">Uploading...</p>
              <p className="text-xs text-muted-foreground mt-1">
                AI will set up the program for you in a moment.
              </p>
            </>
          ) : (
            <>
              <Upload className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
              <p className="text-sm font-medium text-foreground">
                Drop a cost sheet here to create a new program
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                PDF, XLS, XLSX (max 20MB) - AI auto-detects program name, country, type, and Fixed/Not-Fixed.
              </p>
            </>
          )}
        </div>
      )}

      {isAddingProgram && !uploadFirstType && (
        <div className="border rounded-[var(--container-radius)] p-4 space-y-3 bg-muted/20">
          <p className="text-sm font-medium">New Program</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Program Name</Label>
              <Input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. Standard Package"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Country</Label>
              <SingleCountryAutocompleteInput
                value={formCountry}
                onChange={setFormCountry}
                placeholder="Select country..."
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={!formName.trim() || !formCountry.trim() || createMutation.isPending}
              onClick={() => createMutation.mutate({ name: formName.trim(), country: formCountry.trim() })}
            >
              {createMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Check className="w-4 h-4 mr-1" />}
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setIsAddingProgram(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {programsQuery.isLoading && (
        <div className="space-y-3">
          {[1, 2].map((i) => <div key={i} className="h-14 rounded-[var(--container-radius)] bg-muted animate-pulse" />)}
        </div>
      )}

      {programs.map((program) => {
        const isExpanded = expandedProgramId === program.id;
        const isEditing = editingProgramId === program.id;

        return (
          <div key={program.id} className="border rounded-[var(--container-radius)] overflow-hidden">
            <div
              className={cn(
                "flex items-center gap-3 px-4 py-3 bg-muted/20 transition-colors",
                !isEditing && "cursor-pointer hover:bg-muted/40"
              )}
              onClick={isEditing ? undefined : () => setExpandedProgramId(isExpanded ? null : program.id)}
              role={isEditing ? undefined : "button"}
              tabIndex={isEditing ? undefined : 0}
              onKeyDown={isEditing ? undefined : (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setExpandedProgramId(isExpanded ? null : program.id);
                }
              }}
            >
              <>
                {/* Edit mode keeps the same inline row layout as view mode -
                    just swaps the program-name span and the country chip
                    for editable controls in their original positions. The
                    classification toggles, total badge, and pending badge
                    stay visible so admins don't lose context when renaming. */}
                <div
                  className="flex-1 flex items-center gap-2 flex-nowrap min-w-0 overflow-hidden"
                  onClick={isEditing ? (e) => e.stopPropagation() : undefined}
                >
                  {isEditing ? (
                    <>
                      <Input
                        value={formName}
                        onChange={(e) => setFormName(e.target.value)}
                        placeholder="Program name"
                        className="h-7 text-sm w-56 flex-shrink-0"
                        data-testid={`input-program-name-${program.id}`}
                      />
                      <div className="w-44 flex-shrink-0">
                        <SingleCountryAutocompleteInput
                          value={formCountry}
                          onChange={setFormCountry}
                          placeholder="Country"
                          data-testid={`input-program-country-${program.id}`}
                        />
                      </div>
                    </>
                  ) : (
                    <>
                      {/* Name column is fixed-width truncate so the
                          country chip lands at a consistent X position
                          across rows. Long names ellipsize with their
                          full text reachable via the browser title
                          tooltip. */}
                      <span className="font-medium text-sm truncate w-48 flex-shrink-0" title={program.name}>{program.name}</span>
                      {/* Abbreviated country name (e.g. "United States" -> "USA")
                          to reclaim horizontal space for the classification
                          toggles + total + action icons on the right. Full
                          name is preserved in the tooltip for disambiguation. */}
                      <Badge
                        variant="outline"
                        className="text-xs flex items-center gap-1 flex-shrink-0"
                        title={program.country}
                      >
                        {getCountryFlag(program.country)
                          ? <span>{getCountryFlag(program.country)}</span>
                          : <Globe className="w-3 h-3" />}
                        {getCountryShortName(program.country)}
                      </Badge>
                    </>
                  )}
                  {/* Classification slots use natural widths so they
                      don't overflow narrow viewports. Same provider has
                      the same chips on every row so the widths match
                      naturally. */}
                  <ProgramClassificationControls
                    program={program}
                    providerId={providerId}
                    allowedServiceTags={allowedServiceTags}
                    providerType={providerType}
                  />
                </div>

                {/* Total + pending live OUTSIDE the flex-1 wrapper, as
                    true siblings of the pencil/trash/chevron action
                    buttons in the outer row. This way the flex layout
                    reserves real horizontal space for them - the total
                    can't visually bleed past its allocated box and
                    overlap the icons, even when the price is a wide
                    range like "$166,910 - $171,910 (draft)". */}
                <div className="whitespace-nowrap text-right flex-shrink-0">
                  <ProgramTotalBadge program={program} />
                </div>
                {isAdminView && program.latestSheetStatus === "PENDING" && (
                  <Badge className="text-xs bg-[hsl(var(--brand-warning))]/15 text-[hsl(var(--brand-warning))] border-[hsl(var(--brand-warning))]/40 border flex-shrink-0">
                    Pending Review
                  </Badge>
                )}
                {isEditing ? (
                  <>
                    {/* Save / Cancel replace the Pencil in-place. Trash and
                        chevron stay on the right edge so the row's
                        controls don't shift around between modes. */}
                    <Button
                      size="sm"
                      className="h-7 w-7 p-0"
                      disabled={!formName.trim() || !formCountry.trim() || updateMutation.isPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        updateMutation.mutate({ id: program.id, name: formName.trim(), country: formCountry.trim() });
                      }}
                      data-testid={`btn-save-program-${program.id}`}
                    >
                      {updateMutation.isPending
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : <Check className="w-3.5 h-3.5" />}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        cancelEdit();
                      }}
                      data-testid={`btn-cancel-program-${program.id}`}
                    >
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </>
                ) : (
                  (isAdminView || canManagePrograms) && (
                    <>
                      {/* Confirm-classification icon. Sits in the reserved
                          action-icon space (sibling of Pencil/Trash/Chevron)
                          so a wide total column can never clip it like it
                          could when this button lived inside the flex-1
                          overflow-hidden wrapper. */}
                      <ProgramConfirmIconButton program={program} providerId={providerId} />
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0"
                        onClick={(e) => {
                          e.stopPropagation();
                          startEdit(program);
                        }}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild onClick={(e) => e.stopPropagation()}>
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0">
                            <Trash2 className="w-3.5 h-3.5 text-destructive" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete Program</AlertDialogTitle>
                            <AlertDialogDescription>
                              This will permanently delete "{program.name}" and all its cost data. This cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              onClick={() => {
                                if (expandedProgramId === program.id) setExpandedProgramId(null);
                                deleteMutation.mutate(program.id);
                              }}
                            >
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </>
                  )
                )}
                {/* Chevron is purely visual now - the whole row toggles. */}
                <div className="h-7 w-7 flex items-center justify-center text-muted-foreground" aria-hidden>
                  {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </div>
              </>
            </div>

            {isExpanded && (
              <div className="border-t">
                {/* Both the Services covered multi-select and the Program
                    type picker used to live as standalone rows above the
                    cost-sheet body. They now live inside the classification
                    card (rendered by SingleCostsTab below) so all three
                    AI-classifications - services + program type + Fixed/
                    Not-Fixed - sit on the same green/amber surface. */}
                <div className="p-4">
                  <SingleCostsTab
                    providerType={providerType}
                    providerTypeId={providerTypeId}
                    providerId={providerId}
                    isAdminView={isAdminView}
                    parentId={parentId}
                    subType={subType}
                    programId={program.id}
                    programSubType={programShowsIvfSubtype(program) ? (program.subType ?? null) : undefined}
                    programTab={programShowsIvfSubtype(program) ? (program.tab ?? tabFilter ?? null) : undefined}
                    programShowsAnySubtype={programShowsAnySubtype(program)}
                    programShowsIvfSubtype={programShowsIvfSubtype(program)}
                    programCurrentSubType={program.subType ?? null}
                    programTabFilter={tabFilter}
                    onSubTypeChange={(newSub, newTab) =>
                      updateSubTypeMutation.mutate({ id: program.id, subType: newSub, tab: newTab })
                    }
                    allowedServiceTags={allowedServiceTags}
                    programServiceTypes={program.serviceTypes ?? []}
                    onServiceTypesChange={(next) =>
                      updateServiceTypesMutation.mutate({ id: program.id, serviceTypes: next })
                    }
                    programCurrentSubTypes={program.subTypes ?? []}
                    onSubTypesChange={(next) =>
                      updateSubTypesMutation.mutate({ id: program.id, subTypes: next })
                    }
                  />
                </div>
              </div>
            )}
          </div>
        );
      })}

      {programs.length === 0 && !programsQuery.isLoading && !isAddingProgram && !uploadFirstType && (
        <div className="text-center py-8 border rounded-[var(--container-radius)] text-muted-foreground">
          <Globe className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <p className="text-sm">No programs created yet.</p>
          {(isAdminView || canManagePrograms) && (
            <p className="text-xs mt-1">Click "Add Program" to create the first program.</p>
          )}
        </div>
      )}
    </div>
  );
}

// (Removed isEggDonationType + EggDonationSubTabs - Fresh/Frozen is now a
// per-program AI-detected subtype shown in the program row badge + dropdown.)

export default function ProviderCostsTab({
  providerType,
  providerId,
  isAdminView,
  canManagePrograms,
  parentId,
  providerServices,
}: ProviderCostsTabProps) {
  const services = providerServices && providerServices.length > 0 ? providerServices : null;
  const [selectedTypeId, setSelectedTypeId] = useState<string>(services?.[0]?.providerTypeId || "");

  useEffect(() => {
    if (services && services.length > 0 && !services.find(s => s.providerTypeId === selectedTypeId)) {
      setSelectedTypeId(services[0].providerTypeId);
    }
  }, [services, selectedTypeId]);

  if (!services || services.length <= 1) {
    const svcName = services?.[0]?.providerTypeName || providerType;
    const svcTypeId = services?.[0]?.providerTypeId;

    // Egg-donation Fresh/Frozen used to live in outer radio buttons. Now
    // the AI classifies each program automatically and each program shows
    // its fresh/frozen via the in-row badge + dropdown - so we drop the
    // EggDonationSubTabs wrapper and render programs straight.
    return (
      <ProgramsView
        providerType={svcName}
        providerTypeId={svcTypeId}
        providerId={providerId}
        isAdminView={isAdminView}
        canManagePrograms={canManagePrograms}
        parentId={parentId}
        providerServices={providerServices}
      />
    );
  }

  // Multi-service provider (e.g. Eggspecting - IVF Clinic + Surrogacy +
  // Egg Donor). Every cost sheet carries its own service-type tag(s) and
  // we show one flat list across services. The AI tags each program on
  // upload; provider can override the tags on the row.
  //
  // CRITICAL: pass "multi-service" instead of the first service's name.
  // (a) The upload endpoint forwards this to the AI prompt branch that
  //     unions all heuristics - otherwise a surrogacy PDF dropped here
  //     gets force-classified as an IVF subtype.
  // (b) /api/costs/templates/multi-service returns no templates, so the
  //     editor doesn't fabricate IVF default fields as a fallback when
  //     a sheet parses empty.
  return (
    <ProgramsView
      providerType="multi-service"
      providerTypeId={undefined}
      providerId={providerId}
      isAdminView={isAdminView}
      canManagePrograms={canManagePrograms}
      parentId={parentId}
      providerServices={providerServices}
    />
  );
}
