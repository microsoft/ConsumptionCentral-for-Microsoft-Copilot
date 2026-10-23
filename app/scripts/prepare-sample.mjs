// Builds the bundled synthetic sample used by the app.
// Usage: npm run prepare-sample
//
// Copies the synthetic exports from "1. Local CSV/sample-data", keeps only the
// columns the app reads, and generates a richer synthetic Cowork task export
// keyed to the same synthetic people and weeks. Everything here is fictional.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Papa from 'papaparse'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = path.resolve(here, '..', '..', '1. Local CSV', 'sample-data')
const out = path.resolve(here, '..', 'public', 'sample')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

const read = (file) => {
  const text = fs.readFileSync(path.join(src, file), 'utf8').replace(/^\uFEFF/, '')
  return Papa.parse(text, { header: true, skipEmptyLines: true }).data
}
const write = (file, rows, columns) => {
  fs.writeFileSync(path.join(out, file), Papa.unparse(rows, { columns }) + '\n')
  console.log(`${file}: ${rows.length} rows`)
}

// Files copied with every column.
const whole = [
  'PersonServiceCreditsMetrics.csv',
  'PersonPolicyMap.csv',
  'PeopleMetaData.csv',
  'SpendingPolicyMetadata.csv',
  'entra_org.csv',
  'StudioTenantDaily.csv',
  'StudioPerAgent.csv',
  'StudioPerUser.csv',
  'GitHubUserMap.csv',
  'AzureAiSpendDaily.csv',
  'AzureDeploymentHealth.csv',
  'AzureBillingReconciliation.csv',
]
for (const f of whole) {
  const rows = read(f)
  write(f, rows, Object.keys(rows[0]))
}

// Large exports: keep only the columns the app reads.
const trimmed = {
  'GitHubAiUsage.csv': ['date', 'username', 'product', 'sku', 'model', 'quantity', 'gross_amount', 'discount_amount', 'net_amount', 'organization', 'cost_center_name'],
  'AzureSolutionSpend.csv': [
    'UsageDate', 'SubscriptionName', 'ResourceName', 'Application', 'DepartmentTag', 'ServiceName', 'ServiceCategory', 'ActualCost', 'AmortizedCost',
    'Currency', 'TotalTokensM', 'PaygTokensM', 'InputPaygCost', 'OutputPaygCost', 'CachedPaygCost', 'Requests', 'SpeechHours', 'DocumentPages', 'Images', 'AllocationStatus',
  ],
}
for (const [f, cols] of Object.entries(trimmed)) {
  const rows = read(f).map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? ''])))
  write(f, rows, cols)
}

// ---- Synthetic Cowork task export -------------------------------------------
// Deterministic PRNG so the sample never changes between runs.
let seed = 20260801
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296
  return seed / 4294967296
}
const pick = (items) => {
  const total = items.reduce((a, [, w]) => a + w, 0)
  let r = rnd() * total
  for (const [v, w] of items) if ((r -= w) <= 0) return v
  return items[items.length - 1][0]
}

const categories = [
  ['Analysis & research', 18, 9],
  ['Document & content creation', 22, 6],
  ['Email workflows', 20, 2],
  ['Meeting workflows', 12, 5],
  ['Communication workflows', 10, 1.5],
  ['Specialized workflows', 6, 7],
  ['Write or debug code', 5, 11],
  ['General assistance / Other', 5, 1],
  ['Unknown', 2, 2],
]
const types = [
  ['UserInitiated', 70],
  ['Scheduled', 25],
  ['Unknown', 5],
]

const metrics = read('PersonServiceCreditsMetrics.csv')
const map = read('PersonPolicyMap.csv')
const meta = new Map(read('PeopleMetaData.csv').map((r) => [r.PeopleHistoricalId, r]))
const entra = new Map(read('entra_org.csv').map((r) => [r.userPrincipalName.toLowerCase(), r]))
const phidOf = new Map(map.map((r) => [r.PersonId, r]))

// One row per person-week that had Cowork credits.
const weekly = new Map()
for (const m of metrics) {
  if (m.ServiceName !== 'Cowork') continue
  const k = `${m.PersonId}|${m.MetricDate}`
  weekly.set(k, (weekly.get(k) ?? 0) + Number(m['Total Copilot Credits used']))
}

const tasks = []
const people = new Map()
for (const [k, credits] of weekly) {
  const [pid, date] = k.split('|')
  const person = phidOf.get(pid)
  if (!person) continue
  const n = 1 + Math.floor(rnd() * 4)
  const seen = new Set()
  for (let i = 0; i < n; i++) {
    const cat = pick(categories.map((c) => [c, c[1]]))
    const type = pick(types)
    const key = `${cat[0]}|${type}`
    if (seen.has(key)) continue
    seen.add(key)
    const count = 1 + Math.floor(rnd() * Math.max(2, Math.min(40, credits / 600)))
    const perTask = cat[2] * (0.6 + rnd() * 0.8)
    tasks.push({
      PersonId: pid,
      MetricDate: date,
      TaskCategory: cat[0],
      TaskType: type,
      'Total credits used': (count * perTask).toFixed(2),
      'Total Cowork tasks': count,
      PeopleHistoricalId: person.PeopleHistoricalId,
    })
  }
  if (!people.has(person.PeopleHistoricalId)) {
    const m = meta.get(person.PeopleHistoricalId)
    const e = entra.get(person.userPrincipalName.toLowerCase())
    people.set(person.PeopleHistoricalId, {
      PeopleHistoricalId: person.PeopleHistoricalId,
      Organization: m?.Organization ?? e?.department ?? '',
      FunctionType: e?.jobFamily ?? '',
      IsCopilotLicensed: m?.IsCopilotLicensed ?? '',
    })
  }
}
tasks.sort((a, b) => a.MetricDate.localeCompare(b.MetricDate) || a.PersonId.localeCompare(b.PersonId))
write('CoworkWeeklyMetrics.csv', tasks, ['PersonId', 'MetricDate', 'TaskCategory', 'TaskType', 'Total credits used', 'Total Cowork tasks', 'PeopleHistoricalId'])
write('CoworkTaskPeopleMetaData.csv', [...people.values()], ['PeopleHistoricalId', 'Organization', 'FunctionType', 'IsCopilotLicensed'])

fs.writeFileSync(
  path.join(out, 'manifest.json'),
  JSON.stringify(fs.readdirSync(out).filter((f) => f.endsWith('.csv')).sort(), null, 1) + '\n',
)
