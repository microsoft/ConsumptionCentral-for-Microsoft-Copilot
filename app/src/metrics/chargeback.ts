import type { CoworkPerson, Dataset, Policy } from '../data/types'
import type { Filters, Settings } from '../data/store'
import { selectPeople, windowUse } from './cowork'
import { div, groupRows } from './stats'

export const NOT_ASSIGNED = '(Not assigned)'
export const MULTIPLE = '(Multiple)'

export type ChargeTo = 'costCentre' | 'department'

export interface ChargeLine {
  key: string
  costCentre: string
  department: string
  billingOwner: string
  chargeCode: string
  users: number
  consuming: number
  credits: number
  prepaidCredits: number
  prepaidCost: number
  paygCredits: number
  paygCost: number
  total: number
  share: number | null
}

export interface ChargeRow extends ChargeLine {
  /** One line per spending policy charged to this cost centre or department. */
  policies: ChargeLine[]
}

const label = (v: string) => v || NOT_ASSIGNED
const one = (vals: string[]) => {
  const set = new Set(vals.map(label))
  return set.size === 1 ? [...set][0] : MULTIPLE
}

/** True when the policy file carries at least one of the optional billing columns. */
export const hasBillingColumns = (ds: Dataset) => ds.policies.some((p) => p.costCentre || p.department || p.billingOwner || p.chargeCode)

/**
 * The tenant's prepaid share for the period: prepaid credits used divided by all credits used,
 * over every person on the roster (policy, cohort and Group By filters ignored) for the selected
 * period and service. Each cost centre is charged that share of its credits at the prepaid rate and
 * the rest at the pay-as-you-go rate, so the charges add up to the tenant's Cowork total cost.
 */
export function prepaidShare(ds: Dataset, f: Filters, s: Settings) {
  const used = windowUse(ds, f, ds.people).used ?? 0
  const prepaid = Math.min(used, s.pack)
  return { tenantUsed: used, tenantPrepaid: prepaid, share: used > 0 ? prepaid / used : 0 }
}

export function chargebackModel(ds: Dataset, f: Filters, s: Settings, by: ChargeTo) {
  const { share, tenantUsed, tenantPrepaid } = prepaidShare(ds, f, s)
  const people = selectPeople(ds, f)
  const w = windowUse(ds, f, people)
  const pol = new Map(ds.policies.map((p) => [p.id, p]))
  const policyOf = (p: CoworkPerson): Policy | undefined => pol.get(p.policyId)

  const line = (key: string, ps: CoworkPerson[], policies: (Policy | undefined)[]): ChargeLine => {
    const credits = ps.reduce((a, p) => a + (w.per.get(p.upn) ?? 0), 0)
    const prepaidCredits = credits * share
    const paygCredits = credits - prepaidCredits
    const prepaidCost = prepaidCredits * s.coworkPrepaid
    const paygCost = paygCredits * s.coworkPayg
    return {
      key,
      costCentre: one(policies.map((p) => p?.costCentre ?? '')),
      department: one(policies.map((p) => p?.department ?? '')),
      billingOwner: one(policies.map((p) => p?.billingOwner ?? '')),
      chargeCode: one(policies.map((p) => p?.chargeCode ?? '')),
      users: ps.length,
      consuming: ps.filter((p) => (w.per.get(p.upn) ?? 0) > 0).length,
      credits,
      prepaidCredits,
      prepaidCost,
      paygCredits,
      paygCost,
      total: prepaidCost + paygCost,
      share: null,
    }
  }

  const keyOf = (p: CoworkPerson) => label((by === 'costCentre' ? policyOf(p)?.costCentre : policyOf(p)?.department) ?? '')
  const rows: ChargeRow[] = [...groupRows(people, keyOf).entries()].map(([key, ps]) => {
    const policies = [...groupRows(ps, (p) => p.policyId).entries()].map(([id, pp]) => {
      const p = pol.get(id)
      return line(p?.name || (id ? id : '(No policy)'), pp, [p])
    })
    return { ...line(key, ps, ps.map(policyOf)), policies }
  })

  const total = rows.reduce((a, r) => a + r.total, 0)
  for (const r of rows) {
    r.share = div(r.total, total)
    for (const c of r.policies) c.share = div(c.total, total)
  }
  rows.sort((a, b) => b.total - a.total)
  const unassigned = rows.find((r) => r.key === NOT_ASSIGNED)

  return {
    by,
    rows,
    share,
    tenantUsed,
    tenantPrepaid,
    credits: rows.reduce((a, r) => a + r.credits, 0),
    prepaidCost: rows.reduce((a, r) => a + r.prepaidCost, 0),
    paygCost: rows.reduce((a, r) => a + r.paygCost, 0),
    total,
    unassignedShare: div(unassigned?.total ?? 0, total),
    assigned: rows.filter((r) => r.key !== NOT_ASSIGNED && r.credits > 0).length,
    hasColumns: hasBillingColumns(ds),
  }
}

export type ChargebackModel = ReturnType<typeof chargebackModel>

const CSV_COLUMNS: [string, (r: ChargeLine) => string | number][] = [
  ['Cost centre', (r) => r.costCentre],
  ['Department', (r) => r.department],
  ['Billing owner', (r) => r.billingOwner],
  ['Charge code', (r) => r.chargeCode],
  ['Users', (r) => r.users],
  ['Credits', (r) => r.credits.toFixed(2)],
  ['Prepaid credits', (r) => r.prepaidCredits.toFixed(2)],
  ['Prepaid cost', (r) => r.prepaidCost.toFixed(2)],
  ['PAYG credits', (r) => r.paygCredits.toFixed(2)],
  ['PAYG cost', (r) => r.paygCost.toFixed(2)],
  ['Total cost', (r) => r.total.toFixed(2)],
  ['Share of total', (r) => (r.share ?? 0).toFixed(4)],
]

const cell = (v: string | number) => {
  const t = String(v)
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
}

/** The chargeback table as CSV: one line per cost centre (or department) and spending policy. */
export function chargebackCsv(m: ChargebackModel): string {
  const head = ['Charged to', 'Spending policy', ...CSV_COLUMNS.map(([h]) => h)]
  const lines = [head.map(cell).join(',')]
  for (const r of m.rows) for (const p of r.policies) lines.push([r.key, p.key, ...CSV_COLUMNS.map(([, v]) => v(p))].map(cell).join(','))
  return lines.join('\r\n') + '\r\n'
}
