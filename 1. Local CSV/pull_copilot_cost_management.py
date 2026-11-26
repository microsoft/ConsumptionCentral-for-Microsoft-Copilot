"""Collect Graph Cost Management credit aggregates using an app-only Azure CLI login.

Run after authenticating Azure CLI as a service principal, or pipe an app-only
Graph access token to --token-stdin. The output files are independent views,
not additive totals. Graph beta APIs are not supported for production use.
Refresh consumers only after a successful exit.
"""

import argparse
import base64
import csv
import json
import math
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from pull_azure_ai import AzureCLI, CollectionError, publish

GRAPH = "https://graph.microsoft.com"
ROOT = GRAPH + "/beta/copilot/costManagement"
SERVICE_FILE = "CopilotCostServiceDaily.csv"
FUNDING_FILE = "CopilotCostFundingMonthly.csv"
BALANCE_FILE = "CopilotCostBalance.csv"
SERVICE_HEADERS = ["Date", "ServiceId", "ConsumedQuantity", "Unit"]
FUNDING_HEADERS = ["Month", "FundingClass", "ConsumedQuantity", "Unit", "LatestSourceDateTime"]
BALANCE_HEADERS = ["AsOfUTC", "BillingMethod", "PurchasedQuantity", "ConsumedQuantity",
                   "RemainingQuantity", "Unit", "LastModifiedDateTime"]


def graph_url(url):
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or parsed.netloc.lower() != "graph.microsoft.com"
            or not parsed.path.startswith("/beta/copilot/costManagement/")
            or parsed.fragment or "\\" in url or any(ord(c) <= 32 for c in url)):
        raise CollectionError("Invalid Graph request or continuation URL")
    return url


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class GraphClient:
    def __init__(self, token, opener=None, sleep=time.sleep):
        if not isinstance(token, str) or not token:
            raise CollectionError("Missing Graph access token")
        self.token, self.opener, self.sleep = token, opener or build_opener(NoRedirect()).open, sleep

    def get(self, url):
        url = graph_url(url)
        for attempt in range(4):
            try:
                request = Request(url, headers={"Authorization": "Bearer " + self.token,
                                                "Accept": "application/json"})
                with self.opener(request, timeout=90) as response:
                    data = json.load(response)
                if not isinstance(data, dict) or "error" in data:
                    raise CollectionError("Graph returned an invalid response")
                return data
            except HTTPError as exc:
                if exc.code not in (429, 500, 502, 503, 504) or attempt == 3:
                    raise CollectionError(f"Graph request failed with HTTP {exc.code}") from exc
                retry = exc.headers.get("Retry-After")
                if retry is not None and (not retry.isdecimal() or int(retry) > 3600):
                    raise CollectionError("Graph returned an invalid Retry-After") from exc
                self.sleep(int(retry) if retry is not None else 2 ** (attempt + 1))
            except (URLError, OSError, ValueError, UnicodeDecodeError) as exc:
                raise CollectionError(f"Graph response could not be read: {type(exc).__name__}") from exc
        raise CollectionError("Graph retry limit exceeded")

    def list(self, url):
        rows, seen = [], set()
        while url:
            graph_url(url)
            if url in seen or len(seen) >= 10000:
                raise CollectionError("Repeated or excessive Graph continuation pages")
            seen.add(url)
            page = self.get(url)
            if not isinstance(page.get("value"), list):
                raise CollectionError("Graph collection has no value array")
            rows.extend(page["value"])
            url = page.get("@odata.nextLink")
            if url is not None and not isinstance(url, str):
                raise CollectionError("Invalid Graph continuation")
        return rows


def quantity(record, name, optional=False):
    value = record.get(name)
    if value is None and optional:
        return ""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise CollectionError(f"Invalid {name} in Graph response")
    return value


def text(record, name):
    value = record.get(name)
    if not isinstance(value, str) or not value:
        raise CollectionError(f"Invalid {name} in Graph response")
    return value


def unit(record):
    value = text(record, "unit")
    if value != "copilotCredit":
        raise CollectionError("Unexpected credit unit in Graph response")
    return value


def optional_status(record, field):
    status = record.get("dataStatus")
    if status is None:
        return ""
    if not isinstance(status, dict):
        raise CollectionError("Invalid dataStatus in Graph response")
    value = status.get(field)
    if value is not None and not isinstance(value, str):
        raise CollectionError("Invalid freshness timestamp in Graph response")
    return value or ""


def distinct(rows, key):
    result = {}
    for row in rows:
        identity = tuple(row[name] for name in key)
        if identity in result and result[identity] != row:
            raise CollectionError("Conflicting Graph records in the same reporting window")
        result[identity] = row
    return list(result.values())


def collect(client, start, end, as_of):
    if start >= end:
        raise CollectionError("The collection window must contain at least one completed UTC day")
    services = []
    day = start
    while day < end:
        url = ROOT + "/usageReports/serviceUsageRecords?" + urlencode(
            {"startDate": day.isoformat(), "endDate": (day + timedelta(days=1)).isoformat()})
        for item in client.list(url):
            if not isinstance(item, dict):
                raise CollectionError("Invalid Graph service record")
            services.append({"Date": day.isoformat(), "ServiceId": text(item, "serviceId"),
                             "ConsumedQuantity": quantity(item, "consumedQuantity"), "Unit": unit(item)})
        day += timedelta(days=1)

    funding = []
    month = start.replace(day=1)
    while month < end:
        url = ROOT + "/usageReports/fundingUsageRecords?" + urlencode({"month": month.strftime("%Y-%m")})
        for item in client.list(url):
            if not isinstance(item, dict):
                raise CollectionError("Invalid Graph funding record")
            funding.append({"Month": month.isoformat(), "FundingClass": text(item, "fundingClass"),
                            "ConsumedQuantity": quantity(item, "consumedQuantity"), "Unit": unit(item),
                            "LatestSourceDateTime": optional_status(item, "latestSourceDateTime")})
        month = (month.replace(day=28) + timedelta(days=4)).replace(day=1)

    snapshot = client.get(ROOT + "/getTenantCreditBalance")
    balances = snapshot.get("billingMethodBalances")
    if not isinstance(balances, list):
        raise CollectionError("Graph balance response has no billingMethodBalances array")
    balance = []
    for item in balances:
        if not isinstance(item, dict):
            raise CollectionError("Invalid Graph balance record")
        balance.append({"AsOfUTC": as_of, "BillingMethod": text(item, "billingMethod"),
                        "PurchasedQuantity": quantity(item, "purchasedQuantity", optional=True),
                        "ConsumedQuantity": quantity(item, "consumedQuantity"),
                        "RemainingQuantity": quantity(item, "remainingQuantity", optional=True),
                        "Unit": unit(item),
                        "LastModifiedDateTime": optional_status(item, "lastModifiedDateTime")})
    return {
        SERVICE_FILE: (SERVICE_HEADERS, distinct(services, ["Date", "ServiceId"])),
        FUNDING_FILE: (FUNDING_HEADERS, distinct(funding, ["Month", "FundingClass"])),
        BALANCE_FILE: (BALANCE_HEADERS, distinct(balance, ["BillingMethod"])),
    }


def app_token(payload):
    token = payload.get("accessToken") if isinstance(payload, dict) else None
    try:
        encoded = token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
    except (AttributeError, IndexError, ValueError, UnicodeDecodeError, TypeError) as exc:
        raise CollectionError("Azure CLI did not return a readable Graph access token") from exc
    roles = claims.get("roles") if isinstance(claims, dict) else None
    if (not isinstance(claims, dict) or claims.get("scp") or not isinstance(roles, list)
            or "CopilotCostManagement.Read.All" not in roles):
        raise CollectionError("The Azure CLI login must be an app with the consented "
                              "CopilotCostManagement.Read.All application permission")
    return token


def preserve_history(outdir, datasets, start, end):
    for filename, column, window_start in (
        (SERVICE_FILE, "Date", start), (FUNDING_FILE, "Month", start.replace(day=1)),
    ):
        headers, rows = datasets[filename]
        path = Path(outdir) / filename
        try:
            with path.open(newline="", encoding="utf-8-sig") as handle:
                reader = csv.DictReader(handle)
                if reader.fieldnames != headers:
                    raise CollectionError(f"{filename} has an unexpected schema")
                old = []
                for row in reader:
                    if None in row or None in row.values():
                        raise CollectionError(f"{filename} contains a malformed row")
                    try:
                        day = date.fromisoformat(row[column])
                    except (ValueError, TypeError) as exc:
                        raise CollectionError(f"{filename} has an invalid {column}") from exc
                    if day < window_start or day >= end:
                        old.append(row)
        except FileNotFoundError:
            old = []
        except (OSError, UnicodeDecodeError, csv.Error) as exc:
            raise CollectionError(f"{filename} cannot be read") from exc
        datasets[filename] = (headers, old + rows)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", help="Output folder")
    parser.add_argument("--days", type=int, default=14, help="Completed UTC days to reload")
    parser.add_argument("--token-stdin", action="store_true", help="Read an app-only Graph token from standard input")
    args = parser.parse_args(argv)
    if not 1 <= args.days <= 366:
        parser.error("--days must be between 1 and 366")
    try:
        now = datetime.now(timezone.utc)
        end = now.date()
        token = ({"accessToken": sys.stdin.read().strip()} if args.token_stdin
                 else AzureCLI().run(["account", "get-access-token", "--resource", GRAPH]))
        datasets = collect(GraphClient(app_token(token)), end - timedelta(days=args.days), end,
                           now.isoformat())
        preserve_history(args.folder, datasets, end - timedelta(days=args.days), end)
        publish(args.folder, datasets)
        print("Graph credit aggregates collected. The three files are separate, not additive.")
    except CollectionError as exc:
        print(f"Collection failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
