import { useData } from '../data/store'
import { DataTable } from '../ui/DataTable'
import { dec2 } from '../ui/format'
import { Note, Panel } from '../ui/primitives'
import { N } from './helpers'

export function CostManagement() {
  const { ds } = useData()
  return (
    <>
      <Note title="Separate credit views">
        Graph beta returns credits, not currency. Daily services, monthly funding and the balance
        snapshot overlap; do not add them together or to other product totals. The API and collector
        have not been validated in a tenant, and beta APIs are not supported for production.
      </Note>
      <Panel title="Service usage by completed UTC day" note="Supply CopilotCostServiceDaily.csv.">
        <DataTable label="Service credit usage" rows={ds.costService.map((data, i) => ({ id: String(i), data }))}
          initialSort={{ key: 'date', desc: true }}
          columns={[
            { key: 'date', label: 'UTC day', value: (r) => r.date },
            { key: 'service', label: 'Service', value: (r) => r.service },
            { key: 'credits', label: 'Credits', value: (r) => r.credits, fmt: dec2, align: 'right' },
          ]} />
      </Panel>
      <Panel title="Funding usage by calendar month" note="Supply CopilotCostFundingMonthly.csv. Freshness does not guarantee completeness.">
        <DataTable label="Funding credit usage" rows={ds.costFunding.map((data, i) => ({ id: String(i), data }))}
          initialSort={{ key: 'month', desc: true }}
          columns={[
            { key: 'month', label: 'Month', value: (r) => r.month.slice(0, 7) },
            { key: 'funding', label: 'Funding class', value: (r) => r.funding },
            { key: 'credits', label: 'Credits', value: (r) => r.credits, fmt: dec2, align: 'right' },
            { key: 'freshness', label: 'Latest source time', value: (r) => r.freshness },
          ]} />
      </Panel>
      <Panel title="Tenant balance snapshot" note="Supply CopilotCostBalance.csv. Blank quantities are not zero.">
        <DataTable label="Tenant credit balance" rows={ds.costBalance.map((data, i) => ({ id: String(i), data }))}
          columns={[
            { key: 'method', label: 'Billing method', value: (r) => r.billingMethod },
            { key: 'purchased', label: 'Purchased', value: (r) => N(r.purchased), fmt: dec2, align: 'right' },
            { key: 'consumed', label: 'Consumed', value: (r) => r.consumed, fmt: dec2, align: 'right' },
            { key: 'remaining', label: 'Remaining', value: (r) => N(r.remaining), fmt: dec2, align: 'right' },
            { key: 'asOf', label: 'Collected at UTC', value: (r) => r.asOf },
            { key: 'freshness', label: 'Last modified', value: (r) => r.freshness },
          ]} />
      </Panel>
    </>
  )
}
