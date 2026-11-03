# Consumption Central browser demos

Two independent bundles are prepared for static hosting:

| Bundle | Output path | Description |
|---|---|---|
| App | `demo/consumption-central/` | Existing browser app UI with genericized synthetic sample data. |
| Power BI report | `demo/consumption-central-report/` | Static browser port of the shared report design with invented data and interactive filters. |

Each bundle contains an `index.html` and local assets, uses its `/demo/<slug>/` base or relative links, and works without sign-in, Power BI service, tenant access, backend, or external network requests. The site host must serve the output folders at `/demo/consumption-central/` and `/demo/consumption-central-report/`.

## Provenance and reproducible builds

- **Source repository:** `microsoft/ConsumptionCentral-for-Microsoft-Copilot` (`https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot.git`)
- **Base revision:** `970c0c51f3d65331e0f2086e822d4ee115a8fd42` (`main` at the start of this work; demo worktree was clean).
- **App source:** `app/`, built with the existing React/Vite project and its browser-only calculations.
- **Report sources:** `1. Local CSV/Consumption Central - Local CSV.pbit`, `2. Fabric/Consumption Central - Fabric.pbit`, `3. Viva Direct/Consumption Central - Viva Direct.pbit`, plus the generated plain-English measure reference in `docs/MEASURES.md`. All three templates have the same 24-page order and visual-type structure. The report port uses the recommended Local CSV template's layout coordinates where minor geometry differs.
- **App build:** Node.js 24.x and npm, plus Python 3.12+ standard library for safe fixture generation. The app's pinned `@microsoft/rayfin-cli` package supports Node `>=24.0.0 <25.0.0`. From the repository root, run `npm --prefix app ci` then `npm --prefix app run build:demo`.
- **Report build:** Python 3.12+ standard library. From the repository root, run `python demo/consumption-central-report-src/scripts/build.py`.
- **Runtime:** Both output bundles are static browser files; no server-side runtime is needed.
- **License:** The repository is MIT-licensed. The app bundle includes the repository MIT license and notices for the bundled runtime dependencies; the report bundle includes the repository MIT license and has no third-party runtime dependencies.
- **Change boundary:** These source changes and generated bundles are uncommitted changes based on the stated revision. The site integration belongs in its separate site session; this repository work does not publish to or modify that site.

The bundled samples contain no real customer, tenant, account, or person data. The app build rewrites free-text entities in the repository's synthetic CSV fixtures to generic names and uses a generic sample label. The report demo uses fixed invented group, workload, and amount values.
