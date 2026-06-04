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
import { setButtonLoading } from "./ui.js";

const grant = loadTranslatorGrant();
if (!grant) {
  location.replace("/translator-login.html");
  throw new Error("not authenticated");
}

const $eventBanner = document.getElementById("event-banner") as HTMLDivElement;
const $onAir = document.getElementById("on-air") as HTMLDivElement;
const $onAirHeadline = document.getElementById("on-air-headline") as HTMLElement;
const $onAirSub = document.getElementById("on-air-sub") as HTMLElement;
const $greeting = document.getElementById("greeting") as HTMLHeadingElement;
const $translatorDetail = document.getElementById("translator-detail") as HTMLParagraphElement;
const $mic = document.getElementById("mic") as HTMLSelectElement;
const $micRefresh = document.getElementById("mic-refresh") as HTMLButtonElement;
const $micHint = document.getElementById("mic-hint") as HTMLParagraphElement;
const $connect = document.getElementById("connect") as HTMLButtonElement;
const $stop = document.getElementById("stop-broadcast") as HTMLButtonElement;
const $signOut = document.getElementById("sign-out") as HTMLButtonElement;
const $muteToggle = document.getElementById("mute-toggle") as HTMLLabelElement;
const $mute = document.getElementById("mute") as HTMLInputElement;
const $muteLabel = document.getElementById("mute-label") as HTMLSpanElement;
const $status = document.getElementById("status") as HTMLDivElement;
const $level = document.getElementById("level") as HTMLDivElement;

let room: Room | null = null;
let track: LocalAudioTrack | null = null;
let levelTimer: number | null = null;
let micEnumerationToken = 0;

function setStatus(text: string, isError = false) {
  $status.textContent = text;
  $status.classList.toggle("error", isError);
}

if (grant.eventName) {
  $eventBanner.textContent = grant.eventName;
  $eventBanner.hidden = false;
}

$greeting.textContent = `Hello, ${grant.name}`;
$translatorDetail.textContent = `Translating into ${grant.flag}  ${grant.languageName}`;

function setOnAir(state: "off" | "live" | "muted" | "reconnecting") {
  if (state === "off") {
    $onAir.hidden = true;
    return;
  }
  $onAir.hidden = false;
  $onAir.classList.toggle("muted", state === "muted");
  if (state === "live") {
    $onAirHeadline.textContent = "On air";
    $onAirSub.textContent = "You are live.";
  } else if (state === "muted") {
    $onAirHeadline.textContent = "Muted";
    $onAirSub.textContent = "Listeners hear silence right now.";
  } else if (state === "reconnecting") {
    $onAirHeadline.textContent = "Reconnecting…";
    $onAirSub.textContent = "Network glitch — hang on.";
  }
}

function setBroadcastUI(broadcasting: boolean) {
  $connect.hidden = broadcasting;
  $stop.hidden = !broadcasting;
  $muteToggle.hidden = !broadcasting;
  // While broadcasting, the mic select is disabled — switching device
  // mid-stream is jarring and rarely what you want.
  $mic.disabled = broadcasting;
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
    const deviceId = $mic.value || undefined;
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
      } else if (state === ConnectionState.Connected) {
        syncMuteState();
      }
    });
    room.on(RoomEvent.Disconnected, () => {
      teardownLive();
    });

    await room.connect(livekitUrl(), grant.token);
    await room.localParticipant.publishTrack(track, {
      source: Track.Source.Microphone,
    });

    setBroadcastUI(true);
    syncMuteState();
    setStatus("");
    startLiveLevelMeter(track);
  } catch (err) {
    console.error(err);
    setStatus(err instanceof Error ? err.message : "Could not start broadcast.", true);
    teardownLive();
  } finally {
    setButtonLoading($connect, false);
  }
}

function teardownLive() {
  stopLevelMeter();
  if (track) {
    track.stop();
    track = null;
  }
  if (room) {
    void room.disconnect();
    room = null;
  }
  setBroadcastUI(false);
  setOnAir("off");
  $mute.checked = false;
  $muteLabel.textContent = "Live — broadcasting";
  // Restart preview meter so the translator can see their mic level again.
  void startPreviewLevelMeter();
}

function signOut() {
  teardownLive();
  clearTranslatorGrant();
  location.replace("/translator-login.html");
}

$connect.addEventListener("click", () => void connect());
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
