import { AccessToken } from "livekit-server-sdk";
import { config } from "./config.js";
import { randomUUID } from "node:crypto";

const SIX_HOURS = "6h";

export async function listenerToken(language: string): Promise<string> {
  const at = new AccessToken(config.apiKey, config.apiSecret, {
    identity: `listener-${randomUUID()}`,
    ttl: SIX_HOURS,
  });
  at.addGrant({
    room: config.roomFor(language),
    roomJoin: true,
    canPublish: false,
    canSubscribe: true,
    canPublishData: false,
    hidden: true,
  });
  return at.toJwt();
}

export async function translatorToken(
  language: string,
  displayName: string,
): Promise<string> {
  const at = new AccessToken(config.apiKey, config.apiSecret, {
    identity: `translator-${language}-${randomUUID().slice(0, 8)}`,
    name: displayName,
    ttl: SIX_HOURS,
  });
  at.addGrant({
    room: config.roomFor(language),
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  return at.toJwt();
}
