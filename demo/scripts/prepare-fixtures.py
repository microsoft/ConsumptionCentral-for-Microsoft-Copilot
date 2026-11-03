#!/usr/bin/env python3
"""Create a neutral, deterministic browser-demo copy of the bundled synthetic CSVs."""

import argparse
import csv
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "app" / "public" / "sample"

SAFE_VALUES = {
    "product": ("Microsoft 365 Copilot", "Copilot Studio", "GitHub Copilot", "Azure AI Foundry"),
    "taskcategory": ("Writing", "Summarization", "Analysis", "Research"),
    "tasktype": ("Drafting", "Research", "Meeting recap", "Code review"),
    "servicecategory": ("AI model", "AI platform", "Other service"),
    "capacitytype": ("Provisioned", "Pay-as-you-go"),
    "pricingmodel": ("Pay-as-you-go", "Prepaid"),
    "channel": ("Web", "Teams", "Other"),
    "plan": ("Standard", "Premium"),
    "allocationstatus": ("Allocated", "Unallocated"),
    "metric": ("Input tokens", "Output tokens", "Total requests"),
    "status": ("Matched", "Estimated", "Needs review"),
    "evidencetype": ("Usage export", "Billing record", "Synthetic estimate"),
    "currency": ("USD",),
}

FAMILIES = {
    "personid": ("Person ID", "person-id-"),
    "peoplehistoricalid": ("Person", "Person "),
    "userprincipalname": ("User email", "demo-user-"),
    "email": ("User email", "demo-user-"),
    "useremail": ("User email", "demo-user-"),
    "username": ("Contributor", "contributor-"),
    "displayname": ("Person", "Person "),
    "manager": ("Manager", "Manager "),
    "agentname": ("Agent", "Agent "),
    "agentid": ("Agent ID", "agent-id-"),
    "environmentid": ("Environment ID", "environment-id-"),
    "environmentname": ("Environment", "Environment "),
    "subscriptionid": ("Subscription ID", "subscription-id-"),
    "subscriptionname": ("Subscription", "Subscription "),
    "resourceid": ("Resource ID", "resource-id-"),
    "resourcename": ("Resource", "Resource "),
    "resourcegroup": ("Resource group", "Resource group "),
    "deploymentid": ("Deployment ID", "deployment-id-"),
    "deploymentname": ("Deployment", "Deployment "),
    "application": ("Workload", "Workload "),
    "spendingpolicyid": ("Policy ID", "policy-id-"),
    "name": ("Policy", "Policy "),
    "billingowner": ("Billing owner", "Owner "),
    "chargecode": ("Charge code", "charge-"),
    "costcentre": ("Cost centre", "Cost centre "),
    "costcenter": ("Cost centre", "Cost centre "),
    "costcentername": ("Cost centre", "Cost centre "),
    "costcentrename": ("Cost centre", "Cost centre "),
    "department": ("Department", "Department "),
    "departmenttag": ("Department", "Department "),
    "organization": ("Organization", "Organization "),
    "businessunit": ("Business unit", "Business unit "),
    "jobtitle": ("Job title", "Job title "),
    "jobfamily": ("Job family", "Job family "),
    "city": ("City", "City "),
    "country": ("Region", "Region "),
    "repository": ("Repository", "Repository "),
    "organizationname": ("Organization", "Organization "),
    "meter": ("Meter", "Meter "),
    "service": ("Service", "Service "),
    "servicename": ("Service", "Service "),
    "taskcategory": ("Task category", "Task category "),
    "tasktype": ("Task type", "Task type "),
    "model": ("Model", "Model "),
    "modelname": ("Model", "Model "),
    "modelversion": ("Model version", "Model version "),
    "llmmodel": ("Model", "Model "),
    "sku": ("SKU", "SKU "),
    "skuname": ("SKU", "SKU "),
    "knowledgeSources".lower(): ("Knowledge source", "Knowledge source "),
    "toolused": ("Tool", "Tool "),
    "notes": ("Synthetic note", "Synthetic note "),
    "poolname": ("Billing pool", "Billing pool "),
    "billingplanid": ("Billing plan ID", "billing-plan-"),
    "billingplanname": ("Billing plan", "Billing plan "),
}

def normalize_header(header: str) -> str:
    return re.sub(r"[^a-z0-9]", "", header.casefold())


def is_numeric(value: str) -> bool:
    if value is None or not value.strip():
        return True
    try:
        float(value.replace(",", ""))
        return True
    except ValueError:
        return False


def is_date(header: str, value: str) -> bool:
    if value is None or not value.strip():
        return True
    if "date" in normalize_header(header) or normalize_header(header) in {"period", "periodstart", "periodend"}:
        return True
    return bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", value.strip()))


def map_text(header: str, value: str, maps: dict) -> str:
    normalized = normalize_header(header)
    if value is None or not value.strip():
        return ""
    if normalized in {"iscopilotlicensed", "m365copilotlicensed"}:
        low = value.strip().casefold()
        if low in {"true", "yes", "1"}:
            return "Yes"
        if low in {"false", "no", "0"}:
            return "No"
    values = maps.setdefault(normalized, {})
    if normalized in SAFE_VALUES:
        if value not in values:
            values[value] = len(values)
        options = SAFE_VALUES[normalized]
        return options[values[value] % len(options)]
    family, prefix = FAMILIES.get(normalized, (header.strip().title(), f"{header.strip().title()} "))
    if value not in values:
        values[value] = len(values) + 1
    number = values[value]
    if normalized in {"userprincipalname", "email", "useremail"}:
        return f"demo-user-{number:03d}@example.invalid"
    return f"{prefix}{number:03d}" if prefix.endswith("-") else f"{prefix}{number:02d}"


def prepare(output: Path) -> None:
    manifest = json.loads((SOURCE / "manifest.json").read_text(encoding="utf-8"))
    output.mkdir(parents=True, exist_ok=True)
    maps = {}
    for name in manifest:
        with (SOURCE / name).open(encoding="utf-8-sig", newline="") as stream:
            reader = csv.DictReader(stream)
            rows = list(reader)
            headers = reader.fieldnames or []
        sanitized = [
            {
                header: (
                    value
                    if is_numeric(value) or is_date(header, value)
                    else map_text(header, value, maps)
                )
                for header, value in row.items()
            }
            for row in rows
        ]
        with (output / name).open("w", encoding="utf-8", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=headers, lineterminator="\n")
            writer.writeheader()
            writer.writerows(sanitized)
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, help="Output directory for neutralized sample files")
    args = parser.parse_args()
    output = Path(args.out)
    if not output.is_absolute():
        output = Path.cwd() / output
    prepare(output)


if __name__ == "__main__":
    main()
