import type { Dataset } from '../data/types'
import type { Filters, Settings } from '../data/store'
import { dateLabel, int, pct0 } from '../ui/format'
import { div } from './stats'

export const REPORTING_CAVEAT =
  'One date window applies to all dated sources on this page. Cowork uses whole weekly records dated within the window, not daily proration. Studio user/agent snapshots cannot be date-aligned and are excluded. Credits are product-specific units; cost bases differ, so no misleading grand total is shown.'

export const PRODUCTS = ['Cowork / Work IQ', 'Copilot Studio', 'GitHub Copilot', 'Azure AI Foundry'] as const
export type Product = (typeof PRODUCTS)[number]

const COST_BASIS: Record<Product, string> = {
  'Cowork / Work IQ': 'PAYG reference value; before prepaid capacity',
  'Copilot Studio': 'Tenant quantities x configured prepaid/PAYG rates',
  'GitHub Copilot': 'Export net usage amount; excludes seat subscriptions',
  'Azure AI Foundry': 'Azure export cost in billing currency',
}

export interface ProductRow {
  product: Product
  credits: number | null
  cost: number | null
  basis: string
  coverage: string
  rows: number
}

function coverage(dates: string[], inWindow: number, lo: string, hi: string): string {
  if (!dates.length) return 'No source loaded'
  let min = dates[0]
  let max = dates[0]
  for (const d of dates) {
    if (d < min) min = d
    if (d > max) max = d
  }
  const state = inWindow === 0 ? 'No rows in selected dates; not confirmed zero' : min > lo || max < hi ? 'Partial date coverage' : 'Date span covered'
  return `${state} | source ${min} to ${max}`
}

export function combinedModel(ds: Dataset, f: Filters, s: Settings) {
  const lo = f.from && f.from >= ds.minDate ? f.from : ds.minDate
  const hi = f.to && f.to <= ds.maxDate ? f.to : ds.maxDate
  const inW = (d: string) => d >= lo && d <= hi

  const cw = ds.credits.filter((c) => inW(c.date))
  const st = ds.studioTenant.filter((t) => inW(t.date))
  const gh = ds.ghUsage.filter((r) => inW(r.date))
  const foundryAll = ds.azureDaily.filter((r) => r.service === 'Foundry Models')
  const fd = foundryAll.filter((r) => inW(r.date))

  const cwCredits = cw.reduce((a, c) => a + c.credits, 0)
  const stPrepaid = st.reduce((a, t) => a + t.prepaid, 0)
  const stPayg = st.reduce((a, t) => a + t.payg, 0)
  const rows: ProductRow[] = [
    {
      product: 'Cowork / Work IQ',
      credits: ds.credits.length ? cwCredits : null,
      cost: ds.credits.length ? cwCredits * s.coworkPayg : null,
      rows: cw.length,
      basis: COST_BASIS['Cowork / Work IQ'],
      coverage: coverage(
        ds.credits.map((c) => c.date),
        cw.length,
        lo,
        hi,
      ),
    },
    {
      product: 'Copilot Studio',
      credits: ds.studioTenant.length ? stPrepaid + stPayg : null,
      cost: ds.studioTenant.length ? stPrepaid * s.studioPrepaid + stPayg * s.studioPayg : null,
      rows: st.length,
      basis: COST_BASIS['Copilot Studio'],
      coverage: coverage(
        ds.studioTenant.map((t) => t.date),
        st.length,
        lo,
        hi,
      ),
    },
    {
      product: 'GitHub Copilot',
      credits: ds.ghUsage.length ? gh.reduce((a, r) => a + r.credits, 0) : null,
      cost: ds.ghUsage.length ? gh.reduce((a, r) => a + r.net, 0) : null,
      rows: gh.length,
      basis: COST_BASIS['GitHub Copilot'],
      coverage: coverage(
        ds.ghUsage.map((r) => r.date),
        gh.length,
        lo,
        hi,
      ),
    },
    {
      product: 'Azure AI Foundry',
      credits: null,
      cost: foundryAll.length ? fd.reduce((a, r) => a + r.cost, 0) : null,
      rows: fd.length,
      basis: COST_BASIS['Azure AI Foundry'],
      coverage: coverage(
        foundryAll.map((r) => r.date),
        fd.length,
        lo,
        hi,
      ),
    },
  ]

  // Studio attribution gap (the report's hidden Combined Caveat), shown here because it is useful.
  const tenant = ds.studioTenant.reduce((a, t) => a + t.prepaid + t.payg, 0)
  const attributed = ds.studioUsers.reduce((a, u) => a + u.credits, 0)
  const gap = tenant - attributed
  const studioCaveat = !tenant
    ? 'No Copilot Studio data loaded, so these figures cover the other products only.'
    : gap > 0
      ? `Studio counts only credits attributed to a named user. Its agent and environment exports carry no person, so about ${int(gap)} credits (${pct0(div(gap, tenant) ?? 0)} of Studio usage) sit outside the per-person and per-department views.`
      : 'Studio counts only credits attributed to a named user. All Studio credits in this export carry a person, so nothing is missing here.'

  const cwWeeks = new Set(ds.credits.map((c) => c.date)).size
  const ghMonths = new Set(ds.ghUsage.map((r) => r.date.slice(0, 7))).size
  const stDays = new Set(ds.studioTenant.map((t) => t.date)).size
  const parts = [cwWeeks && `Cowork ${int(cwWeeks)} weeks`, ghMonths && `GitHub ${int(ghMonths)} months`, stDays && `Studio ${int(stDays)} days`].filter(Boolean)

  return {
    lo,
    hi,
    window: lo ? `${dateLabel(lo)} - ${dateLabel(hi)}` : '',
    rows,
    studioCaveat,
    sourceWindows: parts.length ? parts.join('   |   ') : 'No consumption data loaded.',
  }
}
