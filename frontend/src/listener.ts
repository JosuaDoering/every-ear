import {
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from "livekit-client";
import { livekitUrl, type Language } from "./livekit.js";

const $eventSelect = document.getElementById("event") as HTMLSelectElement;
const $select = document.getElementById("language") as HTMLSelectElement;
const $play = document.getElementById("play") as HTMLButtonElement;
const $playLabel = $play.querySelector("span") as HTMLSpanElement;
const $status = document.getElementById("status") as HTMLDivElement | null;
const $audio = document.getElementById("audio") as HTMLAudioElement;
const $level = document.getElementById("level") as HTMLDivElement;
const $speaker = document.getElementById("speaker") as HTMLDivElement;

type EventEntry = {
  id: string;
  name: string;
  languages: Language[];
  hasBackground: boolean;
};

let room: Room | null = null;
let levelTimer: number | null = null;
let events: EventEntry[] = [];

function setStatus(text: string, isError = false) {
  if (!$status) return;
  $status.textContent = text;
  $status.classList.toggle("error", isError);
}

function setPlaying(playing: boolean) {
  $playLabel.textContent = playing ? "■ Stop" : "▶ Play";
  $play.classList.toggle("playing", playing);
  $select.disabled = playing;
  $eventSelect.disabled = playing;
}

function currentEvent(): EventEntry | undefined {
  return events.find((e) => e.id === $eventSelect.value);
}

async function getToken(eventId: string, language: string): Promise<string> {
  const res = await fetch("/api/token/listener", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventId, language }),
  });
  if (!res.ok) throw new Error(`Token request failed (${res.status})`);
  const { token } = (await res.json()) as { token: string };
  return token;
}

function attachTrack(track: RemoteTrack) {
  if (track.kind !== Track.Kind.Audio) return;
  track.attach($audio);
  $audio.play().catch(() => {
    setStatus("Tap ▶ again to start audio.", true);
  });
  startLevelMeter();
}

function detachAll() {
  $audio.srcObject = null;
  stopLevelMeter();
  $level.style.width = "0%";
}

function startLevelMeter() {
  stopLevelMeter();
  if (!$audio.srcObject) return;
  const stream = $audio.srcObject as MediaStream;
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
    const avg = sum / data.length;
    $level.style.width = `${Math.min(100, (avg / 128) * 100)}%`;
  }, 100);
}

function stopLevelMeter() {
  if (levelTimer != null) {
    clearInterval(levelTimer);
    levelTimer = null;
  }
}

function activeBroadcaster(r: Room): RemoteParticipant | null {
  for (const p of r.remoteParticipants.values()) {
    for (const pub of p.audioTrackPublications.values()) {
      if (pub.isSubscribed && !pub.isMuted) return p;
    }
  }
  return null;
}

function updateSpeakerLabel() {
  if (!room) {
    $speaker.hidden = true;
    return;
  }
  const p = activeBroadcaster(room);
  if (p) {
    const flag = languageFlagFor($select.value);
    const name = p.name?.trim() || p.identity;
    $speaker.textContent = `${flag ? flag + " " : ""}${name} is translating for you`;
    $speaker.hidden = false;
  } else {
    $speaker.hidden = true;
  }
}

function languageFlagFor(code: string): string {
  const ev = currentEvent();
  return ev?.languages.find((l) => l.code === code)?.flag ?? "";
}

function applyEventBackground(eventId: string | null) {
  const url = eventId
    ? `url("/api/events/${eventId}/background")`
    : `url("/api/background")`;
  document.documentElement.style.setProperty("--bg-image", url);
}

function renderLanguageOptions(ev: EventEntry | undefined) {
  $select.innerHTML = "";
  if (!ev || ev.languages.length === 0) {
    const opt = document.createElement("option");
    opt.disabled = true;
    opt.selected = true;
    opt.textContent = "No languages available";
    $select.appendChild(opt);
    $play.disabled = true;
    return;
  }
  for (const l of ev.languages) {
    const opt = document.createElement("option");
    opt.value = l.code;
    opt.textContent = `${l.flag}  ${l.name}`;
    $select.appendChild(opt);
  }
  $play.disabled = false;
}

function applyCurrentEvent() {
  const ev = currentEvent();
  applyEventBackground(ev ? ev.id : null);
  renderLanguageOptions(ev);
}

async function start() {
  const ev = currentEvent();
  if (!ev) {
    setStatus("Pick an event first.", true);
    return;
  }
  const language = $select.value;
  setStatus("Connecting…");
  $play.disabled = true;
  try {
    const token = await getToken(ev.id, language);
    room = new Room({
      adaptiveStream: false,
      dynacast: false,
    });
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      attachTrack(track);
      updateSpeakerLabel();
    });
    room.on(RoomEvent.TrackUnsubscribed, () => {
      detachAll();
      updateSpeakerLabel();
    });
    room.on(RoomEvent.TrackMuted, () => updateSpeakerLabel());
    room.on(RoomEvent.TrackUnmuted, () => updateSpeakerLabel());
    room.on(RoomEvent.TrackPublished, (_pub: RemoteTrackPublication) => {
      updateSpeakerLabel();
    });
    room.on(RoomEvent.TrackUnpublished, () => updateSpeakerLabel());
    room.on(RoomEvent.ParticipantConnected, () => updateSpeakerLabel());
    room.on(RoomEvent.ParticipantDisconnected, () => updateSpeakerLabel());
    room.on(RoomEvent.Disconnected, () => {
      setStatus("Disconnected.");
      setPlaying(false);
      detachAll();
      updateSpeakerLabel();
    });

    await room.connect(livekitUrl(), token);
    setPlaying(true);
    setStatus("Connected — waiting for audio…");
    updateSpeakerLabel();
  } catch (err) {
    console.error(err);
    setStatus(err instanceof Error ? err.message : "Unknown error", true);
    setPlaying(false);
  } finally {
    $play.disabled = false;
  }
}

async function stop() {
  if (room) {
    await room.disconnect();
    room = null;
  }
  detachAll();
  setPlaying(false);
  setStatus("Stopped.");
  $speaker.hidden = true;
}

$play.addEventListener("click", () => {
  if (room) void stop();
  else void start();
});

$eventSelect.addEventListener("change", () => {
  applyCurrentEvent();
});

(async () => {
  try {
    const res = await fetch("/api/events");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { events: EventEntry[] };
    events = data.events;
    if (events.length === 0) {
      setStatus("No events configured yet.", true);
      $play.disabled = true;
      return;
    }
    for (const e of events) {
      const opt = document.createElement("option");
      opt.value = e.id;
      opt.textContent = e.name;
      $eventSelect.appendChild(opt);
    }
    applyCurrentEvent();
  } catch (err) {
    setStatus("Could not load events.", true);
    console.error(err);
  }
})();
