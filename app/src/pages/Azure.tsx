import { useMemo } from 'react'
import { useData } from '../data/store'
import { HEALTH_NOTE, RECON_NOTE, healthModel, reconModel, spendModel } from '../metrics/azure'
import { BarList, LineChart } from '../ui/charts'
import { DataTable } from '../ui/DataTable'
import { dayLabel, dec1, dec2, int, money, pct } from '../ui/format'
import { Kpi, KpiRow, Note, Panel } from '../ui/primitives'
import { NEUTRAL, OVER, PRODUCT_COLOR, SERIES, UNDER } from '../ui/theme'
import { N } from './helpers'

const C = PRODUCT_COLOR.azure

/** A difference that rounds to zero in whole currency units is a match, not a variance. */
const isVariance = (d: number | null): d is number => d !== null && Math.abs(d) >= 0.5
const diffColor = (d: number | null) => (!isVariance(d) ? NEUTRAL : d > 0 ? OVER : UNDER)

export function AzureSpend() {
  const { ds, filters } = useData()
  const m = useMemo(() => spendModel(ds, filters), [ds, filters])
  const cur = money(m.currency)
  return (
    <>
      {!m.currencyOk && ds.azureSolution.length > 0 && (
        <Note tone="warn" title="Pick one currency">
          Costs in different currencies can't be added together. Choose a single currency in the filters.
        </Note>
      )}
      <KpiRow>
        <Kpi tone="azure" label="Selected cost" value={cur(N(m.selected))} sub={`${m.basis} cost basis`} help="Whole-solution Azure cost for the filters, on the chosen cost basis." />
        <Kpi label="Model share" value={pct(N(m.modelShare))} sub={`${cur(N(m.model))} on models`} help="Model cost as a share of the selected cost." />
        <Kpi label="Supporting cost" value={cur(N(m.supporting))} sub="storage, networking, compute" />
        <Kpi label="AI requests" value={int(m.requests)} />
        <Kpi label="Tagged allocation" value={pct(N(m.tagged))} sub="cost with a department tag" />
      </KpiRow>
      <div className="grid grid-2">
        <Panel title="Cost composition over time">
          <LineChart
            label="Azure cost composition over time"
            xFmt={dayLabel}
            data={m.composition}
            series={[
              { name: 'Model', color: C, fmt: cur },
              { name: 'AI service', color: SERIES[0], fmt: cur },
              { name: 'Supporting', color: NEUTRAL, fmt: cur },
            ]}
          />
        </Panel>
        <Panel title="Spend by service">
          <BarList label="Azure spend by service" color={C} fmt={cur} items={m.byService.map((s) => ({ key: s.service, label: s.service, value: s.cost }))} />
        </Panel>
      </div>
      <KpiRow>
        <Kpi label="Total tokens" value={dec1(m.tokensM)} sub="millions" />
        <Kpi label="Speech hours" value={dec1(m.speechHours)} />
        <Kpi label="Document pages" value={int(m.pages)} />
        <Kpi label="Generated images" value={int(m.images)} />
        <Kpi label="Cost per 1M PAYG tokens" value={m.currencyOk ? `${dec2(N(m.costPer1M))} ${m.currency}` : '–'} help="Pay-as-you-go token cost divided by pay-as-you-go tokens (millions)." />
      </KpiRow>
      <Panel title="Resource cost and tag allocation">
        <DataTable
          label="Resource cost and tag allocation"
          search={(r) => `${r.resource} ${r.application} ${r.service} ${r.department}`}
          columns={[
            { key: 'resource', label: 'Resource', value: (r) => r.resource },
            { key: 'application', label: 'Application', value: (r) => r.application },
            { key: 'service', label: 'Service', value: (r) => r.service },
            { key: 'department', label: 'Department tag', value: (r) => r.department },
            { key: 'cost', label: 'Cost', value: (r) => r.cost, fmt: cur, align: 'right', bar: C },
          ]}
          rows={m.resources.map((r) => ({ id: r.id, data: r }))}
          initialSort={{ key: 'cost', desc: true }}
        />
      </Panel>
    </>
  )
}

export function AzureHealth() {
  const { ds, filters } = useData()
  const m = useMemo(() => healthModel(ds, filters), [ds, filters])
  const ptu = m.list.filter((d) => d.ptu)
  const ms = (v: number) => `${int(v)} ms`
  return (
    <>
      <KpiRow>
        <Kpi tone="azure" label="Deployments" value={int(m.deployments)} />
        <Kpi label="PTU capacity" value={int(m.capacity)} sub="provisioned throughput units" />
        <Kpi label="Weighted PTU utilisation" value={pct(N(m.util) / 100)} help="Utilisation of provisioned deployments, weighted by capacity." />
        <Kpi label="Model requests" value={int(m.requests)} />
        <Kpi label="5xx error rate" value={pct(N(m.errorRate))} sub={`429 rate ${pct(N(m.throttleRate))}`} />
        <Kpi tone={m.low ? 'warn' : 'neutral'} label="Low-utilisation deployments" value={int(m.low)} sub="PTU below 30%" />
      </KpiRow>
      <div className="grid grid-2">
        <Panel title="PTU utilisation by deployment">
          <BarList label="PTU utilisation by deployment" color={C} fmt={(v) => pct(v / 100)} items={ptu.map((d) => ({ key: d.identity, label: d.deployment || d.identity, value: N(d.util), hint: `${int(d.capacity)} PTU · ${d.application || 'No application'}` }))} />
        </Panel>
        <Panel title="Request-weighted latency by deployment">
          <BarList label="Latency by deployment" color={SERIES[0]} fmt={ms} items={m.list.map((d) => ({ key: d.identity, label: d.deployment || d.identity, value: N(d.latency), hint: d.application || undefined }))} />
        </Panel>
      </div>
      <Note title="How to interpret">{HEALTH_NOTE}</Note>
      <Panel title="Model deployment inventory and health">
        <DataTable
          label="Model deployment inventory and health"
          search={(r) => `${r.identity} ${r.deployment} ${r.application} ${r.model} ${r.sku} ${r.region}`}
          columns={[
            { key: 'deployment', label: 'Deployment', value: (r) => r.deployment || r.identity },
            { key: 'application', label: 'Application', value: (r) => r.application },
            { key: 'model', label: 'Model', value: (r) => r.model },
            { key: 'sku', label: 'SKU', value: (r) => r.sku },
            { key: 'region', label: 'Region', value: (r) => r.region },
            { key: 'capacity', label: 'PTU capacity', value: (r) => (r.ptu ? r.capacity : NaN), fmt: int, align: 'right' },
            { key: 'requests', label: 'Requests', value: (r) => r.requests, fmt: int, align: 'right', bar: C },
            { key: 'throttle', label: '429 rate', value: (r) => N(r.throttleRate), fmt: pct, align: 'right' },
          ]}
          rows={m.list.map((d) => ({ id: d.identity, data: d }))}
          initialSort={{ key: 'requests', desc: true }}
        />
      </Panel>
    </>
  )
}

export function AzureRecon() {
  const { ds, filters } = useData()
  const m = useMemo(() => reconModel(ds, filters), [ds, filters])
  const cur = money(m.currency)
  const aligned = m.byStatus.filter((s) => s.difference !== null)
  return (
    <>
      <KpiRow>
        <Kpi tone="azure" label="Usage estimate" value={cur(N(m.estimate))} sub="product-derived" />
        <Kpi label="Azure actual" value={cur(N(m.actual))} sub="shared billing pool" />
        <Kpi tone={isVariance(m.difference) ? 'warn' : 'neutral'} label="Difference" value={cur(N(m.difference))} sub={m.status} help="Azure actual minus usage estimate. Only shown when period, pool and currency are aligned." />
        <Kpi label="Evidence" value={cur(N(m.evidence))} sub="fictional sample evidence" />
        <Kpi label="Unexplained residual" value={cur(N(m.residual))} sub="difference less evidence" />
      </KpiRow>
      <div className="grid grid-2">
        <Panel title="Usage estimate by product">
          <BarList label="Usage estimate by product" color={C} fmt={cur} items={m.byProduct.map((p) => ({ key: p.product, label: p.product, value: N(p.estimate) }))} />
        </Panel>
        <Panel title="Difference by status" note="Aligned groups only. Red is billed above the estimate, teal below it, grey a match.">
          <BarList label="Difference by status" color={NEUTRAL} fmt={cur} items={aligned.map((s) => ({ key: s.label, label: s.label, value: N(s.difference), color: diffColor(s.difference) }))} />
        </Panel>
      </div>
      <Note title="Comparison guardrails">{RECON_NOTE}</Note>
      <Panel title="Billing representation detail">
        <DataTable
          label="Billing representation detail"
          search={(r) => `${r.representation} ${r.product} ${r.rowStatus} ${r.evidenceType}`}
          columns={[
            { key: 'representation', label: 'Representation', value: (r) => r.representation },
            { key: 'product', label: 'Product', value: (r) => r.product },
            { key: 'rowStatus', label: 'Status', value: (r) => r.rowStatus },
            { key: 'evidenceType', label: 'Evidence type', value: (r) => r.evidenceType },
            { key: 'estimate', label: 'Usage estimate', value: (r) => N(r.estimate), fmt: cur, align: 'right' },
            { key: 'actual', label: 'Azure actual', value: (r) => N(r.actual), fmt: cur, align: 'right' },
            { key: 'difference', label: 'Difference', value: (r) => N(r.difference), fmt: cur, align: 'right' },
          ]}
          rows={m.detail.map((d) => ({ id: d.id, data: d }))}
          initialSort={{ key: 'representation' }}
        />
      </Panel>
    </>
  )
}
