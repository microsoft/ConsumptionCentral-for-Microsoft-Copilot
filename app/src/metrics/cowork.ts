import type { CoworkPerson, CreditRow, Dataset } from '../data/types'
import { ZERO_GUID } from '../data/types'
import type { Filters, Settings } from '../data/store'
import { dayNum, eomonth } from '../data/csv'
import { groupAttr, groupOf, inGroup } from './common'
import { clamp, div, groupRows, ols, scenarioRate } from './stats'
import { int, pct, usd, usd4 } from '../ui/format'

// ---------- Selection ----------

export interface PeriodOption {
  value: string
  label: string
  weeks: number
}

/** The Cowork Period table: 4 and 8 weeks when narrower than the history, then all history. */
export function coworkPeriods(ds: Dataset): PeriodOption[] {
  const max = new Set(ds.credits.map((c) => c.date)).size
  const out: PeriodOption[] = []
  if (4 < max) out.push({ value: '4', label: 'Current period (4 weeks)', weeks: 4 })
  if (8 < max) out.push({ value: '8', label: 'Last 8 weeks', weeks: 8 })
  out.push({ value: String(max), label: `All history (${int(max)} weeks)`, weeks: max })
  return out
}

/** [Cowork Period Weeks]: 4 when nothing is picked. */
export const periodWeeks = (f: Filters) => (f.period ? Number(f.period) : 4)

const weeksAgo = (max: string, date: string) => Math.round((dayNum(max) - dayNum(date)) / 7)

/** CoworkBilling rows that pass the policy, cohort and Group By filters. */
export function selectPeople(ds: Dataset, f: Filters): CoworkPerson[] {
  return ds.people.filter(
    (p) => (!f.policy || p.policyName === f.policy) && (!f.cohort || p.cohort === f.cohort) && inGroup(ds, p.upn, f),
  )
}

/** CreditsWeekly rows for the selected people and service, all weeks. */
export function selectCredits(ds: Dataset, f: Filters, people: CoworkPerson[]): CreditRow[] {
  const keys = new Set(people.map((p) => p.upn))
  return ds.credits.filter((c) => keys.has(c.upn) && (!f.service || c.service === f.service))
}

// ---------- Core measures ----------

export interface CostSplit {
  used: number | null
  prepaidUsed: number | null
  payg: number | null
  prepaidCost: number
  paygCost: number
  total: number
  blended: number | null
}

/** Prepaid draws first, PAYG after, priced at the Settings rates. */
export function costOf(used: number | null, s: Settings): CostSplit {
  const bal = s.pack
  const prepaidUsed = used === null ? null : Math.min(used, bal)
  const payg = used === null ? null : Math.max(0, used - bal)
  const prepaidCost = (prepaidUsed ?? 0) * s.coworkPrepaid
  const paygCost = (payg ?? 0) * s.coworkPayg
  const total = prepaidCost + paygCost
  return { used, prepaidUsed, payg, prepaidCost, paygCost, total, blended: div(total, used) }
}

export interface PersonUse {
  person: CoworkPerson
  used: number
}

/** [Cowork Total Credits Used] for a set of people within the period window. */
export function windowUse(ds: Dataset, f: Filters, people: CoworkPerson[]) {
  const W = periodWeeks(f)
  const credits = selectCredits(ds, f, people)
  const inWindow = credits.filter((c) => weeksAgo(ds.coworkMax, c.date) < W)
  const per = new Map<string, number>()
  for (const c of inWindow) per.set(c.upn, (per.get(c.upn) ?? 0) + c.credits)
  const raw = inWindow.reduce((s, c) => s + c.credits, 0)
  return {
    credits,
    inWindow,
    per,
    used: people.length ? Math.round(raw) : null,
    consuming: new Set(inWindow.map((c) => c.upn)).size,
  }
}

export const billingBasis = (used: number | null, s: Settings) =>
  s.pack === 0 ? 'Pay-as-you-go' : s.pack >= (used ?? 0) ? 'Capacity Packs' : 'Capacity Packs, then pay-as-you-go'

export const ratesInUse = (s: Settings) =>
  `Cowork ${usd4(s.coworkPayg)} · Studio ${usd4(s.studioPayg)} · Cowork capacity pack ${int(s.pack)} credits`

export const SAVING_NOTE =
  'Savings are priced at the pay-as-you-go rate, because releasing a credit only saves money if you would otherwise have bought it.'

/** [Action Value /mo] for one person. */
export function actionValue(p: CoworkPerson, s: Settings): number {
  const r = s.coworkPayg
  switch (p.action.charAt(0)) {
    case '1':
    case '2':
      return p.limit * r
    case '3':
      return Math.max(0, p.delta) * r
    case '6':
      return -Math.max(0, -p.delta) * r
    default:
      return 0
  }
}

// ---------- Weekly series ----------

export interface WeekPoint {
  date: string
  credits: number
  wau: number
  wow: number | null
}

export function weeklySeries(credits: CreditRow[]): WeekPoint[] {
  const by = groupRows(credits, (c) => c.date)
  const dates = [...by.keys()].sort()
  const tot = new Map(dates.map((d) => [d, by.get(d)!.reduce((s, c) => s + c.credits, 0)]))
  return dates.map((d) => {
    const prev = new Date(Date.parse(`${d}T00:00:00Z`) - 7 * 86400000).toISOString().slice(0, 10)
    const p = tot.get(prev)
    return {
      date: d,
      credits: tot.get(d)!,
      wau: new Set(by.get(d)!.map((c) => c.upn)).size,
      wow: p === undefined ? null : div(tot.get(d)! - p, p),
    }
  })
}

/** Weekly prepaid and PAYG cost inside the period window, burning down the pack balance oldest first. */
export function weeklyCost(ds: Dataset, f: Filters, credits: CreditRow[], s: Settings) {
  const W = periodWeeks(f)
  const weeks = weeklySeries(credits.filter((c) => weeksAgo(ds.coworkMax, c.date) < W))
  let prior = 0
  return weeks.map((w) => {
    const left = Math.max(0, s.pack - prior)
    const pre = Math.min(w.credits, left)
    prior += w.credits
    return { ...w, prepaidCost: pre * s.coworkPrepaid, paygCost: (w.credits - pre) * s.coworkPayg }
  })
}

// ---------- Forecast ----------

export interface Trend {
  weeks: number
  slope: number | null
  r2: number | null
  accuracy: number | null
  implied: number | null
  capped: boolean
  confidence: string
}

/** Trend Slope, R², backtest, Implied Monthly Growth and confidence over every selected week. */
export function trend(ds: Dataset, credits: CreditRow[]): Trend {
  const allDates = [...new Set(ds.credits.map((c) => c.date))].sort()
  const idx = new Map(allDates.map((d, i) => [d, i + 1]))
  const series = weeklySeries(credits)
  const xs = series.map((w) => idx.get(w.date)!)
  const ys = series.map((w) => w.credits)
  const n = xs.length
  const fit = ols(xs, ys)
  const mean = n ? ys.reduce((a, b) => a + b, 0) / n : 0
  const wk = Math.max(div(fit.slope, mean) ?? 0, -0.9)
  const raw = (1 + wk) ** 4.345 - 1
  const implied = n < 4 || fit.slope === null || mean === 0 ? null : clamp(raw, -0.75, 1)

  let accuracy: number | null = null
  if (n) {
    const maxIdx = Math.max(...xs)
    const train = xs.map((x, i) => [x, ys[i]] as const).filter(([x]) => x <= maxIdx - 4)
    const test = xs.map((x, i) => [x, ys[i]] as const).filter(([x]) => x > maxIdx - 4)
    if (train.length > 2) {
      const tf = ols(
        train.map(([x]) => x),
        train.map(([, y]) => y),
      )
      const errs = test.map(([x, y]) => div(Math.abs(y - ((tf.intercept ?? 0) + (tf.slope ?? 0) * x)), y)).filter((e): e is number => e !== null)
      accuracy = errs.length ? 1 - errs.reduce((a, b) => a + b, 0) / errs.length : null
    }
  }
  const fitOk = fit.r2 ?? -1
  const accOk = accuracy ?? -1
  const confidence =
    n < 4 ? 'Too early to say' : n < 6 ? 'Indicative only' : fitOk >= 0.8 && accOk >= 0.85 ? 'High' : fitOk >= 0.6 && accOk >= 0.75 ? 'Medium' : 'Low'
  return { weeks: n, slope: fit.slope, r2: fit.r2, accuracy, implied, capped: n >= 4 && raw > 1, confidence }
}

export function growthApplied(t: Trend, scenario: string): number {
  const r = scenarioRate(scenario || 'fitted')
  return r === null ? (t.implied ?? 0) : r
}

export function projection(used: number | null, g: number, blended: number | null) {
  const months = Array.from({ length: 12 }, (_, i) => {
    const credits = (used ?? 0) * (1 + g) ** (i + 1)
    return { m: i + 1, credits, cost: credits * (blended ?? 0) }
  })
  return {
    months,
    yearCredits: months.reduce((s, m) => s + m.credits, 0),
    yearCost: months.reduce((s, m) => s + m.cost, 0),
  }
}

export function forecastSummary(used: number | null, t: Trend, g: number, yearCost: number, scenario: string): string {
  const override = scenarioRate(scenario || 'fitted') !== null
  if (!used) return 'No Cowork or Work IQ consumption in this selection.'
  if (!t.weeks || (!override && t.implied === null)) {
    const w = t.weeks
    return `Only ${int(w)} ${w === 1 ? 'week' : 'weeks'} of history so far - too early to read a trend. The figures above assume usage carries on at its current rate.`
  }
  const basis = override
    ? `Using your rate of ${pct(g)} a month`
    : `Usage has grown ${pct(g)} a month over the last ${int(t.weeks)} ${t.weeks === 1 ? 'week' : 'weeks'}`
  return `${basis}${t.capped ? ', capped at the 100% ceiling' : ''}. At that rate the next twelve months cost about ${usd(yearCost)}. Confidence in this projection is ${t.confidence.toLowerCase()}.`
}

// ---------- Page models ----------

export interface GroupRow {
  group: string
  people: CoworkPerson[]
  users: number
  used: number | null
  allowance: number
  consuming: number
  cost: CostSplit
}

export function coworkModel(ds: Dataset, f: Filters, s: Settings) {
  const attr = groupAttr(ds, f)
  const people = selectPeople(ds, f)
  const w = windowUse(ds, f, people)
  const cost = costOf(w.used, s)
  const allowance = people.reduce((a, p) => a + p.limit, 0)
  const over = people.filter((p) => Math.round(w.per.get(p.upn) ?? 0) > p.limit).length
  const policyAllowance = ds.policies
    .filter((p) => p.id !== ZERO_GUID && (!f.policy || p.name === f.policy))
    .reduce((a, p) => a + p.planLimit, 0)

  const byGroup = groupRows(people, (p) => groupOf(ds, p.upn, attr))
  const groups: GroupRow[] = [...byGroup.entries()].map(([group, ps]) => {
    const gw = windowUse(ds, f, ps)
    return {
      group,
      people: ps,
      users: ps.length,
      used: gw.used,
      allowance: ps.reduce((a, p) => a + p.limit, 0),
      consuming: gw.consuming,
      cost: costOf(gw.used, s),
    }
  })
  groups.sort((a, b) => (b.used ?? 0) - (a.used ?? 0))

  return {
    attr,
    people,
    used: w.used,
    per: w.per,
    credits: w.credits,
    allowance,
    allowanceUsed: div(w.used, allowance),
    consuming: w.consuming,
    activeAll: new Set(w.credits.map((c) => c.upn)).size,
    overPct: div(over, people.length),
    users: people.length,
    cost,
    policyAllowance,
    policyUsed: div(w.used, policyAllowance),
    headroom: policyAllowance - (w.used ?? 0),
    groups,
    weekly: weeklySeries(w.credits),
  }
}

export type CoworkModel = ReturnType<typeof coworkModel>

export function optimisationModel(m: CoworkModel, s: Settings) {
  const r = s.coworkPayg
  const ppl = m.people
  const net = ppl.reduce((a, p) => a + actionValue(p, s), 0)
  const reclaim = ppl.reduce((a, p) => a + Math.max(0, p.delta), 0)
  const dormant = ppl.filter((p) => p.used === 0).reduce((a, p) => a + p.limit, 0)
  const byAction = [...groupRows(ppl, (p) => p.action).entries()]
    .map(([action, ps]) => ({
      action,
      users: ps.length,
      allowance: ps.reduce((a, p) => a + p.limit, 0),
      used: Math.round(ps.reduce((a, p) => a + (m.per.get(p.upn) ?? 0), 0)),
      net: ps.reduce((a, p) => a + actionValue(p, s), 0),
    }))
    .sort((a, b) => a.action.localeCompare(b.action))
  return {
    net,
    reclaim: reclaim * r,
    dormant: dormant * r,
    upgrade: ppl.filter((p) => (p.persistence ?? -1) >= 0.6).length,
    downsize: ppl.filter((p) => p.delta > 0 && p.used > 0).length,
    inactive: ppl.filter((p) => p.licensed && p.used === 0).length,
    byAction,
  }
}

export function forecastModel(ds: Dataset, f: Filters, m: CoworkModel) {
  const t = trend(ds, m.credits)
  const g = growthApplied(t, f.growth)
  const proj = projection(m.used, g, m.cost.blended)
  const flat = projection(m.used, 0, m.cost.blended)
  const fitted = scenarioRate(f.growth || 'fitted') === null
  const groups = m.groups.map((gr) => {
    const gt = trend(ds, selectCredits(ds, f, gr.people))
    const gg = growthApplied(gt, f.growth)
    return { group: gr.group, used: gr.used, growth: gg, yearCost: projection(gr.used, gg, gr.cost.blended).yearCost }
  })
  return {
    trend: t,
    growth: g,
    fitted,
    // Under six weeks of history the trend is too short to project growth.
    reliable: !fitted || (t.confidence !== 'Too early to say' && t.confidence !== 'Indicative only'),
    confidence: t.confidence,
    runRate: (m.used ?? 0) * (m.cost.blended ?? 0),
    ...proj,
    months: proj.months.map((x, i) => ({ ...x, month: ds.coworkMax ? eomonth(ds.coworkMax, x.m) : '', flatCredits: flat.months[i].credits, flatCost: flat.months[i].cost })),
    flatYearCost: flat.yearCost,
    flatYearCredits: flat.yearCredits,
    groups,
    summary: forecastSummary(m.used, t, g, proj.yearCost, f.growth),
  }
}
