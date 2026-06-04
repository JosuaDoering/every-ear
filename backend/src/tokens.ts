import { AccessToken } from "livekit-server-sdk";
import { config } from "./config.js";
import { randomUUID } from "node:crypto";

const SIX_HOURS = "6h";

export async function listenerToken(
  eventId: string,
  language: string,
): Promise<string> {
  const at = new AccessToken(config.apiKey, config.apiSecret, {
    identity: `listener-${randomUUID()}`,
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
