import { getter, has, type Rec } from './csv'
import type { CostBalanceRow, CostFundingRow, CostServiceRow, SourceKind } from './types'

interface Parsed {
  name: string
  headers: string[]
  rows: Rec[]
}

export function detectCostManagement(headers: string[], name = ''): SourceKind | null {
  if (has(headers, 'Date', 'ServiceId', 'ConsumedQuantity', 'Unit')) return 'costService'
  if (has(headers, 'Month', 'FundingClass', 'ConsumedQuantity', 'Unit', 'LatestSourceDateTime')) return 'costFunding'
  if (has(headers, 'AsOfUTC', 'BillingMethod', 'PurchasedQuantity', 'ConsumedQuantity', 'RemainingQuantity', 'Unit', 'LastModifiedDateTime')) return 'costBalance'
  if (/^CopilotCost(?:ServiceDaily|FundingMonthly|Balance)\.csv$/i.test(name)) {
    throw new Error(`Cost Management CSV ${name} has an unexpected schema.`)
  }
  return null
}

function required(value: string, field: string): string {
  if (!value) throw new Error(`Cost Management CSV: ${field} is missing.`)
  return value
}

function quantity(value: string, field: string, optional = false): number | null {
  if (!value && optional) return null
  if (!value || !Number.isFinite(Number(value))) throw new Error(`Cost Management CSV: invalid ${field}.`)
  return Number(value)
}

function validateUnit(value: string) {
  if (value !== 'copilotCredit') throw new Error('Cost Management CSV: unexpected credit unit.')
}

function day(value: string, field: string): string {
  const parsed = new Date(`${value}T00:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`Cost Management CSV: invalid ${field}.`)
  }
  return value
}

export function readCostService(p: Parsed | undefined): CostServiceRow[] {
  if (!p) return []
  const get = (...names: string[]) => getter(p.headers, ...names)
  const [date, service, credits, unit] = [get('Date'), get('ServiceId'), get('ConsumedQuantity'), get('Unit')]
  return p.rows.map((r) => {
    validateUnit(unit(r))
    return { date: day(date(r), 'Date'), service: required(service(r), 'ServiceId'), credits: quantity(credits(r), 'ConsumedQuantity')! }
  })
}

export function readCostFunding(p: Parsed | undefined): CostFundingRow[] {
  if (!p) return []
  const get = (...names: string[]) => getter(p.headers, ...names)
  const [month, funding, credits, unit, freshness] = [get('Month'), get('FundingClass'), get('ConsumedQuantity'), get('Unit'), get('LatestSourceDateTime')]
  return p.rows.map((r) => {
    validateUnit(unit(r))
    const date = day(month(r), 'Month')
    if (!date.endsWith('-01')) throw new Error('Cost Management CSV: Month must be the first day of a month.')
    return { month: date, funding: required(funding(r), 'FundingClass'), credits: quantity(credits(r), 'ConsumedQuantity')!, freshness: freshness(r) }
  })
}

export function readCostBalance(p: Parsed | undefined): CostBalanceRow[] {
  if (!p) return []
  const get = (...names: string[]) => getter(p.headers, ...names)
  const [asOf, billingMethod, purchased, consumed, remaining, unit, freshness] = [
    get('AsOfUTC'), get('BillingMethod'), get('PurchasedQuantity'), get('ConsumedQuantity'),
    get('RemainingQuantity'), get('Unit'), get('LastModifiedDateTime'),
  ]
  return p.rows.map((r) => {
    validateUnit(unit(r))
    const snapshot = required(asOf(r), 'AsOfUTC')
    if (Number.isNaN(Date.parse(snapshot))) throw new Error('Cost Management CSV: invalid AsOfUTC.')
    return { asOf: snapshot, billingMethod: required(billingMethod(r), 'BillingMethod'),
      purchased: quantity(purchased(r), 'PurchasedQuantity', true), consumed: quantity(consumed(r), 'ConsumedQuantity')!,
      remaining: quantity(remaining(r), 'RemainingQuantity', true), freshness: freshness(r) }
  })
}
