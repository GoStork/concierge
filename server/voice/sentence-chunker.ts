// Stateful sentence chunker between the tag-stripper and TTS. Buffers stripped
// text and flushes a chunk to the TTS stream at a sentence boundary (., !, ?
// followed by whitespace/end) or when the buffer exceeds MAX_CHUNK chars, so
// the first sentence starts speaking while the model is still streaming.

const MAX_CHUNK = 150;
// Boundary = sentence punctuation followed by whitespace. Trailing punctuation
// without whitespace is NOT a boundary yet ("$4." could be "$4.5" mid-stream).
const BOUNDARY = /[.!?][)"']?\s/g;

export class SentenceChunker {
  private buf = "";

  constructor(private readonly onChunk: (sentence: string) => void) {}

  push(text: string): void {
    this.buf += text;
    let idx: number;
    while ((idx = this.lastBoundary()) >= 0) {
      const chunk = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx);
      if (chunk) this.onChunk(chunk + " ");
    }
    if (this.buf.length > MAX_CHUNK) {
      // No boundary but too long - flush at the last whitespace to avoid
      // splitting a word.
      const ws = this.buf.lastIndexOf(" ");
      const cut = ws > 40 ? ws : this.buf.length;
      const chunk = this.buf.slice(0, cut).trim();
      this.buf = this.buf.slice(cut);
      if (chunk) this.onChunk(chunk + " ");
    }
  }

  // End of reply: flush whatever remains.
  flush(): void {
    const rest = this.buf.trim();
    this.buf = "";
    if (rest) this.onChunk(rest + " ");
  }

  reset(): void {
    this.buf = "";
  }

  private lastBoundary(): number {
    BOUNDARY.lastIndex = 0;
    let last = -1;
    let m: RegExpExecArray | null;
    while ((m = BOUNDARY.exec(this.buf)) !== null) {
      last = m.index + m[0].length;
    }
    return last;
  }
}
