import type { Dataset } from "../../app/src/data/types";
import { addDays } from "../../app/src/data/csv";
import { intensityBand } from "../../app/src/metrics/stats";
import { TASK_MINUTES } from "../../app/src/metrics/tasks";

export const DEPARTMENTS = ["Engineering", "Operations", "Finance", "Research"];
export const SETTINGS = {
  coworkPayg: 0.01, coworkPrepaid: 0.008, studioPayg: 0.01, studioPrepaid: 0.008,
  pack: 0, githubRate: 0.01, bizSeat: 19, entSeat: 39,
  changeDate: "2026-09-01", bizStd: 1900, entStd: 3900,
};

/** Invented records; no input is copied from a person, tenant or account export. */
export function createFixture(): Dataset {
  const ds: Dataset = {
    label: "Synthetic demo data", sample: true, sources: [],
    people: [], credits: [], policies: [], coworkMax: "2026-07-26",
    groupAttrs: ["All users", "Department", "Cost Center", "Country", "User"],
    groups: new Map(), studioTenant: [], studioAgents: [], studioUsers: [],
    ghUsage: [], ghUsers: [], ghUpn: new Map(), azureDaily: [], azureSolution: [],
    azureHealth: [], recon: [], tasks: [], tasksLoaded: true,
    minDate: "2026-05-01", maxDate: "2026-07-31",
  };
  for (let group = 0; group < 4; group++) {
    ds.policies.push({
      id: `policy-${group + 1}`, name: `Policy ${group + 1}`,
      planLimit: 12000, userLimit: 1000, costCentre: `CC-${group + 1}`,
      department: DEPARTMENTS[group], billingOwner: `Owner ${group + 1}`, chargeCode: `Charge ${group + 1}`,
    });
  }
  for (let person = 0; person < 12; person++) {
    const upn = `person-${person + 1}@example.invalid`;
    const name = `Person ${String(person + 1).padStart(2, "0")}`;
    const group = Math.floor(person / 3);
    ds.groups.set(upn, { Department: DEPARTMENTS[group], "Cost Center": `CC-${group + 1}`, Country: `Region ${group % 2 + 1}`, User: name });
    for (let week = 0; week < 13; week++) {
      if (person === 11 || (person === 10 && week > 8)) continue;
      for (const [service, multiplier] of [["Cowork", 3], ["Work IQ", 1]] as const) {
        ds.credits.push({
          upn, date: addDays("2026-05-03", week * 7), service,
          credits: (person + 1) * (week + 10) * multiplier,
        });
      }
    }
    const records = ds.credits.filter((r) => r.upn === upn);
    const used = records.filter((r) => r.date >= "2026-07-05").reduce((n, r) => n + r.credits, 0);
    const limit = person % 4 === 0 ? 5000 : 1000;
    const recommended = used === 0 ? 0 : Math.max(250, Math.ceil(used * 1.15 / 250) * 250);
    const weeksActive = new Set(records.map((r) => r.date)).size;
    const weeklyUse = [...new Set(records.map((r) => r.date))].map((date) => records.filter((r) => r.date === date).reduce((n, r) => n + r.credits, 0));
    const weeksOver = weeklyUse.filter((n) => n > limit / 4.345).length;
    const persistence = weeksActive ? weeksOver / weeksActive : null;
    const action = weeksActive === 0 ? "1. Reclaim - never used"
      : used === 0 ? "2. Review - no usage in billing period"
      : used / limit < 0.25 ? "3. Downsize - under 25% used"
      : persistence !== null && persistence > 0 && persistence < 0.3 ? "4. Hold - spiky, not structural"
      : used / limit >= 0.85 && (persistence ?? 0) < 0.6 ? "5. Monitor - near limit"
      : (persistence ?? 0) >= 0.6 ? "6. Upgrade - persistently over"
      : "7. Correctly sized";
    ds.people.push({
      upn, name, policyId: `policy-${group + 1}`, policyName: `Policy ${group + 1}`,
      limit, licensed: true, used, cohort: "", bucket: used > limit ? "Over Limit" : used >= limit * .85 ? "Approaching" : "Under Limit",
      weeksActive, weeksOver, persistence, recommended, delta: limit - recommended, action,
    });
    const enterprise = person < 4;
    const username = `contributor-${person + 1}`;
    ds.ghUsers.push({ username, upn, name, enterprise, plan: enterprise ? "Copilot Enterprise" : "Copilot Business", included: enterprise ? 3900 : 1900 });
    ds.ghUpn.set(username, upn);
    for (let month = 5; month <= 7; month++) {
      if (person >= 10) continue;
      for (let model = 0; model < 3; model++) {
        const credits = (person + 1) * (month + model) * 12;
        const gross = credits * SETTINGS.githubRate;
        const discount = gross * .6;
        ds.ghUsage.push({
          username, date: `2026-0${month}-15`, model: `Model ${model + 1}`,
          credits, gross, discount, net: gross - discount, costCenter: `CC-${group + 1}`,
          usageType: model === 2 ? "Coding agent" : "Chat and inline",
          tier: (["1. Lightweight", "2. Versatile", "3. Powerful"] as const)[model],
        });
      }
    }
    for (let agent = 0; agent < 3; agent++) {
      const credits = (person + 1) * (agent + 1) * 10;
      ds.studioUsers.push({ email: upn, name, agent: `Agent ${agent + 1}`, credits, billable: credits * .4, licensed: person < 9 });
    }
  }
  const used = ds.people.map((p) => p.used).sort((a, b) => a - b);
  for (const person of ds.people) person.cohort = intensityBand(person.used, used, false);
  for (let day = 0; day < 92; day++) {
    const date = addDays("2026-05-01", day);
    for (let env = 0; env < 2; env++) {
      ds.studioTenant.push({ envId: `env-${env + 1}`, env: `Environment ${env + 1}`, date, entitled: env ? 0 : 25000, prepaid: env ? 0 : 80 + day, payg: 25 + day + env * 20 });
    }
    for (let resource = 0; resource < 3; resource++) {
      const actual = (resource + 1) * (10 + day / 10);
      ds.azureSolution.push({
        date, subscription: `Subscription ${resource % 2 + 1}`, resource: `Resource ${resource + 1}`,
        application: `Workload ${resource % 2 + 1}`, department: resource === 2 ? "" : DEPARTMENTS[resource],
        service: ["Foundry Models", "AI Speech", "Storage"][resource],
        category: ["Model", "AI service", "Supporting"][resource],
        actual, amortized: actual * .85, currency: "USD",
        tokensM: resource === 0 ? 1 + day / 100 : 0,
        paygTokensM: resource === 0 ? .8 : 0, paygTokenCost: resource === 0 ? 8 : 0,
        requests: resource === 0 ? 1000 + day * 10 : 0,
        speechHours: resource === 1 ? 2 : 0, pages: 0, images: 0, tagged: resource < 2,
      });
      if (resource === 0) ds.azureDaily.push({ date, service: "Foundry Models", cost: actual });
    }
  }
  for (let agent = 0; agent < 4; agent++) {
    for (let feature = 0; feature < 2; feature++) {
      ds.studioAgents.push({
        agent: `Agent ${agent + 1}`, product: "Copilot Studio", feature: ["Generative answers", "Agent actions"][feature],
        billed: agent === 3 ? 0 : (agent + 1) * (feature + 1) * 400,
        nonBilled: agent === 3 ? 0 : (agent + 1) * (feature + 1) * 600,
        model: `Model ${agent % 2 + 1}`, env: `Environment ${agent % 2 + 1}`,
      });
    }
  }
  for (let deployment = 0; deployment < 3; deployment++) {
    for (const date of ["2026-07-30", "2026-07-31"]) {
      ds.azureHealth.push({
        snapshot: `${date}T12:00:00Z`, date, subscription: `Subscription ${deployment % 2 + 1}`,
        identity: `Resource ${deployment + 1} / Deployment ${deployment + 1}`, deployment: `Deployment ${deployment + 1}`,
        application: `Workload ${deployment % 2 + 1}`, model: `Model ${deployment + 1}`,
        sku: deployment === 2 ? "Standard" : "ProvisionedManaged", region: `Region ${deployment % 2 + 1}`,
        capacity: deployment === 2 ? 0 : (deployment + 1) * 50,
        util: 20 + deployment * 25, peak: 30 + deployment * 25, requests: 1000 * (deployment + 1),
        errors: deployment + 1, throttles: (deployment + 1) * 2, latency: 200 + deployment * 100,
      });
    }
  }
  for (const [index, product] of ["Cowork / Work IQ", "Copilot Studio", "GitHub Copilot"].entries()) {
    for (const [representation, amount] of [["UsageEstimate", (index + 1) * 1000], ["AzureActual", (index + 1) * 1100], ["FictionalEvidence", (index + 1) * 80]] as const) {
      ds.recon.push({
        period: "2026-07", start: "2026-07-01", end: "2026-07-31",
        product, pool: "Shared AI pool", representation, amount, currency: "USD",
        status: "Review", evidenceType: representation === "FictionalEvidence" ? "Synthetic adjustment" : "Synthetic export",
      });
    }
  }
  for (let week = 0; week < 13; week++) {
    for (const [categoryIndex, category] of Object.keys(TASK_MINUTES).entries()) {
      for (let org = 0; org < 2; org++) {
        const tasks = (week + 1) * (categoryIndex + 1) * (org + 1);
        ds.tasks.push({
          date: addDays("2026-05-03", week * 7), category, type: categoryIndex % 2 ? "Assisted" : "Autonomous",
          credits: tasks * 2.5, tasks, org: DEPARTMENTS[org],
        });
      }
    }
  }
  return ds;
}
