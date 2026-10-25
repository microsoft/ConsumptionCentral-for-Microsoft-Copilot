import { useMemo } from 'react'
import { useData } from '../data/store'
import type { CoworkPerson } from '../data/types'
import { actionValue, billingBasis, coworkModel, forecastModel, optimisationModel, ratesInUse, SAVING_NOTE, weeklyCost, type CoworkModel } from '../metrics/cowork'
import { div } from '../metrics/stats'
import { BarList, GroupedBars, LineChart } from '../ui/charts'
import { DataTable, type Column } from '../ui/DataTable'
import { dateLabel, dayLabel, int, pct, pct0, signedPct, usd, usd2, usd4 } from '../ui/format'
import { Kpi, KpiRow, Note, NotSuppliedIf, Panel } from '../ui/primitives'
import { ACTION_COLOR, PAYG, PREPAID, PRODUCT_COLOR, SECONDARY } from '../ui/theme'
import { N } from './helpers'

const C = PRODUCT_COLOR.cowork

function useCowork() {
  const { ds, filters, settings } = useData()
  const m = useMemo(() => coworkModel(ds, filters, settings), [ds, filters, settings])
  return { ds, filters, settings, m }
}

interface Line {
  label: string
  users: number
  used: number
  allowance: number
  net: number
  cost?: { prepaid: number; payg: number; total: number }
}

const personUse = (m: CoworkModel, p: CoworkPerson) => Math.round(m.per.get(p.upn) ?? 0)

function RatesCard({ extra }: { extra?: string }) {
  const { settings } = useData()
  return (
    <Panel title="Rates" help="Change rates and the capacity pack balance from Rates in the header.">
      <p className="prose">{ratesInUse(settings)}</p>
      {extra && <p className="section-note">{extra}</p>}
    </Panel>
  )
}

export function CoworkConsumption() {
  const { m, settings } = useCowork()
  const rows = m.groups.map((g) => ({
    id: g.group,
    data: { label: g.group, users: g.users, used: N(g.used), allowance: g.allowance, net: 0 } as Line,
    children: g.people.map((p) => ({ id: p.upn, data: { label: p.name || p.upn, users: 1, used: personUse(m, p), allowance: p.limit, net: actionValue(p, settings) } })),
  }))
  return (
    <>
      <KpiRow>
        <Kpi tone="cowork" label="Total credits used" value={int(N(m.used))} sub="in the selected period" help="Credits consumed by the selected people in the period, rounded." />
        <Kpi label="Person allowance" value={int(m.allowance)} sub="sum of monthly credit limits" help="Sum of each person's monthly credit limit." />
        <Kpi label="Allowance used" value={pct(N(m.allowanceUsed))} help="Credits used divided by the person allowance." />
        <Kpi label="Consuming users" value={int(m.consuming)} sub={`of ${int(m.users)} on the roster`} help="People with any credits in the period." />
        <Kpi label="Weekly active users" value={int(m.activeAll)} sub="any credits in the weekly records" help="Distinct people with credits across the weekly records shown in the chart." />
        <Kpi tone="warn" label="Users over limit" value={pct(N(m.overPct))} help="Share of people whose period credits exceed their monthly limit." />
      </KpiRow>
      <div className="grid grid-1-2">
        <Panel title={`Credits by ${m.attr.toLowerCase()}`} note="Expand a group to see its people.">
          <DataTable
            label="Credits by group and person"
            childNoun="people"
            search={(r) => r.label}
            columns={[
              { key: 'label', label: m.attr, value: (r) => r.label },
              { key: 'users', label: 'Users', value: (r) => r.users, fmt: int, align: 'right' },
              { key: 'used', label: 'Credits', value: (r) => r.used, fmt: int, align: 'right', bar: C },
            ]}
            rows={rows}
            initialSort={{ key: 'used', desc: true }}
          />
        </Panel>
        <div className="stack">
          <Panel title="Credit consumption over time" note="Weekly credits. Hover for weekly active users and week-on-week change.">
            <LineChart
              label="Weekly credits"
              area
              xFmt={dayLabel}
              data={m.weekly.map((w) => ({ key: w.date, values: [w.credits, w.wau, N(w.wow)] }))}
              series={[
                { name: 'Credits', color: C, fmt: int },
                { name: 'Weekly active users', color: C, fmt: int, tipOnly: true },
                { name: 'Week on week', color: C, fmt: signedPct, tipOnly: true },
              ]}
            />
          </Panel>
          <Panel title={`Credits and allowance by ${m.attr.toLowerCase()}`}>
            <GroupedBars
              label="Credits used and allowance by group"
              data={m.groups.slice(0, 12).map((g) => ({ key: g.group, values: [N(g.used), g.allowance] }))}
              series={[
                { name: 'Credits used', color: C, fmt: int },
                { name: 'Person allowance', color: SECONDARY, fmt: int },
              ]}
            />
          </Panel>
        </div>
      </div>
    </>
  )
}

export function CoworkCost() {
  const { ds, filters, settings, m } = useCowork()
  const weekly = useMemo(() => weeklyCost(ds, filters, m.credits, settings), [ds, filters, m.credits, settings])
  const rows = m.groups.map((g) => ({
    id: g.group,
    data: { label: g.group, users: g.users, used: N(g.used), allowance: g.allowance, net: 0, cost: { prepaid: g.cost.prepaidCost, payg: g.cost.paygCost, total: g.cost.total } } as Line,
  }))
  return (
    <>
      <KpiRow>
        <Kpi tone="cowork" label="Total cost" value={usd(m.cost.total)} sub={billingBasis(m.used, settings)} help="Prepaid credits priced at the prepaid rate plus pay-as-you-go credits at the PAYG rate." />
        <Kpi label="Blended rate" value={usd4(N(m.cost.blended))} sub="per credit" help="Total cost divided by credits used." />
        <Kpi label="Credits used" value={int(N(m.used))} />
        <NotSuppliedIf when={!ds.policies.length}>
          <Kpi label="Policy allowance" value={int(m.policyAllowance)} sub="sum of spending-policy limits" help="Sum of the plan limits on the selected spending policies." />
          <Kpi label="Policy allowance used" value={pct(N(m.policyUsed))} />
          <Kpi tone={m.headroom < 0 ? 'warn' : 'neutral'} label="Policy headroom" value={int(m.headroom)} sub="credits left under policy" />
        </NotSuppliedIf>
      </KpiRow>
      <div className="grid grid-2">
        <Panel title={`Cost by ${m.attr.toLowerCase()}`}>
          <DataTable
            label="Cost by group"
            search={(r) => r.label}
            columns={[
              { key: 'label', label: m.attr, value: (r) => r.label },
              { key: 'used', label: 'Credits', value: (r) => r.used, fmt: int, align: 'right' },
              { key: 'prepaid', label: 'Prepaid', value: (r) => r.cost?.prepaid ?? NaN, fmt: usd, align: 'right' },
              { key: 'payg', label: 'PAYG', value: (r) => r.cost?.payg ?? NaN, fmt: usd, align: 'right' },
              { key: 'total', label: 'Total cost', value: (r) => r.cost?.total ?? NaN, fmt: usd, align: 'right', bar: C },
            ]}
            rows={rows}
            initialSort={{ key: 'total', desc: true }}
          />
        </Panel>
        <div className="stack">
          <Panel title="Cost over time" note="Prepaid credits draw down the pack balance first, oldest week first.">
            <LineChart
              label="Weekly cost"
              xFmt={dayLabel}
              data={weekly.map((w) => ({ key: w.date, values: [w.prepaidCost, w.paygCost, w.wau, N(w.wow)] }))}
              series={[
                { name: 'Prepaid cost', color: PREPAID, fmt: usd },
                { name: 'PAYG cost', color: PAYG, fmt: usd },
                { name: 'Weekly active users', color: SECONDARY, fmt: int, tipOnly: true },
                { name: 'Week on week', color: SECONDARY, fmt: signedPct, tipOnly: true },
              ]}
            />
          </Panel>
          <Panel title={`Cost and allowance used by ${m.attr.toLowerCase()}`} note="Bar is total cost; the figure on the left is the share of person allowance used.">
            <BarList
              label="Cost by group"
              color={C}
              fmt={usd}
              items={m.groups.map((g) => ({ key: g.group, label: g.group, value: g.cost.total, hint: `${pct0(N(div(g.used, g.allowance)))} of allowance used · ${int(N(g.used))} credits · ${int(g.consuming)} consuming users` }))}
            />
          </Panel>
        </div>
      </div>
      <div className="grid grid-2">
        <RatesCard />
        <Panel title="Billing basis">
          <p className="prose">{billingBasis(m.used, settings)}</p>
          <p className="section-note">
            Capacity pack balance {int(settings.pack)} credits. Change it in the filters above or under Rates.
          </p>
        </Panel>
      </div>
    </>
  )
}

export function CoworkOptimization() {
  const { m, settings } = useCowork()
  const o = useMemo(() => optimisationModel(m, settings), [m, settings])
  const actionIdx = (a: string) => Math.max(0, Number(a.charAt(0)) - 1)
  const queue = m.groups.map((g) => {
    const people = g.people.map((p) => ({ id: p.upn, data: { label: p.name || p.upn, users: 1, used: personUse(m, p), allowance: p.limit, net: actionValue(p, settings), action: p.action } }))
    return {
      id: g.group,
      data: { label: g.group, users: g.users, used: N(g.used), allowance: g.allowance, net: people.reduce((a, p) => a + p.data.net, 0), action: '' },
      children: people,
    }
  })
  const queueCols: Column<Line & { action: string }>[] = [
    { key: 'label', label: `${m.attr} / person`, value: (r) => r.label },
    { key: 'action', label: 'Action', value: (r) => r.action },
    { key: 'used', label: 'Credits', value: (r) => r.used, fmt: int, align: 'right' },
    { key: 'allowance', label: 'Allowance', value: (r) => r.allowance, fmt: int, align: 'right' },
    { key: 'pct', label: 'Used', value: (r) => N(div(r.used, r.allowance)), fmt: pct0, align: 'right' },
    { key: 'net', label: 'Net $/mo', value: (r) => r.net, fmt: usd2, align: 'right' },
  ]
  return (
    <>
      <KpiRow>
        <Kpi tone="cowork" label="Right-size net" value={usd2(o.net)} sub="a month, if every action is taken" help="Savings from reclaiming and downsizing, less the cost of upgrades, at the PAYG rate." />
        <Kpi label="Reclaimable" value={usd2(o.reclaim)} sub="a month" help="Unused allowance above each person's recommended limit, at the PAYG rate." />
        <Kpi label="Dormant seats" value={usd2(o.dormant)} sub="a month" help="Allowance held by people who used no credits." />
        <Kpi label="Seats to upgrade" value={int(o.upgrade)} help="People over their limit in at least 60% of active weeks." />
        <Kpi label="Seats to downsize" value={int(o.downsize)} help="Active people whose recommended limit is below their current limit." />
        <Kpi tone="warn" label="Licensed but inactive" value={int(o.inactive)} help="Licensed people with no credits used." />
      </KpiRow>
      <div className="grid grid-1-2">
        <Panel title="Seats by recommended action">
          <BarList
            label="Seats by action"
            color={C}
            keepOrder
            items={o.byAction.map((a) => ({ key: a.action, label: a.action, value: a.users, hint: `${usd2(a.net)} net a month`, color: ACTION_COLOR[actionIdx(a.action)] }))}
          />
        </Panel>
        <Panel title="Financial impact by action">
          <DataTable
            label="Financial impact by action"
            columns={[
              { key: 'action', label: 'Action', value: (r) => r.action, width: '36%' },
              { key: 'users', label: 'Users', value: (r) => r.users, fmt: int, align: 'right' },
              { key: 'allowance', label: 'Allowance', value: (r) => r.allowance, fmt: int, align: 'right' },
              { key: 'used', label: 'Credits', value: (r) => r.used, fmt: int, align: 'right' },
              { key: 'net', label: 'Net $/mo', value: (r) => r.net, fmt: usd2, align: 'right' },
            ]}
            rows={o.byAction.map((a) => ({ id: a.action, data: a }))}
            initialSort={{ key: 'action' }}
          />
        </Panel>
      </div>
      <Panel title="Action queue" note="Expand a group to see who to act on first.">
        <DataTable label="Action queue" childNoun="people" search={(r) => r.label} columns={queueCols} rows={queue} initialSort={{ key: 'net', desc: true }} />
      </Panel>
      <div className="grid grid-2">
        <RatesCard />
        <Panel title="How savings are priced">
          <p className="prose">{SAVING_NOTE}</p>
        </Panel>
      </div>
    </>
  )
}

export function CoworkForecast() {
  const { ds, filters, m } = useCowork()
  const fc = useMemo(() => forecastModel(ds, filters, m), [ds, filters, m])
  const last = ds.coworkMax
  return (
    <>
      <KpiRow>
        <Kpi tone="cowork" label="Growth applied" value={signedPct(fc.growth)} sub={`a month · confidence ${fc.trend.confidence.toLowerCase()}`} help="Fitted monthly growth from the weekly trend, capped at 100%, unless you pick a growth assumption." />
        <Kpi label="Next 12 months credits" value={int(fc.yearCredits)} />
        <Kpi label="Next 12 months cost" value={usd(fc.yearCost)} sub="at today's blended rate" />
      </KpiRow>
      <div className="grid grid-2">
        <Panel title="Where the growth is">
          <DataTable
            label="Growth by group"
            search={(r) => r.group}
            columns={[
              { key: 'group', label: m.attr, value: (r) => r.group },
              { key: 'used', label: 'Credits', value: (r) => N(r.used), fmt: int, align: 'right' },
              { key: 'growth', label: 'Growth / mo', value: (r) => r.growth, fmt: signedPct, align: 'right' },
              { key: 'yearCost', label: 'Year cost', value: (r) => r.yearCost, fmt: usd, align: 'right', bar: C },
            ]}
            rows={fc.groups.map((g) => ({ id: g.group, data: g }))}
            initialSort={{ key: 'yearCost', desc: true }}
          />
        </Panel>
        <Panel title="Projected monthly cost, next 12 months" note={last ? `Months after ${dateLabel(last)}.` : undefined}>
          <LineChart
            label="Projected monthly cost"
            area
            xFmt={(k) => `M${k}`}
            data={fc.months.map((x) => ({ key: String(x.m), values: [x.cost, x.credits] }))}
            series={[
              { name: 'Cost', color: C, fmt: usd },
              { name: 'Credits', color: C, fmt: int, tipOnly: true },
            ]}
          />
        </Panel>
      </div>
      <div className="grid grid-2">
        <RatesCard />
        <Panel title="Forecast summary">
          <Note>{fc.summary}</Note>
        </Panel>
      </div>
    </>
  )
}
