import { ALL_USERS, NOT_SET, type Dataset } from '../data/types'
import { distinct } from '../metrics/common'
import { GROWTH_SCENARIOS } from '../metrics/stats'

/** Null-safe value for tables and charts: blank measures become NaN, which every formatter shows as a dash. */
export const N = (v: number | null | undefined) => (v === null || v === undefined ? NaN : v)

export const GROWTH_OPTIONS = GROWTH_SCENARIOS.filter((g) => g.id !== 'fitted').map((g) => ({ value: g.id, label: g.label }))

export function groupValues(ds: Dataset, attr: string): string[] {
  if (attr === ALL_USERS) return [ALL_USERS]
  const vals = distinct([...ds.groups.values()].map((r) => r[attr] ?? ''))
  return [...vals, NOT_SET]
}

export const opts = (vals: readonly string[]) => vals.map((v) => ({ value: v, label: v }))
