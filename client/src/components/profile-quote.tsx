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

import { Quote } from "lucide-react";

export function ProfileQuote({ quote, className }: { quote?: string | null; className?: string }) {
  const text = (quote || "").trim();
  if (!text) return null;

  return (
    <figure
      // Prose needs a measure. Unconstrained, one sentence ran the full 1400px
      // of a desktop page as a single line, which is read as a banner rather
      // than as something a person wrote.
      className={`rounded-[var(--radius)] bg-secondary/70 px-4 py-3.5 flex gap-3 max-w-[68ch] ${className || ""}`}
      data-testid="profile-quote"
    >
      {/* A matched pair of the same mark. This is a verbatim quotation of
          something a person actually wrote, so it is punctuated as one - an
          opening mark with no closing mark reads as a design flourish, which
          quietly undersells that these are her words and not our copy. The
          closing mark is the same glyph turned 180 degrees. */}
      {/* lucide's Quote glyph is a CLOSING mark, so the OPENING one is the
          rotated copy - not the other way round, which is how it shipped and
          gave the sentence two closing marks pointing the wrong way. */}
      <Quote className="w-4 h-4 shrink-0 mt-1 text-accent rotate-180" aria-hidden />
      <blockquote className="t-prompt-answer italic">
        {text}
        <Quote className="w-4 h-4 inline-block ml-1 -mb-0.5 text-accent" aria-hidden />
      </blockquote>
    </figure>
  );
}
