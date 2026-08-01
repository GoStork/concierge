// Server-side port of the client's stripStreamingTags
// (client/src/pages/concierge-chat-page.tsx ~:4219). Keep the two in sync:
// complete [[...]] structured tags are removed entirely, and a trailing
// INCOMPLETE tag ("[[CURA") is held back until it closes, so tag contents are
// never spoken aloud mid-stream.
//
// Stateful streaming wrapper: push() receives raw token deltas and returns
// only the NEW safe (stripped) text since the previous call.
export function stripTags(raw: string): string {
  return raw.replace(/\[\[[\s\S]*?\]\]/g, "").replace(/\[\[[\s\S]*$/, "");
}

export class StreamingTagStripper {
  private raw = "";
  private emitted = 0;

  // Feed a raw delta; get back the newly-safe stripped text (may be "").
  push(delta: string): string {
    this.raw += delta;
    const stripped = stripTags(this.raw);
    if (stripped.length <= this.emitted) return "";
    const fresh = stripped.slice(this.emitted);
    this.emitted = stripped.length;
    return fresh;
  }

  // Everything safe emitted so far (for empty-reply detection at done).
  emittedText(): string {
    return stripTags(this.raw);
  }

  reset(): void {
    this.raw = "";
    this.emitted = 0;
  }
}
