"""Fail if a .pbit ships with parameters a customer should never see.

Step 2 of docs/BUILD.md - resetting the parameters to shipping defaults -
is easy to skip, and skipping it once shipped a template where every
parameter was null. A null BillingPeriodWeeks makes VivaPeriodStart throw
and every other table then reports only "Load was cancelled by an error
in loading a previous table", which looks like bad data rather than an
empty parameter box (issue #6).

Run before exporting:

    python docs/scripts/check_pbit_defaults.py "1. Local CSV/Consumption Central - Local CSV.pbit"

Also refuses anything that looks like a real customer path or endpoint,
which is the other half of what step 2 is guarding against.
"""
import json
import re
import sys
import zipfile
from pathlib import Path

EXPECTED = {
    "CreditRate": "0.01",
    "PrepaidCreditRate": "0.008",
    "PrepaidCreditBalance": "0",
    "GitHubBusinessSeatPrice": "19",
    "GitHubEnterpriseSeatPrice": "39",
    "BillingPeriodWeeks": "4",
    "DataFolder": '"C:\\Consumption Central\\Data"',
    "SharePointSiteUrl": '""',
    "FabricSQLEndpoint": '"your-endpoint.datawarehouse.fabric.microsoft.com"',
    "LakehouseName": '"consumption-central"',
}

# Anything matching here in a default means a real environment leaked in.
LEAKS = (
    re.compile(r"OneDrive", re.I),
    re.compile(r"[A-Za-z]:\\Users\\", re.I),
    re.compile(r"\.sharepoint\.com", re.I),
    re.compile(r"@[\w.-]+\.\w+"),
)


def decode(raw):
    """Package parts are UTF-16LE without a BOM as often as they are UTF-8."""
    if raw[:2] == b"\xff\xfe":
        return raw.decode("utf-16")
    if raw[:3] == b"\xef\xbb\xbf":
        return raw.decode("utf-8-sig")
    if len(raw) > 1 and raw[1] == 0:
        return raw.decode("utf-16-le")
    return raw.decode("utf-8")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    problems = []
    for arg in sys.argv[1:]:
        pbit = Path(arg)
        with zipfile.ZipFile(pbit) as z:
            model = json.loads(decode(z.read("DataModelSchema")))["model"]

        print(f"\n{pbit.name}")
        for e in model.get("expressions", []):
            expr = e.get("expression")
            txt = "\n".join(expr) if isinstance(expr, list) else (expr or "")
            if "IsParameterQuery=true" not in txt:
                continue
            name = e["name"]
            value = txt.split(" meta ")[0].strip()
            required = "IsParameterQueryRequired=true" in txt

            note = ""
            if name in EXPECTED and value != EXPECTED[name]:
                note = f"  <-- expected {EXPECTED[name]}"
                problems.append(f"{pbit.name}: {name} is {value}, "
                                f"expected {EXPECTED[name]}")
            elif value == "null" and not required and "Number" in txt:
                note = "  <-- optional number defaulting to null"
                problems.append(f"{pbit.name}: {name} is an optional number "
                                f"defaulting to null")
            for pat in LEAKS:
                if pat.search(value):
                    note = "  <-- looks like a real environment"
                    problems.append(f"{pbit.name}: {name} leaks {value[:60]}")
            print(f"  {name:32} {value[:44]:44}{note}")

    print()
    if problems:
        for p in problems:
            print(f"FAIL {p}")
        return 1
    print("all parameter defaults are the documented shipping values")
    return 0


if __name__ == "__main__":
    sys.exit(main())
