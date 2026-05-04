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

const grant = loadTranslatorGrant();
if (!grant) {
  location.replace("/translator-login.html");
  // Stop further execution while the redirect is happening.
  throw new Error("not authenticated");
}

const $eventName = document.getElementById("event-name") as HTMLDivElement | null;
const $setupSection = document.getElementById("setup-section") as HTMLElement;
const $liveSection = document.getElementById("live-section") as HTMLElement;
const $whoSetup = document.getElementById("who-setup") as HTMLDivElement | null;
const $mic = document.getElementById("mic") as HTMLSelectElement;
const $micRefresh = document.getElementById("mic-refresh") as HTMLButtonElement | null;
const $connect = document.getElementById("connect") as HTMLButtonElement;
const $signOut = document.getElementById("sign-out") as HTMLButtonElement;
const $mute = document.getElementById("mute") as HTMLButtonElement;
const $muteLabel = $mute.querySelector("span") as HTMLSpanElement;
const $status = document.getElementById("status") as HTMLDivElement | null;
const $level = document.getElementById("level") as HTMLDivElement;

let room: Room | null = null;
let track: LocalAudioTrack | null = null;
let levelTimer: number | null = null;
let micEnumerationToken = 0;

function setStatus(text: string, isError = false) {
  if (!$status) return;
  $status.textContent = text;
  $status.classList.toggle("error", isError);
}

function setBroadcasting(on: boolean) {
  document.body.classList.toggle("broadcasting", on);
}

function syncBroadcasting() {
  setBroadcasting(Boolean(room && track && !track.isMuted));
}

document.documentElement.style.setProperty(
  "--bg-image",
  `url("/api/events/${grant.eventId}/background")`,
);

if ($eventName) {
  $eventName.textContent = grant.eventName;
  $eventName.hidden = false;
}

const label = `${grant.name} → ${grant.flag}  ${grant.languageName}`;
if ($whoSetup) $whoSetup.textContent = label;

// ---- Microphone enumeration ------------------------------------------------

function rememberSelectedMic(): string {
  return $mic.value;
}

function populateMics(mics: MediaDeviceInfo[]): void {
  const previous = rememberSelectedMic();
  $mic.innerHTML = "";

  // Always offer a "system default" entry so the dropdown is never empty.
  const def = document.createElement("option");
  def.value = "";
  def.textContent =
    mics.length === 0
      ? "System default microphone (no devices listed)"
      : "System default microphone";
  $mic.appendChild(def);

  for (const d of mics) {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `Microphone ${$mic.children.length}`;
    $mic.appendChild(opt);
  }

  // Restore the previous selection where possible.
  if (previous && Array.from($mic.options).some((o) => o.value === previous)) {
    $mic.value = previous;
  }
}

async function ensureMicPermission(): Promise<boolean> {
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Holding the probe briefly lets the OS populate device labels reliably
    // — Safari especially returns blanks if the stream is torn down too fast.
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
    setStatus("Microphone access denied or unavailable.", true);
    populateMics([]);
    return;
  }

  const mics = await enumerateMicsWithRetry();
  if (myToken !== micEnumerationToken) return;

  populateMics(mics);
  if (!opts.silent) {
    if (mics.length === 0) {
      setStatus(
        "No microphones detected — using system default. Try the ↻ refresh button.",
        true,
      );
    } else {
      setStatus("");
    }
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

// Re-enumerate whenever the user opens the dropdown — catches devices that
// were plugged in or unblocked while the page was idle.
$mic.addEventListener("focus", () => void loadMics({ silent: true }));
$mic.addEventListener("mousedown", () => void loadMics({ silent: true }));
$micRefresh?.addEventListener("click", () => void loadMics());

// ---- Level meter -----------------------------------------------------------

function startLevelMeter(t: LocalAudioTrack) {
  stopLevelMeter();
  const stream = new MediaStream([t.mediaStreamTrack]);
  const ctx = new AudioContext();
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

function stopLevelMeter() {
  if (levelTimer != null) {
    clearInterval(levelTimer);
    levelTimer = null;
  }
  $level.style.width = "0%";
}

// ---- Connect / disconnect --------------------------------------------------

async function connect() {
  if (!grant) return;
  const deviceId = $mic.value || undefined;
  $connect.disabled = true;
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
        setStatus("Connection unstable — reconnecting…", true);
      }
      if (state === ConnectionState.Connected) setStatus("Live.");
    });
    room.on(RoomEvent.Disconnected, () => {
      setStatus("Disconnected.");
      teardownLive();
    });

    await room.connect(livekitUrl(), grant.token);
    await room.localParticipant.publishTrack(track, {
      source: Track.Source.Microphone,
    });

    $setupSection.hidden = true;
    $liveSection.hidden = false;
    setStatus("Live.");
    startLevelMeter(track);
    syncBroadcasting();
  } catch (err) {
    console.error(err);
    setStatus(err instanceof Error ? err.message : "Unknown error", true);
    teardownLive();
  } finally {
    $connect.disabled = false;
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
  $liveSection.hidden = true;
  $setupSection.hidden = false;
  $muteLabel.textContent = "Mute";
  setBroadcasting(false);
}

function signOut() {
  teardownLive();
  clearTranslatorGrant();
  location.replace("/translator-login.html");
}

$connect.addEventListener("click", () => void connect());
$signOut.addEventListener("click", () => signOut());
$mute.addEventListener("click", async () => {
  if (!track) return;
  if (track.isMuted) await track.unmute();
  else await track.mute();
  $muteLabel.textContent = track.isMuted ? "Unmute" : "Mute";
  syncBroadcasting();
});

void loadMics();
