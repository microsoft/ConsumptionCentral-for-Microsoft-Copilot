import type { AzureHealthRow, AzureSolutionRow, Dataset, ReconRow } from '../data/types'
import type { Filters } from '../data/store'
import { div, groupRows } from './stats'

const currencyOk = (c: string | undefined) => !!c && c.trim().length === 3

// ---------- Spend & consumption ----------

export const COST_BASES = ['Actual', 'Amortized'] as const

export function spendOptions(ds: Dataset) {
  const s = ds.azureSolution
  return {
    subscriptions: [...new Set(s.map((r) => r.subscription))].filter(Boolean).sort(),
    applications: [...new Set(s.map((r) => r.application))].filter(Boolean).sort(),
    services: [...new Set(s.map((r) => r.service))].filter(Boolean).sort(),
    currencies: [...new Set(s.map((r) => r.currency))].filter(Boolean).sort(),
  }
}

export function spendModel(ds: Dataset, f: Filters) {
  const opts = spendOptions(ds)
  const currency = f.currency || opts.currencies[0] || ''
  const basis = f.basis === 'Amortized' ? 'Amortized' : 'Actual'
  const rows = ds.azureSolution.filter(
    (r) =>
      (!f.subscription || r.subscription === f.subscription) &&
      (!f.application || r.application === f.application) &&
      (!f.azService || r.service === f.azService) &&
      (!currency || r.currency === currency),
  )
  const ok = currencyOk(currency) && new Set(rows.map((r) => r.currency)).size <= 1
  const cost = (rs: AzureSolutionRow[]) => (ok ? rs.reduce((a, r) => a + (basis === 'Amortized' ? r.amortized : r.actual), 0) : null)
  const cat = (rs: AzureSolutionRow[], c: string) => cost(rs.filter((r) => r.category === c))
  const selected = cost(rows)
  const paygTokensM = rows.reduce((a, r) => a + r.paygTokensM, 0)
  const paygTokenCost = ok ? rows.reduce((a, r) => a + r.paygTokenCost, 0) : null

  const composition = [...groupRows(rows, (r) => r.date).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, rs]) => ({ key: date, values: [cat(rs, 'Model') ?? 0, cat(rs, 'AI service') ?? 0, cat(rs, 'Supporting') ?? 0] }))
  const byService = [...groupRows(rows, (r) => r.service).entries()]
    .map(([service, rs]) => ({ service, cost: cost(rs) ?? 0 }))
    .sort((a, b) => b.cost - a.cost)
  const resources = [...groupRows(rows, (r) => [r.resource, r.application, r.service, r.department].join('|')).entries()]
    .map(([k, rs]) => ({ id: k, resource: rs[0].resource, application: rs[0].application, service: rs[0].service, department: rs[0].department || '(Untagged)', cost: cost(rs) ?? 0 }))
    .sort((a, b) => b.cost - a.cost)

  return {
    currency: ok ? currency : '',
    currencyOk: ok,
    basis,
    selected,
    model: cat(rows, 'Model'),
    aiService: cat(rows, 'AI service'),
    supporting: cat(rows, 'Supporting'),
    modelShare: div(cat(rows, 'Model'), selected),
    tagged: div(cost(rows.filter((r) => r.tagged)), selected),
    requests: rows.reduce((a, r) => a + r.requests, 0),
    tokensM: rows.reduce((a, r) => a + r.tokensM, 0),
    speechHours: rows.reduce((a, r) => a + r.speechHours, 0),
    pages: rows.reduce((a, r) => a + r.pages, 0),
    images: rows.reduce((a, r) => a + r.images, 0),
    costPer1M: div(paygTokenCost, paygTokensM),
    composition,
    byService,
    resources,
    options: opts,
  }
}

// ---------- Capacity & health ----------

export const HEALTH_NOTE =
  'Low PTU utilisation is a review signal, not guaranteed savings. Capacity uses the latest selected snapshot. Requests and health cover the selected period.'

export function healthOptions(ds: Dataset) {
  const h = ds.azureHealth
  return {
    subscriptions: [...new Set(h.map((r) => r.subscription))].filter(Boolean).sort(),
    applications: [...new Set(h.map((r) => r.application))].filter(Boolean).sort(),
    skus: [...new Set(h.map((r) => r.sku))].filter(Boolean).sort(),
  }
}

interface Snapshot {
  identity: string
  deployment: string
  model: string
  sku: string
  region: string
  application: string
  capacity: number
  util: number
  peak: number
  requests: number
  errors: number
  throttles: number
  latency: number
}

const isPtu = (s: Snapshot) => !!s.sku && !s.sku.includes('Standard') && s.capacity > 0

/** Latest snapshot per deployment at the latest metric date, as the report's health measures do. */
function snapshots(rows: AzureHealthRow[], scope: AzureHealthRow[]): Snapshot[] {
  let maxDate = ''
  for (const r of scope) if (r.date > maxDate) maxDate = r.date
  const period = scope.filter((r) => r.date === maxDate && r.snapshot && r.identity)
  const latest = new Map<string, string>()
  for (const r of period) if (r.snapshot > (latest.get(r.identity) ?? '')) latest.set(r.identity, r.snapshot)
  const picked = rows.filter((r) => r.date === maxDate && r.snapshot && latest.get(r.identity) === r.snapshot)
  return [...groupRows(picked, (r) => r.identity).entries()].map(([identity, rs]) => {
    const max = (f: (r: AzureHealthRow) => number) => Math.max(...rs.map(f))
    const maxS = (f: (r: AzureHealthRow) => string) => rs.map(f).sort().pop() ?? ''
    return {
      identity,
      deployment: maxS((r) => r.deployment),
      model: maxS((r) => r.model),
      sku: maxS((r) => r.sku),
      region: maxS((r) => r.region),
      application: maxS((r) => r.application),
      capacity: max((r) => r.capacity),
      util: max((r) => r.util),
      peak: max((r) => r.peak),
      requests: max((r) => r.requests),
      errors: max((r) => r.errors),
      throttles: max((r) => r.throttles),
      latency: max((r) => r.latency),
    }
  })
}

function healthOf(snaps: Snapshot[]) {
  const withReq = snaps.filter((s) => s.requests > 0)
  const ptu = snaps.filter((s) => isPtu(s) && s.util >= 0)
  return {
    deployments: snaps.length,
    capacity: snaps.filter(isPtu).reduce((a, s) => a + s.capacity, 0),
    util: div(
      ptu.reduce((a, s) => a + s.capacity * s.util, 0),
      ptu.reduce((a, s) => a + s.capacity, 0),
    ),
    requests: snaps.reduce((a, s) => a + s.requests, 0),
    errorRate: div(
      withReq.filter((s) => s.errors >= 0).reduce((a, s) => a + s.errors, 0),
      withReq.filter((s) => s.errors >= 0).reduce((a, s) => a + s.requests, 0),
    ),
    throttleRate: div(
      withReq.filter((s) => s.throttles >= 0).reduce((a, s) => a + s.throttles, 0),
      withReq.filter((s) => s.throttles >= 0).reduce((a, s) => a + s.requests, 0),
    ),
    latency: div(
      withReq.filter((s) => s.latency >= 0).reduce((a, s) => a + s.requests * s.latency, 0),
      withReq.filter((s) => s.latency >= 0).reduce((a, s) => a + s.requests, 0),
    ),
    low: ptu.filter((s) => s.util < 30).length,
  }
}

export function healthModel(ds: Dataset, f: Filters) {
  // The latest-snapshot key ignores application and SKU filters; the measures then respect them.
  const scope = ds.azureHealth.filter((r) => !f.hSubscription || r.subscription === f.hSubscription)
  const rows = scope.filter((r) => (!f.hApplication || r.application === f.hApplication) && (!f.sku || r.sku === f.sku))
  const snaps = snapshots(rows, scope)
  const list = snaps
    .map((s) => ({ ...s, ...healthOf([s]), ptu: isPtu(s) }))
    .sort((a, b) => b.capacity - a.capacity || b.requests - a.requests)
  return { ...healthOf(snaps), list, options: healthOptions(ds) }
}

// ---------- Billing reconciliation ----------

export const RECON_NOTE =
  'Match period, currency and billing pool before comparing. Evidence is fictional sample data. Supporting Azure solution costs are outside this shared pool.'

export function reconOptions(ds: Dataset) {
  const r = ds.recon
  return {
    periods: [...new Set(r.map((x) => x.period))].filter(Boolean).sort(),
    currencies: [...new Set(r.map((x) => x.currency))].filter(Boolean).sort(),
    pools: [...new Set(r.map((x) => x.pool))].filter(Boolean).sort(),
  }
}

function reconOf(rs: ReconRow[]) {
  const currencies = new Set(rs.map((r) => r.currency))
  const cur = currencies.size === 1 ? [...currencies][0] : ''
  const ok = currencyOk(cur)
  const sumRep = (rep: string) => {
    const m = rs.filter((r) => r.representation === rep)
    return ok && m.length ? m.reduce((a, r) => a + r.amount, 0) : null
  }
  const estimate = sumRep('UsageEstimate')
  const actual = sumRep('AzureActual')
  const evidence = sumRep('FictionalEvidence')
  const one = (f: (r: ReconRow) => string) => {
    const v = new Set(rs.map(f))
    return v.size === 1 && !!([...v][0] ?? '')
  }
  const scopeOk = one((r) => r.start) && one((r) => r.end) && one((r) => r.pool) && (rs[0]?.start ?? '') <= (rs[0]?.end ?? '')
  const status = !rs.length
    ? 'No data'
    : !ok
      ? 'Mixed/missing currency'
      : !scopeOk
        ? 'Select one aligned period and pool'
        : estimate === null || actual === null
          ? 'Not comparable: both representations required'
          : 'Comparable'
  const difference = status === 'Comparable' ? actual! - estimate! : null
  return {
    estimate,
    actual,
    evidence,
    status,
    difference,
    residual: difference !== null && evidence !== null ? difference - evidence : null,
  }
}

export function reconModel(ds: Dataset, f: Filters) {
  const opts = reconOptions(ds)
  // Default to one aligned scope (latest period, first pool) so the comparison is meaningful on first view.
  const period = f.reconPeriod || opts.periods[opts.periods.length - 1] || ''
  const pool = f.pool || opts.pools[0] || ''
  const rows = ds.recon.filter(
    (r) => (period === '*' || r.period === period) && (!f.reconCurrency || r.currency === f.reconCurrency) && (pool === '*' || r.pool === pool),
  )
  const total = reconOf(rows)
  const byProduct = [...groupRows(rows, (r) => r.product).entries()]
    .map(([product, rs]) => ({ product, ...reconOf(rs) }))
    .sort((a, b) => (b.estimate ?? 0) - (a.estimate ?? 0))
  const byStatus = [...groupRows(rows, (r) => r.status).entries()].map(([status, rs]) => ({ label: status, ...reconOf(rs) }))
  const detail = [...groupRows(rows, (r) => [r.representation, r.product, r.status, r.evidenceType].join('|')).entries()].map(([id, rs]) => ({
    id,
    representation: rs[0].representation,
    product: rs[0].product,
    rowStatus: rs[0].status,
    evidenceType: rs[0].evidenceType || '–',
    ...reconOf(rs),
  }))
  return { ...total, period, pool, currency: new Set(rows.map((r) => r.currency)).size === 1 ? rows[0].currency : '', byProduct, byStatus, detail, options: opts }
}
