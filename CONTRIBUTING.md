# Contributing

Thank you for your interest in Consumption Central.

## Contributor License Agreement

Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you
have the right to, and actually do, grant us the rights to use your contribution. For details, visit
<https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a
CLA and decorate the PR appropriately. Follow the instructions provided by the bot; you only need to
do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/)
or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions.

---

## What's most useful

**Corrections to the click-paths.** Several of the exports Consumption Central reads are in preview and their
portals move. If a path in [docs/DATA-SOURCES.md](docs/DATA-SOURCES.md) no longer matches what you
see, that is a genuinely valuable issue — please include what you saw instead.

**Answers to the open questions.** Three things are marked unverified in the docs, and a definitive
answer to any of them would improve the template for everyone:

1. Does the **Viva Insights Power BI connector** expose Consumption Dashboard credit data, or only
   Analyst Workbench queries? See [3. Viva Direct](3.%20Viva%20Direct/).
2. What is the exact **VFAM control** that enables identifiable export?
3. Where exactly do the **Copilot Studio CSVs** download from in PPAC?

**New export shapes.** If your export has columns ours does not, open an issue with the header row
(no data rows, please). The loaders alias-match on purpose so new shapes can usually be absorbed
without breaking anyone.

---

## Working on the model

The report is a **PBIP project** — TMDL for the model, JSON for the report — so changes are
reviewable in a diff.

Two rules, both learned the hard way:

**Edit with Power BI Desktop closed.** Desktop holds an in-memory copy and writes it back over your
changes on save. Close it, edit, validate, then open.

**Save the model in Desktop before closing it.** Model edits made through an external tool only
reach the TMDL files when Desktop saves. Force-closing discards them.

### Before opening a PR

If you have changed model or report files, please confirm:

- [ ] The project opens in Power BI Desktop without error
- [ ] A full refresh completes against the sample data
- [ ] Every page renders — a visual can silently vanish without any file being invalid
- [ ] No new hardcoded numbers, dates, or interpretations in any card, title or measure

That last point matters more than it sounds. Consumption Central is a **template**: every customer's data is
different, so a headline that says "usage grew 19.8% over the last 13 weeks" is a lie for the next
reader unless both numbers are computed. If you add narrative, derive it.

### Testing against both export shapes

The Viva consumption export comes in two shapes and both must keep working. If you touch anything in
the loading path, test with:

- the **de-identified** sample under `1. Local CSV/sample-data/`
- an **identified** export, or a hand-made file with `UserPrincipalName` and `EntraId` instead of
  `PersonId` and `PeopleHistoricalId`, and *without* the two person-map files

A useful check: on a small file, count the rows. A join that fans out doubles your credits, and on a
large file doubled credits look entirely plausible.

---

## Installer asset manifest

[`installer-assets.json`](installer-assets.json) is the one list of what the Consumption Central
installer deploys: the three templates, the Fabric notebooks and the [app](app/). The installer and
its exe build read every path from it rather than hard-coding them, so **if you add, rename or move a
template or notebook, update the manifest in the same change.**
[`test_installer_assets.py`](docs/scripts/test_installer_assets.py) runs in CI and fails until you do.

**`templates`**: one entry per shipped `.pbit` (`fabric`, `vivaDirect`, `localCsv`). Archived templates
under `archive/` are not shipped and have no entry.

| Field | Meaning |
|---|---|
| `path` | The template, relative to the repo root |
| `parameters` | The parameters the installer may set. Each must exist in the template; the template can have more. |

**`notebooks`**: every `.ipynb` in `2. Fabric/notebooks`, in the order a pipeline should run them.

| Field | Meaning |
|---|---|
| `key` | The id the installer uses. `azureAi`, `studioConsumption` and `vivaConsumption` match the Analytics Hub installer's catalog. |
| `name` | The notebook's name in Fabric: its file name without `.ipynb` |
| `path` | The file, relative to the repo root |
| `credentials` | `true` if the installer sets `TENANT_ID`, `CLIENT_ID` and `CLIENT_SECRET` from an app registration |
| `values` | Settings the installer writes as Python strings: `NAME = '...'` |
| `expressions` | Settings the installer writes as raw Python, such as a number, `None` or a `getSecret(...)` call |
| `patches` | Exact text the installer replaces. Each occurs exactly once in the notebook. |
| `secret` | `null`, or `{kind, name}`: `kind` is `clientSecret` or `githubPat`, and `name` is the Key Vault secret name the notebook expects (`null` where the installer chooses it) |
| `reads` | Lakehouse tables the notebook reads if they exist, written by another notebook or a Dataflow |
| `writes` | The Delta tables it writes |
| `landing` | The `Files/landing/...` folder it reads uploaded exports from, or `null` |
| `loadSummary` | A JSON file the notebook writes describing what it loaded, or `null` |
| `run` | `pipeline` (safe unattended), `once` (a one-off, such as reading commercial terms) or `interactive` (needs a person signed in) |
| `exclusiveGroup` | Notebooks in the same group write the same tables from different sources; deploy one of them. `null` otherwise. |

Unlike the Analytics Hub catalog, `values` and `expressions` list names only: the installer supplies
the values. Each of those names, and each credential, appears exactly once as a top-level
`NAME = ...` line, which is what the Analytics Hub installer's `installer/src/transform/notebook.js`
edits. A pipeline run passes no parameters, so the shipped defaults must be safe as they stand:
`READ_API_FILES = False`, `PAYG_SUBSCRIPTION_IDS = []`, `ALLOW_EMPTY_LANDING = True` and so on.
The test pins those, and checks that every table the Fabric template reads is written by a listed
notebook with the columns the template needs.
