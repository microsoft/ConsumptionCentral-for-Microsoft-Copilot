# 4. Power Automate + Dataverse

Power Automate pulls your consumption data on a schedule, writes it to Dataverse
tables, and Power BI reads those tables. No manual exports, no Fabric capacity.

Use this path if you want a refresh that runs on its own and you already have
Power Platform. If you have Fabric, use [2. Fabric](../2.%20Fabric) instead.

> **How the Copilot Studio flows sign in**
>
> The licensing endpoint these flows read is fussy about two things at once:
> **who** is calling and **which application** is asking.
>
> - The Power Platform API publishes no application role covering licensing, so
>   a client secret gets `403` with an empty body.
> - A delegated admin token issued to your own app registration also gets `403`,
>   even with every licensing scope consented. Being an admin is not enough on
>   its own.
>
> The flows therefore call it through the **HTTP with Microsoft Entra ID**
> connection, which is a client the API already trusts and which signs each call
> as the person who owns the flow. That owner must be a Global Administrator,
> Power Platform Administrator, or Billing Administrator, and the flows stop
> working if ownership moves to anyone else.
>
> The Azure and GitHub flows are unaffected and still use the app registration.

---

## What you need

- A Power Platform environment with Dataverse
- System Administrator on that environment
- Power BI Desktop
- Python 3.9+ (for the two setup scripts)

---

## Step 1 - Create the Dataverse tables

```bash
cd "4. Power Automate + Dataverse/scripts"
python Deploy-DataverseSchema.py --environment https://your-org.crm.dynamics.com
```

That is a dry run. It prints the 11 tables and 123 columns it would create and
changes nothing.

When the plan looks right, get a token and run it for real:

```bash
python Deploy-DataverseSchema.py --environment https://your-org.crm.dynamics.com --execute
```

The script reads your token from the `DATAVERSE_TOKEN` environment variable.

Re-running is safe. It skips anything that already exists.

---

## Step 2 - Import the flows

1. Go to [make.powerautomate.com](https://make.powerautomate.com)
2. **My flows** → **Import** → **Import Package (Legacy)**
3. Upload `flows/ConsumptionCentral-Dataverse.zip`
4. Set the connections it asks for, then **Import**

Sign in as an administrator, because the Studio flows read the licensing data as
whoever owns them.

One of the connections is **HTTP with Microsoft Entra ID**. Create it with the
same value in both boxes:

| Box | Value |
|---|---|
| Base Resource URL | `https://api.powerplatform.com` |
| Microsoft Entra ID resource URI | `https://api.powerplatform.com` |

There are eight flows - a daily flow and a one-off backfill flow for each of
four feeds. They import switched off.

---

## Step 3 - Fill in the connection details

Open each **daily** flow and set these variables in the `Initialise_` actions at
the top:

| Variable | Value |
|---|---|
| `TenantId` | Your Microsoft Entra tenant ID |
| `ClientId` | App registration from [PERMISSIONS.md](PERMISSIONS.md) |
| `DataverseUrl` | `https://your-org.crm.dynamics.com` |

Leave `ContinuationToken` empty. The flows use it to page through a long day.

The client secret is not a variable. The flows read it from Key Vault under the
name `consumption-central-client-secret`.

The two Copilot Studio flows ignore `TenantId`, `ClientId` and the secret - they
authenticate as their owner instead.

---

## Step 4 - Run the first load

Run each **Backfill** flow once, by hand. They load the last 180 days.

Expect 10-30 minutes each. Let each one finish before starting the next.

Then turn on the four **daily** flows.

---

## What the flows do and do not fill

The flows cover the four feeds that have an API behind them:

| Table | Filled by |
|---|---|
| `studio_tenant_daily` | Studio Consumption flow |
| `studio_agent` | Studio Agents flow |
| `azure_ai_spend` | Azure AI Spend flow |
| `github_ai_usage` | GitHub Usage flow |

The remaining seven tables have no API, so no flow fills them. Their pages stay
blank until you load them. Two are small reference tables you fill once
(`github_user_map`, `viva_spending_policy`); the rest come from exports covered
in [docs/DATA-SOURCES.md](../docs/DATA-SOURCES.md).

To load one by hand, import its CSV straight into the matching Dataverse table
with **Data** → **Import** in [make.powerapps.com](https://make.powerapps.com).
The sample files in [1. Local CSV/sample-data](../1.%20Local%20CSV/sample-data)
show the expected columns.

If you want every page populated without that work, use
[2. Fabric](../2.%20Fabric) or [1. Local CSV](../1.%20Local%20CSV) instead.

---

## Step 5 - Open the report

1. Open `Consumption Central - Power Automate + Dataverse.pbit`
2. Fill in the three prompts:

| Prompt | Value | Where to find it |
|---|---|---|
| `DataverseServer` | `your-org.crm.dynamics.com,5558` | Your environment URL, without `https://`, with `,5558` on the end |
| `DataverseDatabase` | `your-org` | The first part of your environment URL |
| `DataversePrefix` | `cc_` | Leave as-is unless you changed the publisher prefix |

3. Click **Load**

Then **Publish** to your Power BI workspace and set a scheduled refresh.

---

## If something looks wrong

**A page is blank.** Most likely that table has no flow behind it - check the
table above. If it is one of the four the flows fill, the load has not run yet,
or the query errored: in Power BI Desktop go to **Transform data** and look for
a red error on that query.

**"We couldn't authenticate with the credentials provided."** The TDS endpoint
is off. Turn it on in the Power Platform admin centre under **Settings** →
**Features** → **TDS endpoint**.

**Numbers are lower than expected.** Check the daily flow ran. Each table has a
`Loaded On` column showing when the flow last wrote to it.

**Credits look doubled.** A flow was imported twice. Check **My flows** for
duplicates and turn one off.

---

## Notes

- The report is generated from the Fabric template by
  `scripts/Build-Dataverse-Template.py`, which rewrites only the data source.
  Every measure, page and visual is identical to the Fabric path.
- `dataverse-schema.json` is generated by `scripts/generate_dataverse_schema.py`
  from the template itself, so the column names cannot drift apart from what the
  report expects. Do not edit it by hand.
- Copilot Studio per-user data has no API. If you want the per-user page, export
  `StudioPerUser.csv` from PPAC and load it as described in
  [docs/DATA-SOURCES.md](../docs/DATA-SOURCES.md).

For what each table means and where it comes from, see
[docs/DATA-SOURCES.md](../docs/DATA-SOURCES.md).
