# Consumption Central browser demos

Two independent bundles are prepared for static hosting:

| Bundle | Output path | Description |
|---|---|---|
| App | `demo/consumption-central/` | Existing browser app UI with genericized synthetic sample data. |
| Power BI report | `demo/consumption-central-report/` | Source-backed browser port of the shared 24-page report, with local calculations over invented records. |

Each bundle contains an `index.html` and local assets, uses its `/demo/<slug>/` base or relative links, and works without sign-in, Power BI service, tenant access, backend, or external network requests. The site host must serve the output folders at `/demo/consumption-central/` and `/demo/consumption-central-report/`.

Both bundles include a same-origin `Back to solutions` link to `/#solutions`. The site supplies that landing page; no demo runtime fetch depends on it.

The corrected report port preserves the source page order, active field bindings, text, visual types and geometry. Charts, KPI cards and matrix totals calculate from a single deterministic fixture dataset using repository calculation modules plus explicit report-context adapters. It includes local measure definitions and extracted DAX for traceability, not arbitrary per-visual amounts. The report remains subject to the site's fidelity review before enablement; this build does not enable or publish it.

## Provenance and reproducible builds

- **Source repository:** `microsoft/ConsumptionCentral-for-Microsoft-Copilot` (`https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot.git`)
- **Base revision:** `970c0c51f3d65331e0f2086e822d4ee115a8fd42` (`main` at the start of this work; demo worktree was clean).
- **App source:** `app/`, built with the existing React/Vite project and its browser-only calculations.
- **Report sources:** `1. Local CSV/Consumption Central - Local CSV.pbit`, `2. Fabric/Consumption Central - Fabric.pbit`, `3. Viva Direct/Consumption Central - Viva Direct.pbit`, plus the generated plain-English measure reference in `docs/MEASURES.md`. All three templates have the same 24-page order and visual-type structure. The report port uses the recommended Local CSV template's layout coordinates where minor geometry differs.
- **App build:** Node.js 24.x and npm, plus Python 3.12+ standard library for safe fixture generation. The app's pinned `@microsoft/rayfin-cli` package supports Node `>=24.0.0 <25.0.0`. From the repository root, run `npm --prefix app ci` then `npm --prefix app run build:demo`.
- **Report source directory:** `demo/consumption-central-report-src/`, with shared calculation modules in `app/src/metrics/`.
- **Report build:** Node.js 24.x/npm and Python 3.12+ standard library. After `npm --prefix app ci`, run `npm --prefix app run build:report-demo`. The Python extractor alone generates metadata, not a complete deployable bundle.
- **Runtime:** Both output bundles are static browser files; no server-side runtime is needed.
- **License:** The repository is MIT-licensed. Both bundles include `LICENSE` and `THIRD-PARTY-NOTICES.txt`. The app bundles React, React DOM, Scheduler and Papa Parse; the report bundles Papa Parse through shared CSV/date helpers. These dependencies use MIT licences. Vite/TypeScript and Playwright are build/test tools, not hosted services or shipped browser-test dependencies. Product names and source logos do not imply endorsement.
- **Change boundary:** The base revision above identifies the original application/report sources, not the later demo implementation. Demo source and generated bundles are committed separately on `keithland89-consumption-central-demos`; use `git rev-parse HEAD` for the exact demo revision. The site integration belongs in its separate site session; this repository work does not publish to or modify that site.

The bundled samples contain no real customer, tenant, account, or person data. The app build rewrites free-text entities in the repository's synthetic CSV fixtures to generic names and uses a generic sample label. The report creates invented people, weekly credits, tasks, Studio snapshots, GitHub usage and Azure exports in `fixtures.ts`; fixture arithmetic is deterministic and independent of real exports.

## Verification and limits

Run `npm --prefix app run test:report-demo` for strict TypeScript checking, source-binding coverage and numerical/filter assertions. For browser verification, install Chromium once with `cd app; npx playwright install chromium`, then run `npm --prefix app run test:report-demo:browser` from the repository root after building both demos. This starts and stops its own loopback static server, checks all 24 rendered pages and concrete filtered values, rejects off-origin requests and saves screenshots plus raw-card evidence under ignored `app/test-results/report-demo/`.

This is not the Power BI engine or a claim of pixel/DAX-engine identity. SVG typography and native HTML slicers differ; matrices display the source's active hierarchy level without native drill, cross-highlighting, bookmarks, tooltips or export menus. Browser numeric tooltips and Show data tables replace native chart tooltips. Refresh-time rate parameters are fixed in the fixture settings. Studio period controls intentionally change only dated tenant quantities, not undated agent/user snapshots. Totals are recalculated in their own context, not blindly added across non-additive shares, pools or capacity-pack costs. Forecasts and task work equivalents retain source assumptions and are not measured outcomes. See the [report source notes](consumption-central-report-src/README.md) for calculation boundaries and expected examples.
