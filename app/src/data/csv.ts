import Papa from 'papaparse'

export type Rec = Record<string, string>

export function parseCsv(text: string): { headers: string[]; rows: Rec[] } {
  const res = Papa.parse<Rec>(text.replace(/^\uFEFF/, ''), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  })
  return { headers: res.meta.fields ?? [], rows: res.data }
}

/** Header key used by the Power Query loaders: lower case, no spaces, underscores, dashes or punctuation. */
export const hkey = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Finds the first header matching any alias (compared by header key). */
export function pick(headers: string[], ...aliases: string[]): string | undefined {
  const keys = new Map(headers.map((h) => [hkey(h), h]))
  for (const a of aliases) {
    const hit = keys.get(hkey(a))
    if (hit !== undefined) return hit
  }
  return undefined
}

export const has = (headers: string[], ...aliases: string[]) => aliases.every((a) => pick(headers, a) !== undefined)

/** Returns a getter for a column found by aliases; missing columns read as an empty string. */
export function getter(headers: string[], ...aliases: string[]): (r: Rec) => string {
  const h = pick(headers, ...aliases)
  return h === undefined ? () => '' : (r) => (r[h] ?? '').trim()
}

export function num(v: string | undefined): number {
  if (v === undefined) return 0
  const s = v.trim().replace(/[$,£€\s]/g, '')
  if (!s) return 0
  const n = Number(s)
  return Number.isFinite(n) ? n : 0
}

/** Like num, but blank stays null (Power BI BLANK). */
export function numOrNull(v: string | undefined): number | null {
  if (v === undefined || !v.trim()) return null
  const n = num(v)
  return Number.isFinite(n) ? n : null
}

export const truthy = (v: string | undefined) => ['true', 'yes', 'y', '1'].includes((v ?? '').trim().toLowerCase())

const pad = (n: number) => String(n).padStart(2, '0')
export const isoOf = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`

/**
 * Parses ISO, yyyyMMdd and slash dates. Slash dates are month-first unless dayFirst is set
 * (the loaders detect day-first when any leading part is above 12, as the report does).
 */
export function toIso(v: string | undefined, dayFirst = false): string {
  if (!v) return ''
  const s = v.trim()
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s)
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})/.exec(s)
  if (m) return dayFirst ? `${m[3]}-${pad(+m[2])}-${pad(+m[1])}` : `${m[3]}-${pad(+m[1])}-${pad(+m[2])}`
  const t = Date.parse(s)
  return Number.isNaN(t) ? '' : isoOf(new Date(t))
}

/** True when any slash date's first part is above 12, so the column is day-first. */
export function detectDayFirst(values: string[]): boolean {
  for (const v of values) {
    const m = /^(\d{1,2})[/.](\d{1,2})[/.]\d{4}/.exec(v.trim())
    if (m && +m[1] > 12) return true
  }
  return false
}

export const dayNum = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86400000
export const isoFromDay = (n: number) => isoOf(new Date(n * 86400000))
export const addDays = (iso: string, n: number) => isoFromDay(dayNum(iso) + n)

/** Sunday on or before the date (WEEKDAY(..., 1) weeks). */
export function sundayOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  return addDays(iso, -d.getUTCDay())
}

/** Last day of the month `months` after the date's month (EOMONTH). */
export function eomonth(iso: string, months: number): string {
  const y = +iso.slice(0, 4)
  const m = +iso.slice(5, 7) - 1 + months
  return isoOf(new Date(Date.UTC(y, m + 1, 0)))
}

export const monthKey = (iso: string) => +iso.slice(0, 4) * 12 + +iso.slice(5, 7)
