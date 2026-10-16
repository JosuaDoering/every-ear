#!/usr/bin/env bash
# acme.sh DNS-01 hook for Netcup (CCP API).
#
# Mirrors desktop/src/netcup-dns.ts: Netcup's JSON API wrapping quirks are the
# same (wrapper key "dnsrecordset", string deleterecord, trailing-dot hostname).
#
# acme.sh sources this file and calls dns_netcup_add / dns_netcup_rm. Required
# environment variables: NETCUP_CUSTOMER_ID, NETCUP_API_KEY, NETCUP_API_PASSWORD.

dns_netcup_add() {
  fulldomain="$1"
  txtvalue="$2"
  _netcup_run add "$fulldomain" "$txtvalue"
}

dns_netcup_rm() {
  fulldomain="$1"
  txtvalue="$2"
  _netcup_run remove "$fulldomain" "$txtvalue"
}

_netcup_run() {
  op="$1"
  fulldomain="$2"
  txtvalue="$3"

  for v in NETCUP_CUSTOMER_ID NETCUP_API_KEY NETCUP_API_PASSWORD; do
    eval "val=\${$v:-}"
    if [ -z "$val" ]; then
      echo "Netcup: $v is not set" >&2
      return 1
    fi
  done

  python3 - "$op" "$fulldomain" "$txtvalue" <<'PY'
import json, os, sys, urllib.request

op, fulldomain, txtvalue = sys.argv[1], sys.argv[2], sys.argv[3]
cust = os.environ["NETCUP_CUSTOMER_ID"]
key = os.environ["NETCUP_API_KEY"]
pw = os.environ["NETCUP_API_PASSWORD"]
ENDPOINT = "https://ccp.netcup.net/run/webservice/servers/endpoint.php?JSON"


def call(action, param):
    body = json.dumps({"action": action, "param": param}).encode()
    req = urllib.request.Request(ENDPOINT, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        j = json.loads(r.read())
    if j.get("status") != "success":
        raise SystemExit(f"Netcup {action} failed: {j.get('shortmessage')} {j.get('longmessage')}")
    return j.get("responsedata")


# Netcup zone = the registered domain (last two labels). Good for .com/.de etc.
parts = fulldomain.split(".")
zone = ".".join(parts[-2:]) if len(parts) >= 2 else fulldomain
fqdn = fulldomain + "."

sess = call("login", {"customernumber": cust, "apikey": key, "apipassword": pw})["apisessionid"]
try:
    data = call(
        "infoDnsRecords",
        {"apikey": key, "apisessionid": sess, "customernumber": cust, "domainname": zone},
    )
    records = (data or {}).get("dnsrecords", []) or []
    if op == "add":
        rec = {
            "id": "",
            "hostname": fqdn,
            "type": "TXT",
            "priority": "",
            "destination": txtvalue,
            "deleterecord": "false",
            "state": "yes",
        }
        call(
            "updateDnsRecords",
            {
                "apikey": key,
                "apisessionid": sess,
                "customernumber": cust,
                "clientrequestid": "",
                "domainname": zone,
                "dnsrecordset": {"dnsrecords": [rec]},
            },
        )
    else:
        match = [
            r
            for r in records
            if r.get("type") == "TXT"
            and r.get("destination") == txtvalue
            and r.get("hostname") in (fqdn, fulldomain)
        ]
        if match:
            r = match[0]
            rec = {
                "id": r["id"],
                "hostname": r["hostname"],
                "type": "TXT",
                "priority": r.get("priority", ""),
                "destination": txtvalue,
                "deleterecord": "TRUE",
                "state": "yes",
            }
            call(
                "updateDnsRecords",
                {
                    "apikey": key,
                    "apisessionid": sess,
                    "customernumber": cust,
                    "clientrequestid": "",
                    "domainname": zone,
                    "dnsrecordset": {"dnsrecords": [rec]},
                },
            )
finally:
    try:
        call("logout", {"customernumber": cust, "apikey": key, "apisessionid": sess})
    except Exception:
        pass

print("ok")
PY
}
