/**
 * Chip-style input for string-array fields ("Languages spoken",
 * "Specialties"). Fixes the classic controlled-CSV bug where value =
 * arr.join(", ") re-renders and erases the comma the user just typed:
 * committed values live as chips, the draft is its own uncontrolled text.
 *
 * - Comma or Enter commits the draft as a chip; Backspace on an empty draft
 *   removes the last chip; blur commits whatever is typed.
 * - Optional `suggestions`: while typing, matching entries render as
 *   clickable pills BELOW the input (inline, not an overlay - immune to
 *   overflow-hidden ancestors like Card).
 */
import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";

export const LANGUAGE_SUGGESTIONS = [
  "English", "Spanish", "Mandarin", "Cantonese", "French", "German", "Italian",
  "Portuguese", "Russian", "Ukrainian", "Polish", "Hebrew", "Arabic", "Hindi",
  "Urdu", "Punjabi", "Gujarati", "Bengali", "Tamil", "Telugu", "Japanese",
  "Korean", "Vietnamese", "Thai", "Tagalog", "Farsi", "Turkish", "Greek",
  "Dutch", "Swedish", "Norwegian", "Danish", "Czech", "Romanian", "Hungarian",
  "Armenian", "Georgian", "Amharic", "Swahili", "American Sign Language (ASL)",
];

export function TagListInput({
  value,
  onChange,
  suggestions,
  placeholder,
  className,
  "data-testid": testId,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
  className?: string;
  "data-testid"?: string;
}) {
  const [draft, setDraft] = useState("");

  const commit = (raw: string) => {
    const tag = raw.trim().replace(/,+$/, "").trim();
    if (!tag) return;
    if (value.some((v) => v.toLowerCase() === tag.toLowerCase())) {
      setDraft("");
      return;
    }
    onChange([...value, tag]);
    setDraft("");
  };

  const matches = useMemo(() => {
    if (!suggestions || !draft.trim()) return [];
    const q = draft.trim().toLowerCase();
    return suggestions
      .filter((s) => s.toLowerCase().includes(q))
      .filter((s) => !value.some((v) => v.toLowerCase() === s.toLowerCase()))
      .slice(0, 8);
  }, [suggestions, draft, value]);

  return (
    <div className="space-y-1.5">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 pl-2.5 pr-1.5 py-0.5 rounded-full bg-secondary text-secondary-foreground text-xs font-ui"
              data-testid={testId ? `${testId}-tag-${tag}` : undefined}
            >
              {tag}
              <button
                type="button"
                className="rounded-full p-0.5 hover:bg-foreground/10"
                onClick={() => onChange(value.filter((v) => v !== tag))}
                aria-label={`Remove ${tag}`}
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <Input
        value={draft}
        onChange={(e) => {
          const v = e.target.value;
          // A pasted "a, b, c" commits everything before the last comma.
          if (v.includes(",")) {
            const parts = v.split(",");
            const rest = parts.pop() ?? "";
            let next = [...value];
            for (const p of parts) {
              const tag = p.trim();
              if (tag && !next.some((x) => x.toLowerCase() === tag.toLowerCase())) next = [...next, tag];
            }
            onChange(next);
            setDraft(rest.trimStart());
          } else {
            setDraft(v);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit(draft);
          } else if (e.key === "Backspace" && !draft && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => commit(draft)}
        placeholder={value.length ? undefined : placeholder}
        className={className}
        data-testid={testId}
      />
      {matches.length > 0 && (
        <div className="flex flex-wrap gap-1.5" data-testid={testId ? `${testId}-suggestions` : undefined}>
          {matches.map((s) => (
            <button
              key={s}
              type="button"
              // onMouseDown so the click wins over the input's onBlur commit.
              onMouseDown={(e) => {
                e.preventDefault();
                commit(s);
              }}
              className="px-2.5 py-0.5 rounded-full border border-[hsl(var(--primary)/0.35)] text-[hsl(var(--primary))] text-xs font-ui hover:bg-[hsl(var(--primary)/0.08)] transition-colors"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
