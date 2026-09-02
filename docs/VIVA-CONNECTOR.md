# Viva Insights connector — what we found

Reference for the **[3. Viva Direct](../3.%20Viva%20Direct/)** path. You don't need this to connect;
it's here for when something doesn't behave.

All verified against a live tenant in August 2026.

---

## Custom query vs Consumption Dashboard export

| | Custom query | Consumption Dashboard |
|---|---|---|
| Auto-refresh | ✅ | ❌ |
| Real UPNs under identification | ✅ | ✅ |
| Org attributes | ✅ analyst chooses | limited |
| Supported by this template | ✅ | ❌ |
| Policy names | in-query column | separate table |

**Use a custom query.** The template no longer supports the Dashboard export shape — see
[The 500 error](#the-500-error) for why.

---

## Table names that answer

The connector exposes more than one table, and the names are not guessable.

| `TableName` | Returns |
|---|---|
| *(omitted)* | The metrics — UPN, EntraId, service, policy, date, credits, `PeopleHistoricalId` |
| **`PeopleHistorical`** | Org attributes — `PeopleHistoricalId`, `IsCopilotLicensed`, `Domain`, `Organization`, `PopulationType`, time zones |
| **`HR`** | Same table, same columns |
| `PeopleMetaData` | ❌ **fails** — despite being the name the CSV export uses |
| `Data_PeopleMetaData`, `Data_People`, `OrganizationalData` | ❌ |

The model tries `PeopleHistorical`, then `HR`, then `PeopleMetaData`, and falls back to the Entra
file if none answer.

**The join key is `PeopleHistoricalId`**, which the metrics rows also carry.

---

## The 500 error

A Consumption Dashboard export is **multi-table**. Omit `TableName` and the connector returns a bare
`(500) Internal Server Error` — it does not say a table name is needed.

The export name has to travel with the request, and it is one of these:

| Export | Name |
|---|---|
| Identified | `IdentifiableAiConsumptionWeeklyExport` |
| De-identified | `AiConsumptionWeeklyExport` |

The template used to expose this as a `VivaExportName` parameter. That has been **removed**: the
Consumption Dashboard dialog never displays the export name, so the only way to answer the prompt was
to download Microsoft's own template and read a table name out of Power Query. A parameter a user
cannot answer from the UI they are looking at is a trap, not an option.

Nor can the right value be detected: `VivaInsights.Data` returns a *lazy* table, so probing it
reports success whether or not the table can actually be read.

**A custom query returns a single table, so none of this applies.**

---

## Org attribute precedence

All three paths follow the same order:

| | Source | Keyed by |
|---|---|---|
| 1 | Org columns on the metrics rows | UPN |
| 2 | Viva's people table | `PeopleHistoricalId` → UPN |
| 3 | An Entra directory export | UPN |

Viva wins when present. A column that exists but is blank for everyone counts as absent — otherwise
it offers a Group By entry that yields one empty bucket.

`IsCopilotLicensed` and the time zone columns are dropped as non-organisational.

---

## Org filtering coverage

Once org data is present, the **Group By** slicer filters Cowork, Copilot Studio and GitHub Copilot
together. Verified by simulating a slicer selection and checking each table responds.

Studio's **per-agent** and **tenant** pages don't filter by org — they carry no person column, so
there's nothing to join on. That's inherent to those exports.

Azure AI Foundry is the same: Cost Management is resource-grained. Where a resource carries a
department tag it can be attributed; otherwise the Foundry page says what share cannot be.
