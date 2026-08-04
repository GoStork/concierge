// Server-side spoken-length ceiling + speech normalization for voice turns.
//
// The VOICE MODE prompt caps ("2 short sentences") are requests to a language
// model - measured live being ignored: 19-62 second monologues, one 197s
// (sessions fj7qre, mnyo9j). This is the CODE control: complete sentences
// pass through until the word budget is spent; the first sentence past the
// budget becomes a short deferral line and the remainder is dropped from
// SPEECH ONLY. The router persists the full reply to the chat transcript
// regardless of what the gateway speaks, so nothing is lost - it just is not
// read aloud.

const ORDINAL_WORDS: Record<string, string> = {
  "1": "First",
  "2": "Second",
  "3": "Third",
  "4": "Fourth",
  "5": "Fifth",
  "6": "Sixth",
  "7": "Seventh",
  "8": "Eighth",
  "9": "Ninth",
  "10": "Tenth",
};

// Fixes measured with real audio (recording iPhone 7.MOV, session mnyo9j):
// numbered-list markers spoken as bare digits ("journey: one."), markdown
// asterisks reaching captions, and Cartesia pronouncing "GoStork" as
// something like "GhostOrg".
export function normalizeSpeech(text: string): string {
  return (
    text
      // markdown emphasis/backticks/headers never reach the voice or captions
      .replace(/[*_`#]+/g, "")
      // numbered-list markers after a sentence boundary (or reply start) read
      // as "one." "two." - speak ordinals instead
      .replace(
        /(^|[.!?:…]["')\]]?\s+)(\d{1,2})\.\s+/g,
        (_m, pre: string, n: string) => `${pre}${ORDINAL_WORDS[n] || "Next"}, `,
      )
      // force the two-word reading
      .replace(/\bGoStork\b/g, "Go Stork")
  );
}

export class SpokenBudget {
  private acc = "";
  private spokenWords = 0;
  private cutDone = false;

  constructor(private readonly limitWords: number) {}

  // Feed streamed text; returns the (normalized) text cleared for speech now.
  // Only COMPLETE sentences are released - the budget decision is made per
  // sentence, never mid-sentence, so the cut can never clip a word.
  push(text: string): string {
    this.acc += text;
    let out = "";
    for (;;) {
      const m = /^([\s\S]*?[.!?…]["')\]]?)(\s+)/.exec(this.acc);
      if (!m) break;
      const sentence = m[1] + m[2];
      this.acc = this.acc.slice(sentence.length);
      out += this.admit(sentence);
    }
    return out;
  }

  // End of stream: whatever remains is the final (unterminated) sentence.
  flush(): string {
    const rest = this.acc;
    this.acc = "";
    return rest.trim() ? this.admit(rest) : "";
  }

  // An interceptor replaced the reply - the replacement gets the full budget.
  reset(): void {
    this.acc = "";
    this.spokenWords = 0;
    this.cutDone = false;
  }

  get truncated(): boolean {
    return this.cutDone;
  }

  private admit(sentence: string): string {
    if (this.spokenWords >= this.limitWords) {
      if (!this.cutDone) {
        this.cutDone = true;
        return "I've put the full details in our chat. ";
      }
      return "";
    }
    this.spokenWords += sentence.split(/\s+/).filter(Boolean).length;
    return normalizeSpeech(sentence);
  }
}
