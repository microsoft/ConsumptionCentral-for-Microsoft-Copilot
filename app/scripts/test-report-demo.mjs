import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";

const result = await build({
  configFile: "vite.report-demo.config.ts",
  logLevel: "warn",
  build: {
    ssr: "runtime.ts",
    write: false,
    minify: false,
  },
});
const chunk = result.output.find((o) => o.type === "chunk" && o.isEntry);
const temp = mkdtempSync(join(tmpdir(), "cc-report-test-"));
const modulePath = join(temp, "runtime.mjs");
let runtime;
try {
  writeFileSync(modulePath, chunk.code);
  runtime = await import(pathToFileURL(modulePath).href);
} finally {
  unlinkSync(modulePath);
  rmdirSync(temp);
}
const { fixture: ds, defaultSelection, measureValue: value, queryVisual, verifyBindings } = runtime;
const schema = JSON.parse(readFileSync("../demo/consumption-central-report/report-schema.json", "utf8"));
const defaults = defaultSelection();
let checks = 0;
const near = (a, b, label) => {
  assert.equal(typeof a, "number", label);
  assert.ok(Math.abs(a - b) < 1e-8 * Math.max(1, Math.abs(b)), `${label}: ${a} != ${b}`);
  checks++;
};
const total = (rows, field) => rows.reduce((n, r) => n + field(r), 0);

verifyBindings(schema.pages);
checks++;
assert.equal(schema.pages.length, 24);
assert.ok(schema.pages[0].visuals.some((v) => v.paragraphs.some((p) => p.textRuns.some((r) => r.value.includes("Check these three first")))));
for (const page of schema.pages) {
  for (const visual of page.visuals) {
    if (visual.type === "textbox") assert.ok(visual.paragraphs.length, `Missing source text: ${page.id}/${visual.id}`);
    for (const projection of Object.values(visual.roles).flat()) {
      if (projection.kind === "Measure") assert.ok(schema.measures[projection.ref]?.dax, `No source DAX: ${projection.ref}`);
    }
  }
}
checks++;
const current = ds.credits.filter((r) => r.date >= "2026-07-05");
near(value("CoworkBilling.Cowork Total Credits Used"), total(current, (r) => r.credits), "Cowork last four weeks");
const all = { ...defaults, "Cowork Period.Period": "13" };
near(value("CoworkBilling.Cowork Total Credits Used", all), total(ds.credits, (r) => r.credits), "Cowork all history");
assert.notEqual(value("CoworkBilling.Cowork Total Credits Used", all), value("CoworkBilling.Cowork Total Credits Used"));
const service = { ...all, "CreditsWeekly.ServiceName": "Work IQ" };
near(value("CoworkBilling.Cowork Total Credits Used", service), total(ds.credits.filter((r) => r.service === "Work IQ"), (r) => r.credits), "Service filter");
const policy = { ...all, "SpendingPolicy.Policy Name": "Policy 1" };
near(value("CoworkBilling.Cowork Total Credits Used", policy), total(ds.credits.filter((r) => ds.people.slice(0, 3).some((p) => p.upn === r.upn)), (r) => r.credits), "Policy filter");
const credits = total(current, (r) => r.credits);
const pack = { ...defaults, "Capacity Pack Balance.Capacity Pack Balance": "5000" };
near(value("CoworkBilling.Cowork Prepaid Cost", pack), 5000 * .008, "Prepaid burn first");
near(value("CoworkBilling.Cowork PAYG Cost", pack), (credits - 5000) * .01, "PAYG remainder");
near(value("CoworkBilling.Avg Weekly Active Users"), 10, "Average weekly active people");
const cwPage = schema.pages.find((p) => p.id === "exec-overview");
const matrix = queryVisual(cwPage.visuals.find((v) => v.id === "shell_left_matrix"), all);
assert.deepEqual(matrix.columns.map((p) => p.ref), ["CoworkBilling.User Count", "CoworkBilling.Cowork Total Credits Used"]);
near(total(matrix.rows, (r) => r.values[1]), matrix.totals[1], "Cowork expanded matrix sums to KPI");
const weeklyCost = schema.pages.find((p) => p.id === "dept-chargeback").visuals.find((v) => v.type === "lineChart");
const burn = queryVisual(weeklyCost, pack);
near(total(burn.rows, (r) => r.values[0]), value("CoworkBilling.Cowork Prepaid Cost", pack), "Weekly prepaid series reconciles");
near(total(burn.rows, (r) => r.values[1]), value("CoworkBilling.Cowork PAYG Cost", pack), "Weekly PAYG series reconciles");

const studioAll = { ...defaults, "Studio Period.Period": "all" };
near(value("Credit Consumption (Tenant).Studio Consumed Credits (Tenant)", studioAll), total(ds.studioTenant, (r) => r.prepaid + r.payg), "Studio full dated tenant");
near(value("Credit Consumption (Tenant).Studio Consumed Credits (Tenant)"), total(ds.studioTenant.filter((r) => r.date >= "2026-07-25"), (r) => r.prepaid + r.payg), "Studio last 7 days");
near(value("Credit Consumption (User).Studio Total Credits Used", studioAll), value("Credit Consumption (User).Studio Total Credits Used"), "Studio undated user snapshot unchanged by dates");
const env = { ...studioAll, "Studio Environment.Environment Name": "Environment 1" };
near(value("Credit Consumption (Tenant).Studio Consumed Credits (Tenant)", env), total(ds.studioTenant.filter((r) => r.env === "Environment 1"), (r) => r.prepaid + r.payg), "Studio environment");
const agentFilter = { ...defaults, "Agent Bridge.Agent Name": "Agent 1" };
near(value("Credit Consumption (Agent).Studio Consumed Credits (Agent)", agentFilter), 3000, "Agent filter");
const studioPage = schema.pages.find((p) => p.id === "d0243621b324b4cb196a");
const agents = queryVisual(studioPage.visuals.find((v) => v.id === "af05167cf219dca3de7f"), defaults);
near(total(agents.rows, (r) => r.values[0]), value("Credit Consumption (User).Studio Total Credits Used"), "Agent user attribution sums");
near(total(agents.rows, (r) => r.values[1]), 1, "Agent user shares sum to 100%");

near(value("GitHub Usage.GHCP Credits Used"), total(ds.ghUsage, (r) => r.credits), "GitHub full history");
const latest = { ...defaults, "GHCP Period.Period": "1" };
near(value("GitHub Usage.GHCP Credits Used", latest), total(ds.ghUsage.filter((r) => r.date.startsWith("2026-07")), (r) => r.credits), "GitHub latest month");
const powerful = { ...latest, "GitHub Usage.Model Tier": "3. Powerful" };
near(value("GitHub Usage.GHCP Credits Used", powerful), total(ds.ghUsage.filter((r) => r.date.startsWith("2026-07") && r.tier === "3. Powerful"), (r) => r.credits), "Model tier filter");
near(value("GitHub User.GHCP Seat Cost (Monthly)"), 4 * 39 + 8 * 19, "Monthly seats are not repeated per usage row");
near(value("GitHub Usage.GHCP Seats With No Credit Use"), 2, "Dormant seats");
near(value("GitHub Usage.GHCP Gross Value"), value("GitHub Usage.GHCP Overage Cost") + value("GitHub Usage.GHCP Allowance Absorbed"), "Credit gross/net/allowance reconcile");

near(value("AzureSolutionSpend.Azure Selected Cost"), total(ds.azureSolution, (r) => r.actual), "Azure actual cost");
near(value("AzureSolutionSpend.Azure Selected Cost", { ...defaults, "Azure Cost Basis.Cost Basis": "Amortized" }), total(ds.azureSolution, (r) => r.amortized), "Amortized cost filter");
near(value("AzureSolutionSpend.Azure Selected Cost", { ...defaults, "AzureSolutionSpend.ServiceName": "Storage" }), total(ds.azureSolution.filter((r) => r.service === "Storage"), (r) => r.actual), "Azure service filter");
near(value("AzureDeploymentHealth.Azure PTU Capacity"), 150, "PTU latest snapshots not double-counted");
near(value("AzureDeploymentHealth.Azure Weighted PTU Utilisation %"), (50 * 20 + 100 * 45) / 150 / 100, "Capacity-weighted PTU fraction formatted as percent");
near(value("AzureDeploymentHealth.Azure Model Requests"), 6000, "Requests from latest snapshots");
near(value("AzureDeploymentHealth.Azure 5xx Error Rate"), .001, "Request-weighted 5xx rate");
near(value("AzureDeploymentHealth.Azure Mean Latency"), (1000 * 200 + 2000 * 300 + 3000 * 400) / 6000, "Request-weighted latency");
near(value("AzureBillingReconciliation.Recon Difference"), 600, "Reconciliation actual minus estimate");
near(value("AzureBillingReconciliation.Recon Unexplained Residual"), 120, "Reconciliation residual subtracts fictional evidence");

const taskRows = ds.tasks.filter((r) => r.date >= "2026-07-05");
near(value("Cowork Tasks.Reported Cowork Tasks"), total(taskRows, (r) => r.tasks), "Task counts");
near(value("Cowork Tasks.Cowork Credits per Task"), 2.5, "Task credits per task");
assert.equal(value("Cowork Tasks.Cowork Task Monetary Equivalent"), null, "No money estimate without selecting an hourly value");
near(value("Cowork Tasks.Cowork Task Monetary Equivalent", { ...defaults, "Cowork Task Hourly Value.Hourly Value": "50" }), value("Cowork Tasks.Cowork Expert-equivalent Hours") * 50, "Task equivalent value");
const flat = { ...defaults, "Growth Scenario.Scenario": "flat" };
near(value("CreditsWeekly.Year Credits", flat), credits * 12, "Flat Cowork forecast");
near(value("Credit Consumption (Tenant).Projected Credits (30d)", flat), value("Credit Consumption (Tenant).Daily Run Rate", flat) * 30, "Studio daily run rate projection");
const growth = { ...defaults, "Growth Scenario.Scenario": "g10" };
near(value("CreditsWeekly.Month Cost $", growth, { "Projection Month.Value": "2" }), credits * .01 * 1.1 ** 2, "Compound scenario projection");
const dates = { ...defaults, from: "2026-07-01", to: "2026-07-31" };
near(value("Settings.Reporting Cowork Credits", dates), credits, "Combined selected dates count only weekly records dated in range");
near(value("Settings.Reporting Studio Credits", dates), total(ds.studioTenant.filter((r) => r.date >= dates.from), (r) => r.prepaid + r.payg), "Combined Studio uses common dates, not product page last-seven-days");
near(value("Settings.Reporting GitHub Credits", dates), 15840, "Combined GitHub uses reporting dates");
const emptyDates = { ...dates, from: "2026-07-27" };
near(value("Settings.Reporting Cowork Credits", emptyDates), 0, "Empty common date range does not invent consumption");
assert.equal(value("Credit Consumption (Agent).Agent Action", defaults, { "Agent Bridge.Agent Name": "Agent 1" }), "4. Healthy - low volume, no action needed", "Agent action uses selected-population share, not row share");
for (const [pageId, id] of [["d0243621b324b4cb196a", "p5_users"], ["ghcp-consumption", "gc_by_group"]]) {
  const visual = schema.pages.find((p) => p.id === pageId).visuals.find((v) => v.id === id);
  const data = queryVisual(visual, defaults);
  for (let column = 0; column < data.columns.length; column++) {
    if (/Share|Credits Used|Active Developers/.test(data.columns[column].ref)) {
      near(total(data.rows, (r) => r.values[column]), data.totals[column], `${pageId} group ${data.columns[column].ref} reconciles`);
    }
  }
}

// Every data-bound visual must also resolve under all supported slicer choices.
for (const page of schema.pages) {
  for (const slicer of page.visuals.filter((v) => v.type === "slicer")) {
    const ref = slicer.roles.Values[0].ref;
    if (ref === "Reporting Date.Date") continue;
    for (const option of runtime.optionsFor(ref)) {
      const filters = { ...defaults, [ref]: option.value };
      for (const visual of page.visuals) {
        if (visual.type !== "slicer" && Object.keys(visual.roles).length) {
          const output = queryVisual(visual, filters);
          for (const raw of [...output.totals, ...output.rows.flatMap((r) => r.values)]) {
            assert.ok(raw === null || typeof raw === "string" || Number.isFinite(raw), `${page.id}/${visual.id}: nonfinite value for ${ref}`);
          }
        }
      }
      checks++;
    }
  }
}
console.log(`Report model: ${checks} numerical/binding/filter checks passed across ${schema.pages.length} source pages.`);
