# Consumption Central report demo source

This static browser port reads the current PBIR page definitions from all three report templates, verifies that their 24-page order and visual types agree, and uses the recommended Local CSV template's coordinates as the single browser layout. The three templates differ slightly in the placement of some visuals; the page canvas keeps the Local CSV geometry rather than inventing a fourth source variant.

The browser calculates from invented typed records in `fixtures.ts`, using the application's calculation modules and explicit source-measure/context adapters in `runtime.ts`. It has no sign-in, Power BI service, tenant connection, backend or CDN. The report schema includes exact active role projections, measure DAX/format strings, source text and embedded PNG logos; plain-English measure definitions are a second local JSON asset. Unknown bindings fail explicitly rather than producing placeholder values.

From the repository root, run:

```powershell
npm --prefix app ci
npm --prefix app run build:report-demo
npm --prefix app run test:report-demo
```

The build requires Node.js 24.x and Python 3.12+ standard library. Python extracts and checks the templates; Vite bundles the local evaluator, renderer and Papa Parse. The result is `demo/consumption-central-report/index.html`, local hashed JS/CSS assets, schema/definition JSON, MIT `LICENSE` and dependency notices. Old generated assets are removed before rebuilding. See [`../README.md`](../README.md) for the exact upstream base revision and integration contract.

## Numerical and rendered evidence

`npm --prefix app run test:report-demo` checks every source-bound measure/slicer, source DAX provenance, all slicer choices, hand-computed totals and context-sensitive results. `npm --prefix app run test:report-demo:browser` starts its own temporary server and Chromium, checks all 24 rendered pages, card/matrix/chart structure and concrete filter interactions, rejects off-origin requests and captures screenshots plus `evidence.json` under `app/test-results/report-demo/`. Install the test browser first with `cd app; npx playwright install chromium`.

Examples independently asserted in the browser:

| Selection | Expected result |
|---|---|
| Cowork, last 4 weeks, all services | 18,040 credits; 12 users; 10 consuming users; 10 average weekly active users |
| Cowork, all 13 weeks | 51,304 credits |
| Cowork, all history, Work IQ only | 12,826 credits |
| Cowork cost, last 4 weeks, 5,000-credit pack | $40 prepaid + $130.40 PAYG |
| Azure health, latest snapshots | 150 PTUs; 36.7% weighted utilization; 6,000 requests |
| Billing reconciliation, full pool | 600 difference, 120 unexplained residual |
| GitHub, latest month | 15,840 credits |

Studio tenant dates and undated user/agent details deliberately do not reconcile to one period total; this is a source limitation, visibly retained. A date change must change the tenant series while leaving the snapshot unchanged. Per-agent shares/actions use the selected-population denominator rather than treating every row as 100%. Health utilization is converted from input percent to the DAX measure's fraction before percentage formatting.

## Faithfulness boundary

This is a source-backed approximation of the report, not a Power BI renderer or DAX interpreter. Every active visual binding has an explicit local implementation, but shared application helpers and adapter tests are not proof of arbitrary DAX engine parity. Active source matrix levels are shown as ordinary tables; native drill, bookmarks, cross-highlighting and service/export menus are absent. Source page-navigation/help and Back actions are supported. Charts use SVG marks, numeric tooltips and Show data tables; typography and HTML slicers are approximate. Source refresh-time rate parameters remain fixed in `SETTINGS`; pack/growth/task assumptions are interactive. Optimization seat attributes are invented latest-period snapshot attributes, as distinct from period-filtered credit totals. Forecasts and task expert-work equivalents remain estimates. No administrative action is exposed.

The page text is copied from the original report, including instructions about real exports and source parameters. Those describe the original product; the surrounding synthetic-data badge and limitations apply to this demo. Site review must accept these boundaries before enabling its report link.
