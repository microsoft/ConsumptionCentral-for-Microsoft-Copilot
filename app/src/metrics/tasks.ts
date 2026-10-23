import type { Dataset, TaskRow } from '../data/types'
import type { Filters, Settings } from '../data/store'
import { dayNum, sundayOf } from '../data/csv'
import { div, groupRows } from './stats'
import { pct, usd4 } from '../ui/format'

/** Provisional expert-equivalent minutes per task (the Cowork Task Categories table). */
export const TASK_MINUTES: Record<string, { Conservative: number; Typical: number; Optimistic: number }> = {
  'analysis & research': { Conservative: 30, Typical: 67, Optimistic: 92 },
  'document & content creation': { Conservative: 12, Typical: 24, Optimistic: 42 },
  'email workflows': { Conservative: 3, Typical: 7, Optimistic: 12 },
  'meeting workflows': { Conservative: 12, Typical: 31, Optimistic: 43 },
  'communication workflows': { Conservative: 2, Typical: 4, Optimistic: 11 },
  'specialized workflows': { Conservative: 10, Typical: 25, Optimistic: 40 },
  'write or debug code': { Conservative: 30, Typical: 56, Optimistic: 96 },
  'general assistance / other': { Conservative: 2, Typical: 5, Optimistic: 8 },
}

export const TASK_SCENARIOS = ['Conservative', 'Typical', 'Optimistic'] as const
export type TaskScenario = (typeof TASK_SCENARIOS)[number]

export const TASK_FOOTNOTE =
  'Estimates are not measured time saved or successful completions. Unknown and unmapped tasks remain in observed totals.'

function span(ds: Dataset) {
  if (!ds.tasks.length) return { last: '', weeks: 0 }
  let min = ds.tasks[0].date
  let max = min
  for (const t of ds.tasks) {
    if (t.date < min) min = t.date
    if (t.date > max) max = t.date
  }
  const last = sundayOf(max)
  return { last, weeks: Math.round((dayNum(last) - dayNum(sundayOf(min))) / 7) + 1 }
}

export function taskPeriods(ds: Dataset) {
  const { weeks } = span(ds)
  const out: { value: string; label: string }[] = []
  if (4 < weeks) out.push({ value: '4', label: 'Last 4 weeks' })
  if (8 < weeks) out.push({ value: '8', label: 'Last 8 weeks' })
  out.push({ value: String(Math.max(weeks, 1)), label: 'All history' })
  return out
}

export interface CategoryRow {
  category: string
  tasks: number
  credits: number | null
  share: number | null
  creditsPerTask: number | null
  paygPerTask: number | null
  minutes: number | null
  hours: number | null
  monetary: number | null
}

function summarise(rows: TaskRow[], minutesOf: (cat: string) => number | null, rate: number | null, s: Settings) {
  const tasks = rows.reduce((a, r) => a + r.tasks, 0)
  const complete = rows.every((r) => r.credits !== null)
  const credits = rows.length && complete ? rows.reduce((a, r) => a + (r.credits ?? 0), 0) : null
  const withCredits = rows.filter((r) => r.credits !== null).reduce((a, r) => a + r.tasks, 0)
  const byCat = groupRows(rows, (r) => r.category.trim().toLowerCase())
  let hours: number | null = null
  let valued = 0
  for (const [key, rs] of byCat) {
    const m = minutesOf(key)
    const t = rs.reduce((a, r) => a + r.tasks, 0)
    if (m !== null && rs.length) {
      hours = (hours ?? 0) + (t * m) / 60
      valued += t
    }
  }
  return {
    tasks,
    credits,
    coverage: div(withCredits, tasks),
    valuation: div(valued, tasks),
    creditsPerTask: div(credits, tasks),
    paygPerTask: credits === null ? null : div(credits * s.coworkPayg, tasks),
    hours,
    monetary: rate !== null && hours !== null ? hours * rate : null,
  }
}

export function tasksModel(ds: Dataset, f: Filters, s: Settings) {
  const { last, weeks: spanWeeks } = span(ds)
  const W = f.taskPeriod ? Number(f.taskPeriod) : 4
  const scenario: TaskScenario = (TASK_SCENARIOS as readonly string[]).includes(f.scenario) ? (f.scenario as TaskScenario) : 'Typical'
  const rate = f.hourly ? Number(f.hourly) : null
  const minutesOf = (key: string) => TASK_MINUTES[key]?.[scenario] ?? null

  const rows = ds.tasks.filter(
    (t) =>
      Math.round((dayNum(last) - dayNum(sundayOf(t.date))) / 7) < W &&
      (!f.taskType || t.type === f.taskType) &&
      (!f.category || t.category === f.category) &&
      (!f.org || t.org === f.org),
  )
  const total = summarise(rows, minutesOf, rate, s)

  const categories: CategoryRow[] = [...groupRows(rows, (r) => r.category).entries()]
    .map(([category, rs]) => {
      const c = summarise(rs, minutesOf, rate, s)
      return {
        category,
        tasks: c.tasks,
        credits: c.credits,
        share: div(c.tasks, total.tasks),
        creditsPerTask: c.creditsPerTask,
        paygPerTask: c.paygPerTask,
        minutes: minutesOf(category.trim().toLowerCase()),
        hours: c.hours,
        monetary: c.monetary,
      }
    })
    .sort((a, b) => b.tasks - a.tasks)

  const types = [...new Set(rows.map((r) => r.type))].sort()
  const weekly = [...groupRows(rows, (r) => sundayOf(r.date)).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, rs]) => ({
      key: week,
      values: types.map((t) => rs.filter((r) => r.type === t).reduce((a, r) => a + r.tasks, 0)),
    }))

  let status: string
  if (!ds.tasksLoaded) status = 'Task categories not supplied'
  else if (!ds.tasks.length) status = 'Task export contains no rows'
  else if (!rows.length) status = 'No tasks match these filters'
  else
    status =
      `Value assumptions cover ${pct(total.valuation ?? 0)} of reported tasks. ` +
      (total.credits === null
        ? `Credits are incomplete${total.tasks > 0 ? ` (${pct(total.coverage ?? 0)} task coverage)` : ''}; cost estimates are unavailable. `
        : '') +
      'Expert-equivalent work is estimated, not measured time saved.'

  const basis = [
    `${scenario} estimates`,
    rate === null ? 'Select USD/hour to value work.' : `$${rate.toLocaleString('en-GB')} per expert hour (USD)`,
    `PAYG: ${usd4(s.coworkPayg)}/credit`,
    'No prepaid/licence allocation.',
  ]

  return {
    spanWeeks,
    scenario,
    rate,
    total,
    categories,
    types,
    weekly,
    status,
    basis,
    options: {
      types: [...new Set(ds.tasks.map((t) => t.type))].sort(),
      categories: [...new Set(ds.tasks.map((t) => t.category))].sort(),
      orgs: [...new Set(ds.tasks.map((t) => t.org))].sort(),
    },
  }
}
