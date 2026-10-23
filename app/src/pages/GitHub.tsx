import { useMemo } from 'react'
import { useData } from '../data/store'
import { ghModel, type GhModel } from '../metrics/ghcp'
import { BarList, LineChart } from '../ui/charts'
import { DataTable } from '../ui/DataTable'
import { dateLabel, dayLabel, dec1, int, monthLabel, pct, signedPct, usd, usd2 } from '../ui/format'
import { Kpi, KpiRow, Note, Panel } from '../ui/primitives'
import { PAYG, PREPAID, PRODUCT_COLOR } from '../ui/theme'
import { N } from './helpers'

const C = PRODUCT_COLOR.github
const TIER_COLOR: Record<string, string> = { '1. Lightweight': '#94a3b8', '2. Versatile': '#2563eb', '3. Powerful': '#1f2937' }

function useGh() {
  const { ds, filters, settings } = useData()
  const m = useMemo(() => ghModel(ds, filters, settings), [ds, filters, settings])
  return { m, settings }
}

function PeriodKpi({ m }: { m: GhModel }) {
  return <Kpi label="Billing period" value={m.billingPeriod} wide />
}

interface DevLine {
  label: string
  credits: number
  devs: number
  perDev: number
  powerful: number
  gross: number
  latest: number
}

function devRows(m: GhModel) {
  return m.byGroup.map((g) => ({
    id: g.group,
    data: { label: g.group, credits: g.credits, devs: g.devs, perDev: N(g.perDev), powerful: N(g.powerful), gross: g.gross, latest: g.latest } as DevLine,
    children: m.developers
      .filter((d) => d.group === g.group)
      .map((d) => ({ id: d.username, data: { label: d.name, credits: d.credits, devs: 1, perDev: d.credits, powerful: N(d.powerful), gross: d.gross, latest: d.latest } })),
  }))
}

export function GitHubConsumption() {
  const { m } = useGh()
  return (
    <>
      <KpiRow>
        <Kpi tone="github" label="Credits used" value={int(m.credits)} help="Billed GitHub Copilot AI credits in the period." />
        <Kpi label="Active developers" value={int(m.devs)} />
        <Kpi label="Credits per developer" value={dec1(N(m.perDev))} />
        <Kpi label="Coding agent share" value={pct(N(m.coding))} sub="of credits" />
        <Kpi label="Powerful model share" value={pct(N(m.powerful))} sub="of credits" />
        <PeriodKpi m={m} />
      </KpiRow>
      <div className="grid grid-2-1">
        <Panel title="Credit consumption over time">
          <LineChart label="Daily GitHub Copilot credits" area xFmt={dayLabel} data={m.daily.map((d) => ({ key: d.date, values: [d.credits] }))} series={[{ name: 'Credits', color: C, fmt: int }]} />
        </Panel>
        <Panel title={`Consumption by ${m.attr.toLowerCase()}`}>
          <DataTable
            label="Consumption by group"
            search={(r) => r.group}
            columns={[
              { key: 'group', label: m.attr, value: (r) => r.group },
              { key: 'devs', label: 'Developers', value: (r) => r.devs, fmt: int, align: 'right' },
              { key: 'credits', label: 'Credits', value: (r) => r.credits, fmt: int, align: 'right', bar: C },
              { key: 'perDev', label: 'Per dev', value: (r) => N(r.perDev), fmt: dec1, align: 'right' },
            ]}
            rows={m.byGroup.map((g) => ({ id: g.group, data: g }))}
            initialSort={{ key: 'credits', desc: true }}
            pageSize={8}
          />
        </Panel>
      </div>
      <div className="grid grid-2-1">
        <Panel title="Credits by model">
          <BarList label="Credits by model" color={C} items={m.byModel.map((x) => ({ key: x.model, label: x.model, value: x.credits, hint: x.tier, color: TIER_COLOR[x.tier] }))} />
        </Panel>
        <Panel title="Heaviest developers">
          <BarList label="Heaviest developers" color={C} items={m.developers.map((d) => ({ key: d.username, label: d.name, value: d.credits }))} />
        </Panel>
      </div>
      <div className="grid grid-2">
        <Panel title="Basis">
          <p className="prose">{m.basisNote}</p>
        </Panel>
        <Panel title="Concentration">
          <p className="prose">{m.concentration}</p>
        </Panel>
      </div>
    </>
  )
}

export function GitHubCost() {
  const { m } = useGh()
  return (
    <>
      <KpiRow>
        <Kpi tone="github" label="Seat cost" value={usd(m.seatCost)} sub="a month" />
        <Kpi label="Overage cost" value={usd2(m.net)} sub="pay-as-you-go credits" help="Credit value beyond the included allowance." />
        <Kpi label="Allowance absorbed" value={usd2(m.absorbed)} help="Credit value covered by the included monthly allowance." />
        <Kpi label="Gross value" value={usd2(m.gross)} sub="before allowance" />
        <Kpi label="Cost per developer" value={usd2(N(m.costPerDev))} sub="seats plus overage, per licensed seat" />
        <PeriodKpi m={m} />
      </KpiRow>
      <Note title="Headline">{m.costHeadline}</Note>
      <div className="grid grid-2">
        <Panel title={`Cost by ${m.attr.toLowerCase()}`}>
          <DataTable
            label="Cost by group"
            search={(r) => r.group}
            columns={[
              { key: 'group', label: m.attr, value: (r) => r.group },
              { key: 'credits', label: 'Credits', value: (r) => r.credits, fmt: int, align: 'right' },
              { key: 'gross', label: 'Gross value', value: (r) => r.gross, fmt: usd2, align: 'right', bar: C },
              { key: 'net', label: 'Overage', value: (r) => r.net, fmt: usd2, align: 'right' },
            ]}
            rows={m.byGroup.map((g) => ({ id: g.group, data: g }))}
            initialSort={{ key: 'gross', desc: true }}
            pageSize={8}
          />
        </Panel>
        <Panel title="Cost over time">
          <LineChart
            label="Daily GitHub Copilot cost"
            xFmt={dayLabel}
            data={m.daily.map((d) => ({ key: d.date, values: [d.absorbed, d.net] }))}
            series={[
              { name: 'Allowance absorbed', color: PREPAID, fmt: usd2 },
              { name: 'Overage cost', color: PAYG, fmt: usd2 },
            ]}
          />
        </Panel>
      </div>
      <div className="grid grid-2">
        <Panel title="Cost by model">
          <DataTable
            label="Cost by model"
            search={(r) => r.model}
            columns={[
              { key: 'model', label: 'Model', value: (r) => r.model },
              { key: 'credits', label: 'Credits', value: (r) => r.credits, fmt: int, align: 'right' },
              { key: 'gross', label: 'Gross value', value: (r) => r.gross, fmt: usd2, align: 'right', bar: C },
            ]}
            rows={m.byModel.map((x) => ({ id: x.model, data: x }))}
            initialSort={{ key: 'gross', desc: true }}
            pageSize={8}
          />
        </Panel>
        <Panel title="Chat versus coding agent">
          <DataTable
            label="Chat versus coding agent"
            columns={[
              { key: 'type', label: 'Usage type', value: (r) => r.type },
              { key: 'credits', label: 'Credits', value: (r) => r.credits, fmt: int, align: 'right' },
              { key: 'gross', label: 'Gross value', value: (r) => r.gross, fmt: usd2, align: 'right', bar: C },
            ]}
            rows={m.byType.map((x) => ({ id: x.type, data: x }))}
            initialSort={{ key: 'gross', desc: true }}
          />
        </Panel>
      </div>
    </>
  )
}

export function GitHubOptimization() {
  const { m } = useGh()
  return (
    <>
      <KpiRow>
        <Kpi tone="github" label="Seats with no credit use" value={int(m.idleSeats)} sub={`of ${int(m.licensed)} licensed`} />
        <Kpi tone="warn" label="Their seat cost" value={usd(m.idleSeatCost)} sub="a month, at list price" />
        <Kpi label="Top 10% share" value={pct(N(m.top10))} sub="of credits" />
        <Kpi label="Powerful model share" value={pct(N(m.powerful))} sub="of credits" />
        <Kpi label="Pool used" value={pct(N(m.poolUsed))} sub={`latest month vs ${int(m.pool)} included`} />
        <PeriodKpi m={m} />
      </KpiRow>
      <div className="grid grid-2">
        <Panel title="Developers by consumption" note="Expand a group to see its developers.">
          <DataTable
            label="Developers by consumption"
            minWidth={580}
            childNoun="developers"
            search={(r) => r.label}
            columns={[
              { key: 'label', label: `${m.attr} / developer`, value: (r) => r.label, width: '32%' },
              { key: 'credits', label: 'Credits', value: (r) => r.credits, fmt: int, align: 'right', bar: C },
              { key: 'powerful', label: 'Powerful', value: (r) => r.powerful, fmt: pct, align: 'right' },
              { key: 'gross', label: 'Gross value', value: (r) => r.gross, fmt: usd2, align: 'right' },
            ]}
            rows={devRows(m)}
            initialSort={{ key: 'credits', desc: true }}
            pageSize={8}
          />
        </Panel>
        <Panel title="Where credits go by model tier" note="Bars are coloured by tier: grey lightweight, blue versatile, dark powerful.">
          <BarList label="Credits by model and tier" color={C} items={m.byModel.map((x) => ({ key: x.model, label: x.model, value: x.credits, hint: x.tier, color: TIER_COLOR[x.tier] }))} />
        </Panel>
      </div>
      <div className="grid grid-2">
        <Panel title="By GitHub cost centre">
          <DataTable
            label="By GitHub cost centre"
            search={(r) => r.cc}
            columns={[
              { key: 'cc', label: 'Cost centre', value: (r) => r.cc },
              { key: 'credits', label: 'Credits', value: (r) => r.credits, fmt: int, align: 'right', bar: C },
              { key: 'devs', label: 'Developers', value: (r) => r.devs, fmt: int, align: 'right' },
              { key: 'perDev', label: 'Per dev', value: (r) => N(r.perDev), fmt: dec1, align: 'right' },
            ]}
            rows={m.byCostCenter.map((x) => ({ id: x.cc, data: x }))}
            initialSort={{ key: 'credits', desc: true }}
          />
        </Panel>
        <Panel title="Seats by plan">
          <DataTable
            label="Seats by plan"
            columns={[
              { key: 'plan', label: 'Plan', value: (r) => r.plan },
              { key: 'seats', label: 'Seats', value: (r) => r.seats, fmt: int, align: 'right' },
              { key: 'active', label: 'Active', value: (r) => r.active, fmt: int, align: 'right' },
              { key: 'pool', label: 'Monthly pool', value: (r) => r.pool, fmt: int, align: 'right' },
              { key: 'seatCost', label: 'Seat cost', value: (r) => r.seatCost, fmt: usd, align: 'right', bar: C },
            ]}
            rows={m.byPlan.map((x) => ({ id: x.plan, data: x }))}
            initialSort={{ key: 'seatCost', desc: true }}
          />
        </Panel>
      </div>
      <div className="grid grid-2">
        <Panel title="Cost headline">
          <p className="prose">{m.costHeadline}</p>
        </Panel>
        <Panel title="Concentration">
          <p className="prose">{m.concentration}</p>
        </Panel>
      </div>
    </>
  )
}

export function GitHubForecast() {
  const { m, settings } = useGh()
  const fc = m.forecast
  const change = dateLabel(settings.changeDate)
  return (
    <>
      <KpiRow>
        <Kpi tone="github" label="Growth applied" value={signedPct(fc.growth)} sub={`a month · confidence ${fc.confidence.toLowerCase()}`} />
        <Kpi label="Next 12 months credits" value={int(fc.yearCredits)} />
        <Kpi label="Next 12 months cost" value={usd(fc.yearCost)} sub="seats plus overage" />
        <Kpi label="Monthly pool" value={int(m.pool)} sub="included credits today" />
        <Kpi label="Pool from change date" value={int(m.poolNext)} sub={`from ${change}`} />
        <PeriodKpi m={m} />
      </KpiRow>
      <div className="grid grid-2">
        <div className="stack">
          <Panel title="Latest month by group" note={m.lastDay ? `Latest month is ${monthLabel(m.lastDay)}.` : undefined}>
            <DataTable
              label="Latest month by group"
              minWidth={540}
              childNoun="developers"
              search={(r) => r.label}
              columns={[
                { key: 'label', label: `${m.attr} / developer`, value: (r) => r.label, width: '32%' },
                { key: 'latest', label: 'Latest month', value: (r) => r.latest, fmt: int, align: 'right', bar: C },
                { key: 'credits', label: 'Period credits', value: (r) => r.credits, fmt: int, align: 'right' },
              ]}
              rows={devRows(m)}
              initialSort={{ key: 'latest', desc: true }}
              pageSize={8}
            />
          </Panel>
          <Panel title="Pool by plan">
            <DataTable
              label="Pool by plan"
              columns={[
                { key: 'plan', label: 'Plan', value: (r) => r.plan },
                { key: 'active', label: 'Active', value: (r) => r.active, fmt: int, align: 'right' },
                { key: 'pool', label: 'Pool today', value: (r) => r.pool, fmt: int, align: 'right' },
                { key: 'poolNext', label: `From ${change}`, value: (r) => r.poolNext, fmt: int, align: 'right' },
              ]}
              rows={m.byPlan.map((x) => ({ id: x.plan, data: x }))}
              initialSort={{ key: 'pool', desc: true }}
            />
          </Panel>
        </div>
        <div className="stack">
          <Panel title="Projected monthly cost, next 12 months" note="Hover for projected credits and the included pool each month.">
            <LineChart
              label="Projected monthly GitHub Copilot cost"
              area
              height={260}
              xFmt={(k) => monthLabel(fc.months[Number(k) - 1]?.month ?? '') || `M${k}`}
              data={fc.months.map((x) => ({ key: String(x.m), values: [x.cost, x.credits, x.pool] }))}
              series={[
                { name: 'Cost', color: C, fmt: usd },
                { name: 'Credits', color: C, fmt: int, tipOnly: true },
                { name: 'Included pool', color: PREPAID, fmt: int, tipOnly: true },
              ]}
            />
          </Panel>
          <Panel title="Forecast summary">
            <p className="prose">{fc.summary}</p>
            <p className="section-note">{m.costHeadline}</p>
          </Panel>
        </div>
      </div>
    </>
  )
}
