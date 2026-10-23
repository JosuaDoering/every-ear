// Groq-backed speech-to-text: the mic is segmented by a client-side VAD and
// each segment is uploaded to the backend, which proxies Groq Whisper. The
// handler contract matches SpeechToText (cumulative transcript + restart), so
// both engines feed the same chunker.
//
// Latency: while a segment is being spoken, interim snapshots are transcribed
// every few seconds and emitted as non-final text, so previews/captions run
// ahead of the pause. On speech end the final transcription replaces the
// interim — only finals may commit sentences (see chunker.pushInterim).
//
// Stability: uploads are serialised (finals must stay in order), one bounded
// retry hides single hiccups, and a run of consecutive failures surfaces via
// onError instead of silently dropping captions.

import type { SttHandlers } from "./stt.js";

export type GroqSttOptions = {
  /** LiveKit publisher token authorizing POST /api/ai/transcribe. */
  token: string;
  /** Borrowed stream (e.g. the broadcast track). Owned internally otherwise. */
  stream?: MediaStream;
  /** Mic device for the internally acquired stream (system default if unset). */
  deviceId?: string;
};

const VAD_TICK_MS = 50;
/** Ticks above threshold before speech is considered started (~150 ms). */
const SPEECH_START_TICKS = 3;
/** Silence below threshold that ends a segment. */
const HANGOVER_MS = 600;
/** Shorter segments are coughs/clicks, not speech — dropped before upload. */
const MIN_SEGMENT_MS = 700;
/** Force-cut long segments so latency and upload size stay bounded. */
const MAX_SEGMENT_MS = 20_000;
/** First interim after this much speech, then again every interval. */
const INTERIM_FIRST_MS = 3_000;
const INTERIM_EVERY_MS = 3_000;
/** Never let RMS triggering fall into the noise floor of a quiet room. */
const MIN_RMS = 0.006;
const UPLOAD_TIMEOUT_MS = 20_000;
const RETRY_DELAY_MS = 700;
/** Consecutive final-upload failures before captions are declared stopped. */
const MAX_FINAL_FAILURES = 4;

/** Best supported recorder mime type, most-preferred first. */
function pickMime(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

function stopRecorder(rec: MediaRecorder): Promise<void> {
  return new Promise((resolve) => {
    rec.addEventListener("stop", () => resolve(), { once: true });
    try {
      rec.stop();
    } catch {
      resolve();
    }
  });
}

export class GroqSpeechToText {
  private active = false;
  private stopped = false;
  private stream: MediaStream | null = null;
  private ownStream = false;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private pcm: Float32Array<ArrayBuffer> | null = null;
  private vadTimer: number | null = null;

  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private mime = "";
  private segStartAt = 0;
  private speaking = false;
  private speechTicks = 0;
  private silenceMs = 0;
  private noiseFloor = MIN_RMS;
  private nextInterimAt = Infinity;
  /** Incremented per segment; guards stale interim responses. */
  private generation = 0;

  private committed = "";
  private interim = "";
  /** Generation the current `interim` belongs to; only that segment's final may clear it. */
  private interimGeneration = -1;
  private interimInFlight = false;
  private finalChain: Promise<void> = Promise.resolve();
  private finalFailures = 0;
  private uploadAbort: AbortController | null = null;

  constructor(
    private lang: string,
    private readonly opts: GroqSttOptions,
    private readonly h: SttHandlers,
  ) {}

  static isSupported(): boolean {
    return (
      typeof MediaRecorder !== "undefined" &&
      typeof navigator.mediaDevices?.getUserMedia === "function"
    );
  }

  setLang(lang: string): void {
    // The backend derives the language from the token/event, so this only
    // keeps interface parity with SpeechToText.
    this.lang = lang;
  }

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    this.stopped = false;
    if (this.opts.stream) {
      this.stream = this.opts.stream;
    } else {
      this.stream = await this.acquireMic();
      this.ownStream = true;
    }
    this.mime = pickMime();
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    // Not connected to destination — analysis only, no monitoring echo.
    src.connect(this.analyser);
    this.pcm = new Float32Array(this.analyser.fftSize);
    this.beginSegment();
    this.vadTimer = window.setInterval(() => this.tick(), VAD_TICK_MS);
  }

  private async acquireMic(): Promise<MediaStream> {
    const audio: MediaTrackConstraints = {
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    };
    if (this.opts.deviceId) {
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio: { ...audio, deviceId: { exact: this.opts.deviceId } },
        });
      } catch {
        // The selected device vanished (unplugged): fall back to the default
        // mic rather than killing captions for the rest of the event.
      }
    }
    return navigator.mediaDevices.getUserMedia({ audio });
  }

  // ---- VAD + segmentation ---------------------------------------------------

  private tick(): void {
    if (!this.analyser || !this.pcm) return;
    this.analyser.getFloatTimeDomainData(this.pcm);
    let sum = 0;
    for (let i = 0; i < this.pcm.length; i++) sum += this.pcm[i]! * this.pcm[i]!;
    const rms = Math.sqrt(sum / this.pcm.length);
    const threshold = Math.max(this.noiseFloor * 3, MIN_RMS);
    const now = performance.now();

    if (!this.speaking) {
      // Adapt the noise floor only while quiet, and clamp spikes so a single
      // bang cannot raise the floor and mute the following speech.
      this.noiseFloor += (Math.min(rms, threshold) - this.noiseFloor) * 0.05;
      if (rms > threshold) {
        this.speechTicks++;
        if (this.speechTicks >= SPEECH_START_TICKS) {
          this.speaking = true;
          this.silenceMs = 0;
        }
      } else {
        this.speechTicks = 0;
      }
      return;
    }

    if (rms > threshold * 0.7) {
      this.silenceMs = 0;
    } else {
      this.silenceMs += VAD_TICK_MS;
      if (this.silenceMs >= HANGOVER_MS) {
        this.endSegment();
        return;
      }
    }
    const elapsed = now - this.segStartAt;
    if (elapsed >= MAX_SEGMENT_MS) {
      this.endSegment();
      return;
    }
    if (elapsed >= this.nextInterimAt) this.sendInterim();
  }

  private beginSegment(): void {
    this.generation++;
    this.chunks = [];
    this.segStartAt = performance.now();
    this.speaking = false;
    this.speechTicks = 0;
    this.silenceMs = 0;
    this.nextInterimAt = INTERIM_FIRST_MS;
    const rec = new MediaRecorder(this.stream!, this.mime ? { mimeType: this.mime } : undefined);
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    rec.start(250);
    this.recorder = rec;
  }

  private endSegment(): void {
    const rec = this.recorder;
    const chunks = this.chunks;
    const startedAt = this.segStartAt;
    const generation = this.generation;
    // Start the next recorder before stopping this one, so the audio between
    // "pause detected" and "recorder swapped" is captured, not dropped.
    this.beginSegment();
    if (!rec) return;
    const durationMs = performance.now() - startedAt;
    void stopRecorder(rec).then(() => {
      if (this.stopped || durationMs < MIN_SEGMENT_MS) return;
      this.enqueueFinal(new Blob(chunks, { type: this.mime }), generation);
    });
  }

  // ---- Upload ---------------------------------------------------------------

  private filename(): string {
    if (this.mime.includes("mp4")) return "segment.mp4";
    if (this.mime.includes("ogg")) return "segment.ogg";
    return "segment.webm";
  }

  private async post(blob: Blob): Promise<string> {
    const form = new FormData();
    form.append("file", blob, this.filename());
    this.uploadAbort = new AbortController();
    const timeout = AbortSignal.timeout(UPLOAD_TIMEOUT_MS);
    const signal = AbortSignal.any([this.uploadAbort.signal, timeout]);
    let res: Response;
    try {
      res = await fetch("/api/ai/transcribe", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.opts.token}` },
        body: form,
        signal,
      });
    } catch (err) {
      throw err instanceof DOMException && err.name === "AbortError"
        ? Object.assign(new Error("transcription timed out"), { status: 504 })
        : err;
    }
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const data = (await res.json()) as { error?: string };
        if (data.error) msg = data.error;
      } catch {
        /* keep generic message */
      }
      throw Object.assign(new Error(msg), { status: res.status });
    }
    const data = (await res.json()) as { text?: string };
    return (data.text ?? "").trim();
  }

  private isRetryable(err: unknown): boolean {
    const status = (err as { status?: number })?.status;
    // No status = network failure; 5xx/429 = transient upstream trouble.
    return status == null || status === 429 || status >= 500;
  }

  /** Interims are best-effort: skipped while busy, never retried. */
  private sendInterim(): void {
    if (this.interimInFlight || this.chunks.length === 0) {
      // Keep the cadence even when skipping, so the next try is one interval out.
      this.nextInterimAt += INTERIM_EVERY_MS;
      return;
    }
    this.nextInterimAt += INTERIM_EVERY_MS;
    const generation = this.generation;
    const snapshot = new Blob(this.chunks, { type: this.mime });
    this.interimInFlight = true;
    void this.post(snapshot)
      .then((text) => {
        // A segment boundary (or stop) since the snapshot makes this stale.
        if (!this.active || generation !== this.generation) return;
        this.interim = text;
        this.interimGeneration = generation;
        this.emit(false);
      })
      .catch(() => {
        /* the next interval tries again */
      })
      .finally(() => {
        this.interimInFlight = false;
      });
  }

  /** Finals are serialised so sentences land in spoken order. */
  private enqueueFinal(blob: Blob, generation: number): void {
    this.finalChain = this.finalChain.then(() => this.sendFinal(blob, generation));
  }

  private async sendFinal(blob: Blob, generation: number): Promise<void> {
    let text: string;
    try {
      text = await this.post(blob);
    } catch (first) {
      const status = (first as { status?: number })?.status;
      if (status === 401 || status === 403) {
        this.failFatal("Caption login expired — please sign in again.");
        return;
      }
      if (!this.isRetryable(first)) {
        this.failFatal(first instanceof Error ? first.message : "transcription failed");
        return;
      }
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      try {
        text = await this.post(blob);
      } catch (second) {
        const status2 = (second as { status?: number })?.status;
        if (status2 === 401 || status2 === 403) {
          this.failFatal("Caption login expired — please sign in again.");
          return;
        }
        this.finalFailures++;
        if (this.finalFailures >= MAX_FINAL_FAILURES) {
          this.failFatal("transcription unavailable (network or provider down)");
        }
        // Otherwise drop the segment and keep listening: a lost sentence is
        // bad, a dead caption loop is worse.
        return;
      }
    }
    this.finalFailures = 0;
    // Emitted even while stopping: stop() awaits the chain precisely so the
    // last spoken sentence still reaches the chunker before teardown.
    if (text) {
      this.committed = this.committed ? `${this.committed} ${text}` : text;
    }
    // The interim belonged to this segment; the final replaces it.
    if (generation === this.interimGeneration) {
      this.interim = "";
      this.interimGeneration = -1;
    }
    this.emit(true);
  }

  private failFatal(msg: string): void {
    // Report first, then stop: stopping also clears the recorder, and the
    // handler may want to show the message while tearing down.
    this.h.onError?.(msg);
    void this.stop();
  }

  private emit(isFinal: boolean): void {
    const text = this.interim
      ? this.committed
        ? `${this.committed} ${this.interim}`
        : this.interim
      : this.committed;
    this.h.onTranscript(text, isFinal);
  }

  // ---- Teardown ---------------------------------------------------------------

  /**
   * Stop capture and upload the last pending segment (bounded): the operator
   * stopping right after a sentence must not lose it. Resolves when in-flight
   * uploads settle.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.active = false;
    if (this.vadTimer != null) {
      clearInterval(this.vadTimer);
      this.vadTimer = null;
    }
    const rec = this.recorder;
    this.recorder = null;
    const chunks = this.chunks;
    const startedAt = this.segStartAt;
    const generation = this.generation;
    this.generation++; // invalidate any interim still in flight
    if (rec && rec.state !== "inactive") {
      await stopRecorder(rec);
      // Only spoken audio is worth one last upload.
      if (performance.now() - startedAt >= MIN_SEGMENT_MS && chunks.length > 0) {
        this.enqueueFinal(new Blob(chunks, { type: this.mime }), generation);
      }
    }
    this.stopped = true;
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
      this.analyser = null;
    }
    if (this.ownStream && this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
    }
    this.stream = null;
    // Wait for the final chain (including the last segment) to settle. Each
    // post has its own timeout, so this is bounded.
    await this.finalChain.catch(() => undefined);
  }
}
