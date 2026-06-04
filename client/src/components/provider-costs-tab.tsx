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

// Egg-donor subtype picker - mirrors IvfSubtypePopover's visual treatment
// (badge grid, mobile drawer / desktop popover) but with the flat 2-option
// fresh/frozen list instead of the tab-grouped 14-subtype IVF taxonomy.
// Used as a sub-popover next to the top-bar "Egg Donor" coverage leaf,
// analogous to how the IVF leaf surfaces IvfSubtypePopover.
function EggDonorSubtypePopover({
  currentSubType,
  onSelect,
  triggerClassName,
}: {
  currentSubType: string | null;
  onSelect: (subType: string) => void;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const currentLabel = labelOfEggDonorSubtype(currentSubType);

  const trigger = (
    <Button
      variant="outline"
      size="sm"
      className={cn(
        "shrink-0 h-8 text-xs font-medium rounded-[var(--radius)] gap-1.5 px-3",
        triggerClassName,
      )}
      data-testid="select-egg-donor-subtype"
    >
      <span className="truncate text-left">{currentLabel || "Select donor type..."}</span>
      <ChevronDown className="w-3.5 h-3.5 opacity-60 flex-shrink-0" />
    </Button>
  );

  const body = (
    <div className="flex flex-wrap gap-2.5">
      {EGG_DONOR_SUBTYPES.map(s => {
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
            data-testid={`egg-donor-subtype-option-${s.id}`}
          >
            {s.label}
          </Badge>
        );
      })}
    </div>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger asChild>{trigger}</DrawerTrigger>
        <DrawerContent data-testid="drawer-egg-donor-subtype">
          <DrawerHeader>
            <DrawerTitle>Donor type</DrawerTitle>
          </DrawerHeader>
          <div className="px-6 pb-6 max-h-[70vh] overflow-y-auto space-y-4">
            {body}
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        className="w-[22rem] max-w-[calc(100vw-2rem)] p-4 max-h-[var(--radix-popover-content-available-height)] overflow-y-auto"
        align="start"
        side="bottom"
        sideOffset={6}
        collisionPadding={16}
      >
        <div className="space-y-3">
          <div className="flex justify-between items-center sticky top-0 bg-popover pb-2 -mt-1 -mx-1 px-1 z-10">
            <span className="font-ui" style={{ fontSize: 'var(--filter-label-size, 18px)' }}>Donor type</span>
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
  { id: "egg_donor",         label: "Egg Donor",   serviceTag: "egg_donor" },
  { id: "sperm_donor",       label: "Sperm Donor", serviceTag: "sperm_donor" },
  { id: "ivf",               label: "IVF",         serviceTag: "ivf_clinic" },
];

// Backwards alias - some call sites still import NON_IVF_LEAVES.
const NON_IVF_LEAVES = COVERAGE_LEAVES.filter(l => l.id !== "ivf");

// Egg-donor subtype options surfaced by the EggDonor sub-popover. The
// virtual "egg_donor" coverage leaf is on when one of these ids lives in
// subTypes[]; the backend matcher continues to read the granular ids.
const EGG_DONOR_SUBTYPES: { id: string; label: string }[] = [
  { id: "egg_donor_fresh",  label: "Fresh Donor" },
  { id: "egg_donor_frozen", label: "Frozen Egg" },
];

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

// Find the (single) egg-donor subtype currently in subTypes[]. The top-bar
// "Egg Donor" coverage leaf is a virtual toggle whose on/off state is
// derived from this; the actual fresh/frozen distinction is picked in a
// sub-popover styled to match the IVF program-type popover.
function getEggDonorSubtype(subTypes: string[] | null | undefined): string | null {
  return (subTypes || []).find(s => s === "egg_donor_fresh" || s === "egg_donor_frozen") || null;
}

function labelOfEggDonorSubtype(subType: string | null | undefined): string | null {
  return EGG_DONOR_SUBTYPES.find(s => s.id === subType)?.label ?? null;
}

// Pending-state shape held at the ProgramsView level. One entry per
// program with at least one unsaved edit; absent entries = clean rows.
// Save bar at the bottom of the Costs tab flushes all of these in order
// via the existing PATCH endpoints when the user clicks SAVE.
type ProgramPending = {
  name?: string;
  country?: string;
  subTypes?: string[];
  isFixedCost?: boolean | null;
  // Line-item edits bubbled up from SingleCostsTab. The bottom Save bar
  // flushes these via /api/costs/save-draft per program.
  items?: CostItemData[];
};

// Consolidated classification controls rendered inline inside each cost
// program's top bar. Encapsulates: Coverage toggle row (Surrogacy / Egg
// Donor / Sperm Donor / IVF), Program type popover (visible only when
// IVF leaf is on), Egg-donor Fresh/Frozen popover (visible only when the
// egg-donor leaf is on), and the Fixed-Cost / Not-Fixed segmented toggle.
// All edits are STAGED into the pending bag - they don't fire mutations
// directly. The parent's Save bar flushes them when clicked.
function ProgramClassificationControls({
  program,
  pending,
  onPatch,
  allowedServiceTags,
}: {
  program: CostProgram;
  pending?: ProgramPending;
  onPatch: (patch: Partial<ProgramPending>) => void;
  allowedServiceTags: string[];
}) {
  const visibleLeaves = leavesForServiceTags(allowedServiceTags);
  // Effective state = pending overlay (if any) on top of server values.
  const current = pending?.subTypes ?? program.subTypes ?? [];
  const currentIvfSubtype = getIvfSubtype(current);
  const ivfOn = !!currentIvfSubtype;
  const currentEggDonorSubtype = getEggDonorSubtype(current);
  const eggDonorOn = !!currentEggDonorSubtype;
  // "Shipping Eggs + Sperm" programs mean the parent ships their own eggs
  // to the clinic - there's no donor in the equation, so the Fresh/Frozen
  // donor picker doesn't apply. Hide it for those subtypes.
  const ivfSubtypeExcludesDonor = currentIvfSubtype?.startsWith("shipping_eggs_sperm") ?? false;
  const latestSheet = program.latestSheet ?? null;
  const effectiveIsFixedCost =
    pending?.isFixedCost !== undefined ? pending.isFixedCost : latestSheet?.isFixedCost ?? null;

  const toggleLeaf = (leafId: string) => {
    if (leafId === "ivf") {
      if (ivfOn) {
        const next = current.filter(s => !s.startsWith("ivf_") && !s.startsWith("embryo_") && !s.startsWith("fet_") && !s.startsWith("shipping_") && !s.startsWith("egg_freezing_"));
        onPatch({ subTypes: next });
      } else {
        onPatch({ subTypes: [...current, "ivf_cycle_own_eggs_own_carry"] });
      }
      return;
    }
    if (leafId === "egg_donor") {
      if (eggDonorOn) {
        const next = current.filter(s => s !== "egg_donor_fresh" && s !== "egg_donor_frozen");
        onPatch({ subTypes: next });
      } else {
        onPatch({ subTypes: [...current, "egg_donor_fresh"] });
      }
      return;
    }
    const has = current.includes(leafId);
    const next = has ? current.filter(s => s !== leafId) : [...current, leafId];
    onPatch({ subTypes: next });
  };

  const setIvfSubtype = (newSub: string) => {
    const nonIvf = current.filter(s => !s.startsWith("ivf_") && !s.startsWith("embryo_") && !s.startsWith("fet_") && !s.startsWith("shipping_") && !s.startsWith("egg_freezing_"));
    // shipping_eggs_sperm means parent ships own gametes - no donor applies.
    // Drop any stale egg_donor_fresh/frozen so saved data matches the UI.
    const cleaned = newSub.startsWith("shipping_eggs_sperm")
      ? nonIvf.filter(s => s !== "egg_donor_fresh" && s !== "egg_donor_frozen")
      : nonIvf;
    onPatch({ subTypes: [...cleaned, newSub] });
  };

  const setEggDonorSubtype = (newSub: string) => {
    const others = current.filter(s => s !== "egg_donor_fresh" && s !== "egg_donor_frozen");
    onPatch({ subTypes: [...others, newSub] });
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

      {/* Slots 1 + 2 + 2b are wrapped together in a single flex-nowrap
          group so the Coverage pills and the corresponding sub-coverage
          popovers (IVF program type, Egg-donor Fresh/Frozen) never get
          separated when the outer flex-wrap kicks in - they describe the
          SAME classification choice and reading "IVF" on one line with
          "Own eggs, surrogate carries" stranded on another reads as two
          unrelated controls. The Fixed-Cost toggle (slot 3) stays a
          separate flex item, free to wrap independently when space is
          tight. */}
      <div className="flex items-center gap-2 flex-shrink-0 flex-nowrap">
        {/* Slot 1: Coverage (multi-select pills). Natural width with
            flex-shrink-0 so the chip set doesn't compress on narrow
            viewports. The same provider has the same visibleLeaves
            on every row so widths match naturally across rows. */}
        <div className="flex items-center flex-shrink-0">
          {visibleLeaves.length > 0 && (
            <div className="inline-flex gap-1 p-1 bg-background border-2 border-accent/40 rounded-[var(--radius)] shadow-sm items-center">
              {visibleLeaves.map(leaf => {
                const selected =
                  leaf.id === "ivf" ? ivfOn :
                  leaf.id === "egg_donor" ? eggDonorOn :
                  current.includes(leaf.id);
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

        {/* Slot 2b: Egg-donor subtype picker. Surfaces alongside the IVF
            subtype picker so a program covering both (e.g. donor-eggs IVF +
            standalone egg-donor service) can pick a Fresh/Frozen variant
            without polluting the coverage row with two flat leaves. Fixed
            trigger width keeps downstream slots column-aligned across rows. */}
        {eggDonorOn && !ivfSubtypeExcludesDonor && (
          <div className="flex items-center flex-shrink-0" onClick={(e) => e.stopPropagation()}>
            <EggDonorSubtypePopover
              currentSubType={currentEggDonorSubtype}
              onSelect={setEggDonorSubtype}
              triggerClassName="w-44 justify-between"
            />
          </div>
        )}
      </div>

      {/* Slot 3: Cost (Fixed-Cost / Not Fixed Costs segmented toggle).
          Reads pending overlay first, falls back to latestSheet. Sets
          stage into onPatch so the bottom Save bar flushes it. */}
      <div className="flex items-center flex-shrink-0">
        {latestSheet && (
          <div className="inline-flex gap-1 p-1 bg-background border-2 border-accent/40 rounded-[var(--radius)] shadow-sm" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className={cn(
                "px-2.5 py-1 text-xs rounded-[var(--radius)] transition-all font-medium whitespace-nowrap",
                effectiveIsFixedCost === true ? "bg-accent text-accent-foreground shadow-sm" : "text-foreground hover:bg-accent/10",
              )}
              onClick={() => onPatch({ isFixedCost: true })}
              data-testid={`top-mark-fixed-${program.id}`}
            >
              Fixed-Cost
            </button>
            <button
              type="button"
              className={cn(
                "px-2.5 py-1 text-xs rounded-[var(--radius)] transition-all font-medium whitespace-nowrap",
                effectiveIsFixedCost === false ? "bg-accent text-accent-foreground shadow-sm" : "text-foreground hover:bg-accent/10",
              )}
              onClick={() => onPatch({ isFixedCost: false })}
              data-testid={`top-mark-not-fixed-${program.id}`}
            >
              Not Fixed Costs
            </button>
          </div>
        )}
      </div>

    </>
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
  // controls (Fixed/Not Fixed toggle). Null when no master sheet exists
  // yet (newly created program).
  latestSheet?: {
    id: string;
    isFixedCost: boolean | null;
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
  programShowsAnySubtype?: boolean;
  programShowsIvfSubtype?: boolean;
  programCurrentSubType?: string | null;
  programTabFilter?: IvfTab;
  onSubTypeChange?: (subType: string, tab?: string) => void;
  allowedServiceTags?: string[];
  programServiceTypes?: string[];
  onServiceTypesChange?: (next: string[]) => void;
  programCurrentSubTypes?: string[];
  onSubTypesChange?: (next: string[]) => void;
  // When set, line-item edits are bubbled up to the parent (ProgramsView)
  // instead of auto-saved inline. The parent's bottom Save bar owns the
  // flush. Disables the debounced saveDraftMutation and hides every
  // internal "Save / Override / Submit for Approval" button.
  onItemsChange?: (items: CostItemData[]) => void;
  // Pending overlay from the parent: if present, used as the source of
  // truth for editItems on mount so unsaved edits survive a re-render.
  pendingItems?: CostItemData[];
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
  onItemsChange,
  pendingItems,
}: SingleCostsTabProps) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingFileRef = useRef<File | null>(null);
  const [editItems, setEditItems] = useState<CostItemData[]>(pendingItems ?? []);
  // Line items are always editable now. The Override gate (admin only) is
  // gone - any field change flows into the parent's pending bag via
  // onItemsChange, and the bottom Save bar flushes everything.
  const [isEditing, setIsEditing] = useState(true);
  // True when the parent owns the save flow. Suppresses internal
  // auto-save, internal Save/Cancel/Submit bars, and Override gates.
  const parentOwnsSave = !!onItemsChange;
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
        // Data load (AI parse result), not a user edit - skip the
        // bubble so the bottom Save bar doesn't pop up on its own.
        itemsBubbleSkipRef.current = true;
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
            // Data load (poll picked up the freshly-parsed sheet), not
            // a user edit - skip the bubble so the bottom Save bar
            // doesn't appear automatically when parsing finishes.
            itemsBubbleSkipRef.current = true;
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
    // Parent (ProgramsView) owns the save flow now. We bubble item
    // changes up via onItemsChange below; the bottom Save bar flushes
    // them. Skip the internal debounced auto-save entirely.
    if (parentOwnsSave) return;
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
  }, [parentOwnsSave, isEditing, isAdminView, isDirty]);

  // Bubble editItems up to the parent so the bottom Save bar can flush
  // them. Skips the first mount (initial state already came from
  // pendingItems) and bails when the parent isn't managing saves.
  const itemsBubbleSkipRef = useRef(true);
  useEffect(() => {
    if (!parentOwnsSave || !onItemsChange) return;
    if (itemsBubbleSkipRef.current) {
      itemsBubbleSkipRef.current = false;
      return;
    }
    onItemsChange(editItems);
  }, [editItems, parentOwnsSave, onItemsChange]);

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

  // Update the classification (tab + subType + isFixedCost). The clinic
  // can change any of these freely; the save action is the only persistence
  // step - there is no separate confirm gate.
  const classificationMutation = useMutation({
    mutationFn: async (payload: { sheetId: string; tab?: string; subType?: string; isFixedCost?: boolean }) => {
      return apiRequest("PATCH", `/api/costs/sheet/${payload.sheetId}/classification`, {
        tab: payload.tab,
        subType: payload.subType,
        isFixedCost: payload.isFixedCost,
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

    // Skip the next bubble-up. setEditItems below is a data-LOAD, not a
    // user edit - if we don't gate it, just opening the row dirties the
    // program and the bottom Save bar appears for nothing. The bubble
    // effect (around line 1404) clears the ref after one render.
    itemsBubbleSkipRef.current = true;
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
    } else {
      // No data load actually happened - release the skip so the next
      // genuine user edit still bubbles.
      itemsBubbleSkipRef.current = false;
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
        displaySheet.isFixedCost === null && (
        <Alert variant="default" className="border-[hsl(var(--brand-warning))]/40 bg-[hsl(var(--brand-warning))]/5">
          <AlertTriangle className="h-4 w-4 text-[hsl(var(--brand-warning))]" />
          <AlertDescription className="text-foreground space-y-3">
            <div>
              <strong>AI couldn't extract any data from this file.</strong>{" "}
              The file is attached but no items, classification, or program type were detected. Add items manually, or re-upload the file in a clearer format (PDF with selectable text, XLS/XLSX preferred over scanned images).
            </div>
            {/* When the parent owns saving (program-row flow) the line
                items are already editable inline below - no need for an
                Override entry point. Old standalone view kept the
                button for legacy callers (parent-quotes etc.). */}
            {isAdminView && !parentOwnsSave && (
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

          {isAdminView && !effectiveEditing && !parentOwnsSave && (
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
          {isAdminView && !parentOwnsSave && (
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

      {/* Internal admin Save/Cancel bar - hidden when the parent
          (ProgramsView) owns the save flow. The bottom-of-tab Save bar
          flushes everything in one shot instead. */}
      {!parentOwnsSave && isAdminView && effectiveEditing && editItems.length > 0 && (
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

      {/* Provider's internal Submit for Approval bar - same gating: only
          when the parent isn't already handling the save flow. */}
      {!parentOwnsSave && !isAdminView && editItems.length > 0 && (isDirty || !displaySheet || displaySheet.status === "DRAFT" || displaySheet.status === "REJECTED") && (
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
          <Button
            onClick={() => {
              if (autoSavePendingTimerRef.current) { clearTimeout(autoSavePendingTimerRef.current); autoSavePendingTimerRef.current = null; }
              submitMutation.mutate({
                items: editItems,
                sheetId: displaySheet?.status === "APPROVED" ? undefined : displaySheet?.id,
              });
            }}
            disabled={submitMutation.isPending || missingMandatory.length > 0 || isParsing}
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
  const pendingAutoEditProgramIdRef = useRef<string | null>(null);
  const [isAddingProgram, setIsAddingProgram] = useState(false);
  // Inputs for the legacy "Add Program" form (still uses immediate create).
  const [formName, setFormName] = useState("");
  const [formCountry, setFormCountry] = useState("");

  // Unified pending-edit bag. Keys = programId, values = the fields the
  // admin has changed since the last save. Empty bag = clean state, no
  // Save bar visible. Save handler iterates this map and POSTs each
  // entry's diff to the existing PATCH endpoints.
  const [pendingByProgram, setPendingByProgram] = useState<Record<string, ProgramPending>>({});
  const [isSaving, setIsSaving] = useState(false);
  const hasPending = Object.keys(pendingByProgram).length > 0;

  const updateProgramPending = useCallback((id: string, patch: Partial<ProgramPending>) => {
    setPendingByProgram(prev => {
      const next = { ...prev[id], ...patch };
      // Clean up the entry entirely if every staged field matches the
      // server value again (admin toggled and untoggled). Keeps the
      // "X unsaved" badge honest.
      return { ...prev, [id]: next };
    });
  }, []);

  const discardProgramPending = useCallback((id: string) => {
    setPendingByProgram(prev => {
      const { [id]: _, ...rest } = prev;
      return rest;
    });
  }, []);

  const discardAllPending = useCallback(() => {
    setPendingByProgram({});
  }, []);

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

  // After an upload, expand the new program's row as soon as AI parsing
  // finishes so the admin sees the classified name + country populated
  // and can review/tweak inline. Name + country are now always-editable
  // inputs, so there's no per-row edit-mode flip to do.
  useEffect(() => {
    const targetId = pendingAutoEditProgramIdRef.current;
    if (!targetId) return;
    const program = (programsQuery.data || []).find((p) => p.id === targetId);
    if (!program) return;
    if (program.latestSheetStatus && program.latestSheetStatus !== "PARSING") {
      pendingAutoEditProgramIdRef.current = null;
      setExpandedProgramId(program.id);
    }
  }, [programsQuery.data]);

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

  // Single Save handler that flushes every pending program's diff to the
  // appropriate endpoint. Runs sequentially per-program (program PATCH then
  // sheet classification PATCH) so a failure on one row's program update
  // doesn't fire its sheet update with stale assumptions. Errors are
  // collected and surfaced at the end - one toast per failure.
  const saveAll = useCallback(async () => {
    if (!hasPending || isSaving) return;
    setIsSaving(true);
    const failures: string[] = [];
    try {
      for (const [programId, patch] of Object.entries(pendingByProgram)) {
        const program = (programsQuery.data || []).find(p => p.id === programId);
        if (!program) continue;
        // 1) Program-level fields (name, country, subTypes). One PATCH
        // bundles everything the endpoint accepts.
        const programPayload: Record<string, unknown> = {};
        if (patch.name !== undefined) programPayload.name = patch.name.trim();
        if (patch.country !== undefined) programPayload.country = patch.country.trim();
        if (patch.subTypes !== undefined) programPayload.subTypes = patch.subTypes;
        if (Object.keys(programPayload).length > 0) {
          try {
            await apiRequest("PATCH", `/api/costs/programs/${programId}`, programPayload);
          } catch (err: any) {
            failures.push(`${program.name}: ${err.message || "program update failed"}`);
            continue;
          }
        }
        // 2) Sheet-level classification (isFixedCost) lives on the
        // program's latest master sheet. Only emit if the admin
        // actually toggled it AND the program has a sheet to write to.
        if (patch.isFixedCost !== undefined && program.latestSheet) {
          try {
            await apiRequest(
              "PATCH",
              `/api/costs/sheet/${program.latestSheet.id}/classification`,
              { isFixedCost: patch.isFixedCost },
            );
          } catch (err: any) {
            failures.push(`${program.name}: ${err.message || "classification update failed"}`);
          }
        }
        // 3) Line-item edits flush. For admins we route to /submit
        // instead of /save-draft - /submit auto-approves the sheet when
        // the caller is GOSTORK_ADMIN (CostsController.submitSheet line
        // 348-350), so the row exits "(draft)" in the same Save click.
        // Non-admin providers stay on /save-draft (sheet remains DRAFT
        // until an admin approves it through the review queue).
        if (patch.items !== undefined) {
          const existingSheetId =
            program.latestSheet && program.latestSheet.status !== "APPROVED"
              ? program.latestSheet.id
              : undefined;
          try {
            await apiRequest(
              "POST",
              isAdminView ? "/api/costs/submit" : "/api/costs/save-draft",
              {
                providerId,
                items: patch.items,
                sheetId: existingSheetId,
                providerTypeId: program.providerTypeId,
                programId,
              },
            );
          } catch (err: any) {
            failures.push(`${program.name}: ${err.message || "items save failed"}`);
          }
        } else if (isAdminView && program.latestSheet && program.latestSheet.status !== "APPROVED") {
          // Admin edited only program-level fields (name / country /
          // subTypes / Fixed-Cost) and didn't touch line items. The
          // sheet would otherwise stay on its existing DRAFT/PENDING
          // status and the row would keep showing "(draft)". Approve
          // the current sheet so the Save click feels atomic.
          try {
            await apiRequest("POST", `/api/costs/approve/${program.latestSheet.id}`);
          } catch (err: any) {
            failures.push(`${program.name}: ${err.message || "approve failed"}`);
          }
        }
      }
    } finally {
      setIsSaving(false);
    }
    // Always refresh - even partial successes need a re-fetch.
    invalidatePrograms();
    queryClient.invalidateQueries({ queryKey: ["/api/costs/provider", providerId], exact: false });
    if (failures.length === 0) {
      setPendingByProgram({});
      toast({ title: "Changes saved", variant: "success" });
    } else {
      // Keep failed rows in pending so admin can retry. Successful ones
      // get cleared, identified by absence from `failures`.
      const failedIds = new Set(
        failures
          .map(f => f.split(":")[0])
          .map(name => (programsQuery.data || []).find(p => p.name === name)?.id)
          .filter(Boolean) as string[],
      );
      setPendingByProgram(prev =>
        Object.fromEntries(Object.entries(prev).filter(([id]) => failedIds.has(id))),
      );
      toast({
        title: failures.length === 1 ? "Save failed" : `${failures.length} saves failed`,
        description: failures.join("\n"),
        variant: "destructive",
      });
    }
  }, [hasPending, isSaving, pendingByProgram, programsQuery.data, providerId, toast]);

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
      // Arm the auto-edit effect - the row will flip into edit mode the
      // moment its latestSheetStatus transitions away from PARSING.
      pendingAutoEditProgramIdRef.current = result.programId;
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

  function startAdd() {
    setIsAddingProgram(true);
    setFormName("");
    setFormCountry("");
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
        const programPending = pendingByProgram[program.id];
        // Effective field values = pending overlay (if any) on top of
        // the server values. Inputs read these so the admin sees their
        // own keystrokes while the row stays "dirty" until Save fires.
        const effectiveName = programPending?.name ?? program.name;
        const effectiveCountry = programPending?.country ?? program.country;
        const onProgramPatch = (patch: Partial<ProgramPending>) =>
          updateProgramPending(program.id, patch);

        const countryBadge = (
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
        );
        const pendingBadge = isAdminView && program.latestSheetStatus === "PENDING" ? (
          <Badge className="text-xs bg-[hsl(var(--brand-warning))]/15 text-[hsl(var(--brand-warning))] border-[hsl(var(--brand-warning))]/40 border flex-shrink-0">
            Pending Review
          </Badge>
        ) : null;
        const chevronIcon = (
          <div className="h-7 w-7 flex items-center justify-center text-muted-foreground flex-shrink-0" aria-hidden>
            {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </div>
        );

        // Trash only - Pencil + green-check Save are gone now that name
        // and country live in always-editable inputs flushed by the
        // bottom Save bar.
        const renderActions = (_testidSuffix: string) =>
          (isAdminView || canManagePrograms) ? (
            <AlertDialog>
              <AlertDialogTrigger asChild onClick={(e) => e.stopPropagation()}>
                <Button size="sm" variant="ghost" className="h-7 w-7 p-0 flex-shrink-0">
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
                      discardProgramPending(program.id);
                      deleteMutation.mutate(program.id);
                    }}
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null;

        const renderClassification = () => (
          <ProgramClassificationControls
            program={program}
            pending={programPending}
            onPatch={onProgramPatch}
            allowedServiceTags={allowedServiceTags}
          />
        );

        return (
          <div key={program.id} className="border rounded-[var(--container-radius)] overflow-hidden">
            <div
              className="px-4 py-3 bg-muted/20 transition-colors cursor-pointer hover:bg-muted/40"
              onClick={() => setExpandedProgramId(isExpanded ? null : program.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setExpandedProgramId(isExpanded ? null : program.id);
                }
              }}
            >
              {/* Desktop layout: prefers a single horizontal row, but the
                  inner wrapper falls back to flex-wrap so wide
                  configurations (e.g. Egg Donor + IVF where both subtype
                  popovers are visible alongside the Fixed-Cost toggle)
                  drop the classification group onto a second line. The
                  name+country and classification slots are each grouped
                  into their own flex item so that, when wrapping kicks
                  in, name+country stays on row 1 and ALL classification
                  controls move together to row 2 (rather than only the
                  trailing few slipping down piecemeal). Mirrors the
                  mobile multi-row treatment without forcing it on
                  narrower configurations that still fit on one line. */}
              <div className="hidden sm:flex items-center gap-3">
                <div
                  className="flex-1 flex items-center gap-2 flex-wrap min-w-0"
                >
                  {/* Group A: name + country. Single flex item so the
                      pair stays together on row 1 even when wrapping.
                      stopPropagation is on the controls themselves, NOT
                      this wrapper - otherwise the empty horizontal gap
                      between controls swallows the row-toggle click and
                      makes the chevron feel broken in that band. */}
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {(isAdminView || canManagePrograms) ? (
                      <>
                        {/* Name + country are always inline-editable now.
                            Edits stage into pendingByProgram and flush via
                            the bottom Save bar. Input sizes to content so
                            long titles aren't clipped. */}
                        <Input
                          value={effectiveName}
                          onChange={(e) => onProgramPatch({ name: e.target.value })}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                          placeholder="Program name"
                          // Fixed width with the input scrolling internally for
                          // long values - the previous `size={length}` + w-auto
                          // grew the box one character at a time and pushed the
                          // country chip to the right with every keystroke.
                          className="h-7 text-sm flex-shrink-0 w-80"
                          data-testid={`input-program-name-${program.id}`}
                        />
                        <div
                          className="w-44 flex-shrink-0"
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          <SingleCountryAutocompleteInput
                            value={effectiveCountry}
                            onChange={(next) => onProgramPatch({ country: next })}
                            placeholder="Country"
                            data-testid={`input-program-country-${program.id}`}
                            className="h-7"
                          />
                        </div>
                      </>
                    ) : (
                      <>
                        <span className="font-medium text-sm whitespace-nowrap flex-shrink-0" title={program.name}>{program.name}</span>
                        {countryBadge}
                      </>
                    )}
                  </div>
                  {/* Group B: all classification slots wrapped in a single
                      flex item so they wrap to row 2 together when they
                      can't fit next to group A. Internal flex-wrap so
                      the group can still split further on an extremely
                      narrow viewport. */}
                  <div className="flex items-center gap-2 flex-wrap">
                    {renderClassification()}
                  </div>
                </div>

                <div className="whitespace-nowrap text-right flex-shrink-0">
                  <ProgramTotalBadge program={program} />
                </div>
                {pendingBadge}
                {renderActions("")}
                {chevronIcon}
              </div>

              {/* Mobile layout: 3 logical rows.
                    Row 1: name (flex-grows + truncates) + chevron
                    Row 2: country + total + admin actions (right)
                    Row 3: classification controls, horizontally scrollable
                  Each row is its own flex container so the wide draft
                  total can't push the name off-screen, and the
                  classification toggles always have their own width
                  to spread into without competing for row 1 space. */}
              <div className="sm:hidden flex flex-col gap-2">
                {/* Row 1 - stopPropagation lives on the Input itself so
                    tapping the gap between the name and the chevron
                    still toggles the row open. */}
                <div className="flex items-center gap-2 min-w-0">
                  {(isAdminView || canManagePrograms) ? (
                    <Input
                      value={effectiveName}
                      onChange={(e) => onProgramPatch({ name: e.target.value })}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                      placeholder="Program name"
                      className="h-7 text-sm flex-1 min-w-0"
                      data-testid={`input-program-name-${program.id}-mobile`}
                    />
                  ) : (
                    <span className="font-medium text-sm truncate flex-1 min-w-0" title={program.name}>{program.name}</span>
                  )}
                  {chevronIcon}
                </div>

                {/* Row 2 - same treatment: stopPropagation on the
                    country autocomplete wrapper only, so the empty
                    space alongside the total / action icons still
                    toggles the row open. */}
                <div className="flex items-center gap-2 flex-wrap">
                  {(isAdminView || canManagePrograms) ? (
                    <div
                      className="flex-1 min-w-[140px]"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <SingleCountryAutocompleteInput
                        value={effectiveCountry}
                        onChange={(next) => onProgramPatch({ country: next })}
                        placeholder="Country"
                        data-testid={`input-program-country-${program.id}-mobile`}
                        className="h-7"
                      />
                    </div>
                  ) : (
                    countryBadge
                  )}
                  <div className="whitespace-nowrap text-right flex-shrink-0">
                    <ProgramTotalBadge program={program} />
                  </div>
                  {pendingBadge}
                  <div className="ml-auto flex items-center gap-0.5 flex-shrink-0">
                    {renderActions("-mobile")}
                  </div>
                </div>

                {/* Row 3: classification - full-bleed horizontal scroll
                    so the IVF subtype popover trigger + Fixed-Cost
                    toggle stay reachable on the narrowest phones. */}
                <div
                  className="-mx-4 px-4 overflow-x-auto"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center gap-2 flex-nowrap py-0.5 w-fit">
                    {renderClassification()}
                  </div>
                </div>
              </div>
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
                    allowedServiceTags={allowedServiceTags}
                    programServiceTypes={program.serviceTypes ?? []}
                    programCurrentSubTypes={program.subTypes ?? []}
                    pendingItems={programPending?.items}
                    onItemsChange={(next) => updateProgramPending(program.id, { items: next })}
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

      {/* Sticky Save bar - the single flush point for every program-row
          edit (name, country, coverage pills, IVF/egg-donor subtype,
          Fixed-Cost). Visible only when at least one row is dirty.
          sticky bottom-0 keeps it on screen as the admin scrolls the
          program list; the parent tab content provides bottom padding
          (pb-28 on the SingleCostsTab containers) so this bar doesn't
          cover the last row's actions. */}
      {hasPending && (
        <div
          className="sticky bottom-0 z-20 -mx-4 px-4 py-3 bg-background/95 backdrop-blur border-t shadow-[0_-4px_12px_-4px_rgba(0,0,0,0.06)] flex items-center justify-between gap-3"
          data-testid="costs-save-bar"
        >
          <span className="text-sm text-foreground">
            <span className="font-medium">{Object.keys(pendingByProgram).length}</span>{" "}
            unsaved {Object.keys(pendingByProgram).length === 1 ? "program" : "programs"}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={discardAllPending}
              disabled={isSaving}
              data-testid="btn-costs-discard"
            >
              Discard
            </Button>
            <Button
              size="sm"
              onClick={saveAll}
              disabled={isSaving}
              data-testid="btn-costs-save"
            >
              {isSaving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Save
            </Button>
          </div>
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
