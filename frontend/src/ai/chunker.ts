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
// Speech recognition often runs for a long time without punctuation. An
// unbounded chunk would be slow to translate, lag behind the audio, and can hit
// the backend's input cap — so long tail is cut at a word boundary.
const MAX_CHUNK_LEN = 220;
const SOFT_BREAKS = /[,;:—–]/;
// Progressive preview: a tail this long is worth translating before the
// sentence ends, so listeners see text while the speaker is still talking.
// Each preview is a billed request, so they are capped per sentence and spaced
// apart; the follow-ups continue from the previous preview instead of
// re-translating the whole sentence.
const PREVIEW_MIN_LEN = 70;
const PREVIEW_INTERVAL_MS = 1500;
const MAX_PREVIEWS_PER_SENTENCE = 3;

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

/**
 * Index to cut an over-long tail at: the last clause/clause-ish separator in
 * the first MAX_CHUNK_LEN characters, else the last space, else the cap.
 */
function softCut(tail: string): number {
  const window = tail.slice(0, MAX_CHUNK_LEN);
  for (let i = window.length - 1; i >= MIN_CHUNK_LEN; i--) {
    if (SOFT_BREAKS.test(window[i]!)) return i + 1;
  }
  const space = window.lastIndexOf(" ");
  return space > MIN_CHUNK_LEN ? space : MAX_CHUNK_LEN;
}

export class SentenceChunker {
  private buffer = "";
  private committedLen = 0;
  /**
   * Bytes of `buffer` backed by final (non-interim) STT text. Commits and
   * flushes never cross this offset: interim text may drive previews, but a
   * sentence is only published as final from final transcripts.
   */
  private finalLen = 0;
  private nextId = 1;
  private flushTimer: number | null = null;
  /** Previews sent for the sentence currently being spoken. */
  private previewsForId = 0;
  private lastPreviewAt = 0;
  private lastPreviewLen = 0;

  constructor(
    private readonly onChunk: (chunk: Chunk) => void,
    /**
     * Optional early text for the sentence still being spoken. It carries the
     * id the sentence will get when committed, so the final replaces it.
     */
    private readonly onPreview?: (chunk: Chunk) => void,
  ) {}

  /** Feed the full cumulative transcript seen so far (final STT results). */
  push(text: string): void {
    // Web Speech revises interim results, so the committed prefix may change
    // wording without being a new session; only a transcript that shrank below
    // the offset means the engine restarted without reset() (offset now points
    // into unrelated text). Emit the old tail and start over in that case.
    if (text.length < this.committedLen) {
      const tail = this.buffer.slice(this.committedLen, this.finalLen);
      if (tail.trim().length > 0) this.commit(tail);
      this.committedLen = 0;
    }

    this.buffer = text;
    this.finalLen = text.length;

    // One push can carry several finished sentences. Emit each one as soon as
    // it is long enough, so subtitles are not delayed until the speaker pauses.
    for (;;) {
      const tail = this.buffer.slice(this.committedLen);
      let cut = firstCommittableTerms(tail);
      if (cut < 0 && tail.length > MAX_CHUNK_LEN) cut = softCut(tail);
      if (cut < 0) break;
      this.commit(tail.slice(0, cut));
    }

    if (this.buffer.slice(this.committedLen, this.finalLen).trim().length > 0) {
      this.armFlush();
    }
    this.maybePreview();
  }

  /**
   * Feed an interim (still revisable) transcript. It may extend the buffer so
   * previews run ahead, but it must never commit a sentence: the Groq engine
   * can reword interim text, and only final transcripts are authoritative.
   */
  pushInterim(text: string): void {
    if (text.length < this.finalLen) return; // stale interim — ignore
    this.buffer = text;
    this.maybePreview();
  }

  private maybePreview(): void {
    if (!this.onPreview) return;
    const tail = this.buffer.slice(this.committedLen).trim();
    const len = speechLen(tail);
    if (len < PREVIEW_MIN_LEN) return;
    if (this.previewsForId >= MAX_PREVIEWS_PER_SENTENCE) return;
    // Only worth a request if the tail has grown meaningfully, and not faster
    // than the interval — otherwise a chatty transcript update would preview
    // on every partial result.
    if (this.previewsForId > 0) {
      if (len < this.lastPreviewLen + 15) return;
      if (Date.now() - this.lastPreviewAt < PREVIEW_INTERVAL_MS) return;
    }
    this.previewsForId++;
    this.lastPreviewAt = Date.now();
    this.lastPreviewLen = len;
    // `nextId` is the id the pending tail will take when it is committed.
    this.onPreview({ id: this.nextId, text: tail });
  }

  /**
   * Emit whatever is still pending. Call before `reset()`: the last words
   * before an STT restart carry no terminator and would otherwise be dropped.
   * Only final text is emitted — an unconfirmed interim tail is dropped.
   */
  flush(): void {
    this.clearFlush();
    const tail = this.buffer.slice(this.committedLen, this.finalLen);
    if (tail.trim().length > 0) this.commit(tail);
  }

  /** Drop all state; call when the STT session restarts (cumulative resets). */
  reset(): void {
    this.buffer = "";
    this.committedLen = 0;
    this.finalLen = 0;
    this.clearPreviewState();
    this.clearFlush();
  }

  /** Stop timers (e.g. when the operator disconnects). */
  stop(): void {
    this.clearFlush();
  }

  private commit(segment: string): void {
    this.committedLen += segment.length;
    this.clearFlush();
    this.clearPreviewState();
    const text = segment.trim();
    if (text) this.onChunk({ id: this.nextId++, text });
  }

  private armFlush(): void {
    this.clearFlush();
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      // The buffer may have grown past finalLen with interim text since the
      // timer was armed; only the final-backed tail may be committed.
      const tail = this.buffer.slice(this.committedLen, this.finalLen);
      if (speechLen(tail) >= MIN_CHUNK_LEN) {
        this.commit(tail);
      }
    }, FLUSH_TIMEOUT_MS);
  }

  private clearPreviewState(): void {
    this.previewsForId = 0;
    this.lastPreviewLen = 0;
    this.lastPreviewAt = 0;
  }

  private clearFlush(): void {
    if (this.flushTimer != null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
