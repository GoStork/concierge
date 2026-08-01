// Stateful sentence chunker between the tag-stripper and TTS. Buffers stripped
// text and flushes a chunk to the TTS stream at a sentence boundary (., !, ?
// followed by whitespace/end) or when the buffer exceeds MAX_CHUNK chars, so
// the first sentence starts speaking while the model is still streaming.

const MAX_CHUNK = 150;
// Boundary = sentence punctuation followed by whitespace. Trailing punctuation
// without whitespace is NOT a boundary yet ("$4." could be "$4.5" mid-stream).
const BOUNDARY = /[.!?][)"']?\s/g;
// The FIRST chunk of a reply also flushes at a clause break (comma/colon)
// once it has enough words - time-to-first-audio matters more than perfect
// prosody on the opening clause.
const FIRST_CHUNK_CLAUSE = /[,;:]\s/g;
const FIRST_CHUNK_MIN = 40;

export class SentenceChunker {
  private buf = "";
  private emittedFirst = false;

  constructor(private readonly onChunk: (sentence: string) => void) {}

  push(text: string): void {
    this.buf += text;
    let idx: number;
    while ((idx = this.lastBoundary()) >= 0) {
      const chunk = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx);
      if (chunk) this.emit(chunk + " ");
    }
    if (!this.emittedFirst && this.buf.length >= FIRST_CHUNK_MIN) {
      FIRST_CHUNK_CLAUSE.lastIndex = 0;
      let clause = -1;
      let m: RegExpExecArray | null;
      while ((m = FIRST_CHUNK_CLAUSE.exec(this.buf)) !== null) {
        if (m.index + m[0].length >= FIRST_CHUNK_MIN) {
          clause = m.index + m[0].length;
          break;
        }
        clause = m.index + m[0].length;
      }
      if (clause >= 0) {
        const chunk = this.buf.slice(0, clause).trim();
        this.buf = this.buf.slice(clause);
        if (chunk) this.emit(chunk + " ");
      }
    }
    if (this.buf.length > MAX_CHUNK) {
      // No boundary but too long - flush at the last whitespace to avoid
      // splitting a word.
      const ws = this.buf.lastIndexOf(" ");
      const cut = ws > 40 ? ws : this.buf.length;
      const chunk = this.buf.slice(0, cut).trim();
      this.buf = this.buf.slice(cut);
      if (chunk) this.emit(chunk + " ");
    }
  }

  private emit(chunk: string): void {
    this.emittedFirst = true;
    this.onChunk(chunk);
  }

  // End of reply: flush whatever remains.
  flush(): void {
    const rest = this.buf.trim();
    this.buf = "";
    if (rest) this.emit(rest + " ");
  }

  reset(): void {
    this.buf = "";
    this.emittedFirst = false;
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
