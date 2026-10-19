# Cowork task categories

**2.1. Cowork: Tasks**, immediately after Cowork Cost, shows reported task volume, category mix, weekly initiation type and credit intensity. It is independent of the existing Cowork / Work IQ consumption, cost, optimization and forecast pages. Supplying the new export does not replace legacy inputs, join anonymous people to other products, or add task credits to billing totals.

## Inputs and coexistence

| Path | Optional input |
|---|---|
| Local CSV | `CoworkWeeklyMetrics.csv` beneath `DataFolder`, with `PeopleMetaData.csv` in the same export directory |
| Viva Direct | The same optional CSV route through `DataFolder`; the existing custom Viva query is unchanged |
| Fabric | `dbo.cowork_tasks_weekly`; the Viva ingestion notebook can now ingest task-only exports |
| Power Automate + Dataverse | The corresponding optional `cowork_tasks_weekly` contract; no automatic task-export API or new flow is assumed |

For CSV paths, keep exports in separate subfolders when they contain different files named `PeopleMetaData.csv`. Do not overwrite legacy people metadata with task metadata. The file loader chooses the shallowest task export, then the most recently modified file; it does not sum multiple overlapping snapshots. Without a task file, Local CSV retains its original legacy metadata search anywhere beneath `DataFolder` (shallowest, then newest), even without a metrics file. When tasks are present, keep legacy metadata beside the selected legacy metrics file; each task export uses only its own companion.

Fabric recursively discovers task exports and their companions and upserts historical natural keys. Legacy consumption and spending-policy CSV discovery remains top-level only; retained legacy exports in `old/` or dated subfolders are not ingested. Directories starting with `_` or `.` are skipped for task discovery.

The new file has **person x week x category x initiation-type** grain:

| Export field | Meaning and handling |
|---|---|
| `PersonId` | Required person key; a populated `UserPrincipalName` is accepted as a fallback |
| `MetricDate` | Required calendar date (`yyyy-MM-dd`); the observed export uses Sunday week starts. Other weekdays remain accepted and are grouped into Sunday-start weeks |
| `Total Cowork tasks` | Required nonnegative whole count; reported activity, not successful completions |
| `Total credits used` | Optional fractional credits; missing is not zero |
| `TaskCategory` | Optional open category list; missing becomes `Not supplied` |
| `TaskType` | Optional initiation type; observed values include `Scheduled`, `UserInitiated`, `Unknown` |
| `PeopleHistoricalId` | Optional historical metadata key, not a stable person identifier |

The companion maps `PeopleHistoricalId` to `Organization`, `FunctionType` and `IsCopilotLicensed`. Historical changes remain distinct. A left join retains unmatched tasks; conflicting duplicate metadata keys fail rather than multiplying counts. Case-only organization/function variants share one relationship key and dimension row, preserving a source label for display. These attributes remain task-scoped and do not alter the shared organization dimension or cross-product cohorts.

Canonical SQL/Dataverse fields and types are documented in the [Fabric dictionary](../2.%20Fabric/docs/DATA-DICTIONARY.md#cowork_tasks_weekly). Header matching tolerates case, spaces, underscores and dashes; ambiguous aliases fail unless the exact canonical field is present.

## Reading the page

- **Reported tasks and task credits** are observations. Credits per task divides total credits by total tasks, never averages row-level ratios.
- **Estimated PAYG cost** multiplies task credits by the existing `Cowork PAYG Rate Value`, displayed beside the scenario controls. It does not allocate prepaid capacity, licences or blended product costs.
- **Task period** uses the latest Sunday-start task week, not the legacy consumption calendar. The default is the last four available weeks, or all history when shorter. All history includes the earliest week even when input dates fall on different weekdays.
- **Estimated expert-equivalent hours** are a provisional scenario applied to mapped categories. Unknown, Unclassified and other unmapped categories remain in observed totals but have blank estimates. The status strip shows valuation coverage.
- **Estimated monetary equivalent** stays blank until one numeric expert hourly value is selected. The selector is single-select; its initial `(Blank)` option means no monetary value. Return to `(Blank)` to remove the estimate; selecting zero is an explicit zero-rate scenario. Currency is USD, matching the report's dollar cost measures, with no currency conversion.

The task export contains no duration, successful-completion flag, task-level prompt, task ID, service/policy allocation or billed currency. It does not establish reconciliation with all Cowork / Work IQ credits. Do not sum these overlapping facts or interpret estimated equivalent work as realized savings, return on investment, completed outputs or measured time saved.

## Editable expert-equivalent assumptions

The initial bands align with the Cowork category bands in [ValueLens](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot). Its Cowork methodology is provisional and under revision; these are **not validated productivity benchmarks**. This report uses the exported task counts directly, not ValueLens audit threads, resource reads or chain multipliers.

Minutes per reported task:

| Category | Conservative | Typical | Optimistic |
|---|---:|---:|---:|
| Analysis & research | 30 | 67 | 92 |
| Document & content creation | 12 | 24 | 42 |
| Email workflows | 3 | 7 | 12 |
| Meeting workflows | 12 | 31 | 43 |
| Communication workflows | 2 | 4 | 11 |
| Specialized workflows | 10 | 25 | 40 |
| Write or debug code | 30 | 56 | 96 |
| General assistance / Other | 2 | 5 | 8 |

**Typical** is initially selected. In Desktop, open **Transform data**, select **Cowork Task Categories**, then **Advanced Editor**. Edit the `Assumptions` table's category rows and three minute values. Category names must be unique after trimming and case normalization, and bands must be finite, nonnegative and ordered Conservative <= Typical <= Optimistic. Add a row only when you deliberately choose a basis for a new category. No extra assumption file is required.

The hourly selector offers a blank no-value option and USD 0-1,000 in one-dollar increments, with no numeric value selected initially.
Its range can be edited in the **Cowork Task Hourly Value** query; it is a scenario input, not an
observed compensation or billing rate.

The category matrix exposes the effective minutes and estimated hours. Hours are the sum of `reported task count x selected category minutes / 60`. Monetary equivalent is those covered hours multiplied by the explicitly selected hourly value. The same band applies to either initiation type. There is no hidden realization haircut, success discount, scheduled-run multiplier or annualization.

## Empty, partial and invalid data

| Condition | Result |
|---|---|
| Task file/table absent | `Task categories not supplied`; numeric task visuals blank; existing pages unchanged |
| Zero-byte or header-only file / empty table | `Task export contains no rows`; numeric task visuals blank |
| Filters select no rows | `No tasks match these filters`; not a measured zero |
| Explicit zero tasks | Task count is zero; per-task ratios are blank at a zero denominator |
| Optional category/type absent | `Not supplied`, distinct from exported Unknown or Unclassified |
| Credits missing in selected rows | Counts remain available; credit totals, credit ratios and cost estimates are blank; coverage is disclosed |
| Unmapped category | Observed counts and credits remain; category value estimate is blank |
| Invalid core field, malformed supplied numeric/date/licence value, conflicting natural keys | Actionable task-source error; no silent coercion to zero |
| Optional task folder inaccessible | `Task folder unavailable; check DataFolder and folder access.`; task numbers blank, without blocking a connector-only Viva refresh |
| Supplied task/companion file unreadable, connector authentication or transport failure | Refresh error, not an optional-data empty state |

Identical task rows may be deduplicated. Conflicting rows at the normalized natural key must be reconciled rather than summed. Missing optional tables are detected through source navigation; connector failures and errors reading discovered files are not blanket-caught. Only optional folder enumeration degrades to an explicit status. Legacy Local CSV sources retain their existing folder-access behavior.

See [synthetic examples](../1.%20Local%20CSV/sample-data/cowork-tasks/README.md) and the [verification matrix](TESTING.md#cowork-task-verification).
