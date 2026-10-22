import { useMemo } from 'react'
import { useData } from './data/store'
import { COST_BASES, healthOptions, reconOptions, spendOptions } from './metrics/azure'
import { distinct } from './metrics/common'
import { coworkPeriods } from './metrics/cowork'
import { ghOptions, ghPeriods } from './metrics/ghcp'
import { AGENT_ACTIONS, STUDIO_PERIODS, studioOptions } from './metrics/studio'
import { TASK_SCENARIOS, taskPeriods } from './metrics/tasks'
import { GroupByFields, GrowthField } from './pages/fields'
import { opts } from './pages/helpers'
import type { Route } from './routes'
import { DateField, NumberField, Select } from './ui/primitives'

function CoworkFilters({ view }: { view: string }) {
  const { ds, filters, setFilter, settings, setSettings } = useData()
  const periods = useMemo(() => coworkPeriods(ds), [ds])
  const services = useMemo(() => distinct(ds.credits.map((c) => c.service)), [ds])
  const policies = useMemo(() => distinct(ds.people.map((p) => p.policyName)), [ds])
  const cohorts = useMemo(() => distinct(ds.people.map((p) => p.cohort)), [ds])
  const defaultPeriod = periods.find((p) => p.value === '4')?.value ?? periods[0]?.value ?? ''
  return (
    <>
      <Select label="Period" value={filters.period || defaultPeriod} onChange={(v) => setFilter('period', v)} options={periods} />
      <Select label="Service" value={filters.service ?? ''} onChange={(v) => setFilter('service', v)} options={opts(services)} allLabel="All services" />
      <Select label="Spending policy" value={filters.policy ?? ''} onChange={(v) => setFilter('policy', v)} options={opts(policies)} allLabel="All policies" />
      <GroupByFields />
      <Select label="Usage cohort" value={filters.cohort ?? ''} onChange={(v) => setFilter('cohort', v)} options={opts(cohorts)} allLabel="All cohorts" />
      {view === 'cost' && (
        <NumberField
          label="Capacity pack balance"
          value={settings.pack}
          min={0}
          step={1000}
          onChange={(v) => setSettings({ ...settings, pack: Math.max(0, Number(v) || 0) })}
        />
      )}
      {view === 'forecast' && <GrowthField />}
    </>
  )
}

function TaskFilters() {
  const { ds, filters, setFilter } = useData()
  const periods = useMemo(() => taskPeriods(ds), [ds])
  const types = useMemo(() => distinct(ds.tasks.map((t) => t.type)), [ds])
  const categories = useMemo(() => distinct(ds.tasks.map((t) => t.category)), [ds])
  const orgs = useMemo(() => distinct(ds.tasks.map((t) => t.org)), [ds])
  const defaultPeriod = periods.find((p) => p.value === '4')?.value ?? periods[0]?.value ?? ''
  return (
    <>
      <Select label="Period" value={filters.taskPeriod || defaultPeriod} onChange={(v) => setFilter('taskPeriod', v)} options={periods} />
      <Select label="Task type" value={filters.taskType ?? ''} onChange={(v) => setFilter('taskType', v)} options={opts(types)} allLabel="All types" />
      <Select label="Category" value={filters.category ?? ''} onChange={(v) => setFilter('category', v)} options={opts(categories)} allLabel="All categories" />
      <Select label="Organisation" value={filters.org ?? ''} onChange={(v) => setFilter('org', v)} options={opts(orgs)} allLabel="All" />
      <Select label="Scenario" value={filters.scenario || 'Typical'} onChange={(v) => setFilter('scenario', v)} options={opts(TASK_SCENARIOS)} />
      <NumberField label="Hourly value (USD)" value={filters.hourly ?? ''} min={0} max={1000} step={5} placeholder="None" onChange={(v) => setFilter('hourly', v === '' ? '' : String(Math.min(1000, Math.max(0, Number(v) || 0))))} />
    </>
  )
}

function StudioFilters({ view }: { view: string }) {
  const { ds, filters, setFilter } = useData()
  const o = useMemo(() => studioOptions(ds), [ds])
  return (
    <>
      <Select label="Period (tenant totals)" value={filters.studioPeriod || 'all'} onChange={(v) => setFilter('studioPeriod', v)} options={STUDIO_PERIODS} />
      <GroupByFields />
      <Select label="Environment" value={filters.env ?? ''} onChange={(v) => setFilter('env', v)} options={opts(o.envs)} allLabel="All" />
      <Select label="Agent" value={filters.agent ?? ''} onChange={(v) => setFilter('agent', v)} options={opts(o.agents)} allLabel="All agents" />
      <Select label="Product" value={filters.product ?? ''} onChange={(v) => setFilter('product', v)} options={opts(o.products)} allLabel="All" />
      {view === 'optimization' && (
        <Select label="Action" value={filters.agentAction ?? ''} onChange={(v) => setFilter('agentAction', v)} options={opts(AGENT_ACTIONS)} allLabel="All actions" />
      )}
      {view === 'forecast' && <GrowthField />}
    </>
  )
}

function GitHubFilters({ view }: { view: string }) {
  const { ds, filters, setFilter } = useData()
  const periods = useMemo(() => ghPeriods(ds), [ds])
  const o = useMemo(() => ghOptions(ds), [ds])
  return (
    <>
      <Select label="Period" value={filters.ghPeriod || '0'} onChange={(v) => setFilter('ghPeriod', v)} options={periods} />
      <GroupByFields />
      <Select label="Cost centre" value={filters.costCenter ?? ''} onChange={(v) => setFilter('costCenter', v)} options={opts(o.costCenters)} allLabel="All" />
      <Select label="Model tier" value={filters.tier ?? ''} onChange={(v) => setFilter('tier', v)} options={opts(o.tiers)} allLabel="All tiers" />
      <Select label="Model" value={filters.model ?? ''} onChange={(v) => setFilter('model', v)} options={opts(o.models)} allLabel="All models" />
      <Select label="Usage type" value={filters.usageType ?? ''} onChange={(v) => setFilter('usageType', v)} options={opts(o.types)} allLabel="All" />
      {view === 'forecast' && <GrowthField />}
    </>
  )
}

function AzureFilters({ view }: { view: string }) {
  const { ds, filters, setFilter } = useData()
  const spend = useMemo(() => spendOptions(ds), [ds])
  const health = useMemo(() => healthOptions(ds), [ds])
  const recon = useMemo(() => reconOptions(ds), [ds])
  if (view === 'health')
    return (
      <>
        <Select label="Subscription" value={filters.hSubscription ?? ''} onChange={(v) => setFilter('hSubscription', v)} options={opts(health.subscriptions)} allLabel="All" />
        <Select label="Application" value={filters.hApplication ?? ''} onChange={(v) => setFilter('hApplication', v)} options={opts(health.applications)} allLabel="All" />
        <Select label="SKU" value={filters.sku ?? ''} onChange={(v) => setFilter('sku', v)} options={opts(health.skus)} allLabel="All" />
      </>
    )
  if (view === 'recon')
    return (
      <>
        <Select
          label="Billing period"
          value={filters.reconPeriod || recon.periods[recon.periods.length - 1] || ''}
          onChange={(v) => setFilter('reconPeriod', v)}
          options={[...opts([...recon.periods].reverse()), { value: '*', label: 'All periods (not comparable)' }]}
        />
        <Select label="Currency" value={filters.reconCurrency ?? ''} onChange={(v) => setFilter('reconCurrency', v)} options={opts(recon.currencies)} allLabel="All" />
        <Select
          label="Billing pool"
          value={filters.pool || recon.pools[0] || ''}
          onChange={(v) => setFilter('pool', v)}
          options={[...opts(recon.pools), { value: '*', label: 'All pools (not comparable)' }]}
        />
      </>
    )
  return (
    <>
      <Select label="Cost basis" value={filters.basis || 'Actual'} onChange={(v) => setFilter('basis', v)} options={opts(COST_BASES)} />
      <Select label="Subscription" value={filters.subscription ?? ''} onChange={(v) => setFilter('subscription', v)} options={opts(spend.subscriptions)} allLabel="All" />
      <Select label="Application" value={filters.application ?? ''} onChange={(v) => setFilter('application', v)} options={opts(spend.applications)} allLabel="All" />
      <Select label="Service" value={filters.azService ?? ''} onChange={(v) => setFilter('azService', v)} options={opts(spend.services)} allLabel="All" />
      <Select label="Currency" value={filters.currency || spend.currencies[0] || ''} onChange={(v) => setFilter('currency', v)} options={opts(spend.currencies)} />
    </>
  )
}

function OverviewFilters() {
  const { ds, filters, setFilter } = useData()
  return (
    <>
      <DateField label="From" value={filters.from || ds.minDate} min={ds.minDate} max={ds.maxDate} onChange={(v) => setFilter('from', v)} />
      <DateField label="To" value={filters.to || ds.maxDate} min={ds.minDate} max={ds.maxDate} onChange={(v) => setFilter('to', v)} />
    </>
  )
}

export function FilterBar({ route }: { route: Route }) {
  const { filters, resetFilters } = useData()
  const { tab, view } = route
  if (tab.id === 'guide') return null
  const anySet = Object.values(filters).some(Boolean)
  return (
    <div className="filters" role="group" aria-label="Filters">
      {tab.id === 'overview' && <OverviewFilters />}
      {tab.id === 'cowork' && (view === 'tasks' ? <TaskFilters /> : <CoworkFilters view={view} />)}
      {tab.id === 'studio' && <StudioFilters view={view} />}
      {tab.id === 'github' && <GitHubFilters view={view} />}
      {tab.id === 'azure' && <AzureFilters view={view} />}
      {anySet && (
        <button type="button" className="link-btn reset" onClick={resetFilters}>
          Clear filters
        </button>
      )}
    </div>
  )
}
