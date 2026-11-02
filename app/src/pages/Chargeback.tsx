import { useMemo, useState } from 'react'
import { useData } from '../data/store'
import { chargebackCsv, chargebackModel, NOT_ASSIGNED, type ChargeLine, type ChargeTo } from '../metrics/chargeback'
import { billingBasis } from '../metrics/cowork'
import { BarList } from '../ui/charts'
import { DataTable, type Column } from '../ui/DataTable'
import { int, pct, pct0, usd, usd2, usd4 } from '../ui/format'
import { Kpi, KpiRow, Note, NotSuppliedIf, Panel, Segmented } from '../ui/primitives'
import { PRODUCT_COLOR } from '../ui/theme'

const C = PRODUCT_COLOR.cowork

const CHARGE_TO: { id: ChargeTo; label: string }[] = [
  { id: 'costCentre', label: 'Cost centre' },
  { id: 'department', label: 'Department' },
]

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function CoworkChargeback() {
  const { ds, filters, settings } = useData()
  const [by, setBy] = useState<ChargeTo>('costCentre')
  const m = useMemo(() => chargebackModel(ds, filters, settings, by), [ds, filters, settings, by])
  const noun = by === 'costCentre' ? 'cost centre' : 'department'
  const nounPlural = by === 'costCentre' ? 'cost centres' : 'departments'

  const rows = m.rows.map((r) => ({
    id: r.key,
    data: r as ChargeLine,
    children: r.policies.map((p) => ({ id: `${r.key}|${p.key}`, data: p })),
  }))
  const columns: Column<ChargeLine>[] = [
    { key: 'key', label: `${by === 'costCentre' ? 'Cost centre' : 'Department'} / policy`, value: (r) => r.key, width: '22%' },
    by === 'costCentre'
      ? { key: 'department', label: 'Department', value: (r) => r.department }
      : { key: 'costCentre', label: 'Cost centre', value: (r) => r.costCentre },
    { key: 'billingOwner', label: 'Billing owner', value: (r) => r.billingOwner },
    { key: 'chargeCode', label: 'Charge code', value: (r) => r.chargeCode },
    { key: 'users', label: 'Users', value: (r) => r.users, fmt: int, align: 'right' },
    { key: 'credits', label: 'Credits', value: (r) => r.credits, fmt: int, align: 'right' },
    { key: 'prepaid', label: 'Prepaid', value: (r) => r.prepaidCost, fmt: usd2, align: 'right', help: 'Prepaid credits at the prepaid rate.' },
    { key: 'payg', label: 'PAYG', value: (r) => r.paygCost, fmt: usd2, align: 'right', help: 'Pay-as-you-go credits at the PAYG rate.' },
    { key: 'total', label: 'Total cost', value: (r) => r.total, fmt: usd2, align: 'right', bar: C },
    { key: 'share', label: 'Share', value: (r) => r.share ?? NaN, fmt: pct, align: 'right' },
  ]

  return (
    <>
      {!ds.policies.length ? (
        <Note title="Spending policies not loaded">
          Chargeback reads the cost centre, department, billing owner and charge code from SpendingPolicyMetadata.csv. Add it from Change data in the header. Until then, all
          cost shows as {NOT_ASSIGNED}.
        </Note>
      ) : (
        !m.hasColumns && (
          <Note title="No billing columns yet">
            Add CostCentre, Department, BillingOwner and ChargeCode columns to SpendingPolicyMetadata.csv, one value per spending policy, then load it again. Until then, all cost
            shows as {NOT_ASSIGNED}.
          </Note>
        )
      )}
      <KpiRow>
        <Kpi tone="cowork" label="Total chargeback" value={usd(m.total)} sub={billingBasis(m.tenantUsed, settings)} help="Prepaid plus pay-as-you-go cost for the selection. With no filters it equals Cowork total cost." />
        <Kpi label="Prepaid" value={usd(m.prepaidCost)} sub={`${pct0(m.share)} of credits at ${usd4(settings.coworkPrepaid)}`} help="Each line's credits times the tenant's prepaid share, at the prepaid rate." />
        <Kpi label="Pay-as-you-go" value={usd(m.paygCost)} sub={`at ${usd4(settings.coworkPayg)} a credit`} help="The rest of each line's credits, at the PAYG rate." />
        <Kpi label="Credits charged" value={int(m.credits)} />
        <NotSuppliedIf when={!ds.policies.length}>
          <Kpi label={`${by === 'costCentre' ? 'Cost centres' : 'Departments'} charged`} value={int(m.assigned)} />
          <Kpi tone={(m.unassignedShare ?? 0) > 0 ? 'warn' : 'neutral'} label="Not assigned" value={pct(m.unassignedShare ?? 0)} sub="of cost" help={`Cost from spending policies with no ${noun}, or from people with no policy.`} />
        </NotSuppliedIf>
      </KpiRow>
      <Panel
        title="Chargeback"
        note={`Expand a ${noun} to see its spending policies.`}
        actions={
          <div className="panel-actions">
            <Segmented label="Charge to" value={by} options={CHARGE_TO} onChange={setBy} />
            <button type="button" className="link-btn" onClick={() => download(`Cowork-chargeback-by-${by === 'costCentre' ? 'cost-centre' : 'department'}.csv`, chargebackCsv(m))}>
              Download CSV
            </button>
          </div>
        }
      >
        <DataTable label={`Chargeback by ${noun}`} childNoun="policies" search={(r) => `${r.key} ${r.billingOwner} ${r.chargeCode}`} columns={columns} rows={rows} initialSort={{ key: 'total', desc: true }} minWidth={980} />
      </Panel>
      <Panel title={`Cost by ${noun}`}>
        <BarList
          label={`Cost by ${noun}`}
          color={C}
          fmt={usd}
          items={m.rows.filter((r) => r.credits > 0).slice(0, 15).map((r) => ({ key: r.key, label: r.key, value: r.total, hint: `${int(r.credits)} credits · prepaid ${usd(r.prepaidCost)} · PAYG ${usd(r.paygCost)}` }))}
        />
      </Panel>
      <Note title="How the cost is split">
        Prepaid credits are shared pro rata: this period the tenant used {int(m.tenantUsed)} credits, {int(m.tenantPrepaid)} of them from the capacity pack, so every {noun}{' '}
        is charged {pct(m.share)} of its credits at the prepaid rate ({usd4(settings.coworkPrepaid)}) and the rest at the pay-as-you-go rate ({usd4(settings.coworkPayg)}). The share
        is worked out across all {nounPlural}, so filters change which lines you see but not the rate each one pays. Change rates and the pack balance from Rates in the header. A
        fresh Viva Insights export of SpendingPolicyMetadata.csv does not include the billing columns, so add them back after each re-export.
      </Note>
    </>
  )
}
