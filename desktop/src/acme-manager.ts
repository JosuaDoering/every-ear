import { Client, forge, directory } from "acme-client";
import type { Order, Authorization } from "acme-client";
import dns from "node:dns";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { acmeAccountKeyPath, acmeCertsDir } from "./paths";
import * as netcupDns from "./netcup-dns";
import type { NetcupCreds } from "./netcup-dns";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function extractZoneAndFqdn(domain: string): { zone: string; fqdn: string } {
  const parts = domain.split(".");
  const zone = parts.length <= 2 ? domain : parts.slice(-2).join(".");
  return { zone, fqdn: `_acme-challenge.${domain}` };
}

// Poll public resolvers until the TXT record is visible. Avoids the user's
// local resolver entirely (it may negative-cache the lookup for a few minutes).
async function waitForDnsPropagation(
  fqdn: string,
  expectedValue: string,
  onProgress: (msg: string) => void,
  opts: { intervalMs?: number; maxAttempts?: number } = {},
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 60_000;
  const maxAttempts = opts.maxAttempts ?? 15;

  const resolver = new dns.promises.Resolver();
  resolver.setServers(["1.1.1.1", "8.8.8.8"]);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const records = await resolver.resolveTxt(fqdn);
      const found = records.some((chunks) => chunks.join("") === expectedValue);
      if (found) {
        onProgress(`DNS record visible (attempt ${attempt}). Continuing…`);
        return;
      }
      onProgress(`Attempt ${attempt}/${maxAttempts}: record present but value not matching yet. Retrying in 60 s…`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const reason = code === "ENOTFOUND" || code === "ENODATA" ? "record not visible yet" : (err instanceof Error ? err.message : "DNS error");
      onProgress(`Attempt ${attempt}/${maxAttempts}: ${reason}. Retrying soon…`);
    }
    if (attempt < maxAttempts) await sleep(intervalMs);
  }
  throw new Error(`DNS record did not become visible in time. Double-check the TXT record at your DNS provider, then try again.`);
}

// The exact DNS record the user must create when issuing manually. Mirrors what
// the renderer shows in the "Other / manual" provider guide.
export type ManualDnsChallenge = {
  recordType: "TXT";
  recordName: string;
  recordValue: string;
};

// Shared ACME plumbing -------------------------------------------------------

async function createAcmeClient(): Promise<Client> {
  let accountKey: Buffer;
  const akPath = acmeAccountKeyPath();
  if (existsSync(akPath)) {
    accountKey = readFileSync(akPath);
  } else {
    accountKey = await forge.createPrivateKey();
    writeFileSync(akPath, accountKey, { mode: 0o600 });
  }
  const client = new Client({ directoryUrl: directory.letsencrypt.production, accountKey });
  await client.createAccount({ termsOfServiceAgreed: true });
  return client;
}

type PreparedOrder = {
  order: Order;
  authorization: Authorization;
  challenge: Authorization["challenges"][number];
  txtValue: string;
  zone: string;
  fqdn: string;
};

async function startDns01Order(client: Client, domain: string): Promise<PreparedOrder> {
  const order = await client.createOrder({ identifiers: [{ type: "dns", value: domain }] });
  const authorizations = await client.getAuthorizations(order);
  const authorization = authorizations[0];
  if (!authorization) throw new Error("No authorization returned from Let's Encrypt.");

  const challenge = authorization.challenges.find((c) => c.type === "dns-01");
  if (!challenge) throw new Error("DNS-01 challenge not available for this domain.");

  const txtValue = await client.getChallengeKeyAuthorization(challenge);
  const { zone, fqdn } = extractZoneAndFqdn(domain);
  return { order, authorization, challenge, txtValue, zone, fqdn };
}

async function completeAndInstall(
  client: Client,
  prepared: PreparedOrder,
  domain: string,
  onProgress: (msg: string) => void,
): Promise<{ certFile: string; keyFile: string }> {
  onProgress("Requesting Let's Encrypt validation…");
  await client.verifyChallenge(prepared.authorization, prepared.challenge);
  await client.completeChallenge(prepared.challenge);
  await client.waitForValidStatus(prepared.authorization);

  onProgress("Finalizing certificate order…");
  const domainKey = await forge.createPrivateKey();
  const [, csr] = await forge.createCsr({ commonName: domain, altNames: [domain] }, domainKey);
  await client.finalizeOrder(prepared.order, csr);
  const validOrder = await client.waitForValidStatus(prepared.order);
  const cert = await client.getCertificate(validOrder);

  onProgress("Installing certificate…");
  const certsDir = acmeCertsDir();
  mkdirSync(certsDir, { recursive: true });
  const certFile = path.join(certsDir, "cert.pem");
  const keyFile = path.join(certsDir, "key.pem");
  writeFileSync(certFile, cert, { mode: 0o600 });
  writeFileSync(keyFile, domainKey, { mode: 0o600 });
  return { certFile, keyFile };
}

// Automatic issuance via the Netcup DNS API.
export async function obtainCertificateViaNetcup(
  domain: string,
  creds: NetcupCreds,
  onProgress: (msg: string) => void,
): Promise<{ certFile: string; keyFile: string }> {
  onProgress("Preparing ACME account…");
  const client = await createAcmeClient();

  onProgress("Creating certificate order…");
  const prepared = await startDns01Order(client, domain);

  onProgress("Logging in to Netcup…");
  const sessionId = await netcupDns.login(creds);

  try {
    onProgress("Adding DNS TXT record…");
    await netcupDns.addTxtRecord(prepared.zone, prepared.fqdn, prepared.txtValue, creds, sessionId);

    onProgress("Waiting for DNS propagation (checks every 60 s)…");
    await waitForDnsPropagation(prepared.fqdn, prepared.txtValue, onProgress);

    const result = await completeAndInstall(client, prepared, domain, onProgress);

    onProgress("Removing DNS TXT record…");
    await netcupDns
      .removeTxtRecord(prepared.zone, prepared.fqdn, prepared.txtValue, creds, sessionId)
      .catch(() => {});

    return result;
  } finally {
    await netcupDns.logout(creds, sessionId);
  }
}

// Manual issuance: works with any DNS provider. The caller (settings UI) shows
// the user the exact TXT record via `onChallenge`; we then poll public
// resolvers until they create it, finish the order, and leave the record in
// place for the user to delete afterwards.
export async function obtainCertificateManual(
  domain: string,
  onProgress: (msg: string) => void,
  onChallenge: (challenge: ManualDnsChallenge) => void,
): Promise<{ certFile: string; keyFile: string }> {
  onProgress("Preparing ACME account…");
  const client = await createAcmeClient();

  onProgress("Creating certificate order…");
  const prepared = await startDns01Order(client, domain);

  onChallenge({
    recordType: "TXT",
    recordName: prepared.fqdn,
    recordValue: prepared.txtValue,
  });

  // Patient poll: 20 s × 30 = up to 10 min for the user to log in and add it.
  onProgress("Waiting for the TXT record to appear (checks every 20 s)…");
  await waitForDnsPropagation(prepared.fqdn, prepared.txtValue, onProgress, {
    intervalMs: 20_000,
    maxAttempts: 30,
  });

  const result = await completeAndInstall(client, prepared, domain, onProgress);
  onProgress("Certificate installed. You can now delete the TXT record at your DNS provider.");
  return result;
}
