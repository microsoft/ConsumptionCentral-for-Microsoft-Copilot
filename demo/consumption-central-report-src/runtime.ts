import type { Dataset } from "../../app/src/data/types";
import type { Filters } from "../../app/src/data/store";
import { addDays } from "../../app/src/data/csv";
import { coworkModel, forecastModel, ratesInUse, billingBasis, actionValue, weeklyCost, SAVING_NOTE } from "../../app/src/metrics/cowork";
import { studioModel, AGENT_ACTIONS } from "../../app/src/metrics/studio";
import { ghModel } from "../../app/src/metrics/ghcp";
import { spendModel, healthModel, reconModel } from "../../app/src/metrics/azure";
import { tasksModel, TASK_SCENARIOS } from "../../app/src/metrics/tasks";
import { combinedModel, REPORTING_CAVEAT } from "../../app/src/metrics/combined";
import { groupOf } from "../../app/src/metrics/common";
import { GROWTH_SCENARIOS, div } from "../../app/src/metrics/stats";
import { createFixture, SETTINGS } from "./fixtures";

export type Scalar = string | number | null;
export interface Projection { ref: string; label: string; kind: string }
export interface Visual {
  id: string;
  type: string;
  label: string;
  roles: Record<string, Projection[]>;
  sort?: {
    sort?: {
      field: Partial<Record<"Measure" | "Column", { Expression: { SourceRef: { Entity: string } }; Property: string }>>;
      direction: string;
    }[];
  };
}
export type Selection = Record<string, string>;
type Coordinates = Record<string, string>;
export const fixture = createFixture();

const controls: Record<string, string> = {
  "Group By.Attribute": "group", "Group By.Group": "groupValue",
  "CreditsWeekly.ServiceName": "service", "SpendingPolicy.Policy Name": "policy",
  "CoworkBilling.UsageCohort Label": "cohort", "Cowork Period.Period": "period",
  "Capacity Pack Balance.Capacity Pack Balance": "pack",
  "Growth Scenario.Scenario": "growth",
  "Studio Period.Period": "studioPeriod", "Agent Bridge.Agent Name": "agent",
  "Studio Environment.Environment Name": "env", "Credit Consumption (Agent).Product": "product",
  "Agent Action Group.Action": "agentAction", "GHCP Period.Period": "ghPeriod",
  "GitHub Usage.Cost_Centre": "costCenter", "GitHub Usage.Model Tier": "tier",
  "GitHub Usage.Usage Type": "usageType", "GitHub Usage.Model": "model",
  "AzureSolutionSpend.SubscriptionName": "subscription", "AzureSolutionSpend.Application": "application",
  "AzureSolutionSpend.ServiceName": "azService", "AzureSolutionSpend.Currency": "currency",
  "Azure Cost Basis.Cost Basis": "basis",
  "AzureDeploymentHealth.SubscriptionName": "hSubscription", "AzureDeploymentHealth.Application": "hApplication",
  "AzureDeploymentHealth.SkuName": "sku",
  "AzureBillingReconciliation.Period": "reconPeriod", "AzureBillingReconciliation.Currency": "reconCurrency",
  "AzureBillingReconciliation.PoolName": "pool",
  "Cowork Task Period.Period": "taskPeriod", "Cowork Task Categories.TaskCategory": "category",
  "Cowork Tasks.TaskType": "taskType", "Cowork Task People.Organization": "org",
  "Cowork Task Scenario.Scenario": "scenario", "Cowork Task Hourly Value.Hourly Value": "hourly",
};

const unique = (values: string[]) => [...new Set(values)].filter(Boolean).sort();
export function optionsFor(ref: string): { value: string; label: string }[] {
  const raw: Record<string, string[]> = {
    "Group By.Attribute": fixture.groupAttrs,
    "CreditsWeekly.ServiceName": unique(fixture.credits.map((r) => r.service)),
    "SpendingPolicy.Policy Name": fixture.policies.map((p) => p.name),
    "CoworkBilling.UsageCohort Label": unique(fixture.people.map((p) => p.cohort)),
    "Studio Environment.Environment Name": unique(fixture.studioAgents.map((p) => p.env)),
    "Agent Bridge.Agent Name": unique(fixture.studioAgents.map((p) => p.agent)),
    "Credit Consumption (Agent).Product": unique(fixture.studioAgents.map((p) => p.product)),
    "Agent Action Group.Action": AGENT_ACTIONS,
    "GitHub Usage.Cost_Centre": unique(fixture.ghUsage.map((p) => p.costCenter)),
    "GitHub Usage.Model Tier": unique(fixture.ghUsage.map((p) => p.tier)),
    "GitHub Usage.Usage Type": unique(fixture.ghUsage.map((p) => p.usageType)),
    "GitHub Usage.Model": unique(fixture.ghUsage.map((p) => p.model)),
    "AzureSolutionSpend.SubscriptionName": unique(fixture.azureSolution.map((p) => p.subscription)),
    "AzureSolutionSpend.Application": unique(fixture.azureSolution.map((p) => p.application)),
    "AzureSolutionSpend.ServiceName": unique(fixture.azureSolution.map((p) => p.service)),
    "AzureSolutionSpend.Currency": ["USD"], "Azure Cost Basis.Cost Basis": ["Actual", "Amortized"],
    "AzureDeploymentHealth.SubscriptionName": unique(fixture.azureHealth.map((p) => p.subscription)),
    "AzureDeploymentHealth.Application": unique(fixture.azureHealth.map((p) => p.application)),
    "AzureDeploymentHealth.SkuName": unique(fixture.azureHealth.map((p) => p.sku)),
    "AzureBillingReconciliation.Period": unique(fixture.recon.map((p) => p.period)),
    "AzureBillingReconciliation.Currency": ["USD"],
    "AzureBillingReconciliation.PoolName": unique(fixture.recon.map((p) => p.pool)),
    "Cowork Task Categories.TaskCategory": unique(fixture.tasks.map((p) => p.category)),
    "Cowork Tasks.TaskType": unique(fixture.tasks.map((p) => p.type)),
    "Cowork Task People.Organization": unique(fixture.tasks.map((p) => p.org)),
    "Cowork Task Scenario.Scenario": [...TASK_SCENARIOS],
  };
  if (ref === "Cowork Period.Period" || ref === "Cowork Task Period.Period") {
    return [{ value: "4", label: "Last 4 weeks" }, { value: "8", label: "Last 8 weeks" }, { value: "13", label: "All history (13 weeks)" }];
  }
  if (ref === "Studio Period.Period") return [{ value: "7", label: "Last 7 days" }, { value: "all", label: "All available days" }];
  if (ref === "GHCP Period.Period") return [{ value: "1", label: "Latest month" }, { value: "2", label: "Last 2 months" }, { value: "0", label: "All history (3 months)" }];
  if (ref === "Growth Scenario.Scenario") return GROWTH_SCENARIOS.map((s) => ({ value: s.id, label: s.label }));
  if (ref === "Capacity Pack Balance.Capacity Pack Balance") return [0, 1000, 5000, 10000, 25000].map((n) => ({ value: String(n), label: n.toLocaleString("en-US") }));
  if (ref === "Cowork Task Hourly Value.Hourly Value") return [{ value: "", label: "Select USD/hour" }, ...[25, 50, 100, 150].map((n) => ({ value: String(n), label: `$${n}/hour` }))];
  if (!raw[ref]) throw new Error(`No source-backed options for ${ref}`);
  const choices = raw[ref].map((value) => ({ value, label: value }));
  if (!["Group By.Attribute", "Azure Cost Basis.Cost Basis", "Cowork Task Scenario.Scenario"].includes(ref)) choices.unshift({ value: "", label: "All" });
  return choices;
}

export function defaultSelection(): Selection {
  return {
    "Group By.Attribute": "Department", "Cowork Period.Period": "4",
    "Studio Period.Period": "7", "GHCP Period.Period": "0", "Cowork Task Period.Period": "4",
    "Growth Scenario.Scenario": "fitted", "Cowork Task Scenario.Scenario": "Typical",
    "Capacity Pack Balance.Capacity Pack Balance": "0", "Azure Cost Basis.Cost Basis": "Actual",
  };
}

class Context {
  readonly ds: Dataset;
  readonly f: Filters;
  readonly s: typeof SETTINGS;
  readonly selections: Selection;
  readonly coordinates: Coordinates;
  constructor(selections: Selection, coordinates: Coordinates = {}) {
    this.selections = selections;
    this.coordinates = coordinates;
    this.ds = { ...fixture };
    const f: Filters = { from: fixture.minDate, to: fixture.maxDate };
    for (const [ref, value] of Object.entries({ ...selections, ...coordinates })) if (controls[ref]) f[controls[ref]] = value;
    this.f = f;
    this.s = { ...SETTINGS, pack: Number(f.pack || 0) };
    for (const [ref, value] of Object.entries(coordinates)) this.slice(ref, value);
    if (selections.from) f.from = selections.from;
    if (selections.to) f.to = selections.to;
  }
  private slice(ref: string, value: string) {
    const ds = this.ds;
    if (ref === "Org.DisplayName" || ref === "CoworkBilling.DisplayName") {
      ds.people = ds.people.filter((p) => p.name === value);
    } else if (ref === "CoworkBilling.Seat Action") ds.people = ds.people.filter((p) => p.action === value);
    else if (ref === "CreditsWeekly.Week Label") ds.credits = ds.credits.filter((p) => p.date === value);
    else if (ref === "Credit Consumption (Tenant).Usage_Date") ds.studioTenant = ds.studioTenant.filter((p) => p.date === value);
    else if (ref === "Credit Consumption (Agent).LLM_Model") ds.studioAgents = ds.studioAgents.filter((p) => p.model === value);
    else if (ref === "Credit Consumption (Agent).Billable_Feature") ds.studioAgents = ds.studioAgents.filter((p) => p.feature === value);
    else if (ref === "Credit Consumption (User).User Name") ds.studioUsers = ds.studioUsers.filter((p) => p.name === value);
    else if (ref === "GitHub User.Developer") {
      const users = ds.ghUsers.filter((p) => p.name === value);
      ds.ghUsers = users;
      ds.ghUsage = ds.ghUsage.filter((p) => users.some((u) => u.username === p.username));
    } else if (ref === "GitHub User.Plan") {
      const users = ds.ghUsers.filter((p) => p.plan === value);
      ds.ghUsers = users;
      ds.ghUsage = ds.ghUsage.filter((p) => users.some((u) => u.username === p.username));
    } else if (ref === "GitHub Usage.Usage_Date") ds.ghUsage = ds.ghUsage.filter((p) => p.date === value);
    else if (ref.startsWith("AzureSolutionSpend.") && !controls[ref]) {
      const keys: Record<string, "date" | "resource" | "department"> = { UsageDate: "date", ResourceName: "resource", DepartmentTag: "department" };
      const key = keys[ref.split(".")[1]];
      if (key) ds.azureSolution = ds.azureSolution.filter((p) => p[key] === value);
    } else if (ref.startsWith("AzureDeploymentHealth.") && !controls[ref]) {
      const keys: Record<string, "identity" | "model" | "region"> = { "Deployment Identity": "identity", ModelName: "model", Region: "region" };
      const key = keys[ref.split(".")[1]];
      if (key) ds.azureHealth = ds.azureHealth.filter((p) => p[key] === value);
    } else if (ref.startsWith("AzureBillingReconciliation.") && !controls[ref]) {
      const keys: Record<string, "representation" | "product" | "status" | "evidenceType"> = { Representation: "representation", Product: "product", Status: "status", EvidenceType: "evidenceType" };
      const key = keys[ref.split(".")[1]];
      if (key) ds.recon = ds.recon.filter((p) => p[key] === value);
    } else if (ref === "Cowork Task Date.Week Start") ds.tasks = ds.tasks.filter((p) => p.date === value);
  }
  get cw() { return this.cached("cw", () => coworkModel(this.ds, this.f, this.s)); }
  get cf() { return this.cached("cf", () => forecastModel(this.ds, this.f, this.cw)); }
  get st() { return this.cached("st", () => studioModel(this.ds, this.f, this.s)); }
  get gh() { return this.cached("gh", () => ghModel(this.ds, this.f, this.s)); }
  get az() { return this.cached("az", () => spendModel(this.ds, this.f)); }
  get health() { return this.cached("health", () => healthModel(this.ds, this.f)); }
  get recon() { return this.cached("recon", () => reconModel(this.ds, this.f)); }
  get task() { return this.cached("task", () => tasksModel(this.ds, this.f, this.s)); }
  get combined() { return this.cached("combined", () => combinedModel(this.ds, this.f, this.s)); }
  private values = new Map<string, unknown>();
  private cached<T>(key: string, make: () => T): T {
    if (!this.values.has(key)) this.values.set(key, make());
    return this.values.get(key) as T;
  }
}

type Resolver = (c: Context, total: Context) => Scalar;
const measures: Record<string, Resolver> = {};
function register(table: string, definitions: Record<string, Resolver>) {
  for (const [name, resolve] of Object.entries(definitions)) measures[`${table}.${name}`] = resolve;
}
const sum = <T>(rows: T[], field: (row: T) => number) => rows.reduce((n, r) => n + field(r), 0);
const month = (c: Context) => Number(c.coordinates["Projection Month.Value"] || 1) - 1;

register("CoworkBilling", {
  "Cowork Total Credits Used": (c) => c.cw.used, "Person Allowance": (c) => c.cw.allowance,
  "Person Allowance Used %": (c) => c.cw.allowanceUsed, "Consuming Users": (c) => c.cw.consuming,
  "Avg Weekly Active Users": (c) => {
    const dates = unique(fixture.credits.map((r) => r.date)).slice(-Number(c.f.period || 4));
    return div(sum(dates, (date) => new Set(c.cw.credits.filter((r) => r.date === date).map((r) => r.upn)).size), dates.length);
  },
  "% Users Over Limit": (c) => c.cw.overPct, "User Count": (c) => c.cw.users,
  "Cowork Total Cost": (c) => c.cw.cost.total, "Cowork Prepaid Cost": (c) => c.cw.cost.prepaidCost,
  "Cowork PAYG Cost": (c) => c.cw.cost.paygCost, "Blended Rate $": (c) => c.cw.cost.blended,
  "Policy Allowance": (c) => c.cw.policyAllowance, "Policy Allowance Used %": (c) => c.cw.policyUsed,
  "Policy Headroom": (c) => c.cw.headroom, "Billing Basis": (c) => billingBasis(c.cw.used, c.s),
  "Unused Seats $": (c) => sum(c.cw.people.filter((p) => ["1", "2"].includes(p.action[0])), (p) => actionValue(p, c.s)),
  "Oversized Seats $": (c) => sum(c.cw.people.filter((p) => p.action[0] === "3"), (p) => actionValue(p, c.s)),
  "Upgrade Seats $": (c) => sum(c.cw.people.filter((p) => p.action[0] === "6"), (p) => actionValue(p, c.s)),
  "Right-Size Net $": (c) => sum(c.cw.people, (p) => actionValue(p, c.s)),
  "Seat Saving Basis Note": () => SAVING_NOTE,
});
register("CreditsWeekly", {
  "Weekly Credits": (c) => sum(c.cw.credits, (r) => r.credits),
  "Weekly Active Users": (c) => new Set(c.cw.credits.map((r) => r.upn)).size,
  "Weekly Credits WoW %": (c, total) => {
    const date = c.coordinates["CreditsWeekly.Week Label"];
    const now = sum(c.cw.credits, (r) => r.credits);
    const prev = sum(total.cw.credits.filter((r) => r.date === addDays(date, -7)), (r) => r.credits);
    return div(now - prev, prev);
  },
  "Cowork Weekly Prepaid Cost": (c, total) => weeklyCost(fixture, total.f, total.cw.credits, c.s).find((p) => p.date === c.coordinates["CreditsWeekly.Week Label"])?.prepaidCost ?? 0,
  "Cowork Weekly PAYG Cost": (c, total) => weeklyCost(fixture, total.f, total.cw.credits, c.s).find((p) => p.date === c.coordinates["CreditsWeekly.Week Label"])?.paygCost ?? 0,
  "Growth Applied %": (c) => c.cf.growth, "Year Credits": (c) => c.cf.yearCredits,
  "Year Cost $": (c) => c.cf.yearCost, "Month Cost $": (c) => c.cf.months[month(c)]?.cost ?? null,
  "Cowork Forecast Summary": (c) => c.cf.summary,
});
register("Credit Consumption (Tenant)", {
  "Studio Consumed Credits (Tenant)": (c) => c.st.tenant.consumed,
  "Studio Prepaid Consumed": (c) => c.st.tenant.prepaid, "Studio PAYG Consumed": (c) => c.st.tenant.payg,
  "Studio Prepaid Cost": (c) => c.st.tenant.prepaidCost, "Studio PAYG Cost": (c) => c.st.tenant.paygCost,
  "Total Billable Cost": (c) => c.st.tenant.cost, "Studio PAYG Share %": (c) => c.st.tenant.paygShare,
  "Billing Period": (c) => c.st.billingPeriod,
  "Consumption Without Entitlement": (c) => c.st.consumptionWithoutEnt,
  "Environments Without Entitlement": (c) => c.st.envsWithoutEnt,
  "Studio Headline": (c) => c.st.headline, "Daily Run Rate": (c) => c.st.forecast.runRate,
  "Projected Credits (30d)": (c) => c.st.forecast.proj30, "Projected Cost (30d)": (c) => c.st.forecast.cost30,
  "Studio Month Credits": (c) => c.st.forecast.months[month(c)]?.credits ?? null,
  "Studio Month Cost": (c) => c.st.forecast.months[month(c)]?.cost ?? null,
  "Studio Forecast Note": (c) => c.st.forecast.note, "Studio Forecast Summary": (c) => c.st.forecast.summary,
});
register("Credit Consumption (Agent)", {
  "Studio Consumed Credits (Agent)": (c) => c.st.agentTotal,
  "Billable Credit Cost (Agent)": (c) => c.st.agentBilled * c.s.studioPayg,
  "Billing Agents with Credits": (c) => c.st.agentsWithCredits,
  "Agent Action": (c, total) => total.st.agents.find((p) => p.agent === c.f.agent)?.action ?? null,
  "Entitlement Absorbed %": (c) => div(c.st.agentTotal - c.st.agentBilled, c.st.agentTotal),
  "Billed Credit Ratio": (c) => div(c.st.agentBilled, c.st.agentTotal),
  "Agents with No Consumption": (c) => c.st.agentsNoConsumption,
  "Agent Credit Share %": (c, total) => div(c.st.agentTotal, total.st.agentTotal),
  "Projected Cost by Agent (30d)": (c, total) => (div(c.st.agentTotal, total.st.agentTotal) ?? 0) * (total.st.forecast.cost30 ?? 0),
  "Projected Cost by Agent (12mo)": (c, total) => (div(c.st.agentTotal, total.st.agentTotal) ?? 0) * total.st.forecast.yearCost,
});
register("Credit Consumption (User)", {
  "Studio Total Credits Used": (c) => c.st.userTotal,
  "Total Billable Credits Used": (c) => c.st.userBillable,
  "Billable Credit Cost (User)": (c) => c.st.userBillable * c.s.studioPayg,
  "Billing Active Users": (c) => c.st.users,
  "Studio Avg Credits per User": (c) => c.st.avgPerUser, "Avg Agents per User": (c) => c.st.avgAgents,
  "Group Credit Share %": (c, total) => div(c.st.userTotal, total.st.userTotal),
  "Unlicensed Credit Share %": (c) => c.st.unlicensed, "Studio Top 10% Share": (c) => c.st.top10,
  "Studio Concentration Summary": (c) => c.st.concentration,
  "Projected Cost by Group (30d)": (c, total) => (div(c.st.userTotal, total.st.userTotal) ?? 0) * (total.st.forecast.cost30 ?? 0),
  "Projected Cost by Group (12mo)": (c, total) => (div(c.st.userTotal, total.st.userTotal) ?? 0) * total.st.forecast.yearCost,
});
register("Agent Action Group", {
  "Agents in Action": (c) => sum(c.st.byAction.filter((a) => !c.f.agentAction || a.action === c.f.agentAction), (a) => a.agents),
  "Credits in Action": (c) => sum(c.st.byAction.filter((a) => !c.f.agentAction || a.action === c.f.agentAction), (a) => a.credits),
});
register("GitHub Usage", {
  "GHCP Credits Used": (c) => c.gh.credits, "GHCP Active Developers": (c) => c.gh.devs,
  "GHCP Credits per Developer": (c) => c.gh.perDev, "GHCP Coding Agent Share %": (c) => c.gh.coding,
  "GHCP Powerful Model Share %": (c) => c.gh.powerful, "GHCP Basis Note": (c) => c.gh.basisNote,
  "GHCP Concentration Summary": (c) => c.gh.concentration,
  "GHCP Overage Cost": (c) => c.gh.net, "GHCP Allowance Absorbed": (c) => c.gh.absorbed,
  "GHCP Gross Value": (c) => c.gh.gross, "GHCP Cost per Developer": (c) => c.gh.costPerDev,
  "GHCP Cost Headline": (c) => c.gh.costHeadline, "GHCP Seats With No Credit Use": (c) => c.gh.idleSeats,
  "GHCP Seat Cost With No Credit Use": (c) => c.gh.idleSeatCost, "GHCP Top 10% Share": (c) => c.gh.top10,
  "GHCP Latest Month Credits": (c) => c.gh.latestMonth, "GHCP Growth Applied %": (c) => c.gh.forecast.growth,
  "GHCP Year Credits": (c) => c.gh.forecast.yearCredits, "GHCP Year Cost": (c) => c.gh.forecast.yearCost,
  "GHCP Month Cost": (c) => c.gh.forecast.months[month(c)]?.cost ?? null,
  "GHCP Month Credits": (c) => c.gh.forecast.months[month(c)]?.credits ?? null,
  "GHCP Month Pool": (c) => c.gh.forecast.months[month(c)]?.pool ?? null,
  "GHCP Forecast Summary": (c) => c.gh.forecast.summary,
});
register("GitHub User", {
  "GHCP Seat Cost (Monthly)": (c) => c.gh.seatCost, "GHCP Monthly Pool": (c) => c.gh.pool,
  "GHCP Pool From September": (c) => c.gh.poolNext, "GHCP Pool Used %": (c) => c.gh.poolUsed,
});
register("GHCP Period", { "GHCP Billing Period": (c) => c.gh.billingPeriod });
register("AzureSolutionSpend", {
  "Azure Selected Cost": (c) => c.az.selected, "Azure Model Share %": (c) => c.az.modelShare,
  "Azure Supporting Cost": (c) => c.az.supporting, "Azure AI Requests": (c) => c.az.requests,
  "Azure Tagged Allocation %": (c) => c.az.tagged, "Azure Model Cost": (c) => c.az.model,
  "Azure AI Service Cost": (c) => c.az.aiService, "Azure Total Tokens (M)": (c) => c.az.tokensM,
  "Azure Speech Hours": (c) => c.az.speechHours, "Azure Document Pages": (c) => c.az.pages,
  "Azure Generated Images": (c) => c.az.images, "Azure Cost per 1M PAYG Tokens": (c) => c.az.costPer1M,
});
register("AzureDeploymentHealth", {
  "Azure Deployments": (c) => c.health.deployments, "Azure PTU Capacity": (c) => c.health.capacity,
  "Azure Weighted PTU Utilisation %": (c) => c.health.util === null ? null : c.health.util / 100, "Azure Model Requests": (c) => c.health.requests,
  "Azure 5xx Error Rate": (c) => c.health.errorRate, "Azure 429 Rate": (c) => c.health.throttleRate,
  "Azure Mean Latency": (c) => c.health.latency, "Azure Low Utilisation Deployments": (c) => c.health.low,
});
register("AzureBillingReconciliation", {
  "Recon Usage Estimate": (c) => c.recon.estimate, "Recon Azure Actual": (c) => c.recon.actual,
  "Recon Difference": (c) => c.recon.difference, "Recon Fictional Evidence": (c) => c.recon.evidence,
  "Recon Unexplained Residual": (c) => c.recon.residual,
});
register("Cowork Tasks", {
  "Reported Cowork Tasks": (c) => c.task.total.tasks, "Cowork Task Credits": (c) => c.task.total.credits,
  "Cowork Credits per Task": (c) => c.task.total.creditsPerTask, "Cowork PAYG Cost per Task": (c) => c.task.total.paygPerTask,
  "Cowork Task Effort Minutes": (c) => c.task.categories.length === 1 ? c.task.categories[0].minutes : null,
  "Cowork Expert-equivalent Hours": (c) => c.task.total.hours,
  "Cowork Task Monetary Equivalent": (c) => c.task.total.monetary,
  "Cowork Task Share": (c, total) => div(c.task.total.tasks, total.task.total.tasks),
  "Cowork Task Status Message": (c) => c.task.status, "Cowork Task Value Basis": (c) => c.task.basis.join(" · "),
});
const reportingRow = (c: Context) => c.combined.rows.find((p) => p.product === c.coordinates["Reporting Product.Product"]);
register("Settings", {
  "Reporting Cowork Credits": (c) => c.combined.rows[0].credits,
  "Reporting Studio Credits": (c) => c.combined.rows[1].credits,
  "Reporting GitHub Credits": (c) => c.combined.rows[2].credits,
  "Reporting Foundry Cost": (c) => c.combined.rows[3].cost,
  "Reporting Product Credits": (c) => reportingRow(c)?.credits ?? null,
  "Reporting Product Cost": (c) => reportingRow(c)?.cost ?? null,
  "Reporting Cost Basis": (c) => reportingRow(c)?.basis ?? null,
  "Reporting Coverage": (c) => reportingRow(c)?.coverage ?? null,
  "Reporting Window": (c) => c.combined.window, "Combined Caveat": (c) => c.combined.studioCaveat,
  "Reporting Caveat": () => REPORTING_CAVEAT, "Rates In Use": (c) => ratesInUse(c.s),
  "Source Windows": (c) => c.combined.rows.map((r) => `${r.product}: ${r.covered}`).join(" · "),
  "Studio Snapshot Note": (c) => c.st.snapshotNote, "Studio Effective Rate": (c) => c.st.tenant.effective,
});

export function measureValue(ref: string, selections: Selection = defaultSelection(), coordinates: Coordinates = {}): Scalar {
  const resolver = measures[ref];
  if (!resolver) throw new Error(`Unimplemented source measure: ${ref}`);
  return resolver(new Context(selections, coordinates), new Context(selections));
}

function dimensionRows(refs: string[], c: Context, values: Projection[]): Coordinates[] {
  if (!refs.length) return [{}];
  const first = refs[0];
  let candidates: Coordinates[] = [];
  const attr = c.f.group || "Department";
  if (first === "Group By.Group") {
    const isStudio = values.some((p) => p.ref.startsWith("Credit Consumption"));
    const isGitHub = values.some((p) => p.ref.startsWith("GitHub"));
    const people = isStudio ? c.st.perUser : isGitHub ? c.gh.developers
      : c.cw.people.map((p) => ({ name: p.name, group: groupOf(fixture, p.upn, attr) }));
    candidates = people.map((p) => Object.fromEntries(refs.map((ref) => [ref, ref === "Group By.Group" ? p.group : p.name])));
  } else {
    const map: Record<string, () => Coordinates[]> = {
      "Reporting Product.Product": () => c.combined.rows.map((p) => ({ [first]: p.product })),
      "CreditsWeekly.Week Label": () => c.cw.weekly.filter((p) => p.date >= addDays(fixture.coworkMax, -(Number(c.f.period || 4) - 1) * 7)).map((p) => ({ [first]: p.date })),
      "CoworkBilling.Seat Action": () => c.cw.people.map((p) => ({ [first]: p.action })),
      "Agent Bridge.Agent Name": () => c.st.visibleAgents.map((p) => ({ [first]: p.agent })),
      "Credit Consumption (Tenant).Usage_Date": () => c.st.daily.map((p) => ({ [first]: p.date })),
      "Credit Consumption (Agent).LLM_Model": () => c.st.byModel.map((p) => ({ [first]: p.model })),
      "Credit Consumption (Agent).Billable_Feature": () => c.st.byFeature.map((p) => ({ [first]: p.feature })),
      "Agent Action Group.Action": () => c.st.byAction.filter((p) => !c.f.agentAction || p.action === c.f.agentAction).map((p) => ({ [first]: p.action })),
      "GitHub User.Developer": () => c.gh.developers.map((p) => ({ [first]: p.name })),
      "GitHub User.Plan": () => c.gh.byPlan.map((p) => ({ [first]: p.plan })),
      "GitHub Usage.Model": () => c.gh.byModel.map((p) => ({ [first]: p.model })),
      "GitHub Usage.Usage_Date": () => c.gh.daily.map((p) => ({ [first]: p.date })),
      "GitHub Usage.Usage Type": () => c.gh.byType.map((p) => ({ [first]: p.type })),
      "GitHub Usage.Cost_Centre": () => c.gh.byCostCenter.map((p) => ({ [first]: p.cc })),
      "AzureSolutionSpend.ServiceName": () => c.az.byService.map((p) => ({ [first]: p.service })),
      "AzureSolutionSpend.UsageDate": () => c.az.composition.map((p) => ({ [first]: p.key })),
      "AzureSolutionSpend.ResourceName": () => c.az.resources.map((p) => ({
        [first]: p.resource, "AzureSolutionSpend.Application": p.application,
        "AzureSolutionSpend.ServiceName": p.service, "AzureSolutionSpend.DepartmentTag": p.department === "(Untagged)" ? "" : p.department,
      })),
      "AzureDeploymentHealth.Deployment Identity": () => c.health.list.map((p) => ({
        [first]: p.identity, "AzureDeploymentHealth.ModelName": p.model,
        "AzureDeploymentHealth.SkuName": p.sku, "AzureDeploymentHealth.Region": p.region,
      })),
      "AzureBillingReconciliation.Product": () => c.recon.byProduct.map((p) => ({ [first]: p.product })),
      "AzureBillingReconciliation.Status": () => c.recon.byStatus.map((p) => ({ [first]: p.label })),
      "AzureBillingReconciliation.Representation": () => c.recon.detail.map((p) => ({
        [first]: p.representation, "AzureBillingReconciliation.Product": p.product,
        "AzureBillingReconciliation.Status": p.rowStatus, "AzureBillingReconciliation.EvidenceType": p.evidenceType,
      })),
      "Cowork Task Categories.TaskCategory": () => c.task.categories.map((p) => ({ [first]: p.category })),
      "Cowork Task Date.Week Start": () => c.task.weekly.map((p) => ({ [first]: p.key })),
      "Projection Month.Value": () => Array.from({ length: 12 }, (_, i) => ({ [first]: String(i + 1) })),
    };
    if (!map[first]) throw new Error(`Unimplemented source dimension: ${first}`);
    candidates = map[first]();
  }
  return [...new Map(candidates.map((row) => {
    const picked = Object.fromEntries(refs.map((ref) => [ref, row[ref] ?? ""]));
    return [JSON.stringify(picked), picked];
  })).values()];
}

export function queryVisual(visual: Visual, selections: Selection) {
  const total = new Context(selections);
  const roles = visual.roles;
  const dimensions = roles.Rows || roles.Category || [];
  const values = [...(roles.Data || roles.Values || roles.Y || []), ...(roles.Y2 || [])];
  const tooltips = roles.Tooltips || [];
  const resolve = (p: Projection, c: Context) => {
    if (!measures[p.ref]) throw new Error(`Unimplemented source measure: ${p.ref}`);
    return measures[p.ref](c, total);
  };
  const seriesRef = roles.Series?.[0]?.ref;
  const series = seriesRef === "Cowork Tasks.TaskType" ? total.task.types : [];
  let columns = values;
  if (series.length) columns = series.map((type) => ({ ...values[0], label: type }));
  const rows = dimensionRows(dimensions.map((p) => p.ref), total, values).map((coordinates) => {
    const c = new Context(selections, coordinates);
    const data = series.length ? series.map((type) => resolve(values[0], new Context(selections, { ...coordinates, [seriesRef!]: type }))) : values.map((p) => resolve(p, c));
    return { coordinates, labels: dimensions.map((p) => coordinates[p.ref]), values: data, tooltips: tooltips.map((p) => ({ label: p.label, value: resolve(p, c) })) };
  });
  for (const order of [...(visual.sort?.sort || [])].reverse()) {
    const field = order.field.Measure || order.field.Column;
    if (!field) throw new Error(`Unsupported source sort on ${visual.id}`);
    const ref = `${field.Expression.SourceRef.Entity}.${field.Property}`;
    const key = (row: typeof rows[number]) => order.field.Column ? row.coordinates[ref]
      : resolve({ ref, label: field.Property, kind: "Measure" }, new Context(selections, row.coordinates));
    rows.sort((a, b) => {
      const left = key(a), right = key(b);
      const result = typeof left === "number" && typeof right === "number" ? left - right
        : String(left ?? "").localeCompare(String(right ?? ""));
      return result * (order.direction === "Descending" ? -1 : 1);
    });
  }
  return { dimensions, columns, rows, totals: values.map((p) => resolve(p, total)) };
}

export function verifyBindings(pages: { visuals: Visual[] }[]) {
  for (const page of pages) for (const visual of page.visuals) {
    if (visual.type === "slicer") {
      const ref = visual.roles.Values[0].ref;
      if (ref !== "Reporting Date.Date") optionsFor(ref);
    } else if (Object.keys(visual.roles).length) queryVisual(visual, defaultSelection());
  }
}
