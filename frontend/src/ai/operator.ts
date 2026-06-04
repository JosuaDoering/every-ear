// AI operator pipeline: transcribe the operator's mic, translate each chunk into
// every AI language via the backend (OpenRouter SSE), and publish the result as
// caption data into that language's LiveKit room. Listeners read the captions and
// (by default) have their device speak them aloud.

import { Room } from "livekit-client";
import { livekitUrl } from "../livekit.js";
import type { AiLanguageGrant } from "../session.js";
import { SentenceChunker } from "./chunker.js";
import { SpeechToText } from "./stt.js";
import { encodeCaption, type CaptionMessage } from "./types.js";

export type ChannelState = "connecting" | "live" | "error";

type Channel = AiLanguageGrant & { lkRoom: Room };

const INTERIM_THROTTLE_MS = 300;

async function streamTranslate(
  body: { text: string; sourceLang: string; targetLang: string; context: string[] },
  onDelta: (full: string) => void,
): Promise<string> {
  const res = await fetch("/api/ai/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`translate failed (${res.status})`);

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
        full = obj.delta;
        onDelta(full);
      } else if (obj.done && typeof obj.text === "string") {
        full = obj.text;
      }
    }
  }
  return full;
}

export class AiOperator {
  private channels: Channel[] = [];
  private stt: SpeechToText | null = null;
  private chunker: SentenceChunker | null = null;
  private contexts = new Map<string, string[]>();
  private lastInterim = new Map<string, number>();
  private running = false;

  constructor(
    private readonly grant: { aiLanguages?: AiLanguageGrant[]; name: string },
    private readonly getSourceLang: () => string,
    private readonly onStatus: (code: string, state: ChannelState, detail?: string) => void,
  ) {}

  async start(): Promise<void> {
    const langs = this.grant.aiLanguages ?? [];
    if (langs.length === 0) throw new Error("This event has no AI languages configured.");
    if (!SpeechToText.isSupported()) {
      throw new Error("Speech recognition is not supported in this browser (use Chrome or Edge).");
    }

    this.running = true;
    for (const ai of langs) {
      this.onStatus(ai.code, "connecting");
      const room = new Room();
      try {
        await room.connect(livekitUrl(), ai.token);
        this.channels.push({ ...ai, lkRoom: room });
        this.onStatus(ai.code, "live");
      } catch (err) {
        this.onStatus(ai.code, "error", err instanceof Error ? err.message : "connect failed");
      }
    }

    this.chunker = new SentenceChunker((chunk) => this.onChunk(chunk.id, chunk.text));
    this.stt = new SpeechToText(this.getSourceLang(), {
      onTranscript: (text) => this.chunker?.push(text),
      onRestart: () => this.chunker?.reset(),
    });
    this.stt.start();
  }

  setSourceLang(lang: string): void {
    this.stt?.setLang(lang);
  }

  private onChunk(id: number, text: string): void {
    const sourceLang = this.getSourceLang();
    for (const ch of this.channels) {
      void this.translateAndPublish(id, text, sourceLang, ch);
    }
  }

  private async translateAndPublish(
    id: number,
    text: string,
    sourceLang: string,
    ch: Channel,
  ): Promise<void> {
    const context = this.contexts.get(ch.code) ?? [];
    try {
      const finalText = await streamTranslate(
        { text, sourceLang, targetLang: ch.code, context },
        (partial) => {
          const now = Date.now();
          const last = this.lastInterim.get(ch.code) ?? 0;
          if (now - last >= INTERIM_THROTTLE_MS) {
            this.lastInterim.set(ch.code, now);
            this.publish(ch, { id, text: partial, lang: ch.code, final: false });
          }
        },
      );
      this.publish(ch, { id, text: finalText, lang: ch.code, final: true });
      const arr = this.contexts.get(ch.code) ?? [];
      arr.push(finalText);
      while (arr.length > 3) arr.shift();
      this.contexts.set(ch.code, arr);
    } catch (err) {
      this.onStatus(ch.code, "error", err instanceof Error ? err.message : "translate failed");
    }
  }

  private publish(ch: Channel, msg: Omit<CaptionMessage, "type">): void {
    if (!this.running) return;
    const payload = encodeCaption({ type: "caption", ...msg });
    void ch.lkRoom.localParticipant.publishData(payload, {
      reliable: msg.final,
      topic: "captions",
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stt?.stop();
    this.stt = null;
    this.chunker?.stop();
    this.chunker = null;
    await Promise.all(this.channels.map((c) => c.lkRoom.disconnect()));
    this.channels = [];
  }
}
