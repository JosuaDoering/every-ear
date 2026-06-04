// Shared types + wire encoding for AI captions sent over LiveKit data messages.

export type CaptionMessage = {
  type: "caption";
  /** Monotonic sentence id from the SentenceChunker. */
  id: number;
  text: string;
  /** Language code of the channel this caption belongs to. */
  lang: string;
  /** Whether this is the final text for the sentence (vs. a streaming update). */
  final: boolean;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeCaption(msg: CaptionMessage): Uint8Array {
  return encoder.encode(JSON.stringify(msg));
}

export function decodeCaption(payload: Uint8Array): CaptionMessage | null {
  try {
    const obj = JSON.parse(decoder.decode(payload)) as Partial<CaptionMessage>;
    if (obj && obj.type === "caption" && typeof obj.text === "string" && typeof obj.id === "number") {
      return {
        type: "caption",
        id: obj.id,
        text: obj.text,
        lang: typeof obj.lang === "string" ? obj.lang : "",
        final: Boolean(obj.final),
      };
    }
  } catch {
    // Not a caption payload.
  }
  return null;
}
