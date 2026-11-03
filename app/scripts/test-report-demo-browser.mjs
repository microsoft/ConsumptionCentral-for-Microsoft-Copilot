import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(root, "app/test-results/report-demo");
await mkdir(output, { recursive: true });
const schema = JSON.parse(await readFile(resolve(root, "demo/consumption-central-report/report-schema.json"), "utf8"));
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = resolve(root, `.${decodeURIComponent(url.pathname)}`, url.pathname.endsWith("/") ? "index.html" : "");
  const bundles = ["consumption-central", "consumption-central-report"].map((slug) => resolve(root, "demo", slug) + sep);
  if (!bundles.some((prefix) => path.startsWith(prefix))) { res.writeHead(404).end(); return; }
  try {
    const body = await readFile(path);
    res.writeHead(200, { "Content-Type": mime[extname(path)] || "text/plain" }).end(body);
  } catch (error) {
    if (error.code !== "ENOENT") console.error(error);
    res.writeHead(error.code === "ENOENT" ? 404 : 500).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
let browser;
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } });
  const errors = [], external = [], failed = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => { if (!r.url().startsWith(origin) && !r.url().startsWith("data:")) external.push(r.url()); });
  page.on("response", (r) => { if (r.status() >= 400 && !r.url().endsWith("/favicon.ico")) failed.push(`${r.status()} ${r.url()}`); });
  await page.goto(`${origin}/demo/consumption-central-report/`);
  await page.locator(".report-canvas").waitFor();
  const evidence = [];
  for (const source of schema.pages) {
    await page.locator(`[data-page="${source.id}"]`).click();
    assert.equal(await page.locator("#page-title").textContent(), source.title);
    assert.equal(await page.locator(".report-canvas > .visual").count(), source.visuals.length, `${source.id}: source visual count; browser errors: ${errors.join("; ")}`);
    assert.equal(await page.getByText("Report visual", { exact: true }).count(), 0);
    assert.equal(await page.getByText(/Values are illustrative/).count(), 0);
    const dataVisuals = source.visuals.filter((v) => !["slicer", "cardVisual"].includes(v.type) && Object.keys(v.roles).length);
    for (const visual of dataVisuals) {
      const target = page.locator(`[data-visual="${visual.id}"]`);
      if (visual.type === "pivotTable") {
        assert.ok(await target.locator("tbody tr").count(), `${source.id}/${visual.id}: empty matrix`);
        assert.deepEqual(await target.locator("thead th").allTextContents(), [...visual.roles.Rows, ...visual.roles.Values].map((p) => p.label));
      } else {
        assert.ok(await target.locator("svg [data-measure]").count(), `${source.id}/${visual.id}: missing rendered marks`);
        assert.ok(await target.locator("svg title").count(), `${source.id}/${visual.id}: missing numeric tooltips`);
      }
    }
    const cards = await page.locator(".metric").evaluateAll((nodes) => nodes.map((n) => ({ ref: n.dataset.measure, value: JSON.parse(n.dataset.value), rendered: n.textContent })));
    evidence.push({ page: source.id, visuals: source.visuals.length, chartsAndMatrices: dataVisuals.length, cards });
    await page.screenshot({ path: resolve(output, `${source.id}.png`), fullPage: true });
  }
  const metric = (ref) => page.locator(`.metric[data-measure="${ref}"]`);
  const raw = async (ref) => JSON.parse(await page.locator(`.metric[data-measure="${ref}"], .pivotTable tfoot [data-measure="${ref}"]`).first().getAttribute("data-value"));
  const choose = async (ref, value) => {
    await page.locator(`select[data-filter="${ref}"]`).selectOption(value);
  };
  await page.locator('[data-page="exec-overview"]').click();
  assert.equal(await raw("CoworkBilling.Cowork Total Credits Used"), 18040);
  await choose("Cowork Period.Period", "13");
  assert.equal(await raw("CoworkBilling.Cowork Total Credits Used"), 51304);
  await choose("CreditsWeekly.ServiceName", "Work IQ");
  assert.equal(await raw("CoworkBilling.Cowork Total Credits Used"), 12826);
  await page.getByRole("button", { name: "Reset page filters" }).click();
  assert.equal(await raw("CoworkBilling.Cowork Total Credits Used"), 18040);
  await page.locator('[data-page="dept-chargeback"]').click();
  await choose("Capacity Pack Balance.Capacity Pack Balance", "5000");
  assert.equal(JSON.parse(await page.locator('.pivotTable tfoot [data-measure="CoworkBilling.Cowork Prepaid Cost"]').getAttribute("data-value")), 40);
  assert.equal(JSON.parse(await page.locator('.pivotTable tfoot [data-measure="CoworkBilling.Cowork PAYG Cost"]').getAttribute("data-value")), 130.4);
  await page.locator('[data-page="d0243621b324b4cb196a"]').click();
  const snapshot = await raw("Credit Consumption (User).Studio Total Credits Used");
  const tenant = await raw("Credit Consumption (Tenant).Studio Consumed Credits (Tenant)");
  await choose("Studio Period.Period", "all");
  assert.equal(await raw("Credit Consumption (User).Studio Total Credits Used"), snapshot);
  assert.ok(await raw("Credit Consumption (Tenant).Studio Consumed Credits (Tenant)") > tenant);
  await page.locator('[data-page="azure-capacity-health"]').click();
  assert.equal(await metric("AzureDeploymentHealth.Azure Weighted PTU Utilisation %").textContent(), "36.7%");
  await page.locator('[data-page="azure-billing-reconciliation"]').click();
  assert.equal(await raw("AzureBillingReconciliation.Recon Difference"), 600);
  await page.locator('[data-page="ghcp-consumption"]').click();
  const ghAll = await raw("GitHub Usage.GHCP Credits Used");
  await choose("GHCP Period.Period", "1");
  assert.equal(await raw("GitHub Usage.GHCP Credits Used"), 15840);
  assert.ok(ghAll > 15840);
  await page.locator('[data-page="cowork-tasks"]').click();
  assert.equal(await page.locator('select[data-filter="Cowork Task Hourly Value.Hourly Value"]').inputValue(), "");
  assert.equal(await raw("Cowork Tasks.Cowork Task Monetary Equivalent"), null);
  await choose("Cowork Task Hourly Value.Hourly Value", "50");
  assert.ok(await raw("Cowork Tasks.Cowork Task Monetary Equivalent") > 0);
  await page.locator('[data-page="all-products"]').click();
  await page.getByLabel("Reporting from", { exact: true }).fill("2026-07-01");
  await page.getByLabel("Reporting from", { exact: true }).press("Tab");
  assert.equal(await raw("Settings.Reporting Cowork Credits"), 18040);
  await page.locator('[data-page="intro"]').click();
  await page.locator(".report-canvas .source-action").click();
  assert.equal(await page.locator("#page-title").textContent(), "How to read this");
  await page.getByRole("button", { name: "Back to previous report page" }).click();
  assert.equal(await page.locator("#page-title").textContent(), "Start here");
  assert.equal(await page.getByRole("link", { name: "Back to solutions" }).getAttribute("href"), "/#solutions");
  await page.goto(`${origin}/demo/consumption-central/`);
  await page.getByRole("link", { name: "Back to solutions" }).waitFor();
  assert.equal(await page.getByRole("link", { name: "Back to solutions" }).getAttribute("href"), "/#solutions");
  await page.screenshot({ path: resolve(output, "app.png"), fullPage: true });
  assert.deepEqual(errors, [], "Browser runtime errors");
  assert.deepEqual(external, [], "Off-origin runtime requests");
  assert.deepEqual(failed, [], "Failed runtime asset requests");
  await writeFile(resolve(output, "evidence.json"), JSON.stringify({ pages: evidence, errors, external, failed }, null, 2) + "\n");
  console.log(`Browser: ${evidence.length} source pages, rendered charts/matrices, KPI/filter assertions and both backlinks passed; no off-origin requests. Screenshots: ${output}`);
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
