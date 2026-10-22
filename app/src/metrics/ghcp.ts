import type { Dataset, GhUsageRow, GhUser } from '../data/types'
import type { Filters, Settings } from '../data/store'
import { addDays, eomonth, monthKey } from '../data/csv'
import { groupAttr, groupOf } from './common'
import { div, groupRows, scenarioRate } from './stats'
import { dayLabel, dateLabel, int, pct, pct0, usd } from '../ui/format'

export function ghPeriods(ds: Dataset) {
  const months = new Set(ds.ghUsage.map((r) => monthKey(r.date))).size
  return [
    { value: '1', label: 'Latest month' },
    { value: '2', label: 'Last 2 months' },
    { value: '0', label: `All history (${int(months)} months)` },
  ]
}

export const ghOptions = (ds: Dataset) => ({
  costCenters: [...new Set(ds.ghUsage.map((r) => r.costCenter))].filter(Boolean).sort(),
  tiers: ['1. Lightweight', '2. Versatile', '3. Powerful'],
  types: ['Chat and inline', 'Coding agent'],
  models: [...new Set(ds.ghUsage.map((r) => r.model))].filter(Boolean).sort(),
})

const credits = (rs: GhUsageRow[]) => rs.reduce((a, r) => a + r.credits, 0)

function usageTotals(rs: GhUsageRow[]) {
  const c = credits(rs)
  const devs = new Set(rs.map((r) => r.username.toLowerCase())).size
  return {
    credits: c,
    devs,
    perDev: div(c, devs),
    gross: rs.reduce((a, r) => a + r.gross, 0),
    absorbed: rs.reduce((a, r) => a + r.discount, 0),
    net: rs.reduce((a, r) => a + r.net, 0),
    powerful: div(credits(rs.filter((r) => r.tier === '3. Powerful')), c),
    coding: div(credits(rs.filter((r) => r.usageType === 'Coding agent')), c),
  }
}

export function ghModel(ds: Dataset, f: Filters, s: Settings) {
  const attr = groupAttr(ds, f)
  const months = f.ghPeriod ? Number(f.ghPeriod) : 0
  const all = ds.ghUsage.map((r) => r.date).sort()
  const earliest = all[0] ?? ''
  const latestAll = all[all.length - 1] ?? ''
  const start = months === 0 || !latestAll ? earliest : addDays(eomonth(latestAll, -months), 1)
  const groupOfUser = (username: string) => groupOf(ds, ds.ghUpn.get(username.toLowerCase()) ?? '', attr)

  // Every filter except the period; the period is applied separately so latest-month measures can see it.
  const base = ds.ghUsage.filter(
    (r) =>
      (!f.costCenter || r.costCenter === f.costCenter) &&
      (!f.tier || r.tier === f.tier) &&
      (!f.usageType || r.usageType === f.usageType) &&
      (!f.model || r.model === f.model) &&
      (!f.groupValue || groupOfUser(r.username) === f.groupValue),
  )
  const rows = base.filter((r) => r.date >= start)
  const t = usageTotals(rows)

  // Scoped dates come from the whole export (ALL on the date column).
  const scopedDates = all.filter((d) => d >= start)
  const lastDay = scopedDates[scopedDates.length - 1] ?? ''
  const days = new Set(rows.map((r) => r.date)).size
  const monthsObserved = new Set(rows.map((r) => monthKey(r.date))).size
  const latestMonth = lastDay ? credits(base.filter((r) => monthKey(r.date) === monthKey(lastDay))) : 0

  const ymKeys = scopedDates.map(monthKey)
  const firstM = ymKeys.length ? Math.min(...ymKeys) : 0
  const lastM = ymKeys.length ? Math.max(...ymKeys) : 0
  const firstVal = credits(rows.filter((r) => monthKey(r.date) === firstM))
  const lastVal = credits(rows.filter((r) => monthKey(r.date) === lastM))
  const observedGrowth = lastM - firstM > 0 && firstVal > 0 ? (lastVal / firstVal) ** (1 / (lastM - firstM)) - 1 : null

  // Seats
  const seatUsers: GhUser[] = ds.ghUsers.filter((u) => !f.groupValue || groupOf(ds, u.upn, attr) === f.groupValue)
  const seatPrice = (u: GhUser) => (u.enterprise ? s.entSeat : s.bizSeat)
  const seatCost = seatUsers.reduce((a, u) => a + seatPrice(u), 0)
  const licensed = ds.ghUsers.length
  const active = new Set(rows.map((r) => r.username.toLowerCase()))
  const idleSeatCost = ds.ghUsers.filter((u) => !active.has(u.username.toLowerCase())).reduce((a, u) => a + (u.enterprise ? 39 : 19), 0)
  const pool = seatUsers.reduce((a, u) => a + u.included, 0)
  const poolNext = seatUsers.reduce((a, u) => a + (u.enterprise ? s.entStd : s.bizStd), 0)
  const totalCost = seatCost + t.net

  const perDev = [...groupRows(rows, (r) => r.username.toLowerCase()).entries()]
    .map(([u, rs]) => {
      const info = ds.ghUsers.find((x) => x.username.toLowerCase() === u)
      return {
        username: u,
        name: info?.name || rs[0].username,
        group: groupOfUser(u),
        ...usageTotals(rs),
        latest: lastDay ? credits(base.filter((r) => r.username.toLowerCase() === u && monthKey(r.date) === monthKey(lastDay))) : 0,
      }
    })
    .sort((a, b) => b.credits - a.credits)
  const top10 = perDev.length ? div(perDev.slice(0, Math.ceil(perDev.length * 0.1)).reduce((a, d) => a + d.credits, 0), t.credits) : null

  const byGroup = [...groupRows(perDev, (d) => d.group).entries()]
    .map(([group, ds2]) => {
      const rs = rows.filter((r) => groupOfUser(r.username) === group)
      return { group, ...usageTotals(rs), latest: ds2.reduce((a, d) => a + d.latest, 0) }
    })
    .sort((a, b) => b.credits - a.credits)
  const byModel = [...groupRows(rows, (r) => r.model).entries()]
    .map(([model, rs]) => ({ model, tier: rs[0].tier, ...usageTotals(rs) }))
    .sort((a, b) => b.credits - a.credits)
  const byType = [...groupRows(rows, (r) => r.usageType).entries()].map(([type, rs]) => ({ type, ...usageTotals(rs) }))
  const byCostCenter = [...groupRows(rows, (r) => r.costCenter || '(Not set)').entries()]
    .map(([cc, rs]) => ({ cc, ...usageTotals(rs) }))
    .sort((a, b) => b.credits - a.credits)
  const byPlan = [...groupRows(seatUsers, (u) => u.plan || '(Not set)').entries()].map(([plan, us]) => {
    const names = new Set(us.map((u) => u.username.toLowerCase()))
    return {
      plan,
      seats: us.length,
      active: [...active].filter((a) => names.has(a)).length,
      pool: us.reduce((a, u) => a + u.included, 0),
      poolNext: us.reduce((a, u) => a + (u.enterprise ? s.entStd : s.bizStd), 0),
      seatCost: us.reduce((a, u) => a + seatPrice(u), 0),
    }
  })
  const daily = [...groupRows(rows, (r) => r.date).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, rs]) => ({ date, ...usageTotals(rs) }))

  // Forecast
  const scen = scenarioRate(f.growth || 'fitted')
  const fitted = scen === null
  const growth = fitted ? (observedGrowth ?? 0) : scen
  const forecastMonths = Array.from({ length: 12 }, (_, i) => {
    const m = i + 1
    const c = latestMonth * (1 + growth) ** m
    const p = lastDay && eomonth(lastDay, m) >= s.changeDate ? poolNext : pool
    const creditCost = Math.max(0, c - p) * s.githubRate
    return { m, month: lastDay ? eomonth(lastDay, m) : '', credits: c, pool: p, creditCost, cost: seatCost + creditCost }
  })
  const yearCost = forecastMonths.reduce((a, m) => a + m.cost, 0)
  const yearCredits = forecastMonths.reduce((a, m) => a + m.credits, 0)
  const confidence = monthsObserved >= 9 ? 'High' : monthsObserved >= 5 ? 'Moderate' : monthsObserved >= 2 ? 'Low' : 'Insufficient history'
  const basisBit = fitted
    ? `Fitted from ${int(monthsObserved)} ${monthsObserved === 1 ? 'month' : 'months'} of history, usage is growing ${pct(growth)} a month`
    : `Using your rate of ${pct(growth)} a month`
  const forecastSummary = !latestMonth
    ? 'No GitHub Copilot consumption in this selection.'
    : `${basisBit}. The next twelve months come to ${usd(yearCost)} - seats ${usd(seatCost * 12)}, credits ${usd(yearCost - seatCost * 12)}.`

  const lo = scopedDates[0]
  return {
    attr,
    rows,
    ...t,
    billingPeriod: lo ? `${dayLabel(lo)} – ${dateLabel(lastDay)}` : 'No usage export loaded',
    basisNote: `Based on ${int(days)} days of billed credit usage. Code completions and next-edit suggestions are unlimited on every paid plan and are not billed, so they never appear here.`,
    concentration:
      top10 === null
        ? 'No GitHub Copilot consumption in this selection.'
        : `The heaviest 10% of developers account for ${pct0(top10)} of credits, and ${pct0(t.powerful ?? 0)} of all credits go to top-tier models.`,
    costHeadline: !seatCost
      ? 'No GitHub Copilot seats in this selection.'
      : `Seats cost ${usd(seatCost)} a month, pay-as-you-go credits ${usd(t.net)}. The allowance absorbs about ${usd(t.absorbed / Math.max(1, monthsObserved))} of consumption a month.`,
    days,
    monthsObserved,
    latestMonth,
    lastDay,
    observedGrowth,
    seatCost,
    licensed,
    idleSeats: licensed - t.devs,
    idleSeatCost,
    totalCost,
    costPerDev: div(totalCost, licensed),
    pool,
    poolNext,
    poolUsed: div(latestMonth, pool),
    top10,
    developers: perDev,
    byGroup,
    byModel,
    byType,
    byCostCenter,
    byPlan,
    daily,
    forecast: { growth, confidence, months: forecastMonths, yearCost, yearCredits, summary: forecastSummary },
  }
}

export type GhModel = ReturnType<typeof ghModel>
