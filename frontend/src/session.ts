// Session storage helpers shared between login pages and authenticated pages.

export type AiLanguageGrant = {
  code: string;
  name: string;
  flag: string;
  room: string;
  token: string;
};

export type TranslatorGrant = {
  role?: "translator" | "ai-operator";
  // Present for role "translator" (a single language channel).
  token?: string;
  room?: string;
  language?: string;
  languageName?: string;
  flag?: string;
  name: string;
  eventId: string;
  eventName: string;
  eventHasBackground: boolean;
  /** STT engine selected in AI settings (e.g. "web-speech"). */
  sttEngine?: string;
  // Present for role "ai-operator".
  sourceLang?: string;
  aiLanguages?: AiLanguageGrant[];
};

type StoredGrant = TranslatorGrant & { savedAt: number };

const TRANSLATOR_KEY = "tk-translator-grant";
const ADMIN_KEY = "tk-admin-token";

// LiveKit translator tokens are issued for 6 hours. Discard locally a bit
// earlier to avoid a frustrating "expired right after I sat down" moment.
const TRANSLATOR_GRANT_TTL_MS = 5 * 3600_000;

export function saveTranslatorGrant(grant: TranslatorGrant): void {
  const payload: StoredGrant = { ...grant, savedAt: Date.now() };
  sessionStorage.setItem(TRANSLATOR_KEY, JSON.stringify(payload));
}

export function loadTranslatorGrant(): TranslatorGrant | null {
  const raw = sessionStorage.getItem(TRANSLATOR_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredGrant;
    if (Date.now() - parsed.savedAt > TRANSLATOR_GRANT_TTL_MS) {
      sessionStorage.removeItem(TRANSLATOR_KEY);
      return null;
    }
    return parsed;
  } catch {
    sessionStorage.removeItem(TRANSLATOR_KEY);
    return null;
  }
}

export function clearTranslatorGrant(): void {
  sessionStorage.removeItem(TRANSLATOR_KEY);
}

export function saveAdminToken(token: string): void {
  sessionStorage.setItem(ADMIN_KEY, token);
}

export function loadAdminToken(): string | null {
  return sessionStorage.getItem(ADMIN_KEY);
}

export function clearAdminToken(): void {
  sessionStorage.removeItem(ADMIN_KEY);
}
