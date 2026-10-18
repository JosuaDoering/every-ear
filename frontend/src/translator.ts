import {
  Room,
  RoomEvent,
  LocalAudioTrack,
  createLocalAudioTrack,
  ConnectionState,
  Track,
} from "livekit-client";
import { livekitUrl } from "./livekit.js";
import { loadTranslatorGrant, clearTranslatorGrant } from "./session.js";
import { escapeHtml, setButtonLoading } from "./ui.js";
import { SentenceChunker } from "./ai/chunker.js";
import { SpeechToText } from "./ai/stt.js";
import { encodeCaption } from "./ai/types.js";
import { AiOperator, type ChannelState, type ChannelStats } from "./ai/operator.js";

const grant = loadTranslatorGrant();
if (!grant) {
  location.replace("/translator-login.html");
  throw new Error("not authenticated");
}

const isAi = grant.role === "ai-operator";

const $eventBanner = document.getElementById("event-banner") as HTMLDivElement;
const $onAir = document.getElementById("on-air") as HTMLDivElement;
const $onAirHeadline = document.getElementById("on-air-headline") as HTMLElement;
const $onAirSub = document.getElementById("on-air-sub") as HTMLElement;
const $greeting = document.getElementById("greeting") as HTMLHeadingElement;
const $translatorDetail = document.getElementById("translator-detail") as HTMLParagraphElement;
const $mic = document.getElementById("mic") as HTMLSelectElement;
const $micRefresh = document.getElementById("mic-refresh") as HTMLButtonElement;
const $micHint = document.getElementById("mic-hint") as HTMLParagraphElement;
const $micSystemHint = document.getElementById("mic-system-hint") as HTMLSpanElement;
const $connect = document.getElementById("connect") as HTMLButtonElement;
const $stop = document.getElementById("stop-broadcast") as HTMLButtonElement;
const $signOut = document.getElementById("sign-out") as HTMLButtonElement;
const $muteToggle = document.getElementById("mute-toggle") as HTMLLabelElement;
const $mute = document.getElementById("mute") as HTMLInputElement;
const $muteLabel = document.getElementById("mute-label") as HTMLSpanElement;
const $status = document.getElementById("status") as HTMLDivElement;
const $reloadPrompt = document.getElementById("reload-prompt") as HTMLDivElement;
const $reloadPromptText = document.getElementById("reload-prompt-text") as HTMLParagraphElement;
const $reloadNow = document.getElementById("reload-now") as HTMLButtonElement;
const $level = document.getElementById("level") as HTMLDivElement;
const $sourceFixed = document.getElementById("source-fixed") as HTMLParagraphElement;
const $sourceFixedName = document.getElementById("source-fixed-name") as HTMLElement;
const $aiChannels = document.getElementById("ai-channels") as HTMLDivElement;

let room: Room | null = null;
let track: LocalAudioTrack | null = null;
let levelTimer: number | null = null;
let micEnumerationToken = 0;
// True while we are intentionally tearing down (stop / sign-out), so the
// resulting Disconnected event isn't mistaken for a network failure.
let expectDisconnect = false;
let reloadScheduled = false;

// AI captions for the human-translator path (self-STT of their own mic).
let stt: SpeechToText | null = null;
let chunker: SentenceChunker | null = null;
// AI operator pipeline (role = ai-operator).
let operator: AiOperator | null = null;

function setStatus(text: string, isError = false) {
  $status.textContent = text;
  $status.classList.toggle("error", isError);
}

if (grant.eventName) {
  $eventBanner.textContent = grant.eventName;
  $eventBanner.hidden = false;
}

$greeting.textContent = `Hello, ${grant.name}`;
if (isAi) {
  const count = grant.aiLanguages?.length ?? 0;
  $translatorDetail.textContent = `AI translation into ${count} language${count === 1 ? "" : "s"}`;
  // The source language belongs to the event: the operator speaks what the
  // organiser configured, so there is nothing to pick here.
  const sourceName = grant.sourceLangName ?? grant.sourceLang?.toUpperCase() ?? "—";
  $sourceFixedName.textContent = `${grant.sourceLangFlag ?? ""} ${sourceName}`.trim();
  $sourceFixed.hidden = false;
  $aiChannels.hidden = false;
  // Web Speech ignores deviceId, so a picker here would only pretend to work.
  $mic.disabled = true;
  $micRefresh.hidden = true;
  $micSystemHint.hidden = false;
  renderAiChannels();
} else {
  $translatorDetail.textContent = `Translating into ${grant.flag ?? ""}  ${grant.languageName ?? ""}`;
}

// One status row per AI language channel.
function renderAiChannels() {
  $aiChannels.innerHTML = "";
  for (const ai of grant?.aiLanguages ?? []) {
    const row = document.createElement("div");
    row.className = "ai-channel-row";
    row.dataset.code = ai.code;
    row.innerHTML = `<span class="ai-channel-lang">${escapeHtml(ai.flag)} ${escapeHtml(
      ai.name,
    )}</span>
      <span class="ai-channel-state" data-state="idle">idle</span>
      <span class="ai-channel-health" hidden></span>`;
    $aiChannels.appendChild(row);
  }
}

function setChannelState(code: string, state: ChannelState, detail?: string) {
  const el = $aiChannels.querySelector<HTMLElement>(
    `.ai-channel-row[data-code="${code}"] .ai-channel-state`,
  );
  if (!el) return;
  el.dataset.state = state;
  el.textContent = detail ? `${state} — ${detail}` : state;
}

/**
 * Show what the channel is actually doing: sentences delivered and how long
 * listeners wait. Numbers are rounded hard — the point is spotting a channel
 * that is falling behind, not measuring milliseconds.
 */
function setChannelStats(code: string, stats: ChannelStats) {
  const el = $aiChannels.querySelector<HTMLElement>(
    `.ai-channel-row[data-code="${code}"] .ai-channel-health`,
  );
  if (!el) return;
  if (stats.done === 0) {
    el.hidden = true;
    return;
  }
  const first = (stats.firstTextMs / 1000).toFixed(1);
  const lag = (stats.latencyMs / 1000).toFixed(1);
  el.hidden = false;
  el.dataset.behind = Number(lag) > 4 ? "true" : "false";
  el.textContent = `${stats.done} sentences · first text after ${first}s · complete after ${lag}s`;
}

type OnAirState = "off" | "live" | "muted" | "reconnecting" | "error";

function setOnAir(state: OnAirState) {
  if (state === "off") {
    $onAir.hidden = true;
    $onAir.className = "on-air";
    return;
  }
  $onAir.hidden = false;
  // One state class drives the colour so each situation is unmistakable.
  $onAir.className = `on-air ${state}`;
  if (state === "live") {
    $onAirHeadline.textContent = "🔊 ON AIR — you can be heard";
    $onAirSub.textContent = "You are live. Listeners hear you right now.";
  } else if (state === "muted") {
    $onAirHeadline.textContent = "🔇 Muted — nobody hears you";
    $onAirSub.textContent = "Switch the toggle back on to be heard again.";
  } else if (state === "reconnecting") {
    $onAirHeadline.textContent = "⏳ Reconnecting…";
    $onAirSub.textContent = "Network glitch — trying to restore your broadcast.";
  } else if (state === "error") {
    $onAirHeadline.textContent = "⚠️ Connection lost — you are NOT heard";
    $onAirSub.textContent = "Trying to reconnect.";
  }
}

function setBroadcastUI(broadcasting: boolean) {
  $connect.hidden = broadcasting;
  $stop.hidden = !broadcasting;
  // The AI operator has no single live/mute audio track, so no mute toggle.
  $muteToggle.hidden = !broadcasting || isAi;
  // While broadcasting, the mic select is disabled — switching device
  // mid-stream is jarring and rarely what you want. The AI path stays disabled
  // because speech recognition cannot follow a chosen device at all.
  $mic.disabled = broadcasting || isAi;
  $micRefresh.disabled = broadcasting;
  $micHint.hidden = broadcasting;
}

function syncMuteState() {
  if (!track) {
    $mute.checked = false;
    $muteLabel.textContent = "Live — broadcasting";
    return;
  }
  const muted = track.isMuted;
  // Toggle is "on" = broadcasting. So checked when NOT muted.
  $mute.checked = !muted;
  $muteLabel.textContent = muted ? "Muted — nobody hears you" : "Live — broadcasting";
  setOnAir(muted ? "muted" : "live");
}

// ---- Microphone enumeration ------------------------------------------------

function rememberSelectedMic(): string {
  return $mic.value;
}

function populateMics(mics: MediaDeviceInfo[]): void {
  const previous = rememberSelectedMic();
  $mic.innerHTML = "";

  const def = document.createElement("option");
  def.value = "";
  def.textContent =
    mics.length === 0
      ? "System default (no other microphones found)"
      : "System default microphone";
  $mic.appendChild(def);

  for (const d of mics) {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `Microphone ${$mic.children.length}`;
    $mic.appendChild(opt);
  }

  if (previous && Array.from($mic.options).some((o) => o.value === previous)) {
    $mic.value = previous;
  }
}

async function ensureMicPermission(): Promise<boolean> {
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    await new Promise((r) => setTimeout(r, 80));
    probe.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    return false;
  }
}

async function enumerateMicsWithRetry(): Promise<MediaDeviceInfo[]> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === "audioinput");
    if (mics.length > 0) return mics;
    await new Promise((r) => setTimeout(r, 150 + attempt * 200));
  }
  return [];
}

async function loadMics(opts: { silent?: boolean } = {}): Promise<void> {
  const myToken = ++micEnumerationToken;
  if (!opts.silent) setStatus("Looking for microphones…");

  const ok = await ensureMicPermission();
  if (myToken !== micEnumerationToken) return;

  if (!ok) {
    setStatus("Microphone access denied. Allow it in your browser settings.", true);
    populateMics([]);
    return;
  }

  const mics = await enumerateMicsWithRetry();
  if (myToken !== micEnumerationToken) return;

  populateMics(mics);
  if (!opts.silent) {
    if (mics.length === 0) {
      setStatus(
        "No microphones detected — using system default. Tap ↻ to retry.",
        true,
      );
    } else {
      setStatus("");
    }
  }

  // Keep the level meter running off the system default so the translator
  // can verify their mic before going live.
  if (!room) {
    void startPreviewLevelMeter();
  }
}

navigator.mediaDevices?.addEventListener?.("devicechange", () => {
  void loadMics({ silent: true });
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void loadMics({ silent: true });
  }
});

$mic.addEventListener("focus", () => void loadMics({ silent: true }));
$mic.addEventListener("mousedown", () => void loadMics({ silent: true }));
$mic.addEventListener("change", () => {
  if (!room) void startPreviewLevelMeter();
});
$micRefresh.addEventListener("click", () => void loadMics());

// ---- Level meter -----------------------------------------------------------

let previewStream: MediaStream | null = null;
let previewCtx: AudioContext | null = null;

function stopLevelMeter() {
  if (levelTimer != null) {
    clearInterval(levelTimer);
    levelTimer = null;
  }
  $level.style.width = "0%";
}

function teardownPreview() {
  if (previewStream) {
    previewStream.getTracks().forEach((t) => t.stop());
    previewStream = null;
  }
  if (previewCtx) {
    void previewCtx.close();
    previewCtx = null;
  }
}

async function startPreviewLevelMeter() {
  if (room) return; // Live meter will take over.
  stopLevelMeter();
  teardownPreview();
  try {
    // The AI path always records the system default device, so preview the
    // same one the recogniser will use.
    const deviceId = isAi ? undefined : $mic.value || undefined;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    });
    previewStream = stream;
    runMeterOnStream(stream);
  } catch {
    // Permission denied — meter just stays at zero.
  }
}

function runMeterOnStream(stream: MediaStream) {
  const ctx = new AudioContext();
  previewCtx = ctx;
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  src.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  levelTimer = window.setInterval(() => {
    analyser.getByteFrequencyData(data);
    let sum = 0;
    for (const v of data) sum += v;
    $level.style.width = `${Math.min(100, (sum / data.length / 128) * 100)}%`;
  }, 80);
}

function startLiveLevelMeter(t: LocalAudioTrack) {
  stopLevelMeter();
  teardownPreview();
  const stream = new MediaStream([t.mediaStreamTrack]);
  runMeterOnStream(stream);
}

// ---- Connect / disconnect --------------------------------------------------

async function connect() {
  if (!grant) return;
  const deviceId = $mic.value || undefined;
  expectDisconnect = false;
  hideReloadPrompt();
  setButtonLoading($connect, true);
  setStatus("Connecting…");

  try {
    track = await createLocalAudioTrack({
      deviceId,
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    });

    room = new Room({
      publishDefaults: {
        audioPreset: { maxBitrate: 32_000, priority: "high" },
        dtx: true,
        red: true,
      },
    });

    room.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
      if (state === ConnectionState.Reconnecting) {
        setOnAir("reconnecting");
        setStatus("Network glitch — reconnecting…", true);
      } else if (state === ConnectionState.Connected) {
        syncMuteState();
        setStatus("");
      }
    });
    room.on(RoomEvent.Disconnected, () => {
      if (expectDisconnect) return;
      handleNetworkError();
    });

    await room.connect(livekitUrl(), grant.token!);
    await room.localParticipant.publishTrack(track, {
      source: Track.Source.Microphone,
    });

    setBroadcastUI(true);
    syncMuteState();
    setStatus("");
    startLiveLevelMeter(track);
    startTranslatorCaptions(room, grant.language!);
  } catch (err) {
    console.error(err);
    setStatus(err instanceof Error ? err.message : "Could not start broadcast.", true);
    teardownLive();
  } finally {
    setButtonLoading($connect, false);
  }
}

// Transcribe the translator's own speech and publish it as captions into their
// channel. Audio still broadcasts even if the browser lacks speech recognition.
function startTranslatorCaptions(r: Room, lang: string) {
  if (!SpeechToText.isSupported()) return;
  chunker = new SentenceChunker((chunk) => {
    const payload = encodeCaption({
      type: "caption",
      id: chunk.id,
      text: chunk.text,
      lang,
      final: true,
    });
    void r.localParticipant.publishData(payload, { reliable: true, topic: "captions" });
  });
  stt = new SpeechToText(lang, {
    onTranscript: (text) => chunker?.push(text),
    onRestart: () => {
      // The session is ending mid-sentence: keep the pending words, then reset.
      chunker?.flush();
      chunker?.reset();
    },
    // Audio keeps flowing, but listeners would silently lose captions. Say so
    // instead of showing an on-air translator without subtitles.
    onError: (msg) => setStatus(`Captions stopped: ${msg}. Audio is unaffected.`, true),
  });
  stt.start();
}

function stopCaptions() {
  stt?.stop();
  stt = null;
  // Publish the last unfinished sentence; the room is still up at this point.
  chunker?.flush();
  chunker?.stop();
  chunker = null;
}

// AI operator: no listener audio track — transcribe the source mic and fan out
// translated captions to every AI-language room.
async function connectAi() {
  expectDisconnect = false;
  hideReloadPrompt();
  setButtonLoading($connect, true);
  setStatus("Connecting…");
  try {
    operator = new AiOperator(
      grant!,
      (code, state, detail) => setChannelState(code, state, detail),
      (code, stats) => setChannelStats(code, stats),
    );
    await operator.start();
    setBroadcastUI(true);
    setOnAir("live");
    setStatus("");
  } catch (err) {
    console.error(err);
    setStatus(err instanceof Error ? err.message : "Could not start AI translation.", true);
    void teardownLive();
  } finally {
    setButtonLoading($connect, false);
  }
}

function teardownLive() {
  // Mark the upcoming room.disconnect() as intentional.
  expectDisconnect = true;
  stopLevelMeter();
  stopCaptions();
  if (operator) {
    void operator.stop();
    operator = null;
  }
  if (track) {
    track.stop();
    track = null;
  }
  if (room) {
    void room.disconnect();
    room = null;
  }
  // Reset AI channel status rows back to idle.
  for (const el of $aiChannels.querySelectorAll<HTMLElement>(".ai-channel-state")) {
    el.dataset.state = "idle";
    el.textContent = "idle";
  }
  setBroadcastUI(false);
  setOnAir("off");
  $mute.checked = false;
  $muteLabel.textContent = "Live — broadcasting";
  // Restart preview meter so the translator can see their mic level again.
  void startPreviewLevelMeter();
}

// ---- Network-error recovery ------------------------------------------------

function scheduleReload(delayMs: number) {
  if (reloadScheduled) return;
  reloadScheduled = true;
  window.setTimeout(() => location.reload(), delayMs);
}

function showReloadPrompt(text: string) {
  $reloadPromptText.textContent = text;
  $reloadPrompt.hidden = false;
}

function hideReloadPrompt() {
  $reloadPrompt.hidden = true;
}

// An unexpected disconnect: LiveKit gave up reconnecting. Recover by reloading
// the page when the network is available, otherwise ask the translator to
// reload and auto-reload as soon as connectivity returns.
function handleNetworkError() {
  if (reloadScheduled) return;
  setOnAir("error");
  setBroadcastUI(false);
  stopLevelMeter();
  stopCaptions();
  if (operator) {
    void operator.stop();
    operator = null;
  }
  if (track) {
    track.stop();
    track = null;
  }
  room = null;

  if (navigator.onLine) {
    setStatus("Connection lost — reloading to reconnect…", true);
    scheduleReload(1500);
  } else {
    setStatus("You're offline — listeners can't hear you.", true);
    showReloadPrompt(
      "You appear to be offline. The page reloads automatically once you're back online — or tap Reload.",
    );
    window.addEventListener("online", () => scheduleReload(400), { once: true });
  }
}

$reloadNow.addEventListener("click", () => location.reload());

function signOut() {
  teardownLive();
  clearTranslatorGrant();
  location.replace("/translator-login.html");
}

$connect.addEventListener("click", () => void (isAi ? connectAi() : connect()));
$stop.addEventListener("click", () => teardownLive());
$signOut.addEventListener("click", () => signOut());

$mute.addEventListener("change", async () => {
  if (!track) return;
  // Toggle is "on" = broadcasting (not muted).
  if ($mute.checked) {
    await track.unmute();
  } else {
    await track.mute();
  }
  syncMuteState();
});

void loadMics();
