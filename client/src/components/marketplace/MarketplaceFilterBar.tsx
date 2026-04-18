import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer";
import { Search, ArrowUpDown, X, Heart, ChevronDown, Plus, MapPin, Award } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { useAppSelector, useAppDispatch } from "@/store";
import { setMarketplaceSearchQuery, setMarketplaceSortBy, setFilter, clearFilters, setShowFavoritesOnly, setShowSkippedOnly, setShowExperiencedOnly } from "@/store/uiSlice";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";

type ProviderType = "egg-donor" | "surrogate" | "sperm-donor" | "ivf-clinic";

interface MarketplaceFilterBarProps {
  providerType: ProviderType;
  ivfLocation?: string;
  onIvfLocationChange?: (value: string) => void;
  ivfSearch?: string;
  onIvfSearchChange?: (value: string) => void;
  ivfEggSource?: string;
  onIvfEggSourceChange?: (value: string) => void;
  ivfAgeGroup?: string;
  onIvfAgeGroupChange?: (value: string) => void;
  ivfIsNewPatient?: string;
  onIvfIsNewPatientChange?: (value: string) => void;
  ivfSortBy?: string;
  onIvfSortByChange?: (value: string) => void;
  hasIvfLocation?: boolean;
  location?: string;
  onLocationChange?: (value: string) => void;
  hasLocation?: boolean;
  hideFavorites?: boolean;
  inlineMode?: boolean;
  overlayStyle?: boolean;
  noResults?: boolean;
}

const SORT_OPTIONS = [
  { value: "newest", label: "Newest First" },
  { value: "oldest", label: "Oldest First" },
  { value: "age_asc", label: "Age: Low to High" },
  { value: "age_desc", label: "Age: High to Low" },
  { value: "height_asc", label: "Height: Short to Tall" },
  { value: "height_desc", label: "Height: Tall to Short" },
  { value: "weight_asc", label: "Weight: Low to High" },
  { value: "weight_desc", label: "Weight: High to Low" },
  { value: "cost_asc", label: "Cost: Low to High" },
  { value: "cost_desc", label: "Cost: High to Low" },
];

const IVF_SORT_OPTIONS = [
  { value: "highest_success", label: "Highest success rate" },
  { value: "lowest_success", label: "Lowest success rate" },
  { value: "highest_cycles", label: "Highest cycles reported" },
  { value: "lowest_cycles", label: "Lowest cycles reported" },
  { value: "alphabetical", label: "Alphabetical (A-Z)" },
  { value: "closest_distance", label: "Closest distance", needsLocation: true },
  { value: "best_success_range", label: "Best success within range", needsLocation: true },
  { value: "best_balance", label: "Best balance: success + distance", needsLocation: true },
];

const EGG_SOURCE_OPTIONS = [
  { value: "own_eggs", label: "Own eggs" },
  { value: "donor", label: "Donor eggs" },
  { value: "donated_embryos", label: "Donated embryos" },
];

const AGE_GROUP_OPTIONS = [
  { value: "under_35", label: "Under 35" },
  { value: "35_37", label: "35-37" },
  { value: "38_40", label: "38-40" },
  { value: "over_40", label: "Over 40" },
];

const IVF_HISTORY_OPTIONS = [
  { value: "true", label: "New to IVF" },
  { value: "false", label: "Had prior cycles" },
];

const RANGE_FILTER_KEYS = new Set(["age", "bmi", "height", "maxCost", "baseCompensation", "donorCompensation", "maxLiveBirths", "maxCSections", "maxMiscarriages", "maxAbortions", "lastDeliveryYear"]);

function formatHeightInches(inches: number): string {
  const ft = Math.floor(inches / 12);
  const remaining = inches % 12;
  return `${ft}'${remaining}"`;
}

const RACE_OPTIONS = ["Asian", "Black", "Hispanic", "White", "Mixed", "Other"];
const EYE_COLOR_OPTIONS = ["Brown", "Blue", "Green", "Hazel", "Gray", "Amber"];
const HAIR_COLOR_OPTIONS = ["Black", "Brown", "Blonde", "Red", "Auburn", "Gray"];
const EGG_TYPE_OPTIONS = ["Fresh", "Frozen"];
const DONATION_TYPE_OPTIONS = ["Anonymous", "Semi-Open", "Open ID", "Known"];
const EDUCATION_OPTIONS = ["High School", "Some College", "Associate", "Bachelor", "Master", "Doctorate"];
const IVY_LEAGUE_SCHOOLS = [
  "Harvard", "Yale", "Princeton", "Columbia",
  "University of Pennsylvania", "Brown", "Dartmouth", "Cornell",
];
const ETHNICITY_OPTIONS = [
  "Brazilian", "Chinese", "Colombian", "Cuban", "English",
  "Ethiopian", "Filipino", "French", "German", "Haitian",
  "Indian", "Irish", "Israeli", "Italian", "Jamaican",
  "Japanese", "Korean", "Mexican", "Middle Eastern", "Nigerian",
  "Persian", "Polish", "Puerto Rican", "Russian", "Turkish",
  "Vietnamese",
  "Other",
];
const RELATIONSHIP_OPTIONS = ["Single", "Married", "Partnered", "Divorced"];

const FILTER_DISPLAY_NAMES: Record<string, string> = {
  age: "Age",
  bmi: "BMI",
  eyeColor: "Eye Color",
  hairColor: "Hair Color",
  race: "Race",
  ethnicity: "Ethnicity",
  education: "Education",
  religion: "Religion",
  relationshipStatus: "Relationship",
  donorCompensation: "Compensation",
  maxCost: "Total Cost",
  baseCompensation: "Base Comp.",
  agreesToTwins: "Twins",
  agreesToSelectiveReduction: "Selective Reduction",
  openToSameSexCouple: "Same Sex Couple",
  agreesToInternationalParents: "Int'l Parents",
  covidVaccinated: "COVID Vax",
  maxLiveBirths: "Live Births",
  maxCSections: "Max C-Sections",
  maxMiscarriages: "Max Miscarriages",
  maxAbortions: "Max Abortions",
  height: "Height",
  lastDeliveryYear: "Last Delivery",
  eggType: "Egg Type",
  location: "Location",
};

function formatFilterPills(filters: Record<string, string[]>): { key: string; label: string }[] {
  const pills: { key: string; label: string }[] = [];
  const SINGLE_VALUE_KEYS = new Set(["maxCSections", "maxMiscarriages", "maxAbortions", "lastDeliveryYear"]);
  for (const [key, vals] of Object.entries(filters)) {
    if (!vals || vals.length === 0) continue;
    const displayName = FILTER_DISPLAY_NAMES[key] || key;
    if (SINGLE_VALUE_KEYS.has(key)) {
      if (key === "lastDeliveryYear") {
        pills.push({ key, label: `${displayName}: ${vals[0]}+` });
      } else {
        pills.push({ key, label: `${displayName}: ≤ ${vals[0]}` });
      }
    } else if (RANGE_FILTER_KEYS.has(key)) {
      const [min, max] = vals;
      if (key === "height") {
        pills.push({ key, label: `${displayName}: ${formatHeightInches(Number(min))}–${formatHeightInches(Number(max))}` });
      } else {
        const prefix = key === "maxCost" || key === "baseCompensation" || key === "donorCompensation" ? "$" : "";
        pills.push({ key, label: `${displayName}: ${prefix}${min}–${prefix}${max}` });
      }
    } else if (vals.length === 1 && vals[0] === "true") {
      pills.push({ key, label: displayName });
    } else {
      vals.filter(Boolean).forEach((v) => pills.push({ key, label: `${displayName}: ${v}` }));
    }
  }
  return pills;
}

function MultiSelectBubbles({ options, selected, onToggle, testIdPrefix }: {
  options: string[];
  selected: string[];
  onToggle: (val: string) => void;
  testIdPrefix: string;
}) {
  return (
    <div className="flex flex-wrap gap-2.5">
      {options.map((opt) => (
        <Badge
          key={opt}
          variant={selected.includes(opt) ? "default" : "outline"}
          className="cursor-pointer font-ui px-4 py-2 rounded-full"
          style={{ fontSize: 'var(--badge-text-size, 13px)' }}
          onClick={() => onToggle(opt)}
          data-testid={`${testIdPrefix}-${opt.toLowerCase().replace(/\s+/g, "-")}`}
        >
          {opt}
        </Badge>
      ))}
    </div>
  );
}

function useCustomFilterTags() {
  const { user } = useAuth();
  const isLoggedIn = !!user;
  const { data } = useQuery<{ tags: Record<string, string[]> }>({
    queryKey: ["/api/parent-account/custom-filter-tags"],
    enabled: isLoggedIn,
  });
  const addMutation = useMutation({
    mutationFn: async ({ filterKey, tag }: { filterKey: string; tag: string }) => {
      const res = await apiRequest("POST", `/api/parent-account/custom-filter-tags/${filterKey}`, { tag });
      return await res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/parent-account/custom-filter-tags"] }),
  });
  const removeMutation = useMutation({
    mutationFn: async ({ filterKey, tag }: { filterKey: string; tag: string }) => {
      const res = await apiRequest("DELETE", `/api/parent-account/custom-filter-tags/${filterKey}/${encodeURIComponent(tag)}`);
      return await res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/parent-account/custom-filter-tags"] }),
  });
  return {
    allTags: data?.tags || {},
    addTag: (filterKey: string, tag: string) => addMutation.mutate({ filterKey, tag }),
    removeTag: (filterKey: string, tag: string) => removeMutation.mutate({ filterKey, tag }),
    isLoggedIn,
  };
}

function parseTagInput(input: string): string {
  const parts = input.split(/[+_,]/).map(p => p.trim()).filter(Boolean)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase());
  return parts.join(" + ");
}

function BubblesWithCustomTags({ options, customTags, selected, onToggle, onRemoveCustomTag, testIdPrefix }: {
  options: string[];
  customTags: string[];
  selected: string[];
  onToggle: (val: string) => void;
  onRemoveCustomTag: (tag: string) => void;
  testIdPrefix: string;
}) {
  return (
    <div className="flex flex-wrap gap-2.5">
      {options.map((opt) => (
        <Badge
          key={opt}
          variant={selected.includes(opt) ? "default" : "outline"}
          className="cursor-pointer font-ui px-4 py-2 rounded-full"
          style={{ fontSize: 'var(--badge-text-size, 13px)' }}
          onClick={() => onToggle(opt)}
          data-testid={`${testIdPrefix}-${opt.toLowerCase().replace(/\s+/g, "-")}`}
        >
          {opt}
        </Badge>
      ))}
      {customTags.map((tag) => (
        <Badge
          key={`custom-${tag}`}
          variant={selected.includes(tag) ? "default" : "outline"}
          className="cursor-pointer font-ui px-4 py-2 rounded-full gap-1 border-dashed"
          style={{ fontSize: 'var(--badge-text-size, 13px)' }}
          onClick={() => onToggle(tag)}
          data-testid={`${testIdPrefix}-custom-${tag.toLowerCase().replace(/\s+/g, "-")}`}
        >
          {tag}
          <X
            className="w-3 h-3 ml-0.5 opacity-60 hover:opacity-100"
            onClick={(e) => { e.stopPropagation(); onRemoveCustomTag(tag); }}
          />
        </Badge>
      ))}
    </div>
  );
}

function TagInput({ onAdd, filterKey }: { onAdd: (tag: string) => void; filterKey: string }) {
  const [inputValue, setInputValue] = useState("");

  const handleSubmit = () => {
    const tag = parseTagInput(inputValue);
    if (tag) { onAdd(tag); setInputValue(""); }
  };

  return (
    <div className="flex items-center gap-2 mt-2">
      <Input
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && inputValue.trim()) { e.preventDefault(); handleSubmit(); } }}
        placeholder="Type to add custom option"
        className="h-auto py-1.5"
        style={{ fontSize: 'calc(var(--drawer-body-size, 16px) * 0.85)' }}
        data-testid={`input-custom-${filterKey}`}
      />
      <Button
        variant="outline"
        size="sm"
        className="h-auto py-1.5 shrink-0"
        style={{ fontSize: 'calc(var(--drawer-body-size, 16px) * 0.85)' }}
        disabled={!inputValue.trim()}
        onClick={handleSubmit}
        data-testid={`btn-add-custom-${filterKey}`}
      >
        <Plus className="w-3 h-3 mr-1" /> Add
      </Button>
    </div>
  );
}

function CustomTagPopover({ label, filterKey, options, activeFilters, dispatch, testIdPrefix }: {
  label: string;
  filterKey: string;
  options: string[];
  activeFilters: Record<string, string[]>;
  dispatch: any;
  testIdPrefix: string;
}) {
  const { allTags, addTag, removeTag } = useCustomFilterTags();
  const customTags = allTags[filterKey] || [];
  const selected = activeFilters[filterKey] || [];
  const isActive = selected.length > 0;

  const toggleFilter = (val: string) => {
    const current = activeFilters[filterKey] || [];
    const next = current.includes(val) ? current.filter((v) => v !== val) : [...current, val];
    dispatch(setFilter({ key: filterKey, values: next }));
  };

  const handleAddAndSelect = (tag: string) => {
    addTag(filterKey, tag);
    const current = activeFilters[filterKey] || [];
    if (!current.includes(tag)) {
      dispatch(setFilter({ key: filterKey, values: [...current, tag] }));
    }
  };

  const handleRemoveCustomTag = (tag: string) => {
    removeTag(filterKey, tag);
    const current = activeFilters[filterKey] || [];
    if (current.includes(tag)) {
      dispatch(setFilter({ key: filterKey, values: current.filter(v => v !== tag) }));
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant={isActive ? "default" : "outline"}
          size="sm"
          className="shrink-0 h-9 font-ui rounded-full gap-1 px-3.5"
          style={{ fontSize: 'var(--badge-text-size, 13px)' }}
          data-testid={`filter-btn-${filterKey}`}
        >
          {label}
          {isActive && <span className="font-normal opacity-80">({selected.length})</span>}
          <ChevronDown className="w-3.5 h-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-4" align="start">
        <div className="space-y-3">
          <div className="flex justify-between items-center">
            <span className="font-ui" style={{ fontSize: 'var(--filter-label-size, 18px)' }}>{label}</span>
            {isActive && (
              <Button variant="ghost" size="sm" className="h-auto py-0.5"
                style={{ fontSize: 'calc(var(--drawer-body-size, 16px) * 0.75)' }}
                onClick={() => dispatch(setFilter({ key: filterKey, values: [] }))}
                data-testid={`clear-${filterKey}`}
              >Clear</Button>
            )}
          </div>
          <BubblesWithCustomTags
            options={options}
            customTags={customTags}
            selected={selected}
            onToggle={toggleFilter}
            onRemoveCustomTag={handleRemoveCustomTag}
            testIdPrefix={testIdPrefix}
          />
          <TagInput onAdd={handleAddAndSelect} filterKey={filterKey} />
          <p className="font-body text-muted-foreground" style={{ fontSize: 'var(--drawer-body-size, 16px)', opacity: 0.7 }}>
            Use + to combine (e.g. "Israeli + Korean" matches donors with both)
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

const OVERLAY_BTN_STYLE: React.CSSProperties = {};

const TINDER_LABEL_BASE = "shrink-0 bg-transparent border-none shadow-none px-1.5 h-auto py-0 font-ui tracking-tight";
const TINDER_LABEL_STYLE: React.CSSProperties = { fontSize: 'var(--filter-label-size, 18px)' };

function tinderLabel(active: boolean, dark?: boolean) {
  if (dark) return `${TINDER_LABEL_BASE} ${active ? 'text-foreground' : 'text-foreground/60'}`;
  return `${TINDER_LABEL_BASE} ${active ? 'text-white' : 'text-white/80'}`;
}

const TINDER_LABEL_ACTIVE = `${TINDER_LABEL_BASE} text-white`;
const TINDER_LABEL_INACTIVE = `${TINDER_LABEL_BASE} text-white/80`;

function MobileCustomTagDrawer({ label, filterKey, options, activeFilters, dispatch, testIdPrefix, btnStyle, dark }: {
  label: string;
  filterKey: string;
  options: string[];
  activeFilters: Record<string, string[]>;
  dispatch: any;
  testIdPrefix: string;
  btnStyle?: React.CSSProperties;
  dark?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { allTags, addTag, removeTag } = useCustomFilterTags();
  const customTags = allTags[filterKey] || [];
  const selected = activeFilters[filterKey] || [];
  const isActive = selected.length > 0;

  const toggleFilter = (val: string) => {
    const current = activeFilters[filterKey] || [];
    const next = current.includes(val) ? current.filter((v) => v !== val) : [...current, val];
    dispatch(setFilter({ key: filterKey, values: next }));
  };

  const handleAddAndSelect = (tag: string) => {
    addTag(filterKey, tag);
    const current = activeFilters[filterKey] || [];
    if (!current.includes(tag)) {
      dispatch(setFilter({ key: filterKey, values: [...current, tag] }));
    }
  };

  const handleRemoveCustomTag = (tag: string) => {
    removeTag(filterKey, tag);
    const current = activeFilters[filterKey] || [];
    if (current.includes(tag)) {
      dispatch(setFilter({ key: filterKey, values: current.filter(v => v !== tag) }));
    }
  };

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <button
          className={tinderLabel(isActive, dark)}
          style={TINDER_LABEL_STYLE}
          data-testid={`filter-btn-${filterKey}`}
        >
          {label}
        </button>
      </DrawerTrigger>
      <DrawerContent data-testid={`drawer-${filterKey}`}>
        <DrawerHeader>
          <DrawerTitle className="flex items-center justify-between">
            {label}
            {isActive && (
              <Button variant="ghost" size="sm" className="h-auto py-0.5"
                style={{ fontSize: 'calc(var(--drawer-body-size, 16px) * 0.75)' }}
                onClick={() => dispatch(setFilter({ key: filterKey, values: [] }))}
                data-testid={`clear-${filterKey}`}
              >Clear</Button>
            )}
          </DrawerTitle>
        </DrawerHeader>
        <div className="px-6 pb-6 max-h-[70vh] overflow-y-auto space-y-4">
          <BubblesWithCustomTags
            options={options}
            customTags={customTags}
            selected={selected}
            onToggle={toggleFilter}
            onRemoveCustomTag={handleRemoveCustomTag}
            testIdPrefix={testIdPrefix}
          />
          <TagInput onAdd={handleAddAndSelect} filterKey={filterKey} />
          <p className="font-body text-muted-foreground" style={{ fontSize: 'var(--drawer-body-size, 16px)', opacity: 0.7 }}>
            Use + to combine (e.g. "Israeli + Korean" matches donors with both)
          </p>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function EducationPopover({ activeFilters, dispatch }: {
  activeFilters: Record<string, string[]>;
  dispatch: any;
}) {
  const { allTags, addTag, removeTag } = useCustomFilterTags();
  const customTags = allTags["education"] || [];
  const selected = activeFilters["education"] || [];
  const isActive = selected.length > 0;

  const toggleFilter = (val: string) => {
    const current = activeFilters["education"] || [];
    const next = current.includes(val) ? current.filter((v) => v !== val) : [...current, val];
    dispatch(setFilter({ key: "education", values: next }));
  };

  const handleAddAndSelect = (tag: string) => {
    addTag("education", tag);
    const current = activeFilters["education"] || [];
    if (!current.includes(tag)) {
      dispatch(setFilter({ key: "education", values: [...current, tag] }));
    }
  };

  const handleRemoveCustomTag = (tag: string) => {
    removeTag("education", tag);
    const current = activeFilters["education"] || [];
    if (current.includes(tag)) {
      dispatch(setFilter({ key: "education", values: current.filter(v => v !== tag) }));
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant={isActive ? "default" : "outline"}
          size="sm"
          className="shrink-0 h-9 font-ui rounded-full gap-1 px-3.5" style={{ fontSize: 'var(--badge-text-size, 13px)' }}
          data-testid="filter-btn-education"
        >
          Education
          {isActive && <span className="font-normal opacity-80">({selected.length})</span>}
          <ChevronDown className="w-3.5 h-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-4" align="start">
        <div className="space-y-3">
          <div className="flex justify-between items-center">
            <span className="font-ui" style={{ fontSize: 'var(--filter-label-size, 18px)' }}>Education</span>
            {isActive && (
              <Button variant="ghost" size="sm" className="h-auto py-0.5" style={{ fontSize: 'calc(var(--drawer-body-size, 16px) * 0.75)' }}
                onClick={() => dispatch(setFilter({ key: "education", values: [] }))}
                data-testid="clear-education"
              >Clear</Button>
            )}
          </div>
          <div>
            <span className="font-ui text-muted-foreground mb-1.5 block" style={{ fontSize: 'var(--badge-text-size, 13px)' }}>Level</span>
            <MultiSelectBubbles options={EDUCATION_OPTIONS} selected={selected} onToggle={toggleFilter} testIdPrefix="filter-edu" />
          </div>
          <div>
            <span className="font-ui text-muted-foreground mb-1.5 block" style={{ fontSize: 'var(--badge-text-size, 13px)' }}>Ivy League</span>
            <BubblesWithCustomTags
              options={IVY_LEAGUE_SCHOOLS}
              customTags={customTags}
              selected={selected}
              onToggle={toggleFilter}
              onRemoveCustomTag={handleRemoveCustomTag}
              testIdPrefix="filter-edu-ivy"
            />
          </div>
          <TagInput onAdd={handleAddAndSelect} filterKey="education" />
          <p className="font-body text-muted-foreground" style={{ fontSize: 'var(--drawer-body-size, 16px)', opacity: 0.7 }}>
            Type a school name and press Enter to add it
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function MobileEducationDrawer({ activeFilters, dispatch, btnStyle, dark }: {
  activeFilters: Record<string, string[]>;
  dispatch: any;
  btnStyle?: React.CSSProperties;
  dark?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { allTags, addTag, removeTag } = useCustomFilterTags();
  const customTags = allTags["education"] || [];
  const selected = activeFilters["education"] || [];
  const isActive = selected.length > 0;

  const toggleFilter = (val: string) => {
    const current = activeFilters["education"] || [];
    const next = current.includes(val) ? current.filter((v) => v !== val) : [...current, val];
    dispatch(setFilter({ key: "education", values: next }));
  };

  const handleAddAndSelect = (tag: string) => {
    addTag("education", tag);
    const current = activeFilters["education"] || [];
    if (!current.includes(tag)) {
      dispatch(setFilter({ key: "education", values: [...current, tag] }));
    }
  };

  const handleRemoveCustomTag = (tag: string) => {
    removeTag("education", tag);
    const current = activeFilters["education"] || [];
    if (current.includes(tag)) {
      dispatch(setFilter({ key: "education", values: current.filter(v => v !== tag) }));
    }
  };

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <button
          className={tinderLabel(isActive, dark)}
          data-testid="filter-btn-education"
        >
          Education
        </button>
      </DrawerTrigger>
      <DrawerContent data-testid="drawer-education">
        <DrawerHeader>
          <DrawerTitle className="flex items-center justify-between">
            Education
            {isActive && (
              <Button variant="ghost" size="sm" className="h-auto py-0.5" style={{ fontSize: 'calc(var(--drawer-body-size, 16px) * 0.75)' }}
                onClick={() => dispatch(setFilter({ key: "education", values: [] }))}
                data-testid="clear-education"
              >Clear</Button>
            )}
          </DrawerTitle>
        </DrawerHeader>
        <div className="px-6 pb-6 max-h-[70vh] overflow-y-auto space-y-4">
          <div>
            <span className="font-ui text-muted-foreground mb-1.5 block" style={{ fontSize: 'var(--badge-text-size, 13px)' }}>Level</span>
            <MultiSelectBubbles options={EDUCATION_OPTIONS} selected={selected} onToggle={toggleFilter} testIdPrefix="filter-edu" />
          </div>
          <div>
            <span className="font-ui text-muted-foreground mb-1.5 block" style={{ fontSize: 'var(--badge-text-size, 13px)' }}>Ivy League</span>
            <BubblesWithCustomTags
              options={IVY_LEAGUE_SCHOOLS}
              customTags={customTags}
              selected={selected}
              onToggle={toggleFilter}
              onRemoveCustomTag={handleRemoveCustomTag}
              testIdPrefix="filter-edu-ivy"
            />
          </div>
          <TagInput onAdd={handleAddAndSelect} filterKey="education" />
          <p className="font-body text-muted-foreground" style={{ fontSize: 'var(--drawer-body-size, 16px)', opacity: 0.7 }}>
            Type a school name and press Enter to add it
          </p>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function RangePopover({ label, filterKey, min, max, step, unit, activeFilters, dispatch, formatValue }: {
  label: string;
  filterKey: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  activeFilters: Record<string, string[]>;
  dispatch: any;
  formatValue?: (v: number) => string;
}) {
  const current = activeFilters[filterKey];
  const hasValue = current && current.length === 2;
  const currentMin = hasValue ? Number(current[0]) : min;
  const currentMax = hasValue ? Number(current[1]) : max;
  const isActive = hasValue && (currentMin !== min || currentMax !== max);

  const formatVal = formatValue || ((v: number) => unit === "$" ? `$${v.toLocaleString()}` : String(v));

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant={isActive ? "default" : "outline"}
          size="sm"
          className="shrink-0 h-9 font-ui rounded-full gap-1 px-3.5" style={{ fontSize: 'var(--badge-text-size, 13px)' }}
          data-testid={`filter-btn-${filterKey}`}
        >
          {label}
          {isActive && <span className="font-normal opacity-80">{formatVal(currentMin)}–{formatVal(currentMax)}</span>}
          <ChevronDown className="w-3.5 h-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-4" align="start">
        <div className="space-y-3">
          <div className="flex justify-between" style={{ fontSize: 'var(--drawer-body-size, 16px)' }}>
            <span className="font-ui">{label}</span>
            <span className="text-muted-foreground">{formatVal(currentMin)} – {formatVal(currentMax)}</span>
          </div>
          <Slider
            value={[currentMin, currentMax]}
            min={min}
            max={max}
            step={step}
            onValueChange={(vals) => {
              dispatch(setFilter({ key: filterKey, values: [String(vals[0]), String(vals[1])] }));
            }}
            data-testid={`slider-${filterKey}`}
          />
          {isActive && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              style={{ fontSize: 'calc(var(--drawer-body-size, 16px) * 0.85)' }}
              onClick={() => dispatch(setFilter({ key: filterKey, values: [] }))}
              data-testid={`clear-${filterKey}`}
            >
              Reset
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function MultiSelectPopover({ label, filterKey, options, activeFilters, dispatch, testIdPrefix }: {
  label: string;
  filterKey: string;
  options: string[];
  activeFilters: Record<string, string[]>;
  dispatch: any;
  testIdPrefix: string;
}) {
  const selected = activeFilters[filterKey] || [];
  const isActive = selected.length > 0;

  const toggleFilter = (val: string) => {
    const current = activeFilters[filterKey] || [];
    const next = current.includes(val) ? current.filter((v) => v !== val) : [...current, val];
    dispatch(setFilter({ key: filterKey, values: next }));
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant={isActive ? "default" : "outline"}
          size="sm"
          className="shrink-0 h-9 font-ui rounded-full gap-1 px-3.5" style={{ fontSize: 'var(--badge-text-size, 13px)' }}
          data-testid={`filter-btn-${filterKey}`}
        >
          {label}
          {isActive && <span className="font-normal opacity-80">({selected.length})</span>}
          <ChevronDown className="w-3.5 h-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-4" align="start">
        <div className="space-y-3">
          <div className="flex justify-between items-center">
            <span className="font-ui" style={{ fontSize: 'var(--filter-label-size, 18px)' }}>{label}</span>
            {isActive && (
              <Button
                variant="ghost"
                size="sm"
                className="h-auto py-0.5" style={{ fontSize: 'calc(var(--drawer-body-size, 16px) * 0.75)' }}
                onClick={() => dispatch(setFilter({ key: filterKey, values: [] }))}
                data-testid={`clear-${filterKey}`}
              >
                Clear
              </Button>
            )}
          </div>
          <MultiSelectBubbles
            options={options}
            selected={selected}
            onToggle={toggleFilter}
            testIdPrefix={testIdPrefix}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ToggleFilterButton({ label, filterKey, activeFilters, dispatch }: {
  label: string;
  filterKey: string;
  activeFilters: Record<string, string[]>;
  dispatch: any;
}) {
  const isActive = (activeFilters[filterKey] || [])[0] === "true";

  return (
    <Button
      variant={isActive ? "default" : "outline"}
      size="sm"
      className="shrink-0 h-9 font-ui rounded-full px-3.5" style={{ fontSize: 'var(--badge-text-size, 13px)' }}
      onClick={() => dispatch(setFilter({ key: filterKey, values: isActive ? [] : ["true"] }))}
      data-testid={`filter-btn-${filterKey}`}
    >
      {label}
    </Button>
  );
}

function ThumbAnchoredRange({ filterKey, min, max, step, unit, currentMin, currentMax, onValueChange, formatValue }: {
  filterKey: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  currentMin: number;
  currentMax: number;
  onValueChange: (vals: number[]) => void;
  formatValue?: (v: number) => string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [trackWidth, setTrackWidth] = useState(0);
  const formatVal = formatValue || ((v: number) => unit === "$" ? `$${v.toLocaleString()}` : String(v));

  const measureTrack = useCallback(() => {
    if (trackRef.current) {
      setTrackWidth(trackRef.current.offsetWidth);
    }
  }, []);

  useEffect(() => {
    measureTrack();
    window.addEventListener('resize', measureTrack);
    return () => window.removeEventListener('resize', measureTrack);
  }, [measureTrack]);

  const thumbSize = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--slider-thumb-size') || '24');
  const halfThumb = thumbSize / 2;
  const usableWidth = trackWidth - thumbSize;

  const minPct = (currentMin - min) / (max - min);
  const maxPct = (currentMax - min) / (max - min);
  const minLeft = halfThumb + minPct * usableWidth;
  const maxLeft = halfThumb + maxPct * usableWidth;

  const minTranslate = -(minPct * 100);
  const maxTranslate = -(maxPct * 100);

  return (
    <div ref={trackRef}>
      <div className="relative w-full" style={{ height: 'calc(var(--slider-value-size, 22px) * 1.5)' }}>
        <span
          className="font-body tabular-nums absolute"
          style={{
            fontSize: 'var(--slider-value-size, 22px)',
            left: `${minLeft}px`,
            transform: `translateX(${minTranslate}%)`,
            whiteSpace: 'nowrap',
            bottom: 0,
          }}
          data-testid={`slider-val-min-${filterKey}`}
        >
          {formatVal(currentMin)}
        </span>
        <span
          className="font-body tabular-nums absolute"
          style={{
            fontSize: 'var(--slider-value-size, 22px)',
            left: `${maxLeft}px`,
            transform: `translateX(${maxTranslate}%)`,
            whiteSpace: 'nowrap',
            bottom: 0,
          }}
          data-testid={`slider-val-max-${filterKey}`}
        >
          {formatVal(currentMax)}
        </span>
      </div>
      <div className="mt-2">
        <Slider
          value={[currentMin, currentMax]}
          min={min}
          max={max}
          step={step}
          onValueChange={onValueChange}
          data-testid={`slider-${filterKey}`}
        />
      </div>
    </div>
  );
}

function DrawerRangeSlider({ label, filterKey, min, max, step, unit, activeFilters, dispatch, formatValue }: {
  label: string;
  filterKey: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  activeFilters: Record<string, string[]>;
  dispatch: any;
  formatValue?: (v: number) => string;
}) {
  const current = activeFilters[filterKey];
  const hasValue = current && current.length === 2;
  const currentMin = hasValue ? Number(current[0]) : min;
  const currentMax = hasValue ? Number(current[1]) : max;
  const isActive = hasValue && (currentMin !== min || currentMax !== max);

  return (
    <div className="space-y-3">
      <span className="font-ui block" style={{ fontSize: 'var(--drawer-body-size, 16px)' }}>{label}</span>
      <ThumbAnchoredRange
        filterKey={filterKey}
        min={min}
        max={max}
        step={step}
        unit={unit}
        currentMin={currentMin}
        currentMax={currentMax}
        onValueChange={(vals) => {
          dispatch(setFilter({ key: filterKey, values: [String(vals[0]), String(vals[1])] }));
        }}
        formatValue={formatValue}
      />
      {isActive && (
        <Button
          variant="ghost"
          size="sm"
          className="w-full"
          style={{ fontSize: 'var(--drawer-body-size, 16px)' }}
          onClick={() => dispatch(setFilter({ key: filterKey, values: [] }))}
          data-testid={`clear-${filterKey}`}
        >
          Reset
        </Button>
      )}
    </div>
  );
}

function MobileRangeDrawer({ label, filterKey, min, max, step, unit, activeFilters, dispatch, btnStyle, dark, formatValue }: {
  label: string;
  filterKey: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  activeFilters: Record<string, string[]>;
  dispatch: any;
  btnStyle?: React.CSSProperties;
  dark?: boolean;
  formatValue?: (v: number) => string;
}) {
  const [open, setOpen] = useState(false);
  const current = activeFilters[filterKey];
  const hasValue = current && current.length === 2;
  const currentMin = hasValue ? Number(current[0]) : min;
  const currentMax = hasValue ? Number(current[1]) : max;
  const isActive = hasValue && (currentMin !== min || currentMax !== max);

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <button
          className={tinderLabel(isActive, dark)}
          style={TINDER_LABEL_STYLE}
          data-testid={`filter-btn-${filterKey}`}
        >
          {label}
        </button>
      </DrawerTrigger>
      <DrawerContent data-testid={`drawer-${filterKey}`}>
        <DrawerHeader>
          <DrawerTitle>{label}</DrawerTitle>
        </DrawerHeader>
        <div className="px-6 pb-6 space-y-3 max-h-[70vh] overflow-y-auto">
          <ThumbAnchoredRange
            filterKey={filterKey}
            min={min}
            max={max}
            step={step}
            unit={unit}
            currentMin={currentMin}
            currentMax={currentMax}
            onValueChange={(vals) => {
              dispatch(setFilter({ key: filterKey, values: [String(vals[0]), String(vals[1])] }));
            }}
            formatValue={formatValue}
          />
          {isActive && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              style={{ fontSize: 'var(--drawer-body-size, 16px)' }}
              onClick={() => dispatch(setFilter({ key: filterKey, values: [] }))}
              data-testid={`clear-${filterKey}`}
            >
              Reset
            </Button>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function MobileMultiSelectDrawer({ label, filterKey, options, activeFilters, dispatch, testIdPrefix, btnStyle, dark }: {
  label: string;
  filterKey: string;
  options: string[];
  activeFilters: Record<string, string[]>;
  dispatch: any;
  testIdPrefix: string;
  btnStyle?: React.CSSProperties;
  dark?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = activeFilters[filterKey] || [];
  const isActive = selected.length > 0;

  const toggleFilter = (val: string) => {
    const current = activeFilters[filterKey] || [];
    const next = current.includes(val) ? current.filter((v) => v !== val) : [...current, val];
    dispatch(setFilter({ key: filterKey, values: next }));
  };

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <button
          className={tinderLabel(isActive, dark)}
          style={TINDER_LABEL_STYLE}
          data-testid={`filter-btn-${filterKey}`}
        >
          {label}
        </button>
      </DrawerTrigger>
      <DrawerContent data-testid={`drawer-${filterKey}`}>
        <DrawerHeader>
          <DrawerTitle className="flex items-center justify-between">
            {label}
            {isActive && (
              <Button
                variant="ghost"
                size="sm"
                className="h-auto py-0.5" style={{ fontSize: 'calc(var(--drawer-body-size, 16px) * 0.75)' }}
                onClick={() => dispatch(setFilter({ key: filterKey, values: [] }))}
                data-testid={`clear-${filterKey}`}
              >
                Clear
              </Button>
            )}
          </DrawerTitle>
        </DrawerHeader>
        <div className="px-6 pb-6 max-h-[70vh] overflow-y-auto">
          <MultiSelectBubbles
            options={options}
            selected={selected}
            onToggle={toggleFilter}
            testIdPrefix={testIdPrefix}
          />
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function MobileCostsDrawer({ isDonor, isSurrogate, isSperm, activeFilters, dispatch, activeCostCount, btnStyle, dark }: {
  isDonor: boolean;
  isSurrogate: boolean;
  isSperm: boolean;
  activeFilters: Record<string, string[]>;
  dispatch: any;
  activeCostCount: number;
  btnStyle?: React.CSSProperties;
  dark?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <button
          className={tinderLabel(activeCostCount > 0, dark)}
          style={TINDER_LABEL_STYLE}
          data-testid="filter-btn-costs"
        >
          Costs
        </button>
      </DrawerTrigger>
      <DrawerContent data-testid="drawer-costs">
        <DrawerHeader>
          <DrawerTitle>Costs</DrawerTitle>
        </DrawerHeader>
        <div className="px-6 pb-6 space-y-5 max-h-[70vh] overflow-y-auto">
          {isDonor && (
            <>
              <DrawerRangeSlider label="Donor Compensation" filterKey="donorCompensation" min={0} max={200000} step={5000} unit="$" activeFilters={activeFilters} dispatch={dispatch} />
              <DrawerRangeSlider label="Total Cost" filterKey="maxCost" min={0} max={200000} step={5000} unit="$" activeFilters={activeFilters} dispatch={dispatch} />
            </>
          )}
          {isSurrogate && (
            <>
              <DrawerRangeSlider label="Base Compensation" filterKey="baseCompensation" min={0} max={200000} step={5000} unit="$" activeFilters={activeFilters} dispatch={dispatch} />
              <DrawerRangeSlider label="Total Cost" filterKey="maxCost" min={0} max={500000} step={10000} unit="$" activeFilters={activeFilters} dispatch={dispatch} />
            </>
          )}
          {isSperm && (
            <DrawerRangeSlider label="Max Price" filterKey="maxCost" min={0} max={5000} step={100} unit="$" activeFilters={activeFilters} dispatch={dispatch} />
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function SingleValueSlider({ label, filterKey, min, max, step, activeFilters, dispatch }: {
  label: string;
  filterKey: string;
  min: number;
  max: number;
  step: number;
  activeFilters: Record<string, string[]>;
  dispatch: any;
}) {
  const current = activeFilters[filterKey]?.[0] ? Number(activeFilters[filterKey][0]) : max;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground" style={{ fontSize: 'var(--drawer-body-size, 16px)' }}>{label}</span>
        <span className="font-ui tabular-nums" style={{ fontSize: 'var(--drawer-body-size, 16px)' }}>{current === max ? "Any" : `≤ ${current}`}</span>
      </div>
      <Slider
        min={min}
        max={max}
        step={step}
        value={[current]}
        onValueChange={([val]) => {
          dispatch(setFilter({ key: filterKey, values: val === max ? [] : [String(val)] }));
        }}
        data-testid={`slider-${filterKey}`}
      />
    </div>
  );
}

function YearInput({ label, filterKey, activeFilters, dispatch }: {
  label: string;
  filterKey: string;
  activeFilters: Record<string, string[]>;
  dispatch: any;
}) {
  const current = activeFilters[filterKey]?.[0] || "";

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground" style={{ fontSize: 'var(--drawer-body-size, 16px)' }}>{label}</span>
        {current && <span className="font-ui tabular-nums" style={{ fontSize: 'var(--drawer-body-size, 16px)' }}>{current}+</span>}
      </div>
      <Input
        type="number"
        min={2000}
        max={new Date().getFullYear()}
        placeholder={`e.g. ${new Date().getFullYear() - 3}`}
        value={current}
        onChange={(e) => {
          const val = e.target.value;
          dispatch(setFilter({ key: filterKey, values: val ? [val] : [] }));
        }}
        className="h-auto py-1.5"
        style={{ fontSize: 'calc(var(--drawer-body-size, 16px) * 0.85)' }}
        data-testid={`input-${filterKey}`}
      />
    </div>
  );
}

function BooleanToggle({ label, filterKey, activeFilters, dispatch }: {
  label: string;
  filterKey: string;
  activeFilters: Record<string, string[]>;
  dispatch: any;
}) {
  const isActive = (activeFilters[filterKey] || [])[0] === "true";

  return (
    <button
      type="button"
      className={`flex items-center justify-between w-full px-3 py-2.5 rounded-[var(--radius)] border font-ui transition-colors ${
        isActive
          ? "bg-primary/10 border-primary/30 text-primary"
          : "bg-muted/30 border-border text-muted-foreground hover:bg-muted/50"
      }`}
      style={{ fontSize: 'calc(var(--drawer-body-size, 16px) * 0.85)' }}
      onClick={() => dispatch(setFilter({ key: filterKey, values: isActive ? [] : ["true"] }))}
      data-testid={`toggle-${filterKey}`}
    >
      <span>{label}</span>
      <span className={`${isActive ? "text-primary" : "text-muted-foreground/60"}`} style={{ fontSize: 'calc(var(--drawer-body-size, 16px) * 0.7)' }}>{isActive ? "Yes" : "Any"}</span>
    </button>
  );
}

function MobileMedicalDrawer({ activeFilters, dispatch, btnStyle, dark }: { activeFilters: Record<string, string[]>; dispatch: any; btnStyle?: React.CSSProperties; dark?: boolean }) {
  const [open, setOpen] = useState(false);
  const medicalKeys = ["maxLiveBirths", "maxCSections", "maxMiscarriages", "maxAbortions", "lastDeliveryYear", "covidVaccinated"];
  const activeCount = medicalKeys.filter((k) => {
    const v = activeFilters[k];
    if (!v || v.length === 0) return false;
    if (k === "covidVaccinated") return v[0] === "true";
    return true;
  }).length;

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <button className={tinderLabel(activeCount > 0, dark)} style={TINDER_LABEL_STYLE} data-testid="filter-btn-medical">
          Medical
        </button>
      </DrawerTrigger>
      <DrawerContent data-testid="drawer-medical">
        <DrawerHeader><DrawerTitle>Medical</DrawerTitle></DrawerHeader>
        <div className="px-6 pb-6 space-y-4 max-h-[70vh] overflow-y-auto">
          <DrawerRangeSlider label="Live Births" filterKey="maxLiveBirths" min={0} max={10} step={1} unit="" activeFilters={activeFilters} dispatch={dispatch} />
          <SingleValueSlider label="Max C-Sections" filterKey="maxCSections" min={0} max={5} step={1} activeFilters={activeFilters} dispatch={dispatch} />
          <SingleValueSlider label="Max Miscarriages" filterKey="maxMiscarriages" min={0} max={5} step={1} activeFilters={activeFilters} dispatch={dispatch} />
          <SingleValueSlider label="Max Abortions" filterKey="maxAbortions" min={0} max={5} step={1} activeFilters={activeFilters} dispatch={dispatch} />
          <YearInput label="Last Delivery Year (since)" filterKey="lastDeliveryYear" activeFilters={activeFilters} dispatch={dispatch} />
          <BooleanToggle label="COVID Vaccinated" filterKey="covidVaccinated" activeFilters={activeFilters} dispatch={dispatch} />
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function MobileAgreesToDrawer({ activeFilters, dispatch, btnStyle, dark }: { activeFilters: Record<string, string[]>; dispatch: any; btnStyle?: React.CSSProperties; dark?: boolean }) {
  const [open, setOpen] = useState(false);
  const agreesKeys = ["agreesToTwins", "agreesToSelectiveReduction", "openToSameSexCouple", "agreesToInternationalParents"];
  const activeCount = agreesKeys.filter((k) => (activeFilters[k] || [])[0] === "true").length;

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <button className={tinderLabel(activeCount > 0, dark)} style={TINDER_LABEL_STYLE} data-testid="filter-btn-agrees-to">
          Agrees To
        </button>
      </DrawerTrigger>
      <DrawerContent data-testid="drawer-agrees-to">
        <DrawerHeader><DrawerTitle>Agrees To</DrawerTitle></DrawerHeader>
        <div className="px-6 pb-6 space-y-4 max-h-[70vh] overflow-y-auto">
          <BooleanToggle label="Twins" filterKey="agreesToTwins" activeFilters={activeFilters} dispatch={dispatch} />
          <BooleanToggle label="Selective Reduction" filterKey="agreesToSelectiveReduction" activeFilters={activeFilters} dispatch={dispatch} />
          <BooleanToggle label="Same Sex Couple" filterKey="openToSameSexCouple" activeFilters={activeFilters} dispatch={dispatch} />
          <BooleanToggle label="International Parents" filterKey="agreesToInternationalParents" activeFilters={activeFilters} dispatch={dispatch} />
          <p className="text-muted-foreground/70 pt-1 px-1" style={{ fontSize: 'calc(var(--drawer-body-size, 16px) * 0.7)' }}>Surrogates are automatically filtered based on your location and identification.</p>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

export function MarketplaceFilterBar({
  providerType,
  ivfLocation,
  onIvfLocationChange,
  ivfSearch,
  onIvfSearchChange,
  ivfEggSource,
  onIvfEggSourceChange,
  ivfAgeGroup,
  onIvfAgeGroupChange,
  ivfIsNewPatient,
  onIvfIsNewPatientChange,
  ivfSortBy,
  onIvfSortByChange,
  hasIvfLocation,
  location,
  onLocationChange,
  hasLocation,
  hideFavorites,
  inlineMode,
  overlayStyle,
  noResults,
}: MarketplaceFilterBarProps) {
  const dispatch = useAppDispatch();
  const isMobile = useIsMobile();
  const searchQuery = useAppSelector((state) => state.ui.marketplaceSearchQuery);
  const sortBy = useAppSelector((state) => state.ui.marketplaceSortBy);
  const activeFilters = useAppSelector((state) => state.ui.activeFilters);
  const showFavoritesOnly = useAppSelector((state) => state.ui.showFavoritesOnly);
  const showSkippedOnly = useAppSelector((state) => state.ui.showSkippedOnly);
  const showExperiencedOnly = useAppSelector((state) => state.ui.showExperiencedOnly);

  const pills = formatFilterPills(activeFilters);
  const activeCount = pills.length;

  const removePill = (key: string, label: string) => {
    if (RANGE_FILTER_KEYS.has(key)) {
      dispatch(setFilter({ key, values: [] }));
    } else {
      const value = label.split(": ").slice(1).join(": ");
      const remaining = (activeFilters[key] || []).filter((x) => x !== value);
      dispatch(setFilter({ key, values: remaining }));
    }
  };

  const isDonor = providerType === "egg-donor";
  const isSurrogate = providerType === "surrogate";
  const isSperm = providerType === "sperm-donor";
  const isIvf = providerType === "ivf-clinic";
  const ivfAgeDisabled = ivfEggSource === "donor" || ivfEggSource === "donated_embryos";

  const costFilterKeys = isDonor ? ["donorCompensation", "maxCost"] : isSurrogate ? ["baseCompensation", "maxCost"] : ["maxCost"];
  const hasCostFilter = costFilterKeys.some((k) => {
    const v = activeFilters[k];
    return v && v.length === 2;
  });
  const activeCostCount = costFilterKeys.filter((k) => {
    const v = activeFilters[k];
    if (!v || v.length !== 2) return false;
    const fMin = Number(v[0]);
    const fMax = Number(v[1]);
    if (k === "donorCompensation" || k === "baseCompensation" || (k === "maxCost" && isDonor)) return fMin !== 0 || fMax !== 200000;
    if (k === "maxCost" && isSurrogate) return fMin !== 0 || fMax !== 500000;
    if (k === "maxCost" && isSperm) return fMin !== 0 || fMax !== 5000;
    return fMin !== 0 || fMax !== 200000;
  }).length;

  const darkLabels = !!noResults;
  const [locationDrawerOpen, setLocationDrawerOpen] = useState(false);

  const ivfMobileFilterButtons = isIvf ? (
    <>
      <Drawer open={locationDrawerOpen} onOpenChange={setLocationDrawerOpen}>
        <DrawerTrigger asChild>
          <button
            className={tinderLabel(!!ivfLocation, darkLabels)}
            style={TINDER_LABEL_STYLE}
            data-testid="filter-btn-ivf-location"
          >
            Location
          </button>
        </DrawerTrigger>
        <DrawerContent>
          <DrawerHeader><DrawerTitle>Location</DrawerTitle></DrawerHeader>
          <div className="p-4">
            <div className="relative">
              <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="City or state"
                value={ivfLocation || ""}
                onChange={(e) => onIvfLocationChange?.(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") setLocationDrawerOpen(false); }}
                data-testid="input-ivf-location-mobile"
              />
            </div>
          </div>
        </DrawerContent>
      </Drawer>

      <Drawer>
        <DrawerTrigger asChild>
          <button className={tinderLabel(false, darkLabels)} style={TINDER_LABEL_STYLE} data-testid="filter-btn-ivf-egg-source">
            Egg Source
          </button>
        </DrawerTrigger>
        <DrawerContent>
          <DrawerHeader><DrawerTitle>Egg Source</DrawerTitle></DrawerHeader>
          <div className="p-4 space-y-2">
            {EGG_SOURCE_OPTIONS.map((opt) => (
              <Button key={opt.value} variant={ivfEggSource === opt.value ? "default" : "outline"} className="w-full justify-start" onClick={() => onIvfEggSourceChange?.(opt.value)} data-testid={`ivf-egg-source-${opt.value}`}>
                {opt.label}
              </Button>
            ))}
          </div>
        </DrawerContent>
      </Drawer>

      <Drawer>
        <DrawerTrigger asChild>
          <button className={`${tinderLabel(false, darkLabels)} ${ivfAgeDisabled ? "opacity-50" : ""}`} style={TINDER_LABEL_STYLE} disabled={ivfAgeDisabled} data-testid="filter-btn-ivf-age">
            Your Age
          </button>
        </DrawerTrigger>
        <DrawerContent>
          <DrawerHeader><DrawerTitle>Your Age</DrawerTitle></DrawerHeader>
          <div className="p-4 space-y-2">
            {AGE_GROUP_OPTIONS.map((opt) => (
              <Button key={opt.value} variant={ivfAgeGroup === opt.value ? "default" : "outline"} className="w-full justify-start" onClick={() => onIvfAgeGroupChange?.(opt.value)} data-testid={`ivf-age-${opt.value}`}>
                {opt.label}
              </Button>
            ))}
          </div>
        </DrawerContent>
      </Drawer>

      <Drawer>
        <DrawerTrigger asChild>
          <button className={tinderLabel(false, darkLabels)} style={TINDER_LABEL_STYLE} data-testid="filter-btn-ivf-history">
            IVF History
          </button>
        </DrawerTrigger>
        <DrawerContent>
          <DrawerHeader><DrawerTitle>IVF History</DrawerTitle></DrawerHeader>
          <div className="p-4 space-y-2">
            {IVF_HISTORY_OPTIONS.map((opt) => (
              <Button key={opt.value} variant={ivfIsNewPatient === opt.value ? "default" : "outline"} className="w-full justify-start" onClick={() => onIvfIsNewPatientChange?.(opt.value)} data-testid={`ivf-history-${opt.value}`}>
                {opt.label}
              </Button>
            ))}
          </div>
        </DrawerContent>
      </Drawer>
    </>
  ) : null;

  const obs = overlayStyle ? OVERLAY_BTN_STYLE : undefined;

  const mobileFilterButtons = (
    <>
      {!isIvf && !hideFavorites && (
        <>
          <Button
            variant={showFavoritesOnly ? "default" : "outline"}
            size="sm"
            className="shrink-0 h-9 w-9 p-0 rounded-full"
            style={!showFavoritesOnly ? obs : undefined}
            onClick={() => dispatch(setShowFavoritesOnly(!showFavoritesOnly))}
            data-testid="button-favorites"
            title="Favorites only"
          >
            <Heart className="w-3.5 h-3.5" fill={showFavoritesOnly ? "currentColor" : "none"} />
          </Button>

          <Button
            variant={showSkippedOnly ? "default" : "outline"}
            size="sm"
            className="shrink-0 h-9 w-9 p-0 rounded-full"
            style={!showSkippedOnly ? obs : undefined}
            onClick={() => dispatch(setShowSkippedOnly(!showSkippedOnly))}
            data-testid="button-show-skipped"
            title="Skipped only"
          >
            <X className="w-3.5 h-3.5" strokeWidth={showSkippedOnly ? 3 : 2} />
          </Button>
        </>
      )}

      {!isIvf && !hideFavorites && (
        <Button
          variant={showExperiencedOnly ? "default" : "outline"}
          size="sm"
          className="shrink-0 h-9 w-9 p-0 rounded-full"
          style={!showExperiencedOnly ? obs : undefined}
          onClick={() => dispatch(setShowExperiencedOnly(!showExperiencedOnly))}
          data-testid="button-experienced"
          title="Experienced only"
        >
          <Award className="w-3.5 h-3.5" fill={showExperiencedOnly ? "currentColor" : "none"} />
        </Button>
      )}

      {isIvf && ivfMobileFilterButtons}

      {!isIvf && (
        <Drawer open={locationDrawerOpen} onOpenChange={setLocationDrawerOpen}>
          <DrawerTrigger asChild>
            <button
              className={tinderLabel(!!hasLocation, darkLabels)}
              style={TINDER_LABEL_STYLE}
              data-testid="filter-btn-location"
            >
              Location
            </button>
          </DrawerTrigger>
          <DrawerContent>
            <DrawerHeader><DrawerTitle>Location</DrawerTitle></DrawerHeader>
            <div className="p-4">
              <div className="relative">
                <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  className="pl-9"
                  placeholder="City, state, or country"
                  value={location || ""}
                  onChange={(e) => onLocationChange?.(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") setLocationDrawerOpen(false); }}
                  data-testid="input-location-mobile"
                />
              </div>
            </div>
          </DrawerContent>
        </Drawer>
      )}

      {!isIvf && (
        <MobileRangeDrawer label="Age" filterKey="age" min={18} max={45} step={1} unit="" activeFilters={activeFilters} dispatch={dispatch} btnStyle={obs} dark={darkLabels} />
      )}

      {(isDonor || isSperm) && (
        <>
          <MobileCustomTagDrawer label="Eye Color" filterKey="eyeColor" options={EYE_COLOR_OPTIONS} activeFilters={activeFilters} dispatch={dispatch} testIdPrefix="filter-eye" btnStyle={obs} dark={darkLabels} />
          <MobileCustomTagDrawer label="Hair Color" filterKey="hairColor" options={HAIR_COLOR_OPTIONS} activeFilters={activeFilters} dispatch={dispatch} testIdPrefix="filter-hair" btnStyle={obs} dark={darkLabels} />
          <MobileRangeDrawer label="Height" filterKey="height" min={48} max={84} step={1} unit="" activeFilters={activeFilters} dispatch={dispatch} btnStyle={obs} dark={darkLabels} formatValue={formatHeightInches} />
        </>
      )}

      {isSurrogate && (
        <MobileRangeDrawer label="BMI" filterKey="bmi" min={16} max={40} step={1} unit="" activeFilters={activeFilters} dispatch={dispatch} btnStyle={obs} dark={darkLabels} />
      )}

      {!isIvf && (
        <>
          <MobileCustomTagDrawer label="Race" filterKey="race" options={RACE_OPTIONS} activeFilters={activeFilters} dispatch={dispatch} testIdPrefix="filter-race" btnStyle={obs} dark={darkLabels} />
          <MobileCustomTagDrawer label="Ethnicity" filterKey="ethnicity" options={ETHNICITY_OPTIONS} activeFilters={activeFilters} dispatch={dispatch} testIdPrefix="filter-eth" btnStyle={obs} dark={darkLabels} />
        </>
      )}

      {(isDonor || isSperm) && (
        <MobileEducationDrawer activeFilters={activeFilters} dispatch={dispatch} btnStyle={obs} dark={darkLabels} />
      )}

      {isSurrogate && (
        <MobileMultiSelectDrawer label="Relationship" filterKey="relationshipStatus" options={RELATIONSHIP_OPTIONS} activeFilters={activeFilters} dispatch={dispatch} testIdPrefix="filter-rel" btnStyle={obs} dark={darkLabels} />
      )}

      {!isIvf && (
        <MobileCostsDrawer isDonor={isDonor} isSurrogate={isSurrogate} isSperm={isSperm} activeFilters={activeFilters} dispatch={dispatch} activeCostCount={activeCostCount} btnStyle={obs} dark={darkLabels} />
      )}

      {isDonor && (
        <>
          <MobileMultiSelectDrawer label="Egg Type" filterKey="eggType" options={EGG_TYPE_OPTIONS} activeFilters={activeFilters} dispatch={dispatch} testIdPrefix="filter-egg-type" btnStyle={obs} dark={darkLabels} />
          <MobileMultiSelectDrawer label="Donation Type" filterKey="donationType" options={DONATION_TYPE_OPTIONS} activeFilters={activeFilters} dispatch={dispatch} testIdPrefix="filter-donation" btnStyle={obs} dark={darkLabels} />
        </>
      )}

      {isSurrogate && (
        <>
          <MobileMedicalDrawer activeFilters={activeFilters} dispatch={dispatch} btnStyle={obs} dark={darkLabels} />
          <MobileAgreesToDrawer activeFilters={activeFilters} dispatch={dispatch} btnStyle={obs} dark={darkLabels} />
        </>
      )}

      {isSperm && (
        <MobileMultiSelectDrawer label="Donor Type" filterKey="donorType" options={["ID Release", "Non-ID Release"]} activeFilters={activeFilters} dispatch={dispatch} testIdPrefix="filter-donor-type" btnStyle={obs} dark={darkLabels} />
      )}
    </>
  );

  const [locationPopoverOpen, setLocationPopoverOpen] = useState(false);

  const ivfDesktopFilterButtons = isIvf ? (
    <>
      <Popover open={locationPopoverOpen} onOpenChange={setLocationPopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            variant={ivfLocation ? "default" : "outline"}
            size="sm"
            className="shrink-0 h-9 font-ui rounded-full gap-1 px-3.5" style={{ fontSize: 'var(--badge-text-size, 13px)' }}
            data-testid="filter-btn-ivf-location"
          >
            <MapPin className="w-3 h-3" />
            {ivfLocation || "Location"}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-3" align="start">
          <div className="space-y-2">
            <span className="font-ui" style={{ fontSize: 'var(--filter-label-size, 18px)' }}>Location</span>
            <div className="relative">
              <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="City or state"
                value={ivfLocation || ""}
                onChange={(e) => onIvfLocationChange?.(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") setLocationPopoverOpen(false); }}
                data-testid="input-ivf-location-desktop"
              />
            </div>
            {ivfLocation && (
              <Button variant="ghost" size="sm" className="h-auto py-0.5" style={{ fontSize: 'calc(var(--drawer-body-size, 16px) * 0.75)' }} onClick={() => { onIvfLocationChange?.(""); setLocationPopoverOpen(false); }} data-testid="clear-ivf-location">
                Clear
              </Button>
            )}
          </div>
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="shrink-0 h-9 font-ui rounded-full gap-1 px-3.5" style={{ fontSize: 'var(--badge-text-size, 13px)' }} data-testid="filter-btn-ivf-egg-source">
            {EGG_SOURCE_OPTIONS.find(o => o.value === ivfEggSource)?.label || "Egg Source"}
            <ChevronDown className="w-3.5 h-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-48 p-2" align="start">
          <div className="space-y-1">
            {EGG_SOURCE_OPTIONS.map((opt) => (
              <Button key={opt.value} variant={ivfEggSource === opt.value ? "default" : "ghost"} size="sm" className="w-full justify-start text-xs" onClick={() => onIvfEggSourceChange?.(opt.value)} data-testid={`ivf-egg-source-${opt.value}`}>
                {opt.label}
              </Button>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className={`shrink-0 h-9 font-ui rounded-full gap-1 px-3.5 ${ivfAgeDisabled ? "opacity-50" : ""}`} style={{ fontSize: 'var(--badge-text-size, 13px)' }} disabled={ivfAgeDisabled} data-testid="filter-btn-ivf-age">
            {AGE_GROUP_OPTIONS.find(o => o.value === ivfAgeGroup)?.label || "Your Age"}
            <ChevronDown className="w-3.5 h-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-40 p-2" align="start">
          <div className="space-y-1">
            {AGE_GROUP_OPTIONS.map((opt) => (
              <Button key={opt.value} variant={ivfAgeGroup === opt.value ? "default" : "ghost"} size="sm" className="w-full justify-start text-xs" onClick={() => onIvfAgeGroupChange?.(opt.value)} data-testid={`ivf-age-${opt.value}`}>
                {opt.label}
              </Button>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="shrink-0 h-9 font-ui rounded-full gap-1 px-3.5" style={{ fontSize: 'var(--badge-text-size, 13px)' }} data-testid="filter-btn-ivf-history">
            {IVF_HISTORY_OPTIONS.find(o => o.value === ivfIsNewPatient)?.label || "IVF History"}
            <ChevronDown className="w-3.5 h-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-48 p-2" align="start">
          <div className="space-y-1">
            {IVF_HISTORY_OPTIONS.map((opt) => (
              <Button key={opt.value} variant={ivfIsNewPatient === opt.value ? "default" : "ghost"} size="sm" className="w-full justify-start text-xs" onClick={() => onIvfIsNewPatientChange?.(opt.value)} data-testid={`ivf-history-${opt.value}`}>
                {opt.label}
              </Button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </>
  ) : null;

  const desktopFilterButtons = (
    <>
      {!isIvf && !hideFavorites && (
        <>
          <Button
            variant={showFavoritesOnly ? "default" : "outline"}
            size="sm"
            className="shrink-0 h-9 w-9 p-0 rounded-full"
            onClick={() => dispatch(setShowFavoritesOnly(!showFavoritesOnly))}
            data-testid="button-favorites"
            title="Favorites only"
          >
            <Heart className="w-3.5 h-3.5" fill={showFavoritesOnly ? "currentColor" : "none"} />
          </Button>

          <Button
            variant={showSkippedOnly ? "default" : "outline"}
            size="sm"
            className="shrink-0 h-9 w-9 p-0 rounded-full"
            onClick={() => dispatch(setShowSkippedOnly(!showSkippedOnly))}
            data-testid="button-show-skipped"
            title="Skipped only"
          >
            <X className="w-3.5 h-3.5" strokeWidth={showSkippedOnly ? 3 : 2} />
          </Button>
        </>
      )}

      {!isIvf && (
        <Button
          variant={showExperiencedOnly ? "default" : "outline"}
          size="sm"
          className="shrink-0 h-9 w-9 p-0 rounded-full"
          onClick={() => dispatch(setShowExperiencedOnly(!showExperiencedOnly))}
          data-testid="button-experienced"
          title="Experienced only"
        >
          <Award className="w-3.5 h-3.5" fill={showExperiencedOnly ? "currentColor" : "none"} />
        </Button>
      )}

      {isIvf && ivfDesktopFilterButtons}

      {!isIvf && (
        <Popover open={locationPopoverOpen} onOpenChange={setLocationPopoverOpen}>
          <PopoverTrigger asChild>
            <Button
              variant={hasLocation ? "default" : "outline"}
              size="sm"
              className="shrink-0 h-9 font-ui rounded-full gap-1 px-3.5"
              style={{ fontSize: 'var(--badge-text-size, 13px)' }}
              data-testid="filter-btn-location"
            >
              <MapPin className="w-3 h-3" />
              {location || "Location"}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-3" align="start">
            <div className="space-y-2">
              <span className="font-ui" style={{ fontSize: 'var(--filter-label-size, 18px)' }}>Location</span>
              <div className="relative">
                <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  className="pl-9"
                  placeholder="City, state, or country"
                  value={location || ""}
                  onChange={(e) => onLocationChange?.(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") setLocationPopoverOpen(false); }}
                  data-testid="input-location-desktop"
                />
              </div>
              {location && (
                <Button variant="ghost" size="sm" className="h-auto py-0.5" style={{ fontSize: 'calc(var(--drawer-body-size, 16px) * 0.75)' }} onClick={() => { onLocationChange?.(""); setLocationPopoverOpen(false); }} data-testid="clear-location">
                  Clear
                </Button>
              )}
            </div>
          </PopoverContent>
        </Popover>
      )}

      {!isIvf && (
        <RangePopover label="Age" filterKey="age" min={18} max={45} step={1} unit="" activeFilters={activeFilters} dispatch={dispatch} />
      )}

      {(isDonor || isSperm) && (
        <>
          <CustomTagPopover label="Eye Color" filterKey="eyeColor" options={EYE_COLOR_OPTIONS} activeFilters={activeFilters} dispatch={dispatch} testIdPrefix="filter-eye" />
          <CustomTagPopover label="Hair Color" filterKey="hairColor" options={HAIR_COLOR_OPTIONS} activeFilters={activeFilters} dispatch={dispatch} testIdPrefix="filter-hair" />
          <RangePopover label="Height" filterKey="height" min={48} max={84} step={1} unit="" activeFilters={activeFilters} dispatch={dispatch} formatValue={formatHeightInches} />
        </>
      )}

      {isSurrogate && (
        <RangePopover label="BMI" filterKey="bmi" min={16} max={40} step={1} unit="" activeFilters={activeFilters} dispatch={dispatch} />
      )}

      {!isIvf && (
        <>
          <CustomTagPopover label="Race" filterKey="race" options={RACE_OPTIONS} activeFilters={activeFilters} dispatch={dispatch} testIdPrefix="filter-race" />
          <CustomTagPopover label="Ethnicity" filterKey="ethnicity" options={ETHNICITY_OPTIONS} activeFilters={activeFilters} dispatch={dispatch} testIdPrefix="filter-eth" />
        </>
      )}

      {(isDonor || isSperm) && (
        <EducationPopover activeFilters={activeFilters} dispatch={dispatch} />
      )}

      {isSurrogate && (
        <MultiSelectPopover label="Relationship" filterKey="relationshipStatus" options={RELATIONSHIP_OPTIONS} activeFilters={activeFilters} dispatch={dispatch} testIdPrefix="filter-rel" />
      )}

      {!isIvf && (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant={activeCostCount > 0 ? "default" : "outline"}
              size="sm"
              className="shrink-0 h-9 font-ui rounded-full gap-1 px-3.5" style={{ fontSize: 'var(--badge-text-size, 13px)' }}
              data-testid="filter-btn-costs"
            >
              Costs
              {activeCostCount > 0 && <span className="font-normal opacity-80">({activeCostCount})</span>}
              <ChevronDown className="w-3.5 h-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-4" align="start">
            <div className="space-y-5">
              <span className="font-ui" style={{ fontSize: 'var(--filter-label-size, 18px)' }}>Costs</span>
              {isDonor && (
                <>
                  <DrawerRangeSlider label="Donor Compensation" filterKey="donorCompensation" min={0} max={200000} step={5000} unit="$" activeFilters={activeFilters} dispatch={dispatch} />
                  <DrawerRangeSlider label="Total Cost" filterKey="maxCost" min={0} max={200000} step={5000} unit="$" activeFilters={activeFilters} dispatch={dispatch} />
                </>
              )}
              {isSurrogate && (
                <>
                  <DrawerRangeSlider label="Base Compensation" filterKey="baseCompensation" min={0} max={200000} step={5000} unit="$" activeFilters={activeFilters} dispatch={dispatch} />
                  <DrawerRangeSlider label="Total Cost" filterKey="maxCost" min={0} max={500000} step={10000} unit="$" activeFilters={activeFilters} dispatch={dispatch} />
                </>
              )}
              {isSperm && (
                <DrawerRangeSlider label="Max Price" filterKey="maxCost" min={0} max={5000} step={100} unit="$" activeFilters={activeFilters} dispatch={dispatch} />
              )}
            </div>
          </PopoverContent>
        </Popover>
      )}

      {isDonor && (
        <>
          <MultiSelectPopover label="Egg Type" filterKey="eggType" options={EGG_TYPE_OPTIONS} activeFilters={activeFilters} dispatch={dispatch} testIdPrefix="filter-egg-type" />
          <MultiSelectPopover label="Donation Type" filterKey="donationType" options={DONATION_TYPE_OPTIONS} activeFilters={activeFilters} dispatch={dispatch} testIdPrefix="filter-donation" />
        </>
      )}

      {isSurrogate && (
        <>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant={(() => {
                  const medicalKeys = ["maxLiveBirths", "maxCSections", "maxMiscarriages", "maxAbortions", "lastDeliveryYear", "covidVaccinated"];
                  return medicalKeys.some((k) => {
                    const v = activeFilters[k];
                    if (!v || v.length === 0) return false;
                    if (k === "covidVaccinated") return v[0] === "true";
                    return true;
                  }) ? "default" : "outline";
                })()}
                size="sm"
                className="shrink-0 h-9 font-ui rounded-full gap-1 px-3.5" style={{ fontSize: 'var(--badge-text-size, 13px)' }}
                data-testid="filter-btn-medical"
              >
                Medical
                {(() => {
                  const medicalKeys = ["maxLiveBirths", "maxCSections", "maxMiscarriages", "maxAbortions", "lastDeliveryYear", "covidVaccinated"];
                  const c = medicalKeys.filter((k) => {
                    const v = activeFilters[k];
                    if (!v || v.length === 0) return false;
                    if (k === "covidVaccinated") return v[0] === "true";
                    return true;
                  }).length;
                  return c > 0 ? <span className="font-normal opacity-80">({c})</span> : null;
                })()}
                <ChevronDown className="w-3.5 h-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-80 p-4" align="start">
              <div className="space-y-4">
                <span className="font-ui" style={{ fontSize: 'var(--filter-label-size, 18px)' }}>Medical</span>
                <DrawerRangeSlider label="Live Births" filterKey="maxLiveBirths" min={0} max={10} step={1} unit="" activeFilters={activeFilters} dispatch={dispatch} />
                <SingleValueSlider label="Max C-Sections" filterKey="maxCSections" min={0} max={5} step={1} activeFilters={activeFilters} dispatch={dispatch} />
                <SingleValueSlider label="Max Miscarriages" filterKey="maxMiscarriages" min={0} max={5} step={1} activeFilters={activeFilters} dispatch={dispatch} />
                <SingleValueSlider label="Max Abortions" filterKey="maxAbortions" min={0} max={5} step={1} activeFilters={activeFilters} dispatch={dispatch} />
                <YearInput label="Last Delivery Year (since)" filterKey="lastDeliveryYear" activeFilters={activeFilters} dispatch={dispatch} />
                <BooleanToggle label="COVID Vaccinated" filterKey="covidVaccinated" activeFilters={activeFilters} dispatch={dispatch} />
              </div>
            </PopoverContent>
          </Popover>

          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant={(() => {
                  const agreesKeys = ["agreesToTwins", "agreesToSelectiveReduction", "openToSameSexCouple", "agreesToInternationalParents"];
                  return agreesKeys.some((k) => (activeFilters[k] || [])[0] === "true") ? "default" : "outline";
                })()}
                size="sm"
                className="shrink-0 h-9 font-ui rounded-full gap-1 px-3.5" style={{ fontSize: 'var(--badge-text-size, 13px)' }}
                data-testid="filter-btn-agrees-to"
              >
                Agrees To
                {(() => {
                  const agreesKeys = ["agreesToTwins", "agreesToSelectiveReduction", "openToSameSexCouple", "agreesToInternationalParents"];
                  const c = agreesKeys.filter((k) => (activeFilters[k] || [])[0] === "true").length;
                  return c > 0 ? <span className="font-normal opacity-80">({c})</span> : null;
                })()}
                <ChevronDown className="w-3.5 h-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-72 p-4" align="start">
              <div className="space-y-3">
                <span className="font-ui" style={{ fontSize: 'var(--filter-label-size, 18px)' }}>Agrees To</span>
                <BooleanToggle label="Twins" filterKey="agreesToTwins" activeFilters={activeFilters} dispatch={dispatch} />
                <BooleanToggle label="Selective Reduction" filterKey="agreesToSelectiveReduction" activeFilters={activeFilters} dispatch={dispatch} />
                <BooleanToggle label="Same Sex Couple" filterKey="openToSameSexCouple" activeFilters={activeFilters} dispatch={dispatch} />
                <BooleanToggle label="International Parents" filterKey="agreesToInternationalParents" activeFilters={activeFilters} dispatch={dispatch} />
                <p className="text-muted-foreground/70 pt-1 px-1" style={{ fontSize: 'calc(var(--drawer-body-size, 16px) * 0.7)' }}>Surrogates are automatically filtered based on your location and identification.</p>
              </div>
            </PopoverContent>
          </Popover>
        </>
      )}

      {isSperm && (
        <MultiSelectPopover label="Donor Type" filterKey="donorType" options={["ID Release", "Non-ID Release"]} activeFilters={activeFilters} dispatch={dispatch} testIdPrefix="filter-donor-type" />
      )}
    </>
  );

  const currentSearchValue = isIvf ? (ivfSearch || "") : searchQuery;
  const currentSearchPlaceholder = isIvf ? "Clinic name..." : "Search by name, ID, location, education...";
  const currentSearchPlaceholderMobile = isIvf ? "Clinic name..." : "Search...";
  const handleSearchChange = isIvf
    ? (val: string) => onIvfSearchChange?.(val)
    : (val: string) => dispatch(setMarketplaceSearchQuery(val));
  const currentSortValue = isIvf ? (ivfSortBy || "highest_success") : sortBy;
  const handleSortChange = isIvf
    ? (val: string) => onIvfSortByChange?.(val)
    : (val: string) => dispatch(setMarketplaceSortBy(val));
  const currentSortOptions = isIvf ? IVF_SORT_OPTIONS : SORT_OPTIONS;

  if (inlineMode) {
    return <>{mobileFilterButtons}</>;
  }

  if (isMobile) {
    return (
      <>
        <div className="flex items-center gap-2 overflow-x-auto pb-2 -mx-1 px-1 scrollbar-hide" data-testid="filter-bar-mobile">
          <div className="relative shrink-0 flex-1 min-w-[140px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              data-testid="input-search-mobile"
              className="pl-8 h-9 text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
              placeholder={currentSearchPlaceholderMobile}
              value={currentSearchValue}
              onChange={(e) => handleSearchChange(e.target.value)}
            />
            {currentSearchValue && (
              <button
                className="absolute right-2 top-1/2 -translate-y-1/2"
                onClick={() => handleSearchChange("")}
                data-testid="button-clear-search-mobile"
              >
                <X className="w-3.5 h-3.5 text-muted-foreground" />
              </button>
            )}
          </div>
          <Select value={currentSortValue} onValueChange={handleSortChange}>
            <SelectTrigger className="h-9 w-auto shrink-0 gap-1 text-xs focus:ring-0 focus:ring-offset-0" data-testid="select-sort-mobile">
              <ArrowUpDown className="w-3.5 h-3.5 shrink-0" />
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent>
              {currentSortOptions.map((opt) => (
                <SelectItem key={opt.value} value={opt.value} disabled={Boolean("needsLocation" in opt && (opt as any).needsLocation && !hasIvfLocation)} data-testid={`sort-option-${opt.value}`}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-hide" data-testid="filter-buttons-mobile">
          {mobileFilterButtons}
        </div>

        {activeCount > 0 && !isIvf && (
          <div className="flex items-center gap-1.5 mt-2 flex-wrap" data-testid="active-filter-pills-mobile">
            {pills.map((pill) => (
              <Badge
                key={pill.label}
                variant="secondary"
                className="text-xs gap-1 cursor-pointer hover:bg-destructive/10"
                data-testid={`pill-${pill.key}`}
              >
                {pill.label}
                <X className="w-3 h-3" onClick={() => removePill(pill.key, pill.label)} />
              </Badge>
            ))}
            <Button
              variant="ghost"
              size="sm"
              className="text-xs h-6 text-muted-foreground"
              onClick={() => dispatch(clearFilters())}
              data-testid="button-clear-all-mobile"
            >
              Clear all
            </Button>
          </div>
        )}

      </>
    );
  }

  return (
    <>
      <div className="flex items-center gap-3 overflow-x-auto scrollbar-hide" data-testid="filter-bar-desktop">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            data-testid="input-search-desktop"
            className="pl-9 focus-visible:ring-0 focus-visible:ring-offset-0"
            placeholder={currentSearchPlaceholder}
            value={currentSearchValue}
            onChange={(e) => handleSearchChange(e.target.value)}
          />
          {currentSearchValue && (
            <button
              className="absolute right-3 top-1/2 -translate-y-1/2"
              onClick={() => handleSearchChange("")}
              data-testid="button-clear-search-desktop"
            >
              <X className="w-4 h-4 text-muted-foreground hover:text-foreground" />
            </button>
          )}
        </div>

        {desktopFilterButtons}

        <Select value={currentSortValue} onValueChange={handleSortChange}>
          <SelectTrigger className="w-[180px] shrink-0 focus:ring-0 focus:ring-offset-0" data-testid="select-sort-desktop">
            <ArrowUpDown className="w-4 h-4 mr-1 shrink-0" />
            <SelectValue placeholder="Sort by" />
          </SelectTrigger>
          <SelectContent>
            {currentSortOptions.map((opt) => (
              <SelectItem key={opt.value} value={opt.value} disabled={"needsLocation" in opt && opt.needsLocation && !hasIvfLocation} data-testid={`sort-option-${opt.value}`}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {activeCount > 0 && !isIvf && (
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground shrink-0"
            onClick={() => dispatch(clearFilters())}
            data-testid="button-clear-all-desktop"
          >
            Clear filters ({activeCount})
          </Button>
        )}
      </div>

      {activeCount > 0 && !isIvf && (
        <div className="flex items-center gap-1.5 mt-2 flex-wrap" data-testid="active-filter-pills-desktop">
          {pills.map((pill) => (
            <Badge
              key={pill.label}
              variant="secondary"
              className="text-xs gap-1 cursor-pointer hover:bg-destructive/10"
              data-testid={`pill-${pill.key}`}
            >
              {pill.label}
              <X className="w-3 h-3" onClick={() => removePill(pill.key, pill.label)} />
            </Badge>
          ))}
        </div>
      )}

    </>
  );
}
