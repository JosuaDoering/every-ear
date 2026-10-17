#!/usr/bin/env bash
# acme.sh DNS-01 hook for netcup's new REST API (CloudDNS).
#
# The legacy CCP API (key + password + customer number) is no longer supported
# here. Configure a single REST API key (64 characters):
#
#     export NETCUP_API_KEY='...'
#
# The REST API can only manage `_acme-challenge` records, which is all DNS-01
# needs. It cannot create A/AAAA records — set those manually in the CCP.

dns_netcup_add() {
  fulldomain="$1"
  txtvalue="$2"
  _netcup_rest add "$fulldomain" "$txtvalue"
}

dns_netcup_rm() {
  fulldomain="$1"
  txtvalue="$2"
  _netcup_rest remove "$fulldomain" "$txtvalue"
}

_netcup_rest() {
  op="$1"
  fulldomain="$2"
  txtvalue="$3"

  if [ -z "${NETCUP_API_KEY:-}" ]; then
    echo "netcup: NETCUP_API_KEY is not set (the 64-character REST API key)." >&2
    return 1
  fi

  python3 - "$op" "$fulldomain" "$txtvalue" <<'PY'
import json, os, sys, time, urllib.error, urllib.parse, urllib.request

op, fulldomain, txtvalue = sys.argv[1], sys.argv[2], sys.argv[3]
API_KEY = os.environ["NETCUP_API_KEY"]
BASE = "https://api.netcup.com/v1"
HEADERS = {
    "Authorization": f"Bearer {API_KEY}",
    "Accept": "application/json",
    "Content-Type": "application/json",
}


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers=HEADERS, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            raw = res.read().decode() or ""
            return res.status, raw
    except urllib.error.HTTPError as err:
        raw = err.read().decode() or ""
        return err.code, raw


def find_domain_object(value):
    if isinstance(value, list):
        for item in value:
            found = find_domain_object(item)
            if found:
                return found
        return None
    if not isinstance(value, dict):
        return None
    if "fqdn" in value and "id" in value:
        return value
    for nested in value.values():
        found = find_domain_object(nested)
        if found:
            return found
    return None


def get_domain(fqdn):
    status, raw = call("GET", "/domain?fqdn=" + urllib.parse.quote(fqdn))
    if status >= 400:
        raise SystemExit(f"netcup API HTTP {status}: {raw[:300]}")
    try:
        data = json.loads(raw) if raw else None
    except json.JSONDecodeError:
        return None
    found = find_domain_object(data)
    if found:
        return {"id": int(found["id"]), "fqdn": found["fqdn"],
                "managed": found.get("isDnsManaged") is not False}
    if isinstance(data, dict) and data.get("code") == "resourceDoesNotExist":
        return None
    if isinstance(data, dict) and data.get("success") is True:
        return None
    raise SystemExit(f"netcup API: {raw[:300]}")


def resolve_zone(challenge_name):
    labels = [l for l in challenge_name.split(".") if l]
    start = 1 if challenge_name.startswith("_acme-challenge.") else 0
    for i in range(start, len(labels)):
        found = get_domain(".".join(labels[i:]))
        if found:
            return found
    raise SystemExit(f"netcup: no DNS zone found for {challenge_name} in this account.")


def scope_for(challenge_name, zone_fqdn):
    host = challenge_name[len("_acme-challenge."):] if challenge_name.startswith("_acme-challenge.") else challenge_name
    if host == zone_fqdn:
        return "@"
    if host.endswith("." + zone_fqdn):
        host = host[: -(len(zone_fqdn) + 1)]
    return host


zone = resolve_zone(fulldomain)
if not zone["managed"]:
    raise SystemExit(
        f"netcup: the DNS of {zone['fqdn']} is not managed by CloudDNS; the new API cannot manage it."
    )
scope = scope_for(fulldomain, zone["fqdn"])

if op == "add":
    status, raw = call(
        "POST", f"/domain/{zone['id']}/acme/challenge", {"scope": scope, "value": txtvalue}
    )
    if status >= 400:
        raise SystemExit(f"netcup API HTTP {status}: {raw[:300]}")
    try:
        body = json.loads(raw) if raw else None
        if isinstance(body, dict) and body.get("success") is False:
            raise SystemExit(f"netcup API: {raw[:300]}")
    except json.JSONDecodeError:
        pass

    # Wait for the asynchronous deployment to the nameservers.
    path = f"/domain/{zone['id']}/acme/challenge/{urllib.parse.quote(scope)}/{urllib.parse.quote(txtvalue)}"
    for _ in range(12):
        time.sleep(5)
        st, body = call("GET", path)
        if st < 400 and "deployed" in body:
            break
else:
    path = f"/domain/{zone['id']}/acme/challenge/{urllib.parse.quote(scope)}/{urllib.parse.quote(txtvalue)}"
    status, raw = call("DELETE", path)
    if status not in (200, 204, 404):
        raise SystemExit(f"netcup API HTTP {status}: {raw[:300]}")

print("ok")
PY
}
