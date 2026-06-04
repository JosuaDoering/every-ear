import {
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from "livekit-client";
import { livekitUrl, type Language } from "./livekit.js";

const $hero = document.getElementById("hero") as HTMLDivElement;
const $eventLabel = document.getElementById("event-label") as HTMLLabelElement;
const $eventSelect = document.getElementById("event") as HTMLSelectElement;
const $languageLabel = document.getElementById("language-label") as HTMLLabelElement;
const $select = document.getElementById("language") as HTMLSelectElement;
const $play = document.getElementById("play") as HTMLButtonElement;
const $playLabel = document.getElementById("play-label") as HTMLSpanElement;
const $status = document.getElementById("status") as HTMLDivElement;
const $audio = document.getElementById("audio") as HTMLAudioElement;
const $level = document.getElementById("level") as HTMLDivElement;
const $levelWrap = document.getElementById("level-wrap") as HTMLDivElement;
const $nowPlaying = document.getElementById("now-playing") as HTMLDivElement;
const $npFlag = document.getElementById("np-flag") as HTMLSpanElement;
const $npName = document.getElementById("np-name") as HTMLSpanElement;
const $npSuffix = document.getElementById("np-suffix") as HTMLSpanElement;
const $intro = document.getElementById("intro") as HTMLParagraphElement;

type EventEntry = {
  id: string;
  name: string;
  languages: Language[];
  hasBackground: boolean;
};

const STORAGE_KEY = "ll-listener-prefs";
type Prefs = { eventId?: string; language?: string };

let room: Room | null = null;
let levelTimer: number | null = null;
let events: EventEntry[] = [];

function loadPrefs(): Prefs {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Prefs;
  } catch {
    return {};
  }
}

function savePrefs(prefs: Prefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // ignore quota / private-mode failures
  }
}

function setStatus(text: string, isError = false) {
  $status.textContent = text;
  $status.classList.toggle("error", isError);
}

function setPlaying(playing: boolean) {
  $playLabel.textContent = playing ? "■  Stop" : "▶  Listen";
  $play.classList.toggle("danger", playing);
  $play.classList.toggle("primary", !playing);
  $select.disabled = playing;
  $eventSelect.disabled = playing;
  $levelWrap.hidden = !playing;
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
    setStatus("Tap Listen again to start audio.", true);
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
    $nowPlaying.hidden = true;
    return;
  }
  const p = activeBroadcaster(room);
  if (p) {
    const flag = languageFlagFor($select.value);
    const name = p.name?.trim() || p.identity;
    $npFlag.textContent = flag;
    $npName.textContent = name;
    $npSuffix.textContent = "is translating for you";
    $nowPlaying.hidden = false;
  } else {
    // Connected but no active broadcaster — show a "waiting" pill.
    $npFlag.textContent = "🎙";
    $npName.textContent = "Waiting";
    $npSuffix.textContent = "for the translator to start…";
    $nowPlaying.hidden = false;
  }
}

function languageFlagFor(code: string): string {
  const ev = currentEvent();
  return ev?.languages.find((l) => l.code === code)?.flag ?? "";
}

function applyEventHero(eventId: string | null, eventHasBackground: boolean) {
  if (eventId && eventHasBackground) {
    $hero.style.setProperty("--bg-image", `url("/api/events/${eventId}/background")`);
    $hero.hidden = false;
  } else {
    // Use the default background as a fallback hero.
    $hero.style.setProperty("--bg-image", `url("/api/background")`);
    $hero.hidden = false;
  }
}

function renderLanguageOptions(ev: EventEntry | undefined, preferred?: string) {
  $select.innerHTML = "";
  if (!ev || ev.languages.length === 0) {
    const opt = document.createElement("option");
    opt.disabled = true;
    opt.selected = true;
    opt.textContent = "No languages available";
    $select.appendChild(opt);
    $play.disabled = true;
    $languageLabel.hidden = false;
    return;
  }
  for (const l of ev.languages) {
    const opt = document.createElement("option");
    opt.value = l.code;
    opt.textContent = `${l.flag}  ${l.name}`;
    $select.appendChild(opt);
  }
  // Prefer remembered language if still available.
  if (preferred && ev.languages.some((l) => l.code === preferred)) {
    $select.value = preferred;
  }
  $play.disabled = false;
  $languageLabel.hidden = false;
}

function applyCurrentEvent(preferredLang?: string) {
  const ev = currentEvent();
  applyEventHero(ev ? ev.id : null, ev?.hasBackground ?? false);
  renderLanguageOptions(ev, preferredLang);
}

async function start() {
  const ev = currentEvent();
  if (!ev) {
    setStatus("Pick an event first.", true);
    return;
  }
  const language = $select.value;
  savePrefs({ eventId: ev.id, language });
  setStatus("Connecting…");
  $play.disabled = true;
  try {
    const token = await getToken(ev.id, language);
    room = new Room({ adaptiveStream: false, dynacast: false });
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
    room.on(RoomEvent.TrackPublished, (_pub: RemoteTrackPublication) =>
      updateSpeakerLabel(),
    );
    room.on(RoomEvent.TrackUnpublished, () => updateSpeakerLabel());
    room.on(RoomEvent.ParticipantConnected, () => updateSpeakerLabel());
    room.on(RoomEvent.ParticipantDisconnected, () => updateSpeakerLabel());
    room.on(RoomEvent.Disconnected, () => {
      setPlaying(false);
      detachAll();
      $nowPlaying.hidden = true;
      setStatus("");
    });

    await room.connect(livekitUrl(), token);
    setPlaying(true);
    setStatus("");
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
  setStatus("");
  $nowPlaying.hidden = true;
}

$play.addEventListener("click", () => {
  if (room) void stop();
  else void start();
});

$eventSelect.addEventListener("change", () => {
  applyCurrentEvent();
  const ev = currentEvent();
  savePrefs({ eventId: ev?.id, language: $select.value });
});

$select.addEventListener("change", () => {
  const ev = currentEvent();
  savePrefs({ eventId: ev?.id, language: $select.value });
});

(async () => {
  try {
    const res = await fetch("/api/events");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { events: EventEntry[] };
    events = data.events;
    if (events.length === 0) {
      $intro.textContent = "There are no live events right now. Check back in a moment.";
      $eventLabel.hidden = true;
      $languageLabel.hidden = true;
      $play.hidden = true;
      return;
    }

    const prefs = loadPrefs();

    for (const e of events) {
      const opt = document.createElement("option");
      opt.value = e.id;
      opt.textContent = e.name;
      $eventSelect.appendChild(opt);
    }

    // Restore previous event if still available.
    if (prefs.eventId && events.some((e) => e.id === prefs.eventId)) {
      $eventSelect.value = prefs.eventId;
    }

    // Hide event dropdown if there's only one.
    $eventLabel.hidden = events.length <= 1;

    applyCurrentEvent(prefs.language);
  } catch (err) {
    setStatus("Could not load events.", true);
    console.error(err);
  }
})();
