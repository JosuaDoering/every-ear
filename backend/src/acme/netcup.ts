// Netcup REST API client (CloudDNS).
//
// The legacy CCP API (ccp.netcup.net, key + password + customer number) is no
// longer used. The new REST API authenticates with a single API key (64 chars)
// as a Bearer token.
//
// Scope: the API currently only manages `_acme-challenge` records, which is
// exactly what DNS-01 certificate issuance needs. A/AAAA records cannot be
// managed here — those must be set manually in the netcup CCP.
//
// Docs: https://www.netcup.com/en/helpcenter/documentation/domain/our-api

const BASE = "https://api.netcup.com/v1";

/** Outbound requests must never hang forever (a stuck request holds the ACME lock). */
const REQUEST_TIMEOUT_MS = 30_000;
const timeoutSignal = (): AbortSignal => AbortSignal.timeout(REQUEST_TIMEOUT_MS);

/** Combine the per-request timeout with an optional caller abort signal. */
function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = timeoutSignal();
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

function abortError(): Error {
  const err = new Error("certificate operation aborted");
  err.name = "AbortError";
  return err;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

export type NetcupDomain = {
  id: number;
  fqdn: string;
  /** False if the zone's DNS is not managed via netcup CloudDNS. */
  isDnsManaged: boolean;
};

function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function errorText(status: number, body: string): string {
  return `netcup API HTTP ${status}: ${body.slice(0, 300)}`;
}

/** Recursively find a domain object (`id` + `fqdn`) in a JSON response. */
function findDomainObject(
  value: unknown,
): { id: number; fqdn: string; isDnsManaged?: boolean } | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDomainObject(item);
      if (found) return found;
    }
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (
    typeof obj.fqdn === "string" &&
    (typeof obj.id === "number" || typeof obj.id === "string")
  ) {
    return {
      id: Number(obj.id),
      fqdn: obj.fqdn,
      isDnsManaged:
        typeof obj.isDnsManaged === "boolean" ? obj.isDnsManaged : undefined,
    };
  }
  for (const nested of Object.values(obj)) {
    const found = findDomainObject(nested);
    if (found) return found;
  }
  return null;
}

/**
 * Look up one exact FQDN. Returns null if it is not a domain of this account,
 * throws on authentication/transport errors.
 */
async function getDomain(
  apiKey: string,
  fqdn: string,
  signal?: AbortSignal,
): Promise<NetcupDomain | null> {
  const res = await fetch(`${BASE}/domain?fqdn=${encodeURIComponent(fqdn)}`, {
    headers: headers(apiKey),
    signal: requestSignal(signal),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(errorText(res.status, text));

  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON response — treat as not found.
    return null;
  }

  const found = findDomainObject(json);
  if (found && Number.isFinite(found.id)) {
    return {
      id: found.id,
      fqdn: found.fqdn,
      isDnsManaged: found.isDnsManaged !== false,
    };
  }

  const obj = json as { success?: boolean; code?: string; message?: string } | null;
  if (obj?.code === "resourceDoesNotExist") return null;
  if (obj?.success === true) return null; // empty result → not this account
  const detail = (obj?.message ?? text.slice(0, 300)) || "unexpected response";
  throw new Error(`netcup API: ${detail}`);
}

/**
 * Find the zone that hosts `name`, walking up its labels (longest match first).
 * For `_acme-challenge.events.example.com` the `_acme-challenge` label is
 * skipped, since it can never be a zone.
 */
export async function resolveDomain(
  apiKey: string,
  name: string,
  signal?: AbortSignal,
): Promise<NetcupDomain | null> {
  const labels = name.split(".").filter(Boolean);
  const start = name.startsWith("_acme-challenge.") ? 1 : 0;
  for (let i = start; i < labels.length; i++) {
    const candidate = labels.slice(i).join(".");
    const found = await getDomain(apiKey, candidate, signal);
    if (found) return found;
  }
  return null;
}

/**
 * Host part of the challenge relative to its zone. The REST API prepends
 * `_acme-challenge.` itself, so it is stripped here.
 *   _acme-challenge.example.com        + example.com → "@"
 *   _acme-challenge.events.example.com + example.com → "events"
 */
export function challengeScope(challengeName: string, zone: string): string {
  let host = challengeName.replace(/^_acme-challenge\./, "");
  if (host === zone) return "@";
  if (host.endsWith(`.${zone}`)) host = host.slice(0, -(zone.length + 1));
  return host;
}

function challengeUrl(domain: NetcupDomain, scope: string, value: string): string {
  return (
    `${BASE}/domain/${domain.id}/acme/challenge/` +
    `${encodeURIComponent(scope)}/${encodeURIComponent(value)}`
  );
}

/**
 * Create the ACME challenge TXT record and wait (up to ~60s) until netcup has
 * deployed it to the nameservers. Returns even if it is still deploying — the
 * caller also polls public DNS, which is the authoritative check.
 */
export async function addChallenge(
  apiKey: string,
  domain: NetcupDomain,
  scope: string,
  value: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!domain.isDnsManaged) {
    throw new Error(
      `The DNS of ${domain.fqdn} is not managed by netcup CloudDNS — the new API cannot add records for it.`,
    );
  }

  const res = await fetch(`${BASE}/domain/${domain.id}/acme/challenge`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify({ scope, value }),
    signal: requestSignal(signal),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(errorText(res.status, text));
  try {
    const json = text ? (JSON.parse(text) as { success?: boolean; message?: string }) : null;
    if (json && json.success === false) {
      throw new Error(`netcup API: ${json.message ?? text.slice(0, 300)}`);
    }
  } catch (err) {
    if (err instanceof SyntaxError) {
      // non-JSON success body — accept it
    } else {
      throw err;
    }
  }

  // Wait for the asynchronous deployment to the nameservers.
  for (let attempt = 0; attempt < 12; attempt++) {
    await sleep(5_000, signal);
    try {
      const status = await fetch(challengeUrl(domain, scope, value), {
        headers: headers(apiKey),
        signal: requestSignal(signal),
      });
      if (!status.ok) continue;
      const body = await status.text();
      if (/"status"\s*:\s*"deployed"/.test(body)) return;
    } catch (err) {
      // Aborting must not be swallowed; transient errors keep polling.
      if (signal?.aborted) throw err;
    }
  }
}

/** Remove the challenge record. A missing record is treated as success. */
export async function removeChallenge(
  apiKey: string,
  domain: NetcupDomain,
  scope: string,
  value: string,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(challengeUrl(domain, scope, value), {
    method: "DELETE",
    headers: headers(apiKey),
    signal: requestSignal(signal),
  });
  if (res.status === 404) return;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(errorText(res.status, text));
  }
}
