# Consumption Central report demo source

This static browser port reads the current PBIR page definitions from all three report templates, verifies that their 24-page order and visual types agree, and uses the recommended Local CSV template's coordinates as the single browser layout. The three templates differ slightly in the placement of some visuals; the page canvas keeps the Local CSV geometry rather than inventing a fourth source variant.

The browser displays invented example values only. It has no sign-in, Power BI service, tenant connection, backend, CDN, or third-party runtime dependency. The report schema and the model's plain-English measure definitions are copied into local JSON assets by the build.

From the repository root, run:

```powershell
python demo/consumption-central-report-src/scripts/build.py
```

The build requires Python 3.12+ standard library and writes the site bundle to `demo/consumption-central-report/`. The published bundle is static and needs no server-side runtime. See [`../README.md`](../README.md) for source provenance, the base revision, and integration details.
