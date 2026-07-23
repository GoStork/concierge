/**
 * Debounced async autocomplete used by the IP form's clinic + RE fields.
 * Suggests from a remote source but ALWAYS allows free text (parents whose
 * clinic/doctor isn't in our directory just type it).
 */
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";

export function AsyncAutocomplete<T>({
  value,
  onChangeText,
  onSelect,
  fetchItems,
  itemLabel,
  renderItem,
  placeholder,
  disabled,
  minChars = 2,
  testId,
}: {
  value: string;
  /** Free-text edits (every keystroke). */
  onChangeText: (text: string) => void;
  /** A suggestion was picked. */
  onSelect: (item: T) => void;
  fetchItems: (query: string) => Promise<T[]>;
  /** Text to place in the input when an item is picked. */
  itemLabel: (item: T) => string;
  renderItem: (item: T) => React.ReactNode;
  placeholder?: string;
  disabled?: boolean;
  minChars?: number;
  testId?: string;
}) {
  const [query, setQuery] = useState(value || "");
  const [items, setItems] = useState<T[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  // Highlight is tracked explicitly (not CSS :hover) so it reliably follows
  // the mouse and clears when the list re-renders under a stationary cursor.
  const [hoverIdx, setHoverIdx] = useState(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const containerRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  useEffect(() => setQuery(value || ""), [value]);
  useEffect(() => { setHoverIdx(-1); }, [items]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const search = (q: string) => {
    if (q.trim().length < minChars) {
      setItems([]);
      setOpen(false);
      return;
    }
    const mySeq = ++seq.current;
    setLoading(true);
    fetchItems(q.trim())
      .then((res) => {
        if (mySeq !== seq.current) return; // stale response
        setItems(res);
        setOpen(res.length > 0);
      })
      .catch(() => { if (mySeq === seq.current) { setItems([]); setOpen(false); } })
      .finally(() => { if (mySeq === seq.current) setLoading(false); });
  };

  const handleInput = (v: string) => {
    setQuery(v);
    onChangeText(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(v), 300);
  };

  const pick = (item: T) => {
    setQuery(itemLabel(item));
    onSelect(item);
    setOpen(false);
    setItems([]);
  };

  return (
    <div ref={containerRef} className="relative">
      <Input
        value={query}
        onChange={(e) => handleInput(e.target.value)}
        // minChars 0 (a clinic is selected) => show its list on focus even
        // with an empty query.
        onFocus={() => { if (items.length) setOpen(true); else if (minChars === 0) search(query); }}
        placeholder={placeholder}
        disabled={disabled}
        data-testid={testId}
      />
      {loading && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-muted-foreground" />}
      {open && items.length > 0 && (
        <div
          className="absolute z-50 top-full left-0 right-0 mt-1 bg-popover border border-border rounded-[var(--radius)] shadow-lg max-h-60 overflow-y-auto"
          onMouseLeave={() => setHoverIdx(-1)}
        >
          {items.map((it, i) => (
            <button
              key={i}
              type="button"
              className={`w-full text-left px-3 py-2 text-sm ${hoverIdx === i ? "bg-secondary" : ""}`}
              onMouseEnter={() => setHoverIdx(i)}
              onMouseMove={() => { if (hoverIdx !== i) setHoverIdx(i); }}
              onMouseDown={(e) => { e.preventDefault(); pick(it); }}
              data-testid={`${testId}-option-${i}`}
            >
              {renderItem(it)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
