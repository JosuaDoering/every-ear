// Turns a growing (cumulative) transcript into committed sentence chunks.
//
// Web Speech yields cumulative interim+final results ("Hello" → "Hello world."),
// so we track how much of the buffer has already been emitted (`committedLen`)
// and only ever look at the uncommitted tail. A chunk is emitted either when the
// tail ends a sentence, or after a short silence (flush timeout) so speakers who
// don't pause on clear punctuation still get translated.

export type Chunk = { id: number; text: string };

const MIN_CHUNK_LEN = 12;
const FLUSH_TIMEOUT_MS = 800;

/**
 * Speech content of a fragment, counting CJK / full-width characters double.
 * A Japanese or Chinese sentence of 12 characters carries far more speech than
 * 12 Latin letters, so a plain `length` check would merge several sentences
 * into one translation chunk. Emoji/zero-width marks are ignored.
 */
function speechLen(text: string): number {
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x20 || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfeff) continue;
    n += cp >= 0x2e80 ? 2 : 1;
  }
  return n;
}
// Sentence/clause terminators, incl. CJK full-width forms, Devanagari danda
// (Hindi), Arabic question mark and Ethiopic full stop, plus newline.
const TERMINATORS = /[.!?…。！？।॥؟።\n]/;

/**
 * Length of the shortest prefix of `tail` that ends a sentence and is long
 * enough to translate, or -1. Short fragments ("Dr." or "Ja.") are skipped so
 * they are merged into the following sentence instead of sent alone.
 */
function firstCommittableTerms(tail: string): number {
  for (let i = 0; i < tail.length; i++) {
    if (!TERMINATORS.test(tail[i]!)) continue;
    const len = i + 1;
    if (speechLen(tail.slice(0, len)) >= MIN_CHUNK_LEN) return len;
  }
  return -1;
}

export class SentenceChunker {
  private buffer = "";
  private committedLen = 0;
  private nextId = 1;
  private flushTimer: number | null = null;

  constructor(private readonly onChunk: (chunk: Chunk) => void) {}

  /** Feed the full cumulative transcript seen so far. */
  push(text: string): void {
    // Web Speech revises interim results, so the committed prefix may change
    // wording without being a new session; only a transcript that shrank below
    // the offset means the engine restarted without reset() (offset now points
    // into unrelated text). Emit the old tail and start over in that case.
    if (text.length < this.committedLen) {
      const tail = this.buffer.slice(this.committedLen);
      if (tail.trim().length > 0) this.commit(tail);
      this.committedLen = 0;
    }

    this.buffer = text;

    // One push can carry several finished sentences. Emit each one as soon as
    // it is long enough, so subtitles are not delayed until the speaker pauses.
    for (;;) {
      const cut = firstCommittableTerms(this.buffer.slice(this.committedLen));
      if (cut < 0) break;
      this.commit(this.buffer.slice(this.committedLen, this.committedLen + cut));
    }

    if (this.buffer.slice(this.committedLen).trim().length > 0) this.armFlush();
  }

  /**
   * Emit whatever is still pending. Call before `reset()`: the last words
   * before an STT restart carry no terminator and would otherwise be dropped.
   */
  flush(): void {
    this.clearFlush();
    const tail = this.buffer.slice(this.committedLen);
    if (tail.trim().length > 0) this.commit(tail);
  }

  /** Drop all state; call when the STT session restarts (cumulative resets). */
  reset(): void {
    this.buffer = "";
    this.committedLen = 0;
    this.clearFlush();
  }

  /** Stop timers (e.g. when the operator disconnects). */
  stop(): void {
    this.clearFlush();
  }

  private commit(segment: string): void {
    this.committedLen += segment.length;
    this.clearFlush();
    const text = segment.trim();
    if (text) this.onChunk({ id: this.nextId++, text });
  }

  private armFlush(): void {
    this.clearFlush();
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      const tail = this.buffer.slice(this.committedLen);
      if (speechLen(tail) >= MIN_CHUNK_LEN) {
        this.commit(tail);
      }
    }, FLUSH_TIMEOUT_MS);
  }

  private clearFlush(): void {
    if (this.flushTimer != null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
