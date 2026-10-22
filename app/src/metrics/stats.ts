/** Number of values in an ascending array strictly below v. */
function below(sorted: number[], v: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] < v) lo = mid + 1
    else hi = mid
  }
  return lo
}

export const BANDS = [
  '0. Not used',
  '1. Light (Bottom 50%)',
  '2. Regular (Top 25–50%)',
  '3. Engaged (Top 10–25%)',
  '4. Native (Top 5–10%)',
  '5. Power (Top 1–5%)',
  '6. Frontier (Top 1%)',
]

/** RANKX(..., ASC) percentile into the report's usage-intensity bands. */
export function intensityBand(v: number, sorted: number[], zeroIsNotUsed: boolean): string {
  if (zeroIsNotUsed && v <= 0) return BANDS[0]
  const p = (below(sorted, v) + 1) / sorted.length
  if (p <= 0.5) return BANDS[1]
  if (p <= 0.75) return BANDS[2]
  if (p <= 0.9) return BANDS[3]
  if (p <= 0.95) return BANDS[4]
  if (p <= 0.99) return BANDS[5]
  return BANDS[6]
}

/** DAX DIVIDE: null when the denominator is zero or either side is missing. */
export function div(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a === null || a === undefined || b === null || b === undefined || !Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null
  return a / b
}

export const sum = <T,>(rows: T[], f: (r: T) => number) => rows.reduce((s, r) => s + f(r), 0)

export interface Fit {
  n: number
  slope: number | null
  intercept: number | null
  r2: number | null
}

/** Ordinary least squares, matching the report's Trend Slope / Intercept / R2 measures. */
export function ols(xs: number[], ys: number[]): Fit {
  const n = xs.length
  let sx = 0
  let sy = 0
  let sxy = 0
  let sxx = 0
  for (let i = 0; i < n; i++) {
    sx += xs[i]
    sy += ys[i]
    sxy += xs[i] * ys[i]
    sxx += xs[i] * xs[i]
  }
  const slope = n > 1 ? div(n * sxy - sx * sy, n * sxx - sx * sx) : null
  const intercept = n > 1 && slope !== null ? sy / n - slope * (sx / n) : null
  let r2: number | null = null
  if (n > 2 && slope !== null && intercept !== null) {
    const ybar = sy / n
    let res = 0
    let tot = 0
    for (let i = 0; i < n; i++) {
      res += (ys[i] - (intercept + slope * xs[i])) ** 2
      tot += (ys[i] - ybar) ** 2
    }
    const d = div(res, tot)
    r2 = d === null ? null : 1 - d
  }
  return { n, slope, intercept, r2 }
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

/** Groups and sums by key, preserving first-seen order. */
export function rollup<T>(rows: T[], key: (r: T) => string, val: (r: T) => number): Map<string, number> {
  const m = new Map<string, number>()
  for (const r of rows) {
    const k = key(r)
    m.set(k, (m.get(k) ?? 0) + val(r))
  }
  return m
}

export function groupRows<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const r of rows) {
    const k = key(r)
    const l = m.get(k)
    if (l) l.push(r)
    else m.set(k, [r])
  }
  return m
}

/** Share of the total held by the heaviest k values. */
export function topShare(values: number[], k: number): number | null {
  const s = [...values].sort((a, b) => b - a)
  const total = s.reduce((a, b) => a + b, 0)
  return div(
    s.slice(0, k).reduce((a, b) => a + b, 0),
    total,
  )
}

export const GROWTH_SCENARIOS = [
  { id: 'fitted', label: 'Fitted from history', rate: null },
  { id: 'flat', label: 'Flat - no growth', rate: 0 },
  { id: 'g10', label: 'Grow 10% a month', rate: 0.1 },
  { id: 'g20', label: 'Grow 20% a month', rate: 0.2 },
  { id: 'g30', label: 'Grow 30% a month', rate: 0.3 },
  { id: 'd10', label: 'Decline 10% a month', rate: -0.1 },
] as const

export function scenarioRate(id: string): number | null {
  return GROWTH_SCENARIOS.find((s) => s.id === id)?.rate ?? null
}
