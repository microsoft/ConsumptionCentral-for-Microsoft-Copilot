import { useMemo } from 'react'
import { useData } from '../data/store'
import { combinedModel, REPORTING_CAVEAT, type ProductRow } from '../metrics/combined'
import { ratesInUse } from '../metrics/cowork'
import { DataTable } from '../ui/DataTable'
import { BarList } from '../ui/charts'
import { int, usd } from '../ui/format'
import { Note, Panel } from '../ui/primitives'
import { PRODUCT_COLOR } from '../ui/theme'
import { N } from './helpers'

const CARDS: { product: ProductRow['product']; href: string; color: string; metric: 'credits' | 'cost'; sub: string }[] = [
  { product: 'Cowork / Work IQ', href: '#/cowork', color: PRODUCT_COLOR.cowork, metric: 'credits', sub: 'Cowork credits · per person' },
  { product: 'Copilot Studio', href: '#/studio', color: PRODUCT_COLOR.studio, metric: 'credits', sub: 'Studio credits · per agent' },
  { product: 'GitHub Copilot', href: '#/github', color: PRODUCT_COLOR.github, metric: 'credits', sub: 'GitHub credits · against the pool' },
  { product: 'Azure AI Foundry', href: '#/azure', color: PRODUCT_COLOR.azure, metric: 'cost', sub: 'Foundry model cost' },
]

const COLOR_OF: Record<ProductRow['product'], string> = {
  'Cowork / Work IQ': PRODUCT_COLOR.cowork,
  'Copilot Studio': PRODUCT_COLOR.studio,
  'GitHub Copilot': PRODUCT_COLOR.github,
  'Azure AI Foundry': PRODUCT_COLOR.azure,
}

export function Overview() {
  const { ds, filters, settings } = useData()
  const m = useMemo(() => combinedModel(ds, filters, settings), [ds, filters, settings])
  const byProduct = new Map(m.rows.map((r) => [r.product, r]))
  return (
    <>
      <div className="product-cards">
        {CARDS.map((c) => {
          const r = byProduct.get(c.product)!
          const v = c.metric === 'credits' ? r.credits : r.cost
          return (
            <a key={c.product} className="product-card" href={c.href} style={{ ['--pc' as string]: c.color }}>
              <span className="pc-name">{c.product}</span>
              <span className="pc-value">{c.metric === 'credits' ? int(N(v)) : usd(N(v))}</span>
              <span className="pc-sub">{c.sub}</span>
            </a>
          )
        })}
      </div>
      <div className="grid grid-2-1">
        <Panel title="Aligned source totals" note={`Same dates for every product: ${m.window}.`} help="Credits are product-specific units, and each product's cost uses a different basis, so there is no grand total.">
          <DataTable
            label="Aligned source totals"
            minWidth={680}
            columns={[
              { key: 'product', label: 'Product', value: (r) => r.product },
              { key: 'credits', label: 'Credits', value: (r) => N(r.credits), fmt: int, align: 'right' },
              { key: 'cost', label: 'Cost', value: (r) => N(r.cost), fmt: usd, align: 'right' },
              { key: 'basis', label: 'Cost basis', value: (r) => r.basis, render: (r) => <span className="wrap-cell full">{r.basis}</span>, width: '24%' },
              { key: 'coverage', label: 'Coverage', value: (r) => r.coverage, render: (r) => <span className="wrap-cell full">{r.coverage}</span>, width: '24%' },
            ]}
            rows={m.rows.map((r) => ({ id: r.product, data: r }))}
            initialSort={{ key: 'cost', desc: true }}
          />
        </Panel>
        <Panel title="Cost by product · same dates">
          <BarList
            label="Cost by product"
            color={PRODUCT_COLOR.cowork}
            fmt={usd}
            items={m.rows.filter((r) => r.cost !== null).map((r) => ({ key: r.product, label: r.product, value: r.cost!, color: COLOR_OF[r.product] }))}
          />
        </Panel>
      </div>
      <div className="grid grid-3">
        <Panel title="Selected dates">
          <p className="prose">{m.window || 'No dated sources loaded.'}</p>
          <p className="section-note">Source windows: {m.sourceWindows}</p>
        </Panel>
        <Panel title="Rates in use" help="Change rates and the capacity pack balance from Rates in the header.">
          <p className="prose">{ratesInUse(settings)}</p>
        </Panel>
        <Panel title="Before you compare">
          <div className="notes">
            <Note>{REPORTING_CAVEAT}</Note>
            <Note tone="warn">{m.studioCaveat}</Note>
          </div>
        </Panel>
      </div>
    </>
  )
}
