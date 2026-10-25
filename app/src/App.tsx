import { useEffect, useRef, useState } from 'react'
import { useData } from './data/store'
import { FilterBar } from './FilterBar'
import { AzureHealth, AzureRecon, AzureSpend } from './pages/Azure'
import { CoworkConsumption, CoworkCost, CoworkForecast, CoworkOptimization } from './pages/Cowork'
import { CoworkTasks } from './pages/Tasks'
import { GitHubConsumption, GitHubCost, GitHubForecast, GitHubOptimization } from './pages/GitHub'
import { Guide } from './pages/Guide'
import { Overview } from './pages/Overview'
import { StudioConsumption, StudioCost, StudioForecast, StudioOptimization } from './pages/Studio'
import { TABS, useRoute, type Route } from './routes'
import type { SourceKind } from './data/types'
import { DataSourceDialog } from './ui/DataSourceDialog'
import { ErrorBoundary } from './ui/ErrorBoundary'
import { dateLabel } from './ui/format'
import { Note, Segmented } from './ui/primitives'
import { NotSupplied } from './ui/notSupplied'
import { SettingsSheet } from './ui/SettingsSheet'

function Page({ route }: { route: Route }) {
  const { tab, view } = route
  switch (tab.id) {
    case 'overview':
      return <Overview />
    case 'cowork':
      if (view === 'cost') return <CoworkCost />
      if (view === 'tasks') return <CoworkTasks />
      if (view === 'optimization') return <CoworkOptimization />
      if (view === 'forecast') return <CoworkForecast />
      return <CoworkConsumption />
    case 'studio':
      if (view === 'cost') return <StudioCost />
      if (view === 'optimization') return <StudioOptimization />
      if (view === 'forecast') return <StudioForecast />
      return <StudioConsumption />
    case 'github':
      if (view === 'cost') return <GitHubCost />
      if (view === 'optimization') return <GitHubOptimization />
      if (view === 'forecast') return <GitHubForecast />
      return <GitHubConsumption />
    case 'azure':
      if (view === 'health') return <AzureHealth />
      if (view === 'recon') return <AzureRecon />
      return <AzureSpend />
    default:
      return <Guide view={view} />
  }
}

/** Files each view needs. Overview, Guide and Tasks (which has its own notice) are left out. */
function viewSources({ tab, view }: Route): SourceKind[] | null {
  switch (tab.id) {
    case 'cowork':
      return view === 'tasks' ? null : ['coworkMetrics']
    case 'studio':
      return ['studioTenant', 'studioAgent', 'studioUser']
    case 'github':
      return ['ghUsage', 'ghUsers']
    case 'azure':
      if (view === 'health') return ['azureHealth']
      if (view === 'recon') return ['recon']
      return ['azureSolution']
    default:
      return null
  }
}

function View({ route }: { route: Route }) {
  const { ds } = useData()
  const kinds = viewSources(route)
  const missing = !!kinds && !ds.sources.some((s) => kinds.includes(s.kind) && s.rows > 0)
  return (
    <NotSupplied.Provider value={missing}>
      {missing && (
        <Note title="Not supplied">
          No {route.tab.label} data is loaded, so this view shows dashes. Add the {route.tab.label} files from Change data in the header.
        </Note>
      )}
      <ErrorBoundary key={`${route.tab.id}/${route.view}`} resetKey={ds}>
        <Page route={route} />
      </ErrorBoundary>
    </NotSupplied.Provider>
  )
}

export default function App() {
  const { ds, resetFilters } = useData()
  const [route, go] = useRoute()
  const [sheet, setSheet] = useState<'source' | 'settings' | null>(null)
  const prevTab = useRef(route.tab.id)

  // Each product has its own slicers, so they reset when the tab changes.
  useEffect(() => {
    if (prevTab.current === route.tab.id) return
    prevTab.current = route.tab.id
    resetFilters()
  }, [route.tab.id, resetFilters])

  // On narrow screens the tab strip and view switcher scroll sideways; keep the current one visible.
  useEffect(() => {
    document.querySelectorAll<HTMLElement>('.tabs [aria-current="page"], .segmented .on').forEach((el) => {
      const strip = el.closest<HTMLElement>('.tabs, .segmented')
      if (!strip || strip.scrollWidth <= strip.clientWidth) return
      const offset = el.getBoundingClientRect().left - strip.getBoundingClientRect().left
      strip.scrollTo({ left: strip.scrollLeft + offset - (strip.clientWidth - el.offsetWidth) / 2 })
    })
  }, [route.tab.id, route.view])

  const view = route.tab.views.find((v) => v.id === route.view)
  return (
    <div className="shell">
      <a href="#main" className="skip">
        Skip to content
      </a>
      <header className="band">
        <div className="band-inner">
          <div className="band-top">
            <div className="brand">
              <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
                <rect width="28" height="28" rx="7" fill="#ffffff" fillOpacity="0.1" />
                <circle cx="14" cy="14" r="7.5" fill="none" stroke="#7fe0cf" strokeWidth="2.6" />
                <path d="M14 6.5A7.5 7.5 0 0 1 21.5 14H14Z" fill="#7fe0cf" />
              </svg>
              <div>
                <h1>Consumption Central</h1>
                <p>Copilot credits and AI spend</p>
              </div>
            </div>
            <div className="band-actions">
              <button type="button" className="source-chip" onClick={() => setSheet('source')} title="Change data source">
                {ds.sample && <span className="tag">Sample data</span>}
                <span className="source-dates">
                  {dateLabel(ds.minDate)} – {dateLabel(ds.maxDate)}
                </span>
                <span className="source-action">Change data</span>
              </button>
              <button type="button" className="band-btn" onClick={() => setSheet('settings')} aria-label="Rates and settings">
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M2 4h8M13 4h1M2 8h2M7 8h7M2 12h6M11 12h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  <circle cx="11.5" cy="4" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
                  <circle cx="5.5" cy="8" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
                  <circle cx="9.5" cy="12" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
                </svg>
                <span className="label">Rates</span>
              </button>
            </div>
          </div>
          <nav className="tabs" aria-label="Sections">
            {TABS.map((t) => (
              <a key={t.id} href={`#/${t.id}`} aria-current={t.id === route.tab.id ? 'page' : undefined}>
                {t.label}
              </a>
            ))}
          </nav>
        </div>
      </header>
      <div className="toolbar">
        <div className="toolbar-inner">
          <div className="page-head">
            <h2>
              {route.tab.label}
              {view && route.tab.views.length > 1 && <span className="crumb"> · {view.label}</span>}
            </h2>
            <p>{view?.intro ?? route.tab.intro}</p>
          </div>
          {route.tab.views.length > 1 && (
            <Segmented label={`${route.tab.label} views`} value={route.view} options={route.tab.views} onChange={(v) => go(route.tab.id, v)} />
          )}
        </div>
        <FilterBar route={route} />
      </div>
      <main id="main" className="main" tabIndex={-1}>
        <View route={route} />
      </main>
      <footer className="foot">Consumption Central app. Everything is calculated in your browser and never leaves it.</footer>
      <DataSourceDialog open={sheet === 'source'} onClose={() => setSheet(null)} />
      <SettingsSheet open={sheet === 'settings'} onClose={() => setSheet(null)} />
    </div>
  )
}
