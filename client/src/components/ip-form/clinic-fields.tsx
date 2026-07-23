/**
 * Fertility Clinic section fields backed by our directory:
 *  - ClinicNameField: autocomplete against IVF clinics (any approval status);
 *    stores { name, providerId } so the RE + address pickers can scope to it.
 *    Free text is fine (providerId null).
 *  - DoctorNameField: autocomplete the RE against the selected clinic's doctors
 *    (or a global name search). Free text fine.
 *  - ClinicAddressField: quick-pick the clinic's saved addresses, or enter one
 *    manually (reuses the normal address widget).
 */
import { useEffect, useState } from "react";
import { MapPin } from "lucide-react";
import { Label } from "@/components/ui/label";
import { AsyncAutocomplete } from "@/components/ip-form/async-autocomplete";
import { QuestionField, IpFormQuestionDef } from "@/components/ip-form/question-field";

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

function FieldLabel({ question }: { question: IpFormQuestionDef }) {
  return (
    <Label className="text-sm font-medium leading-snug">
      {question.label}
      {question.required && <span className="text-destructive ml-0.5">*</span>}
    </Label>
  );
}

interface ClinicNameValue { name?: string; providerId?: string | null }

export function clinicProviderIdOf(value: any): string | null {
  return value && typeof value === "object" ? value.providerId || null : null;
}
function clinicNameText(value: any): string {
  if (!value) return "";
  if (typeof value === "string") return value; // legacy plain-string answers
  return value.name || "";
}

export function ClinicNameField({ question, value, onChange, disabled }: { question: IpFormQuestionDef; value: any; onChange: (v: ClinicNameValue) => void; disabled?: boolean }) {
  return (
    <div className="space-y-1.5" data-testid="ipform-clinic-name">
      <FieldLabel question={question} />
      <AsyncAutocomplete<{ id: string; name: string }>
        value={clinicNameText(value)}
        onChangeText={(text) => onChange({ name: text, providerId: null })}
        onSelect={(c) => onChange({ name: c.name, providerId: c.id })}
        fetchItems={async (q) => (await getJson(`/api/ip-form/clinic-search?q=${encodeURIComponent(q)}`))?.clinics || []}
        itemLabel={(c) => c.name}
        renderItem={(c) => c.name}
        placeholder="Start typing your clinic..."
        disabled={disabled}
        testId="ipform-clinic-search"
      />
    </div>
  );
}

export function DoctorNameField({ question, value, providerId, onChange, disabled }: { question: IpFormQuestionDef; value: any; providerId: string | null; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <div className="space-y-1.5" data-testid="ipform-re-name">
      <FieldLabel question={question} />
      <AsyncAutocomplete<{ name: string; title: string | null }>
        value={typeof value === "string" ? value : ""}
        onChangeText={(text) => onChange(text)}
        onSelect={(d) => onChange(d.name)}
        // With a clinic selected, an empty query still lists that clinic's
        // doctors; otherwise it's a global name search.
        fetchItems={async (q) => (await getJson(`/api/ip-form/doctor-search?q=${encodeURIComponent(q)}${providerId ? `&providerId=${providerId}` : ""}`))?.doctors || []}
        itemLabel={(d) => d.name}
        renderItem={(d) => (
          <span>
            {d.name}
            {d.title ? <span className="text-muted-foreground"> - {d.title}</span> : null}
          </span>
        )}
        placeholder={providerId ? "Start typing, or pick from this clinic..." : "Start typing the doctor's name..."}
        disabled={disabled}
        minChars={providerId ? 0 : 2}
        testId="ipform-re-search"
      />
    </div>
  );
}

interface AddressValue { address?: string; city?: string; state?: string; zip?: string; country?: string; apt?: string }

export function ClinicAddressField({ question, value, providerId, onChange, disabled }: { question: IpFormQuestionDef; value: any; providerId: string | null; onChange: (v: AddressValue) => void; disabled?: boolean }) {
  const [locations, setLocations] = useState<AddressValue[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!providerId) { setLocations([]); return; }
    getJson(`/api/ip-form/clinic-locations?providerId=${providerId}`).then((r) => {
      if (!cancelled) setLocations(r?.locations || []);
    });
    return () => { cancelled = true; };
  }, [providerId]);

  return (
    <div className="space-y-1.5" data-testid="ipform-clinic-address">
      <FieldLabel question={question} />
      {!disabled && locations.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <span className="text-xs text-muted-foreground w-full">Use one of this clinic's addresses:</span>
          {locations.map((loc, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onChange(loc)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border border-border bg-background hover:border-primary/50 hover:bg-secondary/40 text-left"
              data-testid={`ipform-clinic-address-chip-${i}`}
            >
              <MapPin className="w-3 h-3 text-muted-foreground shrink-0" />
              {[loc.address, loc.city, loc.state].filter(Boolean).join(", ")}
            </button>
          ))}
        </div>
      )}
      <QuestionField question={question} value={value} onChange={onChange} disabled={disabled} hideLabel />
    </div>
  );
}
