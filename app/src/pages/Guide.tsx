import { useMemo, useState, type CSSProperties } from 'react'
import guide from '../data/guide.json'
import { PRODUCT_COLOR } from '../ui/theme'
import { Panel } from '../ui/primitives'

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
  cowork: 'guide-cowork',
  studio: 'guide-studio',
  github: 'guide-ghcp',
  azure: 'guide-foundry',
  glossary: 'glossary',
}

const CARD_COLOR: Record<string, string> = {
  'Cowork & Work IQ': PRODUCT_COLOR.cowork,
  'Copilot Studio': PRODUCT_COLOR.studio,
  'GitHub Copilot': PRODUCT_COLOR.github,
  'Azure AI Foundry': PRODUCT_COLOR.azure,
}

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
    title: 'Settings are under Rates',
    body: 'Where the guide mentions Settings or parameters (credit rates, prepaid balances, the GitHub pool and change date), use the Rates button at the top right.',
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
      note="Definitions from the Power BI report"
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

export function Guide({ view }: { view: string }) {
  const page = PAGES.find((p) => p.id === BY_VIEW[view]) ?? PAGES[0]
  if (page.id === 'glossary') return <Glossary page={page} />
  return (
    <div className="stack">
      {page.cards.length > 0 && (
        <div className="product-cards">
          {page.cards.map((c) => (
            <div key={c.title} className="product-card" style={{ '--pc': CARD_COLOR[c.title] } as CSSProperties}>
              <span className="pc-name">{c.title}</span>
              <span className="pc-sub">{c.sub}</span>
            </div>
          ))}
        </div>
      )}
      <Sections page={page} />
      {page.id === 'intro' && (
        <Panel title="About this app edition">
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
