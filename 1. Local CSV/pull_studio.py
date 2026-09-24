"""Collect Copilot Studio CSVs from the Power Platform API instead of by hand.

Examples:
    python pull_studio.py "C:\\Data\\ConsumptionCentral"
    python pull_studio.py "C:\\Data\\ConsumptionCentral" --days 90

Writes StudioTenantDaily.csv and StudioPerAgent.csv, the same two files the
Power Platform admin centre produces, so every path that reads a data folder
picks them up with no other change.

Uses the runner's existing Azure CLI login; this program never accepts
credentials. The signed-in principal needs Power Platform administrator, or an
app registration with Licensing.Read.All. Schedule daily after UTC midnight and
refresh Power BI ONLY after exit code 0.

Two things this cannot do. There is no per-user route on the API, so
StudioPerUser.csv remains a manual export - see fallback/. And the API keeps a
limited window, so treat these files as the current picture rather than an
archive; if you need history beyond that, use 2. Fabric or
4. Power Automate + Dataverse, which both accumulate it.

Per-agent figures are an aggregate over the requested window, stamped with the
month it ends in. That matches the admin centre export, which is also an
aggregate rather than a daily series.
"""

import argparse
import csv
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode, urlsplit

HOST = "api.powerplatform.com"
BASE = f"https://{HOST}"
API = "2024-10-01"
ENTITLEMENT = "MCSMessages"
PAGE_SIZE = 5000
MAX_PAGES = 10000
TIMEOUT = 120
RETRIES = 5

TENANT_HEADERS = ["BillingPlan Id", "BillingPlan Name", "Environment Id",
                  "Environment Name", "Capacity Type", "Entitled Quantity",
                  "Prepaid Consumed Quantity", "Pay as you go Consumed Quantity",
                  "Usage Date"]

AGENT_HEADERS = ["Agent Name", "Agent Id", "Product", "AI Feature/Billable Feature",
                 "Billed credit", "Non-billed credit", "Channel", "Knowledge Sources",
                 "Tool Used", "LLM Model", "Scenario Name", "Environment Id",
                 "Environment Name", "Snapshot Month"]

# The documented response model names `metadata` but not its keys, and what is
# in it varies by tenant. Read every key case- and separator-insensitively and
# take the first that is present, rather than guess one spelling and silently
# write blank columns.
FIELDS = {
    "agent_name": ("agentname", "resourcename", "displayname", "name"),
    "agent_id": ("agentid", "resourceid", "botid"),
    "product": ("productname", "product"),
    "feature": ("feature", "billablefeature", "aifeature"),
    "channel": ("channel", "channelname"),
    "knowledge": ("knowledgesources", "knowledge"),
    "tool": ("toolused", "tool", "tools"),
    "model": ("llmmodel", "modelname", "model"),
    "scenario": ("scenarioname", "scenario"),
    "environment": ("environmentid", "environment"),
    "nonbillable": ("nonbillableconsumed", "nonbilledcredit", "nonbillablecredits"),
    "billable": ("billableconsumed", "billedcredit", "consumed"),
    "capacity_type": ("capacitytype", "type"),
    "plan_id": ("billingplanid", "planid"),
    "plan_name": ("billingplanname", "planname"),
}


class CollectionError(RuntimeError):
    """Collection is incomplete; existing output must not be published over."""


def key(text):
    return "".join(c for c in str(text) if c.isalnum()).lower()


def meta_get(record, names, default=""):
    """First present value among `names`, matched loosely."""
    if not isinstance(record, dict):
        return default
    folded = {key(k): v for k, v in record.items()}
    for name in names:
        value = folded.get(key(name))
        if value not in (None, ""):
            return value
    return default


def field(row, name, default=""):
    """Read a field from the row, then from its metadata."""
    value = meta_get(row, FIELDS[name], None)
    if value in (None, ""):
        value = meta_get(row.get("metadata") or {}, FIELDS[name], None)
    return default if value in (None, "") else value


def number(value):
    if value in (None, ""):
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def url_for(path, **params):
    if params:
        params.setdefault("api-version", API)
        return f"{BASE}{path}?{urlencode(params)}"
    return f"{BASE}{path}?{urlencode({'api-version': API})}"


def checked(url):
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or parsed.netloc.lower() != HOST
            or parsed.fragment or "\\" in url or any(ord(c) <= 32 for c in url)):
        raise CollectionError(f"refusing to request {url}")
    return url


def token():
    """A Power Platform token from the runner's existing az login."""
    executable = shutil.which("az") or shutil.which("az.cmd")
    if not executable:
        raise CollectionError("the Azure CLI is not on PATH; sign in with `az login` first")
    try:
        result = subprocess.run(
            [executable, "account", "get-access-token",
             "--resource", BASE, "--query", "accessToken", "-o", "tsv"],
            capture_output=True, text=True, timeout=180, check=False)
    except (OSError, subprocess.SubprocessError) as error:
        raise CollectionError(f"could not run the Azure CLI: {error}") from None
    if result.returncode != 0:
        detail = (result.stderr or "").strip().splitlines()
        hint = detail[-1] if detail else "no detail"
        raise CollectionError(f"could not get a token for {BASE}: {hint}")
    value = result.stdout.strip()
    if not value:
        raise CollectionError("the Azure CLI returned an empty token")
    return value


def get(url, bearer):
    """One GET, retrying on throttling and transient failure."""
    for attempt in range(RETRIES):
        request = urllib.request.Request(checked(url), headers={
            "Authorization": f"Bearer {bearer}",
            "Accept": "application/json",
        })
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
                return json.loads(response.read() or b"{}")
        except urllib.error.HTTPError as error:
            if error.code in (429, 500, 502, 503, 504) and attempt < RETRIES - 1:
                header = (error.headers.get("Retry-After")
                          or error.headers.get("x-ms-ratelimit-timeremaining")
                          or "")
                try:
                    wait = int(float(header))
                except ValueError:
                    wait = 2 ** attempt
                if wait > 300:
                    raise CollectionError(
                        f"throttled for {wait}s, which is too long to wait") from None
                time.sleep(max(1, wait))
                continue
            if error.code in (401, 403):
                raise CollectionError(
                    f"{error.code} from the licensing API - the signed-in principal "
                    f"needs Power Platform administrator or Licensing.Read.All") from None
            detail = error.read().decode("utf-8", "replace")[:300]
            raise CollectionError(f"{error.code} from {url}: {detail}") from None
        except (urllib.error.URLError, TimeoutError) as error:
            if attempt < RETRIES - 1:
                time.sleep(2 ** attempt)
                continue
            raise CollectionError(f"could not reach {HOST}: {error}") from None
    raise CollectionError(f"gave up on {url}")


def pages(url, bearer):
    """Every page of a paged collection."""
    seen = 0
    while url:
        body = get(url, bearer)
        for row in body.get("value") or []:
            yield row
        seen += 1
        if seen >= MAX_PAGES:
            raise CollectionError("too many pages; refusing to loop")
        follow = body.get("nextLink") or body.get("@odata.nextLink")
        if not follow:
            marker = body.get("continuationToken") or body.get("continuationtoken")
            if not marker:
                return
            follow = url_for(f"/licensing/entitlements/{ENTITLEMENT}/resources",
                             continuationtoken=marker, pageSize=PAGE_SIZE)
        url = follow


def environments(bearer):
    """Environment id -> display name, so the CSVs carry readable names."""
    names = {}
    try:
        for row in pages(url_for("/environmentmanagement/environments"), bearer):
            identifier = row.get("id") or row.get("name") or ""
            label = ((row.get("properties") or {}).get("displayName")
                     or row.get("displayName") or "")
            if identifier:
                names[str(identifier).lower()] = label
    except CollectionError as error:
        # Names are a convenience. Losing them should not lose the numbers.
        print(f"warning: could not read environment names ({error})", file=sys.stderr)
    return names


def capacity(bearer):
    """Entitlement totals, used for the entitled and prepaid columns."""
    body = get(url_for(f"/licensing/entitlements/{ENTITLEMENT}"), bearer)
    rows = body.get("value") if isinstance(body.get("value"), list) else [body]
    totals = {}
    for row in rows or []:
        environment = str(field(row, "environment", "")).lower()
        totals[environment] = {
            "entitled": number(meta_get(row, ("entitled", "entitledquantity",
                                              "allocated", "total"))),
            "plan_id": field(row, "plan_id", ""),
            "plan_name": field(row, "plan_name", ""),
        }
    return totals


def day_rows(bearer, day):
    path = f"/licensing/entitlements/{ENTITLEMENT}/resources"
    url = url_for(path, fromDate=day, toDate=day, pageSize=PAGE_SIZE)
    return list(pages(url, bearer))


def collect(bearer, days, names, totals):
    """Walk the window once, building both files from the same rows."""
    tenant = defaultdict(lambda: {"prepaid": 0.0, "payg": 0.0})
    agents = defaultdict(lambda: {"billed": 0.0, "nonbilled": 0.0})
    today = datetime.now(timezone.utc).date()
    empty = 0

    for offset in range(days, 0, -1):
        day = (today - timedelta(days=offset)).isoformat()
        rows = day_rows(bearer, day)
        if not rows:
            empty += 1
            continue
        for row in rows:
            environment = str(field(row, "environment", "")).lower()
            capacity_type = str(field(row, "capacity_type", "Pay as you go"))
            billed = number(field(row, "billable", 0))
            nonbilled = number(field(row, "nonbillable", 0))

            bucket = tenant[(environment, capacity_type, day)]
            if "prepaid" in key(capacity_type):
                bucket["prepaid"] += billed
            else:
                bucket["payg"] += billed

            agent = (
                str(field(row, "agent_id", "")),
                str(field(row, "agent_name", "")),
                str(field(row, "product", "Copilot Studio")),
                str(field(row, "feature", "")),
                str(field(row, "channel", "")),
                str(field(row, "knowledge", "")),
                str(field(row, "tool", "")),
                str(field(row, "model", "")),
                str(field(row, "scenario", "")),
                environment,
            )
            agents[agent]["billed"] += billed
            agents[agent]["nonbilled"] += nonbilled

    if empty == days:
        raise CollectionError(
            f"the API returned no usage for any of the last {days} days. "
            f"Either nothing was consumed, or this tenant has no Copilot Credits "
            f"entitlement. Nothing was written.")

    snapshot = (today - timedelta(days=1)).strftime("%Y-%m")

    tenant_rows = []
    for (environment, capacity_type, day), value in sorted(tenant.items()):
        totals_for = totals.get(environment, {})
        tenant_rows.append({
            "BillingPlan Id": totals_for.get("plan_id", ""),
            "BillingPlan Name": totals_for.get("plan_name", ""),
            "Environment Id": environment,
            "Environment Name": names.get(environment, ""),
            "Capacity Type": capacity_type,
            "Entitled Quantity": totals_for.get("entitled", ""),
            "Prepaid Consumed Quantity": round(value["prepaid"], 4),
            "Pay as you go Consumed Quantity": round(value["payg"], 4),
            "Usage Date": day,
        })

    agent_rows = []
    for identity, value in sorted(agents.items()):
        (agent_id, agent_name, product, feature, channel, knowledge,
         tool, model, scenario, environment) = identity
        agent_rows.append({
            "Agent Name": agent_name,
            "Agent Id": agent_id,
            "Product": product or "Copilot Studio",
            "AI Feature/Billable Feature": feature,
            "Billed credit": round(value["billed"], 4),
            "Non-billed credit": round(value["nonbilled"], 4),
            "Channel": channel,
            "Knowledge Sources": knowledge,
            "Tool Used": tool,
            "LLM Model": model,
            "Scenario Name": scenario,
            "Environment Id": environment,
            "Environment Name": names.get(environment, ""),
            # Never blank. The report reads this to pick the newest export, and
            # a column that exists but is empty fails the refresh outright.
            "Snapshot Month": snapshot,
        })

    return tenant_rows, agent_rows


def write(folder, name, headers, rows):
    """Replace a CSV atomically, so a reader never sees a half-written file."""
    target = folder / name
    scratch = folder / f".{name}.tmp"
    with scratch.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    os.replace(scratch, target)
    print(f"  {name}: {len(rows)} rows")


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("folder", help="the folder the template reads")
    parser.add_argument("--days", type=int, default=30,
                        help="complete days to collect, ending yesterday (default 30)")
    arguments = parser.parse_args()

    if arguments.days < 1 or arguments.days > 365:
        sys.exit("error: --days must be between 1 and 365")
    folder = Path(arguments.folder).expanduser()
    if not folder.is_dir():
        sys.exit(f"error: {folder} is not a folder")

    try:
        bearer = token()
        names = environments(bearer)
        totals = capacity(bearer)
        tenant_rows, agent_rows = collect(bearer, arguments.days, names, totals)
        # Everything is gathered and validated before anything is published.
        write(folder, "StudioTenantDaily.csv", TENANT_HEADERS, tenant_rows)
        write(folder, "StudioPerAgent.csv", AGENT_HEADERS, agent_rows)
    except CollectionError as error:
        sys.exit(f"error: {error}")

    print(f"\ndone. StudioPerUser.csv has no API - export it by hand if you "
          f"want the per-user page; see fallback/README.md")


if __name__ == "__main__":
    main()
