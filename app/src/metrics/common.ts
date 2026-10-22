import type { Dataset } from '../data/types'
import { ALL_USERS, NOT_SET } from '../data/types'
import type { Filters } from '../data/store'

/** The Group By attribute in effect: the user's choice, else Department, else All users. */
export function groupAttr(ds: Dataset, f: Filters): string {
  if (f.group && ds.groupAttrs.includes(f.group)) return f.group
  return ds.groupAttrs.includes('Department') ? 'Department' : ALL_USERS
}

/** Group value for a person (lower-case key) under an attribute. */
export function groupOf(ds: Dataset, key: string, attr: string): string {
  if (attr === ALL_USERS) return ALL_USERS
  return ds.groups.get(key)?.[attr] || NOT_SET
}

/** True when the person passes the Group By value filter. */
export function inGroup(ds: Dataset, key: string, f: Filters): boolean {
  if (!f.groupValue) return true
  return groupOf(ds, key, groupAttr(ds, f)) === f.groupValue
}

/** Sorted distinct values. */
export const distinct = (vals: Iterable<string>) => [...new Set(vals)].filter(Boolean).sort((a, b) => a.localeCompare(b))

export interface GrowthOption {
  value: string
  label: string
}
