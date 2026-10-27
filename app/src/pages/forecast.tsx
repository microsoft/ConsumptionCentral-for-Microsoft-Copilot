import { LineChart, type Series } from '../ui/charts'
import { compact, monthLabel, signedPct, usd, usdCompact, type Fmt } from '../ui/format'
import { Kpi } from '../ui/primitives'
import { NEUTRAL } from '../ui/theme'

/** What every product forecast shares: today's rate, then twelve months flat and with growth. */
export interface ForecastFigures {
  runRate: number
  fitted: boolean
  reliable: boolean
  growth: number
  confidence: string
  yearCost: number
  yearCredits: number
  flatYearCost: number
  flatYearCredits: number
  months: { month: string; cost: number; credits: number; flatCost: number; flatCredits: number }[]
}

const flat = (g: number) => Math.abs(g) < 0.0005

function range(a: number, b: number, f: Fmt) {
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  return f(lo) === f(hi) ? f(hi) : `${f(lo)} – ${f(hi)}`
}

function growthSub(fc: ForecastFigures) {
  const rate = `${fc.fitted ? '' : 'your '}${signedPct(fc.growth)} a month`
  const span = flat(fc.growth) ? 'flat' : fc.growth > 0 ? `flat to ${rate}` : `${rate} to flat`
  return fc.fitted ? `${span} · ${fc.confidence.toLowerCase()} confidence` : span
}

/**
 * The forecast KPIs: run rate first, then the next twelve months as a range from flat to the growth applied.
 * Growth is only projected when there is enough history to read a trend (or the user picked a rate).
 */
export function ForecastKpis(props: { fc: ForecastFigures; tone: 'cowork' | 'studio' | 'github'; runRateSub: string; tooShort: string; costHelp?: string }) {
  const { fc } = props
  return (
    <>
      <Kpi tone={props.tone} label="Monthly run rate" value={usd(fc.runRate)} sub={props.runRateSub} />
      {fc.reliable ? (
        <>
          <Kpi label="Next 12 months cost" value={range(fc.flatYearCost, fc.yearCost, usdCompact)} sub={growthSub(fc)} help={props.costHelp} />
          <Kpi label="Next 12 months credits" value={range(fc.flatYearCredits, fc.yearCredits, compact)} />
        </>
      ) : (
        <Kpi label="Next 12 months cost" value="Not enough history" sub={props.tooShort} help={props.costHelp} />
      )}
    </>
  )
}

/** Monthly cost for the next twelve months: the current rate dashed, growth solid when it can be projected. */
export function ForecastChart(props: { fc: ForecastFigures; color: string; label: string; extra?: { series: Series; values: number[] }[] }) {
  const { fc } = props
  const extra = props.extra ?? []
  const series: Series[] = fc.reliable
    ? [
        { name: 'At current rate', color: NEUTRAL, fmt: usd, dashed: true },
        { name: 'With growth', color: props.color, fmt: usd },
        { name: 'Credits with growth', color: props.color, fmt: compact, tipOnly: true },
      ]
    : [
        { name: 'At current rate', color: props.color, fmt: usd },
        { name: 'Credits', color: props.color, fmt: compact, tipOnly: true },
      ]
  return (
    <LineChart
      label={props.label}
      area
      height={260}
      xFmt={(k) => monthLabel(fc.months[Number(k)]?.month ?? '')}
      data={fc.months.map((x, i) => ({
        key: String(i),
        values: [...(fc.reliable ? [x.flatCost, x.cost, x.credits] : [x.flatCost, x.flatCredits]), ...extra.map((e) => e.values[i])],
      }))}
      series={[...series, ...extra.map((e) => ({ ...e.series, tipOnly: true }))]}
    />
  )
}
