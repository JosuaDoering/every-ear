// AI operator pipeline: transcribe the operator's mic, translate each chunk into
// every AI language via the backend (OpenRouter SSE), and publish the result as
// caption data into that language's LiveKit room. Listeners read the captions and
// (by default) have their device speak them aloud.

import { Room, RoomEvent } from "livekit-client";
import { livekitUrl } from "../livekit.js";
import type { AiLanguageGrant } from "../session.js";
import { SentenceChunker } from "./chunker.js";
import { SpeechToText } from "./stt.js";
import { GroqSpeechToText } from "./groq-stt.js";
import { encodeCaption, type CaptionMessage } from "./types.js";

export type ChannelState = "connecting" | "live" | "error";

/** Per-language health counters shown under each channel on the operator page. */
export type ChannelStats = {
  /** Sentences that made it to listeners. */
  done: number;
  /** Average seconds from "sentence finished" to "translation published live". */
  latencyMs: number;
  /** Average seconds from "operator started speaking it" to first live text. */
  firstTextMs: number;
};

type Channel = AiLanguageGrant & { lkRoom: Room };

const INTERIM_THROTTLE_MS = 300;
/** How long a queued sentence may wait before it is too stale to publish. */
const MAX_CHUNK_AGE_MS = 6000;
const MAX_QUEUE = 2;

async function streamTranslate(
  body: {
    text: string;
    sourceLang: string;
    targetLang: string;
    context: string[];
    partial?: string;
  },
  token: string,
  onDelta: (full: string) => void,
): Promise<string> {
  const res = await fetch("/api/ai/translate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // The backend verifies this LiveKit token: translation spends the
      // server's OpenRouter key, so it must be tied to this event/room.
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`translate failed (${res.status})`);
  // A continuation request is prefilled with the text we already show, so the
  // model usually returns only the rest. Some models restate the sentence
  // anyway; detect that instead of prepending the baseline twice.
  const baseline = body.partial ?? "";
  const join = (part: string) =>
    baseline && !part.trimStart().startsWith(baseline.trim()) ? `${baseline}${part}` : part;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      let obj: { delta?: string; done?: boolean; text?: string; error?: string };
      try {
        obj = JSON.parse(data);
      } catch {
        continue;
      }
      if (obj.error) throw new Error(obj.error);
      if (typeof obj.delta === "string") {
        full = join(obj.delta);
        onDelta(full);
      } else if (obj.done && typeof obj.text === "string") {
        full = join(obj.text);
      }
    }
  }
  return full;
}

export class AiOperator {
  private channels: Channel[] = [];
  private stt: SpeechToText | GroqSpeechToText | null = null;
  private chunker: SentenceChunker | null = null;
  private contexts = new Map<string, string[]>();
  private lastInterim = new Map<string, number>();
  private running = false;
  // Backpressure: one in-flight translation per channel and a small FIFO of
  // queued chunks. A single "latest wins" slot dropped whole sentences whenever
  // the model was slower than the speaker, which is why subtitles felt
  // unreliable; queuing keeps the text without unbounded lag. Chunks older than
  // MAX_CHUNK_AGE_MS are skipped, because their audio is long gone by then.
  private inFlight = new Set<string>();
  private queues = new Map<string, { id: number; text: string; sourceLang: string; at: number }[]>();
  // Last published finals per channel, replayed to listeners who join late.
  private recent = new Map<string, { id: number; text: string }[]>();
  /** Live preview translation of the sentence being spoken, per channel. */
  private previews = new Map<string, { id: number; text: string; inFlight: boolean }>();
  private stats = new Map<string, ChannelStats>();
  // Latency metrics per sentence id: speech start, speech end, first live text.
  private startAt = new Map<number, number>();
  private endAt = new Map<number, number>();
  private firstTextAt = new Map<number, number>();

  constructor(
    private readonly grant: {
      aiLanguages?: AiLanguageGrant[];
      name: string;
      sourceLang?: string;
      sttEngine?: string;
    },
    private readonly onStatus: (code: string, state: ChannelState, detail?: string) => void,
    private readonly onStats?: (code: string, stats: ChannelStats) => void,
    private readonly opts: { deviceId?: string } = {},
  ) {}

  private get sourceLang(): string {
    // The event's source language, fixed by the admin. Empty only for grants
    // issued before the backend started requiring it.
    return this.grant.sourceLang ?? "";
  }

  private get sttEngine(): "web-speech" | "groq" {
    return this.grant.sttEngine === "groq" ? "groq" : "web-speech";
  }

  async start(): Promise<void> {
    const langs = this.grant.aiLanguages ?? [];
    if (langs.length === 0) throw new Error("This event has no AI languages configured.");
    if (!this.sourceLang) {
      throw new Error("This event has no AI source language — ask the organizer to set it.");
    }
    if (this.sttEngine === "groq") {
      if (!GroqSpeechToText.isSupported()) {
        throw new Error("Audio recording is not supported in this browser.");
      }
    } else if (!SpeechToText.isSupported()) {
      throw new Error("Speech recognition is not supported in this browser (use Chrome or Edge).");
    }

    this.running = true;
    for (const ai of langs) {
      this.onStatus(ai.code, "connecting");
      const room = new Room();
      try {
        await room.connect(livekitUrl(), ai.token);
        // Late joiners get the current subtitle instantly instead of staring
        // at an empty box until the speaker's next sentence.
        room.on(RoomEvent.ParticipantConnected, () => {
          window.setTimeout(() => this.publishSnapshot(room), 250);
        });
        room.on(RoomEvent.Reconnecting, () => this.onStatus(ai.code, "connecting", "reconnecting"));
        room.on(RoomEvent.Reconnected, () => {
          this.onStatus(ai.code, "live");
          this.publishSnapshot(room);
        });
        // LiveKit gives up after its own retries; say so instead of showing a
        // live channel that silently drops every caption.
        room.on(RoomEvent.Disconnected, () => {
          if (!this.running) return;
          this.onStatus(ai.code, "error", "disconnected");
        });
        this.channels.push({ ...ai, lkRoom: room });
        this.onStatus(ai.code, "live");
      } catch (err) {
        this.onStatus(ai.code, "error", err instanceof Error ? err.message : "connect failed");
      }
    }

    // Without a single connected channel the operator would look "on air"
    // while publishing nothing, so fail loudly instead.
    if (this.channels.length === 0) {
      this.running = false;
      throw new Error("Could not connect to any AI language room.");
    }

    this.chunker = new SentenceChunker(
      (chunk) => this.onChunk(chunk.id, chunk.text),
      (chunk) => this.onPreviewChunk(chunk.id, chunk.text),
    );
    const engine = this.sttEngine;
    const handlers = {
      // Groq interims are revisable: they drive previews only, finals commit.
      onTranscript: (text: string, isFinal: boolean) => {
        if (engine === "groq" && !isFinal) this.chunker?.pushInterim(text);
        else this.chunker?.push(text);
      },
      onRestart: () => {
        this.chunker?.flush();
        this.chunker?.reset();
      },
      // Without this the channel rows keep saying "live" while recognition has
      // stopped for good (mic revoked, engine error) and nothing is published.
      onError: (msg: string) => {
        for (const ch of this.channels) this.onStatus(ch.code, "error", msg);
      },
    };
    this.stt =
      engine === "groq"
        ? new GroqSpeechToText(
            this.sourceLang,
            { token: langs[0]!.token, deviceId: this.opts.deviceId },
            handlers,
          )
        : new SpeechToText(this.sourceLang, handlers);
    await this.stt.start();
  }

  private onChunk(id: number, text: string): void {
    const sourceLang = this.sourceLang;
    // Commit is the end of speech: the sentence was terminated or the speaker
    // paused long enough for a flush.
    const now = Date.now();
    this.endAt.set(id, now);
    if (!this.startAt.has(id)) this.startAt.set(id, now);
    for (const ch of this.channels) {
      if (this.inFlight.has(ch.code)) {
        const queue = this.queues.get(ch.code) ?? [];
        queue.push({ id, text, sourceLang, at: Date.now() });
        // Keep at most two waiting sentences; beyond that the subtitles would
        // trail the speaker by seconds and stop being useful.
        while (queue.length > MAX_QUEUE) this.forgetSentence(queue.shift()!.id);
        this.queues.set(ch.code, queue);
        continue;
      }
      void this.runTranslateAndPublish(id, text, sourceLang, ch);
    }
  }

  private async runTranslateAndPublish(
    id: number,
    text: string,
    sourceLang: string,
    ch: Channel,
  ): Promise<void> {
    this.inFlight.add(ch.code);
    try {
      await this.translateAndPublish(id, text, sourceLang, ch);
    } finally {
      this.inFlight.delete(ch.code);
      this.drainQueue(ch);
    }
  }

  /** Start the next queued sentence for a channel, skipping stale ones. */
  private drainQueue(ch: Channel): void {
    const queue = this.queues.get(ch.code);
    if (!queue || queue.length === 0) return;
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (Date.now() - next.at > MAX_CHUNK_AGE_MS) {
        this.forgetSentence(next.id);
        continue;
      }
      void this.runTranslateAndPublish(next.id, next.text, next.sourceLang, ch);
      return;
    }
  }

  /**
   * The sentence being spoken is already long: translate it now and show the
   * text as an interim, so listeners read along before the sentence ends.
   * The chunker caps how many previews one sentence may cost.
   */
  private onPreviewChunk(id: number, text: string): void {
    const sourceLang = this.sourceLang;
    if (!this.startAt.has(id)) this.startAt.set(id, Date.now());
    for (const ch of this.channels) {
      // Never preview ahead of unpublished work: the older sentence's final
      // would arrive after newer text and make the band jump backwards.
      if (this.inFlight.has(ch.code) || (this.queues.get(ch.code)?.length ?? 0) > 0) continue;
      const prior = this.previews.get(ch.code);
      if (prior && prior.inFlight) continue;
      void this.runPreview(id, text, sourceLang, ch);
    }
  }

  private async runPreview(
    id: number,
    text: string,
    sourceLang: string,
    ch: Channel,
  ): Promise<void> {
    const previous = this.previews.get(ch.code);
    // Continue from the last preview of this sentence; a preview of an older
    // sentence is no baseline at all.
    const baseline = previous && previous.id === id ? previous.text : "";
    this.previews.set(ch.code, { id, text: baseline, inFlight: true });
    try {
      const full = await streamTranslate(
        {
          text,
          sourceLang,
          targetLang: ch.code,
          context: this.contexts.get(ch.code) ?? [],
          ...(baseline ? { partial: baseline } : {}),
        },
        ch.token,
        () => undefined,
      );
      // The sentence may have been committed while the preview was in flight;
      // the final wins, so drop the late preview text.
      const entry = this.previews.get(ch.code);
      if (!entry || entry.id !== id) return;
      this.previews.set(ch.code, { id, text: full, inFlight: false });
      this.publish(ch, { id, text: full, lang: ch.code, final: false });
      this.markFirstText(id);
    } catch {
      const entry = this.previews.get(ch.code);
      if (entry && entry.id === id) this.previews.set(ch.code, { id, text: baseline, inFlight: false });
    }
  }

  private async translateAndPublish(
    id: number,
    text: string,
    sourceLang: string,
    ch: Channel,
  ): Promise<void> {
    const context = this.contexts.get(ch.code) ?? [];
    const started = Date.now();
    try {
      const finalText = await streamTranslate(
        { text, sourceLang, targetLang: ch.code, context },
        ch.token,
        (partial) => {
          const now = Date.now();
          const last = this.lastInterim.get(ch.code) ?? 0;
          if (now - last >= INTERIM_THROTTLE_MS) {
            this.lastInterim.set(ch.code, now);
            this.publish(ch, { id, text: partial, lang: ch.code, final: false });
            this.markFirstText(id);
          }
        },
      );
      this.publish(ch, { id, text: finalText, lang: ch.code, final: true });
      this.previews.delete(ch.code);
      this.recordStats(ch.code, id, started);
      const recent = this.recent.get(ch.code) ?? [];
      recent.push({ id, text: finalText });
      while (recent.length > 2) recent.shift();
      this.recent.set(ch.code, recent);
      const arr = this.contexts.get(ch.code) ?? [];
      arr.push(finalText);
      while (arr.length > 3) arr.shift();
      this.contexts.set(ch.code, arr);
    } catch (err) {
      this.onStatus(ch.code, "error", err instanceof Error ? err.message : "translate failed");
    }
  }

  /** Drop per-sentence bookkeeping for a sentence that will never publish. */
  private forgetSentence(id: number): void {
    this.startAt.delete(id);
    this.endAt.delete(id);
    this.firstTextAt.delete(id);
  }

  /** Remember the first live text of a sentence (only the first counts). */
  private markFirstText(id: number): void {
    if (!this.firstTextAt.has(id)) this.firstTextAt.set(id, Date.now());
  }

  /**
   * Fold one finished sentence into the channel's running averages. `latency`
   * is measured from the end of speech, `firstText` from the start, so a
   * preview improves the second number without flattering the first.
   */
  private recordStats(code: string, id: number, startedAt: number): void {
    const now = Date.now();
    const start = this.startAt.get(id) ?? startedAt;
    const end = this.endAt.get(id) ?? startedAt;
    const first = this.firstTextAt.get(id) ?? now;
    const stats = this.stats.get(code) ?? { done: 0, latencyMs: 0, firstTextMs: 0 };
    const prevDone = stats.done;
    stats.done += 1;
    stats.latencyMs =
      (stats.latencyMs * prevDone + Math.max(0, now - end)) / stats.done;
    stats.firstTextMs =
      (stats.firstTextMs * prevDone + Math.max(0, first - start)) / stats.done;
    this.stats.set(code, stats);
    this.forgetSentence(id);
    this.onStats?.(code, { ...stats });
  }

  private publish(ch: Channel, msg: Omit<CaptionMessage, "type">): void {
    if (!this.running) return;
    const payload = encodeCaption({ type: "caption", ...msg });
    // A rejected publish (room reconnecting) must not surface as an unhandled
    // rejection; the next sentence will retry through the same room.
    void ch.lkRoom.localParticipant
      .publishData(payload, { reliable: msg.final, topic: "captions" })
      .catch(() => undefined);
  }

  /** Replay the last finals to everyone in the room (listeners de-duplicate). */
  private publishSnapshot(room: Room): void {
    if (!this.running) return;
    const ch = this.channels.find((c) => c.lkRoom === room);
    if (!ch) return;
    for (const item of this.recent.get(ch.code) ?? []) {
      const payload = encodeCaption({
        type: "caption",
        id: item.id,
        text: item.text,
        lang: ch.code,
        final: true,
        snapshot: true,
      });
      void room.localParticipant
        .publishData(payload, { reliable: true, topic: "captions" })
        .catch(() => undefined);
    }
  }

  private hasQueued(): boolean {
    for (const queue of this.queues.values()) if (queue.length > 0) return true;
    return false;
  }

  async stop(): Promise<void> {
    // Emit the last, still-unfinished sentence before tearing the rooms down:
    // stopping the operator otherwise silently drops the speaker's last words.
    // STT stops first (Groq uploads the pending segment and emits it), then
    // the chunker flushes whatever final text is still pending. The
    // translations this starts are asynchronous, so give them a moment before
    // disconnecting (bounded — stopping must still feel immediate).
    await this.stt?.stop();
    this.stt = null;
    this.chunker?.flush();
    this.chunker?.stop();
    this.chunker = null;
    await this.waitForIdle(2500);
    this.running = false;
    this.previews.clear();
    this.startAt.clear();
    this.endAt.clear();
    this.firstTextAt.clear();
    await Promise.all(this.channels.map((c) => c.lkRoom.disconnect()));
    this.channels = [];
  }

  /** Resolve once no channel has a translation in flight or pending, or after `ms`. */
  private async waitForIdle(ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && (this.inFlight.size > 0 || this.hasQueued())) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}
