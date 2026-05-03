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

const $setupSection = document.getElementById("setup-section") as HTMLElement;
const $liveSection = document.getElementById("live-section") as HTMLElement;
const $whoSetup = document.getElementById("who-setup") as HTMLDivElement;
const $whoLive = document.getElementById("who-live") as HTMLDivElement;
const $mic = document.getElementById("mic") as HTMLSelectElement;
const $connect = document.getElementById("connect") as HTMLButtonElement;
const $signOut = document.getElementById("sign-out") as HTMLButtonElement;
const $mute = document.getElementById("mute") as HTMLButtonElement;
const $muteLabel = $mute.querySelector("span") as HTMLSpanElement;
const $disconnect = document.getElementById("disconnect") as HTMLButtonElement;
const $status = document.getElementById("status") as HTMLDivElement | null;
const $level = document.getElementById("level") as HTMLDivElement;

let room: Room | null = null;
let track: LocalAudioTrack | null = null;
let levelTimer: number | null = null;

function setStatus(text: string, isError = false) {
  if (!$status) return;
  $status.textContent = text;
  $status.classList.toggle("error", isError);
}

const label = `${grant.flag}  ${grant.name} → ${grant.languageName}`;
$whoSetup.textContent = label;
$whoLive.textContent = label;

async function loadMics() {
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks().forEach((t) => t.stop());
  } catch {
    setStatus("Microphone access denied.", true);
    return;
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  $mic.innerHTML = "";
  for (const d of devices.filter((d) => d.kind === "audioinput")) {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `Microphone ${$mic.children.length + 1}`;
    $mic.appendChild(opt);
  }
}

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
    await room.localParticipant.publishTrack(track, { source: Track.Source.Microphone });

    $setupSection.hidden = true;
    $liveSection.hidden = false;
    setStatus("Live.");
    startLevelMeter(track);
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
}

function signOut() {
  teardownLive();
  clearTranslatorGrant();
  location.replace("/translator-login.html");
}

$connect.addEventListener("click", () => void connect());
$disconnect.addEventListener("click", () => teardownLive());
$signOut.addEventListener("click", () => signOut());
$mute.addEventListener("click", async () => {
  if (!track) return;
  if (track.isMuted) await track.unmute();
  else await track.mute();
  $muteLabel.textContent = track.isMuted ? "Unmute" : "Mute";
});

void loadMics();
