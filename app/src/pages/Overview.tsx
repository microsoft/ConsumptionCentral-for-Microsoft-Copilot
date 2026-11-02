import { useMemo } from 'react'
import { useData } from '../data/store'
import { combinedModel, REPORTING_CAVEAT, type ProductRow } from '../metrics/combined'
import { DataTable } from '../ui/DataTable'
import { BarList } from '../ui/charts'
import { int, usd } from '../ui/format'
import { Note, Panel } from '../ui/primitives'
import { PRODUCT_COLOR } from '../ui/theme'
import { N } from './helpers'

const PRODUCT: Record<ProductRow['product'], { color: string; href: string }> = {
  'Cowork / Work IQ': { color: PRODUCT_COLOR.cowork, href: '#/cowork' },
  'Copilot Studio': { color: PRODUCT_COLOR.studio, href: '#/studio' },
  'GitHub Copilot': { color: PRODUCT_COLOR.github, href: '#/github' },
  'Azure AI Foundry': { color: PRODUCT_COLOR.azure, href: '#/azure' },
}

export function Overview() {
  const { ds, filters, settings } = useData()
  const m = useMemo(() => combinedModel(ds, filters, settings), [ds, filters, settings])
  const missing = m.rows.filter((r) => r.cost === null).map((r) => r.product)
  return (
    <>
      <Panel
        title="Cost by product"
        note="Each product bills on its own basis, so there is no grand total."
        help="Cowork is valued at the PAYG rate before prepaid capacity. Studio is tenant credits at your prepaid and PAYG rates. GitHub is the export's net amount, without seats. Azure AI Foundry is the export's model cost."
      >
        <BarList
          label="Cost by product"
          color={PRODUCT_COLOR.cowork}
          fmt={usd}
          keepOrder
          items={[...m.rows]
            .filter((r) => r.cost !== null)
            .sort((a, b) => N(b.cost) - N(a.cost))
            .map((r) => ({ key: r.product, label: r.product, value: r.cost!, hint: r.covered, color: PRODUCT[r.product].color, href: PRODUCT[r.product].href }))}
        />
        {missing.length > 0 && <p className="section-note">Not loaded: {missing.join(', ')}.</p>}
      </Panel>
      <Panel title="Credits and coverage" note="Credits are product-specific units, so they are not added up either.">
        <DataTable
          label="Credits and coverage"
          minWidth={680}
          columns={[
            { key: 'product', label: 'Product', value: (r) => r.product },
            { key: 'credits', label: 'Credits', value: (r) => N(r.credits), fmt: int, align: 'right' },
            { key: 'basis', label: 'Cost basis', value: (r) => r.basis, render: (r) => <span className="wrap-cell full">{r.basis}</span>, width: '30%' },
            { key: 'coverage', label: 'Coverage', value: (r) => r.coverage, render: (r) => <span className="wrap-cell full">{r.coverage}</span>, width: '34%' },
          ]}
          rows={m.rows.map((r) => ({ id: r.product, data: r }))}
          initialSort={{ key: 'credits', desc: true }}
        />
      </Panel>
      <div className="notes">
        <Note>{REPORTING_CAVEAT}</Note>
        <Note>{m.studioCaveat}</Note>
      </div>
    </>
  )
}
