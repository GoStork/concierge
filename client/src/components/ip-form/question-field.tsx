/**
 * Intended Parent Form - one question, rendered by widget type, reusing the
 * app's existing inputs (Input, Textarea, OptionPills, Select, PhoneInput,
 * LocationAutocomplete, NumberInput, Calendar+Popover). The photos widget is
 * a multi-file uploader on top of uploadFile() (no cropping - family photos
 * go into the PDF as-is).
 *
 * Conditional follow-ups are the PARENT page's job (it filters visible
 * questions); this component renders exactly what it's given.
 */
import { useRef, useState } from "react";
import { format } from "date-fns";
import { CalendarIcon, ImagePlus, Loader2, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { OptionPills } from "@/components/ui/option-pills";
import { NumberInput } from "@/components/ui/number-input";
import { PhoneInput } from "@/components/ui/phone-input";
import LocationAutocomplete from "@/components/location-autocomplete";
import { uploadFile } from "@/lib/image-utils";

export interface IpFormQuestionDef {
  id: string;
  key: string;
  label: string;
  helpText?: string | null;
  widget: string;
  options?: string[] | null;
  required: boolean;
}

const EMPTY_LOCATION = { address: "", city: "", state: "", zip: "", country: "" };

export function QuestionField({
  question,
  value,
  onChange,
  disabled,
}: {
  question: IpFormQuestionDef;
  value: any;
  onChange: (value: any) => void;
  disabled?: boolean;
}) {
  const q = question;
  return (
    <div className="space-y-1.5" data-testid={`ipform-q-${q.key}`}>
      <Label className="text-sm font-medium leading-snug">
        {q.label}
        {q.required && <span className="text-destructive ml-0.5">*</span>}
      </Label>
      {q.helpText && <p className="text-xs text-muted-foreground">{q.helpText}</p>}
      <WidgetInput question={q} value={value} onChange={onChange} disabled={disabled} />
    </div>
  );
}

function WidgetInput({ question: q, value, onChange, disabled }: { question: IpFormQuestionDef; value: any; onChange: (v: any) => void; disabled?: boolean }) {
  switch (q.widget) {
    case "textarea":
      return (
        <Textarea
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          rows={q.key === "letter_text" ? 12 : 3}
          className="resize-y"
        />
      );
    case "yes_no":
      return (
        <OptionPills
          options={[{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]}
          value={typeof value === "string" ? value : ""}
          onChange={onChange}
          disabled={disabled}
          allowDeselect
          testIdPrefix={`ipform-${q.key}`}
        />
      );
    case "dropdown": {
      const options = Array.isArray(q.options) ? q.options : [];
      // Short choice lists read better as pills; long lists as a dropdown.
      if (options.length <= 4) {
        return (
          <OptionPills
            options={options.map((o) => ({ value: o, label: o }))}
            value={typeof value === "string" ? value : ""}
            onChange={onChange}
            disabled={disabled}
            allowDeselect
            testIdPrefix={`ipform-${q.key}`}
          />
        );
      }
      return (
        <Select value={typeof value === "string" ? value : ""} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger className="w-full max-w-sm">
            <SelectValue placeholder="Select..." />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o} value={o}>{o}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }
    case "date": {
      const dateVal = typeof value === "string" && value ? new Date(`${value}T12:00:00`) : undefined;
      return (
        <Popover>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" disabled={disabled} className="w-full max-w-sm justify-start font-normal" data-testid={`ipform-date-${q.key}`}>
              <CalendarIcon className="w-4 h-4 mr-2 text-muted-foreground" />
              {dateVal && !isNaN(dateVal.getTime()) ? format(dateVal, "MM/dd/yyyy") : <span className="text-muted-foreground">Pick a date</span>}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="single"
              selected={dateVal && !isNaN(dateVal.getTime()) ? dateVal : undefined}
              onSelect={(d) => onChange(d ? format(d, "yyyy-MM-dd") : "")}
              captionLayout="dropdown-buttons"
              fromYear={1930}
              toYear={new Date().getFullYear() + 15}
              defaultMonth={dateVal && !isNaN(dateVal.getTime()) ? dateVal : new Date(1990, 0)}
            />
          </PopoverContent>
        </Popover>
      );
    }
    case "address": {
      const loc = value && typeof value === "object" && !Array.isArray(value) ? { ...EMPTY_LOCATION, ...value } : EMPTY_LOCATION;
      return <LocationAutocomplete value={loc} onChange={onChange} placeholder="Start typing an address..." />;
    }
    case "phone": {
      const phone = value && typeof value === "object" && !Array.isArray(value) ? value : { e164: "", display: "" };
      return (
        <PhoneInput
          value={phone.e164 || ""}
          displayValue={phone.display || ""}
          onChange={({ e164, display, isValid, isoCode }) => onChange({ e164, display, isValid, isoCode })}
          disabled={disabled}
          data-testid={`ipform-phone-${q.key}`}
        />
      );
    }
    case "number":
      return (
        <div className="max-w-[10rem]">
          <NumberInput value={value == null ? "" : String(value)} onChange={(raw) => onChange(raw)} />
        </div>
      );
    case "photos":
      return <PhotosInput value={Array.isArray(value) ? value : []} onChange={onChange} disabled={disabled} />;
    default:
      return (
        <Input
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="max-w-xl"
        />
      );
  }
}

const MAX_PHOTOS = 10;

function PhotosInput({ value, onChange, disabled }: { value: string[]; onChange: (urls: string[]) => void; disabled?: boolean }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    setUploading(true);
    try {
      const room = MAX_PHOTOS - value.length;
      const picked = Array.from(files).slice(0, Math.max(0, room));
      const urls: string[] = [];
      for (const file of picked) {
        if (!file.type.startsWith("image/")) continue;
        const url = await uploadFile(file, file.name);
        urls.push(url);
      }
      if (urls.length) onChange([...value, ...urls]);
      if (files.length > room) setError(`Up to ${MAX_PHOTOS} photos - extra files were skipped`);
    } catch (e: any) {
      setError(e?.message || "Upload failed - please try again");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {value.map((url, i) => (
            <div key={`${url}-${i}`} className="relative group rounded-[var(--radius)] overflow-hidden border border-border bg-secondary/30 aspect-square">
              <img src={url} alt={`Photo ${i + 1}`} className="w-full h-full object-cover" />
              {!disabled && (
                <button
                  type="button"
                  onClick={() => onChange(value.filter((_, j) => j !== i))}
                  className="absolute top-1.5 right-1.5 rounded-full bg-background/90 border border-border p-1 opacity-80 hover:opacity-100"
                  aria-label="Remove photo"
                  data-testid={`ipform-photo-remove-${i}`}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {!disabled && value.length < MAX_PHOTOS && (
        <div>
          <input ref={inputRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => addFiles(e.target.files)} data-testid="ipform-photo-input" />
          <Button type="button" variant="outline" disabled={uploading} onClick={() => inputRef.current?.click()} data-testid="ipform-photo-add">
            {uploading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <ImagePlus className="w-4 h-4 mr-2" />}
            {value.length ? "Add more photos" : "Upload photos"}
          </Button>
          <p className="text-xs text-muted-foreground mt-1">3-6 warm, natural photos work best. Up to {MAX_PHOTOS}.</p>
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
