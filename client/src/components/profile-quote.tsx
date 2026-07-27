import { Quote } from "lucide-react";

/**
 * One line of hers, at the top of the page.
 *
 * Everything above the fold is measurement - age, height, education, cost -
 * and the writing that actually makes a parent feel something about a person
 * sits below twenty rows of it. This puts her voice where the decision is
 * actually being made, without pretending to summarise her: the full letter is
 * still there, unedited, further down.
 *
 * The sentence is chosen once during enrichment and stored (see
 * server/src/modules/providers/highlight-quote.ts), and is verified to appear
 * verbatim in what she wrote. Nothing here paraphrases her.
 */

export function ProfileQuote({ quote, className }: { quote?: string | null; className?: string }) {
  const text = (quote || "").trim();
  if (!text) return null;

  return (
    <figure
      className={`rounded-[var(--radius)] bg-secondary/70 px-4 py-3.5 flex gap-3 ${className || ""}`}
      data-testid="profile-quote"
    >
      <Quote className="w-4 h-4 shrink-0 mt-1 text-accent" aria-hidden />
      <blockquote className="t-prompt-answer italic">{text}</blockquote>
    </figure>
  );
}
