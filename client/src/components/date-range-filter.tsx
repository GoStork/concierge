import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Calendar as CalendarIcon } from "lucide-react";
import { Calendar as CalendarPicker } from "@/components/ui/calendar";

// Shared From/To date-range filter: two pill buttons that open the brand
// calendar directly (no intermediate date input). Used by the invoices /
// cost-sheets / payouts / agreements pages and the Parents tables. Values
// are yyyy-mm-dd strings (LOCAL time - toISOString would shift the day).

export function toDateParam(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** from-inclusive start of day / to-inclusive end of day check */
export function inDateRange(iso: string | null | undefined, from: string, to: string): boolean {
  if (!from && !to) return true;
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (from && t < new Date(`${from}T00:00:00`).getTime()) return false;
  if (to && t > new Date(`${to}T23:59:59.999`).getTime()) return false;
  return true;
}

function DateButton({ value, placeholder, onChange, testId }: { value: string; placeholder: string; onChange: (v: string) => void; testId?: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant={value ? "default" : "outline"} size="sm" className="shrink-0 h-9 text-xs rounded-full gap-1" data-testid={testId}>
          <CalendarIcon className="w-3 h-3" />
          {value || placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <CalendarPicker
          mode="single"
          selected={value ? new Date(`${value}T00:00:00`) : undefined}
          onSelect={(d) => onChange(d ? toDateParam(d) : "")}
        />
        {value && (
          <div className="border-t px-3 py-2">
            <Button variant="ghost" size="sm" className="text-xs h-6 w-full" onClick={() => onChange("")}>
              Clear
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function DateRangeFilter({ from, to, onFrom, onTo, testIdPrefix = "date" }: { from: string; to: string; onFrom: (v: string) => void; onTo: (v: string) => void; testIdPrefix?: string }) {
  return (
    <>
      <DateButton value={from} placeholder="From" onChange={onFrom} testId={`${testIdPrefix}-from`} />
      <DateButton value={to} placeholder="To" onChange={onTo} testId={`${testIdPrefix}-to`} />
    </>
  );
}
