// Shared helpers for listener, translator, and admin pages.

export function livekitUrl(): string {
  // Caddy proxies /livekit/* → LiveKit server :7880.
  // livekit-client appends `/rtc` to this URL for the signaling WebSocket.
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/livekit`;
}

export type Language = { code: string; name: string; flag: string };

export async function fetchLanguages(): Promise<Language[]> {
  const res = await fetch("/api/languages");
  if (!res.ok) throw new Error("failed to load languages");
  const data = (await res.json()) as { languages: Language[] };
  return data.languages;
}
