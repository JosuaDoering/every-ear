// Netcup CCP API client — only the subset needed for ACME DNS-01.
// Docs: https://ccp.netcup.net/run/webservice/servers/endpoint.php
//
// Field formats matched against acme.sh's dns_netcup.sh (widely tested):
//   - Wrapper key is "dnsrecordset", NOT "dnsrecords" (the latter triggers
//     Netcup's generic "DNS records are not in valid format" error).
//   - All record fields must be present; missing fields fail validation.
//   - deleterecord is a string ("false" / "TRUE"), not a JSON boolean.
//   - hostname is the FQDN with a trailing dot (e.g. "_acme-challenge.example.de.").
//   - priority is the empty string for non-MX records.

const ENDPOINT = "https://ccp.netcup.net/run/webservice/servers/endpoint.php?JSON";

export type NetcupCreds = {
  customerId: string;
  apiKey: string;
  apiPassword: string;
};

type NetcupResponse = {
  status: string;
  statuscode: number;
  shortmessage: string;
  longmessage: string;
  responsedata: unknown;
};

type DnsRecord = {
  id: string;
  hostname: string;
  type: string;
  priority: string;
  destination: string;
  deleterecord: string;
  state: string;
};

async function request(action: string, param: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, param }),
  });
  if (!res.ok) throw new Error(`Netcup HTTP ${res.status}`);
  const json = (await res.json()) as NetcupResponse;
  if (json.status !== "success") {
    throw new Error(`Netcup: ${json.shortmessage} — ${json.longmessage}`);
  }
  return json.responsedata;
}

export async function login(creds: NetcupCreds): Promise<string> {
  const data = (await request("login", {
    customernumber: creds.customerId,
    apikey: creds.apiKey,
    apipassword: creds.apiPassword,
  })) as { apisessionid: string };
  return data.apisessionid;
}

export async function logout(creds: NetcupCreds, sessionId: string): Promise<void> {
  await request("logout", {
    customernumber: creds.customerId,
    apikey: creds.apiKey,
    apisessionid: sessionId,
  }).catch(() => {});
}

export async function addTxtRecord(
  zone: string,
  fqdn: string,
  value: string,
  creds: NetcupCreds,
  sessionId: string,
): Promise<void> {
  await request("updateDnsRecords", {
    apikey: creds.apiKey,
    apisessionid: sessionId,
    customernumber: creds.customerId,
    clientrequestid: "",
    domainname: zone,
    dnsrecordset: {
      dnsrecords: [
        {
          id: "",
          hostname: `${fqdn}.`,
          type: "TXT",
          priority: "",
          destination: value,
          deleterecord: "false",
          state: "yes",
        },
      ],
    },
  });
}

export async function removeTxtRecord(
  zone: string,
  fqdn: string,
  value: string,
  creds: NetcupCreds,
  sessionId: string,
): Promise<void> {
  const data = (await request("infoDnsRecords", {
    apikey: creds.apiKey,
    apisessionid: sessionId,
    customernumber: creds.customerId,
    domainname: zone,
  })) as { dnsrecords?: DnsRecord[] } | null;

  const records = data?.dnsrecords ?? [];
  const expectedHostname = `${fqdn}.`;
  const record = records.find(
    (r) =>
      r.type === "TXT" &&
      r.destination === value &&
      (r.hostname === expectedHostname || r.hostname === fqdn),
  );
  if (!record?.id) return;

  await request("updateDnsRecords", {
    apikey: creds.apiKey,
    apisessionid: sessionId,
    customernumber: creds.customerId,
    clientrequestid: "",
    domainname: zone,
    dnsrecordset: {
      dnsrecords: [
        {
          id: record.id,
          hostname: record.hostname,
          type: "TXT",
          priority: record.priority ?? "",
          destination: value,
          deleterecord: "TRUE",
          state: "yes",
        },
      ],
    },
  });
}

// Split a (sub-)domain into the Netcup zone + the hostname relative to that
// zone. Netcup uses "@" for the zone apex, otherwise the subdomain prefix.
function splitDomain(domain: string): { zone: string; host: string } {
  const parts = domain.split(".");
  const zone = parts.length <= 2 ? domain : parts.slice(-2).join(".");
  if (domain === zone) return { zone, host: "@" };
  return { zone, host: domain.slice(0, -(zone.length + 1)) };
}

function matchesHost(recordHost: string, host: string, domain: string): boolean {
  return (
    recordHost === host ||
    recordHost === `${host}.` ||
    recordHost === domain ||
    recordHost === `${domain}.`
  );
}

/**
 * Make sure the A record for `domain` points to `ip`.
 *  - no-op if the record already matches,
 *  - updates the existing record's destination if it differs,
 *  - creates a new record if none exists.
 * Returns whether anything changed plus the previous IP (for notifications).
 */
export async function ensureARecord(
  domain: string,
  ip: string,
  creds: NetcupCreds,
): Promise<{ changed: boolean; previousIp: string | null }> {
  const { zone, host } = splitDomain(domain);
  const sessionId = await login(creds);
  try {
    const data = (await request("infoDnsRecords", {
      apikey: creds.apiKey,
      apisessionid: sessionId,
      customernumber: creds.customerId,
      domainname: zone,
    })) as { dnsrecords?: DnsRecord[] } | null;

    const records = data?.dnsrecords ?? [];
    const existing = records.find(
      (r) => r.type === "A" && matchesHost(r.hostname, host, domain),
    );

    if (existing && existing.destination === ip) {
      return { changed: false, previousIp: ip };
    }

    const recordToSend = existing
      ? {
          id: existing.id,
          hostname: existing.hostname,
          type: "A",
          priority: existing.priority ?? "",
          destination: ip,
          deleterecord: "false",
          state: "yes",
        }
      : {
          id: "",
          hostname: host,
          type: "A",
          priority: "",
          destination: ip,
          deleterecord: "false",
          state: "yes",
        };

    await request("updateDnsRecords", {
      apikey: creds.apiKey,
      apisessionid: sessionId,
      customernumber: creds.customerId,
      clientrequestid: "",
      domainname: zone,
      dnsrecordset: { dnsrecords: [recordToSend] },
    });

    return { changed: true, previousIp: existing?.destination ?? null };
  } finally {
    await logout(creds, sessionId);
  }
}
