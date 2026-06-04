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
// Sentence/clause terminators, incl. CJK full-width forms and newline.
const TERMINATORS = /[.!?…。！？\n]/;

export class SentenceChunker {
  private buffer = "";
  private committedLen = 0;
  private nextId = 1;
  private flushTimer: number | null = null;

  constructor(private readonly onChunk: (chunk: Chunk) => void) {}

  /** Feed the full cumulative transcript seen so far. */
  push(text: string): void {
    this.buffer = text;
    const tail = this.buffer.slice(this.committedLen);

    // Find the last terminator in the uncommitted tail.
    let lastTerm = -1;
    for (let i = tail.length - 1; i >= 0; i--) {
      if (TERMINATORS.test(tail[i]!)) {
        lastTerm = i;
        break;
      }
    }

    if (lastTerm >= 0) {
      const segment = tail.slice(0, lastTerm + 1);
      if (segment.trim().length >= MIN_CHUNK_LEN) {
        this.commit(segment);
        return;
      }
    }

    // No complete sentence yet — (re)arm the flush timer.
    this.armFlush();
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
      if (tail.trim().length >= MIN_CHUNK_LEN) {
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
