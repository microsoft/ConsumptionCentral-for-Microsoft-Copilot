import { useMemo, useState, type CSSProperties } from 'react'
import guide from '../data/guide.json'
import { PRODUCT_COLOR } from '../ui/theme'
import { Panel, Segmented } from '../ui/primitives'

interface Run {
  t: string
  b?: boolean
}
interface GuidePage {
  id: string
  name: string
  title: string
  subtitle: string
  cards: { title: string; sub: string }[]
  sections: { heading: string; paras: Run[][] }[]
}

const PAGES = guide as GuidePage[]
const BY_VIEW: Record<string, string> = {
  start: 'intro',
  read: 'how-to-read',
  glossary: 'glossary',
}

type ProductId = 'cowork' | 'studio' | 'github' | 'azure'

const PRODUCTS: { id: ProductId; title: string; page: string }[] = [
  { id: 'cowork', title: 'Cowork & Work IQ', page: 'guide-cowork' },
  { id: 'studio', title: 'Copilot Studio', page: 'guide-studio' },
  { id: 'github', title: 'GitHub Copilot', page: 'guide-ghcp' },
  { id: 'azure', title: 'Azure AI Foundry', page: 'guide-foundry' },
]
const PRODUCT_BY_TITLE = new Map(PRODUCTS.map((p) => [p.title, p.id]))

const NOTES: { title: string; body: string }[] = [
  {
    title: 'Same numbers, simpler layout',
    body: 'Every measure, chart and table in the Power BI report is here. Its 24 pages (17 data pages and 7 guide pages) are grouped into six tabs, and each product tab has views for consumption, cost, optimization and forecast.',
  },
  {
    title: 'Charts that changed shape',
    body: 'Treemaps, funnels and donuts are shown as ranked bars, and combo charts as a line or bars with the second measure in the tooltip. The values are unchanged.',
  },
  {
    title: 'Overview and forecasts',
    body: 'The Overview ranks each product’s cost on its own basis rather than adding a grand total. Forecasts lead with the monthly run rate and show the next 12 months as a range, from the current rate to the growth trend. With too little history, only the current rate is shown.',
  },
  {
    title: 'Filters',
    body: 'Each product tab has its own period, group and slicers, as the report pages do. They reset when you change tab.',
  },
  {
    title: 'Privacy',
    body: 'Your files are read and calculated in your browser. Nothing is uploaded, and nothing is stored after you close the app.',
  },
  {
    title: 'Sample data',
    body: 'The app opens on a synthetic sample with made-up people and agents. Use Change data to load your own exports.',
  },
]

function Para({ runs }: { runs: Run[] }) {
  return <p>{runs.map((r, i) => (r.b ? <strong key={i}>{r.t}</strong> : <span key={i}>{r.t}</span>))}</p>
}

function Sections({ page }: { page: GuidePage }) {
  return (
    <div className="grid grid-2">
      {page.sections.map((s) => (
        <Panel key={s.heading} title={s.heading}>
          <div className="prose">
            {s.paras.map((p, i) => (
              <Para key={i} runs={p} />
            ))}
          </div>
        </Panel>
      ))}
    </div>
  )
}

function splitTerm(runs: Run[]): { term: string; body: string } {
  const text = runs.map((r) => r.t).join('')
  const i = text.indexOf(' — ')
  return i < 0 ? { term: '', body: text } : { term: text.slice(0, i).trim(), body: text.slice(i + 3).trim() }
}

function Glossary({ page }: { page: GuidePage }) {
  const [q, setQ] = useState('')
  const groups = useMemo(() => {
    const s = q.trim().toLowerCase()
    return page.sections
      .map((sec) => ({
        heading: sec.heading,
        items: sec.paras.map(splitTerm).filter((x) => !s || `${x.term} ${x.body}`.toLowerCase().includes(s)),
      }))
      .filter((g) => g.items.length)
  }, [page, q])
  return (
    <Panel
      title="Glossary"
      note="Every term and metric in the app"
      actions={<input type="search" placeholder="Search terms" aria-label="Search terms" value={q} onChange={(e) => setQ(e.target.value)} />}
    >
      {groups.length === 0 && <p className="empty">No terms match “{q}”.</p>}
      {groups.map((g) => (
        <section key={g.heading} className="gloss-group">
          <h4>{g.heading}</h4>
          <dl className="defs defs-grid gloss-list">
            {g.items.map((x, i) => (
              <div key={i}>
                {x.term && <dt>{x.term}</dt>}
                <dd>{x.body}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </Panel>
  )
}

/** Each card opens its product's tab. */
function Cards({ cards }: { cards: GuidePage['cards'] }) {
  if (!cards.length) return null
  return (
    <div className="product-cards">
      {cards.map((c) => {
        const id = PRODUCT_BY_TITLE.get(c.title)
        return (
          <a key={c.title} className="product-card" href={id ? `#/${id}` : undefined} style={{ '--pc': id ? PRODUCT_COLOR[id] : undefined } as CSSProperties}>
            <span className="pc-name">{c.title}</span>
            <span className="pc-sub">{c.sub}</span>
          </a>
        )
      })}
    </div>
  )
}

function Products() {
  const [id, setId] = useState<ProductId>('cowork')
  const product = PRODUCTS.find((p) => p.id === id)!
  const page = PAGES.find((p) => p.id === product.page)!
  return (
    <div className="stack">
      <div className="guide-product-bar">
        <Segmented label="Product" value={id} options={PRODUCTS.map((p) => ({ id: p.id, label: p.title }))} onChange={setId} />
        <a className="link-btn" href={`#/${id}`}>
          Open {product.title}
        </a>
      </div>
      <p className="section-note">{page.subtitle}</p>
      <Sections page={page} />
    </div>
  )
}

export function Guide({ view }: { view: string }) {
  if (view === 'products') return <Products />
  const page = PAGES.find((p) => p.id === BY_VIEW[view]) ?? PAGES[0]
  if (page.id === 'glossary') return <Glossary page={page} />
  return (
    <div className="stack">
      <Cards cards={page.cards} />
      <Sections page={page} />
      {page.id === 'intro' && (
        <Panel title="About this app">
          <dl className="defs defs-grid">
            {NOTES.map((n) => (
              <div key={n.title}>
                <dt>{n.title}</dt>
                <dd>{n.body}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      )}
    </div>
  )
}
