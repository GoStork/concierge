import { useState, useEffect } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { X, RotateCcw } from "lucide-react";
import { useAppSelector, useAppDispatch } from "@/store";
import { setFilter, clearFilters } from "@/store/uiSlice";

type ProviderType = "egg-donor" | "surrogate" | "sperm-donor";

interface MarketplaceFilterDrawerProps {
  open: boolean;
  onClose: () => void;
  providerType: ProviderType;
  initialTab?: number;
}

const RACE_OPTIONS = ["Asian", "Black", "Hispanic", "White", "Mixed", "Other"];
const EYE_COLOR_OPTIONS = ["Brown", "Blue", "Green", "Hazel", "Gray", "Amber"];
const HAIR_COLOR_OPTIONS = ["Black", "Brown", "Blonde", "Red", "Auburn", "Gray"];
const EGG_TYPE_OPTIONS = ["Fresh", "Frozen"];
const DONATION_TYPE_OPTIONS = ["Anonymous", "Semi-Open", "Open ID", "Known"];
const EDUCATION_OPTIONS = ["High School", "Some College", "Associate", "Bachelor", "Master", "Doctorate"];
const ETHNICITY_OPTIONS = [
  "Chinese", "Japanese", "Korean", "Vietnamese", "Filipino", "Indian",
  "Mexican", "Puerto Rican", "Cuban", "Colombian",
  "Italian", "Irish", "German", "French", "English", "Polish", "Russian",
  "Nigerian", "Ethiopian", "Jamaican", "Haitian",
  "Middle Eastern", "Persian", "Turkish", "Brazilian",
  "Other",
];
const RELATIONSHIP_OPTIONS = ["Single", "Married", "Partnered", "Divorced"];

const SECTION_TABS = ["Age", "Background", "Costs", "Preferences"];

function FilterSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h4 className="font-heading text-foreground" style={{ fontSize: 'var(--filter-label-size, 18px)' }}>{title}</h4>
      {children}
    </div>
  );
}

function MultiSelectBubbles({
  options,
  selected,
  onToggle,
  testIdPrefix,
}: {
  options: string[];
  selected: string[];
  onToggle: (value: string) => void;
  testIdPrefix: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((opt) => {
        const isSelected = selected.includes(opt.toLowerCase());
        return (
          <Badge
            key={opt}
            variant={isSelected ? "default" : "outline"}
            className={`cursor-pointer font-ui px-3 py-1.5 transition-colors ${
              isSelected
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "hover:bg-secondary/60"
            }`}
            style={{ fontSize: 'var(--badge-text-size, 13px)' }}
            onClick={() => onToggle(opt.toLowerCase())}
            data-testid={`${testIdPrefix}-${opt.toLowerCase().replace(/\s+/g, "-")}`}
          >
            {opt}
          </Badge>
        );
      })}
    </div>
  );
}

function RangeFilter({
  label,
  filterKey,
  min,
  max,
  step,
  unit,
  activeFilters,
  dispatch,
}: {
  label: string;
  filterKey: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  activeFilters: Record<string, string[]>;
  dispatch: ReturnType<typeof useAppDispatch>;
}) {
  const current = activeFilters[filterKey];
  const currentMin = current?.[0] ? Number(current[0]) : min;
  const currentMax = current?.[1] ? Number(current[1]) : max;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="font-ui text-muted-foreground" style={{ fontSize: 'var(--badge-text-size, 13px)' }}>{label}</Label>
        <span className="text-muted-foreground" style={{ fontSize: 'var(--badge-text-size, 13px)' }}>
          {unit === "$" ? `$${currentMin.toLocaleString()} – $${currentMax.toLocaleString()}` : `${currentMin} – ${currentMax}`}
        </span>
      </div>
      <Slider
        min={min}
        max={max}
        step={step}
        value={[currentMin, currentMax]}
        onValueChange={([lo, hi]) =>
          dispatch(setFilter({ key: filterKey, values: [String(lo), String(hi)] }))
        }
        data-testid={`slider-${filterKey}`}
      />
    </div>
  );
}

export { SECTION_TABS };

export function MarketplaceFilterDrawer({ open, onClose, providerType, initialTab = 0 }: MarketplaceFilterDrawerProps) {
  const dispatch = useAppDispatch();
  const activeFilters = useAppSelector((state) => state.ui.activeFilters);
  const [activeSection, setActiveSection] = useState(initialTab);

  useEffect(() => {
    if (open) setActiveSection(initialTab);
  }, [open, initialTab]);

  const toggleFilter = (key: string, value: string) => {
    const current = activeFilters[key] || [];
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    dispatch(setFilter({ key, values: next }));
  };

  const activeCount = Object.values(activeFilters).reduce(
    (acc, vals) => acc + vals.filter(Boolean).length,
    0
  );

  const isDonor = providerType === "egg-donor";
  const isSurrogate = providerType === "surrogate";
  const isSperm = providerType === "sperm-donor";

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader className="pb-4 border-b border-border">
          <div className="flex items-center justify-between">
            <SheetTitle className="text-lg font-heading">
              Filters
              {activeCount > 0 && (
                <Badge variant="secondary" className="ml-2 text-xs">{activeCount}</Badge>
              )}
            </SheetTitle>
            <div className="flex items-center gap-2">
              {activeCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => dispatch(clearFilters())}
                  className="text-xs font-ui text-muted-foreground"
                  data-testid="button-clear-filters"
                >
                  <RotateCcw className="w-3 h-3 mr-1" />
                  Clear all
                </Button>
              )}
            </div>
          </div>
          <div className="flex gap-1 mt-3">
            {SECTION_TABS.map((tab, i) => (
              <Button
                key={tab}
                variant={activeSection === i ? "default" : "outline"}
                size="sm"
                className="font-ui flex-1"
                style={{ fontSize: 'var(--badge-text-size, 13px)' }}
                onClick={() => setActiveSection(i)}
                data-testid={`filter-tab-${tab.toLowerCase()}`}
              >
                {tab}
              </Button>
            ))}
          </div>
        </SheetHeader>

        <div className="space-y-6 py-4">
          {activeSection === 0 && (
            <>
              <RangeFilter
                label="Age"
                filterKey="age"
                min={18}
                max={45}
                step={1}
                unit=""
                activeFilters={activeFilters}
                dispatch={dispatch}
              />
              {(isDonor || isSperm) && (
                <>
                  <FilterSection title="Eye Color">
                    <MultiSelectBubbles
                      options={EYE_COLOR_OPTIONS}
                      selected={activeFilters.eyeColor || []}
                      onToggle={(v) => toggleFilter("eyeColor", v)}
                      testIdPrefix="filter-eye"
                    />
                  </FilterSection>
                  <FilterSection title="Hair Color">
                    <MultiSelectBubbles
                      options={HAIR_COLOR_OPTIONS}
                      selected={activeFilters.hairColor || []}
                      onToggle={(v) => toggleFilter("hairColor", v)}
                      testIdPrefix="filter-hair"
                    />
                  </FilterSection>
                </>
              )}
              {isSurrogate && (
                <RangeFilter
                  label="BMI"
                  filterKey="bmi"
                  min={16}
                  max={40}
                  step={1}
                  unit=""
                  activeFilters={activeFilters}
                  dispatch={dispatch}
                />
              )}
            </>
          )}

          {activeSection === 1 && (
            <>
              <FilterSection title="Race">
                <MultiSelectBubbles
                  options={RACE_OPTIONS}
                  selected={activeFilters.race || []}
                  onToggle={(v) => toggleFilter("race", v)}
                  testIdPrefix="filter-race"
                />
              </FilterSection>
              <FilterSection title="Ethnicity">
                <MultiSelectBubbles
                  options={ETHNICITY_OPTIONS}
                  selected={activeFilters.ethnicity || []}
                  onToggle={(v) => toggleFilter("ethnicity", v)}
                  testIdPrefix="filter-eth"
                />
              </FilterSection>
              {(isDonor || isSperm) && (
                <FilterSection title="Education">
                  <MultiSelectBubbles
                    options={EDUCATION_OPTIONS}
                    selected={activeFilters.education || []}
                    onToggle={(v) => toggleFilter("education", v)}
                    testIdPrefix="filter-edu"
                  />
                </FilterSection>
              )}
              <FilterSection title="Relationship Status">
                <MultiSelectBubbles
                  options={RELATIONSHIP_OPTIONS}
                  selected={activeFilters.relationshipStatus || []}
                  onToggle={(v) => toggleFilter("relationshipStatus", v)}
                  testIdPrefix="filter-rel"
                />
              </FilterSection>
            </>
          )}

          {activeSection === 2 && (
            <>
              {isDonor && (
                <>
                  <RangeFilter
                    label="Donor Compensation"
                    filterKey="donorCompensation"
                    min={0}
                    max={200000}
                    step={5000}
                    unit="$"
                    activeFilters={activeFilters}
                    dispatch={dispatch}
                  />
                  <RangeFilter
                    label="Total Cost"
                    filterKey="maxCost"
                    min={0}
                    max={200000}
                    step={5000}
                    unit="$"
                    activeFilters={activeFilters}
                    dispatch={dispatch}
                  />
                </>
              )}
              {isSurrogate && (
                <RangeFilter
                  label="Base Compensation"
                  filterKey="baseCompensation"
                  min={0}
                  max={200000}
                  step={5000}
                  unit="$"
                  activeFilters={activeFilters}
                  dispatch={dispatch}
                />
              )}
              {isSperm && (
                <RangeFilter
                  label="Max Price"
                  filterKey="maxCost"
                  min={0}
                  max={5000}
                  step={100}
                  unit="$"
                  activeFilters={activeFilters}
                  dispatch={dispatch}
                />
              )}
            </>
          )}

          {activeSection === 3 && (
            <>
              {isDonor && (
                <>
                  <FilterSection title="Egg Type">
                    <MultiSelectBubbles
                      options={EGG_TYPE_OPTIONS}
                      selected={activeFilters.eggType || []}
                      onToggle={(v) => toggleFilter("eggType", v)}
                      testIdPrefix="filter-egg-type"
                    />
                  </FilterSection>
                  <FilterSection title="Donation Type">
                    <MultiSelectBubbles
                      options={DONATION_TYPE_OPTIONS}
                      selected={activeFilters.donationType || []}
                      onToggle={(v) => toggleFilter("donationType", v)}
                      testIdPrefix="filter-donation"
                    />
                  </FilterSection>
                </>
              )}
              {isSurrogate && (
                <>
                  <div className="flex items-center justify-between">
                    <Label className="font-ui" style={{ fontSize: 'var(--badge-text-size, 13px)' }}>Agrees to Twins</Label>
                    <Switch
                      checked={(activeFilters.agreesToTwins || [])[0] === "true"}
                      onCheckedChange={(checked) =>
                        dispatch(setFilter({ key: "agreesToTwins", values: checked ? ["true"] : [] }))
                      }
                      data-testid="switch-twins"
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label className="font-ui" style={{ fontSize: 'var(--badge-text-size, 13px)' }}>COVID Vaccinated</Label>
                    <Switch
                      checked={(activeFilters.covidVaccinated || [])[0] === "true"}
                      onCheckedChange={(checked) =>
                        dispatch(setFilter({ key: "covidVaccinated", values: checked ? ["true"] : [] }))
                      }
                      data-testid="switch-covid"
                    />
                  </div>
                </>
              )}
              {isSperm && (
                <FilterSection title="Donor Type">
                  <MultiSelectBubbles
                    options={["ID Release", "Non-ID Release"]}
                    selected={activeFilters.donorType || []}
                    onToggle={(v) => toggleFilter("donorType", v)}
                    testIdPrefix="filter-donor-type"
                  />
                </FilterSection>
              )}
            </>
          )}
        </div>

        <div className="sticky bottom-0 bg-background border-t border-border pt-4 pb-2">
          <Button
            className="w-full"
            onClick={onClose}
            data-testid="button-apply-filters"
          >
            Apply Filters {activeCount > 0 && `(${activeCount})`}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
