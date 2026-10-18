import {
  Room,
  RoomEvent,
  ConnectionState,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from "livekit-client";
import { livekitUrl, type Language } from "./livekit.js";
import { decodeCaption } from "./ai/types.js";

type ListenerLanguage = Language & { ai?: boolean };

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
const $npBadge = document.getElementById("np-badge") as HTMLSpanElement;
const $intro = document.getElementById("intro") as HTMLParagraphElement;
const $captions = document.getElementById("captions") as HTMLDivElement;
const $readAloudRow = document.getElementById("read-aloud-row") as HTMLLabelElement;
const $readAloud = document.getElementById("read-aloud") as HTMLInputElement;
const $subtitleTools = document.getElementById("subtitle-tools") as HTMLDivElement;
const $sizeOptions = Array.from(
  document.querySelectorAll<HTMLButtonElement>(".size-option"),
);
const $subtitleFullscreen = document.getElementById(
  "subtitle-fullscreen",
) as HTMLButtonElement;

type EventEntry = {
  id: string;
  name: string;
  languages: ListenerLanguage[];
  hasBackground: boolean;
};

const STORAGE_KEY = "ll-listener-prefs";
type SubtitleSize = "sm" | "md" | "lg";
type Prefs = {
  eventId?: string;
  language?: string;
  /** Subtitle text size, kept per device — eyes don't change per event. */
  subtitleSize?: SubtitleSize;
  /** Large view: subtitles fill the screen, for people at the back of a room. */
  largeView?: boolean;
};

let room: Room | null = null;
let levelTimer: number | null = null;
// Kept so the meter can be torn down: an AudioContext holds a real audio graph
// and hitting the browser's context limit silently breaks later calls.
let levelCtx: AudioContext | null = null;
let events: EventEntry[] = [];

function loadPrefs(): Prefs {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Prefs;
  } catch {
    return {};
  }
}

function setStatus(text: string, isError = false) {
  $status.textContent = text;
  $status.classList.toggle("error", isError);
}

function setPlaying(playing: boolean) {
  const ai = selectedIsAi();
  $playLabel.textContent = playing ? "■  Stop" : "▶  Listen";
  $play.classList.toggle("danger", playing);
  $play.classList.toggle("primary", !playing);
  $select.disabled = playing;
  $eventSelect.disabled = playing;
  // AI channels have no shared audio meter in this build — captions only.
  $levelWrap.hidden = !playing || ai;
  $readAloudRow.hidden = !(playing && ai);
  $subtitleTools.hidden = !playing;
  if (!playing) clearCaptions();
}

function currentEvent(): EventEntry | undefined {
  return events.find((e) => e.id === $eventSelect.value);
}

function selectedIsAi(): boolean {
  const ev = currentEvent();
  return Boolean(ev?.languages.find((l) => l.code === $select.value)?.ai);
}

// ---- Subtitle presentation -------------------------------------------------
//
// Small, quiet controls under the subtitle band. Both settings are remembered
// on the device: someone who needs large text needs it at every event.

const SIZE_CLASS: Record<SubtitleSize, string> = {
  sm: "subtitle-sm",
  md: "subtitle-md",
  lg: "subtitle-lg",
};

let prefs: Prefs = loadPrefs();

function savePrefs(patch: Partial<Prefs>) {
  prefs = { ...prefs, ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // ignore quota / private-mode failures
  }
}

function applySubtitlePrefs() {
  const size: SubtitleSize = prefs.subtitleSize ?? "md";
  for (const [key, cls] of Object.entries(SIZE_CLASS)) {
    $captions.classList.toggle(cls, key === size);
  }
  for (const btn of $sizeOptions) {
    btn.setAttribute("aria-pressed", String(btn.dataset.size === size));
  }
  const large = Boolean(prefs.largeView);
  document.body.classList.toggle("subtitle-large-view", large);
  $subtitleFullscreen.setAttribute("aria-pressed", String(large));
  const label = $subtitleFullscreen.querySelector(".subtitle-mode-label");
  if (label) label.textContent = large ? "Normal view" : "Large view";
}

for (const btn of $sizeOptions) {
  btn.addEventListener("click", () => {
    const size = btn.dataset.size as SubtitleSize | undefined;
    if (!size) return;
    savePrefs({ subtitleSize: size });
    applySubtitlePrefs();
    renderCaptions();
  });
}

$subtitleFullscreen.addEventListener("click", () => {
  savePrefs({ largeView: !prefs.largeView });
  applySubtitlePrefs();
  renderCaptions();
});

// Escape leaves the large view — the on-screen button stays reachable there.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && prefs.largeView) {
    savePrefs({ largeView: false });
    applySubtitlePrefs();
  }
});

// ---- Captions --------------------------------------------------------------
//
// Captions are addressed by a monotonic sentence id. Interim updates (the
// model still writing) may arrive late or out of order because they are sent
// unreliably; finals are reliable. Rules that keep the text from jumping
// backwards or flickering:
//   * an interim update never overwrites text we already hold as final
//   * an interim update for an older sentence than the newest one is ignored
//   * a snapshot (sent periodically so late joiners catch up) only fills gaps
// The rendered band shows the newest sentence large and the two before it
// smaller and dimmer, so the reader can follow on a phone at arm's length.

const MAX_CAPTIONS = 3;

type CaptionEntry = { text: string; final: boolean };
const captions = new Map<number, CaptionEntry>();
let newestId = 0;

const WAITING_HINT = "Waiting for the speaker…";
let waitingTimer: number | null = null;

function handleCaption(payload: Uint8Array) {
  const msg = decodeCaption(payload);
  if (!msg || msg.text === undefined) return;
  const text = msg.text.trim();
  if (!text) return;

  const existing = captions.get(msg.id);
  if (msg.snapshot) {
    // A snapshot is background catch-up: never regress a live caption and
    // never speak, because the listener may already have heard this line.
    if (!existing) {
      captions.set(msg.id, { text, final: msg.final });
      newestId = Math.max(newestId, msg.id);
      trimCaptions();
      renderCaptions();
    }
    return;
  }

  if (!msg.final) {
    if (existing?.final) return;
    if (msg.id < newestId) return;
  } else if (existing?.final && existing.text === text) {
    return;
  } else if (existing?.final) {
    // A repeated final for the same sentence with a different wording: keep
    // the latest, but don't speak it twice.
    captions.set(msg.id, { text, final: true });
    renderCaptions();
    return;
  }

  captions.set(msg.id, { text, final: msg.final });
  newestId = Math.max(newestId, msg.id);
  trimCaptions();
  renderCaptions();
  armWaitingHint();

  if (msg.final && selectedIsAi() && $readAloud.checked) {
    speakCaption(text, $select.value);
  }
}

function trimCaptions() {
  while (captions.size > MAX_CAPTIONS) {
    const oldest = Math.min(...captions.keys());
    captions.delete(oldest);
  }
}

/** After a pause, refresh the band so the empty state can show "waiting". */
function armWaitingHint() {
  if (waitingTimer != null) {
    clearTimeout(waitingTimer);
    waitingTimer = null;
  }
  if (!room) return;
  waitingTimer = window.setTimeout(() => {
    waitingTimer = null;
    if (!room || room.state !== ConnectionState.Connected) return;
    if (captions.size === 0) renderCaptions();
  }, 4500);
}

function renderCaptions() {
  $captions.innerHTML = "";
  const ids = [...captions.keys()].sort((a, b) => a - b);

  if (ids.length === 0) {
    // An AI channel without text is not broken, it is just quiet. Saying so
    // prevents the "are subtitles even on?" confusion.
    $captions.hidden = !(room && selectedIsAi());
    if (!$captions.hidden) {
      const hint = document.createElement("span");
      hint.className = "caption-waiting";
      if (room?.state !== ConnectionState.Connected) hint.textContent = "Connecting…";
      else if (!activeAiOperator(room)) hint.textContent = "Waiting for the AI operator…";
      else hint.textContent = WAITING_HINT;
      $captions.appendChild(hint);
    }
    return;
  }

  $captions.hidden = false;
  ids.forEach((id, index) => {
    const entry = captions.get(id)!;
    const isNewest = index === ids.length - 1;
    const line = document.createElement("span");
    line.className = `caption-line${isNewest ? " caption-current" : " caption-prev"}${
      entry.final ? "" : " caption-interim"
    }`;
    line.textContent = entry.text;
    $captions.appendChild(line);
  });

  // Keep the newest line in view on small screens with a long transcript.
  $captions.scrollTop = $captions.scrollHeight;
}

function clearCaptions() {
  captions.clear();
  newestId = 0;
  if (waitingTimer != null) {
    clearTimeout(waitingTimer);
    waitingTimer = null;
  }
  $captions.innerHTML = "";
  $captions.hidden = true;
  try {
    window.speechSynthesis?.cancel();
  } catch {
    // no speech synthesis available
  }
}

// iOS/Safari only allows speechSynthesis after a user gesture. Calling this
// from the "Listen" tap unlocks it so later captions can be spoken.
function primeSpeech() {
  if (!("speechSynthesis" in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    window.speechSynthesis.speak(u);
  } catch {
    // ignore
  }
}

function speakCaption(text: string, lang: string) {
  if (!("speechSynthesis" in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    window.speechSynthesis.speak(u);
  } catch {
    // ignore — listener still sees the text
  }
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
  levelCtx = ctx;
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
  if (levelCtx) {
    void levelCtx.close().catch(() => undefined);
    levelCtx = null;
  }
}

/** The AI operator of a room: it publishes captions only, no audio track. */
function activeAiOperator(r: Room): RemoteParticipant | null {
  for (const p of r.remoteParticipants.values()) {
    if (p.identity.startsWith("ai-")) return p;
  }
  return null;
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
  $npBadge.hidden = true;
  if (selectedIsAi()) {
    // AI channels get a voice, but the pill still names a person: listeners
    // trust "Anna (AI)" far more than an anonymous robot.
    const p = activeAiOperator(room);
    const name = p?.name?.trim() || "";
    $npFlag.textContent = "🧑";
    if (name) {
      $npName.textContent = name;
      $npBadge.hidden = false;
      $npSuffix.textContent = $readAloud.checked
        ? "is translating and reads aloud"
        : "is translating for you";
    } else {
      // Nobody is publishing right now: name the state instead of pretending
      // there is a live translation.
      $npFlag.textContent = "🎙";
      $npName.textContent = "Waiting";
      $npSuffix.textContent = "for the AI operator to start…";
      $nowPlaying.hidden = false;
      return;
    }
    $nowPlaying.hidden = false;
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
  // Unlock device speech within the tap gesture (iOS) before any await.
  if (selectedIsAi() && $readAloud.checked) primeSpeech();
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
    room.on(RoomEvent.DataReceived, (payload: Uint8Array) => handleCaption(payload));
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
      renderCaptions();
    });

    await room.connect(livekitUrl(), token);
    setPlaying(true);
    setStatus("");
    updateSpeakerLabel();
    renderCaptions();
    armWaitingHint();
  } catch (err) {
    console.error(err);
    setStatus(err instanceof Error ? err.message : "Unknown error", true);
    setPlaying(false);
    // A failed connect still left `room` assigned, so the play button would
    // take the "stop" branch on the next tap and never retry the connection.
    if (room) {
      await room.disconnect().catch(() => undefined);
      room = null;
    }
    detachAll();
    $nowPlaying.hidden = true;
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

$readAloud.addEventListener("change", () => {
  updateSpeakerLabel();
  if ($readAloud.checked) primeSpeech();
  else
    try {
      window.speechSynthesis?.cancel();
    } catch {
      // ignore
    }
});

applySubtitlePrefs();

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
