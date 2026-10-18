import { AccessToken, TokenVerifier, type ClaimGrants } from "livekit-server-sdk";
import { config } from "./config.js";
import { randomUUID, createHash } from "node:crypto";

const SIX_HOURS = "6h";

// Rebuild the verifier when the credentials change at runtime (web admin can
// rotate them), so we never validate against a stale secret.
let verifier: { key: string; secret: string; instance: TokenVerifier } | null = null;

function tokenVerifier(): TokenVerifier {
  const key = config.apiKey;
  const secret = config.apiSecret;
  if (!verifier || verifier.key !== key || verifier.secret !== secret) {
    verifier = { key, secret, instance: new TokenVerifier(key, secret) };
  }
  return verifier.instance;
}

export type VerifiedPublisher = {
  eventId: string;
  language: string;
  identity: string;
};

/**
 * Verify a LiveKit token issued to a translator or AI operator and return the
 * event/language it grants. Throws if the token is invalid, expired, belongs to
 * a listener (subscribe-only) or does not name a room.
 */
export async function verifyPublisherToken(token: string): Promise<VerifiedPublisher> {
  let claims: ClaimGrants;
  try {
    claims = await tokenVerifier().verify(token);
  } catch {
    throw new Error("invalid token");
  }
  const video = claims.video;
  const room = video?.room ?? "";
  const identity = typeof claims.sub === "string" ? claims.sub : "";
  if (!video?.roomJoin || !room) throw new Error("token does not grant a room");
  // Listeners are subscribe-only and hidden; only publishers may translate.
  if (video.canPublish !== true) throw new Error("token is not allowed to publish");
  if (!identity.startsWith("translator-") && !identity.startsWith("ai-")) {
    throw new Error("token is not a translator token");
  }
  const match = /^event-(.+)-lang-(.+)$/.exec(room);
  if (!match) throw new Error("token is not scoped to an event room");
  return { eventId: match[1]!, language: match[2]!, identity };
}

// Stable, anonymised key for one client so repeat connections from the same
// device/network count as a single unique listener. We never store the raw IP.
function listenerKey(clientIp: string | undefined): string {
  const ip = clientIp?.trim() || "unknown";
  return createHash("sha256").update(ip).digest("hex").slice(0, 12);
}

export async function listenerToken(
  eventId: string,
  language: string,
  clientIp?: string,
): Promise<string> {
  // identity = listener-<ipKey>-<random>. The ipKey lets the stats collector
  // dedupe by client while the random suffix keeps concurrent tabs/devices from
  // the same IP from evicting each other in LiveKit.
  const at = new AccessToken(config.apiKey, config.apiSecret, {
    identity: `listener-${listenerKey(clientIp)}-${randomUUID().slice(0, 8)}`,
    ttl: SIX_HOURS,
  });
  at.addGrant({
    room: config.roomFor(eventId, language),
    roomJoin: true,
    canPublish: false,
    canSubscribe: true,
    canPublishData: false,
    hidden: true,
  });
  return at.toJwt();
}

export async function translatorToken(
  eventId: string,
  language: string,
  displayName: string,
): Promise<string> {
  const at = new AccessToken(config.apiKey, config.apiSecret, {
    identity: `translator-${language}-${randomUUID().slice(0, 8)}`,
    name: displayName,
    ttl: SIX_HOURS,
  });
  at.addGrant({
    room: config.roomFor(eventId, language),
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  return at.toJwt();
}

/**
 * Token for the AI operator to publish subtitles (and, in a follow-up, a TTS
 * audio track) into one AI-language room. One token is issued per AI language.
 */
export async function aiPublisherToken(
  eventId: string,
  language: string,
  displayName: string,
): Promise<string> {
  const at = new AccessToken(config.apiKey, config.apiSecret, {
    identity: `ai-${language}-${randomUUID().slice(0, 8)}`,
    name: displayName,
    ttl: SIX_HOURS,
  });
  at.addGrant({
    room: config.roomFor(eventId, language),
    roomJoin: true,
    canPublish: true, // reserved for the deferred TTS audio track
    canSubscribe: false,
    canPublishData: true,
  });
  return at.toJwt();
}
