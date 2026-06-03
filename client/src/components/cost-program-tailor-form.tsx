import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Loader2, Sparkles, ChevronDown, ChevronUp } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

/**
 * Inline questionnaire that fills the cost-programs gap when a parent
 * lands on a provider profile without enough profile data for the matcher
 * to surface relevant programs. Quick-reply chips for every field the
 * matcher reads, plus a "skip and show me everything" checkbox that flips
 * the page into showAll mode.
 *
 * Per the project rule (no modals/popups/dialogs), this is an inline
 * expandable section that lives where the empty state used to be - not
 * a drawer or overlay.
 */

interface UserProfileShape {
  gender?: string | null;
  partnerGender?: string | null;
  relationshipStatus?: string | null;
}

interface IpProfileShape {
  interestedServices?: string[] | null;
  eggSource?: string | null;
  spermSource?: string | null;
  carrier?: string | null;
  hasEmbryos?: boolean | null;
}

const SERVICE_CHIPS = ["Fertility Clinic", "Egg Donor", "Surrogate", "Sperm Donor"];
const GENDER_CHIPS = [
  { value: "I'm a woman", label: "Woman" },
  { value: "I'm a man", label: "Man" },
  { value: "I'm non-binary", label: "Non-binary" },
];
const PARTNER_GENDER_CHIPS = [
  { value: "woman", label: "Woman" },
  { value: "man", label: "Man" },
];
const RELATIONSHIP_CHIPS = ["Single", "Partnered", "Married"];
const EGG_SOURCE_CHIPS = ["Own eggs", "Partner eggs", "Egg donor"];
const SPERM_SOURCE_CHIPS = ["My sperm", "Partner sperm", "Sperm donor"];
const CARRIER_CHIPS = ["Self", "Partner", "Gestational surrogate"];
const EMBRYO_CHIPS = [
  { value: "yes", label: "Yes, we have embryos" },
  { value: "no", label: "Not yet" },
];

interface ChipRowProps {
  options: Array<string | { value: string; label: string }>;
  selected: string | string[];
  multi?: boolean;
  onSelect: (val: string) => void;
  testIdPrefix: string;
}

function ChipRow({ options, selected, multi, onSelect, testIdPrefix }: ChipRowProps) {
  const isSelected = (v: string) => (multi ? Array.isArray(selected) && selected.includes(v) : selected === v);
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((opt) => {
        const value = typeof opt === "string" ? opt : opt.value;
        const label = typeof opt === "string" ? opt : opt.label;
        const active = isSelected(value);
        return (
          <button
            key={value}
            type="button"
            onClick={() => onSelect(value)}
            className={cn(
              "px-3 py-1.5 rounded-full text-sm border transition-colors font-ui",
              active
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-foreground border-border hover:border-primary/50",
            )}
            data-testid={`${testIdPrefix}-${value.toLowerCase().replace(/\s+/g, "-")}`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

export function CostProgramTailorForm({
  parentAccountId,
  onSaved,
  onSkip,
}: {
  parentAccountId: string;
  onSaved: () => void;
  onSkip: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);

  // Pull the parent's current profile + IP profile so the form pre-fills
  // anything they've already answered (no double-asking). Only fetches
  // once the section is expanded - keeps the empty-state render cheap
  // when most users won't bother to expand.
  const userQuery = useQuery<UserProfileShape>({
    queryKey: ["/api/user"],
    queryFn: async () => {
      const res = await fetch("/api/user", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load user");
      return res.json();
    },
    enabled: expanded,
  });

  const ipQuery = useQuery<IpProfileShape>({
    queryKey: ["/api/parent-profile"],
    queryFn: async () => {
      const res = await fetch(`/api/parent-profile`, { credentials: "include" });
      if (!res.ok) return {};
      return res.json();
    },
    enabled: expanded,
  });

  // Form state - initialized from existing profile values whenever the
  // queries resolve. Empty string means "user hasn't picked yet".
  const [services, setServices] = useState<string[]>([]);
  const [gender, setGender] = useState("");
  const [partnerGender, setPartnerGender] = useState("");
  const [relationship, setRelationship] = useState("");
  const [eggSource, setEggSource] = useState("");
  const [spermSource, setSpermSource] = useState("");
  const [carrier, setCarrier] = useState("");
  const [hasEmbryos, setHasEmbryos] = useState("");
  const [skip, setSkip] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    setServices(ipQuery.data?.interestedServices ?? []);
    setEggSource(ipQuery.data?.eggSource ?? "");
    setSpermSource(ipQuery.data?.spermSource ?? "");
    setCarrier(ipQuery.data?.carrier ?? "");
    setHasEmbryos(
      ipQuery.data?.hasEmbryos === true ? "yes" : ipQuery.data?.hasEmbryos === false ? "no" : "",
    );
    setGender(userQuery.data?.gender ?? "");
    setPartnerGender(userQuery.data?.partnerGender ?? "");
    setRelationship(userQuery.data?.relationshipStatus ?? "");
  }, [expanded, ipQuery.data, userQuery.data]);

  const saveMutation = useMutation({
    mutationFn: async ({ markAs }: { markAs: "tailored" | "show_all" }) => {
      const payload: any = {};
      // Record the parent's decision so we never re-render this form on
      // any future provider profile. "tailored" = they answered;
      // "show_all" = they skipped and want the unfiltered catalog. Both
      // values are read by getProviderParentPrograms server-side.
      payload.costProgramsPreference = markAs;
      // Only persist the answers themselves when the parent actually
      // filled the form. Skipping should NOT overwrite any fields they
      // may have set elsewhere.
      if (markAs === "tailored") {
        payload.interestedServices = services;
        if (gender) payload.gender = gender;
        if (relationship) payload.relationshipStatus = relationship;
        const hasPartner = relationship === "Partnered" || relationship === "Married";
        payload.partnerGender = hasPartner ? (partnerGender || null) : null;
        if (eggSource) payload.eggSource = eggSource;
        if (spermSource) payload.spermSource = spermSource;
        if (carrier) payload.carrier = carrier;
        if (hasEmbryos === "yes") payload.hasEmbryos = true;
        else if (hasEmbryos === "no") payload.hasEmbryos = false;
      }
      await apiRequest("PUT", "/api/user/profile", payload);
    },
    onSuccess: () => {
      // Invalidate every query that depends on the parent's profile so
      // the cost programs section, account page, and any other surface
      // pick up the new answers immediately.
      queryClient.invalidateQueries({ queryKey: ["/api/user"] });
      queryClient.invalidateQueries({ queryKey: ["/api/parent-profile"] });
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      queryClient.invalidateQueries({
        queryKey: ["/api/costs/provider"],
        exact: false,
      });
      toast({ title: "Saved", description: "Showing cost programs tailored to you.", variant: "success" });
      onSaved();
    },
    onError: (err: any) => {
      toast({ title: "Couldn't save", description: err.message, variant: "destructive" });
    },
  });

  const handleSubmit = () => {
    saveMutation.mutate(
      { markAs: skip ? "show_all" : "tailored" },
      {
        onSuccess: () => {
          if (skip) onSkip();
          // onSaved is already called by the mutation's own onSuccess
          // (which invalidates the cost-programs query); for skip path
          // we additionally flip the session-level showAll so the
          // current page re-renders without waiting for the round trip.
        },
      },
    );
  };

  const hasPartner = relationship === "Partnered" || relationship === "Married";

  return (
    <Card className="border-accent/40 bg-accent/5">
      <CardContent className="p-6 space-y-4">
        <div className="flex items-start gap-3">
          <Sparkles className="w-5 h-5 text-accent mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <h3 className="font-heading text-base text-foreground">
              Help us tailor the cost programs for you
            </h3>
            <p className="text-sm text-muted-foreground mt-1">
              We need a few details about your journey to show the programs that match your situation.
              Or skip the questions and we'll show you everything this provider has published.
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded((v) => !v)}
            data-testid="btn-toggle-tailor-form"
          >
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </Button>
        </div>

        {expanded && (
          <div className="space-y-5 pt-2" data-testid="tailor-form-body">
            <div className="space-y-2">
              <Label className="text-sm">What are you looking for?</Label>
              <ChipRow
                options={SERVICE_CHIPS}
                selected={services}
                multi
                onSelect={(v) =>
                  setServices((prev) => (prev.includes(v) ? prev.filter((s) => s !== v) : [...prev, v]))
                }
                testIdPrefix="chip-service"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div className="space-y-2">
                <Label className="text-sm">Your gender identity</Label>
                <ChipRow options={GENDER_CHIPS} selected={gender} onSelect={setGender} testIdPrefix="chip-gender" />
              </div>

              <div className="space-y-2">
                <Label className="text-sm">Relationship status</Label>
                <ChipRow
                  options={RELATIONSHIP_CHIPS}
                  selected={relationship}
                  onSelect={setRelationship}
                  testIdPrefix="chip-relationship"
                />
              </div>
            </div>

            {hasPartner && (
              <div className="space-y-2">
                <Label className="text-sm">Partner's gender</Label>
                <ChipRow
                  options={PARTNER_GENDER_CHIPS}
                  selected={partnerGender}
                  onSelect={setPartnerGender}
                  testIdPrefix="chip-partner-gender"
                />
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div className="space-y-2">
                <Label className="text-sm">Egg source</Label>
                <ChipRow
                  options={EGG_SOURCE_CHIPS}
                  selected={eggSource}
                  onSelect={setEggSource}
                  testIdPrefix="chip-egg-source"
                />
              </div>

              <div className="space-y-2">
                <Label className="text-sm">Sperm source</Label>
                <ChipRow
                  options={SPERM_SOURCE_CHIPS}
                  selected={spermSource}
                  onSelect={setSpermSource}
                  testIdPrefix="chip-sperm-source"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div className="space-y-2">
                <Label className="text-sm">Who will carry?</Label>
                <ChipRow
                  options={CARRIER_CHIPS}
                  selected={carrier}
                  onSelect={setCarrier}
                  testIdPrefix="chip-carrier"
                />
              </div>

              <div className="space-y-2">
                <Label className="text-sm">Do you already have embryos?</Label>
                <ChipRow
                  options={EMBRYO_CHIPS}
                  selected={hasEmbryos}
                  onSelect={setHasEmbryos}
                  testIdPrefix="chip-embryos"
                />
              </div>
            </div>

            <div className="flex items-start gap-2 pt-2 border-t border-border/60">
              <Checkbox
                id="tailor-skip"
                checked={skip}
                onCheckedChange={(v) => setSkip(v === true)}
                data-testid="checkbox-skip-tailor"
              />
              <Label htmlFor="tailor-skip" className="text-sm cursor-pointer leading-tight">
                Skip these questions and just show me every cost program this provider has published.
                <span className="block text-xs text-muted-foreground mt-0.5">
                  You can answer them later from your settings page.
                </span>
              </Label>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setExpanded(false)}
                disabled={saveMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleSubmit}
                disabled={saveMutation.isPending}
                data-testid="btn-tailor-submit"
              >
                {saveMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                ) : null}
                {skip ? "Show me everything" : "Save & show programs"}
              </Button>
            </div>
          </div>
        )}

        {!expanded && (
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setExpanded(true)} data-testid="btn-open-tailor-form">
              Tell us about you
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
