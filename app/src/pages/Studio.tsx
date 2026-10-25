import { useMemo } from 'react'
import { useData } from '../data/store'
import { ratesInUse } from '../metrics/cowork'
import { AGENT_ACTIONS, studioModel, type StudioModel } from '../metrics/studio'
import { BarList, LineChart } from '../ui/charts'
import { DataTable } from '../ui/DataTable'
import { dayLabel, dec2, int, pct, signedPct, usd, usd2, usd4 } from '../ui/format'
import { Kpi, KpiRow, Note, NotSuppliedIf, Panel } from '../ui/primitives'
import { ACTION_COLOR, PAYG, PREPAID, PRODUCT_COLOR } from '../ui/theme'
import { N } from './helpers'

const C = PRODUCT_COLOR.studio

function useStudio() {
  const { ds, filters, settings } = useData()
  const m = useMemo(() => studioModel(ds, filters, settings), [ds, filters, settings])
  return { settings, m, filters, noTenant: !ds.studioTenant.length }
}

interface UserLine {
  label: string
  credits: number
  billable: number
  share: number
  cost: number
}

function userRows(m: StudioModel, rate: number) {
  return m.byGroup.map((g) => ({
    id: g.group,
    data: { label: g.group, credits: g.credits, billable: g.billable, share: N(g.share), cost: g.billable * rate } as UserLine,
    children: g.users.map((u) => ({
      id: u.email,
      data: { label: u.name, credits: u.credits, billable: u.billable, share: N(m.userTotal ? u.credits / m.userTotal : null), cost: u.billable * rate },
    })),
  }))
}

function PeriodKpi({ m }: { m: StudioModel }) {
  const { ds } = useData()
  return (
    <NotSuppliedIf when={!ds.studioTenant.length}>
      <Kpi label="Tenant period" value={m.billingPeriod} sub="period filter applies to tenant totals only" wide />
    </NotSuppliedIf>
  )
}

function Footnotes({ m, rates = true }: { m: StudioModel; rates?: boolean }) {
  const { settings } = useData()
  return (
    <div className="grid grid-2">
      {rates && (
        <Panel title="Rates">
          <p className="prose">{ratesInUse(settings)}</p>
        </Panel>
      )}
      <Panel title="About this data">
        <p className="prose">{m.snapshotNote}</p>
      </Panel>
    </div>
  )
}

export function StudioConsumption() {
  const { m, settings, noTenant } = useStudio()
  return (
    <>
      <KpiRow>
        <NotSuppliedIf when={noTenant}>
          <Kpi tone="studio" label="Credits consumed" value={int(m.tenant.consumed)} sub="tenant total in the period" help="Prepaid plus pay-as-you-go credits from the tenant daily export." />
        </NotSuppliedIf>
        <Kpi label="Billing active users" value={int(m.users)} help="Distinct people in the user snapshot." />
        <Kpi label="Agents with credits" value={int(m.agentsWithCredits)} />
        <Kpi label="Avg credits per user" value={dec2(N(m.avgPerUser))} />
        <Kpi label="Avg agents per user" value={dec2(N(m.avgAgents))} />
        <PeriodKpi m={m} />
      </KpiRow>
      <div className="grid grid-1-2">
        <Panel title="Agents in the user snapshot">
          <DataTable
            label="Agents in the user snapshot"
            search={(r) => r.agent}
            columns={[
              { key: 'agent', label: 'Agent', value: (r) => r.agent },
              { key: 'credits', label: 'Credits', value: (r) => r.userCredits, fmt: int, align: 'right', bar: C },
              { key: 'share', label: 'Share', value: (r) => N(r.userShare), fmt: pct, align: 'right' },
            ]}
            rows={m.agents.filter((a) => a.userCredits > 0).map((a) => ({ id: a.agent, data: a }))}
            initialSort={{ key: 'credits', desc: true }}
            pageSize={8}
          />
        </Panel>
        <Panel title="Consumption over time" note="Daily tenant credits. Hover for the prepaid and PAYG split.">
          <LineChart
            label="Daily Studio credits"
            area
            xFmt={dayLabel}
            data={m.daily.map((d) => ({ key: d.date, values: [d.consumed, d.prepaid, d.payg] }))}
            series={[
              { name: 'Credits consumed', color: C, fmt: int },
              { name: 'Prepaid', color: PREPAID, fmt: int, tipOnly: true },
              { name: 'PAYG', color: PAYG, fmt: int, tipOnly: true },
            ]}
          />
        </Panel>
      </div>
      <div className="grid grid-2">
        <Panel title="Top users by consumption" note={m.concentration || undefined}>
          <DataTable
            label="Top users by consumption"
            childNoun="people"
            search={(r) => r.label}
            columns={[
              { key: 'label', label: `${m.attr} / person`, value: (r) => r.label },
              { key: 'credits', label: 'Credits', value: (r) => r.credits, fmt: int, align: 'right' },
              { key: 'share', label: 'Share', value: (r) => r.share, fmt: pct, align: 'right' },
            ]}
            rows={userRows(m, settings.studioPayg)}
            initialSort={{ key: 'credits', desc: true }}
            pageSize={8}
          />
        </Panel>
        <div className="stack">
          <Panel title="Consumption by model">
            <BarList label="Consumption by model" color={C} items={m.byModel.map((x) => ({ key: x.model, label: x.model, value: x.consumed }))} />
          </Panel>
          <Panel title="Consumption by feature">
            <BarList label="Consumption by feature" color={C} items={m.byFeature.map((x) => ({ key: x.feature, label: x.feature, value: x.consumed }))} />
          </Panel>
        </div>
      </div>
      <Footnotes m={m} rates={false} />
    </>
  )
}

export function StudioCost() {
  const { m, settings, noTenant } = useStudio()
  const t = m.tenant
  return (
    <>
      <NotSuppliedIf when={noTenant}>
        <KpiRow>
          <Kpi tone="studio" label="Total billable cost" value={usd(t.cost)} sub="prepaid plus PAYG" />
          <Kpi label="Prepaid cost" value={usd(t.prepaidCost)} />
          <Kpi label="PAYG cost" value={usd(t.paygCost)} />
          <Kpi label="PAYG share" value={pct(N(t.paygShare))} help="PAYG credits divided by all credits consumed." />
          <Kpi label="Effective rate" value={usd4(N(t.effective))} sub="per credit" help="Total cost divided by credits consumed." />
          <PeriodKpi m={m} />
        </KpiRow>
      </NotSuppliedIf>
      <div className="grid grid-2">
        <Panel title="Estimated value by person" note="User snapshot billable credits at the PAYG rate.">
          <DataTable
            label="Estimated value by person"
            childNoun="people"
            search={(r) => r.label}
            columns={[
              { key: 'label', label: `${m.attr} / person`, value: (r) => r.label },
              { key: 'billable', label: 'Billable credits', value: (r) => r.billable, fmt: int, align: 'right' },
              { key: 'cost', label: 'Cost', value: (r) => r.cost, fmt: usd2, align: 'right', bar: C },
            ]}
            rows={userRows(m, settings.studioPayg)}
            initialSort={{ key: 'cost', desc: true }}
            pageSize={8}
          />
        </Panel>
        <Panel title="Cost over time" note="Hover for the daily total.">
          <LineChart
            label="Daily Studio cost"
            xFmt={dayLabel}
            data={m.daily.map((d) => ({ key: d.date, values: [d.prepaidCost, d.paygCost, d.cost] }))}
            series={[
              { name: 'Prepaid cost', color: PREPAID, fmt: usd2 },
              { name: 'PAYG cost', color: PAYG, fmt: usd2 },
              { name: 'Total cost', color: C, fmt: usd2, tipOnly: true },
            ]}
          />
        </Panel>
      </div>
      <div className="grid grid-2">
        <Panel title="Estimated value by agent">
          <DataTable
            label="Estimated value by agent"
            search={(r) => r.agent}
            columns={[
              { key: 'agent', label: 'Agent', value: (r) => r.agent },
              { key: 'billable', label: 'Billable credits', value: (r) => r.userBillable, fmt: int, align: 'right' },
              { key: 'cost', label: 'Cost', value: (r) => r.userBillable * settings.studioPayg, fmt: usd2, align: 'right', bar: C },
            ]}
            rows={m.agents.filter((a) => a.userCredits > 0 || a.userBillable > 0).map((a) => ({ id: a.agent, data: a }))}
            initialSort={{ key: 'cost', desc: true }}
            pageSize={8}
          />
        </Panel>
        <div className="stack">
          <Panel title="Cost by model">
            <BarList label="Cost by model" color={C} fmt={usd2} items={m.byModel.map((x) => ({ key: x.model, label: x.model, value: x.cost }))} />
          </Panel>
          <Panel title="Cost by feature">
            <BarList label="Cost by feature" color={C} fmt={usd2} items={m.byFeature.map((x) => ({ key: x.feature, label: x.feature, value: x.cost }))} />
          </Panel>
        </div>
      </div>
      <Footnotes m={m} />
    </>
  )
}

export function StudioOptimization() {
  const { m, settings, noTenant } = useStudio()
  const idx = (a: string) => Math.max(0, AGENT_ACTIONS.indexOf(a as (typeof AGENT_ACTIONS)[number]))
  return (
    <>
      <KpiRow>
        <NotSuppliedIf when={noTenant}>
          <Kpi tone="studio" label="Consumption without entitlement" value={int(m.consumptionWithoutEnt)} sub="prepaid credits in unentitled environments" help="Prepaid credits used in environments that hold no capacity entitlement." />
          <Kpi label="Environments without entitlement" value={int(m.envsWithoutEnt)} />
        </NotSuppliedIf>
        <Kpi label="Unlicensed credit share" value={pct(N(m.unlicensed))} help="Share of user-snapshot credits from people without a Microsoft 365 Copilot licence." />
        <Kpi label="Agents with no consumption" value={int(m.agentsNoConsumption)} />
        <Kpi tone="warn" label="Top 10% of users" value={pct(N(m.top10))} sub="share of credits" />
        <PeriodKpi m={m} />
      </KpiRow>
      <Note title="Headline">{m.headline}</Note>
      <div className="grid grid-1-2">
        <Panel title="Agents by recommended action" note="Agents in each action, with the credits they consumed.">
          <BarList
            label="Agents by recommended action"
            color={C}
            keepOrder
            items={m.byAction.map((a) => ({ key: a.action, label: a.action, value: a.agents, hint: `${int(a.credits)} credits`, color: ACTION_COLOR[idx(a.action)] }))}
          />
        </Panel>
        <Panel title="Agent action queue">
          <DataTable
            label="Agent action queue"
            search={(r) => r.agent}
            columns={[
              { key: 'agent', label: 'Agent', value: (r) => r.agent },
              { key: 'action', label: 'Action', value: (r) => r.action, render: (r) => <span className="wrap-cell full">{r.action}</span>, width: '26%' },
              { key: 'consumed', label: 'Credits', value: (r) => r.consumed, fmt: int, align: 'right', bar: C },
              { key: 'absorbed', label: 'Absorbed', value: (r) => N(r.absorbed), fmt: pct, align: 'right', help: 'Share of credits covered by entitlement (non-billed).' },
              { key: 'billed', label: 'Billed ratio', value: (r) => N(r.billedRatio), fmt: pct, align: 'right' },
              { key: 'cost', label: 'Cost', value: (r) => r.cost, fmt: usd2, align: 'right' },
            ]}
            rows={m.visibleAgents.map((a) => ({ id: a.agent, data: a }))}
            initialSort={{ key: 'consumed', desc: true }}
            pageSize={8}
          />
        </Panel>
      </div>
      <div className="grid grid-2">
        <Panel title="Heaviest Studio users">
          <DataTable
            label="Heaviest Studio users"
            childNoun="people"
            search={(r) => r.label}
            columns={[
              { key: 'label', label: `${m.attr} / person`, value: (r) => r.label },
              { key: 'credits', label: 'Credits', value: (r) => r.credits, fmt: int, align: 'right' },
              { key: 'billable', label: 'Billable', value: (r) => r.billable, fmt: int, align: 'right' },
              { key: 'cost', label: 'Cost', value: (r) => r.cost, fmt: usd2, align: 'right', bar: C },
            ]}
            rows={userRows(m, settings.studioPayg)}
            initialSort={{ key: 'credits', desc: true }}
            pageSize={8}
          />
        </Panel>
        <Panel title="Environments" note={m.daysRemaining === null ? undefined : `Prepaid capacity lasts about ${int(m.daysRemaining)} more days at the current draw.`}>
          <DataTable
            label="Environments"
            search={(r) => r.env}
            columns={[
              { key: 'env', label: 'Environment', value: (r) => r.env },
              { key: 'ent', label: 'Entitlement', value: (r) => r.ent, fmt: int, align: 'right' },
              { key: 'used', label: 'Credits', value: (r) => r.used, fmt: int, align: 'right', bar: C },
              { key: 'payg', label: 'PAYG', value: (r) => r.payg, fmt: int, align: 'right' },
            ]}
            rows={m.envs.map((e) => ({ id: e.env, data: e }))}
            initialSort={{ key: 'used', desc: true }}
            pageSize={8}
          />
        </Panel>
      </div>
      <Footnotes m={m} />
    </>
  )
}

export function StudioForecast() {
  const { m, noTenant } = useStudio()
  const fc = m.forecast
  const cost30 = fc.cost30 ?? 0
  return (
    <>
      <NotSuppliedIf when={noTenant}>
        <KpiRow>
          <Kpi tone="studio" label="Daily run rate" value={int(N(fc.runRate))} sub="credits a day" />
          <Kpi label="Projected credits (30 days)" value={int(N(fc.proj30))} />
          <Kpi label="Projected cost (30 days)" value={usd(N(fc.cost30))} />
          <Kpi label="Growth applied" value={signedPct(fc.growth)} sub={`a month · confidence ${fc.confidence.toLowerCase()}`} />
          <Kpi label="Next 12 months cost" value={usd(fc.yearCost)} sub={`${int(fc.yearCredits)} credits`} />
          <PeriodKpi m={m} />
        </KpiRow>
      </NotSuppliedIf>
      <div className="grid grid-2">
        <div className="stack">
          <Panel title="Projected cost by group" note="Tenant projection split by each group's share of user-snapshot credits.">
            <DataTable
              label="Projected cost by group"
              search={(r) => r.group}
              columns={[
                { key: 'group', label: m.attr, value: (r) => r.group },
                { key: 'share', label: 'Share', value: (r) => N(r.share), fmt: pct, align: 'right' },
                { key: 'c30', label: '30 days', value: (r) => (r.share ?? 0) * cost30, fmt: usd2, align: 'right' },
                { key: 'c12', label: '12 months', value: (r) => (r.share ?? 0) * fc.yearCost, fmt: usd, align: 'right', bar: C },
              ]}
              rows={m.byGroup.map((g) => ({ id: g.group, data: g }))}
              initialSort={{ key: 'c12', desc: true }}
              pageSize={8}
            />
          </Panel>
          <Panel title="Projected cost by agent" note="Tenant projection split by each agent's share of agent-snapshot credits.">
            <DataTable
              label="Projected cost by agent"
              search={(r) => r.agent}
              columns={[
                { key: 'agent', label: 'Agent', value: (r) => r.agent },
                { key: 'share', label: 'Share', value: (r) => N(r.share), fmt: pct, align: 'right' },
                { key: 'c30', label: '30 days', value: (r) => (r.share ?? 0) * cost30, fmt: usd2, align: 'right' },
                { key: 'c12', label: '12 months', value: (r) => (r.share ?? 0) * fc.yearCost, fmt: usd, align: 'right', bar: C },
              ]}
              rows={m.agents.filter((a) => a.consumed > 0).map((a) => ({ id: a.agent, data: a }))}
              initialSort={{ key: 'c12', desc: true }}
              pageSize={8}
            />
          </Panel>
        </div>
        <div className="stack">
          <Panel title="Projected monthly cost, next 12 months">
            <LineChart
              label="Projected monthly Studio cost"
              area
              height={260}
              xFmt={(k) => `M${k}`}
              data={fc.months.map((x) => ({ key: String(x.m), values: [x.cost, x.credits] }))}
              series={[
                { name: 'Cost', color: C, fmt: usd },
                { name: 'Credits', color: C, fmt: int, tipOnly: true },
              ]}
            />
          </Panel>
          <Panel title="Forecast summary">
            <p className="prose">{fc.summary}</p>
            <p className="section-note">{fc.note}</p>
          </Panel>
        </div>
      </div>
      <Footnotes m={m} />
    </>
  )
}
