// Thin wrapper over the browser Web Speech API (Chrome/Edge: webkitSpeechRecognition).
// Emits the cumulative transcript of the current recognition session and signals
// when the session restarts (cumulative resets), so the chunker can reset too.
//
// Note: Web Speech captures the system default microphone independently of the
// LiveKit track — it does not honour a selected deviceId. That's acceptable here.

type SpeechRecognitionResult = { 0: { transcript: string }; isFinal: boolean };
type SpeechRecognitionEvent = { results: { length: number } & Record<number, SpeechRecognitionResult> };
type SpeechRecognitionErrorEvent = { error: string };

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

type RecognitionCtor = new () => SpeechRecognitionLike;

function getCtor(): RecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export type SttHandlers = {
  /** Cumulative transcript of the current session, with the final flag of the last result. */
  onTranscript: (text: string, isFinal: boolean) => void;
  /** Fired before a new recognition session begins (transcript resets to ""). */
  onRestart?: () => void;
  onError?: (msg: string) => void;
};

export class SpeechToText {
  private rec: SpeechRecognitionLike | null = null;
  private active = false;
  private started = false;

  constructor(private lang: string, private readonly h: SttHandlers) {}

  static isSupported(): boolean {
    return getCtor() != null;
  }

  setLang(lang: string): void {
    this.lang = lang;
    if (this.rec) this.rec.lang = lang;
  }

  start(): void {
    const Ctor = getCtor();
    if (!Ctor) {
      this.h.onError?.("Speech recognition is not supported in this browser.");
      return;
    }
    this.active = true;
    const rec = new Ctor();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (e) => {
      let text = "";
      let lastFinal = false;
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i]!;
        text += r[0].transcript;
        lastFinal = r.isFinal;
      }
      this.h.onTranscript(text, lastFinal);
    };
    rec.onerror = (e) => {
      // 'no-speech'/'aborted' are routine — onend will restart us.
      if (e.error !== "no-speech" && e.error !== "aborted") {
        this.h.onError?.(e.error);
      }
    };
    rec.onend = () => {
      this.started = false;
      if (!this.active) return;
      this.h.onRestart?.();
      // Restart the session to keep recognition continuous.
      try {
        rec.start();
        this.started = true;
      } catch {
        // Will retry on the next tick if it threw because it's mid-stop.
        window.setTimeout(() => {
          if (this.active && !this.started) {
            try {
              rec.start();
              this.started = true;
            } catch {
              /* give up silently */
            }
          }
        }, 250);
      }
    };

    this.rec = rec;
    try {
      rec.start();
      this.started = true;
    } catch {
      // start() throws if called while already running; ignore.
    }
  }

  stop(): void {
    this.active = false;
    if (this.rec) {
      this.rec.onend = null;
      try {
        this.rec.abort();
      } catch {
        /* ignore */
      }
      this.rec = null;
    }
    this.started = false;
  }
}
