// ACME/DNS-01 certificate issuance, moved from the desktop app into the backend
// so it can be driven from the web admin (desktop and headless alike).
//
// Paths live under the backend data dir instead of Electron's userData.

import { Client, forge, directory, axios as acmeAxios } from "acme-client";
import type { Order, Authorization } from "acme-client";
import dns from "node:dns";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import * as netcup from "./netcup.js";

// acme-client talks to Let's Encrypt through a shared axios instance. Without a
// timeout a flaky network can leave a request hanging forever, which would keep
// the ACME lock (see renewal.ts) occupied.
acmeAxios.defaults.timeout = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function acmeCertsDir(): string {
  return path.join(config.dataDir, "acme-certs");
}
function acmeAccountKeyPath(): string {
  return path.join(config.dataDir, "acme-account.pem");
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
      onProgress(`Attempt ${attempt}/${maxAttempts}: record present but value not matching yet. Retrying…`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const reason =
        code === "ENOTFOUND" || code === "ENODATA"
          ? "record not visible yet"
          : err instanceof Error
            ? err.message
            : "DNS error";
      onProgress(`Attempt ${attempt}/${maxAttempts}: ${reason}. Retrying…`);
    }
    if (attempt < maxAttempts) await sleep(intervalMs);
  }
  throw new Error(
    "DNS record did not become visible in time. Double-check the TXT record at your DNS provider, then try again.",
  );
}

export type ManualDnsChallenge = {
  recordType: "TXT";
  recordName: string;
  recordValue: string;
};

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
};

async function startDns01Order(client: Client, domain: string): Promise<PreparedOrder> {
  const order = await client.createOrder({ identifiers: [{ type: "dns", value: domain }] });
  const authorizations = await client.getAuthorizations(order);
  const authorization = authorizations[0];
  if (!authorization) throw new Error("No authorization returned from Let's Encrypt.");

  const challenge = authorization.challenges.find((c) => c.type === "dns-01");
  if (!challenge) throw new Error("DNS-01 challenge not available for this domain.");

  const txtValue = await client.getChallengeKeyAuthorization(challenge);
  return { order, authorization, challenge, txtValue };
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

export async function obtainCertificateViaNetcup(
  domain: string,
  apiKey: string,
  onProgress: (msg: string) => void,
): Promise<{ certFile: string; keyFile: string }> {
  const challengeName = `_acme-challenge.${domain}`;

  onProgress("Preparing ACME account…");
  const client = await createAcmeClient();

  onProgress("Creating certificate order…");
  const prepared = await startDns01Order(client, domain);

  onProgress("Looking up the DNS zone at netcup…");
  const zone = await netcup.resolveDomain(apiKey, challengeName);
  if (!zone) {
    throw new Error(
      `No netcup DNS zone found for ${domain}. Check that the domain belongs to this API key's account.`,
    );
  }
  const scope = netcup.challengeScope(challengeName, zone.fqdn);

  try {
    onProgress("Adding DNS TXT record…");
    await netcup.addChallenge(apiKey, zone, scope, prepared.txtValue);

    onProgress("Waiting for DNS propagation (checks every 60 s)…");
    await waitForDnsPropagation(challengeName, prepared.txtValue, onProgress);

    const result = await completeAndInstall(client, prepared, domain, onProgress);

    onProgress("Removing DNS TXT record…");
    await netcup.removeChallenge(apiKey, zone, scope, prepared.txtValue).catch(() => {});

    return result;
  } catch (err) {
    // Best effort cleanup if we failed after adding the record.
    await netcup.removeChallenge(apiKey, zone, scope, prepared.txtValue).catch(() => {});
    throw err;
  }
}

export async function obtainCertificateManual(
  domain: string,
  onProgress: (msg: string) => void,
  onChallenge: (challenge: ManualDnsChallenge) => void,
): Promise<{ certFile: string; keyFile: string }> {
  onProgress("Preparing ACME account…");
  const client = await createAcmeClient();

  onProgress("Creating certificate order…");
  const prepared = await startDns01Order(client, domain);
  const challengeName = `_acme-challenge.${domain}`;

  onChallenge({
    recordType: "TXT",
    recordName: challengeName,
    recordValue: prepared.txtValue,
  });

  onProgress("Waiting for the TXT record to appear (checks every 20 s)…");
  await waitForDnsPropagation(challengeName, prepared.txtValue, onProgress, {
    intervalMs: 20_000,
    maxAttempts: 30,
  });

  const result = await completeAndInstall(client, prepared, domain, onProgress);
  onProgress("Certificate installed. You can now delete the TXT record at your DNS provider.");
  return result;
}
