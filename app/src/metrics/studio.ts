import type { Dataset, StudioAgentRow, StudioTenantRow, StudioUserRow } from '../data/types'
import type { Filters, Settings } from '../data/store'
import { addDays, dayNum, eomonth } from '../data/csv'
import { groupAttr, groupOf } from './common'
import { clamp, div, groupRows, ols, scenarioRate } from './stats'
import { dateLabel, int, pct, pct0, usd } from '../ui/format'

export const STUDIO_PERIODS = [
  { value: '7', label: 'Last 7 days' },
  { value: 'all', label: 'All available days' },
]

export const AGENT_ACTIONS = [
  '1. Review - high volume, mostly billed',
  '2. Investigate - almost all billed',
  '3. Monitor - high volume, well covered',
  '4. Healthy - low volume, no action needed',
  '5. Unused - retire or promote',
]

function agentAction(consumed: number, billed: number, share: number | null): string {
  const ratio = div(billed, consumed)
  if (!consumed) return AGENT_ACTIONS[4]
  if ((share ?? 0) >= 0.25 && (ratio ?? 0) >= 0.5) return AGENT_ACTIONS[0]
  if ((ratio ?? 0) >= 0.75) return AGENT_ACTIONS[1]
  if ((share ?? 0) >= 0.25) return AGENT_ACTIONS[2]
  return AGENT_ACTIONS[3]
}

export function studioOptions(ds: Dataset) {
  return {
    envs: [...new Set(ds.studioTenant.map((t) => t.env).concat(ds.studioAgents.map((a) => a.env)))].filter(Boolean).sort(),
    agents: [...new Set(ds.studioAgents.map((a) => a.agent).concat(ds.studioUsers.map((u) => u.agent)))].filter(Boolean).sort(),
    products: [...new Set(ds.studioAgents.map((a) => a.product))].filter(Boolean).sort(),
  }
}

const consumed = (t: StudioTenantRow) => t.prepaid + t.payg

/** Tenant measures over a set of tenant rows (already period- and environment-filtered). */
function tenantTotals(rows: StudioTenantRow[], s: Settings) {
  const prepaid = rows.reduce((a, r) => a + r.prepaid, 0)
  const payg = rows.reduce((a, r) => a + r.payg, 0)
  const prepaidCost = prepaid * s.studioPrepaid
  const paygCost = payg * s.studioPayg
  return { prepaid, payg, consumed: prepaid + payg, prepaidCost, paygCost, cost: prepaidCost + paygCost }
}

/** [Studio Entitled Capacity] for one environment: the max entitlement on its last date in scope. */
function entitled(rows: StudioTenantRow[]): number {
  let last = ''
  for (const r of rows) if (r.date > last) last = r.date
  return rows.filter((r) => r.date === last).reduce((m, r) => Math.max(m, r.entitled), 0)
}

/** [Studio Fitted Monthly Growth %]: log-linear fit of the trailing 7-day average. */
function fittedGrowth(rows: StudioTenantRow[], span: number, observed: number): number | null {
  if (span < 28 || observed < 7 || !rows.length) return null
  const byDay = new Map<number, number>()
  for (const r of rows) byDay.set(dayNum(r.date), (byDay.get(dayNum(r.date)) ?? 0) + consumed(r))
  const min = Math.min(...byDay.keys())
  const max = Math.max(...byDay.keys())
  const daily = Array.from({ length: max - min + 1 }, (_, x) => byDay.get(min + x) ?? 0)
  const xs: number[] = []
  const ys: number[] = []
  for (let x = 6; x < daily.length; x++) {
    let a = 0
    for (let k = x - 6; k <= x; k++) a += daily[k]
    xs.push(x)
    ys.push(Math.log(1 + Math.max(0, a / 7)))
  }
  const fit = ols(xs, ys)
  if (xs.length < 14 || daily.filter((v) => v > 0).length < 7 || fit.slope === null) return null
  return Math.exp(clamp(30 * fit.slope, Math.log(0.7), Math.log(1.3))) - 1
}

export function studioModel(ds: Dataset, f: Filters, s: Settings) {
  const attr = groupAttr(ds, f)
  // Period applies to tenant totals only.
  const allDates = ds.studioTenant.map((t) => t.date).sort()
  const latest = allDates[allDates.length - 1] ?? ''
  const start = f.studioPeriod === '7' && latest ? addDays(latest, -6) : (allDates[0] ?? '')
  const tenant = ds.studioTenant.filter((t) => t.date >= start && (!f.env || t.env === f.env))
  const tt = tenantTotals(tenant, s)
  const effective = div(tt.cost, tt.consumed)

  const dates = [...new Set(tenant.map((t) => t.date))].sort()
  const lo = dates[0] ?? ''
  const hi = dates[dates.length - 1] ?? ''
  const span = lo ? 1 + Math.round(dayNum(hi) - dayNum(lo)) : null
  const observed = dates.length
  const billingPeriod = lo ? `${dateLabel(lo)} - ${dateLabel(hi)}` : 'No tenant rows in this period'

  const daily = [...groupRows(tenant, (t) => t.date).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, rs]) => {
      const d = tenantTotals(rs, s)
      return { date, ...d }
    })

  // Environments
  const envs = [...groupRows(tenant, (t) => t.env).entries()].map(([env, rs]) => {
    const d = tenantTotals(rs, s)
    return { env, ent: entitled(rs), used: d.consumed, prepaid: d.prepaid, payg: d.payg, cost: d.cost }
  })
  envs.sort((a, b) => b.used - a.used)
  const withoutEnt = envs.filter((e) => e.ent === 0)
  const consumptionWithoutEnt = withoutEnt.reduce((a, e) => a + e.prepaid, 0)
  const envsWithoutEnt = withoutEnt.filter((e) => e.prepaid > 0).length
  const entitledEnvs = envs.filter((e) => e.ent > 0)
  const headroom = entitledEnvs.reduce((a, e) => a + (e.ent - e.prepaid), 0)
  const draw = div(
    entitledEnvs.reduce((a, e) => a + e.prepaid, 0),
    observed,
  )
  const daysRemaining = draw !== null && draw > 0 && headroom > 0 ? headroom / draw : null
  const envTotal = envs.reduce((a, e) => a + e.used, 0)
  const top = envs.find((e) => e.used > 0)
  const headline =
    !envTotal || !top
      ? 'No Studio consumption in this selection.'
      : `${pct0(top.used / envTotal)} of Studio credits come from ${top.env}.${top.ent > 0 ? '' : ' That environment holds no entitlement, so its usage bills directly.'}`

  // Agent snapshot: environment, agent and product.
  const agentRows: StudioAgentRow[] = ds.studioAgents.filter(
    (a) => (!f.env || a.env === f.env) && (!f.agent || a.agent === f.agent) && (!f.product || a.product === f.product),
  )
  const agentTotal = agentRows.reduce((a, r) => a + r.billed + r.nonBilled, 0)
  const agentBilled = agentRows.reduce((a, r) => a + r.billed, 0)

  // User snapshot: agent and Group By.
  const userRows: StudioUserRow[] = ds.studioUsers.filter(
    (u) => (!f.agent || u.agent === f.agent) && (!f.groupValue || groupOf(ds, u.email.toLowerCase(), attr) === f.groupValue),
  )
  const userTotal = userRows.reduce((a, r) => a + r.credits, 0)
  const users = new Set(userRows.map((u) => u.email.toLowerCase())).size
  const pairs = new Set(userRows.map((u) => `${u.email.toLowerCase()}|${u.agent}`)).size
  const perUser = [...groupRows(userRows, (u) => u.email.toLowerCase()).entries()].map(([email, rs]) => ({
    email,
    name: rs[0].name || email,
    group: groupOf(ds, email, attr),
    credits: rs.reduce((a, r) => a + r.credits, 0),
    billable: rs.reduce((a, r) => a + r.billable, 0),
  }))
  perUser.sort((a, b) => b.credits - a.credits)
  const k = Math.max(1, Math.round(users * 0.1))
  const top10 = users ? div(perUser.slice(0, k).reduce((a, u) => a + u.credits, 0), userTotal) : null
  const unlicensed = div(
    userRows.filter((u) => !u.licensed).reduce((a, r) => a + r.credits, 0),
    userTotal,
  )

  const agentNames = new Set([
    ...[...groupRows(agentRows, (a) => a.agent).entries()].filter(([, rs]) => rs.reduce((a, r) => a + r.billed + r.nonBilled, 0) > 0).map(([n]) => n),
    ...userRows.filter((u) => u.credits > 0).map((u) => u.agent),
  ])
  agentNames.delete('')

  // Per agent: one row for every agent known to either snapshot, so the action queue keeps unused agents.
  const names = new Set([...agentRows.map((a) => a.agent), ...userRows.map((u) => u.agent)].filter(Boolean))
  const agents = [...names].map((agent) => {
    const ar = agentRows.filter((a) => a.agent === agent)
    const ur = userRows.filter((u) => u.agent === agent)
    const billed = ar.reduce((a, r) => a + r.billed, 0)
    const nonBilled = ar.reduce((a, r) => a + r.nonBilled, 0)
    const c = billed + nonBilled
    const share = div(c, agentTotal)
    return {
      agent,
      billed,
      nonBilled,
      consumed: c,
      share,
      billedRatio: div(billed, c),
      absorbed: div(nonBilled, c),
      cost: billed * s.studioPayg,
      action: agentAction(c, billed, share),
      userCredits: ur.reduce((a, r) => a + r.credits, 0),
      userShare: div(
        ur.reduce((a, r) => a + r.credits, 0),
        userTotal,
      ),
      userBillable: ur.reduce((a, r) => a + r.billable, 0),
    }
  })
  agents.sort((a, b) => b.consumed - a.consumed || b.userCredits - a.userCredits)
  const visibleAgents = f.agentAction ? agents.filter((a) => a.action === f.agentAction) : agents
  const byAction = AGENT_ACTIONS.map((action) => {
    const as = agents.filter((a) => a.action === action)
    return { action, agents: as.length, credits: as.reduce((a, r) => a + r.consumed, 0) }
  })

  const byModel = [...groupRows(agentRows, (a) => a.model || '(Not set)').entries()]
    .map(([model, rs]) => ({ model, consumed: rs.reduce((a, r) => a + r.billed + r.nonBilled, 0), cost: rs.reduce((a, r) => a + r.billed, 0) * s.studioPayg }))
    .sort((a, b) => b.consumed - a.consumed)
  const byFeature = [...groupRows(agentRows, (a) => a.feature || '(Not set)').entries()]
    .map(([feature, rs]) => ({ feature, consumed: rs.reduce((a, r) => a + r.billed + r.nonBilled, 0), cost: rs.reduce((a, r) => a + r.billed, 0) * s.studioPayg }))
    .sort((a, b) => b.consumed - a.consumed)

  const byGroup = [...groupRows(perUser, (u) => u.group).entries()]
    .map(([group, us]) => {
      const credits = us.reduce((a, u) => a + u.credits, 0)
      return { group, users: us, credits, billable: us.reduce((a, u) => a + u.billable, 0), share: div(credits, userTotal) }
    })
    .sort((a, b) => b.credits - a.credits)

  // Forecast
  const runRate = div(tt.consumed, span)
  const fit = fittedGrowth(tenant, span ?? 0, observed)
  const scen = scenarioRate(f.growth || 'fitted')
  const growth = scen === null ? (fit ?? 0) : scen
  const coverage = div(observed, span)
  const confidence = !observed
    ? 'No data'
    : span === null || span < 14 || observed < 4
      ? 'Indicative only'
      : fit === null
        ? 'Low'
        : span >= 84 && (coverage ?? 0) >= 0.4
          ? 'High'
          : span >= 42 && (coverage ?? 0) >= 0.25
            ? 'Medium'
            : 'Low'
  const proj30 = runRate === null ? null : runRate * 30 * (1 + growth)
  const cost30 = proj30 === null ? null : proj30 * (effective ?? 0)
  const months = Array.from({ length: 12 }, (_, i) => {
    const credits = (runRate ?? 0) * 30 * (1 + growth) ** (i + 1)
    const flatCredits = (runRate ?? 0) * 30
    return { m: i + 1, month: hi ? eomonth(hi, i + 1) : '', credits, cost: credits * (effective ?? 0), flatCredits, flatCost: flatCredits * (effective ?? 0) }
  })
  const yearCredits = months.reduce((a, m) => a + m.credits, 0)
  const yearCost = months.reduce((a, m) => a + m.cost, 0)
  const flatYearCredits = (runRate ?? 0) * 30 * 12
  const flatYearCost = flatYearCredits * (effective ?? 0)

  const fitted = scen === null
  // Under 14 days the history is too short to project growth.
  const reliable = !fitted || (confidence !== 'No data' && confidence !== 'Indicative only')
  const basis = fitted
    ? fit === null
      ? ' A fit needs at least 28 calendar days and 7 days with positive consumption. This selection has insufficient usable history, so the daily average is projected flat.'
      : ` Fitted from ${int(span ?? 0)} calendar days of history (${int(observed)} recorded days). Missing dates are treated as zero usage. Fitted growth is capped between -30% and +30% a month.`
    : ' Growth is the scenario you chose, not the fitted rate.'
  const forecastNote =
    confidence === 'No data'
      ? 'No Studio data loaded.'
      : `${confidence === 'Indicative only' ? 'Only ' : ''}${int(span ?? 0)} calendar days of Studio history are in scope.${basis}`
  const growthBit = fitted
    ? fit === null
      ? ' There is insufficient usable history for a fit, so the forecast stays flat from the observed daily average.'
      : Math.abs(growth) < 0.001
        ? ' History fits essentially flat month on month.'
        : ` The history-based rate is ${pct(growth)} a month across ${int(span ?? 0)} calendar days, bounded to -30%/+30% for planning.`
    : ` Using your selected growth rate of ${pct(growth)} a month.`
  const forecastSummary = !runRate
    ? 'No Studio consumption in the current selection.'
    : `Studio is averaging about ${int(runRate)} credits a day across the selected history, which projects to ${usd(cost30 ?? 0)} over 30 days and ${usd(yearCost)} over twelve months.${growthBit}${
        daysRemaining === null ? '' : ` Prepaid capacity lasts about ${int(daysRemaining)} more days at this rate.`
      } Confidence is ${confidence.toLowerCase()}.`

  const notes = [
    'Date controls affect tenant totals only. User and agent detail is an undated export snapshot; costs are rate estimates, not an allocation of the selected-period PAYG bill.',
  ]
  if (!agentRows.length) notes.push('No matching agent-detail rows: model/feature breakdown is unavailable.')
  if (!userRows.length) notes.push('No matching user-detail rows.')

  return {
    attr,
    tenant: { ...tt, effective, paygShare: div(tt.payg, tt.consumed) },
    billingPeriod,
    daily,
    span,
    observed,
    envs,
    consumptionWithoutEnt,
    envsWithoutEnt,
    daysRemaining,
    headline,
    users,
    userTotal,
    userBillable: userRows.reduce((a, r) => a + r.billable, 0),
    avgPerUser: div(userTotal, users),
    avgAgents: div(pairs, users),
    agentsWithCredits: agentNames.size,
    agentsNoConsumption: [...groupRows(agentRows, (a) => a.agent).entries()].filter(([, rs]) => rs.reduce((a, r) => a + r.billed + r.nonBilled, 0) === 0).length,
    agentTotal,
    agentBilled,
    top10,
    concentration: top10 === null ? '' : `Top 10% of users: ${pct0(top10)} of credits`,
    unlicensed,
    perUser,
    byGroup,
    agents,
    visibleAgents,
    byAction,
    byModel,
    byFeature,
    forecast: {
      runRate,
      monthlyCost: (runRate ?? 0) * 30 * (effective ?? 0),
      fit,
      growth,
      fitted,
      reliable,
      confidence,
      coverage,
      proj30,
      cost30,
      months,
      yearCredits,
      yearCost,
      flatYearCredits,
      flatYearCost,
      note: forecastNote,
      summary: forecastSummary,
    },
    snapshotNote: notes.join(' '),
  }
}

export type StudioModel = ReturnType<typeof studioModel>
