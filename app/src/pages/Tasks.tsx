import { useMemo } from 'react'
import { useData } from '../data/store'
import { TASK_FOOTNOTE, tasksModel } from '../metrics/tasks'
import { BarList, ColumnChart } from '../ui/charts'
import { DataTable } from '../ui/DataTable'
import { dayLabel, dec1, dec2, int, pct, usd, usd4 } from '../ui/format'
import { Kpi, KpiRow, Note, Panel } from '../ui/primitives'
import { PRODUCT_COLOR, SERIES } from '../ui/theme'
import { N } from './helpers'

const C = PRODUCT_COLOR.cowork

export function CoworkTasks() {
  const { ds, filters, settings } = useData()
  const m = useMemo(() => tasksModel(ds, filters, settings), [ds, filters, settings])
  const t = m.total
  const ok = ds.tasksLoaded && t.tasks > 0
  return (
    <>
      <KpiRow>
        <Kpi tone="cowork" label="Tasks completed" value={int(t.tasks)} sub={`${m.spanWeeks} weeks of task data`} help="Cowork tasks reported in the selected weeks." />
        <Kpi label="Credits used by tasks" value={int(N(t.credits))} sub={t.coverage !== null && t.coverage < 1 ? `${pct(t.coverage)} of tasks have credits` : undefined} help="Credits attributed to the selected tasks. Blank if any task row has no credits." />
        <Kpi label="Credits per task" value={dec1(N(t.creditsPerTask))} sub={`${usd4(N(t.paygPerTask))} at PAYG`} help="Credits divided by tasks, and the same at the PAYG rate." />
        <Kpi label="Expert-equivalent hours" value={int(N(t.hours))} sub={`${m.scenario} estimate`} help="Tasks multiplied by the expert minutes for each category under the chosen scenario." />
        <Kpi label="Expert-equivalent value" value={usd(N(t.monetary))} sub={m.rate === null ? 'Set USD/hour to value work' : `at $${m.rate}/hour`} help="Expert-equivalent hours at the hourly rate you set." />
      </KpiRow>
      <Note tone={ok ? undefined : 'warn'} title={ok ? 'How to read this' : 'Check the task data'}>
        {m.status}
      </Note>
      <div className="grid grid-1-2">
        <Panel title="Share of tasks by category" note="Hover a row for tasks and credits per task.">
          <BarList
            label="Share of tasks by category"
            color={C}
            fmt={(v) => pct(v)}
            items={m.categories.map((c) => ({ key: c.category, label: c.category, value: N(c.share), hint: `${int(c.tasks)} tasks · ${dec1(N(c.creditsPerTask))} credits per task` }))}
          />
        </Panel>
        <Panel title="Tasks by week and type">
          <ColumnChart
            label="Tasks by week and type"
            stacked
            xFmt={dayLabel}
            data={m.weekly}
            series={m.types.map((ty, i) => ({ name: ty, color: SERIES[i % SERIES.length], fmt: int }))}
          />
        </Panel>
      </div>
      <Panel title="Task value by category" note="Expert minutes per task come from the chosen scenario.">
        <DataTable
          label="Task value by category"
          search={(r) => r.category}
          columns={[
            { key: 'category', label: 'Category', value: (r) => r.category },
            { key: 'tasks', label: 'Tasks', value: (r) => r.tasks, fmt: int, align: 'right', bar: C },
            { key: 'share', label: 'Share', value: (r) => N(r.share), fmt: pct, align: 'right' },
            { key: 'cpt', label: 'Credits / task', value: (r) => N(r.creditsPerTask), fmt: dec1, align: 'right' },
            { key: 'ppt', label: 'PAYG / task', value: (r) => N(r.paygPerTask), fmt: dec2, align: 'right' },
            { key: 'minutes', label: 'Expert min / task', value: (r) => N(r.minutes), fmt: int, align: 'right' },
            { key: 'hours', label: 'Expert hours', value: (r) => N(r.hours), fmt: dec1, align: 'right' },
            { key: 'monetary', label: 'Value (USD)', value: (r) => N(r.monetary), fmt: usd, align: 'right' },
          ]}
          rows={m.categories.map((c) => ({ id: c.category, data: c }))}
          initialSort={{ key: 'tasks', desc: true }}
        />
      </Panel>
      <Panel title="Basis">
        <ul className="notes">
          {m.basis.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
        <p className="section-note">{TASK_FOOTNOTE}</p>
      </Panel>
    </>
  )
}
